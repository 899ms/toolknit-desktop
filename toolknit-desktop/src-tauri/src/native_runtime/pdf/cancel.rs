#[cfg(test)]
mod audio_clip_backend_tests {
    use super::*;

    fn test_directory() -> std::path::PathBuf {
        let suffix = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("clock must be after epoch")
            .as_nanos();
        let directory = std::env::temp_dir().join(format!("toolknit-audio-clip-{}", suffix));
        std::fs::create_dir_all(&directory).expect("create test directory");
        directory
    }

    #[tokio::test]
    async fn trim_audio_publishes_unique_nonempty_outputs_with_the_requested_duration() {
        let _conversion_lock = test_conversion_lock();
        let directory = test_directory();
        let input = directory.join("tone.wav");
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
                "sine=frequency=440:sample_rate=48000:duration=4",
                "-c:a",
                "pcm_s16le",
            ])
            .arg(&input)
            .status()
            .await
            .expect("start FFmpeg fixture generation");
        assert!(status.success(), "generate a valid audio fixture");

        let output_directory = directory.to_string_lossy().into_owned();
        let first = trim_audio(
            input.to_string_lossy().into_owned(),
            output_directory.clone(),
            1.0,
            2.25,
        )
        .await
        .expect("first trim must succeed");
        assert!(first.success);
        assert!(
            std::fs::metadata(&first.output_path)
                .expect("inspect first output")
                .len()
                > 0
        );
        let duration =
            probe_video_convert_duration(&ffmpeg, std::path::Path::new(&first.output_path))
                .await
                .expect("read output duration");
        assert!(
            (duration - 1.25).abs() < 0.08,
            "clip duration was {duration}"
        );

        let second = trim_audio(
            input.to_string_lossy().into_owned(),
            output_directory,
            1.0,
            2.25,
        )
        .await
        .expect("second trim must succeed");
        assert!(second.success);
        assert_ne!(first.output_path, second.output_path);
        assert!(second.output_path.ends_with("tone_clip_1.wav"));
        std::fs::remove_dir_all(&directory).expect("remove test directory");
    }
}

#[tauri::command]
pub(crate) fn cancel_convert() -> Result<(), String> {
    CANCEL_FLAG.store(true, Ordering::SeqCst);
    let pid = CURRENT_CHILD_ID.load(Ordering::SeqCst);
    terminate_conversion_process(pid);
    CURRENT_CHILD_ID.store(0, Ordering::SeqCst);

    let video_pids: Vec<u32> = active_video_children()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .iter()
        .copied()
        .collect();
    for video_pid in video_pids {
        terminate_conversion_process(video_pid);
    }
    let office_pids: Vec<u32> = active_office_children()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .iter()
        .copied()
        .collect();
    for office_pid in office_pids {
        terminate_conversion_process(office_pid);
    }
    Ok(())
}
