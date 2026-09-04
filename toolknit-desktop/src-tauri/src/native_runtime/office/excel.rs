#[derive(Clone, Debug)]
struct ExcelRenderInput {
    path: std::path::PathBuf,
    name: String,
    bytes: u64,
}

#[derive(Clone, Debug, serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ExcelToPdfOptions {
    pub(crate) sheet_range: String,
    pub(crate) orientation: String,
    pub(crate) paper: String,
    pub(crate) scale: String,
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
pub(crate) struct ExcelToPdfFileResult {
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
pub(crate) struct ExcelToPdfBatchResult {
    pub(crate) tool: String,
    pub(crate) success_count: usize,
    pub(crate) fail_count: usize,
    pub(crate) output_dir: String,
    pub(crate) outputs: Vec<ExcelToPdfFileResult>,
    pub(crate) errors: Vec<String>,
    pub(crate) warnings: Vec<String>,
    pub(crate) renderer: LibreOfficeRuntimeInfo,
    pub(crate) manifest_path: String,
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
pub(crate) async fn convert_excel_to_pdf(
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
