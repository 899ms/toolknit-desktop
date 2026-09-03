#[cfg(test)]
mod simplify_tests {
    use super::*;

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
        for name in ["transcript.json", "transcript.srt", "transcript.txt"] {
            std::fs::write(dir.join(name), format!("{name}}}: 旗艦模型升級 {{}}")).unwrap();
        }
        simplify_transcription_outputs(&dir).unwrap();
        let txt = std::fs::read_to_string(dir.join("transcript.txt")).unwrap();
        assert!(txt.contains("旗舰模型升级"));
        let json = std::fs::read_to_string(dir.join("transcript.json")).unwrap();
        assert!(json.starts_with("transcript.json}:"));
        for name in ["transcript.json", "transcript.srt", "transcript.txt"] {
            let _ = std::fs::remove_file(dir.join(name));
        }
        let _ = std::fs::remove_dir(&dir);
    }
}
