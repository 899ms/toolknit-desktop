pub(crate) fn color_linear_rgb_table() -> [f32; 256] {
    std::array::from_fn(|index| {
        let value = index as f32 / 255.0;
        if value <= 0.04045 { value / 12.92 } else { ((value + 0.055) / 1.055).powf(2.4) }
    })
}

pub(crate) fn color_rgb_to_lab_with_table(rgb: [u8; 3], table: &[f32; 256]) -> [f32; 3] {
    let linear = |value: u8| table[value as usize];
    let r = linear(rgb[0]); let g = linear(rgb[1]); let b = linear(rgb[2]);
    let x = (r * 0.4124564 + g * 0.3575761 + b * 0.1804375) / 0.95047;
    let y = r * 0.2126729 + g * 0.7151522 + b * 0.072175;
    let z = (r * 0.0193339 + g * 0.119192 + b * 0.9503041) / 1.08883;
    let f = |value: f32| if value > 0.008856 { value.cbrt() } else { 7.787 * value + 16.0 / 116.0 };
    let fx = f(x); let fy = f(y); let fz = f(z);
    [116.0 * fy - 16.0, 500.0 * (fx - fy), 200.0 * (fy - fz)]
}

#[cfg(test)]
pub(crate) fn color_rgb_to_lab(rgb: [u8; 3]) -> [f32; 3] {
    color_rgb_to_lab_with_table(rgb, &color_linear_rgb_table())
}

pub(crate) fn color_delta_e(first: [f32; 3], second: [f32; 3]) -> f32 {
    ((first[0] - second[0]).powi(2) + (first[1] - second[1]).powi(2) + (first[2] - second[2]).powi(2)).sqrt()
}

pub(crate) fn color_replace_weight(distance: f32, threshold: f32, softness: f32) -> f32 {
    if distance > threshold { return 0.0; }
    if softness <= 0.0 { return 1.0; }
    let feather = (threshold * softness / 100.0).max(0.25);
    let edge = (threshold - feather).max(0.0);
    if distance <= edge { return 1.0; }
    let t = ((threshold - distance) / feather).clamp(0.0, 1.0);
    t * t * (3.0 - 2.0 * t)
}

pub(crate) fn color_replace_format(value: &str) -> Result<(image::ImageFormat, &'static str, String), String> {
    match value.trim().to_ascii_lowercase().as_str() {
        "png" => Ok((image::ImageFormat::Png, ".png", "PNG".to_string())),
        "jpg" | "jpeg" => Ok((image::ImageFormat::Jpeg, ".jpg", "JPG".to_string())),
        "webp" => Ok((image::ImageFormat::WebP, ".webp", "WEBP".to_string())),
        "bmp" => Ok((image::ImageFormat::Bmp, ".bmp", "BMP".to_string())),
        _ => Err("color-replace:unsupported-format".to_string()),
    }
}

pub(crate) fn color_replace_cancelled(options: &ColorReplaceOptions) -> bool {
    options.cancel_token.as_ref().is_some_and(|token| token.load(std::sync::atomic::Ordering::Relaxed))
}

pub(crate) fn emit_color_replace_progress(options: &ColorReplaceOptions, phase: &str, percent: f64, processed: usize, total: usize) {
    if let (Some(app), Some(operation_id)) = (&options.app, &options.operation_id) {
        let _ = app.emit("tool-operation-progress", ToolOperationProgress {
            operation_id: operation_id.clone(),
            phase: phase.to_string(),
            percent,
            processed_bytes: processed as u64,
            total_bytes: total as u64,
        });
    }
}

pub(crate) fn color_replace_blocking(options: ColorReplaceOptions) -> Result<ColorReplaceResult, String> {
    let (input, _) = validate_image_batch_input(&options.input_path).map_err(|_| "color-replace:invalid-input".to_string())?;
    let output_dir = validate_image_output_dir(&options.output_dir).map_err(|_| "color-replace:output-dir".to_string())?;
    let (format, extension, format_label) = color_replace_format(&options.format)?;
    if options.source_rgb.len() != 3 || options.target_rgb.len() != 3 || !(0.0..=100.0).contains(&options.threshold) || !(0.0..=100.0).contains(&options.softness) || !(1..=100).contains(&options.jpeg_quality) {
        return Err("color-replace:invalid-options".to_string());
    }
    let mut image = decode_oriented_image(&input).map_err(|_| "color-replace:decode-failed".to_string())?.to_rgba8();
    let width = image.width(); let height = image.height();
    if options.seed_x >= width || options.seed_y >= height { return Err("color-replace:invalid-seed".to_string()); }
    let source = [options.source_rgb[0], options.source_rgb[1], options.source_rgb[2]];
    let target = [options.target_rgb[0], options.target_rgb[1], options.target_rgb[2]];
    let linear_table = color_linear_rgb_table();
    let source_lab = color_rgb_to_lab_with_table(source, &linear_table);
    let pixels = (width as usize).checked_mul(height as usize).ok_or("color-replace:too-large")?;
    let mut candidates = vec![false; pixels]; let mut weights = vec![0.0_f32; pixels];
    let progress_step = (pixels / 100).max(1);
    emit_color_replace_progress(&options, "analyze", 0.0, 0, pixels);
    for (index, pixel) in image.pixels().enumerate() {
        if index % 4096 == 0 && color_replace_cancelled(&options) { return Err("tool-operation:cancelled".to_string()); }
        if pixel[3] == 0 { continue; }
        let distance = color_delta_e(color_rgb_to_lab_with_table([pixel[0], pixel[1], pixel[2]], &linear_table), source_lab);
        let weight = color_replace_weight(distance, options.threshold, options.softness);
        if weight > 0.0 { candidates[index] = true; weights[index] = weight; }
        if index % progress_step == 0 { emit_color_replace_progress(&options, "analyze", index as f64 / pixels as f64 * 45.0, index, pixels); }
    }
    let selected = if options.smart {
        let mut selected = vec![false; pixels];
        let seed = (options.seed_y as usize) * width as usize + options.seed_x as usize;
        if candidates[seed] {
            let mut queue = std::collections::VecDeque::from([seed]); selected[seed] = true;
            let mut visited = 0_usize;
            while let Some(current) = queue.pop_front() {
                visited += 1;
                if visited % 4096 == 0 && color_replace_cancelled(&options) { return Err("tool-operation:cancelled".to_string()); }
                let x = current % width as usize; let y = current / width as usize;
                for dy in -1_i32..=1 { for dx in -1_i32..=1 {
                    if dx == 0 && dy == 0 { continue; }
                    let nx = x as i32 + dx; let ny = y as i32 + dy;
                    if nx < 0 || ny < 0 || nx >= width as i32 || ny >= height as i32 { continue; }
                    let next = ny as usize * width as usize + nx as usize;
                    if candidates[next] && !selected[next] { selected[next] = true; queue.push_back(next); }
                }}
            }
        }
        selected
    } else { candidates };
    emit_color_replace_progress(&options, "replace", 55.0, 0, pixels);
    let source_lum = f32::from(source[0]) * 0.2126 + f32::from(source[1]) * 0.7152 + f32::from(source[2]) * 0.0722;
    let mut changed_pixels = 0_u64;
    for (index, pixel) in image.pixels_mut().enumerate() {
        if index % 4096 == 0 && color_replace_cancelled(&options) { return Err("tool-operation:cancelled".to_string()); }
        if !selected[index] { continue; }
        let current = [pixel[0], pixel[1], pixel[2]];
        let current_lum = f32::from(current[0]) * 0.2126 + f32::from(current[1]) * 0.7152 + f32::from(current[2]) * 0.0722;
        let delta = if options.preserve_luminance { current_lum - source_lum } else { 0.0 };
        let replacement = [f32::from(target[0]) + delta, f32::from(target[1]) + delta, f32::from(target[2]) + delta];
        let weight = weights[index];
        pixel[0] = (f32::from(current[0]) + (replacement[0] - f32::from(current[0])) * weight).round().clamp(0.0, 255.0) as u8;
        pixel[1] = (f32::from(current[1]) + (replacement[1] - f32::from(current[1])) * weight).round().clamp(0.0, 255.0) as u8;
        pixel[2] = (f32::from(current[2]) + (replacement[2] - f32::from(current[2])) * weight).round().clamp(0.0, 255.0) as u8;
        changed_pixels += 1;
        if index % progress_step == 0 { emit_color_replace_progress(&options, "replace", 55.0 + index as f64 / pixels as f64 * 40.0, index, pixels); }
    }
    let output_name = normalize_image_stitch_output_name(Some(&options.output_name)).map_err(|_| "color-replace:invalid-output-name".to_string())?;
    let mut temporary = ImageStitchTemporaryFile::new(&output_dir);
    if color_replace_cancelled(&options) { return Err("tool-operation:cancelled".to_string()); }
    emit_color_replace_progress(&options, "write", 96.0, pixels, pixels);
    write_image_crop(&image::DynamicImage::ImageRgba8(image), &temporary.path, format, options.jpeg_quality, image::Rgba([255, 255, 255, 255]))?;
    if color_replace_cancelled(&options) { return Err("tool-operation:cancelled".to_string()); }
    let output_path = publish_image_stitch_output(&mut temporary, &output_dir, Some(&output_name), extension).map_err(|_| "color-replace:publish-failed".to_string())?;
    let bytes = std::fs::metadata(&output_path).map(|value| value.len()).unwrap_or(0);
    emit_color_replace_progress(&options, "complete", 100.0, pixels, pixels);
    Ok(ColorReplaceResult { output_path, width, height, bytes, format: format_label, changed_pixels })
}

#[tauri::command]
pub(crate) async fn export_replaced_image(
    app: tauri::AppHandle, input_path: String, output_dir: String, output_name: String, source_rgb: Vec<u8>, target_rgb: Vec<u8>, threshold: f32, seed_x: u32, seed_y: u32, smart: bool, softness: f32, preserve_luminance: bool, format: String, jpeg_quality: u8, operation_id: Option<String>,
) -> Result<ColorReplaceResult, String> {
    let (operation_key, cancel_token) = match operation_id {
        Some(value) if !value.trim().is_empty() => {
            let token = register_tool_operation(&value)?;
            (Some(value), Some(token))
        }
        _ => (None, None),
    };
    let progress_operation_id = operation_key.clone();
    let result = tokio::task::spawn_blocking(move || color_replace_blocking(ColorReplaceOptions { app: Some(app), operation_id: progress_operation_id, input_path, output_dir, output_name, source_rgb, target_rgb, threshold, seed_x, seed_y, smart, softness, preserve_luminance, format, jpeg_quality, cancel_token })).await;
    if let Some(key) = operation_key { finish_tool_operation(&key); }
    result.map_err(|_| "color-replace:worker-failed".to_string())?
}

#[derive(Clone, serde::Serialize)]
pub(crate) struct ToolOperationProgress { pub(crate) operation_id: String, pub(crate) phase: String, pub(crate) percent: f64, pub(crate) processed_bytes: u64, pub(crate) total_bytes: u64 }

pub(crate) static TOOL_OPERATION_CANCELS: OnceLock<std::sync::Mutex<std::collections::HashMap<String, std::sync::Arc<std::sync::atomic::AtomicBool>>>> = OnceLock::new();

pub(crate) fn tool_operation_cancels() -> &'static std::sync::Mutex<std::collections::HashMap<String, std::sync::Arc<std::sync::atomic::AtomicBool>>> {
    TOOL_OPERATION_CANCELS.get_or_init(|| std::sync::Mutex::new(std::collections::HashMap::new()))
}

pub(crate) fn validate_tool_operation_id(operation_id: &str) -> Result<(), String> {
    if operation_id.is_empty() || operation_id.len() > 128 || !operation_id.bytes().all(|value| value.is_ascii_alphanumeric() || matches!(value, b'-' | b'_')) {
        return Err("tool-operation:invalid-id".to_string());
    }
    Ok(())
}

pub(crate) fn register_tool_operation(operation_id: &str) -> Result<std::sync::Arc<std::sync::atomic::AtomicBool>, String> {
    validate_tool_operation_id(operation_id)?;
    let token = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    let mut jobs = tool_operation_cancels().lock().map_err(|_| "tool-operation:lock".to_string())?;
    if jobs.insert(operation_id.to_string(), token.clone()).is_some() { return Err("tool-operation:duplicate-id".to_string()); }
    Ok(token)
}

pub(crate) fn finish_tool_operation(operation_id: &str) {
    if let Ok(mut jobs) = tool_operation_cancels().lock() { jobs.remove(operation_id); }
}

#[tauri::command]
pub(crate) fn cancel_tool_operation(operation_id: String) -> Result<(), String> {
    validate_tool_operation_id(&operation_id)?;
    if let Ok(jobs) = tool_operation_cancels().lock() {
        if let Some(token) = jobs.get(&operation_id) {
            token.store(true, std::sync::atomic::Ordering::Relaxed);
            return Ok(());
        }
    }
    Err("tool-operation:not-found".to_string())
}

#[derive(Clone, serde::Serialize)]
pub(crate) struct FileHashResult { pub(crate) digests: std::collections::BTreeMap<String, String>, pub(crate) processed_bytes: u64, pub(crate) total_bytes: u64 }

#[tauri::command]
pub(crate) async fn hash_file(app: tauri::AppHandle, input_path: String, algorithms: Vec<String>, hmac_key: Option<String>, operation_id: String) -> Result<FileHashResult, String> {
    let token = register_tool_operation(&operation_id)?;
    let operation = operation_id.clone();
    let joined = tokio::task::spawn_blocking(move || {
        use hmac::Mac;
        use sha2::Digest;
        use std::io::Read;

        let selected: std::collections::BTreeSet<String> = algorithms.iter().map(|value| value.to_ascii_lowercase()).collect();
        const SUPPORTED: [&str; 5] = ["md5", "sha1", "sha256", "sha512", "hmac-sha256"];
        if selected.is_empty() { return Err("file-hash:no-algorithm".to_string()); }
        if selected.iter().any(|value| !SUPPORTED.contains(&value.as_str())) { return Err("file-hash:unsupported-algorithm".to_string()); }
        if hmac_key.as_ref().is_some_and(|value| value.len() > 1024 * 1024) { return Err("file-hash:invalid-hmac-key".to_string()); }

        let path = std::path::PathBuf::from(&input_path);
        let meta = std::fs::symlink_metadata(&path).map_err(|_| "file-hash:invalid-input".to_string())?;
        if meta.file_type().is_symlink() || !meta.is_file() { return Err("file-hash:invalid-input".to_string()); }
        let total = meta.len();
        let mut file = std::fs::File::open(&path).map_err(|_| "file-hash:read-failed".to_string())?;
        let mut md5_state = selected.contains("md5").then(md5::Md5::new);
        let mut sha1_state = selected.contains("sha1").then(sha1::Sha1::new);
        let mut sha256_state = selected.contains("sha256").then(sha2::Sha256::new);
        let mut sha512_state = selected.contains("sha512").then(sha2::Sha512::new);
        let mut hmac_state = if selected.contains("hmac-sha256") {
            let key = hmac_key.as_deref().filter(|value| !value.is_empty()).ok_or_else(|| "file-hash:invalid-hmac-key".to_string())?;
            Some(hmac::Hmac::<sha2::Sha256>::new_from_slice(key.as_bytes()).map_err(|_| "file-hash:invalid-hmac-key".to_string())?)
        } else { None };
        let mut buffer = vec![0_u8; 1024 * 1024];
        let mut processed = 0_u64;
        let mut last_percent = 0_f64;
        loop {
            if token.load(std::sync::atomic::Ordering::Relaxed) { return Err("tool-operation:cancelled".to_string()); }
            let read = file.read(&mut buffer).map_err(|_| "file-hash:read-failed".to_string())?;
            if read == 0 { break; }
            let chunk = &buffer[..read];
            if let Some(state) = md5_state.as_mut() { state.update(chunk); }
            if let Some(state) = sha1_state.as_mut() { state.update(chunk); }
            if let Some(state) = sha256_state.as_mut() { state.update(chunk); }
            if let Some(state) = sha512_state.as_mut() { state.update(chunk); }
            if let Some(state) = hmac_state.as_mut() { state.update(chunk); }
            processed += read as u64;
            let percent = if total == 0 { 100.0 } else { processed as f64 / total as f64 * 100.0 };
            if percent - last_percent >= 1.0 || processed == total {
                last_percent = percent;
                let _ = app.emit("tool-operation-progress", ToolOperationProgress { operation_id: operation.clone(), phase: "hash".to_string(), percent, processed_bytes: processed, total_bytes: total });
            }
        }
        let mut digests = std::collections::BTreeMap::new();
        if let Some(state) = md5_state { digests.insert("md5".to_string(), hex::encode(state.finalize())); }
        if let Some(state) = sha1_state { digests.insert("sha1".to_string(), hex::encode(state.finalize())); }
        if let Some(state) = sha256_state { digests.insert("sha256".to_string(), hex::encode(state.finalize())); }
        if let Some(state) = sha512_state { digests.insert("sha512".to_string(), hex::encode(state.finalize())); }
        if let Some(state) = hmac_state { digests.insert("hmac-sha256".to_string(), hex::encode(state.finalize().into_bytes())); }
        let _ = app.emit("tool-operation-progress", ToolOperationProgress { operation_id: operation, phase: "complete".to_string(), percent: 100.0, processed_bytes: processed, total_bytes: total });
        Ok(FileHashResult { digests, processed_bytes: processed, total_bytes: total })
    }).await;
    finish_tool_operation(&operation_id);
    joined.map_err(|_| "file-hash:worker-failed".to_string())?
}

#[derive(Clone, Debug, serde::Serialize)]
pub(crate) struct TkaesResult { pub(crate) output_path: String, pub(crate) bytes: u64 }

pub(crate) const TKAE_MAGIC: &[u8; 4] = b"TKAE";
pub(crate) const TKAE_VERSION: u8 = 2;
pub(crate) const TKAE_CHUNK_SIZE: usize = 1024 * 1024;
pub(crate) const TKAE_ARGON_MEMORY_KIB: u32 = 19 * 1024;
pub(crate) const TKAE_ARGON_ITERATIONS: u32 = 2;
pub(crate) const TKAE_ARGON_LANES: u32 = 1;

pub(crate) fn tkaes_key(password: &str, salt: &[u8], memory_kib: u32, iterations: u32, lanes: u32) -> Result<aes_gcm::Aes256Gcm, String> {
    if !(8 * 1024..=256 * 1024).contains(&memory_kib) || !(1..=10).contains(&iterations) || !(1..=8).contains(&lanes) {
        return Err("tkaes:kdf-params".to_string());
    }
    let params = argon2::Params::new(memory_kib, iterations, lanes, Some(32)).map_err(|_| "tkaes:kdf-params".to_string())?;
    let mut key = [0_u8; 32];
    argon2::Argon2::new(argon2::Algorithm::Argon2id, argon2::Version::V0x13, params).hash_password_into(password.as_bytes(), salt, &mut key).map_err(|_| "tkaes:kdf-failed".to_string())?;
    use aes_gcm::KeyInit;
    use zeroize::Zeroize;
    let cipher = aes_gcm::Aes256Gcm::new_from_slice(&key).map_err(|_| "tkaes:key-failed".to_string());
    key.zeroize();
    cipher
}

pub(crate) fn tkaes_nonce(base: &[u8; 12], index: u64) -> [u8; 12] { let mut nonce = *base; let bytes = index.to_le_bytes(); for i in 0..8 { nonce[4 + i] ^= bytes[i]; } nonce }
pub(crate) fn tkaes_aad(index: u64, length: u32) -> Vec<u8> { let mut aad = Vec::with_capacity(16); aad.extend_from_slice(TKAE_MAGIC); aad.extend_from_slice(&index.to_le_bytes()); aad.extend_from_slice(&length.to_le_bytes()); aad }
pub(crate) fn publish_tkaes_temp(temp: &std::path::Path, dir: &std::path::Path, stem: &str, extension: &str) -> Result<String, String> { for index in 0..10000_u32 { let suffix = if index == 0 { String::new() } else { format!("_{}", index) }; let path = dir.join(format!("{}{}{}", stem, suffix, extension)); if path.exists() { continue; } match std::fs::rename(temp, &path) { Ok(()) => return Ok(path.to_string_lossy().into_owned()), Err(_) => continue } } Err("tkaes:publish-failed".to_string()) }

pub(crate) fn tkaes_temp_path(dir: &std::path::Path, kind: &str) -> Result<std::path::PathBuf, String> {
    let mut random = [0_u8; 8];
    getrandom::getrandom(&mut random).map_err(|_| "tkaes:random-failed".to_string())?;
    Ok(dir.join(format!(".toolknit-{}-{}-{}.part", kind, std::process::id(), hex::encode(random))))
}

pub(crate) fn tkaes_encrypted_stem(input: &std::path::Path) -> &str { input.file_name().and_then(|value| value.to_str()).unwrap_or("encrypted") }
pub(crate) fn tkaes_decrypted_stem(input: &std::path::Path) -> String { let name = input.file_name().and_then(|value| value.to_str()).unwrap_or("decrypted"); if name.to_ascii_lowercase().ends_with(".tkaes") { name[..name.len() - 6].to_string() } else { format!("{}.bin", name) } }

pub(crate) struct TkaesTempGuard { pub(crate) path: std::path::PathBuf, pub(crate) published: bool }
impl TkaesTempGuard { fn new(path: std::path::PathBuf) -> Self { Self { path, published: false } } fn path(&self) -> &std::path::Path { &self.path } fn mark_published(&mut self) { self.published = true; } }
impl Drop for TkaesTempGuard { fn drop(&mut self) { if !self.published { let _ = std::fs::remove_file(&self.path); } } }

pub(crate) fn tkaes_encrypt_blocking(app: Option<tauri::AppHandle>, input_path: String, output_dir: String, password: String, operation_id: String, token: std::sync::Arc<std::sync::atomic::AtomicBool>) -> Result<TkaesResult, String> {
    use aes_gcm::{aead::{Aead, Payload}, Nonce};
    use std::io::{Read, Write};
    let input = std::path::PathBuf::from(input_path);
    let meta = std::fs::metadata(&input).map_err(|_| "tkaes:invalid-input".to_string())?;
    if !meta.is_file() { return Err("tkaes:invalid-input".to_string()); }
    let dir = validate_image_output_dir(&output_dir).map_err(|_| "tkaes:output-dir".to_string())?;
    let mut salt = [0_u8; 16]; let mut base_nonce = [0_u8; 12];
    getrandom::getrandom(&mut salt).map_err(|_| "tkaes:random-failed".to_string())?;
    getrandom::getrandom(&mut base_nonce).map_err(|_| "tkaes:random-failed".to_string())?;
    let cipher = tkaes_key(&password, &salt, TKAE_ARGON_MEMORY_KIB, TKAE_ARGON_ITERATIONS, TKAE_ARGON_LANES)?;
    let mut input_file = std::fs::File::open(&input).map_err(|_| "tkaes:read-failed".to_string())?;
    let stem = tkaes_encrypted_stem(&input);
    let mut guard = TkaesTempGuard::new(tkaes_temp_path(&dir, "encrypt")?);
    let mut output = std::fs::OpenOptions::new().write(true).create_new(true).open(guard.path()).map_err(|_| "tkaes:temp-failed".to_string())?;
    output.write_all(TKAE_MAGIC).map_err(|_| "tkaes:write-failed".to_string())?;
    output.write_all(&[TKAE_VERSION]).map_err(|_| "tkaes:write-failed".to_string())?;
    output.write_all(&(TKAE_CHUNK_SIZE as u32).to_le_bytes()).map_err(|_| "tkaes:write-failed".to_string())?;
    output.write_all(&meta.len().to_le_bytes()).map_err(|_| "tkaes:write-failed".to_string())?;
    output.write_all(&TKAE_ARGON_MEMORY_KIB.to_le_bytes()).map_err(|_| "tkaes:write-failed".to_string())?;
    output.write_all(&TKAE_ARGON_ITERATIONS.to_le_bytes()).map_err(|_| "tkaes:write-failed".to_string())?;
    output.write_all(&TKAE_ARGON_LANES.to_le_bytes()).map_err(|_| "tkaes:write-failed".to_string())?;
    output.write_all(&salt).map_err(|_| "tkaes:write-failed".to_string())?;
    output.write_all(&base_nonce).map_err(|_| "tkaes:write-failed".to_string())?;
    let mut buffer = vec![0_u8; TKAE_CHUNK_SIZE]; let mut index = 0_u64; let mut processed = 0_u64;
    loop {
        if token.load(std::sync::atomic::Ordering::Relaxed) { return Err("tool-operation:cancelled".to_string()); }
        let read = input_file.read(&mut buffer).map_err(|_| "tkaes:read-failed".to_string())?;
        if read == 0 { break; }
        let aad = tkaes_aad(index, read as u32); let nonce = tkaes_nonce(&base_nonce, index);
        let encrypted = cipher.encrypt(Nonce::from_slice(&nonce), Payload { msg: &buffer[..read], aad: &aad }).map_err(|_| "tkaes:encrypt-failed".to_string())?;
        output.write_all(&(read as u32).to_le_bytes()).map_err(|_| "tkaes:write-failed".to_string())?;
        output.write_all(&encrypted).map_err(|_| "tkaes:write-failed".to_string())?;
        processed += read as u64; index += 1;
        if let Some(app) = &app { let _ = app.emit("tool-operation-progress", ToolOperationProgress { operation_id: operation_id.clone(), phase: "encrypt".to_string(), percent: processed as f64 / meta.len().max(1) as f64 * 100.0, processed_bytes: processed, total_bytes: meta.len() }); }
    }
    output.sync_all().map_err(|_| "tkaes:write-failed".to_string())?; drop(output);
    let output_path = publish_tkaes_temp(guard.path(), &dir, stem, ".tkaes")?; guard.mark_published();
    Ok(TkaesResult { bytes: std::fs::metadata(&output_path).map(|value| value.len()).unwrap_or(0), output_path })
}

pub(crate) fn read_tkaes_u32(file: &mut std::fs::File) -> Result<u32, String> { use std::io::Read; let mut bytes = [0_u8; 4]; file.read_exact(&mut bytes).map_err(|_| "tkaes:invalid-container".to_string())?; Ok(u32::from_le_bytes(bytes)) }

pub(crate) fn tkaes_decrypt_blocking(app: Option<tauri::AppHandle>, input_path: String, output_dir: String, password: String, operation_id: String, token: std::sync::Arc<std::sync::atomic::AtomicBool>) -> Result<TkaesResult, String> {
    use aes_gcm::{aead::{Aead, Payload}, Nonce};
    use std::io::{Read, Write};
    let input = std::path::PathBuf::from(input_path); let dir = validate_image_output_dir(&output_dir).map_err(|_| "tkaes:output-dir".to_string())?;
    let mut file = std::fs::File::open(&input).map_err(|_| "tkaes:read-failed".to_string())?;
    let mut magic = [0_u8; 4]; file.read_exact(&mut magic).map_err(|_| "tkaes:invalid-container".to_string())?;
    if &magic != TKAE_MAGIC { return Err("tkaes:invalid-container".to_string()); }
    let mut version = [0_u8; 1]; file.read_exact(&mut version).map_err(|_| "tkaes:invalid-container".to_string())?;
    if ![1, TKAE_VERSION].contains(&version[0]) { return Err("tkaes:unsupported-version".to_string()); }
    let chunk_size = read_tkaes_u32(&mut file)? as usize;
    if chunk_size == 0 || chunk_size > 16 * 1024 * 1024 { return Err("tkaes:invalid-container".to_string()); }
    let mut length_buf = [0_u8; 8]; file.read_exact(&mut length_buf).map_err(|_| "tkaes:invalid-container".to_string())?; let total = u64::from_le_bytes(length_buf);
    let (memory_kib, iterations, lanes) = if version[0] == 1 { (TKAE_ARGON_MEMORY_KIB, TKAE_ARGON_ITERATIONS, TKAE_ARGON_LANES) } else { (read_tkaes_u32(&mut file)?, read_tkaes_u32(&mut file)?, read_tkaes_u32(&mut file)?) };
    let mut salt = [0_u8; 16]; let mut base_nonce = [0_u8; 12];
    file.read_exact(&mut salt).map_err(|_| "tkaes:invalid-container".to_string())?; file.read_exact(&mut base_nonce).map_err(|_| "tkaes:invalid-container".to_string())?;
    let cipher = tkaes_key(&password, &salt, memory_kib, iterations, lanes)?;
    let stem = tkaes_decrypted_stem(&input); let mut guard = TkaesTempGuard::new(tkaes_temp_path(&dir, "decrypt")?);
    let mut output = std::fs::OpenOptions::new().write(true).create_new(true).open(guard.path()).map_err(|_| "tkaes:temp-failed".to_string())?;
    let mut processed = 0_u64; let mut index = 0_u64;
    while processed < total {
        if token.load(std::sync::atomic::Ordering::Relaxed) { return Err("tool-operation:cancelled".to_string()); }
        let plain_len = read_tkaes_u32(&mut file)? as usize;
        if plain_len == 0 || plain_len > chunk_size || processed + plain_len as u64 > total { return Err("tkaes:invalid-container".to_string()); }
        let mut encrypted = vec![0_u8; plain_len + 16]; file.read_exact(&mut encrypted).map_err(|_| "tkaes:invalid-container".to_string())?;
        let nonce = tkaes_nonce(&base_nonce, index); let aad = tkaes_aad(index, plain_len as u32);
        let plain = cipher.decrypt(Nonce::from_slice(&nonce), Payload { msg: &encrypted, aad: &aad }).map_err(|_| "tkaes:authentication-failed".to_string())?;
        output.write_all(&plain).map_err(|_| "tkaes:write-failed".to_string())?; processed += plain.len() as u64; index += 1;
        if let Some(app) = &app { let _ = app.emit("tool-operation-progress", ToolOperationProgress { operation_id: operation_id.clone(), phase: "decrypt".to_string(), percent: processed as f64 / total.max(1) as f64 * 100.0, processed_bytes: processed, total_bytes: total }); }
    }
    if file.read(&mut [0_u8; 1]).map_err(|_| "tkaes:read-failed".to_string())? != 0 { return Err("tkaes:trailing-data".to_string()); }
    output.sync_all().map_err(|_| "tkaes:write-failed".to_string())?; drop(output);
    let output_path = publish_tkaes_temp(guard.path(), &dir, &stem, "")?; guard.mark_published();
    Ok(TkaesResult { bytes: std::fs::metadata(&output_path).map(|value| value.len()).unwrap_or(0), output_path })
}

#[tauri::command]
pub(crate) async fn encrypt_tkaes_file(app: tauri::AppHandle, input_path: String, output_dir: String, password: String, operation_id: String) -> Result<TkaesResult, String> {
    if password.is_empty() { return Err("tkaes:password-required".to_string()); }
    let token = register_tool_operation(&operation_id)?; let cleanup_id = operation_id.clone();
    let joined = tokio::task::spawn_blocking(move || tkaes_encrypt_blocking(Some(app), input_path, output_dir, password, operation_id, token)).await;
    finish_tool_operation(&cleanup_id);
    joined.map_err(|_| "tkaes:worker-failed".to_string())?
}

#[tauri::command]
pub(crate) async fn decrypt_tkaes_file(app: tauri::AppHandle, input_path: String, output_dir: String, password: String, operation_id: String) -> Result<TkaesResult, String> {
    if password.is_empty() { return Err("tkaes:password-required".to_string()); }
    let token = register_tool_operation(&operation_id)?; let cleanup_id = operation_id.clone();
    let joined = tokio::task::spawn_blocking(move || tkaes_decrypt_blocking(Some(app), input_path, output_dir, password, operation_id, token)).await;
    finish_tool_operation(&cleanup_id);
    joined.map_err(|_| "tkaes:worker-failed".to_string())?
}
