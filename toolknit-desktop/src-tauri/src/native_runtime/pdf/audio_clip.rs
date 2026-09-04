#[cfg(test)]
mod audio_conversion_tests {
    use super::*;

    fn test_directory(label: &str) -> std::path::PathBuf {
        let suffix = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("clock must be after epoch")
            .as_nanos();
        let directory =
            std::env::temp_dir().join(format!("toolknit-audio-convert-{}-{}", label, suffix));
        std::fs::create_dir_all(&directory).expect("create test directory");
        directory
    }

    #[test]
    fn audio_convert_rejects_duplicate_empty_and_unsupported_inputs() {
        let directory = test_directory("validation");
        let audio = directory.join("track.m4a");
        std::fs::write(&audio, [1_u8; 32]).expect("write audio fixture");
        let audio_path = audio.to_string_lossy().into_owned();
        assert_eq!(
            validate_audio_convert_inputs(&[audio_path.clone()])
                .expect("m4a input should be accepted")
                .len(),
            1,
        );
        assert_eq!(
            validate_audio_convert_inputs(&[audio_path.clone(), audio_path])
                .expect_err("duplicate input must be rejected"),
            "audio-convert:duplicate-input",
        );

        let empty = directory.join("empty.mp3");
        std::fs::write(&empty, []).expect("write empty fixture");
        assert_eq!(
            validate_audio_convert_inputs(&[empty.to_string_lossy().into_owned()])
                .expect_err("empty input must be rejected"),
            "audio-convert:invalid-input",
        );

        let unsupported = directory.join("notes.txt");
        std::fs::write(&unsupported, [1_u8; 32]).expect("write unsupported fixture");
        assert_eq!(
            validate_audio_convert_inputs(&[unsupported.to_string_lossy().into_owned()])
                .expect_err("unsupported input must be rejected"),
            "audio-convert:invalid-input",
        );
        std::fs::remove_dir_all(&directory).expect("remove test directory");
    }

    #[test]
    fn audio_convert_uses_bounded_quality_profiles() {
        assert_eq!(
            normalize_audio_convert_quality(Some(" HIGH ")).expect("high should normalize"),
            "high"
        );
        assert_eq!(
            normalize_audio_convert_quality(None).expect("default should normalize"),
            "medium"
        );
        assert_eq!(
            normalize_audio_convert_quality(Some("192k"))
                .expect_err("raw FFmpeg arguments must be rejected"),
            "audio-convert:invalid-quality"
        );

        let mp3 = get_encoder_params("MP3", "high");
        assert_eq!(mp3.0, "libmp3lame");
        assert_eq!(mp3.1, vec!["-q:a", "2"]);
        assert_eq!(mp3.2, ".mp3");

        let aac = get_encoder_params("AAC", "low");
        assert_eq!(aac.0, "aac");
        assert_eq!(aac.1, vec!["-b:a", "128k", "-movflags", "+faststart"]);
        assert_eq!(aac.2, ".m4a");

        let wav = get_encoder_params("WAV", "low");
        assert_eq!(wav.0, "pcm_s16le");
        assert!(wav.1.is_empty());
        assert_eq!(wav.2, ".wav");
    }

    #[test]
    fn audio_convert_publication_keeps_existing_output_and_removes_temporary_file() {
        let directory = test_directory("publish");
        let existing = directory.join("track.mp3");
        let temporary = directory.join(".toolknit-audio-test.mp3");
        std::fs::write(&existing, b"original-output").expect("write existing output");
        std::fs::write(&temporary, b"new-output").expect("write temporary output");

        let published = publish_audio_convert_output(&temporary, &directory, "track", ".mp3")
            .expect("publish unique audio output");
        assert!(published.ends_with("track_1.mp3"));
        assert_eq!(
            std::fs::read(&existing).expect("read existing output"),
            b"original-output"
        );
        assert_eq!(
            std::fs::read(&published).expect("read published output"),
            b"new-output"
        );
        assert!(!temporary.exists());
        std::fs::remove_dir_all(&directory).expect("remove test directory");
    }
}

#[derive(serde::Serialize)]
pub(crate) struct TrimResult {
    pub(crate) success: bool,
    pub(crate) output_path: String,
    pub(crate) error: Option<String>,
}

#[tauri::command]
pub(crate) async fn trim_audio(
    input_path: String,
    output_dir: String,
    start_time: f64,
    end_time: f64,
) -> Result<TrimResult, String> {
    let _conversion_guard = begin_conversion()?;
    if !start_time.is_finite()
        || !end_time.is_finite()
        || start_time < 0.0
        || end_time <= start_time
    {
        return Err("audio-clip:invalid-selection".to_string());
    }

    let ffmpeg_path = get_ffmpeg_path()?;
    let input = validate_audio_convert_inputs(&[input_path])
        .map_err(|_| "audio-clip:invalid-input".to_string())?
        .into_iter()
        .next()
        .ok_or("audio-clip:invalid-input")?;
    let input_size = std::fs::metadata(&input)
        .map_err(|_| "audio-clip:invalid-input".to_string())?
        .len();
    if input_size > 100 * 1024 * 1024 {
        return Err("audio-clip:input-too-large".to_string());
    }
    let output_dir_path = validate_audio_convert_output_dir(&output_dir)
        .map_err(|_| "audio-clip:output-path".to_string())?;
    let source_duration = probe_video_convert_duration(&ffmpeg_path, &input)
        .await
        .filter(|duration| duration.is_finite() && *duration > 0.0)
        .ok_or("audio-clip:invalid-input")?;
    if source_duration > 20.0 * 60.0 {
        return Err("audio-clip:audio-too-long".to_string());
    }
    if start_time >= source_duration || end_time > source_duration + 0.05 {
        return Err("audio-clip:invalid-selection".to_string());
    }

    let output_stem = format!("{}_clip", audio_convert_file_stem(&input));
    let original_extension = input
        .extension()
        .and_then(|extension| extension.to_str())
        .map(|extension| format!(".{}", extension.to_ascii_lowercase()))
        .ok_or("audio-clip:invalid-input")?;
    let temporary_path = create_audio_convert_temp_path(&output_dir_path, &original_extension)
        .map_err(|_| "audio-clip:output-path".to_string())?;
    let clip_duration = end_time - start_time;

    let mut cmd = tokio::process::Command::new(&ffmpeg_path);
    cmd.arg("-y")
        .arg("-i")
        .arg(&input)
        .arg("-ss")
        .arg(start_time.to_string())
        .arg("-t")
        .arg(clip_duration.to_string())
        .arg("-c")
        .arg("copy")
        .arg(&temporary_path)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());

    #[cfg(target_os = "windows")]
    {
        cmd.creation_flags(0x08000000);
    }

    let child = cmd.spawn().map_err(|_| "audio-clip:failed".to_string())?;
    if let Some(id) = child.id() {
        CURRENT_CHILD_ID.store(id, Ordering::SeqCst);
    }
    let output = match child.wait_with_output().await {
        Ok(output) => output,
        Err(_) => {
            CURRENT_CHILD_ID.store(0, Ordering::SeqCst);
            let _ = std::fs::remove_file(&temporary_path);
            return Err("audio-clip:failed".to_string());
        }
    };
    CURRENT_CHILD_ID.store(0, Ordering::SeqCst);

    if CANCEL_FLAG.load(Ordering::SeqCst) {
        let _ = std::fs::remove_file(&temporary_path);
        return Err("audio-clip:cancelled".to_string());
    }

    let copy_succeeded = output.status.success()
        && std::fs::metadata(&temporary_path)
            .map(|metadata| metadata.len() > 0)
            .unwrap_or(false);
    if copy_succeeded {
        let output_path = match publish_audio_convert_output(
            &temporary_path,
            &output_dir_path,
            &output_stem,
            &original_extension,
        ) {
            Ok(path) => path,
            Err(error) => {
                let _ = std::fs::remove_file(&temporary_path);
                return Err(error);
            }
        };
        return Ok(TrimResult {
            success: true,
            output_path,
            error: None,
        });
    }

    let _ = std::fs::remove_file(&temporary_path);
    let mp3_temporary_path = create_audio_convert_temp_path(&output_dir_path, ".mp3")
        .map_err(|_| "audio-clip:output-path".to_string())?;
    {
        let mut cmd2 = tokio::process::Command::new(&ffmpeg_path);
        cmd2.arg("-y")
            .arg("-i")
            .arg(&input)
            .arg("-ss")
            .arg(start_time.to_string())
            .arg("-t")
            .arg((end_time - start_time).to_string())
            .arg("-c:a")
            .arg("libmp3lame")
            .arg("-q:a")
            .arg("2")
            .arg(&mp3_temporary_path)
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped());

        #[cfg(target_os = "windows")]
        {
            cmd2.creation_flags(0x08000000);
        }

        let child2 = cmd2.spawn().map_err(|_| "audio-clip:failed".to_string())?;
        if let Some(id) = child2.id() {
            CURRENT_CHILD_ID.store(id, Ordering::SeqCst);
        }
        let output2 = match child2.wait_with_output().await {
            Ok(output) => output,
            Err(_) => {
                CURRENT_CHILD_ID.store(0, Ordering::SeqCst);
                let _ = std::fs::remove_file(&mp3_temporary_path);
                return Err("audio-clip:failed".to_string());
            }
        };
        CURRENT_CHILD_ID.store(0, Ordering::SeqCst);

        if CANCEL_FLAG.load(Ordering::SeqCst) {
            let _ = std::fs::remove_file(&mp3_temporary_path);
            return Err("audio-clip:cancelled".to_string());
        }

        if output2.status.success()
            && std::fs::metadata(&mp3_temporary_path)
                .map(|metadata| metadata.len() > 0)
                .unwrap_or(false)
        {
            let output_path = match publish_audio_convert_output(
                &mp3_temporary_path,
                &output_dir_path,
                &output_stem,
                ".mp3",
            ) {
                Ok(path) => path,
                Err(error) => {
                    let _ = std::fs::remove_file(&mp3_temporary_path);
                    return Err(error);
                }
            };
            Ok(TrimResult {
                success: true,
                output_path,
                error: None,
            })
        } else {
            let _ = std::fs::remove_file(&mp3_temporary_path);
            Ok(TrimResult {
                success: false,
                output_path: String::new(),
                error: Some(compact_audio_convert_error(&String::from_utf8_lossy(
                    &output2.stderr,
                ))),
            })
        }
    }
}
