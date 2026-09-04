
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
pub(crate) struct LibreOfficeRuntimeInfo {
    pub(crate) available: bool,
    pub(crate) command: Option<String>,
    pub(crate) source: Option<String>,
    pub(crate) version: Option<String>,
    pub(crate) message: Option<String>,
}

#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PptToPdfResult {
    pub(crate) tool: String,
    pub(crate) source_name: String,
    pub(crate) input_path: String,
    pub(crate) input_bytes: u64,
    pub(crate) renderer: LibreOfficeRuntimeInfo,
    pub(crate) slide_count: usize,
    pub(crate) page_count: usize,
    pub(crate) page_count_matches_slides: bool,
    pub(crate) output_dir: String,
    pub(crate) output_path: String,
    pub(crate) output_file: String,
    pub(crate) output_bytes: u64,
    pub(crate) manifest_path: String,
    pub(crate) warnings: Vec<String>,
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

pub(crate) fn sanitize_ppt_render_base_name(value: &str) -> String {
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

pub(crate) fn libreoffice_candidates() -> Vec<(std::path::PathBuf, &'static str)> {
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

pub(crate) fn probe_libreoffice(
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

pub(crate) fn resolve_libreoffice_runtime() -> LibreOfficeRuntimeInfo {
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

pub(crate) fn file_url_for_libreoffice(path: &std::path::Path) -> String {
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
pub(crate) fn seed_libreoffice_printer_profile(profile_dir: &std::path::Path) {
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

pub(crate) fn count_pdf_pages_rough(bytes: &[u8]) -> usize {
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
pub(crate) async fn convert_ppt_to_pdf(
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

pub(crate) const EXCEL_RENDER_MAX_FILES: usize = 20;
pub(crate) const EXCEL_RENDER_MAX_INPUT_BYTES: u64 = 200 * 1024 * 1024;
pub(crate) const EXCEL_WPS_METADATA_MAX_BYTES: u64 = 512 * 1024;
pub(crate) const EXCEL_RENDER_TIMEOUT_SECS: u64 = 180;
pub(crate) static EXCEL_RENDER_TEMP_ID: AtomicU64 = AtomicU64::new(0);

pub(crate) const EXCEL_TO_PDF_UNO_SCRIPT: &str = r#"import json
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
