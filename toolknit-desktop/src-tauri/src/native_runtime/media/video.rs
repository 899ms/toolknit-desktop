
pub(crate) const VIDEO_CONVERT_MAX_BATCH_FILES: usize = 30;
pub(crate) const VIDEO_CONVERT_MAX_INPUT_BYTES: u64 = 10 * 1024 * 1024 * 1024;

pub(crate) fn video_convert_profile(
    target_format: &str,
) -> Result<
    (
        Option<&'static str>,
        &'static str,
        &'static str,
        &'static str,
    ),
    String,
> {
    match target_format.trim().to_ascii_uppercase().as_str() {
        "MP4" => Ok((Some("h264_nvenc"), "libx264", "aac", ".mp4")),
        "MKV" => Ok((Some("h264_nvenc"), "libx264", "aac", ".mkv")),
        "MOV" => Ok((Some("h264_nvenc"), "libx264", "aac", ".mov")),
        "AVI" => Ok((None, "mpeg4", "libmp3lame", ".avi")),
        "WEBM" => Ok((None, "libvpx-vp9", "libopus", ".webm")),
        "FLV" => Ok((Some("h264_nvenc"), "libx264", "aac", ".flv")),
        "WMV" => Ok((None, "wmv2", "wmav2", ".wmv")),
        "TS" => Ok((Some("h264_nvenc"), "libx264", "aac", ".ts")),
        _ => Err("video-convert:invalid-target-format".to_string()),
    }
}

pub(crate) fn validate_video_convert_inputs(
    input_paths: &[String],
) -> Result<Vec<std::path::PathBuf>, String> {
    if input_paths.is_empty() {
        return Err("video-convert:missing-input".to_string());
    }
    if input_paths.len() > VIDEO_CONVERT_MAX_BATCH_FILES {
        return Err("video-convert:too-many-files".to_string());
    }

    let mut seen = std::collections::BTreeSet::new();
    let mut validated = Vec::with_capacity(input_paths.len());
    for input_path in input_paths {
        if input_path.contains('\0') {
            return Err("video-convert:invalid-input".to_string());
        }
        let input = std::path::PathBuf::from(input_path);
        let metadata = std::fs::symlink_metadata(&input)
            .map_err(|_| "video-convert:invalid-input".to_string())?;
        let extension = input
            .extension()
            .and_then(|value| value.to_str())
            .map(|value| value.to_ascii_lowercase());
        if metadata.file_type().is_symlink()
            || !metadata.is_file()
            || !matches!(
                extension.as_deref(),
                Some("mp4" | "avi" | "mkv" | "mov" | "webm" | "flv" | "wmv" | "ts" | "m4v")
            )
            || metadata.len() == 0
        {
            return Err("video-convert:invalid-input".to_string());
        }
        if metadata.len() > VIDEO_CONVERT_MAX_INPUT_BYTES {
            return Err("video-convert:input-too-large".to_string());
        }
        let canonical = input
            .canonicalize()
            .map_err(|_| "video-convert:invalid-input".to_string())?;
        if !seen.insert(canonical.clone()) {
            return Err("video-convert:duplicate-input".to_string());
        }
        validated.push(canonical);
    }
    Ok(validated)
}

pub(crate) fn validate_video_convert_output_dir(output_dir: &str) -> Result<std::path::PathBuf, String> {
    if output_dir.trim().is_empty() || output_dir.contains('\0') {
        return Err("video-convert:output-path".to_string());
    }
    let output_dir = std::path::PathBuf::from(output_dir);
    is_path_safe(&output_dir).map_err(|_| "video-convert:output-path".to_string())?;
    std::fs::create_dir_all(&output_dir).map_err(|_| "video-convert:output-path".to_string())?;
    if !output_dir.is_dir() {
        return Err("video-convert:output-path".to_string());
    }
    is_path_safe(&output_dir).map_err(|_| "video-convert:output-path".to_string())?;
    Ok(output_dir)
}

pub(crate) fn video_convert_file_stem(input: &std::path::Path) -> String {
    let raw_stem = input
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("video");
    let sanitized: String = raw_stem
        .chars()
        .map(|character| {
            if matches!(
                character,
                '\\' | '/' | ':' | '*' | '?' | '"' | '<' | '>' | '|'
            ) {
                '_'
            } else {
                character
            }
        })
        .collect();
    let trimmed = sanitized
        .trim()
        .trim_end_matches(|character| character == '.' || character == ' ');
    let safe_stem: String = trimmed.chars().take(96).collect();
    if safe_stem.is_empty() {
        "video".to_string()
    } else {
        safe_stem
    }
}

pub(crate) fn create_video_convert_temp_path(
    output_dir: &std::path::Path,
    extension: &str,
) -> Result<std::path::PathBuf, String> {
    for _ in 0..10_000 {
        let id = VIDEO_CONVERT_TEMP_ID.fetch_add(1, Ordering::SeqCst);
        let candidate = output_dir.join(format!(
            ".toolknit-video-{}-{}{}",
            std::process::id(),
            id,
            extension
        ));
        if !candidate.exists() {
            return Ok(candidate);
        }
    }
    Err("video-convert:output-path".to_string())
}

pub(crate) fn publish_video_convert_output(
    temporary_path: &std::path::Path,
    output_dir: &std::path::Path,
    source_stem: &str,
    extension: &str,
) -> Result<String, String> {
    for counter in 0..10_000_u32 {
        let file_name = if counter == 0 {
            format!("{}_converted{}", source_stem, extension)
        } else {
            format!("{}_converted_{}{}", source_stem, counter, extension)
        };
        let candidate = output_dir.join(file_name);
        match std::fs::hard_link(temporary_path, &candidate) {
            Ok(()) => {
                std::fs::remove_file(temporary_path)
                    .map_err(|_| "video-convert:output-path".to_string())?;
                return Ok(candidate.to_string_lossy().into_owned());
            }
            Err(_) if candidate.exists() => continue,
            Err(_) => return Err("video-convert:output-path".to_string()),
        }
    }
    Err("video-convert:output-path".to_string())
}

pub(crate) fn parse_ffmpeg_timestamp(value: &str) -> Option<f64> {
    let mut segments = value.trim().split(':');
    let hours: f64 = segments.next()?.trim().parse().ok()?;
    let minutes: f64 = segments.next()?.trim().parse().ok()?;
    let seconds: f64 = segments.next()?.trim().parse().ok()?;
    if segments.next().is_some()
        || !hours.is_finite()
        || !minutes.is_finite()
        || !seconds.is_finite()
        || hours < 0.0
        || minutes < 0.0
        || seconds < 0.0
    {
        return None;
    }
    Some(hours * 3600.0 + minutes * 60.0 + seconds)
}

pub(crate) fn parse_ffmpeg_duration(stderr: &str) -> Option<f64> {
    stderr.lines().find_map(|line| {
        let duration = line.split_once("Duration:")?.1.trim();
        let value = duration.split(',').next()?.trim();
        parse_ffmpeg_timestamp(value)
    })
}

pub(crate) fn parse_ffmpeg_progress_seconds(line: &str) -> Option<f64> {
    if let Some(value) = line.strip_prefix("out_time=") {
        return parse_ffmpeg_timestamp(value);
    }
    let value = line
        .strip_prefix("out_time_us=")
        .or_else(|| line.strip_prefix("out_time_ms="))?;
    value
        .trim()
        .parse::<f64>()
        .ok()
        .filter(|value| value.is_finite() && *value >= 0.0)
        .map(|value| value / 1_000_000.0)
}

pub(crate) fn compact_video_convert_error(stderr: &str) -> String {
    let detail = stderr
        .lines()
        .rev()
        .find(|line| !line.trim().is_empty())
        .unwrap_or("FFmpeg could not convert this video.");
    let compact = detail.trim().chars().take(480).collect::<String>();
    if compact.is_empty() {
        "FFmpeg could not convert this video.".to_string()
    } else {
        compact
    }
}

pub(crate) async fn probe_video_convert_duration(
    ffmpeg_path: &std::path::Path,
    input: &std::path::Path,
) -> Option<f64> {
    let mut command = tokio::process::Command::new(ffmpeg_path);
    command
        .arg("-hide_banner")
        .arg("-i")
        .arg(input)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::piped());
    #[cfg(target_os = "windows")]
    {
        command.creation_flags(0x08000000);
    }
    let output = command.output().await.ok()?;
    parse_ffmpeg_duration(&String::from_utf8_lossy(&output.stderr))
}

pub(crate) async fn has_video_nvenc_encoder(ffmpeg_path: &std::path::Path, encoder: &str) -> bool {
    let mut probe = tokio::process::Command::new(ffmpeg_path);
    probe
        .arg("-hide_banner")
        .arg("-f")
        .arg("lavfi")
        .arg("-i")
        .arg("nullsrc=s=64x64:d=0.1")
        .arg("-c:v")
        .arg(encoder)
        .arg("-f")
        .arg("null")
        .arg("-")
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null());
    #[cfg(target_os = "windows")]
    {
        probe.creation_flags(0x08000000);
    }
    probe
        .status()
        .await
        .map(|status| status.success())
        .unwrap_or(false)
}

pub(crate) async fn convert_video_file(
    app_handle: tauri::AppHandle,
    ffmpeg_path: std::path::PathBuf,
    input: std::path::PathBuf,
    output_dir: std::path::PathBuf,
    video_encoder: String,
    audio_encoder: String,
    extension: &'static str,
    current: usize,
    total: usize,
) -> Result<(), String> {
    use tauri::Emitter;
    use tokio::io::{AsyncBufReadExt, AsyncReadExt, BufReader};

    if CANCEL_FLAG.load(Ordering::SeqCst) {
        return Err("video-convert:cancelled".to_string());
    }
    let file_name = input
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("video")
        .to_string();
    let _ = app_handle.emit(
        "convert-progress",
        ConvertProgress {
            file_name: file_name.clone(),
            current,
            total,
            progress: 0.0,
            status: "preparing".to_string(),
        },
    );
    let duration = probe_video_convert_duration(&ffmpeg_path, &input)
        .await
        .unwrap_or(0.0);
    if CANCEL_FLAG.load(Ordering::SeqCst) {
        return Err("video-convert:cancelled".to_string());
    }
    let temporary_path = create_video_convert_temp_path(&output_dir, extension)?;
    let mut command = tokio::process::Command::new(&ffmpeg_path);
    command
        .arg("-y")
        .arg("-i")
        .arg(&input)
        .arg("-c:v")
        .arg(&video_encoder)
        .arg("-c:a")
        .arg(&audio_encoder)
        .arg("-pix_fmt")
        .arg("yuv420p");
    match video_encoder.as_str() {
        "h264_nvenc" => {
            command
                .arg("-preset")
                .arg("fast")
                .arg("-rc")
                .arg("vbr")
                .arg("-cq")
                .arg("23");
        }
        "libx264" => {
            command.arg("-preset").arg("fast").arg("-crf").arg("23");
        }
        "libvpx-vp9" => {
            command
                .arg("-row-mt")
                .arg("1")
                .arg("-speed")
                .arg("2")
                .arg("-crf")
                .arg("32")
                .arg("-b:v")
                .arg("0");
        }
        _ => {}
    }
    command
        .arg("-progress")
        .arg("pipe:1")
        .arg("-nostats")
        .arg(&temporary_path)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    #[cfg(target_os = "windows")]
    {
        command.creation_flags(0x08000000);
    }

    let mut child = command
        .spawn()
        .map_err(|_| "video-convert:failed".to_string())?;
    let child_id = match child.id() {
        Some(id) => id,
        None => {
            let _ = child.kill().await;
            let _ = std::fs::remove_file(&temporary_path);
            return Err("video-convert:failed".to_string());
        }
    };
    active_video_children()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .insert(child_id);
    if CANCEL_FLAG.load(Ordering::SeqCst) {
        terminate_conversion_process(child_id);
    }

    let stdout = match child.stdout.take() {
        Some(stdout) => stdout,
        None => {
            terminate_conversion_process(child_id);
            active_video_children()
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .remove(&child_id);
            let _ = child.wait().await;
            let _ = std::fs::remove_file(&temporary_path);
            return Err("video-convert:failed".to_string());
        }
    };
    let stderr = match child.stderr.take() {
        Some(stderr) => stderr,
        None => {
            terminate_conversion_process(child_id);
            active_video_children()
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .remove(&child_id);
            let _ = child.wait().await;
            let _ = std::fs::remove_file(&temporary_path);
            return Err("video-convert:failed".to_string());
        }
    };
    let progress_app = app_handle.clone();
    let progress_name = file_name.clone();
    let progress_task = tokio::spawn(async move {
        let mut lines = BufReader::new(stdout).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            if let Some(seconds) = parse_ffmpeg_progress_seconds(&line) {
                let progress = if duration > 0.0 {
                    (seconds / duration).clamp(0.0, 0.99)
                } else {
                    0.0
                };
                let _ = progress_app.emit(
                    "convert-progress",
                    ConvertProgress {
                        file_name: progress_name.clone(),
                        current,
                        total,
                        progress,
                        status: "converting".to_string(),
                    },
                );
            }
        }
    });
    let stderr_task = tokio::spawn(async move {
        let mut bytes = Vec::new();
        let mut reader = BufReader::new(stderr);
        let _ = reader.read_to_end(&mut bytes).await;
        String::from_utf8_lossy(&bytes).into_owned()
    });
    let status = child.wait().await;
    active_video_children()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .remove(&child_id);
    let _ = progress_task.await;
    let stderr = stderr_task.await.unwrap_or_default();

    if CANCEL_FLAG.load(Ordering::SeqCst) {
        let _ = std::fs::remove_file(&temporary_path);
        return Err("video-convert:cancelled".to_string());
    }
    match status {
        Ok(status) if status.success() => {
            publish_video_convert_output(
                &temporary_path,
                &output_dir,
                &video_convert_file_stem(&input),
                extension,
            )?;
            let _ = app_handle.emit(
                "convert-progress",
                ConvertProgress {
                    file_name,
                    current,
                    total,
                    progress: 1.0,
                    status: "done".to_string(),
                },
            );
            Ok(())
        }
        _ => {
            let _ = std::fs::remove_file(&temporary_path);
            Err(compact_video_convert_error(&stderr))
        }
    }
}

#[tauri::command]
pub(crate) async fn convert_video_batch(
    app_handle: tauri::AppHandle,
    input_paths: Vec<String>,
    output_dir: String,
    target_format: String,
) -> Result<BatchConvertResult, String> {
    use tauri::Emitter;

    let _conversion_guard = begin_conversion()?;
    let input_paths = validate_video_convert_inputs(&input_paths)?;
    let output_dir = validate_video_convert_output_dir(&output_dir)?;
    let (nvenc_encoder, cpu_encoder, audio_encoder, extension) =
        video_convert_profile(&target_format)?;
    let ffmpeg_path = get_ffmpeg_path()?;
    let video_encoder = match nvenc_encoder {
        Some(encoder) if has_video_nvenc_encoder(&ffmpeg_path, encoder).await => encoder,
        _ => cpu_encoder,
    }
    .to_string();
    let total = input_paths.len();
    let max_parallel = std::cmp::min(2, total);
    let mut success_count = 0usize;
    let mut fail_count = 0usize;
    let mut errors = Vec::new();
    let mut join_set = tokio::task::JoinSet::new();

    for (index, input) in input_paths.into_iter().enumerate() {
        if CANCEL_FLAG.load(Ordering::SeqCst) {
            break;
        }
        let file_name = input
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or("video")
            .to_string();
        let ffmpeg_path = ffmpeg_path.clone();
        let output_dir = output_dir.clone();
        let worker_app_handle = app_handle.clone();
        let video_encoder = video_encoder.clone();
        let audio_encoder = audio_encoder.to_string();
        join_set.spawn(async move {
            let result = convert_video_file(
                worker_app_handle,
                ffmpeg_path,
                input,
                output_dir,
                video_encoder,
                audio_encoder,
                extension,
                index + 1,
                total,
            )
            .await;
            (index + 1, file_name, result)
        });

        while join_set.len() >= max_parallel {
            if let Some(result) = join_set.join_next().await {
                match result {
                    Ok((_current, _file_name, Ok(()))) => success_count += 1,
                    Ok((current, file_name, Err(error))) if error != "video-convert:cancelled" => {
                        fail_count += 1;
                        errors.push(format!("{}: {}", file_name, error));
                        let _ = app_handle.emit(
                            "convert-progress",
                            ConvertProgress {
                                file_name,
                                current,
                                total,
                                progress: 1.0,
                                status: "error".to_string(),
                            },
                        );
                    }
                    Ok(_) => {}
                    Err(error) => {
                        fail_count += 1;
                        errors.push(format!("Video worker failed: {}", error));
                    }
                }
            }
        }
    }

    while let Some(result) = join_set.join_next().await {
        match result {
            Ok((_current, _file_name, Ok(()))) => success_count += 1,
            Ok((current, file_name, Err(error))) if error != "video-convert:cancelled" => {
                fail_count += 1;
                errors.push(format!("{}: {}", file_name, error));
                let _ = app_handle.emit(
                    "convert-progress",
                    ConvertProgress {
                        file_name,
                        current,
                        total,
                        progress: 1.0,
                        status: "error".to_string(),
                    },
                );
            }
            Ok(_) => {}
            Err(error) => {
                fail_count += 1;
                errors.push(format!("Video worker failed: {}", error));
            }
        }
    }

    if CANCEL_FLAG.load(Ordering::SeqCst) {
        return Err("video-convert:cancelled".to_string());
    }
    Ok(BatchConvertResult {
        success_count,
        fail_count,
        output_dir: output_dir.to_string_lossy().to_string(),
        errors,
        original_size: None,
        compressed_size: None,
    })
}

#[cfg(test)]
mod video_conversion_tests {
    use super::*;

    fn test_directory(label: &str) -> std::path::PathBuf {
        let suffix = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("system clock is valid")
            .as_nanos();
        let directory = std::env::temp_dir().join(format!(
            "toolknit-video-{}-{}-{}",
            label,
            std::process::id(),
            suffix
        ));
        std::fs::create_dir_all(&directory).expect("create temporary test directory");
        directory
    }

    #[test]
    fn video_convert_accepts_only_declared_target_formats() {
        let webm = video_convert_profile(" webm ").expect("webm should be supported");
        assert_eq!(webm.1, "libvpx-vp9");
        assert!(
            webm.0.is_none(),
            "WebM must not use an incompatible H.264 NVENC encoder"
        );
        assert!(video_convert_profile("mpeg").is_err());
    }

    #[test]
    fn video_convert_rejects_duplicate_or_invalid_input_paths() {
        let directory = test_directory("validation");
        let video = directory.join("clip.m4v");
        std::fs::write(&video, [0_u8; 32]).expect("write fixture video");
        let video_path = video.to_string_lossy().into_owned();
        assert_eq!(
            validate_video_convert_inputs(&[video_path.clone()])
                .expect("m4v input should be accepted")
                .len(),
            1
        );
        assert_eq!(
            validate_video_convert_inputs(&[video_path.clone(), video_path])
                .expect_err("duplicate input must be rejected"),
            "video-convert:duplicate-input"
        );
        let invalid = directory.join("clip.txt");
        std::fs::write(&invalid, [0_u8; 32]).expect("write invalid fixture");
        assert_eq!(
            validate_video_convert_inputs(&[invalid.to_string_lossy().into_owned()])
                .expect_err("non-video input must be rejected"),
            "video-convert:invalid-input"
        );
        std::fs::remove_dir_all(&directory).expect("remove temporary test directory");
    }

    #[test]
    fn video_convert_parses_timestamp_progress() {
        assert_eq!(parse_ffmpeg_timestamp("01:02:03.5"), Some(3723.5));
        assert_eq!(
            parse_ffmpeg_progress_seconds("out_time=00:00:05.25"),
            Some(5.25)
        );
        assert_eq!(
            parse_ffmpeg_progress_seconds("out_time_us=2500000"),
            Some(2.5)
        );
        assert_eq!(parse_ffmpeg_timestamp("bad"), None);
    }

    #[test]
    fn video_convert_publishes_unique_output_without_overwriting() {
        let directory = test_directory("publish");
        let existing = directory.join("sample_converted.mp4");
        let temporary = directory.join(".toolknit-video-temp.mp4");
        std::fs::write(&existing, b"original-output").expect("write existing output");
        std::fs::write(&temporary, b"new-output").expect("write temporary output");

        let published = publish_video_convert_output(&temporary, &directory, "sample", ".mp4")
            .expect("publish a unique output");
        assert!(published.ends_with("sample_converted_1.mp4"));
        assert_eq!(
            std::fs::read(&existing).expect("read existing output"),
            b"original-output"
        );
        assert_eq!(
            std::fs::read(&published).expect("read published output"),
            b"new-output"
        );
        assert!(!temporary.exists());
        std::fs::remove_dir_all(&directory).expect("remove temporary test directory");
    }
}