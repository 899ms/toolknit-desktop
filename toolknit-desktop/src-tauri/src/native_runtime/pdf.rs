const PDF_DECRYPT_MAX_INPUT_BYTES: u64 = 150 * 1024 * 1024;
const PDF_DECRYPT_MAX_PAGES: u32 = 200;
const PDF_ENCRYPT_MAX_INPUT_BYTES: u64 = 150 * 1024 * 1024;
const PDF_ENCRYPT_MAX_PAGES: u32 = 200;
const PDF_ENCRYPT_MIN_PASSWORD_CHARS: usize = 8;
const PDF_ENCRYPT_MAX_PASSWORD_BYTES: usize = 127;
const PDF_COMPRESS_MAX_INPUT_BYTES: u64 = 150 * 1024 * 1024;
const PDF_COMPRESS_MAX_PAGES: u32 = 500;
const QPDF_PROCESS_TIMEOUT_SECS: u64 = 120;

fn get_qpdf_path() -> Result<std::path::PathBuf, String> {
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

fn clear_pdf_password(password: &mut String) {
    use zeroize::Zeroize;
    password.zeroize();
}

async fn run_qpdf_with_stdin(
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

async fn run_qpdf(
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

fn create_pdf_decrypt_file_name(input_path: &std::path::Path) -> String {
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

fn create_pdf_decrypt_temp_path(
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

fn publish_pdf_decrypt_output(
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

fn map_qpdf_decrypt_error(output: &std::process::Output) -> String {
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
async fn decrypt_pdf(
    input_path: String,
    mut password: String,
    output_dir: Option<String>,
) -> Result<String, String> {
    let result = decrypt_pdf_inner(&input_path, &password, output_dir.as_deref()).await;
    clear_pdf_password(&mut password);
    result
}

async fn decrypt_pdf_inner(
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
enum PdfEncryptPrintingPermission {
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
struct PdfEncryptPermissions {
    #[serde(default)]
    printing: PdfEncryptPrintingPermission,
    #[serde(default = "pdf_encrypt_permission_default")]
    modifying: bool,
    #[serde(default = "pdf_encrypt_permission_default")]
    copying: bool,
    #[serde(default = "pdf_encrypt_permission_default")]
    annotating: bool,
    #[serde(default = "pdf_encrypt_permission_default")]
    filling_forms: bool,
    #[serde(default = "pdf_encrypt_permission_default")]
    content_accessibility: bool,
    #[serde(default = "pdf_encrypt_permission_default")]
    document_assembly: bool,
}

fn pdf_encrypt_permission_default() -> bool {
    true
}

fn validate_pdf_encrypt_password(password: &str) -> Result<(), String> {
    if password.chars().count() < PDF_ENCRYPT_MIN_PASSWORD_CHARS {
        return Err("pdf-encrypt:password-too-short".to_string());
    }
    if password.len() > PDF_ENCRYPT_MAX_PASSWORD_BYTES {
        return Err("pdf-encrypt:password-too-long".to_string());
    }
    if password
        .chars()
        .any(|character| matches!(character, '\0' | '\r' | '\n'))
    {
        return Err("pdf-encrypt:password-unsupported".to_string());
    }
    invalidate_ffmpeg_runtime_cache();
    Ok(())
}

fn pdf_encrypt_print_option(
    permission: &PdfEncryptPrintingPermission,
) -> Result<&'static str, String> {
    match permission {
        PdfEncryptPrintingPermission::Enabled(true) => Ok("full"),
        PdfEncryptPrintingPermission::Enabled(false) => Ok("none"),
        PdfEncryptPrintingPermission::Quality(value) if value == "highResolution" => Ok("full"),
        PdfEncryptPrintingPermission::Quality(value) if value == "lowResolution" => Ok("low"),
        _ => Err("pdf-encrypt:invalid-permissions".to_string()),
    }
}

fn pdf_encrypt_yes_no(value: bool) -> &'static str {
    if value {
        "y"
    } else {
        "n"
    }
}

fn validate_pdf_encrypt_argument(value: &str, error_code: &str) -> Result<(), String> {
    if value
        .chars()
        .any(|character| matches!(character, '\0' | '\r' | '\n'))
    {
        Err(error_code.to_string())
    } else {
        Ok(())
    }
}

fn append_pdf_encrypt_argument(
    payload: &mut Vec<u8>,
    value: &str,
    error_code: &str,
) -> Result<(), String> {
    validate_pdf_encrypt_argument(value, error_code)?;
    payload.extend_from_slice(value.as_bytes());
    payload.push(b'\n');
    Ok(())
}

fn append_pdf_encrypt_option(
    payload: &mut Vec<u8>,
    prefix: &str,
    value: &str,
    error_code: &str,
) -> Result<(), String> {
    validate_pdf_encrypt_argument(value, error_code)?;
    payload.extend_from_slice(prefix.as_bytes());
    payload.extend_from_slice(value.as_bytes());
    payload.push(b'\n');
    Ok(())
}

fn create_pdf_encrypt_owner_password() -> Result<String, String> {
    use std::fmt::Write;
    use zeroize::Zeroize;

    let mut random_bytes = [0_u8; 32];
    getrandom::getrandom(&mut random_bytes)
        .map_err(|_| "pdf-encrypt:encryption-failed".to_string())?;
    let mut password = String::with_capacity(random_bytes.len() * 2);
    for byte in &random_bytes {
        write!(&mut password, "{:02x}", byte)
            .map_err(|_| "pdf-encrypt:encryption-failed".to_string())?;
    }
    random_bytes.zeroize();
    Ok(password)
}

fn create_pdf_encrypt_file_name(input_path: &std::path::Path) -> String {
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
    format!("{}_encrypted.pdf", stem)
}

fn create_pdf_encrypt_temp_path(
    output_dir: &std::path::Path,
) -> Result<std::path::PathBuf, String> {
    use std::time::{SystemTime, UNIX_EPOCH};

    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| "pdf-encrypt:encryption-failed".to_string())?
        .as_nanos();
    for _ in 0..100 {
        let id = PDF_DECRYPT_TEMP_ID.fetch_add(1, Ordering::Relaxed);
        let candidate = output_dir.join(format!(
            ".toolknit-encrypt-{}-{}-{}.pdf",
            std::process::id(),
            timestamp,
            id
        ));
        if !candidate.exists() {
            return Ok(candidate);
        }
    }
    Err("pdf-encrypt:encryption-failed".to_string())
}

fn publish_pdf_encrypt_output(
    temporary_path: &std::path::Path,
    output_dir: &std::path::Path,
    file_name: &str,
) -> Result<String, String> {
    let source = std::path::Path::new(file_name);
    let stem = source
        .file_stem()
        .and_then(|value| value.to_str())
        .ok_or("pdf-encrypt:encryption-failed")?;

    for counter in 0..10_000_u32 {
        let candidate_name = if counter == 0 {
            file_name.to_string()
        } else {
            format!("{}_{}.pdf", stem, counter)
        };
        let candidate = output_dir.join(candidate_name);
        match std::fs::hard_link(temporary_path, &candidate) {
            Ok(()) => {
                std::fs::remove_file(temporary_path)
                    .map_err(|_| "pdf-encrypt:encryption-failed".to_string())?;
                return Ok(candidate.to_string_lossy().into_owned());
            }
            Err(_) if candidate.exists() => continue,
            Err(_) => return Err("pdf-encrypt:encryption-failed".to_string()),
        }
    }
    Err("pdf-encrypt:encryption-failed".to_string())
}

fn map_qpdf_encrypt_error(output: &std::process::Output) -> String {
    let details = String::from_utf8_lossy(&output.stderr).to_ascii_lowercase();
    if details.contains("invalid password")
        || details.contains("password supplied is incorrect")
        || details.contains("encrypted file")
    {
        "pdf-encrypt:password-protected".to_string()
    } else if details.contains("not a pdf")
        || details.contains("damaged pdf")
        || details.contains("can't find pdf header")
    {
        "pdf-encrypt:invalid-pdf".to_string()
    } else {
        "pdf-encrypt:encryption-failed".to_string()
    }
}

fn build_pdf_encrypt_qpdf_arguments(
    input: &std::path::Path,
    temporary_path: &std::path::Path,
    password: &str,
    owner_password: &str,
    permissions: &PdfEncryptPermissions,
) -> Result<Vec<u8>, String> {
    input
        .to_str()
        .ok_or("pdf-encrypt:invalid-pdf".to_string())?;
    temporary_path
        .to_str()
        .ok_or("pdf-encrypt:output-path".to_string())?;
    let input = cleanup_display_path(input);
    let output = cleanup_display_path(temporary_path);
    let print = pdf_encrypt_print_option(&permissions.printing)?;
    let mut payload = Vec::with_capacity(input.len() + output.len() + password.len() + 512);
    append_pdf_encrypt_argument(&mut payload, "--warning-exit-0", "pdf-encrypt:encryption-failed")?;
    append_pdf_encrypt_argument(&mut payload, "--password-mode=unicode", "pdf-encrypt:encryption-failed")?;
    append_pdf_encrypt_argument(&mut payload, "--encrypt", "pdf-encrypt:encryption-failed")?;
    append_pdf_encrypt_option(
        &mut payload,
        "--user-password=",
        password,
        "pdf-encrypt:password-unsupported",
    )?;
    append_pdf_encrypt_option(
        &mut payload,
        "--owner-password=",
        owner_password,
        "pdf-encrypt:encryption-failed",
    )?;
    append_pdf_encrypt_argument(&mut payload, "--bits=256", "pdf-encrypt:encryption-failed")?;
    append_pdf_encrypt_option(&mut payload, "--print=", print, "pdf-encrypt:invalid-permissions")?;
    append_pdf_encrypt_option(
        &mut payload,
        "--extract=",
        pdf_encrypt_yes_no(permissions.copying),
        "pdf-encrypt:invalid-permissions",
    )?;
    append_pdf_encrypt_option(
        &mut payload,
        "--modify-other=",
        pdf_encrypt_yes_no(permissions.modifying),
        "pdf-encrypt:invalid-permissions",
    )?;
    append_pdf_encrypt_option(
        &mut payload,
        "--annotate=",
        pdf_encrypt_yes_no(permissions.annotating),
        "pdf-encrypt:invalid-permissions",
    )?;
    append_pdf_encrypt_option(
        &mut payload,
        "--form=",
        pdf_encrypt_yes_no(permissions.filling_forms),
        "pdf-encrypt:invalid-permissions",
    )?;
    append_pdf_encrypt_option(
        &mut payload,
        "--accessibility=",
        pdf_encrypt_yes_no(permissions.content_accessibility),
        "pdf-encrypt:invalid-permissions",
    )?;
    append_pdf_encrypt_option(
        &mut payload,
        "--assemble=",
        pdf_encrypt_yes_no(permissions.document_assembly),
        "pdf-encrypt:invalid-permissions",
    )?;
    append_pdf_encrypt_argument(&mut payload, "--", "pdf-encrypt:encryption-failed")?;
    append_pdf_encrypt_argument(&mut payload, &input, "pdf-encrypt:invalid-pdf")?;
    append_pdf_encrypt_argument(&mut payload, &output, "pdf-encrypt:output-path")?;
    Ok(payload)
}

#[tauri::command]
async fn encrypt_pdf(
    input_path: String,
    mut password: String,
    permissions: PdfEncryptPermissions,
    output_dir: Option<String>,
) -> Result<String, String> {
    let result = encrypt_pdf_inner(
        &input_path,
        &password,
        &permissions,
        output_dir.as_deref(),
    )
    .await;
    clear_pdf_password(&mut password);
    result
}

async fn encrypt_pdf_inner(
    input_path: &str,
    password: &str,
    permissions: &PdfEncryptPermissions,
    requested_output_dir: Option<&str>,
) -> Result<String, String> {
    use zeroize::Zeroize;

    validate_pdf_encrypt_password(password)?;
    validate_pdf_encrypt_argument(input_path, "pdf-encrypt:invalid-pdf")?;
    let requested = std::path::Path::new(input_path);
    let requested_metadata = std::fs::symlink_metadata(requested)
        .map_err(|_| "pdf-encrypt:invalid-pdf".to_string())?;
    if requested_metadata.file_type().is_symlink() || !requested_metadata.is_file() {
        return Err("pdf-encrypt:invalid-pdf".to_string());
    }
    let input = requested
        .canonicalize()
        .map_err(|_| "pdf-encrypt:invalid-pdf".to_string())?;
    if !input
        .extension()
        .and_then(|value| value.to_str())
        .is_some_and(|value| value.eq_ignore_ascii_case("pdf"))
    {
        return Err("pdf-encrypt:invalid-pdf".to_string());
    }
    let input_size = std::fs::metadata(&input)
        .map_err(|_| "pdf-encrypt:invalid-pdf".to_string())?
        .len();
    if input_size == 0 {
        return Err("pdf-encrypt:invalid-pdf".to_string());
    }
    if input_size > PDF_ENCRYPT_MAX_INPUT_BYTES {
        return Err("pdf-encrypt:input-too-large".to_string());
    }

    let qpdf_path =
        get_qpdf_path().map_err(|_| "pdf-encrypt:qpdf-unavailable".to_string())?;
    let qpdf_input_path = std::path::PathBuf::from(cleanup_display_path(&input));
    let page_output = run_qpdf_with_stdin(
        &qpdf_path,
        &[
            std::ffi::OsString::from("--show-npages"),
            qpdf_input_path.as_os_str().to_os_string(),
        ],
        None,
        true,
        "pdf-encrypt:encryption-failed",
    )
    .await?;
    if !page_output.status.success() {
        return Err(map_qpdf_encrypt_error(&page_output));
    }
    let page_count = String::from_utf8_lossy(&page_output.stdout)
        .trim()
        .parse::<u32>()
        .map_err(|_| "pdf-encrypt:invalid-pdf".to_string())?;
    if page_count == 0 {
        return Err("pdf-encrypt:invalid-pdf".to_string());
    }
    if page_count > PDF_ENCRYPT_MAX_PAGES {
        return Err("pdf-encrypt:too-many-pages".to_string());
    }

    let output_dir = requested_output_dir
        .filter(|value| !value.trim().is_empty())
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|| {
            dirs::document_dir()
                .unwrap_or_default()
                .join("ToolKnit")
                .join("PDF_Encrypt")
        });
    let output_dir_text = output_dir
        .to_str()
        .ok_or("pdf-encrypt:output-path".to_string())?;
    validate_pdf_encrypt_argument(output_dir_text, "pdf-encrypt:output-path")?;
    is_path_safe(&output_dir).map_err(|_| "pdf-encrypt:output-path".to_string())?;
    std::fs::create_dir_all(&output_dir)
        .map_err(|_| "pdf-encrypt:encryption-failed".to_string())?;
    is_path_safe(&output_dir).map_err(|_| "pdf-encrypt:output-path".to_string())?;
    let temporary_path = create_pdf_encrypt_temp_path(&output_dir)?;

    let result = async {
        let mut owner_password = create_pdf_encrypt_owner_password()?;
        let arguments_result = build_pdf_encrypt_qpdf_arguments(
            &input,
            &temporary_path,
            password,
            &owner_password,
            permissions,
        );
        let mut argument_payload = match arguments_result {
            Ok(payload) => payload,
            Err(error) => {
                owner_password.zeroize();
                return Err(error);
            }
        };
        let encrypt_result = run_qpdf_with_stdin(
            &qpdf_path,
            &[std::ffi::OsString::from("@-")],
            Some(&argument_payload),
            false,
            "pdf-encrypt:engine-failed",
        )
        .await;
        argument_payload.zeroize();
        owner_password.zeroize();
        let mut encryption_output = encrypt_result?;
        if !encryption_output.status.success() {
            let mapped = map_qpdf_encrypt_error(&encryption_output);
            encryption_output.stdout.zeroize();
            encryption_output.stderr.zeroize();
            return Err(if mapped == "pdf-encrypt:encryption-failed" {
                "pdf-encrypt:engine-failed".to_string()
            } else {
                mapped
            });
        }
        encryption_output.stdout.zeroize();
        encryption_output.stderr.zeroize();
        if std::fs::metadata(&temporary_path)
            .map(|metadata| metadata.len() == 0)
            .unwrap_or(true)
        {
            return Err("pdf-encrypt:output-invalid".to_string());
        }

        let mut password_input = Vec::with_capacity(password.len() + 1);
        password_input.extend_from_slice(password.as_bytes());
        password_input.push(b'\n');
        let check_result = run_qpdf_with_stdin(
            &qpdf_path,
            &[
                std::ffi::OsString::from("--password-mode=unicode"),
                std::ffi::OsString::from("--password-file=-"),
                std::ffi::OsString::from("--check"),
                temporary_path.as_os_str().to_os_string(),
            ],
            Some(&password_input),
            false,
            "pdf-encrypt:verification-failed",
        )
        .await;
        password_input.zeroize();
        let mut check_output = check_result?;
        let check_succeeded = check_output.status.success();
        check_output.stdout.zeroize();
        check_output.stderr.zeroize();
        if !check_succeeded {
            return Err("pdf-encrypt:verification-failed".to_string());
        }

        publish_pdf_encrypt_output(
            &temporary_path,
            &output_dir,
            &create_pdf_encrypt_file_name(&input),
        )
    }
    .await;
    if result.is_err() {
        let _ = std::fs::remove_file(&temporary_path);
    }
    result
}

#[cfg(test)]
mod pdf_encrypt_backend_tests {
    use super::*;

    fn test_directory() -> std::path::PathBuf {
        let suffix = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("clock must be after epoch")
            .as_nanos();
        let directory = std::env::temp_dir().join(format!(
            "toolknit-pdf-encrypt-{}-{}",
            std::process::id(),
            suffix
        ));
        std::fs::create_dir_all(&directory).expect("create PDF encryption test directory");
        directory
    }

    fn structured_pdf_fixture() -> Vec<u8> {
        let objects = [
            "<< /Type /Catalog /Pages 2 0 R /AcroForm 5 0 R >>",
            "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
            "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources <<>> /Contents 4 0 R /Annots [6 0 R] >>",
            "<< /Length 0 >>\nstream\n\nendstream",
            "<< /Fields [6 0 R] /NeedAppearances true >>",
            "<< /Type /Annot /Subtype /Widget /FT /Tx /T (customer.name) /V (ToolKnit) /Rect [48 680 268 708] /P 3 0 R >>",
            "<< /Title (ToolKnit encryption structure regression) >>",
        ];
        let mut pdf = b"%PDF-1.7\n%\xE2\xE3\xCF\xD3\n".to_vec();
        let mut offsets = Vec::with_capacity(objects.len());
        for (index, object) in objects.iter().enumerate() {
            offsets.push(pdf.len());
            pdf.extend_from_slice(format!("{} 0 obj\n{}\nendobj\n", index + 1, object).as_bytes());
        }
        let xref_offset = pdf.len();
        pdf.extend_from_slice(format!("xref\n0 {}\n", objects.len() + 1).as_bytes());
        pdf.extend_from_slice(b"0000000000 65535 f \n");
        for offset in offsets {
            pdf.extend_from_slice(format!("{:010} 00000 n \n", offset).as_bytes());
        }
        pdf.extend_from_slice(
            format!(
                "trailer\n<< /Size {} /Root 1 0 R /Info 7 0 R >>\nstartxref\n{}\n%%EOF\n",
                objects.len() + 1,
                xref_offset
            )
            .as_bytes(),
        );
        pdf
    }

    fn default_permissions() -> PdfEncryptPermissions {
        PdfEncryptPermissions {
            printing: PdfEncryptPrintingPermission::Quality("lowResolution".to_string()),
            modifying: false,
            copying: false,
            annotating: true,
            filling_forms: true,
            content_accessibility: true,
            document_assembly: false,
        }
    }

    #[test]
    fn password_contract_prevents_qpdf_truncation() {
        assert!(validate_pdf_encrypt_password("中文密码安全测试-😀").is_ok());
        assert!(validate_pdf_encrypt_password(&"x".repeat(64)).is_ok());
        assert_eq!(
            validate_pdf_encrypt_password(&"x".repeat(PDF_ENCRYPT_MAX_PASSWORD_BYTES + 1))
                .unwrap_err(),
            "pdf-encrypt:password-too-long"
        );
        assert_eq!(
            validate_pdf_encrypt_password("valid-pass\nline").unwrap_err(),
            "pdf-encrypt:password-unsupported"
        );
    }

    #[tokio::test]
    async fn qpdf_encrypts_and_decrypts_unicode_password_without_losing_catalog_data() {
        let directory = test_directory();
        let source = directory.join("source.pdf");
        std::fs::write(&source, structured_pdf_fixture()).expect("write structured PDF fixture");
        let password = format!("中文密码安全测试-😀-{}", "long-password-".repeat(4));
        assert!(password.len() > 32);
        assert!(password.len() <= PDF_ENCRYPT_MAX_PASSWORD_BYTES);

        let encrypted = encrypt_pdf_inner(
            source.to_str().expect("UTF-8 source path"),
            &password,
            &default_permissions(),
            directory.to_str(),
        )
        .await
        .expect("encrypt Unicode password PDF");
        let encrypted_path = std::path::PathBuf::from(&encrypted);
        assert!(encrypted_path.is_file());

        let qpdf_path = get_qpdf_path().expect("bundled qpdf");
        let encryption_info = run_qpdf_with_stdin(
            &qpdf_path,
            &[
                std::ffi::OsString::from("--show-encryption"),
                encrypted_path.as_os_str().to_os_string(),
            ],
            None,
            true,
            "pdf-encrypt:encryption-failed",
        )
        .await
        .expect("inspect encryption");
        let encryption_info = String::from_utf8_lossy(&encryption_info.stdout);
        assert!(encryption_info.contains("R = 6"));
        assert!(encryption_info.contains("stream encryption method: AESv3"));
        assert!(!encryption_info.contains(&password));

        let wrong_password = decrypt_pdf_inner(
            encrypted_path.to_str().expect("UTF-8 encrypted path"),
            "wrong-password",
            directory.to_str(),
        )
        .await
        .expect_err("wrong password must fail");
        assert_eq!(wrong_password, "pdf-decrypt:invalid-password");

        let decrypted = decrypt_pdf_inner(
            encrypted_path.to_str().expect("UTF-8 encrypted path"),
            &password,
            directory.to_str(),
        )
        .await
        .expect("decrypt Unicode password PDF");
        let decrypted_path = std::path::PathBuf::from(&decrypted);
        let qdf_path = directory.join("decrypted-qdf.pdf");
        let qdf_output = run_qpdf_with_stdin(
            &qpdf_path,
            &[
                std::ffi::OsString::from("--qdf"),
                std::ffi::OsString::from("--object-streams=disable"),
                decrypted_path.as_os_str().to_os_string(),
                qdf_path.as_os_str().to_os_string(),
            ],
            None,
            false,
            "pdf-encrypt:encryption-failed",
        )
        .await
        .expect("write inspectable decrypted PDF");
        assert!(qdf_output.status.success());
        let qdf_bytes = std::fs::read(&qdf_path).expect("read decrypted QDF");
        let qdf = String::from_utf8_lossy(&qdf_bytes);
        assert!(qdf.contains("/AcroForm"));
        assert!(qdf.contains("/Title (ToolKnit encryption structure regression)"));
        assert!(qdf.contains("/T (customer.name)"));

        let encrypted_again = encrypt_pdf_inner(
            source.to_str().expect("UTF-8 source path"),
            &password,
            &default_permissions(),
            directory.to_str(),
        )
        .await
        .expect("publish a unique second encryption output");
        assert_ne!(encrypted, encrypted_again);
        assert!(std::path::Path::new(&encrypted_again).is_file());
        assert!(!std::fs::read_dir(&directory)
            .expect("inspect encryption temp cleanup")
            .filter_map(Result::ok)
            .any(|entry| entry.file_name().to_string_lossy().starts_with(".toolknit-encrypt-")));

        std::fs::remove_dir_all(&directory).expect("remove PDF encryption test directory");
    }
}

#[derive(serde::Serialize)]
struct PdfCompressResult {
    original_size: u64,
    compressed_size: u64,
    output_path: Option<String>,
    output_dir: String,
}

fn create_pdf_compress_temp_path(
    output_dir: &std::path::Path,
) -> Result<std::path::PathBuf, String> {
    use std::time::{SystemTime, UNIX_EPOCH};

    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| "pdf-compress:compression-failed".to_string())?
        .as_nanos();
    for _ in 0..100 {
        let id = PDF_DECRYPT_TEMP_ID.fetch_add(1, Ordering::Relaxed);
        let candidate = output_dir.join(format!(
            ".toolknit-compress-{}-{}-{}.pdf",
            std::process::id(),
            timestamp,
            id
        ));
        if !candidate.exists() {
            return Ok(candidate);
        }
    }
    Err("pdf-compress:compression-failed".to_string())
}

fn create_pdf_compress_file_name(input_path: &std::path::Path) -> String {
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
    format!("{}_compressed.pdf", stem)
}

fn publish_pdf_compress_output(
    temporary_path: &std::path::Path,
    output_dir: &std::path::Path,
    file_name: &str,
) -> Result<String, String> {
    let file = std::path::Path::new(file_name);
    let stem = file
        .file_stem()
        .and_then(|value| value.to_str())
        .ok_or("pdf-compress:compression-failed")?;
    for counter in 0..10_000_u32 {
        let candidate_name = if counter == 0 {
            file_name.to_string()
        } else {
            format!("{}_{}.pdf", stem, counter)
        };
        let candidate = output_dir.join(candidate_name);
        match std::fs::hard_link(temporary_path, &candidate) {
            Ok(()) => {
                std::fs::remove_file(temporary_path)
                    .map_err(|_| "pdf-compress:compression-failed".to_string())?;
                return Ok(candidate.to_string_lossy().into_owned());
            }
            Err(_) if candidate.exists() => continue,
            Err(_) => return Err("pdf-compress:compression-failed".to_string()),
        }
    }
    Err("pdf-compress:compression-failed".to_string())
}

fn map_qpdf_compress_error(output: &std::process::Output) -> String {
    let details = String::from_utf8_lossy(&output.stderr).to_ascii_lowercase();
    if details.contains("invalid password") || details.contains("encrypted") {
        "pdf-compress:password-protected".to_string()
    } else if details.contains("not a pdf")
        || details.contains("damaged pdf")
        || details.contains("can't find pdf header")
    {
        "pdf-compress:invalid-pdf".to_string()
    } else {
        "pdf-compress:compression-failed".to_string()
    }
}

#[tauri::command]
async fn compress_pdf(
    input_path: String,
    level: String,
    output_dir: Option<String>,
) -> Result<PdfCompressResult, String> {
    let input = std::path::Path::new(&input_path);
    if input_path.contains('\0')
        || !input.is_file()
        || !input
            .extension()
            .and_then(|value| value.to_str())
            .is_some_and(|value| value.eq_ignore_ascii_case("pdf"))
    {
        return Err("pdf-compress:invalid-pdf".to_string());
    }
    let original_size = std::fs::metadata(input)
        .map_err(|_| "pdf-compress:invalid-pdf".to_string())?
        .len();
    if original_size > PDF_COMPRESS_MAX_INPUT_BYTES {
        return Err("pdf-compress:input-too-large".to_string());
    }
    if !matches!(level.as_str(), "low" | "medium" | "high") {
        return Err("pdf-compress:invalid-level".to_string());
    }

    let qpdf_path = get_qpdf_path().map_err(|_| "pdf-compress:qpdf-unavailable".to_string())?;
    let page_output = run_qpdf(
        &qpdf_path,
        &[
            std::ffi::OsString::from("--show-npages"),
            input.as_os_str().to_os_string(),
        ],
        None,
    )
    .await
    .map_err(|_| "pdf-compress:compression-failed".to_string())?;
    if !page_output.status.success() {
        return Err(map_qpdf_compress_error(&page_output));
    }
    let page_count = String::from_utf8_lossy(&page_output.stdout)
        .trim()
        .parse::<u32>()
        .map_err(|_| "pdf-compress:invalid-pdf".to_string())?;
    if page_count == 0 {
        return Err("pdf-compress:invalid-pdf".to_string());
    }
    if page_count > PDF_COMPRESS_MAX_PAGES {
        return Err("pdf-compress:too-many-pages".to_string());
    }

    let output_dir = output_dir
        .filter(|value| !value.trim().is_empty() && !value.contains('\0'))
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|| {
            dirs::document_dir()
                .unwrap_or_default()
                .join("ToolKnit")
                .join("PDF_Compress")
        });
    is_path_safe(&output_dir).map_err(|_| "pdf-compress:output-path".to_string())?;
    std::fs::create_dir_all(&output_dir)
        .map_err(|_| "pdf-compress:compression-failed".to_string())?;
    is_path_safe(&output_dir).map_err(|_| "pdf-compress:output-path".to_string())?;
    let temporary_path = create_pdf_compress_temp_path(&output_dir)?;
    let mut args = vec![
        std::ffi::OsString::from("--warning-exit-0"),
        std::ffi::OsString::from("--object-streams=generate"),
        std::ffi::OsString::from("--compress-streams=y"),
    ];
    if level != "low" {
        args.push(std::ffi::OsString::from("--recompress-flate"));
        args.push(std::ffi::OsString::from(if level == "high" {
            "--compression-level=9"
        } else {
            "--compression-level=6"
        }));
    }
    args.push(input.as_os_str().to_os_string());
    args.push(temporary_path.as_os_str().to_os_string());
    let output = run_qpdf(&qpdf_path, &args, None)
        .await
        .map_err(|_| "pdf-compress:compression-failed".to_string())?;
    if !output.status.success() {
        let _ = std::fs::remove_file(&temporary_path);
        return Err(map_qpdf_compress_error(&output));
    }
    let check_output = run_qpdf(
        &qpdf_path,
        &[
            std::ffi::OsString::from("--check"),
            temporary_path.as_os_str().to_os_string(),
        ],
        None,
    )
    .await
    .map_err(|_| "pdf-compress:compression-failed".to_string())?;
    if !check_output.status.success() {
        let _ = std::fs::remove_file(&temporary_path);
        return Err("pdf-compress:compression-failed".to_string());
    }
    let compressed_size = std::fs::metadata(&temporary_path)
        .map_err(|_| "pdf-compress:compression-failed".to_string())?
        .len();
    let output_path = if compressed_size < original_size {
        Some(publish_pdf_compress_output(
            &temporary_path,
            &output_dir,
            &create_pdf_compress_file_name(input),
        )?)
    } else {
        let _ = std::fs::remove_file(&temporary_path);
        None
    };
    Ok(PdfCompressResult {
        original_size,
        compressed_size,
        output_path,
        output_dir: output_dir.to_string_lossy().into_owned(),
    })
}

#[derive(serde::Serialize, Clone)]
struct ConvertProgress {
    file_name: String,
    current: usize,
    total: usize,
    progress: f64,
    status: String,
}

#[derive(serde::Serialize)]
struct BatchConvertResult {
    success_count: usize,
    fail_count: usize,
    output_dir: String,
    errors: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    original_size: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    compressed_size: Option<u64>,
}

#[derive(serde::Serialize)]
struct AudioBatchConvertResult {
    success_count: usize,
    fail_count: usize,
    output_dir: String,
    output_paths: Vec<String>,
    errors: Vec<String>,
}

fn normalize_audio_convert_quality(quality: Option<&str>) -> Result<&'static str, String> {
    match quality
        .unwrap_or("medium")
        .trim()
        .to_ascii_lowercase()
        .as_str()
    {
        "low" => Ok("low"),
        "medium" => Ok("medium"),
        "high" => Ok("high"),
        _ => Err("audio-convert:invalid-quality".to_string()),
    }
}

fn get_encoder_params(target_format: &str, quality: &str) -> (String, Vec<String>, &'static str) {
    // Returns (encoder, extra_args, extension)
    match target_format.to_uppercase().as_str() {
        "MP3" => {
            let q = match quality {
                "low" => "6",
                "high" => "2",
                _ => "4",
            };
            (
                "libmp3lame".to_string(),
                vec!["-q:a".to_string(), q.to_string()],
                ".mp3",
            )
        }
        "AAC" => {
            let q = match quality {
                "low" => "128k",
                "high" => "256k",
                _ => "192k",
            };
            (
                "aac".to_string(),
                vec![
                    "-b:a".to_string(),
                    q.to_string(),
                    "-movflags".to_string(),
                    "+faststart".to_string(),
                ],
                ".m4a",
            )
        }
        "WAV" => ("pcm_s16le".to_string(), vec![], ".wav"),
        "FLAC" => {
            let q = match quality {
                "low" => "2",
                "high" => "8",
                _ => "5",
            };
            (
                "flac".to_string(),
                vec!["-compression_level".to_string(), q.to_string()],
                ".flac",
            )
        }
        "ALAC" => (
            "alac".to_string(),
            vec!["-movflags".to_string(), "+faststart".to_string()],
            ".m4a",
        ),
        "OGG" => {
            let q = match quality {
                "low" => "3",
                "high" => "7",
                _ => "5",
            };
            (
                "libvorbis".to_string(),
                vec!["-q:a".to_string(), q.to_string()],
                ".ogg",
            )
        }
        _ => (
            "libmp3lame".to_string(),
            vec!["-q:a".to_string(), "4".to_string()],
            ".mp3",
        ),
    }
}

fn get_unique_output_path(
    output_dir: &std::path::Path,
    stem: &str,
    ext: &str,
) -> std::path::PathBuf {
    let mut path = output_dir.join(format!("{}{}", stem, ext));
    let mut counter = 1;
    while path.exists() {
        path = output_dir.join(format!("{}_{}{}", stem, counter, ext));
        counter += 1;
    }
    path
}

const AUDIO_CONVERT_MAX_INPUT_BYTES: u64 = 10 * 1024 * 1024 * 1024;
const AUDIO_CONVERT_MAX_FILES: usize = 100;

fn validate_audio_convert_inputs(
    input_paths: &[String],
) -> Result<Vec<std::path::PathBuf>, String> {
    if input_paths.is_empty() {
        return Err("audio-convert:missing-input".to_string());
    }
    if input_paths.len() > AUDIO_CONVERT_MAX_FILES {
        return Err("audio-convert:too-many-files".to_string());
    }

    let mut seen = std::collections::BTreeSet::new();
    let mut validated = Vec::with_capacity(input_paths.len());
    for input_path in input_paths {
        if input_path.contains('\0') {
            return Err("audio-convert:invalid-input".to_string());
        }
        let input = std::path::PathBuf::from(input_path);
        let metadata = std::fs::symlink_metadata(&input)
            .map_err(|_| "audio-convert:invalid-input".to_string())?;
        let extension = input
            .extension()
            .and_then(|value| value.to_str())
            .map(|value| value.to_ascii_lowercase());
        if metadata.file_type().is_symlink()
            || !metadata.is_file()
            || !matches!(
                extension.as_deref(),
                Some("mp3" | "aac" | "m4a" | "wav" | "flac" | "alac" | "ogg" | "wma")
            )
            || metadata.len() == 0
        {
            return Err("audio-convert:invalid-input".to_string());
        }
        if metadata.len() > AUDIO_CONVERT_MAX_INPUT_BYTES {
            return Err("audio-convert:input-too-large".to_string());
        }
        let canonical = input
            .canonicalize()
            .map_err(|_| "audio-convert:invalid-input".to_string())?;
        if !seen.insert(canonical.clone()) {
            return Err("audio-convert:duplicate-input".to_string());
        }
        validated.push(canonical);
    }
    Ok(validated)
}

fn validate_audio_convert_output_dir(output_dir: &str) -> Result<std::path::PathBuf, String> {
    if output_dir.trim().is_empty() || output_dir.contains('\0') {
        return Err("audio-convert:output-path".to_string());
    }
    let output_dir = std::path::PathBuf::from(output_dir);
    is_path_safe(&output_dir).map_err(|_| "audio-convert:output-path".to_string())?;
    std::fs::create_dir_all(&output_dir).map_err(|_| "audio-convert:output-path".to_string())?;
    if !output_dir.is_dir() {
        return Err("audio-convert:output-path".to_string());
    }
    is_path_safe(&output_dir).map_err(|_| "audio-convert:output-path".to_string())?;
    Ok(output_dir)
}

fn audio_convert_file_stem(input: &std::path::Path) -> String {
    let raw_stem = input
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("audio");
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
    let safe_stem: String = trimmed.chars().take(96).collect();
    if safe_stem.is_empty() {
        "audio".to_string()
    } else {
        safe_stem
    }
}

fn create_audio_convert_temp_path(
    output_dir: &std::path::Path,
    extension: &str,
) -> Result<std::path::PathBuf, String> {
    for _ in 0..10_000 {
        let id = AUDIO_CONVERT_TEMP_ID.fetch_add(1, Ordering::SeqCst);
        let candidate = output_dir.join(format!(
            ".toolknit-audio-{}-{}{}",
            std::process::id(),
            id,
            extension
        ));
        if !candidate.exists() {
            return Ok(candidate);
        }
    }
    Err("audio-convert:output-path".to_string())
}

fn publish_audio_convert_output(
    temporary_path: &std::path::Path,
    output_dir: &std::path::Path,
    source_stem: &str,
    extension: &str,
) -> Result<String, String> {
    for counter in 0..10_000_u32 {
        let file_name = if counter == 0 {
            format!("{}{}", source_stem, extension)
        } else {
            format!("{}_{}{}", source_stem, counter, extension)
        };
        let candidate = output_dir.join(file_name);
        match std::fs::hard_link(temporary_path, &candidate) {
            Ok(()) => {
                std::fs::remove_file(temporary_path)
                    .map_err(|_| "audio-convert:output-path".to_string())?;
                return Ok(candidate.to_string_lossy().into_owned());
            }
            Err(_) if candidate.exists() => continue,
            Err(_) => return Err("audio-convert:output-path".to_string()),
        }
    }
    Err("audio-convert:output-path".to_string())
}

fn compact_audio_convert_error(stderr: &str) -> String {
    let detail = stderr
        .lines()
        .rev()
        .find(|line| !line.trim().is_empty())
        .unwrap_or("FFmpeg could not convert this audio file.");
    let compact = detail.trim().chars().take(480).collect::<String>();
    if compact.is_empty() {
        "FFmpeg could not convert this audio file.".to_string()
    } else {
        compact
    }
}

async fn convert_audio_file(
    app_handle: tauri::AppHandle,
    ffmpeg_path: std::path::PathBuf,
    input: std::path::PathBuf,
    output_dir: std::path::PathBuf,
    encoder: String,
    extra_args: Vec<String>,
    extension: &'static str,
    current: usize,
    total: usize,
) -> Result<String, String> {
    use tauri::Emitter;
    use tokio::io::{AsyncBufReadExt, AsyncReadExt, BufReader};

    if CANCEL_FLAG.load(Ordering::SeqCst) {
        return Err("audio-convert:cancelled".to_string());
    }
    let file_name = input
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("audio")
        .to_string();
    let _ = app_handle.emit(
        "convert-progress",
        ConvertProgress {
            file_name: file_name.clone(),
            current,
            total,
            progress: 0.0,
            status: "preparing".to_string(),
        },
    );
    let duration = probe_video_convert_duration(&ffmpeg_path, &input)
        .await
        .unwrap_or(0.0);
    if CANCEL_FLAG.load(Ordering::SeqCst) {
        return Err("audio-convert:cancelled".to_string());
    }
    let temporary_path = create_audio_convert_temp_path(&output_dir, extension)?;
    let mut command = tokio::process::Command::new(&ffmpeg_path);
    command
        .arg("-y")
        .arg("-i")
        .arg(&input)
        .arg("-c:a")
        .arg(&encoder)
        .args(&extra_args)
        .arg("-progress")
        .arg("pipe:1")
        .arg("-nostats")
        .arg(&temporary_path)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    #[cfg(target_os = "windows")]
    {
        command.creation_flags(0x08000000);
    }

    let mut child = command
        .spawn()
        .map_err(|_| "audio-convert:failed".to_string())?;
    let child_id = match child.id() {
        Some(id) => id,
        None => {
            let _ = child.kill().await;
            let _ = std::fs::remove_file(&temporary_path);
            return Err("audio-convert:failed".to_string());
        }
    };
    CURRENT_CHILD_ID.store(child_id, Ordering::SeqCst);
    if CANCEL_FLAG.load(Ordering::SeqCst) {
        terminate_conversion_process(child_id);
    }
    let stdout = match child.stdout.take() {
        Some(stdout) => stdout,
        None => {
            terminate_conversion_process(child_id);
            let _ = child.wait().await;
            CURRENT_CHILD_ID.store(0, Ordering::SeqCst);
            let _ = std::fs::remove_file(&temporary_path);
            return Err("audio-convert:failed".to_string());
        }
    };
    let stderr = match child.stderr.take() {
        Some(stderr) => stderr,
        None => {
            terminate_conversion_process(child_id);
            let _ = child.wait().await;
            CURRENT_CHILD_ID.store(0, Ordering::SeqCst);
            let _ = std::fs::remove_file(&temporary_path);
            return Err("audio-convert:failed".to_string());
        }
    };
    let progress_app = app_handle.clone();
    let progress_name = file_name.clone();
    let progress_task = tokio::spawn(async move {
        let mut lines = BufReader::new(stdout).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            if let Some(seconds) = parse_ffmpeg_progress_seconds(&line) {
                let progress = if duration > 0.0 {
                    (seconds / duration).clamp(0.0, 0.99)
                } else {
                    0.0
                };
                let _ = progress_app.emit(
                    "convert-progress",
                    ConvertProgress {
                        file_name: progress_name.clone(),
                        current,
                        total,
                        progress,
                        status: "converting".to_string(),
                    },
                );
            }
        }
    });
    let stderr_task = tokio::spawn(async move {
        let mut bytes = Vec::new();
        let mut reader = BufReader::new(stderr);
        let _ = reader.read_to_end(&mut bytes).await;
        String::from_utf8_lossy(&bytes).into_owned()
    });
    let status = child.wait().await;
    CURRENT_CHILD_ID.store(0, Ordering::SeqCst);
    let _ = progress_task.await;
    let stderr = stderr_task.await.unwrap_or_default();

    if CANCEL_FLAG.load(Ordering::SeqCst) {
        let _ = std::fs::remove_file(&temporary_path);
        return Err("audio-convert:cancelled".to_string());
    }
    match status {
        Ok(status) if status.success() => {
            let output_size = std::fs::metadata(&temporary_path)
                .map_err(|_| "audio-convert:failed".to_string())?
                .len();
            if output_size == 0 {
                let _ = std::fs::remove_file(&temporary_path);
                return Err("audio-convert:failed".to_string());
            }
            let output_path = match publish_audio_convert_output(
                &temporary_path,
                &output_dir,
                &audio_convert_file_stem(&input),
                extension,
            ) {
                Ok(path) => path,
                Err(error) => {
                    let _ = std::fs::remove_file(&temporary_path);
                    return Err(error);
                }
            };
            let _ = app_handle.emit(
                "convert-progress",
                ConvertProgress {
                    file_name,
                    current,
                    total,
                    progress: 1.0,
                    status: "done".to_string(),
                },
            );
            Ok(output_path)
        }
        _ => {
            let _ = std::fs::remove_file(&temporary_path);
            Err(compact_audio_convert_error(&stderr))
        }
    }
}

#[tauri::command]
async fn convert_audio_batch(
    app_handle: tauri::AppHandle,
    input_paths: Vec<String>,
    output_dir: String,
    target_format: String,
    quality: Option<String>,
) -> Result<AudioBatchConvertResult, String> {
    use tauri::Emitter;

    let _conversion_guard = begin_conversion()?;
    let input_paths = validate_audio_convert_inputs(&input_paths)?;
    let output_dir = validate_audio_convert_output_dir(&output_dir)?;
    let target_format = target_format.trim().to_ascii_uppercase();
    if !matches!(
        target_format.as_str(),
        "MP3" | "AAC" | "WAV" | "FLAC" | "ALAC" | "OGG"
    ) {
        return Err("audio-convert:invalid-target-format".to_string());
    }
    let quality = normalize_audio_convert_quality(quality.as_deref())?;
    let ffmpeg_path = get_ffmpeg_path()?;
    let (encoder, extra_args, extension) = get_encoder_params(&target_format, quality);
    let total = input_paths.len();
    let mut success_count = 0usize;
    let mut fail_count = 0usize;
    let mut output_paths = Vec::with_capacity(total);
    let mut errors = Vec::new();

    for (index, input) in input_paths.into_iter().enumerate() {
        let current = index + 1;
        let file_name = input
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or("audio")
            .to_string();
        match convert_audio_file(
            app_handle.clone(),
            ffmpeg_path.clone(),
            input,
            output_dir.clone(),
            encoder.clone(),
            extra_args.clone(),
            extension,
            current,
            total,
        )
        .await
        {
            Ok(output_path) => {
                success_count += 1;
                output_paths.push(output_path);
            }
            Err(error) if error == "audio-convert:cancelled" => return Err(error),
            Err(error) => {
                fail_count += 1;
                errors.push(format!("{}: {}", file_name, error));
                let _ = app_handle.emit(
                    "convert-progress",
                    ConvertProgress {
                        file_name,
                        current,
                        total,
                        progress: 1.0,
                        status: "error".to_string(),
                    },
                );
            }
        }
    }
    Ok(AudioBatchConvertResult {
        success_count,
        fail_count,
        output_dir: output_dir.to_string_lossy().to_string(),
        output_paths,
        errors,
    })
}

#[cfg(test)]
mod audio_conversion_tests {
    use super::*;

    fn test_directory(label: &str) -> std::path::PathBuf {
        let suffix = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("clock must be after epoch")
            .as_nanos();
        let directory =
            std::env::temp_dir().join(format!("toolknit-audio-convert-{}-{}", label, suffix));
        std::fs::create_dir_all(&directory).expect("create test directory");
        directory
    }

    #[test]
    fn audio_convert_rejects_duplicate_empty_and_unsupported_inputs() {
        let directory = test_directory("validation");
        let audio = directory.join("track.m4a");
        std::fs::write(&audio, [1_u8; 32]).expect("write audio fixture");
        let audio_path = audio.to_string_lossy().into_owned();
        assert_eq!(
            validate_audio_convert_inputs(&[audio_path.clone()])
                .expect("m4a input should be accepted")
                .len(),
            1,
        );
        assert_eq!(
            validate_audio_convert_inputs(&[audio_path.clone(), audio_path])
                .expect_err("duplicate input must be rejected"),
            "audio-convert:duplicate-input",
        );

        let empty = directory.join("empty.mp3");
        std::fs::write(&empty, []).expect("write empty fixture");
        assert_eq!(
            validate_audio_convert_inputs(&[empty.to_string_lossy().into_owned()])
                .expect_err("empty input must be rejected"),
            "audio-convert:invalid-input",
        );

        let unsupported = directory.join("notes.txt");
        std::fs::write(&unsupported, [1_u8; 32]).expect("write unsupported fixture");
        assert_eq!(
            validate_audio_convert_inputs(&[unsupported.to_string_lossy().into_owned()])
                .expect_err("unsupported input must be rejected"),
            "audio-convert:invalid-input",
        );
        std::fs::remove_dir_all(&directory).expect("remove test directory");
    }

    #[test]
    fn audio_convert_uses_bounded_quality_profiles() {
        assert_eq!(
            normalize_audio_convert_quality(Some(" HIGH ")).expect("high should normalize"),
            "high"
        );
        assert_eq!(
            normalize_audio_convert_quality(None).expect("default should normalize"),
            "medium"
        );
        assert_eq!(
            normalize_audio_convert_quality(Some("192k"))
                .expect_err("raw FFmpeg arguments must be rejected"),
            "audio-convert:invalid-quality"
        );

        let mp3 = get_encoder_params("MP3", "high");
        assert_eq!(mp3.0, "libmp3lame");
        assert_eq!(mp3.1, vec!["-q:a", "2"]);
        assert_eq!(mp3.2, ".mp3");

        let aac = get_encoder_params("AAC", "low");
        assert_eq!(aac.0, "aac");
        assert_eq!(aac.1, vec!["-b:a", "128k", "-movflags", "+faststart"]);
        assert_eq!(aac.2, ".m4a");

        let wav = get_encoder_params("WAV", "low");
        assert_eq!(wav.0, "pcm_s16le");
        assert!(wav.1.is_empty());
        assert_eq!(wav.2, ".wav");
    }

    #[test]
    fn audio_convert_publication_keeps_existing_output_and_removes_temporary_file() {
        let directory = test_directory("publish");
        let existing = directory.join("track.mp3");
        let temporary = directory.join(".toolknit-audio-test.mp3");
        std::fs::write(&existing, b"original-output").expect("write existing output");
        std::fs::write(&temporary, b"new-output").expect("write temporary output");

        let published = publish_audio_convert_output(&temporary, &directory, "track", ".mp3")
            .expect("publish unique audio output");
        assert!(published.ends_with("track_1.mp3"));
        assert_eq!(
            std::fs::read(&existing).expect("read existing output"),
            b"original-output"
        );
        assert_eq!(
            std::fs::read(&published).expect("read published output"),
            b"new-output"
        );
        assert!(!temporary.exists());
        std::fs::remove_dir_all(&directory).expect("remove test directory");
    }
}

#[derive(serde::Serialize)]
struct TrimResult {
    success: bool,
    output_path: String,
    error: Option<String>,
}

#[tauri::command]
async fn trim_audio(
    input_path: String,
    output_dir: String,
    start_time: f64,
    end_time: f64,
) -> Result<TrimResult, String> {
    let _conversion_guard = begin_conversion()?;
    if !start_time.is_finite()
        || !end_time.is_finite()
        || start_time < 0.0
        || end_time <= start_time
    {
        return Err("audio-clip:invalid-selection".to_string());
    }

    let ffmpeg_path = get_ffmpeg_path()?;
    let input = validate_audio_convert_inputs(&[input_path])
        .map_err(|_| "audio-clip:invalid-input".to_string())?
        .into_iter()
        .next()
        .ok_or("audio-clip:invalid-input")?;
    let input_size = std::fs::metadata(&input)
        .map_err(|_| "audio-clip:invalid-input".to_string())?
        .len();
    if input_size > 100 * 1024 * 1024 {
        return Err("audio-clip:input-too-large".to_string());
    }
    let output_dir_path = validate_audio_convert_output_dir(&output_dir)
        .map_err(|_| "audio-clip:output-path".to_string())?;
    let source_duration = probe_video_convert_duration(&ffmpeg_path, &input)
        .await
        .filter(|duration| duration.is_finite() && *duration > 0.0)
        .ok_or("audio-clip:invalid-input")?;
    if source_duration > 20.0 * 60.0 {
        return Err("audio-clip:audio-too-long".to_string());
    }
    if start_time >= source_duration || end_time > source_duration + 0.05 {
        return Err("audio-clip:invalid-selection".to_string());
    }

    let output_stem = format!("{}_clip", audio_convert_file_stem(&input));
    let original_extension = input
        .extension()
        .and_then(|extension| extension.to_str())
        .map(|extension| format!(".{}", extension.to_ascii_lowercase()))
        .ok_or("audio-clip:invalid-input")?;
    let temporary_path = create_audio_convert_temp_path(&output_dir_path, &original_extension)
        .map_err(|_| "audio-clip:output-path".to_string())?;
    let clip_duration = end_time - start_time;

    let mut cmd = tokio::process::Command::new(&ffmpeg_path);
    cmd.arg("-y")
        .arg("-i")
        .arg(&input)
        .arg("-ss")
        .arg(start_time.to_string())
        .arg("-t")
        .arg(clip_duration.to_string())
        .arg("-c")
        .arg("copy")
        .arg(&temporary_path)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());

    #[cfg(target_os = "windows")]
    {
        cmd.creation_flags(0x08000000);
    }

    let child = cmd.spawn().map_err(|_| "audio-clip:failed".to_string())?;
    if let Some(id) = child.id() {
        CURRENT_CHILD_ID.store(id, Ordering::SeqCst);
    }
    let output = match child.wait_with_output().await {
        Ok(output) => output,
        Err(_) => {
            CURRENT_CHILD_ID.store(0, Ordering::SeqCst);
            let _ = std::fs::remove_file(&temporary_path);
            return Err("audio-clip:failed".to_string());
        }
    };
    CURRENT_CHILD_ID.store(0, Ordering::SeqCst);

    if CANCEL_FLAG.load(Ordering::SeqCst) {
        let _ = std::fs::remove_file(&temporary_path);
        return Err("audio-clip:cancelled".to_string());
    }

    let copy_succeeded = output.status.success()
        && std::fs::metadata(&temporary_path)
            .map(|metadata| metadata.len() > 0)
            .unwrap_or(false);
    if copy_succeeded {
        let output_path = match publish_audio_convert_output(
            &temporary_path,
            &output_dir_path,
            &output_stem,
            &original_extension,
        ) {
            Ok(path) => path,
            Err(error) => {
                let _ = std::fs::remove_file(&temporary_path);
                return Err(error);
            }
        };
        return Ok(TrimResult {
            success: true,
            output_path,
            error: None,
        });
    }

    let _ = std::fs::remove_file(&temporary_path);
    let mp3_temporary_path = create_audio_convert_temp_path(&output_dir_path, ".mp3")
        .map_err(|_| "audio-clip:output-path".to_string())?;
    {
        let mut cmd2 = tokio::process::Command::new(&ffmpeg_path);
        cmd2.arg("-y")
            .arg("-i")
            .arg(&input)
            .arg("-ss")
            .arg(start_time.to_string())
            .arg("-t")
            .arg((end_time - start_time).to_string())
            .arg("-c:a")
            .arg("libmp3lame")
            .arg("-q:a")
            .arg("2")
            .arg(&mp3_temporary_path)
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped());

        #[cfg(target_os = "windows")]
        {
            cmd2.creation_flags(0x08000000);
        }

        let child2 = cmd2.spawn().map_err(|_| "audio-clip:failed".to_string())?;
        if let Some(id) = child2.id() {
            CURRENT_CHILD_ID.store(id, Ordering::SeqCst);
        }
        let output2 = match child2.wait_with_output().await {
            Ok(output) => output,
            Err(_) => {
                CURRENT_CHILD_ID.store(0, Ordering::SeqCst);
                let _ = std::fs::remove_file(&mp3_temporary_path);
                return Err("audio-clip:failed".to_string());
            }
        };
        CURRENT_CHILD_ID.store(0, Ordering::SeqCst);

        if CANCEL_FLAG.load(Ordering::SeqCst) {
            let _ = std::fs::remove_file(&mp3_temporary_path);
            return Err("audio-clip:cancelled".to_string());
        }

        if output2.status.success()
            && std::fs::metadata(&mp3_temporary_path)
                .map(|metadata| metadata.len() > 0)
                .unwrap_or(false)
        {
            let output_path = match publish_audio_convert_output(
                &mp3_temporary_path,
                &output_dir_path,
                &output_stem,
                ".mp3",
            ) {
                Ok(path) => path,
                Err(error) => {
                    let _ = std::fs::remove_file(&mp3_temporary_path);
                    return Err(error);
                }
            };
            Ok(TrimResult {
                success: true,
                output_path,
                error: None,
            })
        } else {
            let _ = std::fs::remove_file(&mp3_temporary_path);
            Ok(TrimResult {
                success: false,
                output_path: String::new(),
                error: Some(compact_audio_convert_error(&String::from_utf8_lossy(
                    &output2.stderr,
                ))),
            })
        }
    }
}

#[cfg(test)]
mod audio_clip_backend_tests {
    use super::*;

    fn test_directory() -> std::path::PathBuf {
        let suffix = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("clock must be after epoch")
            .as_nanos();
        let directory = std::env::temp_dir().join(format!("toolknit-audio-clip-{}", suffix));
        std::fs::create_dir_all(&directory).expect("create test directory");
        directory
    }

    #[tokio::test]
    async fn trim_audio_publishes_unique_nonempty_outputs_with_the_requested_duration() {
        let _conversion_lock = test_conversion_lock();
        let directory = test_directory();
        let input = directory.join("tone.wav");
        let ffmpeg = get_ffmpeg_path().expect("bundled FFmpeg must be available");
        let status = tokio::process::Command::new(&ffmpeg)
            .args([
                "-hide_banner",
                "-loglevel",
                "error",
                "-y",
                "-f",
                "lavfi",
                "-i",
                "sine=frequency=440:sample_rate=48000:duration=4",
                "-c:a",
                "pcm_s16le",
            ])
            .arg(&input)
            .status()
            .await
            .expect("start FFmpeg fixture generation");
        assert!(status.success(), "generate a valid audio fixture");

        let output_directory = directory.to_string_lossy().into_owned();
        let first = trim_audio(
            input.to_string_lossy().into_owned(),
            output_directory.clone(),
            1.0,
            2.25,
        )
        .await
        .expect("first trim must succeed");
        assert!(first.success);
        assert!(
            std::fs::metadata(&first.output_path)
                .expect("inspect first output")
                .len()
                > 0
        );
        let duration =
            probe_video_convert_duration(&ffmpeg, std::path::Path::new(&first.output_path))
                .await
                .expect("read output duration");
        assert!(
            (duration - 1.25).abs() < 0.08,
            "clip duration was {duration}"
        );

        let second = trim_audio(
            input.to_string_lossy().into_owned(),
            output_directory,
            1.0,
            2.25,
        )
        .await
        .expect("second trim must succeed");
        assert!(second.success);
        assert_ne!(first.output_path, second.output_path);
        assert!(second.output_path.ends_with("tone_clip_1.wav"));
        std::fs::remove_dir_all(&directory).expect("remove test directory");
    }
}

#[tauri::command]
fn cancel_convert() -> Result<(), String> {
    CANCEL_FLAG.store(true, Ordering::SeqCst);
    let pid = CURRENT_CHILD_ID.load(Ordering::SeqCst);
    terminate_conversion_process(pid);
    CURRENT_CHILD_ID.store(0, Ordering::SeqCst);

    let video_pids: Vec<u32> = active_video_children()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .iter()
        .copied()
        .collect();
    for video_pid in video_pids {
        terminate_conversion_process(video_pid);
    }
    let office_pids: Vec<u32> = active_office_children()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .iter()
        .copied()
        .collect();
    for office_pid in office_pids {
        terminate_conversion_process(office_pid);
    }
    Ok(())
}

