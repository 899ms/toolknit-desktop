
#[derive(serde::Serialize)]
pub(crate) struct ExtractResult {
    pub(crate) success: bool,
    pub(crate) output_path: String,
    pub(crate) error: Option<String>,
}

pub(crate) fn emit_audio_extract_progress(app_handle: &Option<tauri::AppHandle>, status: &str, progress: f64) {
    use tauri::Emitter;

    if let Some(app_handle) = app_handle {
        let _ = app_handle.emit(
            "audio-extract-progress",
            serde_json::json!({
                "status": status,
                "progress": progress.clamp(0.0, 1.0),
            }),
        );
    }
}

#[tauri::command]
pub(crate) async fn extract_audio(
    app_handle: tauri::AppHandle,
    input_path: String,
    output_dir: String,
    target_format: String,
    track_index: Option<usize>,
) -> Result<ExtractResult, String> {
    extract_audio_inner(
        Some(app_handle),
        input_path,
        output_dir,
        target_format,
        track_index,
    )
    .await
}

pub(crate) async fn extract_audio_inner(
    app_handle: Option<tauri::AppHandle>,
    input_path: String,
    output_dir: String,
    target_format: String,
    track_index: Option<usize>,
) -> Result<ExtractResult, String> {
    let _conversion_guard = begin_conversion()?;
    let input = validate_audio_extract_input(&input_path)?;
    let target_format = normalize_audio_extract_format(&target_format)?;
    if track_index.is_some_and(|index| index > AUDIO_EXTRACT_MAX_TRACK_INDEX) {
        return Err("audio-extract:invalid-track".to_string());
    }
    let ffmpeg_path = get_ffmpeg_path()?;
    let output_dir_path = validate_audio_extract_output_dir(&output_dir)?;
    emit_audio_extract_progress(&app_handle, "probe", 0.0);
    let duration = probe_video_convert_duration(&ffmpeg_path, &input)
        .await
        .unwrap_or(0.0);
    if CANCEL_FLAG.load(Ordering::SeqCst) {
        emit_audio_extract_progress(&app_handle, "cancelled", 1.0);
        return Err("audio-extract:cancelled".to_string());
    }
    emit_audio_extract_progress(&app_handle, "prepare", 0.05);

    let (encoder, extra_args, ext) = get_encoder_params(target_format, "medium");
    let temporary_path = create_audio_extract_temp_path(&output_dir_path, ext)?;

    let mut cmd = tokio::process::Command::new(&ffmpeg_path);
    cmd.arg("-y")
        .arg("-i")
        .arg(&input)
        .arg("-vn")
        .arg("-map")
        .arg(format!("0:a:{}", track_index.unwrap_or(0)));

    cmd.arg("-c:a")
        .arg(&encoder)
        .args(&extra_args)
        .arg("-progress")
        .arg("pipe:1")
        .arg("-nostats")
        .arg(&temporary_path)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());

    #[cfg(target_os = "windows")]
    {
        cmd.creation_flags(0x08000000);
    }

    let mut child = match cmd.spawn() {
        Ok(child) => child,
        Err(_) => {
            emit_audio_extract_progress(&app_handle, "failed", 1.0);
            return Err("audio-extract:failed".to_string());
        }
    };
    if let Some(id) = child.id() {
        CURRENT_CHILD_ID.store(id, Ordering::SeqCst);
    }
    let stdout = match child.stdout.take() {
        Some(stdout) => stdout,
        None => {
            let _ = child.kill().await;
            CURRENT_CHILD_ID.store(0, Ordering::SeqCst);
            let _ = std::fs::remove_file(&temporary_path);
            emit_audio_extract_progress(&app_handle, "failed", 1.0);
            return Err("audio-extract:failed".to_string());
        }
    };
    let stderr = match child.stderr.take() {
        Some(stderr) => stderr,
        None => {
            let _ = child.kill().await;
            CURRENT_CHILD_ID.store(0, Ordering::SeqCst);
            let _ = std::fs::remove_file(&temporary_path);
            emit_audio_extract_progress(&app_handle, "failed", 1.0);
            return Err("audio-extract:failed".to_string());
        }
    };
    let progress_app = app_handle.clone();
    let progress_task = tokio::spawn(async move {
        use tauri::Emitter;
        use tokio::io::{AsyncBufReadExt, BufReader};

        let mut lines = BufReader::new(stdout).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            let Some(seconds) = parse_ffmpeg_progress_seconds(&line) else {
                continue;
            };
            let progress = if duration > 0.0 {
                0.05 + (seconds / duration).clamp(0.0, 0.9)
            } else {
                0.05
            };
            if let Some(app_handle) = &progress_app {
                let _ = app_handle.emit(
                    "audio-extract-progress",
                    serde_json::json!({ "status": "extract", "progress": progress }),
                );
            }
        }
    });
    let stderr_task = tokio::spawn(async move {
        use tokio::io::{AsyncReadExt, BufReader};

        let mut bytes = Vec::new();
        let mut reader = BufReader::new(stderr);
        let _ = reader.read_to_end(&mut bytes).await;
        String::from_utf8_lossy(&bytes).into_owned()
    });
    let status = match child.wait().await {
        Ok(status) => status,
        Err(_) => {
            CURRENT_CHILD_ID.store(0, Ordering::SeqCst);
            let _ = progress_task.await;
            let _ = stderr_task.await;
            let _ = std::fs::remove_file(&temporary_path);
            emit_audio_extract_progress(&app_handle, "failed", 1.0);
            return Err("audio-extract:failed".to_string());
        }
    };
    CURRENT_CHILD_ID.store(0, Ordering::SeqCst);
    let _ = progress_task.await;
    let stderr = stderr_task.await.unwrap_or_default();

    if CANCEL_FLAG.load(Ordering::SeqCst) {
        let _ = std::fs::remove_file(&temporary_path);
        emit_audio_extract_progress(&app_handle, "cancelled", 1.0);
        return Err("audio-extract:cancelled".to_string());
    }

    if status.success() {
        if std::fs::metadata(&temporary_path)
            .map(|metadata| metadata.len() == 0)
            .unwrap_or(true)
        {
            let _ = std::fs::remove_file(&temporary_path);
            emit_audio_extract_progress(&app_handle, "failed", 1.0);
            return Err("audio-extract:failed".to_string());
        }
        emit_audio_extract_progress(&app_handle, "publish", 0.97);
        let output_path = match publish_audio_extract_output(
            &temporary_path,
            &output_dir_path,
            &audio_extract_file_stem(&input),
            ext,
        ) {
            Ok(path) => path,
            Err(error) => {
                let _ = std::fs::remove_file(&temporary_path);
                emit_audio_extract_progress(&app_handle, "failed", 1.0);
                return Err(error);
            }
        };
        emit_audio_extract_progress(&app_handle, "done", 1.0);
        Ok(ExtractResult {
            success: true,
            output_path,
            error: None,
        })
    } else {
        let _ = std::fs::remove_file(&temporary_path);
        emit_audio_extract_progress(&app_handle, "failed", 1.0);
        let stderr = stderr.to_ascii_lowercase();
        if stderr.contains("matches no streams") || stderr.contains("does not contain any stream") {
            Err("audio-extract:no-audio-track".to_string())
        } else {
            Err("audio-extract:failed".to_string())
        }
    }
}

#[cfg(test)]
mod audio_extract_backend_tests {
    use super::*;

    fn test_directory() -> std::path::PathBuf {
        let suffix = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("clock must be after epoch")
            .as_nanos();
        let directory = std::env::temp_dir().join(format!("toolknit-audio-extract-{}", suffix));
        std::fs::create_dir_all(&directory).expect("create test directory");
        directory
    }

    #[tokio::test]
    async fn audio_extract_rejects_symlinks_and_publishes_unique_outputs() {
        let _conversion_lock = test_conversion_lock();
        let directory = test_directory();
        let video = directory.join("sample.mp4");
        let ffmpeg = get_ffmpeg_path().expect("bundled FFmpeg must be available");
        let status = tokio::process::Command::new(&ffmpeg)
            .args([
                "-hide_banner",
                "-loglevel",
                "error",
                "-y",
                "-f",
                "lavfi",
                "-i",
                "color=c=black:s=32x32:d=1",
                "-f",
                "lavfi",
                "-i",
                "sine=frequency=440:sample_rate=48000:duration=1",
                "-shortest",
                "-c:v",
                "mpeg4",
                "-c:a",
                "aac",
            ])
            .arg(&video)
            .status()
            .await
            .expect("start video fixture generation");
        assert!(status.success(), "generate a video with audio");

        let output_directory = directory.to_string_lossy().into_owned();
        let first = extract_audio_inner(
            None,
            video.to_string_lossy().into_owned(),
            output_directory.clone(),
            "MP3".to_string(),
            Some(0),
        )
        .await
        .expect("first extraction must succeed");
        assert!(first.success);
        assert!(
            std::fs::metadata(&first.output_path)
                .expect("inspect output")
                .len()
                > 0
        );

        let second = extract_audio_inner(
            None,
            video.to_string_lossy().into_owned(),
            output_directory,
            "MP3".to_string(),
            Some(0),
        )
        .await
        .expect("second extraction must succeed");
        assert!(second.success);
        assert_ne!(first.output_path, second.output_path);
        assert!(second.output_path.ends_with("sample_audio_1.mp3"));

        #[cfg(unix)]
        {
            use std::os::unix::fs::symlink;
            let symlink_path = directory.join("linked.mp4");
            symlink(&video, &symlink_path).expect("create symbolic link");
            assert_eq!(
                validate_audio_extract_input(&symlink_path.to_string_lossy())
                    .expect_err("symbolic link must be rejected"),
                "audio-extract:invalid-input",
            );
        }
        std::fs::remove_dir_all(&directory).expect("remove test directory");
    }
}
