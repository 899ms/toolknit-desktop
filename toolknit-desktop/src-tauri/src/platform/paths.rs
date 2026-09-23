use std::path::{Path, PathBuf};

/// Resolve a path while rejecting traversal outside the supplied root.
#[allow(dead_code)]
pub fn confined_path(root: &Path, candidate: &Path) -> Result<PathBuf, String> {
    let root = root.canonicalize().map_err(|error| error.to_string())?;
    let resolved = if candidate.is_absolute() { candidate.to_path_buf() } else { root.join(candidate) };
    let canonical = resolved.canonicalize().map_err(|error| error.to_string())?;
    canonical.starts_with(&root).then_some(canonical).ok_or_else(|| "Path escapes the allowed root".to_string())
}
