
pub(crate) fn calculate_image_stitch_layout(
    dimensions: &[(u32, u32)],
    mode: &str,
    reference: &str,
    spacing_px: u32,
    scale_percent: u32,
) -> Result<ImageStitchLayout, String> {
    if dimensions.len() < 2
        || dimensions.len() > MAX_IMAGE_BATCH_FILES
        || spacing_px > 500
        || !(10..=100).contains(&scale_percent)
    {
        return Err("image-stitch:invalid-settings".to_string());
    }
    let vertical = match mode {
        "vertical" => true,
        "horizontal" => false,
        _ => return Err("image-stitch:invalid-settings".to_string()),
    };
    let axis = |dimensions: &(u32, u32)| if vertical { dimensions.0 } else { dimensions.1 };
    let chosen = match reference {
        "first" => dimensions[0],
        "smallest" => *dimensions
            .iter()
            .min_by_key(|dimensions| axis(dimensions))
            .ok_or_else(|| "image-stitch:invalid-settings".to_string())?,
        "largest" => *dimensions
            .iter()
            .max_by_key(|dimensions| axis(dimensions))
            .ok_or_else(|| "image-stitch:invalid-settings".to_string())?,
        _ => return Err("image-stitch:invalid-settings".to_string()),
    };
    let fixed = ((u64::from(axis(&chosen)) * u64::from(scale_percent) + 50) / 100).max(1);
    let sizes = dimensions
        .iter()
        .map(|(width, height)| {
            if vertical {
                let target_height = ((u64::from(*height) * fixed + u64::from(*width) / 2)
                    / u64::from(*width))
                .max(1);
                (fixed as u32, target_height as u32)
            } else {
                let target_width = ((u64::from(*width) * fixed + u64::from(*height) / 2)
                    / u64::from(*height))
                .max(1);
                (target_width as u32, fixed as u32)
            }
        })
        .collect::<Vec<_>>();
    let gap = u64::from(spacing_px) * (sizes.len() as u64 - 1);
    let width = if vertical {
        fixed
    } else {
        sizes
            .iter()
            .try_fold(gap, |sum, item| sum.checked_add(u64::from(item.0)))
            .ok_or_else(|| "image-stitch:output-too-large".to_string())?
    };
    let height = if vertical {
        sizes
            .iter()
            .try_fold(gap, |sum, item| sum.checked_add(u64::from(item.1)))
            .ok_or_else(|| "image-stitch:output-too-large".to_string())?
    } else {
        fixed
    };
    if width > 65_535 || height > 65_535 {
        return Err("image-stitch:output-too-large".to_string());
    }
    Ok(ImageStitchLayout {
        sizes,
        width: width as u32,
        height: height as u32,
    })
}

#[cfg(target_os = "windows")]
pub(crate) fn available_image_stitch_pixels() -> u64 {
    use windows::Win32::System::SystemInformation::{GlobalMemoryStatusEx, MEMORYSTATUSEX};
    let mut memory = MEMORYSTATUSEX::default();
    memory.dwLength = std::mem::size_of::<MEMORYSTATUSEX>() as u32;
    if unsafe { GlobalMemoryStatusEx(&mut memory) }.is_ok() {
        return (memory.ullAvailPhys / 12).clamp(4_000_000, 160_000_000);
    }
    80_000_000
}

#[cfg(not(target_os = "windows"))]
pub(crate) fn available_image_stitch_pixels() -> u64 {
    80_000_000
}

pub(crate) static IMAGE_STITCH_TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);
pub(crate) static IMAGE_STITCH_PDF_SESSION_COUNTER: AtomicU64 = AtomicU64::new(0);
pub(crate) static PDF_TO_IMAGE_SESSION_COUNTER: AtomicU64 = AtomicU64::new(0);
pub(crate) static PDF_TO_IMAGE_TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);

pub(crate) const IMAGE_STITCH_PDF_SESSION_ROOT: &str = "toolknit-image-stitch-pdf";
pub(crate) const PDF_TO_IMAGE_SESSION_ROOT: &str = "toolknit-pdf-to-image";
pub(crate) const PDF_TO_IMAGE_MAX_PAGE_BYTES: usize = 192 * 1024 * 1024;
pub(crate) const PDF_TO_IMAGE_MAX_SESSION_BYTES: u64 = 2 * 1024 * 1024 * 1024;
pub(crate) const PDF_TO_IMAGE_MAX_PAGES: usize = 200;
pub(crate) const PDF_TO_IMAGE_MAX_LONG_PAGES: usize = 20;
pub(crate) const PDF_TO_IMAGE_MAX_PAGES_PER_LONG_IMAGE: usize = 5;
pub(crate) const PDF_TO_IMAGE_MAX_RENDER_SIDE: u32 = 16_384;
pub(crate) const PDF_TO_IMAGE_MAX_RENDER_PIXELS: u64 = 40_000_000;
pub(crate) const PDF_TO_IMAGE_MAX_LONG_SIDE: u32 = 32_767;
pub(crate) const PDF_TO_IMAGE_MAX_LONG_PIXELS: u64 = 60_000_000;
pub(crate) const PDF_TO_IMAGE_MAX_ESTIMATED_WORKING_BYTES: u64 = 384 * 1024 * 1024;
pub(crate) struct PdfToImageJobState {
    pub(crate) cancelled: std::sync::Arc<std::sync::atomic::AtomicBool>,
    pub(crate) active: bool,
}

pub(crate) static PDF_TO_IMAGE_JOBS: std::sync::OnceLock<
    std::sync::Mutex<std::collections::BTreeMap<String, PdfToImageJobState>>,
> = std::sync::OnceLock::new();

pub(crate) fn pdf_to_image_jobs(
) -> &'static std::sync::Mutex<std::collections::BTreeMap<String, PdfToImageJobState>> {
    PDF_TO_IMAGE_JOBS.get_or_init(|| std::sync::Mutex::new(std::collections::BTreeMap::new()))
}

pub(crate) fn valid_pdf_to_image_job_id(job_id: &str) -> bool {
    !job_id.is_empty()
        && job_id.len() <= 128
        && job_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
}

pub(crate) struct PdfToImageJobGuard {
    pub(crate) job_id: String,
    pub(crate) cancelled: std::sync::Arc<std::sync::atomic::AtomicBool>,
}

impl PdfToImageJobGuard {
    pub(crate) fn register(job_id: String) -> Result<Self, String> {
        if !valid_pdf_to_image_job_id(&job_id) {
            return Err("pdf-to-image:invalid-job-id".to_string());
        }
        let mut jobs = pdf_to_image_jobs()
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let state = jobs
            .entry(job_id.clone())
            .or_insert_with(|| PdfToImageJobState {
                cancelled: std::sync::Arc::new(AtomicBool::new(false)),
                active: false,
            });
        if state.active {
            return Err("pdf-to-image:duplicate-job".to_string());
        }
        state.active = true;
        let cancelled = std::sync::Arc::clone(&state.cancelled);
        Ok(Self { job_id, cancelled })
    }
}

impl Drop for PdfToImageJobGuard {
    fn drop(&mut self) {
        let mut jobs = pdf_to_image_jobs()
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if jobs
            .get(&self.job_id)
            .is_some_and(|current| std::sync::Arc::ptr_eq(&current.cancelled, &self.cancelled))
        {
            jobs.remove(&self.job_id);
        }
    }
}

#[tauri::command]
pub(crate) fn cancel_pdf_to_image(job_id: String) -> Result<(), String> {
    if !valid_pdf_to_image_job_id(&job_id) {
        return Err("pdf-to-image:invalid-job-id".to_string());
    }
    let mut jobs = pdf_to_image_jobs()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if !jobs.contains_key(&job_id) && jobs.len() >= 128 {
        jobs.retain(|_, state| state.active || !state.cancelled.load(Ordering::SeqCst));
    }
    if !jobs.contains_key(&job_id) && jobs.len() >= 128 {
        return Err("pdf-to-image:too-many-jobs".to_string());
    }
    jobs.entry(job_id)
        .or_insert_with(|| PdfToImageJobState {
            cancelled: std::sync::Arc::new(AtomicBool::new(false)),
            active: false,
        })
        .cancelled
        .store(true, Ordering::SeqCst);
    Ok(())
}

#[derive(serde::Serialize)]
pub(crate) struct ImageStitchPdfSession {
    pub(crate) session_id: String,
    pub(crate) directory: String,
}

pub(crate) fn image_stitch_pdf_session_root() -> std::path::PathBuf {
    std::env::temp_dir().join(IMAGE_STITCH_PDF_SESSION_ROOT)
}

pub(crate) fn valid_image_stitch_session_id(session_id: &str) -> bool {
    !session_id.is_empty()
        && session_id.len() <= 96
        && session_id
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || character == '-')
}

pub(crate) fn image_stitch_pdf_session_directory(session_id: &str) -> Result<std::path::PathBuf, String> {
    if !valid_image_stitch_session_id(session_id) {
        return Err("image-stitch:invalid-pdf-session".to_string());
    }
    let root = image_stitch_pdf_session_root();
    let directory = root.join(session_id);
    let canonical_root = root
        .canonicalize()
        .map_err(|_| "image-stitch:invalid-pdf-session".to_string())?;
    let canonical_directory = directory
        .canonicalize()
        .map_err(|_| "image-stitch:invalid-pdf-session".to_string())?;
    if !canonical_directory.starts_with(canonical_root) {
        return Err("image-stitch:invalid-pdf-session".to_string());
    }
    Ok(canonical_directory)
}

pub(crate) fn cleanup_image_stitch_pdf_sessions() {
    let root = image_stitch_pdf_session_root();
    if root.is_dir() {
        let _ = std::fs::remove_dir_all(&root);
    }
}

#[tauri::command]
pub(crate) fn create_image_stitch_pdf_session() -> Result<ImageStitchPdfSession, String> {
    let root = image_stitch_pdf_session_root();
    std::fs::create_dir_all(&root)
        .map_err(|_| "image-stitch:pdf-session-create-failed".to_string())?;
    for _ in 0..10_000 {
        let counter = IMAGE_STITCH_PDF_SESSION_COUNTER.fetch_add(1, Ordering::SeqCst);
        let session_id = format!(
            "{}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos(),
            counter
        );
        let directory = root.join(&session_id);
        match std::fs::create_dir(&directory) {
            Ok(()) => {
                return Ok(ImageStitchPdfSession {
                    session_id,
                    directory: directory.to_string_lossy().into_owned(),
                });
            }
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(_) => return Err("image-stitch:pdf-session-create-failed".to_string()),
        }
    }
    Err("image-stitch:pdf-session-create-failed".to_string())
}

#[tauri::command]
pub(crate) fn write_image_stitch_pdf_page(
    session_id: String,
    page_number: u32,
    bytes: Vec<u8>,
) -> Result<String, String> {
    use std::io::Write;
    const MAX_PAGE_BYTES: usize = 20 * 1024 * 1024;
    if !(1..=100).contains(&page_number)
        || bytes.len() < 8
        || bytes.len() > MAX_PAGE_BYTES
        || bytes[..8] != [137, 80, 78, 71, 13, 10, 26, 10]
    {
        return Err("image-stitch:invalid-pdf-page".to_string());
    }
    let directory = image_stitch_pdf_session_directory(&session_id)?;
    let output_path = directory.join(format!("page_{:04}.png", page_number));
    let mut output = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&output_path)
        .map_err(|_| "image-stitch:pdf-page-write-failed".to_string())?;
    if let Err(error) = output.write_all(&bytes).and_then(|_| output.sync_all()) {
        drop(output);
        let _ = std::fs::remove_file(&output_path);
        return Err(format!("image-stitch:pdf-page-write-failed:{error}"));
    }
    drop(output);
    let valid = image::image_dimensions(&output_path)
        .map(|(width, height)| {
            width > 0 && height > 0 && u64::from(width) * u64::from(height) <= MAX_IMAGE_PIXELS
        })
        .unwrap_or(false);
    if !valid {
        let _ = std::fs::remove_file(&output_path);
        return Err("image-stitch:invalid-pdf-page".to_string());
    }
    Ok(output_path.to_string_lossy().into_owned())
}

#[tauri::command]
pub(crate) fn discard_image_stitch_pdf_session(session_id: String) -> Result<(), String> {
    let directory = image_stitch_pdf_session_directory(&session_id)?;
    std::fs::remove_dir_all(directory)
        .map_err(|_| "image-stitch:pdf-session-cleanup-failed".to_string())
}

pub(crate) struct ImageStitchTemporaryFile {
    pub(crate) path: std::path::PathBuf,
    pub(crate) published: bool,
}

impl ImageStitchTemporaryFile {
    pub(crate) fn new(directory: &std::path::Path) -> Self {
        let counter = IMAGE_STITCH_TEMP_COUNTER.fetch_add(1, Ordering::Relaxed);
        Self {
            path: directory.join(format!(
                ".toolknit-stitch-{}-{}-{}.tmp",
                std::process::id(),
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_nanos(),
                counter
            )),
            published: false,
        }
    }
}

impl Drop for ImageStitchTemporaryFile {
    fn drop(&mut self) {
        if !self.published {
            let _ = std::fs::remove_file(&self.path);
        }
    }
}

pub(crate) fn publish_image_stitch_output(
    temporary: &mut ImageStitchTemporaryFile,
    directory: &std::path::Path,
    output_name: Option<&str>,
    extension: &str,
) -> Result<String, String> {
    let stem = normalize_image_stitch_output_name(output_name)?;
    for index in 0..10_000u32 {
        let suffix = if index == 0 {
            String::new()
        } else {
            format!("_{}", index)
        };
        let target = directory.join(format!("{}{}{}", stem, suffix, extension));
        match std::fs::hard_link(&temporary.path, &target) {
            Ok(()) => {
                std::fs::remove_file(&temporary.path)
                    .map_err(|_| "image-stitch:output-path".to_string())?;
                temporary.published = true;
                return Ok(target.to_string_lossy().into_owned());
            }
            Err(_) if target.exists() => continue,
            Err(_) => return Err("image-stitch:output-path".to_string()),
        }
    }
    Err("image-stitch:output-path".to_string())
}

pub(crate) fn normalize_image_stitch_output_name(value: Option<&str>) -> Result<String, String> {
    let value = value.unwrap_or("stitched_image").trim();
    if value.is_empty()
        || value.chars().count() > 96
        || value == "."
        || value == ".."
        || value.chars().any(|character| {
            character.is_control()
                || matches!(
                    character,
                    '\\' | '/' | ':' | '*' | '?' | '"' | '<' | '>' | '|'
                )
        })
        || value.ends_with([' ', '.'])
    {
        return Err("image-stitch:invalid-output-name".to_string());
    }
    let reserved = value
        .split('.')
        .next()
        .unwrap_or(value)
        .trim_end()
        .to_ascii_uppercase();
    if matches!(reserved.as_str(), "CON" | "PRN" | "AUX" | "NUL")
        || (reserved.len() == 4
            && (reserved.starts_with("COM") || reserved.starts_with("LPT"))
            && matches!(reserved.as_bytes()[3], b'1'..=b'9'))
    {
        return Err("image-stitch:invalid-output-name".to_string());
    }
    Ok(value.to_string())
}

pub(crate) fn encode_image_stitch(
    canvas: &image::RgbaImage,
    temporary: &std::path::Path,
    format: &str,
    jpeg_quality: u8,
) -> Result<(), String> {
    use image::ImageEncoder;
    use std::io::{BufWriter, Write};
    let file = std::fs::OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(temporary)
        .map_err(|_| "image-stitch:output-path".to_string())?;
    let mut writer = BufWriter::new(file);
    if format == "jpg" {
        let rgb = image::DynamicImage::ImageRgba8(canvas.clone()).to_rgb8();
        image::codecs::jpeg::JpegEncoder::new_with_quality(&mut writer, jpeg_quality)
            .encode(
                &rgb,
                canvas.width(),
                canvas.height(),
                image::ExtendedColorType::Rgb8,
            )
            .map_err(|_| "image-stitch:encode-failed".to_string())?;
    } else if format == "webp" {
        image::codecs::webp::WebPEncoder::new_lossless(&mut writer)
            .encode(
                canvas.as_raw(),
                canvas.width(),
                canvas.height(),
                image::ExtendedColorType::Rgba8,
            )
            .map_err(|_| "image-stitch:encode-failed".to_string())?;
    } else {
        image::codecs::png::PngEncoder::new(&mut writer)
            .write_image(
                canvas.as_raw(),
                canvas.width(),
                canvas.height(),
                image::ExtendedColorType::Rgba8,
            )
            .map_err(|_| "image-stitch:encode-failed".to_string())?;
    }
    writer
        .flush()
        .map_err(|_| "image-stitch:output-path".to_string())?;
    writer
        .get_ref()
        .sync_all()
        .map_err(|_| "image-stitch:output-path".to_string())
}

pub(crate) fn stitch_images_blocking<F>(
    options: ImageStitchOptions,
    mut progress: F,
) -> Result<ImageStitchResult, String>
where
    F: FnMut(&str, usize, usize, u8),
{
    validate_image_batch_inputs(&options.input_paths)?;
    if options.input_paths.len() < 2
        || !(60..=100).contains(&options.jpeg_quality)
        || !matches!(options.format.as_str(), "png" | "jpg" | "webp")
    {
        return Err("image-stitch:invalid-settings".to_string());
    }
    let background = stitch_background(&options.background_rgba)?;
    let canvas_background = if options.format == "jpg" {
        image::Rgba([background.0[0], background.0[1], background.0[2], 255])
    } else {
        background
    };
    let output_directory = validate_image_output_dir(&options.output_dir)?;
    let inputs = options
        .input_paths
        .iter()
        .map(std::path::PathBuf::from)
        .collect::<Vec<_>>();
    progress("prepare", 0, inputs.len(), 2);

    let mut dimensions = Vec::with_capacity(inputs.len());
    for (index, input) in inputs.iter().enumerate() {
        if CANCEL_FLAG.load(Ordering::SeqCst) {
            return Err("image-stitch:cancelled".to_string());
        }
        dimensions.push(oriented_image_dimensions(input)?);
        progress(
            "inspect",
            index + 1,
            inputs.len(),
            10 + ((index + 1) * 15 / inputs.len()) as u8,
        );
    }

    let layout = calculate_image_stitch_layout(
        &dimensions,
        &options.mode,
        &options.reference,
        options.spacing_px,
        options.scale_percent,
    )?;
    let pixels = u64::from(layout.width)
        .checked_mul(u64::from(layout.height))
        .ok_or_else(|| "image-stitch:output-too-large".to_string())?;
    if pixels > available_image_stitch_pixels() {
        return Err("image-stitch:output-too-large-for-memory".to_string());
    }

    let mut canvas = image::RgbaImage::from_pixel(layout.width, layout.height, canvas_background);
    let vertical = options.mode == "vertical";
    let mut cursor = 0u32;
    for (index, (input, (width, height))) in inputs.iter().zip(layout.sizes.iter()).enumerate() {
        if CANCEL_FLAG.load(Ordering::SeqCst) {
            return Err("image-stitch:cancelled".to_string());
        }
        let resized = read_oriented_image(input)?
            .resize_exact(*width, *height, image::imageops::FilterType::Lanczos3)
            .to_rgba8();
        image::imageops::overlay(
            &mut canvas,
            &resized,
            if vertical { 0 } else { i64::from(cursor) },
            if vertical { i64::from(cursor) } else { 0 },
        );
        cursor = cursor
            .saturating_add(if vertical { *height } else { *width })
            .saturating_add(options.spacing_px);
        progress(
            "compose",
            index + 1,
            inputs.len(),
            25 + ((index + 1) * 60 / inputs.len()) as u8,
        );
    }

    if CANCEL_FLAG.load(Ordering::SeqCst) {
        return Err("image-stitch:cancelled".to_string());
    }
    progress("encode", inputs.len(), inputs.len(), 88);
    let mut temporary = ImageStitchTemporaryFile::new(&output_directory);
    encode_image_stitch(
        &canvas,
        &temporary.path,
        &options.format,
        options.jpeg_quality,
    )?;
    if CANCEL_FLAG.load(Ordering::SeqCst) {
        return Err("image-stitch:cancelled".to_string());
    }
    let extension = match options.format.as_str() {
        "png" => ".png",
        "jpg" => ".jpg",
        "webp" => ".webp",
        _ => unreachable!("validated image stitch format"),
    };
    let output_path = publish_image_stitch_output(
        &mut temporary,
        &output_directory,
        options.output_name.as_deref(),
        extension,
    )?;
    progress("complete", inputs.len(), inputs.len(), 100);
    Ok(ImageStitchResult {
        output_path,
        width: layout.width,
        height: layout.height,
        count: inputs.len(),
        format: options.format.to_ascii_uppercase(),
    })
}

#[tauri::command]
pub(crate) async fn inspect_image_stitch_inputs(
    input_paths: Vec<String>,
) -> Result<Vec<ImageStitchInputPreview>, String> {
    tokio::task::spawn_blocking(move || {
        use base64::Engine;
        use image::ImageEncoder;
        validate_image_batch_inputs(&input_paths)?;
        input_paths
            .iter()
            .map(|input_path| {
                let path = std::path::PathBuf::from(input_path);
                let decoded = read_oriented_image(&path)?;
                let thumbnail = decoded.thumbnail(180, 180).to_rgba8();
                let preview = decoded.thumbnail(960, 960).to_rgba8();
                let mut thumbnail_bytes = Vec::new();
                image::codecs::png::PngEncoder::new(&mut thumbnail_bytes)
                    .write_image(
                        thumbnail.as_raw(),
                        thumbnail.width(),
                        thumbnail.height(),
                        image::ExtendedColorType::Rgba8,
                    )
                    .map_err(|_| "image-stitch:thumbnail-failed".to_string())?;
                let mut preview_bytes = Vec::new();
                image::codecs::png::PngEncoder::new(&mut preview_bytes)
                    .write_image(
                        preview.as_raw(),
                        preview.width(),
                        preview.height(),
                        image::ExtendedColorType::Rgba8,
                    )
                    .map_err(|_| "image-stitch:thumbnail-failed".to_string())?;
                Ok(ImageStitchInputPreview {
                    path: input_path.clone(),
                    name: path
                        .file_name()
                        .and_then(|name| name.to_str())
                        .unwrap_or("image")
                        .to_string(),
                    width: decoded.width(),
                    height: decoded.height(),
                    thumbnail_data_url: format!(
                        "data:image/png;base64,{}",
                        base64::engine::general_purpose::STANDARD.encode(thumbnail_bytes)
                    ),
                    preview_data_url: format!(
                        "data:image/png;base64,{}",
                        base64::engine::general_purpose::STANDARD.encode(preview_bytes)
                    ),
                })
            })
            .collect::<Result<Vec<_>, String>>()
    })
    .await
    .map_err(|error| format!("image-stitch:worker-failed:{error}"))?
}

#[tauri::command]
pub(crate) async fn stitch_images(
    app_handle: tauri::AppHandle,
    input_paths: Vec<String>,
    output_dir: String,
    output_name: Option<String>,
    mode: String,
    reference: String,
    spacing_px: u32,
    scale_percent: u32,
    format: String,
    jpeg_quality: u8,
    background_rgba: String,
    job_id: Option<String>,
) -> Result<ImageStitchResult, String> {
    let _guard = begin_conversion()?;
    tokio::task::spawn_blocking(move || {
        let job_id = job_id.unwrap_or_else(|| "desktop".to_string());
        stitch_images_blocking(
            ImageStitchOptions {
                input_paths,
                output_dir,
                output_name,
                mode,
                reference,
                spacing_px,
                scale_percent,
                format,
                jpeg_quality,
                background_rgba,
            },
            |phase, current, total, percent| {
                let _ = app_handle.emit(
                    "image-stitch-progress",
                    serde_json::json!({
                        "jobId": job_id,
                        "phase": phase,
                        "current": current,
                        "total": total,
                        "percent": percent
                    }),
                );
            },
        )
    })
    .await
    .map_err(|error| format!("image-stitch:worker-failed:{error}"))?
}

#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PdfToImageSession {
    pub(crate) session_id: String,
    pub(crate) directory: String,
}

#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PdfToImagePageWriteResult {
    pub(crate) page_number: u32,
    pub(crate) path: String,
    pub(crate) width: u32,
    pub(crate) height: u32,
    pub(crate) byte_length: u64,
}

#[derive(Clone, Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PdfToImageExportRequest {
    pub(crate) session_id: String,
    #[serde(rename = "pages", alias = "pageNumbers")]
    pub(crate) page_numbers: Vec<u32>,
    pub(crate) page_count: u32,
    pub(crate) output_dir: String,
    pub(crate) output_name: Option<String>,
    pub(crate) format: String,
    #[serde(rename = "mode", alias = "exportMode")]
    pub(crate) export_mode: String,
    pub(crate) pages_per_long_image: Option<u8>,
    pub(crate) jpeg_quality: Option<u8>,
    pub(crate) background_rgba: Option<String>,
    pub(crate) job_id: Option<String>,
}

#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PdfToImageExportItem {
    pub(crate) output_path: String,
    pub(crate) width: u32,
    pub(crate) height: u32,
    pub(crate) page_numbers: Vec<u32>,
}

#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PdfToImageExportResult {
    pub(crate) output_dir: String,
    pub(crate) outputs: Vec<PdfToImageExportItem>,
    pub(crate) output_count: usize,
    pub(crate) page_count: usize,
    pub(crate) format: String,
    pub(crate) export_mode: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum PdfToImageExportMode {
    Pages,
    Long,
}

#[derive(Clone, Debug)]
pub(crate) struct PdfToImageSourcePage {
    pub(crate) page_number: u32,
    pub(crate) path: std::path::PathBuf,
    pub(crate) width: u32,
    pub(crate) height: u32,
}

pub(crate) struct PdfToImageTemporaryFile {
    pub(crate) path: std::path::PathBuf,
}

impl PdfToImageTemporaryFile {
    pub(crate) fn new(directory: &std::path::Path) -> Self {
        let counter = PDF_TO_IMAGE_TEMP_COUNTER.fetch_add(1, Ordering::Relaxed);
        Self {
            path: directory.join(format!(
                ".toolknit-pdf-image-{}-{}-{}.tmp",
                std::process::id(),
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_nanos(),
                counter
            )),
        }
    }
}

impl Drop for PdfToImageTemporaryFile {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.path);
    }
}

pub(crate) struct PdfToImagePreparedOutput {
    pub(crate) temporary: PdfToImageTemporaryFile,
    pub(crate) logical_stem: String,
    pub(crate) extension: String,
    pub(crate) width: u32,
    pub(crate) height: u32,
    pub(crate) page_numbers: Vec<u32>,
}
