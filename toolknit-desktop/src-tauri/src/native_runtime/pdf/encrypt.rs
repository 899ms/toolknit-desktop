pub(crate) fn pdf_encrypt_permission_default() -> bool {
    true
}

pub(crate) fn validate_pdf_encrypt_password(password: &str) -> Result<(), String> {
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

pub(crate) fn pdf_encrypt_print_option(
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

pub(crate) fn pdf_encrypt_yes_no(value: bool) -> &'static str {
    if value {
        "y"
    } else {
        "n"
    }
}

pub(crate) fn validate_pdf_encrypt_argument(value: &str, error_code: &str) -> Result<(), String> {
    if value
        .chars()
        .any(|character| matches!(character, '\0' | '\r' | '\n'))
    {
        Err(error_code.to_string())
    } else {
        Ok(())
    }
}

pub(crate) fn append_pdf_encrypt_argument(
    payload: &mut Vec<u8>,
    value: &str,
    error_code: &str,
) -> Result<(), String> {
    validate_pdf_encrypt_argument(value, error_code)?;
    payload.extend_from_slice(value.as_bytes());
    payload.push(b'\n');
    Ok(())
}

pub(crate) fn append_pdf_encrypt_option(
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

pub(crate) fn create_pdf_encrypt_owner_password() -> Result<String, String> {
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

pub(crate) fn create_pdf_encrypt_file_name(input_path: &std::path::Path) -> String {
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

pub(crate) fn create_pdf_encrypt_temp_path(
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

pub(crate) fn publish_pdf_encrypt_output(
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

pub(crate) fn map_qpdf_encrypt_error(output: &std::process::Output) -> String {
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

pub(crate) fn build_pdf_encrypt_qpdf_arguments(
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
pub(crate) async fn encrypt_pdf(
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

pub(crate) async fn encrypt_pdf_inner(
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
pub(crate) struct PdfCompressResult {
    pub(crate) original_size: u64,
    pub(crate) compressed_size: u64,
    pub(crate) output_path: Option<String>,
    pub(crate) output_dir: String,
}
