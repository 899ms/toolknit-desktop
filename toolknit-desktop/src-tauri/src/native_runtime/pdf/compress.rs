pub(crate) fn create_pdf_compress_temp_path(
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

pub(crate) fn create_pdf_compress_file_name(input_path: &std::path::Path) -> String {
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

pub(crate) fn publish_pdf_compress_output(
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

pub(crate) fn map_qpdf_compress_error(output: &std::process::Output) -> String {
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
pub(crate) async fn compress_pdf(
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
pub(crate) struct ConvertProgress {
    pub(crate) file_name: String,
    pub(crate) current: usize,
    pub(crate) total: usize,
    pub(crate) progress: f64,
    pub(crate) status: String,
}

#[derive(serde::Serialize)]
pub(crate) struct BatchConvertResult {
    pub(crate) success_count: usize,
    pub(crate) fail_count: usize,
    pub(crate) output_dir: String,
    pub(crate) errors: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) original_size: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) compressed_size: Option<u64>,
}

#[derive(serde::Serialize)]
pub(crate) struct AudioBatchConvertResult {
    pub(crate) success_count: usize,
    pub(crate) fail_count: usize,
    pub(crate) output_dir: String,
    pub(crate) output_paths: Vec<String>,
    pub(crate) errors: Vec<String>,
}
