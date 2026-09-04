pub(crate) fn output_root_config_path() -> Result<std::path::PathBuf, String> {
    Ok(toolknit_app_data_dir()?.join("output-location.json"))
}

pub(crate) fn configured_output_root() -> Option<std::path::PathBuf> {
    let config_path = output_root_config_path().ok()?;
    let config = std::fs::read_to_string(config_path)
        .ok()
        .and_then(|content| serde_json::from_str::<OutputRootConfig>(&content).ok())?;
    config
        .output_root
        .and_then(|path| std::path::PathBuf::from(path).canonicalize().ok())
}

#[tauri::command]
pub(crate) fn get_output_root() -> Result<Option<String>, String> {
    Ok(configured_output_root().map(|path| cleanup_display_path(&path)))
}

#[tauri::command]
pub(crate) fn get_default_output_root() -> Result<String, String> {
    let downloads = dirs::download_dir()
        .or_else(dirs::document_dir)
        .ok_or("Cannot find a default output folder")?;
    let root = downloads.join("ToolKnit");
    std::fs::create_dir_all(&root)
        .map_err(|error| format!("Cannot create default output folder: {}", error))?;
    root.canonicalize()
        .map(|path| cleanup_display_path(&path))
        .map_err(|error| format!("Cannot access default output folder: {}", error))
}

#[tauri::command]
pub(crate) fn set_output_root(output_dir: Option<String>) -> Result<(), String> {
    let output_root = match output_dir {
        Some(path) if !path.trim().is_empty() => {
            if path.contains('\0') {
                return Err("Invalid output folder".to_string());
            }
            let canonical = std::path::PathBuf::from(path)
                .canonicalize()
                .map_err(|error| format!("Cannot access output folder: {}", error))?;
            if !canonical.is_dir() {
                return Err("Output location must be a folder".to_string());
            }
            Some(cleanup_display_path(&canonical))
        }
        _ => None,
    };

    let config_path = output_root_config_path()?;
    let parent = config_path.parent().ok_or("Invalid AppData folder")?;
    std::fs::create_dir_all(parent)
        .map_err(|error| format!("Cannot create settings folder: {}", error))?;
    let content = serde_json::to_vec(&OutputRootConfig { output_root })
        .map_err(|error| format!("Cannot save output location: {}", error))?;
    std::fs::write(config_path, content)
        .map_err(|error| format!("Cannot save output location: {}", error))
}

#[derive(serde::Serialize)]
pub(crate) struct CustomBackgroundAsset {
    pub(crate) path: String,
    pub(crate) media_type: String,
}

#[derive(Clone, serde::Serialize)]
pub(crate) struct LargeFileCandidate {
    pub(crate) id: String,
    pub(crate) path: String,
    pub(crate) name: String,
    pub(crate) extension: String,
    pub(crate) category: String,
    pub(crate) size_bytes: u64,
    pub(crate) modified_at: Option<i64>,
    pub(crate) folder_hint: String,
    pub(crate) risk: String,
    pub(crate) local_reason: String,
}

#[derive(serde::Serialize)]
pub(crate) struct LargeFileScanResult {
    pub(crate) root_path: String,
    pub(crate) min_size_bytes: u64,
    pub(crate) mode: String,
    pub(crate) scanned_files: u64,
    pub(crate) skipped_dirs: u64,
    pub(crate) drive_space: Option<CleanupDriveSpace>,
    pub(crate) candidates: Vec<LargeFileCandidate>,
}

#[derive(Clone, serde::Deserialize, serde::Serialize)]
pub(crate) struct CleanupDriveSpace {
    pub(crate) drive: String,
    pub(crate) free_bytes: u64,
    pub(crate) total_bytes: u64,
}

#[derive(serde::Serialize)]
pub(crate) struct RecycleBinMoveItem {
    pub(crate) path: String,
    pub(crate) ok: bool,
    pub(crate) error: Option<String>,
}

#[derive(serde::Serialize)]
pub(crate) struct RecycleBinMoveResult {
    pub(crate) requested: usize,
    pub(crate) moved: usize,
    pub(crate) failed: usize,
    pub(crate) freed_bytes: u64,
    pub(crate) items: Vec<RecycleBinMoveItem>,
}
