const PPT_RENDER_MAX_INPUT_BYTES: u64 = 200 * 1024 * 1024;
const PPT_RENDER_MAX_SLIDES: usize = 500;

#[derive(Clone, Debug)]
struct PptRenderInput {
    path: std::path::PathBuf,
    name: String,
    bytes: u64,
    slide_count: usize,
}

#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct LibreOfficeRuntimeInfo {
    available: bool,
    command: Option<String>,
    source: Option<String>,
    version: Option<String>,
    message: Option<String>,
}

#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct PptToPdfResult {
    tool: String,
    source_name: String,
    input_path: String,
    input_bytes: u64,
    renderer: LibreOfficeRuntimeInfo,
    slide_count: usize,
    page_count: usize,
    page_count_matches_slides: bool,
    output_dir: String,
    output_path: String,
    output_file: String,
    output_bytes: u64,
    manifest_path: String,
    warnings: Vec<String>,
}

fn normalize_zip_entry_name(value: &str) -> String {
    value
        .replace('\\', "/")
        .trim_start_matches('/')
        .split('/')
        .filter(|part| !part.is_empty() && *part != ".")
        .collect::<Vec<_>>()
        .join("/")
}

fn pptx_central_directory_entries(bytes: &[u8]) -> Vec<String> {
    let mut entries = Vec::new();
    let mut index = 0usize;
    while index + 46 <= bytes.len() {
        if &bytes[index..index + 4] != b"PK\x01\x02" {
            index += 1;
            continue;
        }
        let file_name_len = u16::from_le_bytes([bytes[index + 28], bytes[index + 29]]) as usize;
        let extra_len = u16::from_le_bytes([bytes[index + 30], bytes[index + 31]]) as usize;
        let comment_len = u16::from_le_bytes([bytes[index + 32], bytes[index + 33]]) as usize;
        let name_start = index + 46;
        let name_end = name_start.saturating_add(file_name_len);
        let next = name_end
            .saturating_add(extra_len)
            .saturating_add(comment_len);
        if name_end <= bytes.len() && next <= bytes.len() {
            let name = String::from_utf8_lossy(&bytes[name_start..name_end]);
            let normalized = normalize_zip_entry_name(&name);
            if !normalized.is_empty() && !normalized.split('/').any(|part| part == "..") {
                entries.push(normalized);
            }
            index = next;
        } else {
            index += 4;
        }
    }
    entries
}

fn pptx_entry_eq(entry: &str, expected: &str) -> bool {
    entry.eq_ignore_ascii_case(expected)
}

fn is_pptx_slide_entry(entry: &str) -> bool {
    let lower = entry.to_ascii_lowercase();
    let Some(number) = lower
        .strip_prefix("ppt/slides/slide")
        .and_then(|value| value.strip_suffix(".xml"))
    else {
        return false;
    };
    !number.is_empty() && number.bytes().all(|byte| byte.is_ascii_digit())
}

fn sanitize_ppt_render_base_name(value: &str) -> String {
    let file_name = std::path::Path::new(value)
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("presentation.pptx");
    let stem = std::path::Path::new(file_name)
        .file_stem()
        .and_then(|name| name.to_str())
        .unwrap_or("presentation");
    let mut result = String::new();
    let mut previous_was_underscore = false;
    for character in stem.chars() {
        let invalid = matches!(
            character,
            '\\' | '/' | ':' | '*' | '?' | '"' | '<' | '>' | '|' | '\0'..='\u{1f}'
        );
        let next = if invalid || character.is_whitespace() {
            '_'
        } else {
            character
        };
        if next == '_' {
            if previous_was_underscore {
                continue;
            }
            previous_was_underscore = true;
        } else {
            previous_was_underscore = false;
        }
        result.push(next);
        if result.chars().count() >= 80 {
            break;
        }
    }
    let trimmed = result.trim_matches(|character| character == '.' || character == '_');
    let reserved = matches!(
        trimmed.to_ascii_lowercase().as_str(),
        "con"
            | "prn"
            | "aux"
            | "nul"
            | "com1"
            | "com2"
            | "com3"
            | "com4"
            | "com5"
            | "com6"
            | "com7"
            | "com8"
            | "com9"
            | "lpt1"
            | "lpt2"
            | "lpt3"
            | "lpt4"
            | "lpt5"
            | "lpt6"
            | "lpt7"
            | "lpt8"
            | "lpt9"
    );
    if trimmed.is_empty() || reserved {
        "presentation".to_string()
    } else {
        trimmed.to_string()
    }
}

fn inspect_ppt_render_input(input_path: &str) -> Result<PptRenderInput, String> {
    if input_path.trim().is_empty() || input_path.contains('\0') {
        return Err("ppt-render:invalid-input".to_string());
    }
    let requested = std::path::PathBuf::from(input_path);
    let extension = requested
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    if extension != "pptx" {
        return Err("ppt-render:invalid-extension".to_string());
    }
    let metadata = std::fs::symlink_metadata(&requested)
        .map_err(|_| "ppt-render:input-not-found".to_string())?;
    if metadata.file_type().is_symlink() || !metadata.is_file() || metadata.len() == 0 {
        return Err("ppt-render:invalid-input".to_string());
    }
    if metadata.len() > PPT_RENDER_MAX_INPUT_BYTES {
        return Err("ppt-render:input-too-large".to_string());
    }
    let path = requested
        .canonicalize()
        .map_err(|_| "ppt-render:invalid-input".to_string())?;
    let name = path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("presentation.pptx")
        .to_string();
    let bytes = std::fs::read(&path).map_err(|_| "ppt-render:read-failed".to_string())?;
    if bytes.len() < 4 || bytes[0] != 0x50 || bytes[1] != 0x4b {
        return Err("ppt-render:invalid-pptx".to_string());
    }
    let entries = pptx_central_directory_entries(&bytes);
    if !entries
        .iter()
        .any(|entry| pptx_entry_eq(entry, "[Content_Types].xml"))
        || !entries
            .iter()
            .any(|entry| pptx_entry_eq(entry, "ppt/presentation.xml"))
    {
        return Err("ppt-render:invalid-pptx".to_string());
    }
    let slide_count = entries
        .iter()
        .filter(|entry| is_pptx_slide_entry(entry))
        .count();
    if slide_count == 0 {
        return Err("ppt-render:empty-ppt".to_string());
    }
    if slide_count > PPT_RENDER_MAX_SLIDES {
        return Err("ppt-render:too-many-slides".to_string());
    }
    Ok(PptRenderInput {
        path,
        name,
        bytes: metadata.len(),
        slide_count,
    })
}

fn ppt_render_output_parent(output_dir: &str) -> Result<std::path::PathBuf, String> {
    validate_image_output_dir(output_dir).map_err(|_| "ppt-render:output-path".to_string())
}

fn unique_ppt_render_output_dir(
    parent: &std::path::Path,
    base_name: &str,
    suffix_name: &str,
) -> Result<std::path::PathBuf, String> {
    let base = sanitize_ppt_render_base_name(base_name);
    for counter in 0..10_000_u32 {
        let suffix = if counter == 0 {
            String::new()
        } else {
            format!("_{}", counter)
        };
        let candidate = parent.join(format!("{}_{}{}", base, suffix_name, suffix));
        match std::fs::symlink_metadata(&candidate) {
            Ok(_) => continue,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(candidate),
            Err(_) => return Err("ppt-render:output-path".to_string()),
        }
    }
    Err("ppt-render:output-path".to_string())
}

fn create_ppt_render_temp_dir(parent: &std::path::Path) -> Result<std::path::PathBuf, String> {
    for _ in 0..10_000 {
        let counter = PPT_RENDER_TEMP_ID.fetch_add(1, Ordering::SeqCst);
        let candidate = parent.join(format!(
            ".toolknit-ppt-render-{}-{}",
            std::process::id(),
            counter
        ));
        match std::fs::create_dir(&candidate) {
            Ok(()) => return Ok(candidate),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(_) => return Err("ppt-render:output-path".to_string()),
        }
    }
    Err("ppt-render:output-path".to_string())
}

fn shell_path_candidates_from_path_env(file_names: &[&str]) -> Vec<std::path::PathBuf> {
    std::env::var_os("PATH")
        .map(|value| {
            std::env::split_paths(&value)
                .flat_map(|directory| file_names.iter().map(move |name| directory.join(name)))
                .collect()
        })
        .unwrap_or_default()
}

fn libreoffice_candidates() -> Vec<(std::path::PathBuf, &'static str)> {
    let exe_name = if cfg!(target_os = "windows") {
        "soffice.com"
    } else {
        "soffice"
    };
    let mut candidates = Vec::new();
    if let Ok(value) = std::env::var("TOOLKNIT_LIBREOFFICE_PATH") {
        if !value.trim().is_empty() && !value.contains('\0') {
            candidates.push((
                std::path::PathBuf::from(value),
                "env:TOOLKNIT_LIBREOFFICE_PATH",
            ));
        }
    }
    if let Ok(managed) = libreoffice_runtime_path() {
        candidates.push((managed, "managed"));
    }
    #[cfg(target_os = "windows")]
    {
        for key in ["ProgramFiles", "ProgramFiles(x86)"] {
            if let Ok(root) = std::env::var(key) {
                let directory = std::path::PathBuf::from(root)
                    .join("LibreOffice")
                    .join("program");
                candidates.push((directory.join("soffice.com"), "windows-install"));
                candidates.push((directory.join("soffice.exe"), "windows-install"));
            }
        }
    }
    if let Ok(current_dir) = std::env::current_dir() {
        for ancestor in current_dir.ancestors().take(6) {
            candidates.push((
                ancestor
                    .join("_research")
                    .join("runtime-cache")
                    .join("libreoffice-26.2.5")
                    .join("program")
                    .join(exe_name),
                "dev-runtime-cache",
            ));
            if let Some(parent) = ancestor.parent() {
                candidates.push((
                    parent
                        .join("_research")
                        .join("runtime-cache")
                        .join("libreoffice-26.2.5")
                        .join("program")
                        .join(exe_name),
                    "dev-runtime-cache",
                ));
            }
        }
    }
    if let Ok(current_exe) = std::env::current_exe() {
        for ancestor in current_exe.ancestors().take(8) {
            candidates.push((
                ancestor
                    .join("_research")
                    .join("runtime-cache")
                    .join("libreoffice-26.2.5")
                    .join("program")
                    .join(exe_name),
                "dev-runtime-cache",
            ));
        }
    }
    #[cfg(target_os = "windows")]
    {
        candidates.extend(
            shell_path_candidates_from_path_env(&["soffice.com", "soffice.exe"])
                .into_iter()
                .map(|path| (path, "PATH")),
        );
    }
    #[cfg(not(target_os = "windows"))]
    {
        candidates.extend(
            shell_path_candidates_from_path_env(&["soffice", "libreoffice"])
                .into_iter()
                .map(|path| (path, "PATH")),
        );
    }
    let mut seen = std::collections::BTreeSet::new();
    candidates
        .into_iter()
        .filter(|(path, _)| {
            let key = path.to_string_lossy().to_ascii_lowercase();
            if seen.contains(&key) {
                return false;
            }
            seen.insert(key)
        })
        .collect()
}

fn probe_libreoffice(
    path: &std::path::Path,
    source: &'static str,
) -> Option<LibreOfficeRuntimeInfo> {
    let metadata = std::fs::metadata(path).ok()?;
    if !metadata.is_file() {
        return None;
    }
    // Isolate the probe into a throwaway profile. LibreOffice can block on the
    // default profile lock, and the desktop app plus the CLI can probe
    // concurrently from separate processes; a shared profile makes `--version`
    // hang (LibreOffice then relaunches itself in safe mode) and leaves
    // orphaned soffice workers behind.
    let profile_dir = std::env::temp_dir().join(format!(
        "toolknit-lo-probe-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|duration| duration.as_nanos())
            .unwrap_or(0)
    ));
    let _ = std::fs::create_dir_all(&profile_dir);
    let mut command = std::process::Command::new(path);
    command
        .arg(format!(
            "-env:UserInstallation={}",
            file_url_for_libreoffice(&profile_dir)
        ))
        .arg("--version")
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    let mut child = command.spawn().ok()?;
    let child_id = child.id();
    let started_at = std::time::Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) => {
                if started_at.elapsed().as_millis() >= PPT_RENDER_PROBE_TIMEOUT_MS {
                    terminate_conversion_process(child_id);
                    let _ = child.wait();
                    let _ = std::fs::remove_dir_all(&profile_dir);
                    return None;
                }
                std::thread::sleep(std::time::Duration::from_millis(40));
            }
            Err(_) => {
                terminate_conversion_process(child_id);
                let _ = child.wait();
                let _ = std::fs::remove_dir_all(&profile_dir);
                return None;
            }
        }
    }
    let output = child.wait_with_output();
    let _ = std::fs::remove_dir_all(&profile_dir);
    match output {
        Ok(output) if output.status.success() => {
            let stdout = String::from_utf8_lossy(&output.stdout);
            let stderr = String::from_utf8_lossy(&output.stderr);
            let version = stdout
                .lines()
                .chain(stderr.lines())
                .map(str::trim)
                .find(|line| !line.is_empty())
                .unwrap_or("LibreOffice")
                .to_string();
            Some(LibreOfficeRuntimeInfo {
                available: true,
                command: Some(path.to_string_lossy().into_owned()),
                source: Some(source.to_string()),
                version: Some(version),
                message: None,
            })
        }
        _ => None,
    }
}

fn resolve_libreoffice_runtime() -> LibreOfficeRuntimeInfo {
    // Reuse a validated path for conversions. The command itself is still
    // launched by the conversion worker; this only avoids repeated probes.
    if let Some(runtime) = cached_libreoffice_runtime() {
        let valid = runtime
            .command
            .as_deref()
            .map(std::path::Path::new)
            .is_some_and(|path| std::fs::metadata(path).map(|meta| meta.is_file()).unwrap_or(false));
        if valid {
            return runtime;
        }
        invalidate_libreoffice_runtime_cache();
    }
    if let Some(runtime) = resolve_libreoffice_runtime_quick() {
        cache_libreoffice_runtime(runtime.clone());
        return runtime;
    }
    for (candidate, source) in libreoffice_candidates() {
        if let Some(runtime) = probe_libreoffice(&candidate, source) {
            cache_libreoffice_runtime(runtime.clone());
            return runtime;
        }
    }
    LibreOfficeRuntimeInfo {
        available: false,
        command: None,
        source: None,
        version: None,
        message: Some(
            "LibreOffice runtime was not found. Install LibreOffice or set TOOLKNIT_LIBREOFFICE_PATH to soffice.com/soffice.exe.".to_string(),
        ),
    }
}

fn file_url_for_libreoffice(path: &std::path::Path) -> String {
    let mut text = cleanup_display_path(path).replace('\\', "/");
    text = text
        .replace('%', "%25")
        .replace(' ', "%20")
        .replace('#', "%23")
        .replace('?', "%3F");
    #[cfg(target_os = "windows")]
    {
        if !text.starts_with('/') {
            return format!("file:///{}", text);
        }
    }
    format!("file://{}", text)
}

/// Seed the LibreOffice user profile so headless conversions never ask the
/// Windows print spooler for the document's embedded printer. Impress loads
/// printer settings by default (`LoadPrinterSettings` defaults to `true`),
/// which makes an offline/slow WSD printer stall a conversion for up to the
/// spooler timeout. Writing `false` into `registrymodifications.xcu` keeps the
/// conversion fully file based.
fn seed_libreoffice_printer_profile(profile_dir: &std::path::Path) {
    let user_dir = profile_dir.join("user");
    if std::fs::create_dir_all(&user_dir).is_err() {
        return;
    }
    let xcu_path = user_dir.join("registrymodifications.xcu");
    let existing = std::fs::read_to_string(&xcu_path).unwrap_or_default();
    let header = "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<oor:items xmlns:oor=\"http://openoffice.org/2001/registry\" xmlns:xs=\"http://www.w3.org/2001/XMLSchema\" xmlns:xsi=\"http://www.w3.org/2001/XMLSchema-instance\">";
    let footer = "</oor:items>";
    let printer_item = "<item oor:path=\"/org.openoffice.Office.Common/LoadSave/General\"><prop oor:name=\"LoadPrinterSettings\" oor:op=\"fuse\"><value>false</value></prop></item>";

    let mut updated = if existing.trim().is_empty() {
        format!("{}\n{}\n{}\n", header, printer_item, footer)
    } else if existing.contains("LoadPrinterSettings") {
        existing
            .lines()
            .map(|line| {
                if line.contains("LoadPrinterSettings") {
                    printer_item.to_string()
                } else {
                    line.to_string()
                }
            })
            .collect::<Vec<_>>()
            .join("\n")
    } else if let Some(footer_pos) = existing.rfind("</oor:items>") {
        let mut seeded = existing.clone();
        seeded.insert_str(footer_pos, &format!("{}\n", printer_item));
        seeded
    } else {
        existing
    };
    if !updated.ends_with('\n') {
        updated.push('\n');
    }
    let _ = std::fs::write(&xcu_path, updated);
}

fn find_rendered_pdf(
    directory: &std::path::Path,
    input_name: &str,
) -> Result<std::path::PathBuf, String> {
    let expected = format!("{}.pdf", sanitize_ppt_render_base_name(input_name));
    let mut fallback = None;
    for entry in std::fs::read_dir(directory).map_err(|_| "ppt-render:render-failed".to_string())? {
        let entry = entry.map_err(|_| "ppt-render:render-failed".to_string())?;
        let path = entry.path();
        if path
            .extension()
            .and_then(|value| value.to_str())
            .map(|value| value.eq_ignore_ascii_case("pdf"))
            != Some(true)
        {
            continue;
        }
        let name = path
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or_default();
        if name.eq_ignore_ascii_case(&expected) {
            return Ok(path);
        }
        fallback.get_or_insert(path);
    }
    fallback.ok_or_else(|| "ppt-render:render-failed".to_string())
}

fn count_pdf_pages_rough(bytes: &[u8]) -> usize {
    let mut count = 0usize;
    let needle = b"/Type";
    let mut index = 0usize;
    while index + needle.len() <= bytes.len() {
        if &bytes[index..index + needle.len()] != needle {
            index += 1;
            continue;
        }
        let mut cursor = index + needle.len();
        while cursor < bytes.len() && matches!(bytes[cursor], b' ' | b'\t' | b'\r' | b'\n') {
            cursor += 1;
        }
        if cursor + 5 <= bytes.len()
            && &bytes[cursor..cursor + 5] == b"/Page"
            && bytes.get(cursor + 5).copied() != Some(b's')
        {
            count += 1;
        }
        index = cursor.saturating_add(5);
    }
    count
}

fn validate_ppt_rendered_pdf(
    path: &std::path::Path,
    expected_slides: usize,
) -> Result<(usize, u64, Vec<String>), String> {
    let metadata = std::fs::metadata(path).map_err(|_| "ppt-render:render-failed".to_string())?;
    if !metadata.is_file() || metadata.len() < 16 {
        return Err("ppt-render:render-failed".to_string());
    }
    let bytes = std::fs::read(path).map_err(|_| "ppt-render:render-failed".to_string())?;
    if !bytes.starts_with(b"%PDF-") {
        return Err("ppt-render:render-failed".to_string());
    }
    let mut warnings = Vec::new();
    let page_count = count_pdf_pages_rough(&bytes);
    let page_count = if page_count == 0 {
        warnings.push(
            "PDF page count could not be verified exactly; using PPT slide count.".to_string(),
        );
        expected_slides
    } else {
        page_count
    };
    if page_count != expected_slides {
        warnings.push(format!(
            "Rendered PDF page count ({}) differs from PPT slide count ({}).",
            page_count, expected_slides
        ));
    }
    Ok((page_count, metadata.len(), warnings))
}

async fn run_libreoffice_ppt_to_pdf(
    runtime: &LibreOfficeRuntimeInfo,
    input: &PptRenderInput,
    work_dir: &std::path::Path,
) -> Result<std::path::PathBuf, String> {
    let command = runtime
        .command
        .as_ref()
        .ok_or_else(|| "ppt-render:runtime-missing".to_string())?;
    let out_dir = work_dir.join("out");
    let profile_dir = toolknit_app_data_dir()?
        .join("libreoffice-profile")
        .join(LIBREOFFICE_RUNTIME_VERSION);
    std::fs::create_dir_all(&out_dir).map_err(|_| "ppt-render:output-path".to_string())?;
    std::fs::create_dir_all(&profile_dir).map_err(|_| "ppt-render:output-path".to_string())?;
    seed_libreoffice_printer_profile(&profile_dir);
    let user_installation = file_url_for_libreoffice(&profile_dir);
    let mut command_builder = tokio::process::Command::new(command);
    command_builder
        .arg("--headless")
        .arg("--invisible")
        .arg("--nologo")
        .arg("--nofirststartwizard")
        .arg("--nodefault")
        .arg("--nolockcheck")
        .arg("--norestore")
        .arg(format!("-env:UserInstallation={}", user_installation))
        .arg("--convert-to")
        .arg("pdf:impress_pdf_Export")
        .arg("--outdir")
        .arg(&out_dir)
        .arg(&input.path)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    // Force LibreOffice's non-GUI VCL backend and disable printer-list
    // enumeration. `SAL_DISABLE_PRINTERLIST` is the only supported LibreOffice
    // variable here; Impress can otherwise wait for an offline WSD printer.
    command_builder.env("SAL_USE_VCLPLUGIN", "svp");
    command_builder.env("SAL_DISABLE_PRINTERLIST", "1");
    #[cfg(target_os = "windows")]
    {
        command_builder.creation_flags(0x08000000);
    }
    let child = command_builder
        .spawn()
        .map_err(|_| "ppt-render:runtime-missing".to_string())?;
    let child_id = child.id().unwrap_or(0);
    CURRENT_CHILD_ID.store(child_id, Ordering::SeqCst);
    let output = match tokio::time::timeout(
        std::time::Duration::from_secs(PPT_RENDER_TIMEOUT_SECS),
        child.wait_with_output(),
    )
    .await
    {
        Ok(Ok(output)) => Ok(output),
        Ok(Err(_)) => Err("ppt-render:render-failed".to_string()),
        Err(_) => {
            terminate_conversion_process(child_id);
            CURRENT_CHILD_ID.store(0, Ordering::SeqCst);
            if CANCEL_FLAG.load(Ordering::SeqCst) {
                return Err("ppt-render:cancelled".to_string());
            }
            return Err("ppt-render:timeout".to_string());
        }
    };
    CURRENT_CHILD_ID.store(0, Ordering::SeqCst);
    if CANCEL_FLAG.load(Ordering::SeqCst) {
        return Err("ppt-render:cancelled".to_string());
    }
    let output = output?;
    if !output.status.success() {
        let stdout = String::from_utf8_lossy(&output.stdout);
        let stderr = String::from_utf8_lossy(&output.stderr);
        let detail = stderr
            .lines()
            .chain(stdout.lines())
            .map(str::trim)
            .find(|line| !line.is_empty())
            .unwrap_or("LibreOffice conversion failed.");
        return Err(format!("ppt-render:render-failed:{}", detail));
    }
    find_rendered_pdf(&out_dir, &input.name)
}

#[tauri::command]
async fn convert_ppt_to_pdf(
    input_path: String,
    output_dir: String,
    output_name: Option<String>,
) -> Result<PptToPdfResult, String> {
    let _conversion_guard = begin_conversion().map_err(|_| "ppt-render:busy".to_string())?;
    let input = inspect_ppt_render_input(&input_path)?;
    let runtime = resolve_libreoffice_runtime();
    if !runtime.available {
        return Err("ppt-render:runtime-missing".to_string());
    }
    let output_parent = ppt_render_output_parent(&output_dir)?;
    let base_name = sanitize_ppt_render_base_name(output_name.as_deref().unwrap_or(&input.name));
    let output_file = format!("{}.pdf", base_name);
    let final_dir = unique_ppt_render_output_dir(&output_parent, &base_name, "ppt_to_pdf")?;
    let temp_dir = create_ppt_render_temp_dir(&output_parent)?;
    let work_dir = temp_dir.join(".work");
    std::fs::create_dir_all(&work_dir).map_err(|_| "ppt-render:output-path".to_string())?;
    let result = async {
        let rendered = run_libreoffice_ppt_to_pdf(&runtime, &input, &work_dir).await?;
        let output_path = temp_dir.join(&output_file);
        std::fs::copy(&rendered, &output_path)
            .map_err(|_| "ppt-render:write-failed".to_string())?;
        let (page_count, output_bytes, mut warnings) =
            validate_ppt_rendered_pdf(&output_path, input.slide_count)?;
        let _ = std::fs::remove_dir_all(&work_dir);
        if runtime.source.as_deref() == Some("dev-runtime-cache") {
            warnings.push("Using local development LibreOffice runtime cache.".to_string());
        }
        let manifest_path = temp_dir.join("manifest.json");
        let manifest = serde_json::json!({
            "tool": "ppt.to-pdf",
            "sourceName": input.name.clone(),
            "inputPath": cleanup_display_path(&input.path),
            "inputBytes": input.bytes,
            "renderer": runtime.clone(),
            "slideCount": input.slide_count,
            "pageCount": page_count,
            "pageCountMatchesSlides": page_count == input.slide_count,
            "outputDir": cleanup_display_path(&final_dir),
            "outputPath": cleanup_display_path(&final_dir.join(&output_file)),
            "outputFile": output_file.clone(),
            "outputBytes": output_bytes,
            "warnings": warnings.clone()
        });
        std::fs::write(
            &manifest_path,
            serde_json::to_vec_pretty(&manifest)
                .map_err(|_| "ppt-render:write-failed".to_string())?,
        )
        .map_err(|_| "ppt-render:write-failed".to_string())?;
        std::fs::rename(&temp_dir, &final_dir)
            .map_err(|_| "ppt-render:publish-failed".to_string())?;
        let final_output_path = final_dir.join(&output_file);
        let final_manifest_path = final_dir.join("manifest.json");
        Ok(PptToPdfResult {
            tool: "ppt.to-pdf".to_string(),
            source_name: input.name,
            input_path: cleanup_display_path(&input.path),
            input_bytes: input.bytes,
            renderer: runtime,
            slide_count: input.slide_count,
            page_count,
            page_count_matches_slides: page_count == input.slide_count,
            output_dir: cleanup_display_path(&final_dir),
            output_path: cleanup_display_path(&final_output_path),
            output_file,
            output_bytes,
            manifest_path: cleanup_display_path(&final_manifest_path),
            warnings,
        })
    }
    .await;
    if result.is_err() {
        let _ = std::fs::remove_dir_all(&temp_dir);
    }
    result
}

const EXCEL_RENDER_MAX_FILES: usize = 20;
const EXCEL_RENDER_MAX_INPUT_BYTES: u64 = 200 * 1024 * 1024;
const EXCEL_WPS_METADATA_MAX_BYTES: u64 = 512 * 1024;
const EXCEL_RENDER_TIMEOUT_SECS: u64 = 180;
static EXCEL_RENDER_TEMP_ID: AtomicU64 = AtomicU64::new(0);

const EXCEL_TO_PDF_UNO_SCRIPT: &str = r#"import json
import os
import sys
import time
import uno
from com.sun.star.beans import PropertyValue


def prop(name, value):
    item = PropertyValue()
    item.Name = name
    item.Value = value
    return item


def input_filter(path):
    extension = os.path.splitext(path)[1].lower()
    filters = {
        ".xlsx": "Calc MS Excel 2007 XML",
        ".xls": "MS Excel 97",
        ".ods": "calc8",
    }
    return filters.get(extension)


def connect(pipe_name):
    local_context = uno.getComponentContext()
    resolver = local_context.ServiceManager.createInstanceWithContext(
        "com.sun.star.bridge.UnoUrlResolver", local_context
    )
    target = "uno:pipe,name=%s;urp;StarOffice.ComponentContext" % pipe_name
    last_error = None
    for _ in range(160):
        try:
            return resolver.resolve(target)
        except Exception as error:
            last_error = error
            time.sleep(0.1)
    raise RuntimeError("LibreOffice listener did not become ready: %s" % last_error)


def set_page_property(style, name, value):
    info = style.getPropertySetInfo()
    if not info.hasPropertyByName(name):
        raise RuntimeError("Calc page style does not expose %s" % name)
    style.setPropertyValue(name, value)


def apply_page_setup(document, options):
    sheets = document.getSheets()
    names = list(sheets.getElementNames())
    visible_before = 0
    for name in names:
        sheet = sheets.getByName(name)
        if bool(sheet.getPropertyValue("IsVisible")):
            visible_before += 1
        elif options["sheetRange"] == "all":
            sheet.setPropertyValue("IsVisible", True)

    page_styles = document.getStyleFamilies().getByName("PageStyles")
    configured_styles = set()
    for name in names:
        sheet = sheets.getByName(name)
        if not bool(sheet.getPropertyValue("IsVisible")):
            continue
        style_name = str(sheet.getPropertyValue("PageStyle"))
        if style_name in configured_styles:
            continue
        configured_styles.add(style_name)
        style = page_styles.getByName(style_name)

        current_width = int(style.getPropertyValue("Width"))
        current_height = int(style.getPropertyValue("Height"))
        current_landscape = bool(style.getPropertyValue("IsLandscape"))
        requested_orientation = options["orientation"]
        landscape = current_landscape if requested_orientation == "source" else requested_orientation == "landscape"
        paper = options["paper"]
        if paper == "a4":
            short_edge, long_edge = 21000, 29700
        elif paper == "letter":
            short_edge, long_edge = 21590, 27940
        else:
            short_edge, long_edge = min(current_width, current_height), max(current_width, current_height)
        set_page_property(style, "IsLandscape", landscape)
        set_page_property(style, "Width", long_edge if landscape else short_edge)
        set_page_property(style, "Height", short_edge if landscape else long_edge)

        if options["scale"] == "fit":
            set_page_property(style, "ScaleToPages", 0)
            set_page_property(style, "ScaleToPagesX", 1)
            set_page_property(style, "ScaleToPagesY", 0)
        else:
            set_page_property(style, "ScaleToPages", 0)
            set_page_property(style, "ScaleToPagesX", 0)
            set_page_property(style, "ScaleToPagesY", 0)
            set_page_property(style, "PageScale", 100)

    return {
        "sheetCount": len(names),
        "visibleSheetCount": visible_before,
        "exportedSheetCount": len(names) if options["sheetRange"] == "all" else visible_before,
    }


def main():
    pipe_name, input_path, output_path, options_json, metadata_path = sys.argv[1:6]
    options = json.loads(options_json)
    context = connect(pipe_name)
    service_manager = context.ServiceManager
    desktop = service_manager.createInstanceWithContext("com.sun.star.frame.Desktop", context)
    document = None
    try:
        load_properties = [
            prop("Hidden", True),
            prop("ReadOnly", False),
            prop("UpdateDocMode", 0),
            prop("MacroExecutionMode", 0),
        ]
        input_url = uno.systemPathToFileUrl(os.path.abspath(input_path))
        try:
            document = desktop.loadComponentFromURL(
                input_url, "_blank", 0, tuple(load_properties)
            )
        except Exception:
            filter_name = input_filter(input_path)
            if not filter_name:
                raise
            document = desktop.loadComponentFromURL(
                input_url,
                "_blank",
                0,
                tuple(load_properties + [prop("FilterName", filter_name)]),
            )
        if document is None or not document.supportsService("com.sun.star.sheet.SpreadsheetDocument"):
            implementation = "none" if document is None else str(document.getImplementationName())
            services = [] if document is None else list(document.getSupportedServiceNames())
            raise RuntimeError(
                "The selected file is not a spreadsheet document "
                "(implementation=%s, services=%s)" % (implementation, ",".join(services))
            )
        metadata = apply_page_setup(document, options)
        try:
            document.calculateAll()
        except Exception:
            pass
        export_properties = (
            prop("FilterName", "calc_pdf_Export"),
            prop("Overwrite", True),
        )
        document.storeToURL(
            uno.systemPathToFileUrl(os.path.abspath(output_path)), export_properties
        )
        metadata["outputPath"] = os.path.abspath(output_path)
        with open(metadata_path, "w", encoding="utf-8") as handle:
            json.dump(metadata, handle, ensure_ascii=True)
    finally:
        if document is not None:
            try:
                document.close(True)
            except Exception:
                try:
                    document.dispose()
                except Exception:
                    pass
        try:
            desktop.terminate()
        except Exception:
            pass


if __name__ == "__main__":
    main()
"#;

#[derive(Clone, Debug)]
struct ExcelRenderInput {
    path: std::path::PathBuf,
    name: String,
    bytes: u64,
}

#[derive(Clone, Debug, serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct ExcelToPdfOptions {
    sheet_range: String,
    orientation: String,
    paper: String,
    scale: String,
}

#[derive(Clone, Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct ExcelUnoMetadata {
    sheet_count: usize,
    visible_sheet_count: usize,
    exported_sheet_count: usize,
}

#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct ExcelToPdfFileResult {
    source_name: String,
    input_path: String,
    input_bytes: u64,
    output_path: String,
    output_file: String,
    output_bytes: u64,
    page_count: usize,
    sheet_count: usize,
    visible_sheet_count: usize,
    exported_sheet_count: usize,
    warnings: Vec<String>,
}

#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct ExcelToPdfBatchResult {
    tool: String,
    success_count: usize,
    fail_count: usize,
    output_dir: String,
    outputs: Vec<ExcelToPdfFileResult>,
    errors: Vec<String>,
    warnings: Vec<String>,
    renderer: LibreOfficeRuntimeInfo,
    manifest_path: String,
}

#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct ExcelToPdfProgress {
    file_name: String,
    current: usize,
    total: usize,
    percent: u8,
    phase: String,
}

fn normalize_excel_to_pdf_options(
    mut options: ExcelToPdfOptions,
) -> Result<ExcelToPdfOptions, String> {
    options.sheet_range = options.sheet_range.trim().to_ascii_lowercase();
    options.orientation = options.orientation.trim().to_ascii_lowercase();
    options.paper = options.paper.trim().to_ascii_lowercase();
    options.scale = options.scale.trim().to_ascii_lowercase();
    if !matches!(options.sheet_range.as_str(), "all" | "visible")
        || !matches!(
            options.orientation.as_str(),
            "source" | "portrait" | "landscape"
        )
        || !matches!(options.paper.as_str(), "auto" | "a4" | "letter")
        || !matches!(options.scale.as_str(), "fit" | "original")
    {
        return Err("excel-render:invalid-options".to_string());
    }
    Ok(options)
}

fn inspect_excel_render_input(input_path: &str) -> Result<ExcelRenderInput, String> {
    if input_path.trim().is_empty() || input_path.contains('\0') {
        return Err("excel-render:invalid-input".to_string());
    }
    let requested = std::path::PathBuf::from(input_path);
    let extension = requested
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    if !matches!(extension.as_str(), "xlsx" | "xls" | "ods") {
        return Err("excel-render:invalid-extension".to_string());
    }
    let metadata = std::fs::symlink_metadata(&requested)
        .map_err(|_| "excel-render:input-not-found".to_string())?;
    if metadata.file_type().is_symlink() || !metadata.is_file() || metadata.len() == 0 {
        return Err("excel-render:invalid-input".to_string());
    }
    if metadata.len() > EXCEL_RENDER_MAX_INPUT_BYTES {
        return Err("excel-render:input-too-large".to_string());
    }
    let path = requested
        .canonicalize()
        .map_err(|_| "excel-render:invalid-input".to_string())?;
    let mut signature = [0_u8; 8];
    let mut file = std::fs::File::open(&path)
        .map_err(|_| "excel-render:read-failed".to_string())?;
    use std::io::Read as _;
    let read = file
        .read(&mut signature)
        .map_err(|_| "excel-render:read-failed".to_string())?;
    let valid = if extension == "xls" {
        read >= 8 && signature == [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]
    } else {
        read >= 4 && signature[..4] == [0x50, 0x4b, 0x03, 0x04]
    };
    if !valid {
        return Err("excel-render:invalid-workbook".to_string());
    }
    let name = path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("workbook.xlsx")
        .to_string();
    Ok(ExcelRenderInput {
        path,
        name,
        bytes: metadata.len(),
    })
}

fn is_wps_generated_xlsx(path: &std::path::Path) -> bool {
    if !path
        .extension()
        .and_then(|value| value.to_str())
        .is_some_and(|extension| extension.eq_ignore_ascii_case("xlsx"))
    {
        return false;
    }
    let Ok(file) = std::fs::File::open(path) else {
        return false;
    };
    let Ok(mut archive) = zip::ZipArchive::new(file) else {
        return false;
    };
    for entry_name in ["docProps/app.xml", "docProps/custom.xml", "xl/workbook.xml"] {
        let Ok(entry) = archive.by_name(entry_name) else {
            continue;
        };
        if entry.size() > EXCEL_WPS_METADATA_MAX_BYTES {
            continue;
        }
        let mut metadata = Vec::with_capacity(entry.size() as usize);
        use std::io::Read as _;
        if entry
            .take(EXCEL_WPS_METADATA_MAX_BYTES + 1)
            .read_to_end(&mut metadata)
            .is_err()
            || metadata.len() as u64 > EXCEL_WPS_METADATA_MAX_BYTES
        {
            continue;
        }
        let metadata = String::from_utf8_lossy(&metadata).to_ascii_lowercase();
        if metadata.contains("wps office")
            || metadata.contains("ksoproductbuildver")
            || metadata.contains("web.wps.cn")
        {
            return true;
        }
    }
    false
}

fn libreoffice_python_path(runtime: &LibreOfficeRuntimeInfo) -> Result<std::path::PathBuf, String> {
    let command = runtime
        .command
        .as_deref()
        .map(std::path::PathBuf::from)
        .ok_or_else(|| "excel-render:runtime-missing".to_string())?;
    let directory = command
        .parent()
        .ok_or_else(|| "excel-render:python-missing".to_string())?;
    let names: &[&str] = if cfg!(target_os = "windows") {
        &["python.exe"]
    } else {
        &["python", "python3"]
    };
    names
        .iter()
        .map(|name| directory.join(name))
        .find(|path| std::fs::metadata(path).map(|meta| meta.is_file()).unwrap_or(false))
        .ok_or_else(|| "excel-render:python-missing".to_string())
}

fn unique_excel_render_output_dir(
    parent: &std::path::Path,
    inputs: &[ExcelRenderInput],
) -> Result<std::path::PathBuf, String> {
    let label = if inputs.len() == 1 {
        sanitize_ppt_render_base_name(&inputs[0].name)
    } else {
        "excel_batch".to_string()
    };
    for counter in 0..10_000_u32 {
        let suffix = if counter == 0 {
            String::new()
        } else {
            format!("_{}", counter)
        };
        let candidate = parent.join(format!("{}_to_pdf{}", label, suffix));
        match std::fs::symlink_metadata(&candidate) {
            Ok(_) => continue,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(candidate),
            Err(_) => return Err("excel-render:output-path".to_string()),
        }
    }
    Err("excel-render:output-path".to_string())
}

fn create_excel_render_temp_dir(parent: &std::path::Path) -> Result<std::path::PathBuf, String> {
    for _ in 0..10_000 {
        let counter = EXCEL_RENDER_TEMP_ID.fetch_add(1, Ordering::SeqCst);
        let candidate = parent.join(format!(
            ".toolknit-excel-render-{}-{}",
            std::process::id(),
            counter
        ));
        match std::fs::create_dir(&candidate) {
            Ok(()) => return Ok(candidate),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(_) => return Err("excel-render:output-path".to_string()),
        }
    }
    Err("excel-render:output-path".to_string())
}

fn unique_excel_output_file(
    directory: &std::path::Path,
    input_name: &str,
    used_names: &mut std::collections::BTreeSet<String>,
) -> Result<(String, std::path::PathBuf), String> {
    let base = sanitize_ppt_render_base_name(input_name);
    for counter in 0..10_000_u32 {
        let suffix = if counter == 0 {
            String::new()
        } else {
            format!("_{}", counter)
        };
        let file_name = format!("{}{}.pdf", base, suffix);
        if used_names.insert(file_name.to_ascii_lowercase()) {
            return Ok((file_name.clone(), directory.join(file_name)));
        }
    }
    Err("excel-render:output-path".to_string())
}

fn excel_render_error_detail(stdout: &[u8], stderr: &[u8]) -> String {
    let stderr = String::from_utf8_lossy(stderr);
    let stdout = String::from_utf8_lossy(stdout);
    stderr
        .lines()
        .rev()
        .chain(stdout.lines().rev())
        .map(str::trim)
        .find(|line| !line.is_empty())
        .unwrap_or("LibreOffice Calc export failed.")
        .to_string()
}

async fn normalize_excel_input_with_libreoffice(
    runtime: &LibreOfficeRuntimeInfo,
    input: &ExcelRenderInput,
    work_dir: &std::path::Path,
) -> Result<std::path::PathBuf, String> {
    let soffice = runtime
        .command
        .as_deref()
        .ok_or_else(|| "excel-render:runtime-missing".to_string())?;
    let normalize_dir = work_dir.join("compatibility-import");
    let output_dir = normalize_dir.join("output");
    let profile_dir = normalize_dir.join("profile");
    std::fs::create_dir_all(&output_dir)
        .map_err(|_| "excel-render:output-path".to_string())?;
    std::fs::create_dir_all(&profile_dir)
        .map_err(|_| "excel-render:output-path".to_string())?;
    seed_libreoffice_printer_profile(&profile_dir);
    let extension = input
        .path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("xlsx")
        .to_ascii_lowercase();
    let staged_input = normalize_dir.join(format!("input.{}", extension));
    std::fs::copy(&input.path, &staged_input)
        .map_err(|_| "excel-render:read-failed".to_string())?;

    let mut command = tokio::process::Command::new(soffice);
    command
        .arg(format!(
            "-env:UserInstallation={}",
            file_url_for_libreoffice(&profile_dir)
        ))
        .arg("--headless")
        .arg("--invisible")
        .arg("--nologo")
        .arg("--nofirststartwizard")
        .arg("--nodefault")
        .arg("--nolockcheck")
        .arg("--norestore")
        .arg("--convert-to")
        .arg("ods")
        .arg("--outdir")
        .arg(&output_dir)
        .arg(&staged_input)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .env("SAL_USE_VCLPLUGIN", "svp")
        .env("SAL_DISABLE_PRINTERLIST", "1");
    #[cfg(target_os = "windows")]
    {
        command.creation_flags(0x08000000);
    }
    let child = command
        .spawn()
        .map_err(|_| "excel-render:runtime-missing".to_string())?;
    let child_id = child.id().unwrap_or(0);
    active_office_children()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .insert(child_id);
    CURRENT_CHILD_ID.store(child_id, Ordering::SeqCst);
    let command_output = tokio::time::timeout(
        std::time::Duration::from_secs(EXCEL_RENDER_TIMEOUT_SECS),
        child.wait_with_output(),
    )
    .await;
    CURRENT_CHILD_ID.store(0, Ordering::SeqCst);
    active_office_children()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .remove(&child_id);
    if CANCEL_FLAG.load(Ordering::SeqCst) {
        terminate_conversion_process(child_id);
        return Err("excel-render:cancelled".to_string());
    }
    let output = match command_output {
        Ok(Ok(output)) => output,
        Ok(Err(_)) => return Err("excel-render:render-failed".to_string()),
        Err(_) => {
            terminate_conversion_process(child_id);
            return Err("excel-render:timeout".to_string());
        }
    };
    if !output.status.success() {
        return Err(format!(
            "excel-render:render-failed:{}",
            excel_render_error_detail(&output.stdout, &output.stderr)
        ));
    }
    let normalized = output_dir.join("input.ods");
    let metadata = std::fs::metadata(&normalized)
        .map_err(|_| "excel-render:render-failed".to_string())?;
    if !metadata.is_file() || metadata.len() < 16 {
        return Err("excel-render:render-failed".to_string());
    }
    Ok(normalized)
}

async fn run_libreoffice_excel_to_pdf(
    runtime: &LibreOfficeRuntimeInfo,
    input: &ExcelRenderInput,
    output_path: &std::path::Path,
    options: &ExcelToPdfOptions,
    work_dir: &std::path::Path,
) -> Result<ExcelUnoMetadata, String> {
    let soffice = runtime
        .command
        .as_deref()
        .ok_or_else(|| "excel-render:runtime-missing".to_string())?;
    let python = libreoffice_python_path(runtime)?;
    let profile_dir = work_dir.join("profile");
    std::fs::create_dir_all(&profile_dir)
        .map_err(|_| "excel-render:output-path".to_string())?;
    // LibreOffice's remote UNO loader can fail type detection for otherwise
    // valid WPS/Excel workbooks when the source URL contains non-ASCII path
    // segments. Stage the input under a stable ASCII name for the renderer;
    // the published PDF still keeps the original workbook name.
    let input_extension = input
        .path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("xlsx")
        .to_ascii_lowercase();
    let staged_input = work_dir.join(format!("input.{}", input_extension));
    std::fs::copy(&input.path, &staged_input)
        .map_err(|_| "excel-render:read-failed".to_string())?;
    seed_libreoffice_printer_profile(&profile_dir);
    let script_path = work_dir.join("excel-to-pdf.py");
    let metadata_path = work_dir.join("metadata.json");
    std::fs::write(&script_path, EXCEL_TO_PDF_UNO_SCRIPT.as_bytes())
        .map_err(|_| "excel-render:write-failed".to_string())?;
    let pipe_name = format!(
        "toolknit_excel_{}_{}",
        std::process::id(),
        EXCEL_RENDER_TEMP_ID.fetch_add(1, Ordering::SeqCst)
    );
    let user_installation = file_url_for_libreoffice(&profile_dir);
    let mut office_command = tokio::process::Command::new(soffice);
    office_command
        .arg("--headless")
        .arg("--invisible")
        .arg("--nologo")
        .arg("--nofirststartwizard")
        .arg("--nodefault")
        .arg("--nolockcheck")
        .arg("--norestore")
        .arg(format!("-env:UserInstallation={}", user_installation))
        .arg(format!(
            "--accept=pipe,name={};urp;StarOffice.ComponentContext",
            pipe_name
        ))
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .env("SAL_USE_VCLPLUGIN", "svp")
        .env("SAL_DISABLE_PRINTERLIST", "1");
    #[cfg(target_os = "windows")]
    {
        office_command.creation_flags(0x08000000);
    }
    let mut office = office_command
        .spawn()
        .map_err(|_| "excel-render:runtime-missing".to_string())?;
    let office_id = office.id().unwrap_or(0);
    active_office_children()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .insert(office_id);

    let options_json = serde_json::to_string(options)
        .map_err(|_| "excel-render:invalid-options".to_string())?;
    let mut python_command = tokio::process::Command::new(&python);
    python_command
        .arg(&script_path)
        .arg(&pipe_name)
        .arg(&staged_input)
        .arg(output_path)
        .arg(options_json)
        .arg(&metadata_path)
        .current_dir(python.parent().unwrap_or_else(|| std::path::Path::new(".")))
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    #[cfg(target_os = "windows")]
    {
        python_command.creation_flags(0x08000000);
    }
    let python_child = match python_command.spawn() {
        Ok(child) => child,
        Err(_) => {
            terminate_conversion_process(office_id);
            let _ = office.wait().await;
            active_office_children()
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .remove(&office_id);
            return Err("excel-render:python-missing".to_string());
        }
    };
    let python_id = python_child.id().unwrap_or(0);
    active_office_children()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .insert(python_id);
    CURRENT_CHILD_ID.store(python_id, Ordering::SeqCst);
    let python_output = tokio::time::timeout(
        std::time::Duration::from_secs(EXCEL_RENDER_TIMEOUT_SECS),
        python_child.wait_with_output(),
    )
    .await;
    CURRENT_CHILD_ID.store(0, Ordering::SeqCst);
    active_office_children()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .remove(&python_id);
    if CANCEL_FLAG.load(Ordering::SeqCst) || !matches!(&python_output, Ok(Ok(_))) {
        terminate_conversion_process(python_id);
    }
    if tokio::time::timeout(std::time::Duration::from_secs(2), office.wait())
        .await
        .is_err()
    {
        terminate_conversion_process(office_id);
        let _ = tokio::time::timeout(std::time::Duration::from_secs(3), office.wait()).await;
    }
    active_office_children()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .remove(&office_id);

    if CANCEL_FLAG.load(Ordering::SeqCst) {
        terminate_conversion_process(python_id);
        return Err("excel-render:cancelled".to_string());
    }
    let output = match python_output {
        Ok(Ok(output)) => output,
        Ok(Err(_)) => return Err("excel-render:render-failed".to_string()),
        Err(_) => {
            terminate_conversion_process(python_id);
            return Err("excel-render:timeout".to_string());
        }
    };
    if !output.status.success() {
        return Err(format!(
            "excel-render:render-failed:{}",
            excel_render_error_detail(&output.stdout, &output.stderr)
        ));
    }
    let metadata_bytes = std::fs::read(&metadata_path)
        .map_err(|_| "excel-render:render-failed".to_string())?;
    serde_json::from_slice(&metadata_bytes)
        .map_err(|_| "excel-render:render-failed".to_string())
}

async fn run_compatible_excel_to_pdf(
    runtime: &LibreOfficeRuntimeInfo,
    input: &ExcelRenderInput,
    output_path: &std::path::Path,
    options: &ExcelToPdfOptions,
    work_dir: &std::path::Path,
) -> Result<ExcelUnoMetadata, String> {
    let normalized_path = normalize_excel_input_with_libreoffice(runtime, input, work_dir).await?;
    let normalized_input = ExcelRenderInput {
        path: normalized_path,
        name: input.name.clone(),
        bytes: input.bytes,
    };
    let retry_work_dir = work_dir.join("normalized-render");
    std::fs::create_dir_all(&retry_work_dir)
        .map_err(|_| "excel-render:output-path".to_string())?;
    run_libreoffice_excel_to_pdf(
        runtime,
        &normalized_input,
        output_path,
        options,
        &retry_work_dir,
    )
    .await
}

async fn convert_excel_to_pdf_core<F>(
    input_paths: Vec<String>,
    output_dir: String,
    options: ExcelToPdfOptions,
    mut progress: F,
) -> Result<ExcelToPdfBatchResult, String>
where
    F: FnMut(ExcelToPdfProgress),
{
    if input_paths.is_empty() || input_paths.len() > EXCEL_RENDER_MAX_FILES {
        return Err("excel-render:invalid-file-count".to_string());
    }
    let options = normalize_excel_to_pdf_options(options)?;
    let inputs = input_paths
        .iter()
        .map(|path| inspect_excel_render_input(path))
        .collect::<Result<Vec<_>, _>>()?;
    let runtime = resolve_libreoffice_runtime();
    if !runtime.available {
        return Err("excel-render:runtime-missing".to_string());
    }
    let output_parent = validate_image_output_dir(&output_dir)
        .map_err(|_| "excel-render:output-path".to_string())?;
    let final_dir = unique_excel_render_output_dir(&output_parent, &inputs)?;
    let temp_dir = create_excel_render_temp_dir(&output_parent)?;
    let total = inputs.len();
    let mut outputs = Vec::new();
    let mut errors = Vec::new();
    let mut batch_warnings = Vec::new();
    let mut used_names = std::collections::BTreeSet::new();

    for (index, input) in inputs.iter().enumerate() {
        if CANCEL_FLAG.load(Ordering::SeqCst) {
            let _ = std::fs::remove_dir_all(&temp_dir);
            return Err("excel-render:cancelled".to_string());
        }
        progress(ExcelToPdfProgress {
            file_name: input.name.clone(),
            current: index + 1,
            total,
            percent: ((index * 100) / total).min(95) as u8,
            phase: "preparing".to_string(),
        });
        let (output_file, temporary_output_path) =
            unique_excel_output_file(&temp_dir, &input.name, &mut used_names)?;
        // Keep LibreOffice's profile outside the publish directory. Windows
        // may retain short-lived handles to profile files after soffice exits,
        // which must not prevent the completed PDFs from being published.
        let work_dir = create_excel_render_temp_dir(&output_parent)?;
        progress(ExcelToPdfProgress {
            file_name: input.name.clone(),
            current: index + 1,
            total,
            percent: (((index * 100) + 18) / total).min(96) as u8,
            phase: "converting".to_string(),
        });
        let mut used_compatibility_import = is_wps_generated_xlsx(&input.path);
        let direct_result = if used_compatibility_import {
            run_compatible_excel_to_pdf(
                &runtime,
                input,
                &temporary_output_path,
                &options,
                &work_dir,
            )
            .await
        } else {
            run_libreoffice_excel_to_pdf(
                &runtime,
                input,
                &temporary_output_path,
                &options,
                &work_dir,
            )
            .await
        };
        let render_result = match direct_result {
            Err(error)
                if !used_compatibility_import
                    && error.starts_with("excel-render:render-failed")
                    && input
                        .path
                        .extension()
                        .and_then(|value| value.to_str())
                        .is_some_and(|extension| !extension.eq_ignore_ascii_case("ods")) =>
            {
                used_compatibility_import = true;
                match run_compatible_excel_to_pdf(
                    &runtime,
                    input,
                    &temporary_output_path,
                    &options,
                    &work_dir,
                )
                .await
                {
                    Ok(metadata) => Ok(metadata),
                    Err(normalize_error) => Err(format!("{} | {}", error, normalize_error)),
                }
            }
            result => result,
        };
        match render_result {
            Ok(metadata) => {
                let output_metadata = std::fs::metadata(&temporary_output_path)
                    .map_err(|_| "excel-render:render-failed".to_string())?;
                let bytes = std::fs::read(&temporary_output_path)
                    .map_err(|_| "excel-render:render-failed".to_string())?;
                if !output_metadata.is_file()
                    || output_metadata.len() < 16
                    || !bytes.starts_with(b"%PDF-")
                {
                    errors.push(format!("{}: excel-render:render-failed", input.name));
                    let _ = std::fs::remove_file(&temporary_output_path);
                } else {
                    let page_count = count_pdf_pages_rough(&bytes);
                    let mut warnings = Vec::new();
                    if used_compatibility_import {
                        warnings.push(
                            "Workbook was normalized through LibreOffice compatibility import before rendering."
                                .to_string(),
                        );
                    }
                    if page_count == 0 {
                        warnings.push("PDF page count could not be verified exactly.".to_string());
                    }
                    outputs.push(ExcelToPdfFileResult {
                        source_name: input.name.clone(),
                        input_path: cleanup_display_path(&input.path),
                        input_bytes: input.bytes,
                        output_path: cleanup_display_path(&final_dir.join(&output_file)),
                        output_file,
                        output_bytes: output_metadata.len(),
                        page_count,
                        sheet_count: metadata.sheet_count,
                        visible_sheet_count: metadata.visible_sheet_count,
                        exported_sheet_count: metadata.exported_sheet_count,
                        warnings,
                    });
                }
            }
            Err(error) if error == "excel-render:cancelled" => {
                let _ = std::fs::remove_dir_all(&work_dir);
                let _ = std::fs::remove_dir_all(&temp_dir);
                return Err(error);
            }
            Err(error) => errors.push(format!("{}: {}", input.name, error)),
        }
        let _ = std::fs::remove_dir_all(&work_dir);
        progress(ExcelToPdfProgress {
            file_name: input.name.clone(),
            current: index + 1,
            total,
            percent: (((index + 1) * 100) / total).min(99) as u8,
            phase: "publishing".to_string(),
        });
    }

    if outputs.is_empty() {
        let _ = std::fs::remove_dir_all(&temp_dir);
        return Err(format!(
            "excel-render:all-failed:{}",
            errors.join(" | ")
        ));
    }
    if runtime.source.as_deref() == Some("dev-runtime-cache") {
        batch_warnings.push("Using local development LibreOffice runtime cache.".to_string());
    }
    let manifest_path = temp_dir.join("manifest.json");
    let manifest = serde_json::json!({
        "tool": "excel.to-pdf",
        "options": &options,
        "renderer": &runtime,
        "successCount": outputs.len(),
        "failCount": errors.len(),
        "outputDir": cleanup_display_path(&final_dir),
        "outputs": &outputs,
        "errors": &errors,
        "warnings": &batch_warnings,
    });
    std::fs::write(
        &manifest_path,
        serde_json::to_vec_pretty(&manifest)
            .map_err(|_| "excel-render:write-failed".to_string())?,
    )
    .map_err(|_| "excel-render:write-failed".to_string())?;
    std::fs::rename(&temp_dir, &final_dir)
        .map_err(|error| format!("excel-render:publish-failed:{}", error))?;
    progress(ExcelToPdfProgress {
        file_name: String::new(),
        current: total,
        total,
        percent: 100,
        phase: "complete".to_string(),
    });
    Ok(ExcelToPdfBatchResult {
        tool: "excel.to-pdf".to_string(),
        success_count: outputs.len(),
        fail_count: errors.len(),
        output_dir: cleanup_display_path(&final_dir),
        outputs,
        errors,
        warnings: batch_warnings,
        renderer: runtime,
        manifest_path: cleanup_display_path(&final_dir.join("manifest.json")),
    })
}

#[tauri::command]
async fn convert_excel_to_pdf(
    app_handle: tauri::AppHandle,
    input_paths: Vec<String>,
    output_dir: String,
    options: ExcelToPdfOptions,
) -> Result<ExcelToPdfBatchResult, String> {
    use tauri::Emitter;
    let _conversion_guard = begin_conversion().map_err(|_| "excel-render:busy".to_string())?;
    convert_excel_to_pdf_core(input_paths, output_dir, options, |event| {
        let _ = app_handle.emit("excel-to-pdf-progress", event);
    })
    .await
}

#[cfg(test)]
mod excel_to_pdf_tests {
    use super::*;

    fn default_options() -> ExcelToPdfOptions {
        ExcelToPdfOptions {
            sheet_range: "all".to_string(),
            orientation: "source".to_string(),
            paper: "auto".to_string(),
            scale: "fit".to_string(),
        }
    }

    #[test]
    fn excel_options_reject_unknown_values() {
        let mut options = default_options();
        options.paper = "legal".to_string();
        assert_eq!(
            normalize_excel_to_pdf_options(options).unwrap_err(),
            "excel-render:invalid-options"
        );
    }

    #[test]
    fn excel_input_rejects_fake_workbooks() {
        let directory = std::env::temp_dir().join(format!(
            "toolknit-excel-validation-{}-{}",
            std::process::id(),
            EXCEL_RENDER_TEMP_ID.fetch_add(1, Ordering::SeqCst)
        ));
        std::fs::create_dir_all(&directory).unwrap();
        let path = directory.join("fake.xlsx");
        std::fs::write(&path, b"not an xlsx").unwrap();
        assert_eq!(
            inspect_excel_render_input(path.to_str().unwrap()).unwrap_err(),
            "excel-render:invalid-workbook"
        );
        let _ = std::fs::remove_dir_all(directory);
    }

    #[test]
    fn excel_render_error_reports_the_traceback_cause() {
        let stderr = b"Traceback (most recent call last):\n  File \"excel-to-pdf.py\", line 1\nRuntimeError: type detection failed\n";
        assert_eq!(
            excel_render_error_detail(b"", stderr),
            "RuntimeError: type detection failed"
        );
    }

    fn write_xlsx_metadata_fixture(path: &std::path::Path, metadata: &str) {
        use std::io::Write as _;
        let file = std::fs::File::create(path).unwrap();
        let mut archive = zip::ZipWriter::new(file);
        archive
            .start_file(
                "docProps/app.xml",
                zip::write::SimpleFileOptions::default()
                    .compression_method(zip::CompressionMethod::Deflated),
            )
            .unwrap();
        archive.write_all(metadata.as_bytes()).unwrap();
        archive.finish().unwrap();
    }

    #[test]
    fn excel_detects_wps_metadata_for_fast_compatibility_import() {
        let directory = std::env::temp_dir().join(format!(
            "toolknit-excel-wps-detection-{}-{}",
            std::process::id(),
            EXCEL_RENDER_TEMP_ID.fetch_add(1, Ordering::SeqCst)
        ));
        std::fs::create_dir_all(&directory).unwrap();
        let wps_path = directory.join("wps.xlsx");
        let excel_path = directory.join("excel.xlsx");
        write_xlsx_metadata_fixture(&wps_path, "<Application>WPS Office</Application>");
        write_xlsx_metadata_fixture(&excel_path, "<Application>Microsoft Excel</Application>");
        assert!(is_wps_generated_xlsx(&wps_path));
        assert!(!is_wps_generated_xlsx(&excel_path));
        let _ = std::fs::remove_dir_all(directory);
    }

    #[tokio::test]
    #[ignore = "requires LibreOffice and TOOLKNIT_EXCEL_QA_FILE"]
    async fn excel_real_runtime_qa() {
        let input = std::env::var("TOOLKNIT_EXCEL_QA_FILE").unwrap();
        let retained_output = std::env::var_os("TOOLKNIT_EXCEL_QA_OUTPUT_DIR")
            .map(std::path::PathBuf::from);
        let output = retained_output.clone().unwrap_or_else(|| {
            std::env::temp_dir().join(format!(
                "toolknit-excel-runtime-qa-{}",
                EXCEL_RENDER_TEMP_ID.fetch_add(1, Ordering::SeqCst)
            ))
        });
        std::fs::create_dir_all(&output).unwrap();
        let _guard = begin_conversion().unwrap();
        let all_sheets = convert_excel_to_pdf_core(
            vec![input.clone()],
            output.to_string_lossy().into_owned(),
            default_options(),
            |_| {},
        )
        .await
        .unwrap();
        assert_eq!(all_sheets.success_count, 1);
        assert_eq!(all_sheets.fail_count, 0);
        let all_pdf = std::path::Path::new(&all_sheets.outputs[0].output_path);
        assert!(all_pdf.is_file());
        assert!(all_sheets.outputs[0].output_bytes > 0);
        assert!(std::fs::read(all_pdf).unwrap().starts_with(b"%PDF-"));
        assert!(all_sheets.outputs[0].page_count > 0);
        assert_eq!(
            all_sheets.outputs[0].exported_sheet_count,
            all_sheets.outputs[0].sheet_count
        );
        assert!(std::path::Path::new(&all_sheets.manifest_path).is_file());

        let visible_options = ExcelToPdfOptions {
            sheet_range: "visible".to_string(),
            orientation: "landscape".to_string(),
            paper: "letter".to_string(),
            scale: "original".to_string(),
        };
        let visible_sheets = convert_excel_to_pdf_core(
            vec![input],
            output.to_string_lossy().into_owned(),
            visible_options,
            |_| {},
        )
        .await
        .unwrap();
        assert_eq!(visible_sheets.success_count, 1);
        assert_eq!(visible_sheets.fail_count, 0);
        let visible_pdf = std::path::Path::new(&visible_sheets.outputs[0].output_path);
        assert!(visible_pdf.is_file());
        assert!(std::fs::read(visible_pdf).unwrap().starts_with(b"%PDF-"));
        assert!(visible_sheets.outputs[0].page_count > 0);
        assert_eq!(
            visible_sheets.outputs[0].exported_sheet_count,
            visible_sheets.outputs[0].visible_sheet_count
        );
        assert!(std::path::Path::new(&visible_sheets.manifest_path).is_file());
        assert!(
            all_sheets.outputs[0].exported_sheet_count
                >= visible_sheets.outputs[0].exported_sheet_count
        );
        println!("all-sheets PDF: {}", all_sheets.outputs[0].output_path);
        println!("visible-sheets PDF: {}", visible_sheets.outputs[0].output_path);

        if retained_output.is_none() {
            let _ = std::fs::remove_dir_all(output);
        }
    }
}

#[cfg(test)]
mod image_crop_tests {
    use super::*;
    use image::{GenericImageView, ImageEncoder};

    fn crop_test_directory(label: &str) -> std::path::PathBuf {
        let directory = std::env::temp_dir().join(format!(
            "toolknit-crop-{}-{}-{}",
            label,
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&directory).unwrap();
        directory
    }

    fn crop_options(
        input: &std::path::Path,
        output: &std::path::Path,
        format: &str,
    ) -> ImageCropOptions {
        ImageCropOptions {
            input_path: input.to_string_lossy().into_owned(),
            output_dir: output.to_string_lossy().into_owned(),
            output_name: Some(format!("crop-{format}")),
            crop_x: 0,
            crop_y: 0,
            crop_width: 2,
            crop_height: 2,
            rotation: 0,
            flip_horizontal: false,
            flip_vertical: false,
            format: format.to_string(),
            jpeg_quality: 96,
            background_rgba: "#FFFFFFFF".to_string(),
        }
    }

    fn write_crop_exif_jpeg(path: &std::path::Path, image: &image::RgbImage, orientation: u16) {
        let mut exif = vec![0_u8; 26];
        exif[0..2].copy_from_slice(b"II");
        exif[2..4].copy_from_slice(&42_u16.to_le_bytes());
        exif[4..8].copy_from_slice(&8_u32.to_le_bytes());
        exif[8..10].copy_from_slice(&1_u16.to_le_bytes());
        exif[10..12].copy_from_slice(&0x0112_u16.to_le_bytes());
        exif[12..14].copy_from_slice(&3_u16.to_le_bytes());
        exif[14..18].copy_from_slice(&1_u32.to_le_bytes());
        exif[18..20].copy_from_slice(&orientation.to_le_bytes());
        let file = std::fs::File::create(path).unwrap();
        let mut encoder = image::codecs::jpeg::JpegEncoder::new_with_quality(file, 100);
        encoder.set_exif_metadata(exif).unwrap();
        encoder
            .encode(
                image.as_raw(),
                image.width(),
                image.height(),
                image::ExtendedColorType::Rgb8,
            )
            .unwrap();
    }

    #[test]
    fn crop_rejects_out_of_bounds_rectangles() {
        let mut options = crop_options(
            std::path::Path::new("unused.png"),
            std::path::Path::new("unused"),
            "png",
        );
        options.crop_x = 9;
        options.crop_width = 2;
        assert_eq!(
            validate_image_crop_bounds(&options, 10, 10),
            Err("image-crop:crop-out-of-bounds".to_string())
        );
        options.crop_width = 0;
        assert_eq!(
            validate_image_crop_bounds(&options, 10, 10),
            Err("image-crop:invalid-crop".to_string())
        );
    }

    #[test]
    fn crop_transform_order_is_rotate_then_flip_then_crop() {
        let source = image::RgbaImage::from_fn(2, 3, |x, y| {
            let colors = [
                [[255, 0, 0, 255], [0, 255, 0, 255]],
                [[0, 0, 255, 255], [255, 255, 0, 255]],
                [[255, 0, 255, 255], [0, 255, 255, 255]],
            ];
            image::Rgba(colors[y as usize][x as usize])
        });
        let transformed =
            transform_image_for_crop(image::DynamicImage::ImageRgba8(source), 90, true, false)
                .unwrap();
        assert_eq!(transformed.dimensions(), (3, 2));
        assert_eq!(transformed.get_pixel(0, 0), image::Rgba([255, 0, 0, 255]));
        assert_eq!(transformed.get_pixel(0, 1), image::Rgba([0, 255, 0, 255]));
    }

    #[test]
    fn crop_exports_all_formats_and_never_overwrites() {
        let directory = crop_test_directory("formats");
        let input = directory.join("source.png");
        image::RgbaImage::from_fn(4, 4, |x, y| {
            image::Rgba([
                (x * 50) as u8,
                (y * 50) as u8,
                120,
                if x == 0 { 0 } else { 255 },
            ])
        })
        .save(&input)
        .unwrap();

        for format in ["png", "jpg", "webp", "bmp"] {
            let options = crop_options(&input, &directory, format);
            let first = crop_image_blocking(options.clone()).unwrap();
            let second = crop_image_blocking(options).unwrap();
            assert_ne!(first.output_path, second.output_path);
            assert_eq!(
                image::open(&first.output_path).unwrap().dimensions(),
                (2, 2)
            );
            assert!(first.bytes > 0);
        }
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn crop_jpeg_uses_requested_background_for_transparency() {
        let directory = crop_test_directory("background");
        let input = directory.join("transparent.png");
        image::RgbaImage::from_pixel(2, 2, image::Rgba([0, 0, 0, 0]))
            .save(&input)
            .unwrap();
        let mut options = crop_options(&input, &directory, "jpg");
        options.background_rgba = "#20A060FF".to_string();
        let result = crop_image_blocking(options).unwrap();
        let pixel = image::open(result.output_path)
            .unwrap()
            .to_rgb8()
            .get_pixel(0, 0)
            .0;
        assert!((i16::from(pixel[0]) - 32).abs() < 16);
        assert!((i16::from(pixel[1]) - 160).abs() < 16);
        assert!((i16::from(pixel[2]) - 96).abs() < 16);
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn crop_coordinates_follow_exif_oriented_pixels() {
        let directory = crop_test_directory("exif");
        let input = directory.join("orientation-6.jpg");
        let source = image::RgbImage::from_fn(64, 32, |x, y| match (x < 32, y < 16) {
            (true, true) => image::Rgb([255, 0, 0]),
            (false, true) => image::Rgb([0, 255, 0]),
            (true, false) => image::Rgb([0, 0, 255]),
            (false, false) => image::Rgb([255, 255, 0]),
        });
        write_crop_exif_jpeg(&input, &source, 6);
        let mut options = crop_options(&input, &directory, "png");
        options.crop_width = 12;
        options.crop_height = 12;
        let result = crop_image_blocking(options).unwrap();
        let pixel = image::open(result.output_path).unwrap().to_rgb8().get_pixel(4, 4).0;
        assert!(pixel[2] > 200 && pixel[0] < 40 && pixel[1] < 40);
        std::fs::remove_dir_all(directory).unwrap();
    }
}

#[tauri::command]
fn reveal_in_folder(path: String) -> Result<(), String> {
    // Legacy frontend builds used this command name for output actions. Keep
    // the command available for compatibility, but enforce the current rule that
    // an "open folder" action opens a directory only and never selects or opens
    // the output file itself.
    open_path(path)
}

fn resolve_open_folder(path: &str) -> Result<std::path::PathBuf, String> {
    if path.contains('\0') {
        return Err("Invalid path".to_string());
    }
    let requested = std::path::PathBuf::from(path);
    if !requested.is_absolute() {
        return Err("Path must be absolute".to_string());
    }
    let canonical = requested
        .canonicalize()
        .map_err(|_| "Path does not exist".to_string())?;
    let metadata = std::fs::metadata(&canonical).map_err(|_| "Path is unavailable".to_string())?;
    let target = if metadata.is_file() {
        canonical
            .parent()
            .map(|parent| parent.to_path_buf())
            .ok_or_else(|| "File has no parent folder".to_string())?
    } else if metadata.is_dir() {
        canonical
    } else {
        return Err("Path must be a file or folder".to_string());
    };
    Ok(target)
}

#[tauri::command]
fn open_path(path: String) -> Result<(), String> {
    let target = resolve_open_folder(&path)?;
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        std::process::Command::new("explorer")
            .arg(&target)
            .creation_flags(0x08000000)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg(&target)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    #[cfg(target_os = "linux")]
    {
        std::process::Command::new("xdg-open")
            .arg(&target)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
fn open_recycle_bin() -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        std::process::Command::new("explorer")
            .arg("shell:RecycleBinFolder")
            .creation_flags(0x08000000)
            .spawn()
            .map_err(|e| e.to_string())?;
        Ok(())
    }
    #[cfg(not(target_os = "windows"))]
    {
        Err("Opening the Recycle Bin is currently available on Windows only.".to_string())
    }
}

#[cfg(test)]
mod external_open_security_tests {
    use super::*;

    #[test]
    fn external_urls_require_web_protocol_host_and_no_credentials() {
        assert!(validate_external_url("https://toolknit.com/changelog.html").is_ok());
        assert!(validate_external_url("http://127.0.0.1:1420/").is_ok());
        assert!(validate_external_url("file:///C:/Windows/System32/calc.exe").is_err());
        assert!(validate_external_url("https://user:secret@example.com/").is_err());
        assert!(validate_external_url("javascript:alert(1)").is_err());
        assert!(validate_external_url("https://example.com/\nnext").is_err());
    }

    #[test]
    fn webviews_can_only_navigate_within_the_packaged_application() {
        assert!(allow_webview_navigation(
            &url::Url::parse("tauri://localhost/index.html").unwrap()
        ));
        assert!(allow_webview_navigation(
            &url::Url::parse("http://tauri.localhost/index.html?screen-picker=1").unwrap()
        ));
        assert!(!allow_webview_navigation(
            &url::Url::parse("https://toolknit.com/").unwrap()
        ));
        assert!(!allow_webview_navigation(
            &url::Url::parse("data:text/html,external").unwrap()
        ));
    }

    #[test]
    fn open_folder_resolution_requires_an_existing_absolute_path() {
        let root = std::env::temp_dir().join(format!(
            "toolknit-open-folder-test-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&root).unwrap();
        let file = root.join("result.pdf");
        std::fs::write(&file, b"test").unwrap();

        assert_eq!(resolve_open_folder(root.to_str().unwrap()).unwrap(), root.canonicalize().unwrap());
        assert_eq!(resolve_open_folder(file.to_str().unwrap()).unwrap(), root.canonicalize().unwrap());
        assert!(resolve_open_folder("relative-output").is_err());
        assert!(resolve_open_folder(root.join("missing").to_str().unwrap()).is_err());

        std::fs::remove_dir_all(root).unwrap();
    }
}

#[cfg(test)]
mod image_color_replace_tests {
    use super::*;

    #[test]
    fn perceptual_distance_and_feather_are_bounded() {
        let white = color_rgb_to_lab([255, 255, 255]);
        assert_eq!(color_delta_e(white, white), 0.0);
        assert_eq!(color_replace_weight(0.0, 20.0, 24.0), 1.0);
        assert_eq!(color_replace_weight(21.0, 20.0, 24.0), 0.0);
        assert!((0.0..=1.0).contains(&color_replace_weight(19.0, 20.0, 24.0)));
    }

    #[test]
    fn smart_and_global_exports_match_the_frontend_fixture() {
        let suffix = hex::encode({ let mut value = [0_u8; 8]; getrandom::getrandom(&mut value).unwrap(); value });
        let root = std::env::temp_dir().join(format!("toolknit-color-replace-test-{}", suffix));
        let output = root.join("output");
        std::fs::create_dir_all(&root).unwrap();
        let input = root.join("fixture.png");
        let bytes = vec![
            255,255,255,255, 255,255,255,255, 0,0,0,255, 255,255,255,255,
            255,255,255,255, 255,255,255,255, 0,0,0,255, 255,255,255,255,
            0,0,0,255,       0,0,0,255,       0,0,0,255, 255,255,255,255,
        ];
        image::RgbaImage::from_raw(4, 3, bytes).unwrap().save(&input).unwrap();
        let options = |smart, name: &str| ColorReplaceOptions {
            app: None,
            operation_id: None,
            input_path: input.to_string_lossy().into_owned(),
            output_dir: output.to_string_lossy().into_owned(),
            output_name: name.to_string(),
            source_rgb: vec![255, 255, 255],
            target_rgb: vec![0, 0, 255],
            threshold: 2.0,
            seed_x: 0,
            seed_y: 0,
            smart,
            softness: 0.0,
            preserve_luminance: false,
            format: "png".to_string(),
            jpeg_quality: 92,
            cancel_token: None,
        };
        let smart = color_replace_blocking(options(true, "smart")).unwrap();
        let global = color_replace_blocking(options(false, "global")).unwrap();
        assert_eq!(smart.changed_pixels, 4);
        assert_eq!(global.changed_pixels, 7);
        let smart_pixels = image::open(smart.output_path).unwrap().to_rgba8();
        assert_eq!(smart_pixels.get_pixel(0, 0).0, [0, 0, 255, 255]);
        assert_eq!(smart_pixels.get_pixel(3, 2).0, [255, 255, 255, 255]);
        let global_pixels = image::open(global.output_path).unwrap().to_rgba8();
        assert_eq!(global_pixels.get_pixel(3, 2).0, [0, 0, 255, 255]);
        std::fs::remove_dir_all(root).unwrap();
    }
}

#[cfg(test)]
mod crypto_tool_tests {
    use super::*;

    #[test]
    fn tkaes_header_helpers_are_deterministic_and_nonce_is_per_chunk() {
        let base = [7_u8; 12];
        assert_ne!(tkaes_nonce(&base, 0), tkaes_nonce(&base, 1));
        assert_eq!(&tkaes_aad(3, 42)[..4], TKAE_MAGIC);
        assert_eq!(tkaes_aad(3, 42).len(), 16);
        assert_eq!(TKAE_VERSION, 2);
        assert_eq!(tkaes_encrypted_stem(std::path::Path::new("document.pdf")), "document.pdf");
        assert_eq!(tkaes_decrypted_stem(std::path::Path::new("document.pdf.tkaes")), "document.pdf");
        assert!(validate_tool_operation_id("123e4567-e89b-12d3-a456-426614174000").is_ok());
        assert!(validate_tool_operation_id("../invalid").is_err());
    }

    #[test]
    fn tkaes_round_trip_preserves_name_and_rejects_wrong_password() {
        let suffix = hex::encode({ let mut value = [0_u8; 8]; getrandom::getrandom(&mut value).unwrap(); value });
        let root = std::env::temp_dir().join(format!("toolknit-tkaes-test-{}", suffix));
        let encrypted_dir = root.join("encrypted");
        let decrypted_dir = root.join("decrypted");
        let rejected_dir = root.join("rejected");
        std::fs::create_dir_all(&root).unwrap();
        let input = root.join("document.txt");
        let payload = b"ToolKnit authenticated file container\n".repeat(64);
        std::fs::write(&input, &payload).unwrap();
        let token = || std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));

        let encrypted = tkaes_encrypt_blocking(None, input.to_string_lossy().into_owned(), encrypted_dir.to_string_lossy().into_owned(), "correct horse battery staple".to_string(), "test-encrypt".to_string(), token()).unwrap();
        assert!(encrypted.output_path.ends_with("document.txt.tkaes"));
        let decrypted = tkaes_decrypt_blocking(None, encrypted.output_path.clone(), decrypted_dir.to_string_lossy().into_owned(), "correct horse battery staple".to_string(), "test-decrypt".to_string(), token()).unwrap();
        assert!(decrypted.output_path.ends_with("document.txt"));
        assert_eq!(std::fs::read(&decrypted.output_path).unwrap(), payload);

        let rejected = tkaes_decrypt_blocking(None, encrypted.output_path, rejected_dir.to_string_lossy().into_owned(), "wrong password".to_string(), "test-reject".to_string(), token());
        assert_eq!(rejected.unwrap_err(), "tkaes:authentication-failed");
        assert!(std::fs::read_dir(&rejected_dir).map(|mut entries| entries.next().is_none()).unwrap_or(true));
        std::fs::remove_dir_all(root).unwrap();
    }
}

