pub(crate) fn normalize_audio_convert_quality(quality: Option<&str>) -> Result<&'static str, String> {
    match quality
        .unwrap_or("medium")
        .trim()
        .to_ascii_lowercase()
        .as_str()
    {
        "low" => Ok("low"),
        "medium" => Ok("medium"),
        "high" => Ok("high"),
        _ => Err("audio-convert:invalid-quality".to_string()),
    }
}

pub(crate) fn get_encoder_params(target_format: &str, quality: &str) -> (String, Vec<String>, &'static str) {
    // Returns (encoder, extra_args, extension)
    match target_format.to_uppercase().as_str() {
        "MP3" => {
            let q = match quality {
                "low" => "6",
                "high" => "2",
                _ => "4",
            };
            (
                "libmp3lame".to_string(),
                vec!["-q:a".to_string(), q.to_string()],
                ".mp3",
            )
        }
        "AAC" => {
            let q = match quality {
                "low" => "128k",
                "high" => "256k",
                _ => "192k",
            };
            (
                "aac".to_string(),
                vec![
                    "-b:a".to_string(),
                    q.to_string(),
                    "-movflags".to_string(),
                    "+faststart".to_string(),
                ],
                ".m4a",
            )
        }
        "WAV" => ("pcm_s16le".to_string(), vec![], ".wav"),
        "FLAC" => {
            let q = match quality {
                "low" => "2",
                "high" => "8",
                _ => "5",
            };
            (
                "flac".to_string(),
                vec!["-compression_level".to_string(), q.to_string()],
                ".flac",
            )
        }
        "ALAC" => (
            "alac".to_string(),
            vec!["-movflags".to_string(), "+faststart".to_string()],
            ".m4a",
        ),
        "OGG" => {
            let q = match quality {
                "low" => "3",
                "high" => "7",
                _ => "5",
            };
            (
                "libvorbis".to_string(),
                vec!["-q:a".to_string(), q.to_string()],
                ".ogg",
            )
        }
        _ => (
            "libmp3lame".to_string(),
            vec!["-q:a".to_string(), "4".to_string()],
            ".mp3",
        ),
    }
}

pub(crate) fn get_unique_output_path(
    output_dir: &std::path::Path,
    stem: &str,
    ext: &str,
) -> std::path::PathBuf {
    let mut path = output_dir.join(format!("{}{}", stem, ext));
    let mut counter = 1;
    while path.exists() {
        path = output_dir.join(format!("{}_{}{}", stem, counter, ext));
        counter += 1;
    }
    path
}

pub(crate) const AUDIO_CONVERT_MAX_INPUT_BYTES: u64 = 10 * 1024 * 1024 * 1024;
pub(crate) const AUDIO_CONVERT_MAX_FILES: usize = 100;

pub(crate) fn validate_audio_convert_inputs(
    input_paths: &[String],
) -> Result<Vec<std::path::PathBuf>, String> {
    if input_paths.is_empty() {
        return Err("audio-convert:missing-input".to_string());
    }
    if input_paths.len() > AUDIO_CONVERT_MAX_FILES {
        return Err("audio-convert:too-many-files".to_string());
    }

    let mut seen = std::collections::BTreeSet::new();
    let mut validated = Vec::with_capacity(input_paths.len());
    for input_path in input_paths {
        if input_path.contains('\0') {
            return Err("audio-convert:invalid-input".to_string());
        }
        let input = std::path::PathBuf::from(input_path);
        let metadata = std::fs::symlink_metadata(&input)
            .map_err(|_| "audio-convert:invalid-input".to_string())?;
        let extension = input
            .extension()
            .and_then(|value| value.to_str())
            .map(|value| value.to_ascii_lowercase());
        if metadata.file_type().is_symlink()
            || !metadata.is_file()
            || !matches!(
                extension.as_deref(),
                Some("mp3" | "aac" | "m4a" | "wav" | "flac" | "alac" | "ogg" | "wma")
            )
            || metadata.len() == 0
        {
            return Err("audio-convert:invalid-input".to_string());
        }
        if metadata.len() > AUDIO_CONVERT_MAX_INPUT_BYTES {
            return Err("audio-convert:input-too-large".to_string());
        }
        let canonical = input
            .canonicalize()
            .map_err(|_| "audio-convert:invalid-input".to_string())?;
        if !seen.insert(canonical.clone()) {
            return Err("audio-convert:duplicate-input".to_string());
        }
        validated.push(canonical);
    }
    Ok(validated)
}

pub(crate) fn validate_audio_convert_output_dir(output_dir: &str) -> Result<std::path::PathBuf, String> {
    if output_dir.trim().is_empty() || output_dir.contains('\0') {
        return Err("audio-convert:output-path".to_string());
    }
    let output_dir = std::path::PathBuf::from(output_dir);
    is_path_safe(&output_dir).map_err(|_| "audio-convert:output-path".to_string())?;
    std::fs::create_dir_all(&output_dir).map_err(|_| "audio-convert:output-path".to_string())?;
    if !output_dir.is_dir() {
        return Err("audio-convert:output-path".to_string());
    }
    is_path_safe(&output_dir).map_err(|_| "audio-convert:output-path".to_string())?;
    Ok(output_dir)
}

pub(crate) fn audio_convert_file_stem(input: &std::path::Path) -> String {
    let raw_stem = input
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("audio");
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
        "audio".to_string()
    } else {
        safe_stem
    }
}

pub(crate) fn create_audio_convert_temp_path(
    output_dir: &std::path::Path,
    extension: &str,
) -> Result<std::path::PathBuf, String> {
    for _ in 0..10_000 {
        let id = AUDIO_CONVERT_TEMP_ID.fetch_add(1, Ordering::SeqCst);
        let candidate = output_dir.join(format!(
            ".toolknit-audio-{}-{}{}",
            std::process::id(),
            id,
            extension
        ));
        if !candidate.exists() {
            return Ok(candidate);
        }
    }
    Err("audio-convert:output-path".to_string())
}

pub(crate) fn publish_audio_convert_output(
    temporary_path: &std::path::Path,
    output_dir: &std::path::Path,
    source_stem: &str,
    extension: &str,
) -> Result<String, String> {
    for counter in 0..10_000_u32 {
        let file_name = if counter == 0 {
            format!("{}{}", source_stem, extension)
        } else {
            format!("{}_{}{}", source_stem, counter, extension)
        };
        let candidate = output_dir.join(file_name);
        match std::fs::hard_link(temporary_path, &candidate) {
            Ok(()) => {
                std::fs::remove_file(temporary_path)
                    .map_err(|_| "audio-convert:output-path".to_string())?;
                return Ok(candidate.to_string_lossy().into_owned());
            }
            Err(_) if candidate.exists() => continue,
            Err(_) => return Err("audio-convert:output-path".to_string()),
        }
    }
    Err("audio-convert:output-path".to_string())
}

pub(crate) fn compact_audio_convert_error(stderr: &str) -> String {
    let detail = stderr
        .lines()
        .rev()
        .find(|line| !line.trim().is_empty())
        .unwrap_or("FFmpeg could not convert this audio file.");
    let compact = detail.trim().chars().take(480).collect::<String>();
    if compact.is_empty() {
        "FFmpeg could not convert this audio file.".to_string()
    } else {
        compact
    }
}

pub(crate) async fn convert_audio_file(
    app_handle: tauri::AppHandle,
    ffmpeg_path: std::path::PathBuf,
    input: std::path::PathBuf,
    output_dir: std::path::PathBuf,
    encoder: String,
    extra_args: Vec<String>,
    extension: &'static str,
    current: usize,
    total: usize,
) -> Result<String, String> {
    use tauri::Emitter;
    use tokio::io::{AsyncBufReadExt, AsyncReadExt, BufReader};

    if CANCEL_FLAG.load(Ordering::SeqCst) {
        return Err("audio-convert:cancelled".to_string());
    }
    let file_name = input
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("audio")
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
        return Err("audio-convert:cancelled".to_string());
    }
    let temporary_path = create_audio_convert_temp_path(&output_dir, extension)?;
    let mut command = tokio::process::Command::new(&ffmpeg_path);
    command
        .arg("-y")
        .arg("-i")
        .arg(&input)
        .arg("-c:a")
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
        command.creation_flags(0x08000000);
    }

    let mut child = command
        .spawn()
        .map_err(|_| "audio-convert:failed".to_string())?;
    let child_id = match child.id() {
        Some(id) => id,
        None => {
            let _ = child.kill().await;
            let _ = std::fs::remove_file(&temporary_path);
            return Err("audio-convert:failed".to_string());
        }
    };
    CURRENT_CHILD_ID.store(child_id, Ordering::SeqCst);
    if CANCEL_FLAG.load(Ordering::SeqCst) {
        terminate_conversion_process(child_id);
    }
    let stdout = match child.stdout.take() {
        Some(stdout) => stdout,
        None => {
            terminate_conversion_process(child_id);
            let _ = child.wait().await;
            CURRENT_CHILD_ID.store(0, Ordering::SeqCst);
            let _ = std::fs::remove_file(&temporary_path);
            return Err("audio-convert:failed".to_string());
        }
    };
    let stderr = match child.stderr.take() {
        Some(stderr) => stderr,
        None => {
            terminate_conversion_process(child_id);
            let _ = child.wait().await;
            CURRENT_CHILD_ID.store(0, Ordering::SeqCst);
            let _ = std::fs::remove_file(&temporary_path);
            return Err("audio-convert:failed".to_string());
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
    CURRENT_CHILD_ID.store(0, Ordering::SeqCst);
    let _ = progress_task.await;
    let stderr = stderr_task.await.unwrap_or_default();

    if CANCEL_FLAG.load(Ordering::SeqCst) {
        let _ = std::fs::remove_file(&temporary_path);
        return Err("audio-convert:cancelled".to_string());
    }
    match status {
        Ok(status) if status.success() => {
            let output_size = std::fs::metadata(&temporary_path)
                .map_err(|_| "audio-convert:failed".to_string())?
                .len();
            if output_size == 0 {
                let _ = std::fs::remove_file(&temporary_path);
                return Err("audio-convert:failed".to_string());
            }
            let output_path = match publish_audio_convert_output(
                &temporary_path,
                &output_dir,
                &audio_convert_file_stem(&input),
                extension,
            ) {
                Ok(path) => path,
                Err(error) => {
                    let _ = std::fs::remove_file(&temporary_path);
                    return Err(error);
                }
            };
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
            Ok(output_path)
        }
        _ => {
            let _ = std::fs::remove_file(&temporary_path);
            Err(compact_audio_convert_error(&stderr))
        }
    }
}

#[tauri::command]
pub(crate) async fn convert_audio_batch(
    app_handle: tauri::AppHandle,
    input_paths: Vec<String>,
    output_dir: String,
    target_format: String,
    quality: Option<String>,
) -> Result<AudioBatchConvertResult, String> {
    use tauri::Emitter;

    let _conversion_guard = begin_conversion()?;
    let input_paths = validate_audio_convert_inputs(&input_paths)?;
    let output_dir = validate_audio_convert_output_dir(&output_dir)?;
    let target_format = target_format.trim().to_ascii_uppercase();
    if !matches!(
        target_format.as_str(),
        "MP3" | "AAC" | "WAV" | "FLAC" | "ALAC" | "OGG"
    ) {
        return Err("audio-convert:invalid-target-format".to_string());
    }
    let quality = normalize_audio_convert_quality(quality.as_deref())?;
    let ffmpeg_path = get_ffmpeg_path()?;
    let (encoder, extra_args, extension) = get_encoder_params(&target_format, quality);
    let total = input_paths.len();
    let mut success_count = 0usize;
    let mut fail_count = 0usize;
    let mut output_paths = Vec::with_capacity(total);
    let mut errors = Vec::new();

    for (index, input) in input_paths.into_iter().enumerate() {
        let current = index + 1;
        let file_name = input
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or("audio")
            .to_string();
        match convert_audio_file(
            app_handle.clone(),
            ffmpeg_path.clone(),
            input,
            output_dir.clone(),
            encoder.clone(),
            extra_args.clone(),
            extension,
            current,
            total,
        )
        .await
        {
            Ok(output_path) => {
                success_count += 1;
                output_paths.push(output_path);
            }
            Err(error) if error == "audio-convert:cancelled" => return Err(error),
            Err(error) => {
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
        }
    }
    Ok(AudioBatchConvertResult {
        success_count,
        fail_count,
        output_dir: output_dir.to_string_lossy().to_string(),
        output_paths,
        errors,
    })
}
