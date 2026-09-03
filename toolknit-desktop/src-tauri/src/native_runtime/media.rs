const VIDEO_CONVERT_MAX_BATCH_FILES: usize = 30;
const VIDEO_CONVERT_MAX_INPUT_BYTES: u64 = 10 * 1024 * 1024 * 1024;

fn video_convert_profile(
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

fn validate_video_convert_inputs(
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

fn validate_video_convert_output_dir(output_dir: &str) -> Result<std::path::PathBuf, String> {
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

fn video_convert_file_stem(input: &std::path::Path) -> String {
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

fn create_video_convert_temp_path(
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

fn publish_video_convert_output(
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

fn parse_ffmpeg_timestamp(value: &str) -> Option<f64> {
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

fn parse_ffmpeg_duration(stderr: &str) -> Option<f64> {
    stderr.lines().find_map(|line| {
        let duration = line.split_once("Duration:")?.1.trim();
        let value = duration.split(',').next()?.trim();
        parse_ffmpeg_timestamp(value)
    })
}

fn parse_ffmpeg_progress_seconds(line: &str) -> Option<f64> {
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

fn compact_video_convert_error(stderr: &str) -> String {
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

async fn probe_video_convert_duration(
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

async fn has_video_nvenc_encoder(ffmpeg_path: &std::path::Path, encoder: &str) -> bool {
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

async fn convert_video_file(
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
async fn convert_video_batch(
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

#[derive(serde::Serialize)]
struct ProbeResult {
    duration: f64,
    file_size: u64,
    audio_tracks: Vec<AudioTrack>,
    frame_rate: f64,
    width: u32,
    height: u32,
}

#[derive(serde::Serialize)]
struct AudioTrack {
    index: usize,
    codec: String,
    language: String,
    channels: String,
}

const AUDIO_EXTRACT_MAX_INPUT_BYTES: u64 = 10 * 1024 * 1024 * 1024;
const AUDIO_EXTRACT_MAX_TRACK_INDEX: usize = 31;

fn validate_audio_extract_input(input_path: &str) -> Result<std::path::PathBuf, String> {
    if input_path.contains('\0') {
        return Err("audio-extract:invalid-input".to_string());
    }
    let input = std::path::PathBuf::from(input_path);
    let extension = input
        .extension()
        .and_then(|value| value.to_str())
        .map(|value| value.to_ascii_lowercase());
    let metadata =
        std::fs::symlink_metadata(&input).map_err(|_| "audio-extract:invalid-input".to_string())?;
    if metadata.file_type().is_symlink()
        || !metadata.is_file()
        || !matches!(
            extension.as_deref(),
            Some("mp4" | "mkv" | "avi" | "mov" | "webm" | "flv" | "wmv" | "ts" | "m4v")
        )
    {
        return Err("audio-extract:invalid-input".to_string());
    }
    if metadata.len() == 0 {
        return Err("audio-extract:invalid-input".to_string());
    }
    if metadata.len() > AUDIO_EXTRACT_MAX_INPUT_BYTES {
        return Err("audio-extract:input-too-large".to_string());
    }
    input
        .canonicalize()
        .map_err(|_| "audio-extract:invalid-input".to_string())
}

fn validate_audio_extract_output_dir(output_dir: &str) -> Result<std::path::PathBuf, String> {
    if output_dir.trim().is_empty() || output_dir.contains('\0') {
        return Err("audio-extract:output-path".to_string());
    }
    let output_dir = std::path::PathBuf::from(output_dir);
    is_path_safe(&output_dir).map_err(|_| "audio-extract:output-path".to_string())?;
    std::fs::create_dir_all(&output_dir).map_err(|_| "audio-extract:output-path".to_string())?;
    if !output_dir.is_dir() {
        return Err("audio-extract:output-path".to_string());
    }
    let output_dir = output_dir
        .canonicalize()
        .map_err(|_| "audio-extract:output-path".to_string())?;
    is_path_safe(&output_dir).map_err(|_| "audio-extract:output-path".to_string())?;
    Ok(output_dir)
}

fn normalize_audio_extract_format(value: &str) -> Result<&'static str, String> {
    match value.trim().to_ascii_uppercase().as_str() {
        "MP3" => Ok("MP3"),
        "AAC" => Ok("AAC"),
        "WAV" => Ok("WAV"),
        "FLAC" => Ok("FLAC"),
        "OGG" => Ok("OGG"),
        _ => Err("audio-extract:invalid-target-format".to_string()),
    }
}

fn create_audio_extract_temp_path(
    output_dir: &std::path::Path,
    extension: &str,
) -> Result<std::path::PathBuf, String> {
    use std::time::{SystemTime, UNIX_EPOCH};

    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| "audio-extract:output-path".to_string())?
        .as_nanos();
    for attempt in 0..100_u32 {
        let candidate = output_dir.join(format!(
            ".toolknit-audio-extract-{}-{}-{}{}",
            std::process::id(),
            timestamp,
            attempt,
            extension
        ));
        if !candidate.exists() {
            return Ok(candidate);
        }
    }
    Err("audio-extract:output-path".to_string())
}

fn audio_extract_file_stem(input: &std::path::Path) -> String {
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

fn publish_audio_extract_output(
    temporary_path: &std::path::Path,
    output_dir: &std::path::Path,
    source_stem: &str,
    extension: &str,
) -> Result<String, String> {
    for counter in 0..10_000_u32 {
        let name = if counter == 0 {
            format!("{}_audio{}", source_stem, extension)
        } else {
            format!("{}_audio_{}{}", source_stem, counter, extension)
        };
        let candidate = output_dir.join(name);
        match std::fs::hard_link(temporary_path, &candidate) {
            Ok(()) => {
                std::fs::remove_file(temporary_path)
                    .map_err(|_| "audio-extract:output-path".to_string())?;
                return Ok(candidate.to_string_lossy().into_owned());
            }
            Err(_) if candidate.exists() => continue,
            Err(_) => return Err("audio-extract:output-path".to_string()),
        }
    }
    Err("audio-extract:output-path".to_string())
}

#[tauri::command]
async fn probe_video(input_path: String) -> Result<ProbeResult, String> {
    let input = validate_audio_extract_input(&input_path)?;
    let ffmpeg_path = get_ffmpeg_path()?;
    let mut cmd = tokio::process::Command::new(&ffmpeg_path);
    cmd.arg("-i")
        .arg(&input)
        .arg("-hide_banner")
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());

    #[cfg(target_os = "windows")]
    {
        cmd.creation_flags(0x08000000);
    }

    let output = cmd
        .spawn()
        .map_err(|e| format!("Failed to run ffmpeg: {}", e))?
        .wait_with_output()
        .await
        .map_err(|e| format!("ffmpeg wait failed: {}", e))?;

    let stderr = String::from_utf8_lossy(&output.stderr).to_string();

    // Parse duration
    let mut duration: f64 = 0.0;
    for line in stderr.lines() {
        if line.contains("Duration:") {
            let start = line.find("Duration:").map(|i| i + 9);
            if let Some(s) = start {
                let dur_str = line[s..].trim();
                let end = dur_str.find(',').unwrap_or(dur_str.len());
                let parts: Vec<&str> = dur_str[..end].trim().split(':').collect();
                if parts.len() == 3 {
                    let h: f64 = parts[0].trim().parse().unwrap_or(0.0);
                    let m: f64 = parts[1].trim().parse().unwrap_or(0.0);
                    let s: f64 = parts[2].trim().parse().unwrap_or(0.0);
                    duration = h * 3600.0 + m * 60.0 + s;
                }
            }
            break;
        }
    }

    // Parse the primary video stream's declared frame rate for desktop frame stepping.
    let mut frame_rate = 0.0;
    let mut video_width: u32 = 0;
    let mut video_height: u32 = 0;
    for line in stderr.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with("Stream #") && trimmed.contains("Video:") {
            let tokens: Vec<&str> = trimmed.split_whitespace().collect();
            for token in &tokens {
                let clean = token.trim_end_matches(',').trim();
                if let Some((w, h)) = clean.split_once('x') {
                    if let (Ok(parsed_w), Ok(parsed_h)) = (w.parse::<u32>(), h.parse::<u32>()) {
                        if parsed_w > 0 && parsed_h > 0 {
                            video_width = parsed_w;
                            video_height = parsed_h;
                            break;
                        }
                    }
                }
            }
            for pair in tokens.windows(2) {
                if pair[1].eq_ignore_ascii_case("fps") {
                    frame_rate = pair[0].trim_end_matches(',').parse::<f64>().unwrap_or(0.0);
                    break;
                }
            }
            break;
        }
    }

    // Parse audio tracks
    let mut audio_tracks = Vec::new();
    for line in stderr.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with("Stream #") && trimmed.contains("Audio:") {
            let index = audio_tracks.len();
            let codec = if trimmed.contains("mp3") {
                "MP3"
            } else if trimmed.contains("aac") {
                "AAC"
            } else if trimmed.contains("ac3") {
                "AC3"
            } else if trimmed.contains("vorbis") {
                "Vorbis"
            } else if trimmed.contains("opus") {
                "Opus"
            } else if trimmed.contains("flac") {
                "FLAC"
            } else if trimmed.contains("pcm") {
                "PCM"
            } else {
                "Unknown"
            };
            let language = if trimmed.contains("(") {
                let lang_start = trimmed.rfind("(").map(|i| i + 1);
                let lang_end = trimmed.rfind(")").unwrap_or(trimmed.len());
                if let Some(s) = lang_start {
                    trimmed[s..lang_end].to_string()
                } else {
                    "default".to_string()
                }
            } else {
                "default".to_string()
            };
            let channels = if trimmed.contains("mono") {
                "mono"
            } else if trimmed.contains("stereo") {
                "stereo"
            } else if trimmed.contains("5.1") {
                "5.1"
            } else if trimmed.contains("7.1") {
                "7.1"
            } else {
                "unknown"
            };
            audio_tracks.push(AudioTrack {
                index,
                codec: codec.to_string(),
                language,
                channels: channels.to_string(),
            });
        }
    }

    let file_size = std::fs::metadata(&input).map(|m| m.len()).unwrap_or(0);

    Ok(ProbeResult {
        duration,
        file_size,
        audio_tracks,
        frame_rate,
        width: video_width,
        height: video_height,
    })
}

#[derive(serde::Serialize)]
struct VideoPreviewFrame {
    image_data_url: String,
    timestamp_ms: u64,
}

#[derive(serde::Serialize)]
struct VideoPreviewClip {
    media_data_url: String,
    start_ms: u64,
    end_ms: u64,
}

fn validate_video_preview_clip_range(start_ms: u64, end_ms: u64) -> Result<(), String> {
    const MAX_TIMESTAMP_MS: u64 = 24 * 60 * 60 * 1000;
    const MAX_DURATION_MS: u64 = 30_000;
    if end_ms <= start_ms || end_ms > MAX_TIMESTAMP_MS || end_ms - start_ms > MAX_DURATION_MS {
        return Err("video-preview:invalid-range".to_string());
    }
    Ok(())
}

/// Render a lightweight preview with the same FFmpeg decoder used for exports.
/// WebView media support varies by installed Windows codecs, so the desktop UI
/// deliberately does not depend on HTML video decoding for frame selection.
#[tauri::command]
async fn render_video_preview_frame(
    input_path: String,
    timestamp_ms: u64,
) -> Result<VideoPreviewFrame, String> {
    use base64::Engine;

    const MAX_TIMESTAMP_MS: u64 = 24 * 60 * 60 * 1000;
    const MAX_PREVIEW_BYTES: usize = 8 * 1024 * 1024;

    let input = validate_audio_extract_input(&input_path)?;
    if timestamp_ms > MAX_TIMESTAMP_MS {
        return Err("video-preview:invalid-timestamp".to_string());
    }
    let ffmpeg = get_ffmpeg_path()?;
    let mut command = tokio::process::Command::new(&ffmpeg);
    command
        .arg("-hide_banner")
        .arg("-nostdin")
        .arg("-loglevel")
        .arg("error")
        .arg("-i")
        .arg(&input)
        // Put -ss after the input so keyboard frame stepping matches export.
        .arg("-ss")
        .arg(format!("{:.3}", timestamp_ms as f64 / 1000.0))
        .arg("-map")
        .arg("0:v:0")
        .arg("-frames:v")
        .arg("1")
        .arg("-vf")
        .arg("scale=w='min(1280,iw)':h='min(720,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2:flags=lanczos")
        .arg("-c:v")
        .arg("mjpeg")
        .arg("-q:v")
        .arg("4")
        .arg("-f")
        .arg("image2pipe")
        .arg("pipe:1")
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    #[cfg(target_os = "windows")]
    {
        command.creation_flags(0x08000000);
    }

    let output = command
        .spawn()
        .map_err(|_| "video-preview:engine-failed".to_string())?
        .wait_with_output()
        .await
        .map_err(|_| "video-preview:engine-failed".to_string())?;
    if !output.status.success() || output.stdout.is_empty() {
        return Err("video-preview:engine-failed".to_string());
    }
    if output.stdout.len() > MAX_PREVIEW_BYTES {
        return Err("video-preview:output-too-large".to_string());
    }

    Ok(VideoPreviewFrame {
        image_data_url: format!(
            "data:image/jpeg;base64,{}",
            base64::engine::general_purpose::STANDARD.encode(output.stdout)
        ),
        timestamp_ms,
    })
}

/// Transcode the selected range to a small, browser-compatible stream. The source
/// file itself is never exposed to the WebView, whose codec support is inconsistent.
#[tauri::command]
async fn render_video_preview_clip(
    input_path: String,
    start_ms: u64,
    end_ms: u64,
) -> Result<VideoPreviewClip, String> {
    use base64::Engine;

    const MAX_PREVIEW_BYTES: usize = 10 * 1024 * 1024;

    validate_video_preview_clip_range(start_ms, end_ms)?;
    let input = validate_audio_extract_input(&input_path)?;
    let ffmpeg = get_ffmpeg_path()?;
    let source_duration = probe_video_convert_duration(&ffmpeg, &input)
        .await
        .unwrap_or(0.0);
    if source_duration > 0.0 && end_ms as f64 > source_duration * 1000.0 + 1.0 {
        return Err("video-preview:timestamp-out-of-range".to_string());
    }

    let mut command = tokio::process::Command::new(&ffmpeg);
    command
        .arg("-hide_banner")
        .arg("-nostdin")
        .arg("-loglevel")
        .arg("error")
        .arg("-i")
        .arg(&input)
        .arg("-ss")
        .arg(format!("{:.3}", start_ms as f64 / 1000.0))
        .arg("-t")
        .arg(format!("{:.3}", (end_ms - start_ms) as f64 / 1000.0))
        .arg("-map")
        .arg("0:v:0")
        .arg("-an")
        .arg("-vf")
        .arg("fps=12,scale=w='min(960,iw)':h='min(540,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2:flags=lanczos")
        .arg("-c:v")
        .arg("libx264")
        .arg("-profile:v")
        .arg("baseline")
        .arg("-level:v")
        .arg("3.1")
        .arg("-preset")
        .arg("veryfast")
        .arg("-crf")
        .arg("27")
        .arg("-maxrate")
        .arg("900k")
        .arg("-bufsize")
        .arg("1800k")
        .arg("-pix_fmt")
        .arg("yuv420p")
        .arg("-movflags")
        .arg("+frag_keyframe+empty_moov+default_base_moof")
        .arg("-f")
        .arg("mp4")
        .arg("pipe:1")
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    #[cfg(target_os = "windows")]
    {
        command.creation_flags(0x08000000);
    }

    let output = command
        .spawn()
        .map_err(|_| "video-preview:engine-failed".to_string())?
        .wait_with_output()
        .await
        .map_err(|_| "video-preview:engine-failed".to_string())?;
    if !output.status.success() || output.stdout.is_empty() {
        return Err("video-preview:engine-failed".to_string());
    }
    if output.stdout.len() > MAX_PREVIEW_BYTES {
        return Err("video-preview:output-too-large".to_string());
    }

    Ok(VideoPreviewClip {
        media_data_url: format!(
            "data:video/mp4;base64,{}",
            base64::engine::general_purpose::STANDARD.encode(output.stdout)
        ),
        start_ms,
        end_ms,
    })
}

#[cfg(test)]
mod video_preview_contract_tests {
    use super::*;

    #[test]
    fn preview_clip_accepts_a_gif_sized_selection_only() {
        assert!(validate_video_preview_clip_range(0, 30_000).is_ok());
        assert_eq!(
            validate_video_preview_clip_range(0, 30_001).unwrap_err(),
            "video-preview:invalid-range"
        );
        assert_eq!(
            validate_video_preview_clip_range(4_000, 4_000).unwrap_err(),
            "video-preview:invalid-range"
        );
    }

    #[tokio::test]
    async fn preview_clip_transcodes_to_a_browser_compatible_mp4_stream() {
        use base64::Engine;

        let _guard = test_conversion_lock();
        let Ok(ffmpeg) = get_ffmpeg_path() else {
            return;
        };
        let unique = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("system clock is valid")
            .as_nanos();
        let directory = std::env::temp_dir().join(format!(
            "toolknit-video-preview-{}-{}",
            std::process::id(),
            unique
        ));
        std::fs::create_dir_all(&directory).expect("create preview test directory");
        let source = directory.join("sample.mp4");
        let generated = std::process::Command::new(&ffmpeg)
            .args([
                "-hide_banner",
                "-loglevel",
                "error",
                "-y",
                "-f",
                "lavfi",
                "-i",
                "testsrc2=size=320x180:rate=12",
                "-t",
                "2",
                "-c:v",
                "libx264",
                "-pix_fmt",
                "yuv420p",
            ])
            .arg(&source)
            .status()
            .expect("start fixture encoder");
        assert!(generated.success(), "create preview fixture");

        let preview = render_video_preview_clip(source.to_string_lossy().into_owned(), 0, 1_000)
            .await
            .expect("render preview clip");
        let encoded = preview
            .media_data_url
            .strip_prefix("data:video/mp4;base64,")
            .expect("video preview data URL");
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(encoded)
            .expect("decode preview video");
        assert!(bytes.windows(4).any(|chunk| chunk == b"ftyp"));
        assert!(bytes.len() > 1_000, "preview stream is non-empty");

        std::fs::remove_dir_all(&directory).expect("remove preview test directory");
    }
}

#[derive(serde::Serialize)]
struct VideoFrameResult {
    output_path: String,
    timestamp_ms: u64,
    format: String,
}

fn publish_video_frame_output(
    temporary_path: &std::path::Path,
    output_dir: &std::path::Path,
    source_stem: &str,
    timestamp_ms: u64,
    extension: &str,
) -> Result<String, String> {
    for counter in 0..10_000_u32 {
        let suffix = if counter == 0 {
            String::new()
        } else {
            format!("_{}", counter)
        };
        let candidate = output_dir.join(format!(
            "{}_frame_{}ms{}{}",
            source_stem, timestamp_ms, suffix, extension
        ));
        match std::fs::hard_link(temporary_path, &candidate) {
            Ok(()) => {
                std::fs::remove_file(temporary_path)
                    .map_err(|_| "video-frame:output-path".to_string())?;
                return Ok(candidate.to_string_lossy().into_owned());
            }
            Err(_) if candidate.exists() => continue,
            Err(_) => return Err("video-frame:output-path".to_string()),
        }
    }
    Err("video-frame:output-path".to_string())
}

#[tauri::command]
async fn extract_video_frame(
    app_handle: tauri::AppHandle,
    input_path: String,
    output_dir: String,
    timestamp_ms: u64,
    format: String,
) -> Result<VideoFrameResult, String> {
    use tauri::Emitter;
    let _guard = begin_conversion()?;
    let input = validate_audio_extract_input(&input_path)?;
    if timestamp_ms > 24 * 60 * 60 * 1000 {
        return Err("video-frame:invalid-timestamp".to_string());
    }
    let normalized_format = match format.trim().to_ascii_lowercase().as_str() {
        "png" => "png",
        "jpg" | "jpeg" => "jpg",
        _ => return Err("video-frame:invalid-format".to_string()),
    };
    let output_dir = validate_audio_extract_output_dir(&output_dir)?;
    let ffmpeg = get_ffmpeg_path()?;
    let duration = probe_video_convert_duration(&ffmpeg, &input)
        .await
        .unwrap_or(0.0);
    if duration > 0.0 && timestamp_ms as f64 > duration * 1000.0 + 1.0 {
        return Err("video-frame:timestamp-out-of-range".to_string());
    }
    let extension = if normalized_format == "png" {
        ".png"
    } else {
        ".jpg"
    };
    let temporary = create_audio_extract_temp_path(&output_dir, extension)?;
    let _ = app_handle.emit(
        "video-frame-progress",
        serde_json::json!({ "progress": 0.1, "phase": "prepare" }),
    );
    let mut command = tokio::process::Command::new(&ffmpeg);
    command
        .arg("-hide_banner")
        .arg("-nostdin")
        .arg("-y")
        .arg("-i")
        .arg(&input)
        .arg("-ss")
        .arg(format!("{:.3}", timestamp_ms as f64 / 1000.0))
        .arg("-map")
        .arg("0:v:0")
        .arg("-frames:v")
        .arg("1");
    if normalized_format == "png" {
        command.arg("-c:v").arg("png");
    } else {
        command.arg("-q:v").arg("2");
    }
    command
        .arg(&temporary)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    #[cfg(target_os = "windows")]
    {
        command.creation_flags(0x08000000);
    }
    let result = command
        .spawn()
        .map_err(|_| "video-frame:engine-failed".to_string())?
        .wait_with_output()
        .await
        .map_err(|_| "video-frame:engine-failed".to_string())?;
    if CANCEL_FLAG.load(Ordering::SeqCst) {
        let _ = std::fs::remove_file(&temporary);
        return Err("video-frame:cancelled".to_string());
    }
    if !result.status.success()
        || !temporary.is_file()
        || std::fs::metadata(&temporary).map(|m| m.len()).unwrap_or(0) == 0
    {
        let _ = std::fs::remove_file(&temporary);
        return Err("video-frame:engine-failed".to_string());
    }
    let _ = app_handle.emit(
        "video-frame-progress",
        serde_json::json!({ "progress": 0.9, "phase": "publish" }),
    );
    let output_path = publish_video_frame_output(
        &temporary,
        &output_dir,
        &audio_extract_file_stem(&input),
        timestamp_ms,
        extension,
    )?;
    let _ = app_handle.emit(
        "video-frame-progress",
        serde_json::json!({ "progress": 1.0, "phase": "complete" }),
    );
    Ok(VideoFrameResult {
        output_path,
        timestamp_ms,
        format: normalized_format.to_string(),
    })
}

#[derive(serde::Serialize)]
struct VideoGifResult {
    output_path: String,
    start_ms: u64,
    end_ms: u64,
    duration_ms: u64,
    frame_rate: u32,
    width: u32,
    quality: String,
    output_size: u64,
}

fn publish_video_gif_output(
    temporary_path: &std::path::Path,
    output_dir: &std::path::Path,
    source_stem: &str,
    start_ms: u64,
    end_ms: u64,
) -> Result<String, String> {
    for counter in 0..10_000_u32 {
        let suffix = if counter == 0 {
            String::new()
        } else {
            format!("_{}", counter)
        };
        let candidate = output_dir.join(format!(
            "{}_clip_{}-{}ms{}.gif",
            source_stem, start_ms, end_ms, suffix
        ));
        match std::fs::hard_link(temporary_path, &candidate) {
            Ok(()) => {
                std::fs::remove_file(temporary_path)
                    .map_err(|_| "video-gif:output-path".to_string())?;
                return Ok(candidate.to_string_lossy().into_owned());
            }
            Err(_) if candidate.exists() => continue,
            Err(_) => return Err("video-gif:output-path".to_string()),
        }
    }
    Err("video-gif:output-path".to_string())
}

#[tauri::command]
async fn extract_video_gif(
    app_handle: tauri::AppHandle,
    input_path: String,
    output_dir: String,
    start_ms: u64,
    end_ms: u64,
    frame_rate: Option<u32>,
    width: Option<u32>,
    quality: Option<String>,
) -> Result<VideoGifResult, String> {
    use tauri::Emitter;
    const MAX_GIF_DURATION_MS: u64 = 30_000;
    const MAX_GIF_OUTPUT_BYTES: u64 = 500 * 1024 * 1024;
    let _guard = begin_conversion()?;
    let input = validate_audio_extract_input(&input_path)?;
    if end_ms <= start_ms || end_ms - start_ms > MAX_GIF_DURATION_MS || end_ms > 24 * 60 * 60 * 1000
    {
        return Err("video-gif:invalid-range".to_string());
    }
    let frame_rate = frame_rate.unwrap_or(12);
    let width = width.unwrap_or(640);
    if !(1..=20).contains(&frame_rate) || !(160..=1920).contains(&width) {
        return Err("video-gif:invalid-settings".to_string());
    }
    let quality = quality
        .unwrap_or_else(|| "balanced".to_string())
        .trim()
        .to_ascii_lowercase();
    let (max_colors, dither) = match quality.as_str() {
        "high" => (256_u32, "sierra2_4a"),
        "balanced" => (192_u32, "bayer:bayer_scale=3"),
        "small" => (128_u32, "bayer:bayer_scale=4"),
        "tiny" => (96_u32, "bayer:bayer_scale=5"),
        _ => return Err("video-gif:invalid-quality".to_string()),
    };
    let output_dir = validate_audio_extract_output_dir(&output_dir)?;
    let ffmpeg = get_ffmpeg_path()?;
    let duration = probe_video_convert_duration(&ffmpeg, &input)
        .await
        .unwrap_or(0.0);
    if duration > 0.0 && end_ms as f64 > duration * 1000.0 + 1.0 {
        return Err("video-gif:timestamp-out-of-range".to_string());
    }
    let temporary = create_audio_extract_temp_path(&output_dir, ".gif")?;
    let _ = app_handle.emit(
        "video-gif-progress",
        serde_json::json!({ "progress": 0.05, "phase": "prepare" }),
    );
    let filter = format!("fps={},scale=w='min({},iw)':h=-2:flags=lanczos,split[a][b];[a]palettegen=max_colors={}:stats_mode=diff[p];[b][p]paletteuse=dither={}:diff_mode=rectangle[out]", frame_rate, width, max_colors, dither);
    let mut command = tokio::process::Command::new(&ffmpeg);
    command
        .arg("-hide_banner")
        .arg("-nostdin")
        .arg("-y")
        .arg("-i")
        .arg(&input)
        .arg("-ss")
        .arg(format!("{:.3}", start_ms as f64 / 1000.0))
        .arg("-t")
        .arg(format!("{:.3}", (end_ms - start_ms) as f64 / 1000.0))
        .arg("-filter_complex")
        .arg(filter)
        .arg("-map")
        .arg("[out]")
        .arg("-loop")
        .arg("0")
        .arg(&temporary)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    #[cfg(target_os = "windows")]
    {
        command.creation_flags(0x08000000);
    }
    let result = command
        .spawn()
        .map_err(|_| "video-gif:engine-failed".to_string())?
        .wait_with_output()
        .await
        .map_err(|_| "video-gif:engine-failed".to_string())?;
    if CANCEL_FLAG.load(Ordering::SeqCst) {
        let _ = std::fs::remove_file(&temporary);
        return Err("video-gif:cancelled".to_string());
    }
    let metadata =
        std::fs::metadata(&temporary).map_err(|_| "video-gif:engine-failed".to_string())?;
    if !result.status.success() || !metadata.is_file() || metadata.len() == 0 {
        let _ = std::fs::remove_file(&temporary);
        return Err("video-gif:engine-failed".to_string());
    }
    if metadata.len() > MAX_GIF_OUTPUT_BYTES {
        let _ = std::fs::remove_file(&temporary);
        return Err("video-gif:output-too-large".to_string());
    }
    let output_size = metadata.len();
    let _ = app_handle.emit(
        "video-gif-progress",
        serde_json::json!({ "progress": 0.92, "phase": "publish" }),
    );
    let output_path = publish_video_gif_output(
        &temporary,
        &output_dir,
        &audio_extract_file_stem(&input),
        start_ms,
        end_ms,
    )?;
    let _ = app_handle.emit(
        "video-gif-progress",
        serde_json::json!({ "progress": 1.0, "phase": "complete" }),
    );
    Ok(VideoGifResult {
        output_path,
        start_ms,
        end_ms,
        duration_ms: end_ms - start_ms,
        frame_rate,
        width,
        quality,
        output_size,
    })
}

#[derive(serde::Serialize)]
struct ExtractResult {
    success: bool,
    output_path: String,
    error: Option<String>,
}

fn emit_audio_extract_progress(app_handle: &Option<tauri::AppHandle>, status: &str, progress: f64) {
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
async fn extract_audio(
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

async fn extract_audio_inner(
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

fn is_path_safe(path: &std::path::Path) -> Result<(), String> {
    // Try to canonicalize the path. If it doesn't exist (e.g. a new output file
    // or a not-yet-created subdirectory), walk up ancestors until one exists.
    let canonical = path
        .canonicalize()
        .or_else(|_| {
            let mut ancestor = path.parent();
            while let Some(a) = ancestor {
                if let Ok(c) = a.canonicalize() {
                    return Ok(c);
                }
                ancestor = a.parent();
            }
            Err(std::io::Error::new(
                std::io::ErrorKind::NotFound,
                "No existing ancestor",
            ))
        })
        .map_err(|e| format!("Invalid path: {}", e))?;
    let docs = dirs::document_dir().ok_or("Cannot find Documents folder")?;
    let dl = dirs::download_dir().ok_or("Cannot find Download folder")?;
    let appdata = dirs::data_dir().ok_or("Cannot find AppData folder")?;
    let temp = std::env::temp_dir();
    // Canonicalize all comparison dirs so prefixes match (Windows \\?\ prefix)
    let docs_c = docs.canonicalize().unwrap_or(docs.clone());
    let dl_c = dl.canonicalize().unwrap_or(dl.clone());
    let appdata_c = appdata.canonicalize().unwrap_or(appdata.clone());
    let temp_c = temp.canonicalize().unwrap_or(temp.clone());
    // Also allow the exe's parent directory (install directory) for output files
    let exe_dir = std::env::current_exe()
        .ok()
        .and_then(|e| e.parent().map(|p| p.to_path_buf()))
        .and_then(|p| p.canonicalize().ok().or(Some(p)));
    // Also allow the install_path from install_config.json (may differ from exe_dir if exe is in a subdirectory)
    let install_dir = {
        let exe = std::env::current_exe().ok();
        exe.and_then(|e| {
            e.parent().and_then(|p| {
                let mut search = p.to_path_buf();
                for _ in 0..4 {
                    let candidate = search.join("install_config.json");
                    if candidate.exists() {
                        if let Ok(content) = std::fs::read_to_string(&candidate) {
                            if let Ok(config) = serde_json::from_str::<serde_json::Value>(&content)
                            {
                                if let Some(ip) = config.get("installPath").and_then(|v| v.as_str())
                                {
                                    let p = std::path::PathBuf::from(ip);
                                    return p.canonicalize().ok().or(Some(p));
                                }
                            }
                        }
                    }
                    match search.parent() {
                        Some(p2) => search = p2.to_path_buf(),
                        None => break,
                    }
                }
                None
            })
        })
    };
    let output_root = configured_output_root();
    let is_allowed = canonical.starts_with(&docs_c)
        || canonical.starts_with(&dl_c)
        || canonical.starts_with(&appdata_c)
        || canonical.starts_with(&temp_c)
        || exe_dir.as_ref().map_or(false, |d| canonical.starts_with(d))
        || install_dir
            .as_ref()
            .map_or(false, |d| canonical.starts_with(d))
        || output_root
            .as_ref()
            .map_or(false, |d| canonical.starts_with(d));
    if is_allowed {
        Ok(())
    } else {
        Err("Path outside allowed directories".to_string())
    }
}

#[tauri::command]
fn read_file_bytes(path: String) -> Result<Vec<u8>, String> {
    // Reject files larger than 500MB to prevent OOM
    const MAX_FILE_SIZE: u64 = 500 * 1024 * 1024;
    if path.contains('\0') {
        return Err("Invalid path".to_string());
    }
    let metadata =
        std::fs::metadata(&path).map_err(|e| format!("Failed to read file metadata: {}", e))?;
    if metadata.len() > MAX_FILE_SIZE {
        return Err(format!(
            "File too large ({}MB, max 500MB)",
            metadata.len() / 1024 / 1024
        ));
    }
    std::fs::read(&path).map_err(|e| format!("Failed to read file: {}", e))
}

#[tauri::command]
fn read_file_bytes_limited(path: String, max_bytes: u64) -> Result<Vec<u8>, String> {
    use std::io::Read;

    const ABSOLUTE_MAX_FILE_SIZE: u64 = 500 * 1024 * 1024;
    if path.contains('\0') || max_bytes == 0 || max_bytes > ABSOLUTE_MAX_FILE_SIZE {
        return Err("Invalid file read request".to_string());
    }

    let metadata =
        std::fs::metadata(&path).map_err(|e| format!("Failed to read file metadata: {}", e))?;
    if !metadata.is_file() {
        return Err("Input path must be a file".to_string());
    }
    if metadata.len() > max_bytes {
        return Err(format!(
            "File too large ({}MB)",
            metadata.len() / 1024 / 1024
        ));
    }

    // Read one byte past the limit so a concurrent file replacement cannot bypass the size check.
    let file = std::fs::File::open(&path).map_err(|e| format!("Failed to open file: {}", e))?;
    let mut reader = file.take(max_bytes + 1);
    let mut bytes = Vec::with_capacity(metadata.len() as usize);
    reader
        .read_to_end(&mut bytes)
        .map_err(|e| format!("Failed to read file: {}", e))?;
    if bytes.len() as u64 > max_bytes {
        return Err(format!(
            "File too large (max {}MB)",
            max_bytes / 1024 / 1024
        ));
    }
    Ok(bytes)
}

#[derive(serde::Serialize)]
struct PreparedIconSourceImage {
    bytes: Vec<u8>,
    width: u32,
    height: u32,
    source_bytes: u64,
}

#[tauri::command]
fn prepare_icon_source_image(path: String) -> Result<PreparedIconSourceImage, String> {
    use image::ImageEncoder;

    const MAX_INPUT_BYTES: u64 = 20 * 1024 * 1024;
    const MAX_INPUT_PIXELS: u64 = 20_000_000;
    if path.contains('\0') {
        return Err("Invalid image path".to_string());
    }
    let source = std::path::PathBuf::from(path)
        .canonicalize()
        .map_err(|error| format!("Cannot access image file: {}", error))?;
    let extension = source
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    if !matches!(extension.as_str(), "png" | "jpg" | "jpeg" | "webp") {
        return Err("Only PNG, JPEG, and WebP images can be used for icon generation.".to_string());
    }
    let metadata = std::fs::metadata(&source)
        .map_err(|error| format!("Cannot read image file metadata: {}", error))?;
    if !metadata.is_file() {
        return Err("Input path must be an image file".to_string());
    }
    if metadata.len() == 0 || metadata.len() > MAX_INPUT_BYTES {
        return Err(
            "The image file is empty or exceeds the supported file size limit.".to_string(),
        );
    }

    let image = decode_oriented_image(&source)
        .map_err(|error| format!("Cannot decode image file: {}", error))?;
    let width = image.width();
    let height = image.height();
    let pixels = u64::from(width).saturating_mul(u64::from(height));
    if width == 0 || height == 0 || pixels > MAX_INPUT_PIXELS {
        return Err("Image dimensions exceed the supported pixel limit.".to_string());
    }

    let rgba = image.to_rgba8();
    let mut bytes = Vec::new();
    image::codecs::png::PngEncoder::new(&mut bytes)
        .write_image(&rgba, width, height, image::ColorType::Rgba8.into())
        .map_err(|error| format!("Cannot prepare image for icon generation: {}", error))?;
    if bytes.is_empty() || bytes.len() as u64 > MAX_INPUT_BYTES {
        return Err("Prepared image exceeds the supported file size limit.".to_string());
    }

    Ok(PreparedIconSourceImage {
        bytes,
        width,
        height,
        source_bytes: metadata.len(),
    })
}

#[tauri::command]
fn write_file_bytes(path: String, bytes: Vec<u8>) -> Result<(), String> {
    use std::fs;
    use std::path::Path;
    let path = Path::new(&path);
    is_path_safe(path)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("Failed to create directory: {}", e))?;
    }
    fs::write(path, bytes).map_err(|e| format!("Failed to write file: {}", e))
}

#[tauri::command]
fn write_unique_file_bytes(
    directory: String,
    file_name: String,
    bytes: Vec<u8>,
) -> Result<String, String> {
    use std::fs::{self, OpenOptions};
    use std::io::Write;
    use std::path::Path;

    if directory.contains('\0') || file_name.contains('\0') {
        return Err("Invalid path".to_string());
    }
    let directory = Path::new(&directory);
    let file_path = Path::new(&file_name);
    if file_path.is_absolute() || file_path.components().count() != 1 {
        return Err("Output file name must not contain a path".to_string());
    }
    is_path_safe(directory)?;
    fs::create_dir_all(directory).map_err(|e| format!("Failed to create directory: {}", e))?;

    let stem = file_path
        .file_stem()
        .and_then(|value| value.to_str())
        .ok_or("Invalid output file name")?;
    let extension = file_path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("");

    for counter in 0..10_000_u32 {
        let candidate = if counter == 0 {
            file_name.clone()
        } else if extension.is_empty() {
            format!("{}_{}", stem, counter)
        } else {
            format!("{}_{}.{}", stem, counter, extension)
        };
        let output_path = directory.join(candidate);
        let mut output = match OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&output_path)
        {
            Ok(file) => file,
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(format!("Failed to create output file: {}", error)),
        };

        if let Err(error) = output.write_all(&bytes).and_then(|_| output.sync_all()) {
            drop(output);
            let _ = fs::remove_file(&output_path);
            return Err(format!("Failed to write output file: {}", error));
        }
        return Ok(output_path.to_string_lossy().into_owned());
    }

    Err("Unable to reserve a unique output file name".to_string())
}

#[derive(serde::Serialize)]
struct PairedFileWriteResult {
    first_path: String,
    second_path: String,
}

#[tauri::command]
fn write_unique_file_pair(
    directory: String,
    first_file_name: String,
    first_bytes: Vec<u8>,
    second_file_name: String,
    second_bytes: Vec<u8>,
) -> Result<PairedFileWriteResult, String> {
    use std::fs::{self, OpenOptions};
    use std::io::Write;
    use std::path::Path;

    const MAX_BYTES_PER_FILE: usize = 10 * 1024 * 1024;
    if directory.contains('\0')
        || first_file_name.contains('\0')
        || second_file_name.contains('\0')
        || first_bytes.len() > MAX_BYTES_PER_FILE
        || second_bytes.len() > MAX_BYTES_PER_FILE
    {
        return Err("Invalid paired output request".to_string());
    }
    let directory = Path::new(&directory);
    let first_path = Path::new(&first_file_name);
    let second_path = Path::new(&second_file_name);
    if first_file_name == second_file_name
        || first_path.is_absolute()
        || second_path.is_absolute()
        || first_path.components().count() != 1
        || second_path.components().count() != 1
    {
        return Err("Output file names must be distinct base names without paths".to_string());
    }
    is_path_safe(directory)?;
    fs::create_dir_all(directory)
        .map_err(|error| format!("Failed to create directory: {}", error))?;

    let first_stem = first_path
        .file_stem()
        .and_then(|value| value.to_str())
        .ok_or("Invalid first output name")?;
    let first_extension = first_path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("");
    let second_stem = second_path
        .file_stem()
        .and_then(|value| value.to_str())
        .ok_or("Invalid second output name")?;
    let second_extension = second_path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("");

    for counter in 0..10_000_u32 {
        let suffix = if counter == 0 {
            String::new()
        } else {
            format!("_{}", counter)
        };
        let first_name = if first_extension.is_empty() {
            format!("{}{}", first_stem, suffix)
        } else {
            format!("{}{}.{}", first_stem, suffix, first_extension)
        };
        let second_name = if second_extension.is_empty() {
            format!("{}{}", second_stem, suffix)
        } else {
            format!("{}{}.{}", second_stem, suffix, second_extension)
        };
        let first_output = directory.join(first_name);
        let second_output = directory.join(second_name);
        let mut first = match OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&first_output)
        {
            Ok(file) => file,
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => {
                return Err(format!(
                    "Failed to create refined subtitle output: {}",
                    error
                ))
            }
        };
        if let Err(error) = first.write_all(&first_bytes).and_then(|_| first.sync_all()) {
            drop(first);
            let _ = fs::remove_file(&first_output);
            return Err(format!(
                "Failed to write refined subtitle output: {}",
                error
            ));
        }
        drop(first);
        let mut second = match OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&second_output)
        {
            Ok(file) => file,
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                let _ = fs::remove_file(&first_output);
                continue;
            }
            Err(error) => {
                let _ = fs::remove_file(&first_output);
                return Err(format!("Failed to create refined text output: {}", error));
            }
        };
        if let Err(error) = second
            .write_all(&second_bytes)
            .and_then(|_| second.sync_all())
        {
            drop(second);
            let _ = fs::remove_file(&first_output);
            let _ = fs::remove_file(&second_output);
            return Err(format!("Failed to write refined text output: {}", error));
        }
        return Ok(PairedFileWriteResult {
            first_path: first_output.to_string_lossy().into_owned(),
            second_path: second_output.to_string_lossy().into_owned(),
        });
    }
    Err("Unable to reserve paired output file names".to_string())
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct MarkdownBundleAsset { file_name: String, bytes: Vec<u8> }

#[derive(serde::Serialize)]
struct MarkdownBundleResult { directory: String, markdown_path: String, asset_count: usize }

#[tauri::command]
fn export_markdown_bundle(output_root: String, base_name: String, markdown_bytes: Vec<u8>, assets: Vec<MarkdownBundleAsset>) -> Result<MarkdownBundleResult, String> {
    use std::io::Write;
    if output_root.trim().is_empty() || output_root.contains('\0') || markdown_bytes.len() > 20 * 1024 * 1024 || assets.len() > 100 { return Err("markdown:invalid-export".to_string()); }
    let root = std::path::PathBuf::from(output_root).join("Markdown"); is_path_safe(&root)?; std::fs::create_dir_all(&root).map_err(|_| "markdown:output-dir".to_string())?;
    let clean = base_name.trim().replace(['<','>','"','/','\\','|','?','*',':'], "-").trim_end_matches([' ','.']).to_string(); let clean = if clean.is_empty() { "toolknit-document".to_string() } else { clean.chars().take(80).collect::<String>() };
    let mut asset_names = std::collections::BTreeSet::new(); let mut asset_bytes = 0usize;
    for asset in &assets { if asset.file_name.is_empty() || asset.file_name.contains(['\\','/','\0']) || asset.file_name == "." || asset.file_name == ".." || asset.bytes.len() > 20 * 1024 * 1024 || !asset_names.insert(asset.file_name.clone()) { return Err("markdown:invalid-asset".to_string()); } asset_bytes = asset_bytes.checked_add(asset.bytes.len()).ok_or("markdown:invalid-assets")?; if asset_bytes > 100 * 1024 * 1024 { return Err("markdown:assets-too-large".to_string()); } }
    for index in 0..10_000_u32 {
        let suffix = if index == 0 { String::new() } else { format!("_{}", index) }; let directory = root.join(format!("{}{}", clean, suffix)); if directory.exists() { continue; }
        let temporary = root.join(format!(".{}.part.{}", clean, std::process::id())); let _ = std::fs::remove_dir_all(&temporary); std::fs::create_dir_all(temporary.join("assets")).map_err(|_| "markdown:temp-dir".to_string())?;
        let write_result = (|| -> Result<(), String> {
            let mut markdown = std::fs::File::create(temporary.join(format!("{}.md", clean))).map_err(|_| "markdown:write-failed".to_string())?; markdown.write_all(&markdown_bytes).map_err(|_| "markdown:write-failed".to_string())?; markdown.sync_all().map_err(|_| "markdown:write-failed".to_string())?;
            for asset in &assets { if asset.file_name.is_empty() || asset.file_name.contains(['\\','/','\0']) || asset.bytes.len() > 20 * 1024 * 1024 { return Err("markdown:invalid-asset".to_string()); } let path=temporary.join("assets").join(&asset.file_name); let mut file=std::fs::File::create(path).map_err(|_| "markdown:asset-write-failed".to_string())?; file.write_all(&asset.bytes).map_err(|_| "markdown:asset-write-failed".to_string())?; file.sync_all().map_err(|_| "markdown:asset-write-failed".to_string())?; }
            Ok(())
        })();
        if let Err(error) = write_result { let _=std::fs::remove_dir_all(&temporary); return Err(error); }
        match std::fs::rename(&temporary, &directory) { Ok(()) => return Ok(MarkdownBundleResult { markdown_path: directory.join(format!("{}.md", clean)).to_string_lossy().into_owned(), directory: directory.to_string_lossy().into_owned(), asset_count: assets.len() }), Err(_) => { let _=std::fs::remove_dir_all(&temporary); continue; } }
    }
    Err("markdown:publish-failed".to_string())
}

#[cfg(test)]
mod paired_file_write_tests {
    use super::*;

    fn test_directory() -> std::path::PathBuf {
        let suffix = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("clock must be after epoch")
            .as_nanos();
        let directory = std::env::temp_dir().join(format!("toolknit-paired-output-{}", suffix));
        std::fs::create_dir_all(&directory).expect("create test directory");
        directory
    }

    #[test]
    fn paired_write_uses_one_shared_unique_suffix_without_overwriting() {
        let directory = test_directory();
        let directory_string = directory.to_string_lossy().into_owned();

        let first = write_unique_file_pair(
            directory_string.clone(),
            "meeting_refined.srt".to_string(),
            b"first srt".to_vec(),
            "meeting_refined.txt".to_string(),
            b"first txt".to_vec(),
        )
        .expect("first pair should be written");
        let second = write_unique_file_pair(
            directory_string,
            "meeting_refined.srt".to_string(),
            b"second srt".to_vec(),
            "meeting_refined.txt".to_string(),
            b"second txt".to_vec(),
        )
        .expect("second pair should be uniquely written");

        assert!(first.first_path.ends_with("meeting_refined.srt"));
        assert!(first.second_path.ends_with("meeting_refined.txt"));
        assert!(second.first_path.ends_with("meeting_refined_1.srt"));
        assert!(second.second_path.ends_with("meeting_refined_1.txt"));
        assert_eq!(
            std::fs::read_to_string(&first.first_path).expect("read first SRT"),
            "first srt"
        );
        assert_eq!(
            std::fs::read_to_string(&second.second_path).expect("read second TXT"),
            "second txt"
        );

        std::fs::remove_dir_all(&directory).expect("remove test directory");
    }

    #[test]
    fn paired_write_rejects_paths_and_duplicate_file_names() {
        let directory = test_directory();
        let result = write_unique_file_pair(
            directory.to_string_lossy().into_owned(),
            "../unsafe.srt".to_string(),
            vec![],
            "unsafe.txt".to_string(),
            vec![],
        );
        assert!(result.is_err());

        let duplicate = write_unique_file_pair(
            directory.to_string_lossy().into_owned(),
            "same.txt".to_string(),
            vec![],
            "same.txt".to_string(),
            vec![],
        );
        assert!(duplicate.is_err());
        std::fs::remove_dir_all(&directory).expect("remove test directory");
    }
}

fn validate_icon_archive_file_name(file_name: &str) -> Result<(String, String), String> {
    if file_name.contains('\0') {
        return Err("Invalid icon archive file name".to_string());
    }
    let path = std::path::Path::new(file_name);
    if path.is_absolute() || path.components().count() != 1 {
        return Err("Icon archive file name must not contain a path".to_string());
    }
    let stem = path
        .file_stem()
        .and_then(|value| value.to_str())
        .ok_or("Invalid icon archive file name")?;
    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .ok_or("Icon archive file must use .zip")?;
    if stem.is_empty() || !extension.eq_ignore_ascii_case("zip") {
        return Err("Icon archive file must use .zip".to_string());
    }
    Ok((stem.to_string(), extension.to_string()))
}

fn unique_icon_archive_path(
    directory: &std::path::Path,
    file_name: &str,
    counter: u32,
) -> Result<std::path::PathBuf, String> {
    let (stem, extension) = validate_icon_archive_file_name(file_name)?;
    let candidate = if counter == 0 {
        format!("{}.{}", stem, extension)
    } else {
        format!("{}_{}.{}", stem, counter, extension)
    };
    Ok(directory.join(candidate))
}

#[tauri::command]
fn begin_icon_archive_write(directory: String, file_name: String) -> Result<u64, String> {
    if directory.contains('\0') {
        return Err("Invalid icon archive output directory".to_string());
    }
    validate_icon_archive_file_name(&file_name)?;
    let output_directory = std::path::PathBuf::from(directory);
    is_path_safe(&output_directory)?;
    std::fs::create_dir_all(&output_directory)
        .map_err(|error| format!("Failed to create icon output directory: {}", error))?;
    if !output_directory.is_dir() {
        return Err("Icon archive output path is not a directory".to_string());
    }
    let output_directory = output_directory
        .canonicalize()
        .map_err(|error| format!("Invalid icon output directory: {}", error))?;
    is_path_safe(&output_directory)?;

    for _ in 0..10_000 {
        let session_id = ICON_ARCHIVE_WRITE_ID.fetch_add(1, Ordering::SeqCst);
        let temporary_path = output_directory.join(format!(
            ".toolknit-icon-{}-{}.part",
            std::process::id(),
            session_id
        ));
        match std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary_path)
        {
            Ok(_) => {
                let write = IconArchiveWrite {
                    temporary_path,
                    output_directory,
                    file_name,
                };
                icon_archive_writes()
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner())
                    .insert(session_id, write);
                return Ok(session_id);
            }
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(format!("Failed to create icon archive: {}", error)),
        }
    }
    Err("Unable to reserve icon archive output".to_string())
}

#[tauri::command]
fn append_icon_archive_chunk(session_id: u64, bytes: Vec<u8>) -> Result<(), String> {
    use std::io::Write;

    if bytes.is_empty() {
        return Err("Icon archive chunk is empty".to_string());
    }
    let temporary_path = icon_archive_writes()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .get(&session_id)
        .map(|write| write.temporary_path.clone())
        .ok_or("Icon archive write session is unavailable")?;
    let current_size = std::fs::metadata(&temporary_path)
        .map_err(|error| format!("Cannot inspect icon archive: {}", error))?
        .len();
    let next_size = current_size
        .checked_add(bytes.len() as u64)
        .ok_or("Icon archive is too large")?;
    if next_size > MAX_ICON_ARCHIVE_BYTES {
        return Err("Icon archive exceeds the 32 MB limit".to_string());
    }
    let mut output = std::fs::OpenOptions::new()
        .append(true)
        .open(&temporary_path)
        .map_err(|error| format!("Cannot append icon archive: {}", error))?;
    output
        .write_all(&bytes)
        .map_err(|error| format!("Cannot write icon archive: {}", error))
}

#[tauri::command]
fn finalize_icon_archive_write(session_id: u64) -> Result<String, String> {
    let write = icon_archive_writes()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .remove(&session_id)
        .ok_or("Icon archive write session is unavailable")?;
    let result = (|| {
        let size = std::fs::metadata(&write.temporary_path)
            .map_err(|error| format!("Cannot inspect icon archive: {}", error))?
            .len();
        if size == 0 || size > MAX_ICON_ARCHIVE_BYTES {
            return Err("Icon archive has an invalid size".to_string());
        }
        for counter in 0..10_000_u32 {
            let output_path =
                unique_icon_archive_path(&write.output_directory, &write.file_name, counter)?;
            match std::fs::hard_link(&write.temporary_path, &output_path) {
                Ok(()) => return Ok(cleanup_display_path(&output_path)),
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
                Err(error) => return Err(format!("Cannot publish icon archive: {}", error)),
            }
        }
        Err("Unable to reserve a unique icon archive name".to_string())
    })();
    let _ = std::fs::remove_file(&write.temporary_path);
    result
}

#[tauri::command]
fn discard_icon_archive_write(session_id: u64) -> Result<(), String> {
    let write = icon_archive_writes()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .remove(&session_id)
        .ok_or("Icon archive write session is unavailable")?;
    std::fs::remove_file(&write.temporary_path)
        .map_err(|error| format!("Cannot discard icon archive: {}", error))
}

fn validate_pdf_enhance_file_name(file_name: &str) -> Result<String, String> {
    if file_name.contains('\0')
        || file_name.encode_utf16().count() > 240
        || file_name
            .chars()
            .any(|character| character.is_control() || "<>:\"/\\|?*".contains(character))
    {
        return Err("pdf-enhance:output-path".to_string());
    }
    let path = std::path::Path::new(file_name);
    if path.is_absolute() || path.components().count() != 1 {
        return Err("pdf-enhance:output-path".to_string());
    }
    let stem = path
        .file_stem()
        .and_then(|value| value.to_str())
        .filter(|value| !value.is_empty())
        .ok_or("pdf-enhance:output-path")?;
    let is_pdf = path
        .extension()
        .and_then(|value| value.to_str())
        .is_some_and(|value| value.eq_ignore_ascii_case("pdf"));
    if !is_pdf {
        return Err("pdf-enhance:output-path".to_string());
    }
    let normalized_stem = stem.trim_end_matches(['.', ' ']).to_ascii_uppercase();
    let is_reserved = matches!(
        normalized_stem.as_str(),
        "CON" | "PRN" | "AUX" | "NUL" | "CLOCK$"
    ) || (normalized_stem.len() == 4
        && (normalized_stem.starts_with("COM") || normalized_stem.starts_with("LPT"))
        && normalized_stem
            .as_bytes()
            .last()
            .copied()
            .is_some_and(|value| matches!(value, b'1'..=b'9')));
    if normalized_stem != stem.to_ascii_uppercase() || is_reserved {
        return Err("pdf-enhance:output-path".to_string());
    }
    Ok(stem.to_string())
}

fn unique_pdf_enhance_path(
    directory: &std::path::Path,
    file_name: &str,
    counter: u32,
) -> Result<std::path::PathBuf, String> {
    let stem = validate_pdf_enhance_file_name(file_name)?;
    let candidate = if counter == 0 {
        format!("{}.pdf", stem)
    } else {
        format!("{}_{}.pdf", stem, counter)
    };
    Ok(directory.join(candidate))
}

#[tauri::command]
fn begin_pdf_enhance_write(
    directory: String,
    file_name: String,
    expected_pages: u32,
) -> Result<u64, String> {
    if expected_pages == 0 || expected_pages > MAX_PDF_ENHANCE_PAGES {
        return Err("pdf-enhance:too-many-pages".to_string());
    }
    if directory.contains('\0') {
        return Err("pdf-enhance:output-path".to_string());
    }
    validate_pdf_enhance_file_name(&file_name)?;

    let output_directory = std::path::PathBuf::from(directory);
    is_path_safe(&output_directory).map_err(|_| "pdf-enhance:output-path".to_string())?;
    std::fs::create_dir_all(&output_directory)
        .map_err(|_| "pdf-enhance:output-path".to_string())?;
    if !output_directory.is_dir() {
        return Err("pdf-enhance:output-path".to_string());
    }
    let output_directory = output_directory
        .canonicalize()
        .map_err(|_| "pdf-enhance:output-path".to_string())?;
    is_path_safe(&output_directory).map_err(|_| "pdf-enhance:output-path".to_string())?;

    let mut writes = pdf_enhance_writes()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if writes.len() >= MAX_PDF_ENHANCE_WRITE_SESSIONS {
        return Err("pdf-enhance:enhancement-failed".to_string());
    }

    for _ in 0..10_000 {
        let session_id = PDF_ENHANCE_WRITE_ID.fetch_add(1, Ordering::SeqCst);
        let temporary_path = output_directory.join(format!(
            ".toolknit-pdf-enhance-{}-{}.part",
            std::process::id(),
            session_id
        ));
        match std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary_path)
        {
            Ok(file) => {
                writes.insert(
                    session_id,
                    PdfEnhanceWrite {
                        file,
                        temporary_path,
                        output_directory,
                        file_name,
                        expected_pages,
                        bytes_written: 0,
                    },
                );
                return Ok(session_id);
            }
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(_) => return Err("pdf-enhance:output-path".to_string()),
        }
    }
    Err("pdf-enhance:output-path".to_string())
}

#[tauri::command]
fn append_pdf_enhance_chunk(session_id: u64, bytes: Vec<u8>) -> Result<(), String> {
    use std::io::Write;

    if bytes.is_empty() {
        return Err("pdf-enhance:enhancement-failed".to_string());
    }
    let mut writes = pdf_enhance_writes()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let write = writes
        .get_mut(&session_id)
        .ok_or("pdf-enhance:enhancement-failed")?;
    let next_size = write
        .bytes_written
        .checked_add(bytes.len() as u64)
        .ok_or("pdf-enhance:output-too-large")?;
    if next_size > MAX_PDF_ENHANCE_OUTPUT_BYTES {
        return Err("pdf-enhance:output-too-large".to_string());
    }
    write
        .file
        .write_all(&bytes)
        .map_err(|_| "pdf-enhance:enhancement-failed".to_string())?;
    write.bytes_written = next_size;
    Ok(())
}

async fn validate_pdf_enhance_output(
    path: &std::path::Path,
    expected_pages: u32,
) -> Result<(), String> {
    let qpdf_path = get_qpdf_path().map_err(|_| "pdf-enhance:enhancement-failed".to_string())?;
    let qpdf_input_path = std::path::PathBuf::from(cleanup_display_path(path));
    let check_output = run_qpdf_with_stdin(
        &qpdf_path,
        &[
            std::ffi::OsString::from("--warning-exit-0"),
            std::ffi::OsString::from("--check"),
            qpdf_input_path.as_os_str().to_os_string(),
        ],
        None,
        false,
        "pdf-enhance:enhancement-failed",
    )
    .await?;
    if !check_output.status.success() {
        return Err("pdf-enhance:enhancement-failed".to_string());
    }

    let page_output = run_qpdf_with_stdin(
        &qpdf_path,
        &[
            std::ffi::OsString::from("--show-npages"),
            qpdf_input_path.as_os_str().to_os_string(),
        ],
        None,
        true,
        "pdf-enhance:enhancement-failed",
    )
    .await?;
    let page_count = String::from_utf8_lossy(&page_output.stdout)
        .trim()
        .parse::<u32>()
        .ok();
    if !page_output.status.success() || page_count != Some(expected_pages) {
        return Err("pdf-enhance:enhancement-failed".to_string());
    }
    Ok(())
}

fn publish_pdf_enhance_output(
    temporary_path: &std::path::Path,
    output_directory: &std::path::Path,
    file_name: &str,
) -> Result<String, String> {
    for counter in 0..10_000_u32 {
        let output_path = unique_pdf_enhance_path(output_directory, file_name, counter)?;
        #[cfg(target_os = "windows")]
        {
            use std::os::windows::ffi::OsStrExt;
            use windows::core::PCWSTR;
            use windows::Win32::Storage::FileSystem::{MoveFileExW, MOVE_FILE_FLAGS};

            let source_wide = temporary_path
                .as_os_str()
                .encode_wide()
                .chain(std::iter::once(0))
                .collect::<Vec<_>>();
            let output_wide = output_path
                .as_os_str()
                .encode_wide()
                .chain(std::iter::once(0))
                .collect::<Vec<_>>();
            let move_result = unsafe {
                MoveFileExW(
                    PCWSTR(source_wide.as_ptr()),
                    PCWSTR(output_wide.as_ptr()),
                    MOVE_FILE_FLAGS(0),
                )
            };
            match move_result {
                Ok(()) => return Ok(cleanup_display_path(&output_path)),
                Err(_) if output_path.exists() => continue,
                Err(_) => return Err("pdf-enhance:output-path".to_string()),
            }
        }
        #[cfg(not(target_os = "windows"))]
        {
            match std::fs::hard_link(temporary_path, &output_path) {
                Ok(()) => {
                    let _ = std::fs::remove_file(temporary_path);
                    return Ok(cleanup_display_path(&output_path));
                }
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
                Err(_) => return Err("pdf-enhance:output-path".to_string()),
            }
        }
    }
    Err("pdf-enhance:output-path".to_string())
}

#[tauri::command]
async fn finalize_pdf_enhance_write(session_id: u64) -> Result<String, String> {
    let write = pdf_enhance_writes()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .remove(&session_id)
        .ok_or("pdf-enhance:enhancement-failed")?;
    let PdfEnhanceWrite {
        file,
        temporary_path,
        output_directory,
        file_name,
        expected_pages,
        bytes_written,
    } = write;

    let sync_result = file.sync_all();
    drop(file);
    if bytes_written == 0 || bytes_written > MAX_PDF_ENHANCE_OUTPUT_BYTES || sync_result.is_err() {
        let _ = std::fs::remove_file(&temporary_path);
        return Err("pdf-enhance:enhancement-failed".to_string());
    }
    if let Err(error) = validate_pdf_enhance_output(&temporary_path, expected_pages).await {
        let _ = std::fs::remove_file(&temporary_path);
        return Err(error);
    }
    let result = publish_pdf_enhance_output(
        &temporary_path,
        &output_directory,
        &file_name,
    );
    if result.is_err() {
        let _ = std::fs::remove_file(&temporary_path);
    }
    result
}

#[tauri::command]
fn discard_pdf_enhance_write(session_id: u64) -> Result<(), String> {
    let write = pdf_enhance_writes()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .remove(&session_id)
        .ok_or("pdf-enhance:enhancement-failed")?;
    let temporary_path = write.temporary_path.clone();
    drop(write);
    match std::fs::remove_file(temporary_path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(_) => Err("pdf-enhance:enhancement-failed".to_string()),
    }
}

#[cfg(test)]
mod pdf_enhance_write_tests {
    use super::*;

    fn test_directory() -> std::path::PathBuf {
        let suffix = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("clock must be after epoch")
            .as_nanos();
        let directory = std::env::temp_dir().join(format!(
            "toolknit-pdf-enhance-write-{}-{}",
            std::process::id(),
            suffix
        ));
        std::fs::create_dir_all(&directory).expect("create PDF enhance test directory");
        directory
    }

    #[test]
    fn pdf_enhance_chunk_session_discards_partial_output() {
        let directory = test_directory();
        assert!(begin_pdf_enhance_write(
            directory.to_string_lossy().into_owned(),
            "stream:name.pdf".to_string(),
            1,
        )
        .is_err());
        assert!(begin_pdf_enhance_write(
            directory.to_string_lossy().into_owned(),
            "CON.pdf".to_string(),
            1,
        )
        .is_err());
        let session_id = begin_pdf_enhance_write(
            directory.to_string_lossy().into_owned(),
            "scan_enhanced.pdf".to_string(),
            1,
        )
        .expect("begin PDF enhance write");
        append_pdf_enhance_chunk(session_id, b"partial".to_vec())
            .expect("append PDF enhance chunk");
        let temporary_path = pdf_enhance_writes()
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .get(&session_id)
            .expect("PDF enhance write session")
            .temporary_path
            .clone();
        assert!(temporary_path.exists());
        discard_pdf_enhance_write(session_id).expect("discard PDF enhance write");
        assert!(!temporary_path.exists());
        assert!(!directory.join("scan_enhanced.pdf").exists());
        std::fs::remove_dir_all(directory).expect("remove PDF enhance test directory");
    }

    #[test]
    fn pdf_enhance_publish_never_overwrites_an_existing_file() {
        let directory = test_directory();
        let existing = directory.join("scan_enhanced.pdf");
        let temporary = directory.join(".validated.part");
        std::fs::write(&existing, b"existing").expect("write existing output");
        std::fs::write(&temporary, b"validated").expect("write validated output");
        let published = publish_pdf_enhance_output(
            &temporary,
            &directory,
            "scan_enhanced.pdf",
        )
        .expect("publish unique PDF enhance output");
        assert!(published.ends_with("scan_enhanced_1.pdf"));
        assert_eq!(std::fs::read(existing).expect("read existing output"), b"existing");
        assert_eq!(
            std::fs::read(&published).expect("read published output"),
            b"validated"
        );
        assert!(!temporary.exists());
        std::fs::remove_dir_all(directory).expect("remove PDF enhance test directory");
    }

    #[tokio::test]
    async fn pdf_enhance_validation_removes_invalid_staging_file() {
        if get_qpdf_path().is_err() {
            return;
        }
        let directory = test_directory();
        let session_id = begin_pdf_enhance_write(
            directory.to_string_lossy().into_owned(),
            "broken_enhanced.pdf".to_string(),
            1,
        )
        .expect("begin invalid PDF enhance write");
        append_pdf_enhance_chunk(session_id, b"%PDF-1.7\ninvalid".to_vec())
            .expect("append invalid PDF bytes");
        assert!(finalize_pdf_enhance_write(session_id).await.is_err());
        let entries = std::fs::read_dir(&directory)
            .expect("read PDF enhance test directory")
            .collect::<Result<Vec<_>, _>>()
            .expect("collect PDF enhance test entries");
        assert!(entries.is_empty());
        std::fs::remove_dir_all(directory).expect("remove PDF enhance test directory");
    }
}

#[tauri::command]
fn write_file_chunk(path: String, offset: u64, bytes: Vec<u8>) -> Result<(), String> {
    use std::fs::OpenOptions;
    use std::io::{Seek, SeekFrom, Write};
    is_path_safe(std::path::Path::new(&path))?;
    if let Some(parent) = std::path::Path::new(&path).parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create directory: {}", e))?;
    }
    let mut file = OpenOptions::new()
        .create(true)
        .write(true)
        .truncate(offset == 0)
        .open(&path)
        .map_err(|e| format!("Failed to open file: {}", e))?;
    if offset > 0 {
        file.seek(SeekFrom::Start(offset))
            .map_err(|e| format!("Failed to seek: {}", e))?;
    }
    file.write_all(&bytes)
        .map_err(|e| format!("Failed to write: {}", e))
}

#[tauri::command]
fn exists_path(path: String) -> Result<bool, String> {
    if path.contains('\0') {
        return Err("Invalid path".to_string());
    }
    Ok(std::path::Path::new(&path).exists())
}

#[tauri::command]
fn get_file_size(path: String) -> Result<u64, String> {
    if path.contains('\0') {
        return Err("Invalid path".to_string());
    }
    std::fs::metadata(&path)
        .map(|m| m.len())
        .map_err(|e| format!("Failed to read file metadata: {}", e))
}

