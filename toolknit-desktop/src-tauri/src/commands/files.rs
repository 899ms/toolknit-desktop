use std::path::{Path, PathBuf};

// Kept as a small compatibility helper for command-level consumers and tests.
#[allow(dead_code)]
pub fn output_file(root: &Path, name: &str) -> Result<PathBuf, String> {
    if name.is_empty() || name.chars().any(|character| character == '/' || character == '\\') || name == "." || name == ".." {
        return Err("Invalid output filename".to_string());
    }
    Ok(root.join(name))
}

#[cfg(test)]
mod tests {
    use super::output_file;
    use std::path::Path;

    #[test]
    fn output_file_rejects_path_injection() {
        assert!(output_file(Path::new("C:/tmp"), "../escape.pdf").is_err());
        assert!(output_file(Path::new("C:/tmp"), "nested/file.pdf").is_err());
        assert!(output_file(Path::new("C:/tmp"), "result.pdf").is_ok());
    }
}
