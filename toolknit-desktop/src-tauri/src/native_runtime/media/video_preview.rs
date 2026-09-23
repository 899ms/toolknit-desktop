
#[derive(serde::Serialize)]
pub(crate) struct ProbeResult {
    pub(crate) duration: f64,
    pub(crate) file_size: u64,
    pub(crate) audio_tracks: Vec<AudioTrack>,
    pub(crate) frame_rate: f64,
    pub(crate) width: u32,
    pub(crate) height: u32,
}

#[derive(serde::Serialize)]
pub(crate) struct AudioTrack {
    pub(crate) index: usize,
    pub(crate) codec: String,
    pub(crate) language: String,
    pub(crate) channels: String,
}

pub(crate) const AUDIO_EXTRACT_MAX_INPUT_BYTES: u64 = 10 * 1024 * 1024 * 1024;
pub(crate) const AUDIO_EXTRACT_MAX_TRACK_INDEX: usize = 31;

pub(crate) fn validate_audio_extract_input(input_path: &str) -> Result<std::path::PathBuf, String> {
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

pub(crate) fn validate_audio_extract_output_dir(output_dir: &str) -> Result<std::path::PathBuf, String> {
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

pub(crate) fn normalize_audio_extract_format(value: &str) -> Result<&'static str, String> {
    match value.trim().to_ascii_uppercase().as_str() {
        "MP3" => Ok("MP3"),
        "AAC" => Ok("AAC"),
        "WAV" => Ok("WAV"),
        "FLAC" => Ok("FLAC"),
        "OGG" => Ok("OGG"),
        _ => Err("audio-extract:invalid-target-format".to_string()),
    }
}

pub(crate) fn create_audio_extract_temp_path(
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

pub(crate) fn audio_extract_file_stem(input: &std::path::Path) -> String {
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

pub(crate) fn publish_audio_extract_output(
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
pub(crate) async fn probe_video(input_path: String) -> Result<ProbeResult, String> {
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
pub(crate) struct VideoPreviewFrame {
    pub(crate) image_data_url: String,
    pub(crate) timestamp_ms: u64,
}

#[derive(serde::Serialize)]
pub(crate) struct VideoPreviewClip {
    pub(crate) media_data_url: String,
    pub(crate) start_ms: u64,
    pub(crate) end_ms: u64,
}

pub(crate) fn validate_video_preview_clip_range(start_ms: u64, end_ms: u64) -> Result<(), String> {
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
pub(crate) async fn render_video_preview_frame(
    input_path: String,
    timestamp_ms: u64,
    request_id: Option<String>,
) -> Result<VideoPreviewFrame, String> {
    use base64::Engine;

    const MAX_TIMESTAMP_MS: u64 = 24 * 60 * 60 * 1000;
    const MAX_PREVIEW_BYTES: usize = 8 * 1024 * 1024;
    let job = super::preview_jobs::PreviewJob::register(request_id)?;

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
        // Input seeking remains accurate when transcoding; avoid decoding from zero.
        .arg("-ss")
        .arg(format!("{:.3}", timestamp_ms as f64 / 1000.0))
        .arg("-i")
        .arg(&input)
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

    let bytes = job.output(&mut command, MAX_PREVIEW_BYTES, std::time::Duration::from_secs(90)).await?;

    Ok(VideoPreviewFrame {
        image_data_url: format!(
            "data:image/jpeg;base64,{}",
            base64::engine::general_purpose::STANDARD.encode(bytes)
        ),
        timestamp_ms,
    })
}

/// Transcode the selected range to a small, browser-compatible stream. The source
/// file itself is never exposed to the WebView, whose codec support is inconsistent.
#[tauri::command]
pub(crate) async fn render_video_preview_clip(
    input_path: String,
    start_ms: u64,
    end_ms: u64,
    request_id: Option<String>,
) -> Result<VideoPreviewClip, String> {
    use base64::Engine;

    const MAX_PREVIEW_BYTES: usize = 10 * 1024 * 1024;
    let mut job = super::preview_jobs::PreviewJob::register(request_id)?;

    validate_video_preview_clip_range(start_ms, end_ms)?;
    let input = validate_audio_extract_input(&input_path)?;
    let ffmpeg = get_ffmpeg_path()?;
    if job.duration(&ffmpeg, &input).await?.is_some_and(|duration| end_ms as f64 > duration * 1000.0 + 1.0) {
        return Err("video-preview:timestamp-out-of-range".to_string());
    }
    let mut command = tokio::process::Command::new(&ffmpeg);
    command
        .arg("-hide_banner")
        .arg("-nostdin")
        .arg("-loglevel")
        .arg("error")
        .arg("-ss")
        .arg(format!("{:.3}", start_ms as f64 / 1000.0))
        .arg("-i")
        .arg(&input)
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

    let bytes = job.output(&mut command, MAX_PREVIEW_BYTES, std::time::Duration::from_secs(90)).await?;

    Ok(VideoPreviewClip {
        media_data_url: format!(
            "data:video/mp4;base64,{}",
            base64::engine::general_purpose::STANDARD.encode(bytes)
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

        let preview = render_video_preview_clip(source.to_string_lossy().into_owned(), 0, 1_000, None)
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
pub(crate) struct VideoFrameResult {
    pub(crate) output_path: String,
    pub(crate) timestamp_ms: u64,
    pub(crate) format: String,
}

pub(crate) fn publish_video_frame_output(
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
pub(crate) async fn extract_video_frame(
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
pub(crate) struct VideoGifResult {
    pub(crate) output_path: String,
    pub(crate) start_ms: u64,
    pub(crate) end_ms: u64,
    pub(crate) duration_ms: u64,
    pub(crate) frame_rate: u32,
    pub(crate) width: u32,
    pub(crate) quality: String,
    pub(crate) output_size: u64,
}

pub(crate) fn publish_video_gif_output(
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
pub(crate) async fn extract_video_gif(
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
