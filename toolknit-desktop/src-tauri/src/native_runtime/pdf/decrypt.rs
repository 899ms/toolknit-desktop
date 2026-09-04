
pub(crate) const PDF_DECRYPT_MAX_INPUT_BYTES: u64 = 150 * 1024 * 1024;
pub(crate) const PDF_DECRYPT_MAX_PAGES: u32 = 200;
pub(crate) const PDF_ENCRYPT_MAX_INPUT_BYTES: u64 = 150 * 1024 * 1024;
pub(crate) const PDF_ENCRYPT_MAX_PAGES: u32 = 200;
pub(crate) const PDF_ENCRYPT_MIN_PASSWORD_CHARS: usize = 8;
pub(crate) const PDF_ENCRYPT_MAX_PASSWORD_BYTES: usize = 127;
pub(crate) const PDF_COMPRESS_MAX_INPUT_BYTES: u64 = 150 * 1024 * 1024;
pub(crate) const PDF_COMPRESS_MAX_PAGES: u32 = 500;
pub(crate) const QPDF_PROCESS_TIMEOUT_SECS: u64 = 120;

pub(crate) fn get_qpdf_path() -> Result<std::path::PathBuf, String> {
    let exe_name = if cfg!(target_os = "windows") {
        "qpdf.exe"
    } else {
        "qpdf"
    };
    let exe = std::env::current_exe().map_err(|_| "pdf-decrypt:qpdf-unavailable".to_string())?;
    let exe_dir = exe.parent().ok_or("pdf-decrypt:qpdf-unavailable")?;
    let bundled = exe_dir.join("resources").join("qpdf").join(exe_name);
    if bundled.exists() {
        return Ok(bundled);
    }

    // Tauri dev and direct Rust checks run outside the packaged resources directory.
    let source_resource = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("resources")
        .join("qpdf")
        .join(exe_name);
    if source_resource.exists() {
        return Ok(source_resource);
    }

    Err("pdf-decrypt:qpdf-unavailable".to_string())
}

pub(crate) fn clear_pdf_password(password: &mut String) {
    use zeroize::Zeroize;
    password.zeroize();
}

pub(crate) async fn run_qpdf_with_stdin(
    qpdf_path: &std::path::Path,
    args: &[std::ffi::OsString],
    stdin_data: Option<&[u8]>,
    capture_stdout: bool,
    failure_code: &str,
) -> Result<std::process::Output, String> {
    use tokio::io::AsyncWriteExt;

    let mut command = tokio::process::Command::new(qpdf_path);
    command
        .args(args)
        .kill_on_drop(true)
        .stdin(if stdin_data.is_some() {
            std::process::Stdio::piped()
        } else {
            std::process::Stdio::null()
        })
        .stdout(if capture_stdout {
            std::process::Stdio::piped()
        } else {
            std::process::Stdio::null()
        })
        .stderr(std::process::Stdio::piped());

    #[cfg(target_os = "windows")]
    {
        command.creation_flags(0x08000000);
    }

    let mut child = command
        .spawn()
        .map_err(|_| failure_code.to_string())?;
    if let Some(value) = stdin_data {
        let mut stdin = child.stdin.take().ok_or_else(|| failure_code.to_string())?;
        stdin
            .write_all(value)
            .await
            .map_err(|_| failure_code.to_string())?;
        stdin
            .shutdown()
            .await
            .map_err(|_| failure_code.to_string())?;
    }
    tokio::time::timeout(
        std::time::Duration::from_secs(QPDF_PROCESS_TIMEOUT_SECS),
        child.wait_with_output(),
    )
    .await
    .map_err(|_| failure_code.to_string())?
    .map_err(|_| failure_code.to_string())
}

pub(crate) async fn run_qpdf(
    qpdf_path: &std::path::Path,
    args: &[std::ffi::OsString],
    password: Option<&str>,
) -> Result<std::process::Output, String> {
    use zeroize::Zeroize;

    let mut stdin_data = password.map(|value| {
        let mut bytes = Vec::with_capacity(value.len() + 1);
        bytes.extend_from_slice(value.as_bytes());
        bytes.push(b'\n');
        bytes
    });
    let result = run_qpdf_with_stdin(
        qpdf_path,
        args,
        stdin_data.as_deref(),
        true,
        "pdf-decrypt:decryption-failed",
    )
    .await;
    if let Some(bytes) = stdin_data.as_mut() {
        bytes.zeroize();
    }
    result
}

pub(crate) fn create_pdf_decrypt_file_name(input_path: &std::path::Path) -> String {
    let raw_stem = input_path
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("document");
    let sanitized: String = raw_stem
        .chars()
        .map(|character| {
            if matches!(
                character,
                '\\' | '/' | ':' | '*' | '?' | '"' | '<' | '>' | '|'
            ) {
                '_'
            } else {
                character
            }
        })
        .collect();
    let trimmed = sanitized
        .trim()
        .trim_end_matches(|character| character == '.' || character == ' ');
    let stem = if trimmed.is_empty() {
        "document"
    } else {
        trimmed
    };
    format!("{}_decrypted.pdf", stem)
}

pub(crate) fn create_pdf_decrypt_temp_path(
    output_dir: &std::path::Path,
) -> Result<std::path::PathBuf, String> {
    use std::time::{SystemTime, UNIX_EPOCH};

    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| "pdf-decrypt:decryption-failed".to_string())?
        .as_nanos();
    for _ in 0..100 {
        let id = PDF_DECRYPT_TEMP_ID.fetch_add(1, Ordering::Relaxed);
        let candidate = output_dir.join(format!(
            ".toolknit-decrypt-{}-{}-{}.pdf",
            std::process::id(),
            timestamp,
            id
        ));
        if !candidate.exists() {
            return Ok(candidate);
        }
    }
    Err("pdf-decrypt:decryption-failed".to_string())
}

pub(crate) fn publish_pdf_decrypt_output(
    temporary_path: &std::path::Path,
    output_dir: &std::path::Path,
    file_name: &str,
) -> Result<String, String> {
    let source = std::path::Path::new(file_name);
    let stem = source
        .file_stem()
        .and_then(|value| value.to_str())
        .ok_or("pdf-decrypt:decryption-failed")?;
    let extension = source
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("pdf");

    for counter in 0..10_000_u32 {
        let candidate_name = if counter == 0 {
            file_name.to_string()
        } else {
            format!("{}_{}.{}", stem, counter, extension)
        };
        let candidate = output_dir.join(candidate_name);
        match std::fs::hard_link(temporary_path, &candidate) {
            Ok(()) => {
                std::fs::remove_file(temporary_path)
                    .map_err(|_| "pdf-decrypt:decryption-failed".to_string())?;
                return Ok(candidate.to_string_lossy().into_owned());
            }
            Err(_) if candidate.exists() => continue,
            Err(_) => return Err("pdf-decrypt:decryption-failed".to_string()),
        }
    }
    Err("pdf-decrypt:decryption-failed".to_string())
}

pub(crate) fn map_qpdf_decrypt_error(output: &std::process::Output) -> String {
    let details = String::from_utf8_lossy(&output.stderr).to_ascii_lowercase();
    if details.contains("invalid password") || details.contains("password supplied is incorrect") {
        "pdf-decrypt:invalid-password".to_string()
    } else if details.contains("not a pdf")
        || details.contains("damaged pdf")
        || details.contains("can't find pdf header")
    {
        "pdf-decrypt:invalid-pdf".to_string()
    } else {
        "pdf-decrypt:decryption-failed".to_string()
    }
}

#[tauri::command]
pub(crate) async fn decrypt_pdf(
    input_path: String,
    mut password: String,
    output_dir: Option<String>,
) -> Result<String, String> {
    let result = decrypt_pdf_inner(&input_path, &password, output_dir.as_deref()).await;
    clear_pdf_password(&mut password);
    result
}

pub(crate) async fn decrypt_pdf_inner(
    input_path: &str,
    password: &str,
    requested_output_dir: Option<&str>,
) -> Result<String, String> {
    let input = std::path::Path::new(&input_path);
    if input_path.contains('\0')
        || !input.is_file()
        || !input
            .extension()
            .and_then(|value| value.to_str())
            .is_some_and(|value| value.eq_ignore_ascii_case("pdf"))
    {
        return Err("pdf-decrypt:invalid-pdf".to_string());
    }
    let metadata = std::fs::metadata(input).map_err(|_| "pdf-decrypt:invalid-pdf".to_string())?;
    if metadata.len() > PDF_DECRYPT_MAX_INPUT_BYTES {
        return Err("pdf-decrypt:input-too-large".to_string());
    }

    let qpdf_path = get_qpdf_path()?;
    let output_dir = requested_output_dir
        .filter(|value| !value.trim().is_empty() && !value.contains('\0'))
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|| {
            dirs::document_dir()
                .unwrap_or_default()
                .join("ToolKnit")
                .join("PDF_Decrypt")
        });
    is_path_safe(&output_dir).map_err(|_| "pdf-decrypt:output-path".to_string())?;
    std::fs::create_dir_all(&output_dir)
        .map_err(|_| "pdf-decrypt:decryption-failed".to_string())?;
    is_path_safe(&output_dir).map_err(|_| "pdf-decrypt:output-path".to_string())?;
    let temporary_path = create_pdf_decrypt_temp_path(&output_dir)?;

    let mut decrypt_args = vec![
        std::ffi::OsString::from("--warning-exit-0"),
        std::ffi::OsString::from("--decrypt"),
        input.as_os_str().to_os_string(),
        temporary_path.as_os_str().to_os_string(),
    ];
    let use_password_pipe = !password.is_empty();
    if use_password_pipe {
        decrypt_args.insert(1, std::ffi::OsString::from("--password-file=-"));
    }
    let result = run_qpdf(
        &qpdf_path,
        &decrypt_args,
        if use_password_pipe {
            Some(password)
        } else {
            None
        },
    )
    .await;
    let output = result?;
    if !output.status.success() {
        let _ = std::fs::remove_file(&temporary_path);
        return Err(map_qpdf_decrypt_error(&output));
    }

    let page_output = run_qpdf(
        &qpdf_path,
        &[
            std::ffi::OsString::from("--show-npages"),
            temporary_path.as_os_str().to_os_string(),
        ],
        None,
    )
    .await?;
    let page_count = String::from_utf8_lossy(&page_output.stdout)
        .trim()
        .parse::<u32>()
        .ok();
    if !page_output.status.success() || !matches!(page_count, Some(1..=PDF_DECRYPT_MAX_PAGES)) {
        let _ = std::fs::remove_file(&temporary_path);
        return Err(
            if page_count.is_some_and(|count| count > PDF_DECRYPT_MAX_PAGES) {
                "pdf-decrypt:too-many-pages".to_string()
            } else {
                "pdf-decrypt:invalid-pdf".to_string()
            },
        );
    }

    publish_pdf_decrypt_output(
        &temporary_path,
        &output_dir,
        &create_pdf_decrypt_file_name(input),
    )
}

#[derive(Clone, serde::Deserialize)]
#[serde(untagged)]
pub(crate) enum PdfEncryptPrintingPermission {
    Enabled(bool),
    Quality(String),
}

impl Default for PdfEncryptPrintingPermission {
    fn default() -> Self {
        Self::Enabled(true)
    }
}

#[derive(Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PdfEncryptPermissions {
    #[serde(default)]
    pub(crate) printing: PdfEncryptPrintingPermission,
    #[serde(default = "pdf_encrypt_permission_default")]
    pub(crate) modifying: bool,
    #[serde(default = "pdf_encrypt_permission_default")]
    pub(crate) copying: bool,
    #[serde(default = "pdf_encrypt_permission_default")]
    pub(crate) annotating: bool,
    #[serde(default = "pdf_encrypt_permission_default")]
    pub(crate) filling_forms: bool,
    #[serde(default = "pdf_encrypt_permission_default")]
    pub(crate) content_accessibility: bool,
    #[serde(default = "pdf_encrypt_permission_default")]
    pub(crate) document_assembly: bool,
}
