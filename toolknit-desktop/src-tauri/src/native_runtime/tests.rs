#[cfg(test)]
mod simplify_tests {
    use super::super::*;

    #[test]
    fn simplify_converts_common_whisper_variants() {
        let converted = simplify_chinese_text("旗艦模型升級，創作與理解能力。");
        assert_eq!(converted, "旗舰模型升级，创作与理解能力。");
        assert_eq!(simplify_chinese_text("English stays untouched 123"), "English stays untouched 123");
    }

    #[test]
    fn simplify_transcription_outputs_rewrites_temp_files() {
        let dir = std::env::temp_dir().join(format!("toolknit-simplify-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        for name in ["transcript.srt", "transcript.txt"] {
            std::fs::write(dir.join(name), format!("{name}}}: 旗艦模型升級 {{}}")).unwrap();
        }
        std::fs::write(dir.join("transcript.json"), r#"{"file":"聲音.wav","transcription":[{"text":"總有細碎的溫暖癒合傷口","offsets":{"from":123}}]}"#).unwrap();
        simplify_transcription_outputs(&dir).unwrap();
        let txt = std::fs::read_to_string(dir.join("transcript.txt")).unwrap();
        assert!(txt.contains("旗舰模型升级"));
        let json = std::fs::read_to_string(dir.join("transcript.json")).unwrap();
        let json: serde_json::Value = serde_json::from_str(&json).unwrap();
        assert_eq!(json["file"], "聲音.wav");
        assert_eq!(json["transcription"][0]["text"], "总有细碎的温暖愈合伤口");
        assert_eq!(json["transcription"][0]["offsets"]["from"], 123);
        for name in ["transcript.json", "transcript.srt", "transcript.txt"] {
            let _ = std::fs::remove_file(dir.join(name));
        }
        let _ = std::fs::remove_dir(&dir);
    }

    #[test]
    fn transcription_prepare_error_identifies_missing_audio() {
        assert_eq!(
            transcription_prepare_error(
                false,
                false,
                "Output file does not contain any stream"
            ),
            Some("transcription:no-audio-stream")
        );
        assert_eq!(
            transcription_prepare_error(false, false, "Invalid data found when processing input"),
            Some("transcription:prepare-failed")
        );
        assert_eq!(transcription_prepare_error(true, true, ""), None);
    }

    #[test]
    fn transcription_engine_error_classifies_failure_stage() {
        assert_eq!(
            transcription_engine_error(false, false, "failed to load model from file"),
            Some("transcription:model-load-failed")
        );
        assert_eq!(
            transcription_engine_error(false, false, "failed to read audio data"),
            Some("transcription:audio-read-failed")
        );
        assert_eq!(
            transcription_engine_error(true, false, ""),
            Some("transcription:output-failed")
        );
        assert_eq!(transcription_engine_error(true, true, ""), None);
    }

    #[test]
    fn whisper_workspace_paths_are_ascii() {
        assert!(is_ascii_path(std::path::Path::new(r"C:\ToolKnitTemp\run-1")));
        assert!(!is_ascii_path(std::path::Path::new(r"C:\用户\run-1")));
    }

    #[test]
    fn transcription_temp_dir_is_removed_on_drop() {
        let root = std::env::temp_dir().join(format!(
            "toolknit-transcription-temp-test-{}",
            std::process::id()
        ));
        std::fs::create_dir_all(&root).unwrap();
        let path = {
            let temp = TranscriptionTempDir::create(&root).unwrap();
            let path = temp.path().to_path_buf();
            std::fs::write(path.join("input.wav"), b"test").unwrap();
            path
        };
        assert!(!path.exists());
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn transcription_copy_publish_is_complete_and_atomic() {
        let root = std::env::temp_dir().join(format!(
            "toolknit-transcription-copy-test-{}",
            std::process::id()
        ));
        std::fs::create_dir_all(&root).unwrap();
        let source = root.join("source.txt");
        let destination = root.join("result.txt");
        std::fs::write(&source, b"complete transcript").unwrap();
        copy_transcription_output(&source, &destination).unwrap();
        assert_eq!(std::fs::read(&destination).unwrap(), b"complete transcript");
        assert!(std::fs::read_dir(&root)
            .unwrap()
            .flatten()
            .all(|entry| !entry.file_name().to_string_lossy().ends_with(".tmp")));
        assert!(copy_transcription_output(&source, &destination).is_err());
        assert_eq!(std::fs::read(&destination).unwrap(), b"complete transcript");
        let _ = std::fs::remove_dir_all(root);
    }
}
