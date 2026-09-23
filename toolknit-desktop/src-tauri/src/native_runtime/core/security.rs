pub(crate) fn toolknit_app_data_dir() -> Result<std::path::PathBuf, String> {
    Ok(dirs::data_dir()
        .ok_or("Cannot find AppData folder")?
        .join("ToolKnit"))
}

pub(crate) const AI_API_KEY_FILE_NAME: &str = "ai-api-key.dpapi";
pub(crate) const AI_API_KEY_FILE_HEADER: &[u8] = b"TKDPAPI1";
pub(crate) const AI_API_KEY_MAX_BYTES: usize = 8 * 1024;
pub(crate) const AI_API_KEY_FILE_MAX_BYTES: u64 = 64 * 1024;

pub(crate) fn ai_api_key_path() -> Result<std::path::PathBuf, String> {
    Ok(toolknit_app_data_dir()?.join(AI_API_KEY_FILE_NAME))
}

pub(crate) fn validate_ai_api_key(api_key: &str) -> Result<(), String> {
    if api_key.is_empty()
        || api_key.len() > AI_API_KEY_MAX_BYTES
        || api_key.chars().any(char::is_control)
    {
        return Err("ai-api-key:invalid".to_string());
    }
    Ok(())
}

#[cfg(target_os = "windows")]
pub(crate) fn protect_ai_api_key_bytes(plaintext: &mut [u8]) -> Result<Vec<u8>, String> {
    use windows::core::PCWSTR;
    use windows::Win32::Foundation::{LocalFree, HLOCAL};
    use windows::Win32::Security::Cryptography::{
        CryptProtectData, CRYPT_INTEGER_BLOB, CRYPTPROTECT_UI_FORBIDDEN,
    };

    let input_length = u32::try_from(plaintext.len()).map_err(|_| "ai-api-key:invalid")?;
    let input = CRYPT_INTEGER_BLOB {
        cbData: input_length,
        pbData: plaintext.as_mut_ptr(),
    };
    let mut output = CRYPT_INTEGER_BLOB::default();
    unsafe {
        CryptProtectData(
            &input,
            PCWSTR::null(),
            None,
            None,
            None,
            CRYPTPROTECT_UI_FORBIDDEN,
            &mut output,
        )
        .map_err(|_| "ai-api-key:protect-failed".to_string())?;
        if output.pbData.is_null() || output.cbData == 0 {
            return Err("ai-api-key:protect-failed".to_string());
        }
        let protected = std::slice::from_raw_parts(output.pbData, output.cbData as usize).to_vec();
        let _ = LocalFree(HLOCAL(output.pbData.cast()));
        Ok(protected)
    }
}

#[cfg(target_os = "windows")]
pub(crate) fn unprotect_ai_api_key_bytes(protected: &mut [u8]) -> Result<Vec<u8>, String> {
    use windows::Win32::Foundation::{LocalFree, HLOCAL};
    use windows::Win32::Security::Cryptography::{
        CryptUnprotectData, CRYPT_INTEGER_BLOB, CRYPTPROTECT_UI_FORBIDDEN,
    };

    let input_length = u32::try_from(protected.len()).map_err(|_| "ai-api-key:invalid")?;
    let input = CRYPT_INTEGER_BLOB {
        cbData: input_length,
        pbData: protected.as_mut_ptr(),
    };
    let mut output = CRYPT_INTEGER_BLOB::default();
    unsafe {
        CryptUnprotectData(
            &input,
            None,
            None,
            None,
            None,
            CRYPTPROTECT_UI_FORBIDDEN,
            &mut output,
        )
        .map_err(|_| "ai-api-key:unprotect-failed".to_string())?;
        if output.pbData.is_null() || output.cbData == 0 {
            return Err("ai-api-key:unprotect-failed".to_string());
        }
        let plaintext = std::slice::from_raw_parts(output.pbData, output.cbData as usize).to_vec();
        let _ = LocalFree(HLOCAL(output.pbData.cast()));
        Ok(plaintext)
    }
}

#[cfg(target_os = "windows")]
pub(crate) fn replace_ai_api_key_file(
    temporary_path: &std::path::Path,
    destination_path: &std::path::Path,
) -> Result<(), String> {
    use std::os::windows::ffi::OsStrExt;
    use windows::core::PCWSTR;
    use windows::Win32::Storage::FileSystem::{
        MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
    };

    let temporary_wide = temporary_path
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    let destination_wide = destination_path
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    unsafe {
        MoveFileExW(
            PCWSTR(temporary_wide.as_ptr()),
            PCWSTR(destination_wide.as_ptr()),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
        .map_err(|_| "ai-api-key:write-failed".to_string())
    }
}

#[tauri::command]
pub(crate) fn store_ai_api_key(mut api_key: String) -> Result<(), String> {
    use std::io::Write;
    use zeroize::Zeroize;

    let normalized = api_key.trim().to_string();
    api_key.zeroize();
    validate_ai_api_key(&normalized)?;

    let mut plaintext = normalized.into_bytes();
    let protected_result = protect_ai_api_key_bytes(&mut plaintext);
    plaintext.zeroize();
    let mut protected = protected_result?;

    let destination_path = ai_api_key_path()?;
    let parent = destination_path
        .parent()
        .ok_or_else(|| "ai-api-key:write-failed".to_string())?;
    std::fs::create_dir_all(parent).map_err(|_| "ai-api-key:write-failed".to_string())?;
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or(0);
    let temporary_path = parent.join(format!(
        ".ai-api-key-{}-{}.tmp",
        std::process::id(),
        stamp
    ));
    let write_result = (|| -> Result<(), String> {
        let mut output = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary_path)
            .map_err(|_| "ai-api-key:write-failed".to_string())?;
        output
            .write_all(AI_API_KEY_FILE_HEADER)
            .and_then(|_| output.write_all(&protected))
            .and_then(|_| output.sync_all())
            .map_err(|_| "ai-api-key:write-failed".to_string())?;
        replace_ai_api_key_file(&temporary_path, &destination_path)
    })();
    protected.zeroize();
    if write_result.is_err() {
        let _ = std::fs::remove_file(&temporary_path);
    }
    write_result
}

#[tauri::command]
pub(crate) fn load_ai_api_key() -> Result<Option<String>, String> {
    use zeroize::Zeroize;

    let path = ai_api_key_path()?;
    let metadata = match std::fs::metadata(&path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err("ai-api-key:read-failed".to_string()),
    };
    if !metadata.is_file() || metadata.len() > AI_API_KEY_FILE_MAX_BYTES {
        return Err("ai-api-key:invalid-storage".to_string());
    }
    let mut stored = std::fs::read(&path).map_err(|_| "ai-api-key:read-failed".to_string())?;
    if !stored.starts_with(AI_API_KEY_FILE_HEADER) || stored.len() == AI_API_KEY_FILE_HEADER.len() {
        stored.zeroize();
        return Err("ai-api-key:invalid-storage".to_string());
    }
    let mut protected = stored.split_off(AI_API_KEY_FILE_HEADER.len());
    stored.zeroize();
    let plaintext_result = unprotect_ai_api_key_bytes(&mut protected);
    protected.zeroize();
    let mut plaintext = plaintext_result?;
    let key_result = std::str::from_utf8(&plaintext)
        .map(str::to_owned)
        .map_err(|_| "ai-api-key:invalid-storage".to_string());
    plaintext.zeroize();
    let key = key_result?;
    validate_ai_api_key(&key)?;
    Ok(Some(key))
}

#[tauri::command]
pub(crate) fn clear_ai_api_key() -> Result<(), String> {
    match std::fs::remove_file(ai_api_key_path()?) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(_) => Err("ai-api-key:clear-failed".to_string()),
    }
}

#[cfg(all(test, target_os = "windows"))]
mod ai_api_key_storage_tests {
    use super::*;
    use zeroize::Zeroize;

    #[test]
    fn dpapi_round_trip_is_bound_to_the_current_windows_user() {
        let mut plaintext = b"toolknit-test-api-key".to_vec();
        let mut protected = protect_ai_api_key_bytes(&mut plaintext).unwrap();
        assert_ne!(protected, plaintext);
        let mut restored = unprotect_ai_api_key_bytes(&mut protected).unwrap();
        assert_eq!(restored, plaintext);
        plaintext.zeroize();
        protected.zeroize();
        restored.zeroize();
    }
}

pub(crate) const CUSTOM_FONT_DIRECTORY: &str = "custom-fonts";
pub(crate) const CUSTOM_FONT_MAX_BYTES: u64 = 40 * 1024 * 1024;
pub(crate) const CUSTOM_FONT_SLOTS: [&str; 4] = ["cn-medium", "cn-bold", "en-regular", "en-bold"];
pub(crate) const CUSTOM_FONT_EXTENSIONS: [&str; 4] = ["ttf", "otf", "woff", "woff2"];

#[derive(serde::Serialize)]
pub(crate) struct CustomFontAsset {
    pub(crate) slot: String,
    pub(crate) path: String,
    pub(crate) file_name: String,
}
