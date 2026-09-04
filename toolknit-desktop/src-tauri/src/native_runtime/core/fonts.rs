pub(crate) fn custom_font_dir() -> Result<std::path::PathBuf, String> {
    Ok(toolknit_app_data_dir()?.join(CUSTOM_FONT_DIRECTORY))
}

pub(crate) fn normalized_custom_font_slot(slot: &str) -> Result<&'static str, String> {
    let value = slot.trim().to_ascii_lowercase();
    CUSTOM_FONT_SLOTS
        .iter()
        .copied()
        .find(|candidate| *candidate == value)
        .ok_or("Unknown custom font slot".to_string())
}

pub(crate) fn normalized_custom_font_extension(path: &std::path::Path) -> Result<String, String> {
    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .map(|value| value.to_ascii_lowercase())
        .ok_or("Font file must use a supported extension".to_string())?;
    if CUSTOM_FONT_EXTENSIONS.contains(&extension.as_str()) {
        Ok(extension)
    } else {
        Err("Font file must be TTF, OTF, WOFF, or WOFF2".to_string())
    }
}

pub(crate) fn custom_font_slot_path(slot: &str, extension: &str) -> Result<std::path::PathBuf, String> {
    let normalized_slot = normalized_custom_font_slot(slot)?;
    if !CUSTOM_FONT_EXTENSIONS.contains(&extension) {
        return Err("Unsupported custom font extension".to_string());
    }
    Ok(custom_font_dir()?.join(format!("{}.{}", normalized_slot, extension)))
}

pub(crate) fn existing_custom_font_path(slot: &str) -> Result<Option<std::path::PathBuf>, String> {
    let normalized_slot = normalized_custom_font_slot(slot)?;
    let directory = custom_font_dir()?;
    for extension in CUSTOM_FONT_EXTENSIONS {
        let candidate = directory.join(format!("{}.{}", normalized_slot, extension));
        if candidate.is_file() {
            return Ok(Some(candidate));
        }
    }
    Ok(None)
}

pub(crate) fn remove_custom_font_slot_files(slot: &str) -> Result<(), String> {
    let normalized_slot = normalized_custom_font_slot(slot)?;
    let directory = custom_font_dir()?;
    for extension in CUSTOM_FONT_EXTENSIONS {
        let candidate = directory.join(format!("{}.{}", normalized_slot, extension));
        if candidate.exists() {
            std::fs::remove_file(&candidate)
                .map_err(|error| format!("Cannot remove custom font: {}", error))?;
        }
    }
    Ok(())
}

pub(crate) fn custom_font_magic_is_valid(extension: &str, header: &[u8]) -> bool {
    match extension {
        "ttf" => header.starts_with(&[0x00, 0x01, 0x00, 0x00]) || header.starts_with(b"true"),
        "otf" => header.starts_with(b"OTTO"),
        "woff" => header.starts_with(b"wOFF"),
        "woff2" => header.starts_with(b"wOF2"),
        _ => false,
    }
}

pub(crate) fn validate_custom_font_source(source: &std::path::Path) -> Result<(std::path::PathBuf, String, u64), String> {
    let canonical = source
        .canonicalize()
        .map_err(|error| format!("Cannot read font file: {}", error))?;
    let metadata = std::fs::metadata(&canonical)
        .map_err(|error| format!("Cannot inspect font file: {}", error))?;
    if !metadata.is_file() || metadata.len() == 0 || metadata.len() > CUSTOM_FONT_MAX_BYTES {
        return Err("Font file must be a non-empty file no larger than 40 MB".to_string());
    }
    let extension = normalized_custom_font_extension(&canonical)?;
    let mut input = std::fs::File::open(&canonical)
        .map_err(|error| format!("Cannot open font file: {}", error))?;
    let mut header = [0_u8; 4];
    use std::io::Read;
    input
        .read_exact(&mut header)
        .map_err(|_| "Invalid font file".to_string())?;
    if !custom_font_magic_is_valid(&extension, &header) {
        return Err("Font data does not match its file extension".to_string());
    }
    Ok((canonical, extension, metadata.len()))
}

#[tauri::command]
pub(crate) fn list_custom_fonts() -> Result<Vec<CustomFontAsset>, String> {
    let directory = custom_font_dir()?;
    if !directory.exists() {
        return Ok(Vec::new());
    }
    let root = directory
        .canonicalize()
        .map_err(|error| format!("Cannot inspect custom font folder: {}", error))?;
    let mut assets = Vec::new();
    for slot in CUSTOM_FONT_SLOTS {
        let Some(path) = existing_custom_font_path(slot)? else {
            continue;
        };
        let canonical = path
            .canonicalize()
            .map_err(|error| format!("Cannot inspect custom font: {}", error))?;
        if !canonical.starts_with(&root) {
            return Err("Custom font path is not permitted".to_string());
        }
        let metadata = std::fs::metadata(&canonical)
            .map_err(|error| format!("Cannot inspect custom font: {}", error))?;
        if !metadata.is_file() || metadata.len() == 0 || metadata.len() > CUSTOM_FONT_MAX_BYTES {
            return Err("Installed custom font has an invalid size".to_string());
        }
        let extension = normalized_custom_font_extension(&canonical)?;
        let mut input = std::fs::File::open(&canonical)
            .map_err(|error| format!("Cannot open custom font: {}", error))?;
        let mut header = [0_u8; 4];
        use std::io::Read;
        input
            .read_exact(&mut header)
            .map_err(|_| "Invalid custom font".to_string())?;
        if !custom_font_magic_is_valid(&extension, &header) {
            return Err("Installed custom font is invalid".to_string());
        }
        assets.push(CustomFontAsset {
            slot: slot.to_string(),
            path: canonical.to_string_lossy().into_owned(),
            file_name: canonical
                .file_name()
                .and_then(|value| value.to_str())
                .unwrap_or(slot)
                .to_string(),
        });
    }
    Ok(assets)
}

#[tauri::command]
pub(crate) fn import_custom_font(slot: String, source_path: String) -> Result<CustomFontAsset, String> {
    if source_path.contains('\0') {
        return Err("Invalid font file".to_string());
    }
    let normalized_slot = normalized_custom_font_slot(&slot)?;
    let (source, extension, _) = validate_custom_font_source(std::path::Path::new(&source_path))?;
    let directory = custom_font_dir()?;
    std::fs::create_dir_all(&directory)
        .map_err(|error| format!("Cannot prepare custom font folder: {}", error))?;
    let target = custom_font_slot_path(normalized_slot, &extension)?;
    let temporary = directory.join(format!(".{}.part.{}", normalized_slot, extension));
    std::fs::copy(&source, &temporary)
        .map_err(|error| format!("Cannot copy custom font: {}", error))?;
    if let Err(error) = validate_custom_font_source(&temporary) {
        let _ = std::fs::remove_file(&temporary);
        return Err(error);
    }
    remove_custom_font_slot_files(normalized_slot)?;
    std::fs::rename(&temporary, &target)
        .map_err(|error| format!("Cannot apply custom font: {}", error))?;
    let canonical = target
        .canonicalize()
        .map_err(|error| format!("Cannot finalize custom font: {}", error))?;
    Ok(CustomFontAsset {
        slot: normalized_slot.to_string(),
        path: canonical.to_string_lossy().into_owned(),
        file_name: canonical
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or(normalized_slot)
            .to_string(),
    })
}

#[tauri::command]
pub(crate) fn reset_custom_font(slot: String) -> Result<(), String> {
    remove_custom_font_slot_files(&slot)
}

#[cfg(test)]
mod custom_font_tests {
    use super::*;

    #[test]
    fn custom_font_slots_are_a_closed_allowlist() {
        assert_eq!(normalized_custom_font_slot("cn-medium").unwrap(), "cn-medium");
        assert_eq!(normalized_custom_font_slot(" EN-BOLD ").unwrap(), "en-bold");
        assert!(normalized_custom_font_slot("../outside").is_err());
        assert!(normalized_custom_font_slot("cn-heavy").is_err());
    }

    #[test]
    fn custom_font_signatures_must_match_declared_format() {
        assert!(custom_font_magic_is_valid("ttf", &[0x00, 0x01, 0x00, 0x00]));
        assert!(custom_font_magic_is_valid("otf", b"OTTO"));
        assert!(custom_font_magic_is_valid("woff", b"wOFF"));
        assert!(custom_font_magic_is_valid("woff2", b"wOF2"));
        assert!(!custom_font_magic_is_valid("ttf", b"OTTO"));
        assert!(!custom_font_magic_is_valid("exe", b"MZ\0\0"));
    }
}
