use std::collections::BTreeMap;
use std::io::Write;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

const CHUNK_LIMIT: usize = 2 * 1024 * 1024;
static WRITES: OnceLock<Mutex<BTreeMap<u64, Arc<CompressWrite>>>> = OnceLock::new();
static WRITE_ID: AtomicU64 = AtomicU64::new(1);

struct WriteData {
    file: Option<std::fs::File>,
    path: std::path::PathBuf,
    directory: std::path::PathBuf,
    name: String,
    expected_pages: u32,
    expected_bytes: u64,
    written: u64,
    _guard: ConversionGuard,
}

impl Drop for WriteData {
    fn drop(&mut self) {
        self.file.take();
        let _ = std::fs::remove_file(&self.path);
    }
}

struct WriteState {
    data: Option<WriteData>,
    cancelled: bool,
    committed: bool,
}

struct CompressWrite {
    state: Mutex<WriteState>,
    deadline: Instant,
    expiry: Mutex<Option<tokio::task::AbortHandle>>,
}

impl Drop for CompressWrite {
    fn drop(&mut self) {
        if let Some(expiry) = self.expiry.lock().unwrap_or_else(|e| e.into_inner()).take() {
            expiry.abort();
        }
    }
}

fn writes() -> &'static Mutex<BTreeMap<u64, Arc<CompressWrite>>> {
    WRITES.get_or_init(|| Mutex::new(BTreeMap::new()))
}

fn write_session(id: u64) -> Result<Arc<CompressWrite>, String> {
    writes()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .get(&id)
        .cloned()
        .ok_or_else(|| "pdf-compress:write-session".into())
}

#[tauri::command]
pub(crate) async fn begin_pdf_compress_write(
    input_path: String,
    directory: String,
    expected_bytes: u64,
    target_bytes: Option<u64>,
) -> Result<u64, String> {
    let guard = begin_conversion().map_err(|_| "pdf-compress:busy")?;
    super::compress::compression_target_bytes(None, target_bytes)?;
    let input = std::path::PathBuf::from(&input_path);
    let meta = std::fs::symlink_metadata(&input).map_err(|_| "pdf-compress:invalid-pdf")?;
    if !input.is_absolute()
        || !meta.is_file()
        || meta.file_type().is_symlink()
        || meta.len() == 0
        || meta.len() > PDF_COMPRESS_MAX_INPUT_BYTES
    {
        return Err("pdf-compress:invalid-pdf".into());
    }
    if expected_bytes == 0
        || expected_bytes >= meta.len()
        || target_bytes.is_some_and(|cap| expected_bytes > cap)
    {
        return Err("pdf-compress:output-invalid".into());
    }
    let qpdf = get_qpdf_path().map_err(|_| "pdf-compress:qpdf-unavailable")?;
    let page_args = ["--show-npages".into(), input.as_os_str().into()];
    let pages = tokio::time::timeout(
        Duration::from_secs(15),
        super::compress::run_compress_qpdf(&qpdf, &page_args),
    )
    .await
    .map_err(|_| "pdf-compress:timeout")??;
    let expected_pages = super::compress::parse_pdf_compress_page_count(&pages)?;
    if expected_pages > PDF_COMPRESS_MAX_PAGES {
        return Err("pdf-compress:too-many-pages".into());
    }
    let directory = std::path::PathBuf::from(directory);
    is_path_safe(&directory).map_err(|_| "pdf-compress:output-path")?;
    std::fs::create_dir_all(&directory).map_err(|_| "pdf-compress:output-path")?;
    let directory = directory
        .canonicalize()
        .map_err(|_| "pdf-compress:output-path")?;
    is_path_safe(&directory).map_err(|_| "pdf-compress:output-path")?;
    let path = create_pdf_compress_temp_path(&directory)?;
    let file = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&path)
        .map_err(|_| "pdf-compress:output-path")?;
    let id = WRITE_ID.fetch_add(1, Ordering::SeqCst);
    let session = Arc::new(CompressWrite {
        state: Mutex::new(WriteState {
            data: Some(WriteData {
                file: Some(file),
                path,
                directory,
                name: create_pdf_compress_file_name(&input),
                expected_pages,
                expected_bytes,
                written: 0,
                _guard: guard,
            }),
            cancelled: false,
            committed: false,
        }),
        deadline: Instant::now() + Duration::from_secs(180),
        expiry: Mutex::new(None),
    });
    writes()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .insert(id, session.clone());
    let expiry = tokio::spawn(async move {
        tokio::time::sleep(Duration::from_secs(180)).await;
        let _ = discard_pdf_compress_write(id);
    });
    *session.expiry.lock().unwrap_or_else(|e| e.into_inner()) = Some(expiry.abort_handle());
    Ok(id)
}

#[tauri::command]
pub(crate) async fn append_pdf_compress_chunk(
    session_id: u64,
    offset: u64,
    bytes: Vec<u8>,
) -> Result<(), String> {
    if bytes.is_empty() || bytes.len() > CHUNK_LIMIT {
        return Err("pdf-compress:output-invalid".into());
    }
    tokio::task::spawn_blocking(move || {
        let session = write_session(session_id)?;
        let mut state = session.state.lock().unwrap_or_else(|e| e.into_inner());
        if state.cancelled || Instant::now() >= session.deadline {
            return Err("pdf-compress:cancelled".into());
        }
        let data = state.data.as_mut().ok_or("pdf-compress:write-session")?;
        if data.written != offset || bytes.len() as u64 > data.expected_bytes.saturating_sub(offset)
        {
            return Err("pdf-compress:output-invalid".into());
        }
        data.file
            .as_mut()
            .ok_or("pdf-compress:write-session")?
            .write_all(&bytes)
            .map_err(|_| "pdf-compress:output-path")?;
        data.written += bytes.len() as u64;
        Ok(())
    })
    .await
    .map_err(|_| "pdf-compress:output-path".to_string())?
}

#[tauri::command]
pub(crate) async fn finalize_pdf_compress_write(session_id: u64) -> Result<String, String> {
    let session = write_session(session_id)?;
    let mut data = session
        .state
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .data
        .take()
        .ok_or("pdf-compress:write-session")?;
    let result = async {
        data.file
            .take()
            .ok_or("pdf-compress:write-session")?
            .sync_all()
            .map_err(|_| "pdf-compress:output-path")?;
        if data.written != data.expected_bytes
            || std::fs::metadata(&data.path)
                .map_err(|_| "pdf-compress:output-path")?
                .len()
                != data.expected_bytes
        {
            return Err("pdf-compress:output-invalid".into());
        }
        let qpdf = get_qpdf_path().map_err(|_| "pdf-compress:qpdf-unavailable")?;
        let qpdf_path = std::path::PathBuf::from(cleanup_display_path(&data.path));
        let check = super::compress::run_compress_qpdf(
            &qpdf,
            &[
                "--warning-exit-0".into(),
                "--check".into(),
                qpdf_path.as_os_str().into(),
            ],
        )
        .await?;
        if !check.status.success() {
            return Err("pdf-compress:output-invalid".into());
        }
        let pages = super::compress::run_compress_qpdf(
            &qpdf,
            &["--show-npages".into(), qpdf_path.as_os_str().into()],
        )
        .await?;
        if super::compress::parse_pdf_compress_page_count(&pages)? != data.expected_pages {
            return Err("pdf-compress:output-invalid".into());
        }
        let mut state = session.state.lock().unwrap_or_else(|e| e.into_inner());
        if state.cancelled || Instant::now() >= session.deadline {
            return Err("pdf-compress:cancelled".into());
        }
        let path = publish_pdf_compress_output(&data.path, &data.directory, &data.name)?;
        state.committed = true;
        Ok(path)
    }
    .await;
    writes()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .remove(&session_id);
    result
}

#[tauri::command]
pub(crate) fn discard_pdf_compress_write(session_id: u64) -> Result<(), String> {
    let session = writes()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .remove(&session_id);
    if let Some(session) = session {
        let mut state = session.state.lock().unwrap_or_else(|e| e.into_inner());
        if !state.committed {
            state.cancelled = true;
            CANCEL_FLAG.store(true, Ordering::SeqCst);
            terminate_conversion_process(CURRENT_CHILD_ID.load(Ordering::SeqCst));
            state.data.take();
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pdf_fixture(padding: usize) -> Vec<u8> {
        let mut objects = vec![
            "<< /Type /Catalog /Pages 2 0 R >>".to_string(),
            "<< /Type /Pages /Kids [3 0 R] /Count 1 >>".to_string(),
            "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] /Resources << >> >>".to_string(),
        ];
        if padding > 0 {
            objects.push(format!(
                "<< /Length {} >>\nstream\n{}\nendstream",
                padding,
                "A".repeat(padding)
            ));
        }
        let mut bytes = b"%PDF-1.7\n".to_vec();
        let mut offsets = Vec::new();
        for (index, object) in objects.iter().enumerate() {
            offsets.push(bytes.len());
            bytes
                .extend_from_slice(format!("{} 0 obj\n{}\nendobj\n", index + 1, object).as_bytes());
        }
        let xref = bytes.len();
        bytes.extend_from_slice(
            format!("xref\n0 {}\n0000000000 65535 f \n", objects.len() + 1).as_bytes(),
        );
        for offset in offsets {
            bytes.extend_from_slice(format!("{:010} 00000 n \n", offset).as_bytes());
        }
        bytes.extend_from_slice(
            format!(
                "trailer\n<< /Size {} /Root 1 0 R >>\nstartxref\n{}\n%%EOF\n",
                objects.len() + 1,
                xref
            )
            .as_bytes(),
        );
        bytes
    }

    struct Fixture(std::path::PathBuf);
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }
    fn fixture() -> Fixture {
        let root = std::env::temp_dir().join(format!(
            "toolknit-compress-write-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir(&root).unwrap();
        Fixture(root)
    }

    #[test]
    fn compression_target_limits_are_exact_bytes() {
        assert_eq!(
            super::super::compress::compression_target_bytes(Some(5), None).unwrap(),
            Some(5 * 1024 * 1024)
        );
        assert_eq!(
            super::super::compress::compression_target_bytes(None, Some(51200)).unwrap(),
            Some(51200)
        );
        assert!(super::super::compress::compression_target_bytes(None, Some(51199)).is_err());
        assert!(
            super::super::compress::compression_target_bytes(Some(5), Some(6 * 1024 * 1024))
                .is_err()
        );
    }

    #[tokio::test]
    async fn compression_write_validates_size_pages_and_publishes_unique_files() {
        let _lock = test_conversion_lock();
        let fixture = fixture();
        let input = fixture.0.join("source.pdf");
        let original = pdf_fixture(100_000);
        std::fs::write(&input, &original).unwrap();
        let input = input.canonicalize().unwrap();
        let candidate = pdf_fixture(0);
        let mut outputs = Vec::new();
        for _ in 0..2 {
            let id = begin_pdf_compress_write(
                input.to_string_lossy().into(),
                fixture.0.to_string_lossy().into(),
                candidate.len() as u64,
                Some(51200),
            )
            .await
            .unwrap();
            assert!(append_pdf_compress_chunk(id, 1, candidate.clone())
                .await
                .is_err());
            append_pdf_compress_chunk(id, 0, candidate.clone())
                .await
                .unwrap();
            let output = finalize_pdf_compress_write(id).await.unwrap();
            assert_eq!(
                std::fs::metadata(&output).unwrap().len(),
                candidate.len() as u64
            );
            outputs.push(output);
        }
        assert_ne!(outputs[0], outputs[1]);
        assert_eq!(std::fs::read(&input).unwrap(), original);
        assert!(writes().lock().unwrap().is_empty());
        assert!(!IS_CONVERTING.load(Ordering::SeqCst));
        assert!(!std::fs::read_dir(&fixture.0)
            .unwrap()
            .flatten()
            .any(|entry| entry
                .file_name()
                .to_string_lossy()
                .starts_with(".toolknit-compress-")));
    }

    #[tokio::test]
    async fn compression_write_rejects_invalid_output_and_cleans_cancelled_sessions() {
        let _lock = test_conversion_lock();
        let fixture = fixture();
        let input = fixture.0.join("source.pdf");
        std::fs::write(&input, pdf_fixture(100_000)).unwrap();
        assert!(begin_pdf_compress_write(
            input.to_string_lossy().into(),
            fixture.0.to_string_lossy().into(),
            60000,
            Some(51200)
        )
        .await
        .is_err());
        let begin = || {
            begin_pdf_compress_write(
                input.to_string_lossy().into(),
                fixture.0.to_string_lossy().into(),
                12,
                None,
            )
        };
        let id = begin().await.unwrap();
        append_pdf_compress_chunk(id, 0, b"not a pdf!!!".to_vec())
            .await
            .unwrap();
        assert!(finalize_pdf_compress_write(id).await.is_err());
        let id = begin().await.unwrap();
        append_pdf_compress_chunk(id, 0, b"partial".to_vec())
            .await
            .unwrap();
        discard_pdf_compress_write(id).unwrap();
        discard_pdf_compress_write(id).unwrap();
        assert!(!IS_CONVERTING.load(Ordering::SeqCst));
        let id = begin().await.unwrap();
        let session = write_session(id).unwrap();
        let data = session.state.lock().unwrap().data.take();
        discard_pdf_compress_write(id).unwrap();
        assert!(session.state.lock().unwrap().cancelled);
        assert!(
            IS_CONVERTING.load(Ordering::SeqCst),
            "a finalizing write retains ownership until its work stops"
        );
        drop(data);
        assert!(!IS_CONVERTING.load(Ordering::SeqCst));
        assert_eq!(std::fs::read_dir(&fixture.0).unwrap().count(), 1);
    }
}
