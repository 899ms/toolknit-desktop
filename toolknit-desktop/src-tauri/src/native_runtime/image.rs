// ===== Image Conversion =====

#[tauri::command]
async fn convert_image_batch(
    app_handle: tauri::AppHandle,
    input_paths: Vec<String>,
    output_dir: String,
    target_format: String,
) -> Result<BatchConvertResult, String> {
    let _conversion_guard = begin_conversion()?;
    tokio::task::spawn_blocking(move || {
        convert_image_batch_blocking(app_handle, input_paths, output_dir, target_format)
    })
    .await
    .map_err(|error| format!("Image conversion worker failed: {}", error))?
}

fn validate_image_batch_request(input_paths: &[String]) -> Result<(), String> {
    if input_paths.is_empty() {
        return Err("Select at least one image file".to_string());
    }
    if input_paths.len() > MAX_IMAGE_BATCH_FILES {
        return Err(format!(
            "A batch can contain at most {} image files",
            MAX_IMAGE_BATCH_FILES
        ));
    }
    Ok(())
}

fn validate_image_batch_input(input_path: &str) -> Result<(std::path::PathBuf, String), String> {
    if input_path.contains('\0') {
        return Err("An image input path is invalid".to_string());
    }
    let input = std::path::Path::new(input_path);
    let file_name = input
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("input image");
    let extension = input
        .extension()
        .and_then(|extension| extension.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    if !matches!(
        extension.as_str(),
        "jpg" | "jpeg" | "png" | "webp" | "bmp" | "gif"
    ) {
        return Err(format!("{} has an unsupported image format", file_name));
    }
    let metadata = std::fs::symlink_metadata(input)
        .map_err(|error| format!("Cannot read {}: {}", file_name, error))?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err(format!("{} is not a regular file", file_name));
    }
    if metadata.len() > MAX_IMAGE_FILE_BYTES {
        return Err(format!(
            "{} exceeds the {} MB file limit",
            file_name,
            MAX_IMAGE_FILE_BYTES / 1024 / 1024
        ));
    }
    let canonical = input
        .canonicalize()
        .map_err(|error| format!("Cannot resolve {}: {}", file_name, error))?;
    let (width, height) = image::image_dimensions(&canonical)
        .map_err(|error| format!("Cannot read dimensions for {}: {}", file_name, error))?;
    let pixels = u64::from(width) * u64::from(height);
    if width == 0 || height == 0 || pixels > MAX_IMAGE_PIXELS {
        return Err(format!(
            "{} exceeds the {} megapixel limit",
            file_name,
            MAX_IMAGE_PIXELS / 1_000_000
        ));
    }
    if extension == "gif" {
        let has_multiple_frames = image_has_multiple_gif_frames(&canonical)
            .map_err(|error| format!("Cannot inspect {}: {}", file_name, error))?;
        if has_multiple_frames {
            return Err(format!(
                "{} is animated and cannot be converted without losing frames",
                file_name
            ));
        }
    }
    Ok((canonical, extension))
}

fn validate_image_batch_inputs(input_paths: &[String]) -> Result<(), String> {
    validate_image_batch_request(input_paths)?;
    let mut seen = std::collections::BTreeSet::new();
    for input_path in input_paths {
        let file_name = std::path::Path::new(input_path)
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("input image");
        let (canonical, _) = validate_image_batch_input(input_path)?;
        if !seen.insert(canonical) {
            return Err(format!("Duplicate image file: {}", file_name));
        }
    }
    Ok(())
}

fn image_has_multiple_gif_frames(input: &std::path::Path) -> Result<bool, String> {
    use image::AnimationDecoder;
    use std::io::BufReader;

    let file = std::fs::File::open(input).map_err(|error| format!("Cannot read GIF: {}", error))?;
    let decoder = image::codecs::gif::GifDecoder::new(BufReader::new(file))
        .map_err(|error| format!("Cannot decode GIF: {}", error))?;
    let mut frames = decoder.into_frames();
    if frames
        .next()
        .transpose()
        .map_err(|error| format!("Cannot decode GIF: {}", error))?
        .is_none()
    {
        return Err("GIF has no image frames".to_string());
    }
    Ok(frames
        .next()
        .transpose()
        .map_err(|error| format!("Cannot decode GIF: {}", error))?
        .is_some())
}

fn validate_image_output_dir(output_dir: &str) -> Result<std::path::PathBuf, String> {
    if output_dir.trim().is_empty() || output_dir.contains('\0') {
        return Err("Image output directory is invalid".to_string());
    }
    let directory = std::path::PathBuf::from(output_dir);
    is_path_safe(&directory)?;
    std::fs::create_dir_all(&directory)
        .map_err(|error| format!("Cannot create image output directory: {}", error))?;
    if !directory.is_dir() {
        return Err("Image output path is not a directory".to_string());
    }
    let directory = directory
        .canonicalize()
        .map_err(|error| format!("Cannot resolve image output directory: {}", error))?;
    is_path_safe(&directory)?;
    Ok(directory)
}

fn publish_image_output(
    temporary_output_path: &std::path::Path,
    output_path: &std::path::Path,
) -> Result<(), String> {
    std::fs::hard_link(temporary_output_path, output_path)
        .map_err(|error| format!("Cannot publish image output: {}", error))?;
    let _ = std::fs::remove_file(temporary_output_path);
    Ok(())
}

fn flatten_image_to_rgb(
    source: &image::DynamicImage,
    background: image::Rgb<u8>,
) -> image::RgbImage {
    let rgba = source.to_rgba8();
    let mut output = image::RgbImage::new(rgba.width(), rgba.height());
    let [background_red, background_green, background_blue] = background.0;
    for (source_pixel, output_pixel) in rgba.pixels().zip(output.pixels_mut()) {
        let [red, green, blue, alpha] = source_pixel.0;
        let alpha = u32::from(alpha);
        let inverse_alpha = 255 - alpha;
        let blend = |channel: u8, background_channel: u8| {
            ((u32::from(channel) * alpha + u32::from(background_channel) * inverse_alpha + 127)
                / 255) as u8
        };
        *output_pixel = image::Rgb([
            blend(red, background_red),
            blend(green, background_green),
            blend(blue, background_blue),
        ]);
    }
    output
}

fn write_converted_image(
    image: &image::DynamicImage,
    output_path: &std::path::Path,
    target_format: image::ImageFormat,
) -> image::ImageResult<()> {
    match target_format {
        image::ImageFormat::Jpeg => {
            use image::codecs::jpeg::JpegEncoder;
            use std::io::BufWriter;

            let file = std::fs::File::create(output_path)?;
            let writer = BufWriter::new(file);
            let mut encoder = JpegEncoder::new_with_quality(writer, 92);
            let rgb = flatten_image_to_rgb(image, image::Rgb([255, 255, 255]));
            encoder.encode(
                &rgb,
                rgb.width(),
                rgb.height(),
                image::ExtendedColorType::Rgb8,
            )
        }
        _ => image.save_with_format(output_path, target_format),
    }
}

fn write_raster_svg(
    image: &image::DynamicImage,
    output_path: &std::path::Path,
) -> Result<(), String> {
    use base64::Engine;
    use image::ImageEncoder;

    let rgba = image.to_rgba8();
    let width = image.width();
    let height = image.height();
    let mut png = Vec::new();
    image::codecs::png::PngEncoder::new(&mut png)
        .write_image(&rgba, width, height, image::ExtendedColorType::Rgba8)
        .map_err(|error| format!("Cannot encode SVG image data: {}", error))?;
    let encoded = base64::engine::general_purpose::STANDARD.encode(png);
    let svg = format!(
        r#"<svg xmlns="http://www.w3.org/2000/svg" width="{width}" height="{height}" viewBox="0 0 {width} {height}"><image width="{width}" height="{height}" href="data:image/png;base64,{encoded}"/></svg>"#
    );
    std::fs::write(output_path, svg).map_err(|error| format!("Cannot write SVG output: {}", error))
}

#[derive(Clone, Debug, serde::Serialize)]
struct ImageStitchResult {
    output_path: String,
    width: u32,
    height: u32,
    count: usize,
    format: String,
}

#[derive(serde::Serialize)]
struct ImageStitchInputPreview {
    path: String,
    name: String,
    width: u32,
    height: u32,
    thumbnail_data_url: String,
    preview_data_url: String,
}

#[derive(Clone)]
struct ImageStitchOptions {
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
}

#[derive(Clone, Debug, PartialEq)]
struct ImageStitchLayout {
    sizes: Vec<(u32, u32)>,
    width: u32,
    height: u32,
}

pub(crate) fn decode_oriented_image(path: &std::path::Path) -> image::ImageResult<image::DynamicImage> {
    use image::ImageDecoder;
    let reader = image::ImageReader::open(path)
        .map_err(image::ImageError::IoError)?
        .with_guessed_format()
        .map_err(image::ImageError::IoError)?;
    let mut decoder = reader.into_decoder()?;
    let orientation = decoder.orientation()?;
    let mut decoded = image::DynamicImage::from_decoder(decoder)?;
    decoded.apply_orientation(orientation);
    Ok(decoded)
}

#[derive(Clone, Debug, serde::Serialize)]
struct ImageCropResult {
    output_path: String,
    width: u32,
    height: u32,
    bytes: u64,
    format: String,
}

#[derive(Clone)]
struct ImageCropOptions {
    input_path: String,
    output_dir: String,
    output_name: Option<String>,
    crop_x: u32,
    crop_y: u32,
    crop_width: u32,
    crop_height: u32,
    rotation: u16,
    flip_horizontal: bool,
    flip_vertical: bool,
    format: String,
    jpeg_quality: u8,
    background_rgba: String,
}

fn read_oriented_image(path: &std::path::Path) -> Result<image::DynamicImage, String> {
    decode_oriented_image(path).map_err(|_| "image-stitch:invalid-input".to_string())
}

fn oriented_image_dimensions(path: &std::path::Path) -> Result<(u32, u32), String> {
    use image::ImageDecoder;
    let reader = image::ImageReader::open(path)
        .map_err(|_| "image-stitch:invalid-input".to_string())?
        .with_guessed_format()
        .map_err(|_| "image-stitch:invalid-input".to_string())?;
    let mut decoder = reader
        .into_decoder()
        .map_err(|_| "image-stitch:invalid-input".to_string())?;
    let (width, height) = decoder.dimensions();
    let orientation = decoder
        .orientation()
        .map_err(|_| "image-stitch:invalid-input".to_string())?;
    if matches!(
        orientation,
        image::metadata::Orientation::Rotate90
            | image::metadata::Orientation::Rotate270
            | image::metadata::Orientation::Rotate90FlipH
            | image::metadata::Orientation::Rotate270FlipH
    ) {
        Ok((height, width))
    } else {
        Ok((width, height))
    }
}

fn stitch_background(value: &str) -> Result<image::Rgba<u8>, String> {
    let raw = value.trim().trim_start_matches('#');
    if raw.len() != 8 || !raw.chars().all(|character| character.is_ascii_hexdigit()) {
        return Err("image-stitch:invalid-background".to_string());
    }
    let part = |from| {
        u8::from_str_radix(&raw[from..from + 2], 16)
            .map_err(|_| "image-stitch:invalid-background".to_string())
    };
    Ok(image::Rgba([part(0)?, part(2)?, part(4)?, part(6)?]))
}

fn calculate_image_stitch_layout(
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
fn available_image_stitch_pixels() -> u64 {
    use windows::Win32::System::SystemInformation::{GlobalMemoryStatusEx, MEMORYSTATUSEX};
    let mut memory = MEMORYSTATUSEX::default();
    memory.dwLength = std::mem::size_of::<MEMORYSTATUSEX>() as u32;
    if unsafe { GlobalMemoryStatusEx(&mut memory) }.is_ok() {
        return (memory.ullAvailPhys / 12).clamp(4_000_000, 160_000_000);
    }
    80_000_000
}

#[cfg(not(target_os = "windows"))]
fn available_image_stitch_pixels() -> u64 {
    80_000_000
}

static IMAGE_STITCH_TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);
static IMAGE_STITCH_PDF_SESSION_COUNTER: AtomicU64 = AtomicU64::new(0);
static PDF_TO_IMAGE_SESSION_COUNTER: AtomicU64 = AtomicU64::new(0);
static PDF_TO_IMAGE_TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);

const IMAGE_STITCH_PDF_SESSION_ROOT: &str = "toolknit-image-stitch-pdf";
const PDF_TO_IMAGE_SESSION_ROOT: &str = "toolknit-pdf-to-image";
const PDF_TO_IMAGE_MAX_PAGE_BYTES: usize = 192 * 1024 * 1024;
const PDF_TO_IMAGE_MAX_SESSION_BYTES: u64 = 2 * 1024 * 1024 * 1024;
const PDF_TO_IMAGE_MAX_PAGES: usize = 200;
const PDF_TO_IMAGE_MAX_LONG_PAGES: usize = 20;
const PDF_TO_IMAGE_MAX_PAGES_PER_LONG_IMAGE: usize = 5;
const PDF_TO_IMAGE_MAX_RENDER_SIDE: u32 = 16_384;
const PDF_TO_IMAGE_MAX_RENDER_PIXELS: u64 = 40_000_000;
const PDF_TO_IMAGE_MAX_LONG_SIDE: u32 = 32_767;
const PDF_TO_IMAGE_MAX_LONG_PIXELS: u64 = 60_000_000;
const PDF_TO_IMAGE_MAX_ESTIMATED_WORKING_BYTES: u64 = 384 * 1024 * 1024;
struct PdfToImageJobState {
    cancelled: std::sync::Arc<std::sync::atomic::AtomicBool>,
    active: bool,
}

static PDF_TO_IMAGE_JOBS: std::sync::OnceLock<
    std::sync::Mutex<std::collections::BTreeMap<String, PdfToImageJobState>>,
> = std::sync::OnceLock::new();

fn pdf_to_image_jobs(
) -> &'static std::sync::Mutex<std::collections::BTreeMap<String, PdfToImageJobState>> {
    PDF_TO_IMAGE_JOBS.get_or_init(|| std::sync::Mutex::new(std::collections::BTreeMap::new()))
}

fn valid_pdf_to_image_job_id(job_id: &str) -> bool {
    !job_id.is_empty()
        && job_id.len() <= 128
        && job_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
}

struct PdfToImageJobGuard {
    job_id: String,
    cancelled: std::sync::Arc<std::sync::atomic::AtomicBool>,
}

impl PdfToImageJobGuard {
    fn register(job_id: String) -> Result<Self, String> {
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
fn cancel_pdf_to_image(job_id: String) -> Result<(), String> {
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
struct ImageStitchPdfSession {
    session_id: String,
    directory: String,
}

fn image_stitch_pdf_session_root() -> std::path::PathBuf {
    std::env::temp_dir().join(IMAGE_STITCH_PDF_SESSION_ROOT)
}

fn valid_image_stitch_session_id(session_id: &str) -> bool {
    !session_id.is_empty()
        && session_id.len() <= 96
        && session_id
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || character == '-')
}

fn image_stitch_pdf_session_directory(session_id: &str) -> Result<std::path::PathBuf, String> {
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

fn cleanup_image_stitch_pdf_sessions() {
    let root = image_stitch_pdf_session_root();
    if root.is_dir() {
        let _ = std::fs::remove_dir_all(&root);
    }
}

#[tauri::command]
fn create_image_stitch_pdf_session() -> Result<ImageStitchPdfSession, String> {
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
fn write_image_stitch_pdf_page(
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
fn discard_image_stitch_pdf_session(session_id: String) -> Result<(), String> {
    let directory = image_stitch_pdf_session_directory(&session_id)?;
    std::fs::remove_dir_all(directory)
        .map_err(|_| "image-stitch:pdf-session-cleanup-failed".to_string())
}

struct ImageStitchTemporaryFile {
    path: std::path::PathBuf,
    published: bool,
}

impl ImageStitchTemporaryFile {
    fn new(directory: &std::path::Path) -> Self {
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

fn publish_image_stitch_output(
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

fn normalize_image_stitch_output_name(value: Option<&str>) -> Result<String, String> {
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

fn encode_image_stitch(
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

fn stitch_images_blocking<F>(
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
async fn inspect_image_stitch_inputs(
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
async fn stitch_images(
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
struct PdfToImageSession {
    session_id: String,
    directory: String,
}

#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct PdfToImagePageWriteResult {
    page_number: u32,
    path: String,
    width: u32,
    height: u32,
    byte_length: u64,
}

#[derive(Clone, Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct PdfToImageExportRequest {
    session_id: String,
    #[serde(rename = "pages", alias = "pageNumbers")]
    page_numbers: Vec<u32>,
    page_count: u32,
    output_dir: String,
    output_name: Option<String>,
    format: String,
    #[serde(rename = "mode", alias = "exportMode")]
    export_mode: String,
    pages_per_long_image: Option<u8>,
    jpeg_quality: Option<u8>,
    background_rgba: Option<String>,
    job_id: Option<String>,
}

#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct PdfToImageExportItem {
    output_path: String,
    width: u32,
    height: u32,
    page_numbers: Vec<u32>,
}

#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct PdfToImageExportResult {
    output_dir: String,
    outputs: Vec<PdfToImageExportItem>,
    output_count: usize,
    page_count: usize,
    format: String,
    export_mode: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum PdfToImageExportMode {
    Pages,
    Long,
}

#[derive(Clone, Debug)]
struct PdfToImageSourcePage {
    page_number: u32,
    path: std::path::PathBuf,
    width: u32,
    height: u32,
}

struct PdfToImageTemporaryFile {
    path: std::path::PathBuf,
}

impl PdfToImageTemporaryFile {
    fn new(directory: &std::path::Path) -> Self {
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

struct PdfToImagePreparedOutput {
    temporary: PdfToImageTemporaryFile,
    logical_stem: String,
    extension: String,
    width: u32,
    height: u32,
    page_numbers: Vec<u32>,
}

fn pdf_to_image_session_root() -> std::path::PathBuf {
    std::env::temp_dir().join(PDF_TO_IMAGE_SESSION_ROOT)
}

fn valid_pdf_to_image_session_id(session_id: &str) -> bool {
    !session_id.is_empty()
        && session_id.len() <= 96
        && session_id
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || character == '-')
}

fn pdf_to_image_session_directory(session_id: &str) -> Result<std::path::PathBuf, String> {
    if !valid_pdf_to_image_session_id(session_id) {
        return Err("pdf-to-image:invalid-session".to_string());
    }
    let root = pdf_to_image_session_root();
    let directory = root.join(session_id);
    let canonical_root = root
        .canonicalize()
        .map_err(|_| "pdf-to-image:invalid-session".to_string())?;
    let canonical_directory = directory
        .canonicalize()
        .map_err(|_| "pdf-to-image:invalid-session".to_string())?;
    if !canonical_directory.starts_with(&canonical_root) || !canonical_directory.is_dir() {
        return Err("pdf-to-image:invalid-session".to_string());
    }
    Ok(canonical_directory)
}

fn remove_pdf_to_image_session(session_id: &str) -> Result<(), String> {
    if !valid_pdf_to_image_session_id(session_id) {
        return Err("pdf-to-image:invalid-session".to_string());
    }
    let directory = pdf_to_image_session_root().join(session_id);
    if !directory.exists() {
        return Ok(());
    }
    let directory = pdf_to_image_session_directory(session_id)?;
    std::fs::remove_dir_all(directory)
        .map_err(|_| "pdf-to-image:session-cleanup-failed".to_string())
}

fn cleanup_pdf_to_image_sessions() {
    let root = pdf_to_image_session_root();
    if root.is_dir() {
        let _ = std::fs::remove_dir_all(root);
    }
}

#[tauri::command]
fn create_pdf_to_image_session() -> Result<PdfToImageSession, String> {
    let root = pdf_to_image_session_root();
    std::fs::create_dir_all(&root).map_err(|_| "pdf-to-image:session-create-failed".to_string())?;
    for _ in 0..10_000 {
        let counter = PDF_TO_IMAGE_SESSION_COUNTER.fetch_add(1, Ordering::SeqCst);
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
                return Ok(PdfToImageSession {
                    session_id,
                    directory: cleanup_display_path(&directory),
                });
            }
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(_) => return Err("pdf-to-image:session-create-failed".to_string()),
        }
    }
    Err("pdf-to-image:session-create-failed".to_string())
}

fn pdf_to_image_session_usage(directory: &std::path::Path) -> Result<(usize, u64), String> {
    let mut count = 0usize;
    let mut bytes = 0u64;
    for entry in
        std::fs::read_dir(directory).map_err(|_| "pdf-to-image:invalid-session".to_string())?
    {
        let entry = entry.map_err(|_| "pdf-to-image:invalid-session".to_string())?;
        let metadata = entry
            .metadata()
            .map_err(|_| "pdf-to-image:invalid-session".to_string())?;
        if metadata.is_file() {
            count = count.saturating_add(1);
            bytes = bytes.saturating_add(metadata.len());
        }
    }
    Ok((count, bytes))
}

fn pdf_to_image_page_number_from_file_name(file_name: &str) -> Option<u32> {
    let digits = file_name.strip_prefix("page_")?.strip_suffix(".png")?;
    if digits.len() != 5 || !digits.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    let page_number = digits.parse::<u32>().ok()?;
    if page_number == 0
        || page_number > 10_000
        || file_name != format!("page_{:05}.png", page_number)
    {
        return None;
    }
    Some(page_number)
}

fn write_pdf_to_image_page_bytes(
    session_id: &str,
    file_name: &str,
    bytes: &[u8],
) -> Result<PdfToImagePageWriteResult, String> {
    use std::io::Write;

    let page_number = pdf_to_image_page_number_from_file_name(file_name)
        .ok_or_else(|| "pdf-to-image:invalid-page-name".to_string())?;
    if bytes.len() < 8
        || bytes.len() > PDF_TO_IMAGE_MAX_PAGE_BYTES
        || bytes[..8] != [137, 80, 78, 71, 13, 10, 26, 10]
    {
        return Err("pdf-to-image:invalid-page".to_string());
    }
    let directory = pdf_to_image_session_directory(session_id)?;
    let output_path = directory.join(file_name);
    if output_path.exists() {
        return Err("pdf-to-image:duplicate-page".to_string());
    }
    let (page_count, session_bytes) = pdf_to_image_session_usage(&directory)?;
    if page_count >= PDF_TO_IMAGE_MAX_PAGES {
        return Err("pdf-to-image:too-many-pages".to_string());
    }
    if session_bytes.saturating_add(bytes.len() as u64) > PDF_TO_IMAGE_MAX_SESSION_BYTES {
        return Err("pdf-to-image:session-too-large".to_string());
    }

    let mut output = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&output_path)
        .map_err(|_| "pdf-to-image:page-write-failed".to_string())?;
    if let Err(error) = output.write_all(&bytes).and_then(|_| output.sync_all()) {
        drop(output);
        let _ = std::fs::remove_file(&output_path);
        return Err(format!("pdf-to-image:page-write-failed:{error}"));
    }
    drop(output);

    let dimensions = image::image_dimensions(&output_path).ok();
    let Some((width, height)) = dimensions else {
        let _ = std::fs::remove_file(&output_path);
        return Err("pdf-to-image:invalid-page".to_string());
    };
    let pixels = u64::from(width).saturating_mul(u64::from(height));
    if width == 0
        || height == 0
        || width > PDF_TO_IMAGE_MAX_RENDER_SIDE
        || height > PDF_TO_IMAGE_MAX_RENDER_SIDE
        || pixels > PDF_TO_IMAGE_MAX_RENDER_PIXELS
    {
        let _ = std::fs::remove_file(&output_path);
        return Err("pdf-to-image:invalid-page".to_string());
    }
    Ok(PdfToImagePageWriteResult {
        page_number,
        path: cleanup_display_path(&output_path),
        width,
        height,
        byte_length: bytes.len() as u64,
    })
}

#[tauri::command]
fn write_pdf_to_image_page(
    request: tauri::ipc::Request<'_>,
) -> Result<PdfToImagePageWriteResult, String> {
    let session_id = request
        .headers()
        .get("session-id")
        .and_then(|value| value.to_str().ok())
        .ok_or_else(|| "pdf-to-image:invalid-session".to_string())?;
    let file_name = request
        .headers()
        .get("file-name")
        .and_then(|value| value.to_str().ok())
        .ok_or_else(|| "pdf-to-image:invalid-page-name".to_string())?;
    let bytes = match request.body() {
        tauri::ipc::InvokeBody::Raw(bytes) => bytes.as_slice(),
        _ => return Err("pdf-to-image:raw-body-required".to_string()),
    };
    write_pdf_to_image_page_bytes(session_id, file_name, bytes)
}

#[tauri::command]
fn write_pdf_to_image_page_json(
    session_id: String,
    file_name: String,
    bytes: Vec<u8>,
) -> Result<PdfToImagePageWriteResult, String> {
    write_pdf_to_image_page_bytes(&session_id, &file_name, &bytes)
}

#[tauri::command]
fn read_pdf_to_image_source(path: String) -> Result<tauri::ipc::Response, String> {
    use std::io::Read;

    const MAX_PDF_BYTES: u64 = 150 * 1024 * 1024;
    if path.contains('\0') {
        return Err("pdf-to-image:invalid-pdf".to_string());
    }
    let requested = std::path::PathBuf::from(path);
    let requested_metadata = std::fs::symlink_metadata(&requested)
        .map_err(|_| "pdf-to-image:invalid-pdf".to_string())?;
    if requested_metadata.file_type().is_symlink() || !requested_metadata.is_file() {
        return Err("pdf-to-image:invalid-pdf".to_string());
    }
    let input = requested
        .canonicalize()
        .map_err(|_| "pdf-to-image:invalid-pdf".to_string())?;
    if !input
        .extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| extension.eq_ignore_ascii_case("pdf"))
    {
        return Err("pdf-to-image:invalid-pdf".to_string());
    }
    if requested_metadata.len() < 5 || requested_metadata.len() > MAX_PDF_BYTES {
        return Err(if requested_metadata.len() > MAX_PDF_BYTES {
            "pdf-to-image:pdf-too-large".to_string()
        } else {
            "pdf-to-image:invalid-pdf".to_string()
        });
    }
    let file = std::fs::File::open(&input).map_err(|_| "pdf-to-image:invalid-pdf".to_string())?;
    let mut reader = file.take(MAX_PDF_BYTES + 1);
    let mut bytes = Vec::with_capacity(requested_metadata.len() as usize);
    reader
        .read_to_end(&mut bytes)
        .map_err(|_| "pdf-to-image:invalid-pdf".to_string())?;
    if bytes.len() as u64 > MAX_PDF_BYTES {
        return Err("pdf-to-image:pdf-too-large".to_string());
    }
    let header_length = bytes.len().min(1024);
    if !bytes[..header_length]
        .windows(5)
        .any(|window| window == b"%PDF-")
    {
        return Err("pdf-to-image:invalid-pdf".to_string());
    }
    Ok(tauri::ipc::Response::new(bytes))
}

#[tauri::command]
fn discard_pdf_to_image_session(session_id: String) -> Result<(), String> {
    remove_pdf_to_image_session(&session_id)
}

fn normalize_pdf_to_image_format(value: &str) -> Result<(String, String), String> {
    match value.trim().to_ascii_lowercase().as_str() {
        "png" => Ok(("png".to_string(), ".png".to_string())),
        "jpg" | "jpeg" => Ok(("jpg".to_string(), ".jpg".to_string())),
        "webp" => Ok(("webp".to_string(), ".webp".to_string())),
        _ => Err("pdf-to-image:invalid-format".to_string()),
    }
}

fn normalize_pdf_to_image_mode(value: &str) -> Result<PdfToImageExportMode, String> {
    match value.trim().to_ascii_lowercase().as_str() {
        "images" | "pages" => Ok(PdfToImageExportMode::Pages),
        "long" => Ok(PdfToImageExportMode::Long),
        _ => Err("pdf-to-image:invalid-mode".to_string()),
    }
}

fn load_pdf_to_image_source_pages(
    session_directory: &std::path::Path,
    page_numbers: &[u32],
) -> Result<Vec<PdfToImageSourcePage>, String> {
    let mut seen = std::collections::BTreeSet::new();
    let mut pages = Vec::with_capacity(page_numbers.len());
    for page_number in page_numbers {
        if *page_number == 0 || *page_number > 10_000 || !seen.insert(*page_number) {
            return Err("pdf-to-image:invalid-selection".to_string());
        }
        let path = session_directory.join(format!("page_{:05}.png", page_number));
        let metadata = std::fs::symlink_metadata(&path)
            .map_err(|_| "pdf-to-image:missing-page".to_string())?;
        if metadata.file_type().is_symlink()
            || !metadata.is_file()
            || metadata.len() == 0
            || metadata.len() > PDF_TO_IMAGE_MAX_PAGE_BYTES as u64
        {
            return Err("pdf-to-image:invalid-page".to_string());
        }
        let canonical = path
            .canonicalize()
            .map_err(|_| "pdf-to-image:invalid-page".to_string())?;
        if !canonical.starts_with(session_directory) {
            return Err("pdf-to-image:invalid-page".to_string());
        }
        let (width, height) = image::image_dimensions(&canonical)
            .map_err(|_| "pdf-to-image:invalid-page".to_string())?;
        let pixels = u64::from(width).saturating_mul(u64::from(height));
        if width == 0
            || height == 0
            || width > PDF_TO_IMAGE_MAX_RENDER_SIDE
            || height > PDF_TO_IMAGE_MAX_RENDER_SIDE
            || pixels > PDF_TO_IMAGE_MAX_RENDER_PIXELS
        {
            return Err("pdf-to-image:invalid-page".to_string());
        }
        pages.push(PdfToImageSourcePage {
            page_number: *page_number,
            path: canonical,
            width,
            height,
        });
    }
    Ok(pages)
}

fn pdf_to_image_group_layout(
    pages: &[PdfToImageSourcePage],
    max_pixels: u64,
) -> Result<ImageStitchLayout, String> {
    if pages.is_empty() {
        return Err("pdf-to-image:invalid-selection".to_string());
    }
    let width = pages
        .iter()
        .map(|page| page.width)
        .max()
        .ok_or_else(|| "pdf-to-image:invalid-selection".to_string())?;
    let height = pages.iter().try_fold(0u64, |sum, page| {
        sum.checked_add(u64::from(page.height))
            .ok_or_else(|| "pdf-to-image:output-too-large".to_string())
    })?;
    if width > PDF_TO_IMAGE_MAX_LONG_SIDE || height > u64::from(PDF_TO_IMAGE_MAX_LONG_SIDE) {
        return Err("pdf-to-image:output-too-large".to_string());
    }
    let pixels = u64::from(width)
        .checked_mul(height)
        .ok_or_else(|| "pdf-to-image:output-too-large".to_string())?;
    if pixels > max_pixels {
        return Err("pdf-to-image:output-too-large-for-memory".to_string());
    }
    let max_page_pixels = pages
        .iter()
        .map(|page| u64::from(page.width) * u64::from(page.height))
        .max()
        .unwrap_or(0);
    let estimated_working_bytes = pixels
        .checked_mul(6)
        .and_then(|value| value.checked_add(max_page_pixels.saturating_mul(4)))
        .ok_or_else(|| "pdf-to-image:output-too-large-for-memory".to_string())?;
    if estimated_working_bytes > PDF_TO_IMAGE_MAX_ESTIMATED_WORKING_BYTES {
        return Err("pdf-to-image:output-too-large-for-memory".to_string());
    }
    Ok(ImageStitchLayout {
        sizes: pages.iter().map(|page| (page.width, page.height)).collect(),
        width,
        height: height as u32,
    })
}

fn build_pdf_to_image_groups(
    pages: &[PdfToImageSourcePage],
    mode: PdfToImageExportMode,
    pages_per_long_image: usize,
    max_pixels: u64,
) -> Result<Vec<Vec<PdfToImageSourcePage>>, String> {
    if mode == PdfToImageExportMode::Pages {
        for page in pages {
            pdf_to_image_group_layout(std::slice::from_ref(page), max_pixels)?;
        }
        return Ok(pages.iter().cloned().map(|page| vec![page]).collect());
    }

    let mut groups = Vec::new();
    let mut current = Vec::new();
    for page in pages.iter().cloned() {
        if current.len() >= pages_per_long_image {
            groups.push(std::mem::take(&mut current));
        }
        let mut candidate = current.clone();
        candidate.push(page.clone());
        if pdf_to_image_group_layout(&candidate, max_pixels).is_ok() {
            current = candidate;
            continue;
        }
        if !current.is_empty() {
            groups.push(std::mem::take(&mut current));
        }
        pdf_to_image_group_layout(std::slice::from_ref(&page), max_pixels)?;
        current.push(page);
    }
    if !current.is_empty() {
        groups.push(current);
    }
    Ok(groups)
}

fn compose_pdf_to_image_group(
    pages: &[PdfToImageSourcePage],
    layout: &ImageStitchLayout,
    background: image::Rgba<u8>,
    format: &str,
    cancelled: &AtomicBool,
) -> Result<image::RgbaImage, String> {
    let canvas_background = if format == "jpg" {
        image::Rgba([background.0[0], background.0[1], background.0[2], 255])
    } else {
        background
    };
    let mut canvas = image::RgbaImage::from_pixel(layout.width, layout.height, canvas_background);
    let mut cursor = 0u32;
    for (page, (width, height)) in pages.iter().zip(layout.sizes.iter()) {
        if cancelled.load(Ordering::SeqCst) {
            return Err("pdf-to-image:cancelled".to_string());
        }
        let decoded =
            read_oriented_image(&page.path).map_err(|_| "pdf-to-image:invalid-page".to_string())?;
        if decoded.width() != *width || decoded.height() != *height {
            return Err("pdf-to-image:invalid-page".to_string());
        }
        let rendered = decoded.into_rgba8();
        let x = (layout.width.saturating_sub(*width)) / 2;
        image::imageops::overlay(&mut canvas, &rendered, i64::from(x), i64::from(cursor));
        cursor = cursor.saturating_add(*height);
    }
    Ok(canvas)
}

fn encode_pdf_to_image(
    canvas: image::RgbaImage,
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
        .map_err(|_| "pdf-to-image:output-path".to_string())?;
    let mut writer = BufWriter::new(file);
    match format {
        "jpg" => {
            let width = canvas.width();
            let height = canvas.height();
            let rgb = image::DynamicImage::ImageRgba8(canvas).into_rgb8();
            image::codecs::jpeg::JpegEncoder::new_with_quality(&mut writer, jpeg_quality)
                .encode(&rgb, width, height, image::ExtendedColorType::Rgb8)
                .map_err(|_| "pdf-to-image:encode-failed".to_string())?;
        }
        "webp" => {
            image::codecs::webp::WebPEncoder::new_lossless(&mut writer)
                .encode(
                    canvas.as_raw(),
                    canvas.width(),
                    canvas.height(),
                    image::ExtendedColorType::Rgba8,
                )
                .map_err(|_| "pdf-to-image:encode-failed".to_string())?;
        }
        "png" => {
            image::codecs::png::PngEncoder::new(&mut writer)
                .write_image(
                    canvas.as_raw(),
                    canvas.width(),
                    canvas.height(),
                    image::ExtendedColorType::Rgba8,
                )
                .map_err(|_| "pdf-to-image:encode-failed".to_string())?;
        }
        _ => return Err("pdf-to-image:invalid-format".to_string()),
    }
    writer
        .flush()
        .and_then(|_| writer.get_ref().sync_all())
        .map_err(|_| "pdf-to-image:output-path".to_string())
}

fn pdf_to_image_logical_stem(
    base: &str,
    mode: PdfToImageExportMode,
    output_index: usize,
    pages: &[PdfToImageSourcePage],
    page_count: u32,
) -> String {
    let digits = std::cmp::max(2, page_count.to_string().len());
    if mode == PdfToImageExportMode::Pages {
        return format!(
            "{}_page_{:0width$}",
            base,
            pages[0].page_number,
            width = digits
        );
    }
    let page_label = pages
        .iter()
        .map(|page| format!("{:0width$}", page.page_number, width = digits))
        .collect::<Vec<_>>()
        .join("_");
    format!("{}_long_{:02}_pages_{}", base, output_index + 1, page_label)
}

fn pdf_to_image_candidate_path(
    directory: &std::path::Path,
    prepared: &PdfToImagePreparedOutput,
    batch_suffix: u32,
) -> std::path::PathBuf {
    let suffix = if batch_suffix == 0 {
        String::new()
    } else {
        format!("_{}", batch_suffix)
    };
    directory.join(format!(
        "{}{}{}",
        prepared.logical_stem, suffix, prepared.extension
    ))
}

fn copy_pdf_to_image_output(
    source: &std::path::Path,
    target: &std::path::Path,
    cancelled: &AtomicBool,
) -> std::io::Result<()> {
    use std::io::{Read, Write};

    if cancelled.load(Ordering::SeqCst) {
        return Err(std::io::Error::new(
            std::io::ErrorKind::Interrupted,
            "PDF image export cancelled",
        ));
    }
    let input = std::fs::File::open(source)?;
    let output = std::fs::OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(target)?;
    let mut reader = std::io::BufReader::with_capacity(256 * 1024, input);
    let mut writer = std::io::BufWriter::with_capacity(256 * 1024, output);
    let result = (|| -> std::io::Result<()> {
        let mut buffer = vec![0u8; 256 * 1024];
        loop {
            if cancelled.load(Ordering::SeqCst) {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::Interrupted,
                    "PDF image export cancelled",
                ));
            }
            let read = reader.read(&mut buffer)?;
            if read == 0 {
                break;
            }
            writer.write_all(&buffer[..read])?;
        }
        if cancelled.load(Ordering::SeqCst) {
            return Err(std::io::Error::new(
                std::io::ErrorKind::Interrupted,
                "PDF image export cancelled",
            ));
        }
        writer.flush()?;
        writer.get_ref().sync_all()
    })();
    if result.is_err() {
        drop(writer);
        let _ = std::fs::remove_file(target);
    }
    result
}

fn publish_pdf_to_image_output(
    source: &std::path::Path,
    target: &std::path::Path,
    cancelled: &AtomicBool,
) -> std::io::Result<()> {
    match std::fs::hard_link(source, target) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => Err(error),
        Err(_) => copy_pdf_to_image_output(source, target, cancelled),
    }
}

fn publish_pdf_to_image_batch(
    prepared: &[PdfToImagePreparedOutput],
    directory: &std::path::Path,
    cancelled: &AtomicBool,
) -> Result<Vec<PdfToImageExportItem>, String> {
    if prepared.is_empty() {
        return Err("pdf-to-image:no-output".to_string());
    }
    for batch_suffix in 0..10_000u32 {
        if cancelled.load(Ordering::SeqCst) {
            return Err("pdf-to-image:cancelled".to_string());
        }
        let candidates = prepared
            .iter()
            .map(|item| pdf_to_image_candidate_path(directory, item, batch_suffix))
            .collect::<Vec<_>>();
        if candidates.iter().any(|candidate| candidate.exists()) {
            continue;
        }

        let mut published = Vec::with_capacity(prepared.len());
        let mut collision = false;
        let mut fatal = false;
        for (item, candidate) in prepared.iter().zip(candidates.iter()) {
            if cancelled.load(Ordering::SeqCst) {
                fatal = true;
                break;
            }
            match publish_pdf_to_image_output(&item.temporary.path, candidate, cancelled) {
                Ok(()) => published.push(candidate.clone()),
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                    collision = true;
                    break;
                }
                Err(_) => {
                    fatal = true;
                    break;
                }
            }
        }
        if cancelled.load(Ordering::SeqCst) {
            fatal = true;
        }
        if collision || fatal {
            for path in &published {
                let _ = std::fs::remove_file(path);
            }
            if collision {
                continue;
            }
            return Err(if cancelled.load(Ordering::SeqCst) {
                "pdf-to-image:cancelled".to_string()
            } else {
                "pdf-to-image:publish-failed".to_string()
            });
        }

        return Ok(prepared
            .iter()
            .zip(candidates)
            .map(|(item, output_path)| PdfToImageExportItem {
                output_path: cleanup_display_path(&output_path),
                width: item.width,
                height: item.height,
                page_numbers: item.page_numbers.clone(),
            })
            .collect());
    }
    Err("pdf-to-image:output-path".to_string())
}

fn export_pdf_to_images_blocking<F>(
    request: PdfToImageExportRequest,
    cancelled: &AtomicBool,
    mut progress: F,
) -> Result<PdfToImageExportResult, String>
where
    F: FnMut(&str, usize, usize, u8),
{
    if cancelled.load(Ordering::SeqCst) {
        return Err("pdf-to-image:cancelled".to_string());
    }
    let mode = normalize_pdf_to_image_mode(&request.export_mode)?;
    let unique_page_numbers = request
        .page_numbers
        .iter()
        .copied()
        .collect::<std::collections::BTreeSet<_>>();
    if request.page_count == 0
        || request.page_count as usize > PDF_TO_IMAGE_MAX_PAGES
        || request.page_numbers.is_empty()
        || request.page_numbers.len() > PDF_TO_IMAGE_MAX_PAGES
        || unique_page_numbers.len() != request.page_numbers.len()
        || request
            .page_numbers
            .iter()
            .any(|page_number| *page_number == 0 || *page_number > request.page_count)
    {
        return Err("pdf-to-image:invalid-selection".to_string());
    }
    if mode == PdfToImageExportMode::Long
        && request.page_numbers.len() > PDF_TO_IMAGE_MAX_LONG_PAGES
    {
        return Err("pdf-to-image:too-many-long-pages".to_string());
    }
    let pages_per_long_image = usize::from(
        request
            .pages_per_long_image
            .unwrap_or(PDF_TO_IMAGE_MAX_PAGES_PER_LONG_IMAGE as u8),
    );
    if pages_per_long_image == 0 || pages_per_long_image > PDF_TO_IMAGE_MAX_PAGES_PER_LONG_IMAGE {
        return Err("pdf-to-image:invalid-group-size".to_string());
    }
    let jpeg_quality = request.jpeg_quality.unwrap_or(92);
    if !(60..=100).contains(&jpeg_quality) {
        return Err("pdf-to-image:invalid-quality".to_string());
    }
    let (format, extension) = normalize_pdf_to_image_format(&request.format)?;
    let background = stitch_background(request.background_rgba.as_deref().unwrap_or("#FFFFFFFF"))
        .map_err(|_| "pdf-to-image:invalid-background".to_string())?;
    let base_name =
        normalize_image_stitch_output_name(request.output_name.as_deref().or(Some("document")))
            .map_err(|_| "pdf-to-image:invalid-output-name".to_string())?
            .trim()
            .to_string();
    let session_directory = pdf_to_image_session_directory(&request.session_id)?;
    let output_directory = validate_image_output_dir(&request.output_dir)
        .map_err(|_| "pdf-to-image:output-path".to_string())?;

    progress("prepare", 0, request.page_numbers.len(), 2);
    let pages = load_pdf_to_image_source_pages(&session_directory, &request.page_numbers)?;
    for (index, _) in pages.iter().enumerate() {
        if cancelled.load(Ordering::SeqCst) {
            return Err("pdf-to-image:cancelled".to_string());
        }
        progress(
            "inspect",
            index + 1,
            pages.len(),
            2 + (((index + 1) * 10 / pages.len()) as u8),
        );
    }

    let max_output_pixels = available_image_stitch_pixels().min(PDF_TO_IMAGE_MAX_LONG_PIXELS);
    let groups = build_pdf_to_image_groups(&pages, mode, pages_per_long_image, max_output_pixels)?;
    let mut prepared = Vec::with_capacity(groups.len());
    for (index, group) in groups.iter().enumerate() {
        if cancelled.load(Ordering::SeqCst) {
            return Err("pdf-to-image:cancelled".to_string());
        }
        let layout = pdf_to_image_group_layout(group, max_output_pixels)?;
        progress(
            "compose",
            index,
            groups.len(),
            12 + ((index * 65 / groups.len()) as u8),
        );
        let canvas = compose_pdf_to_image_group(group, &layout, background, &format, cancelled)?;
        let temporary = PdfToImageTemporaryFile::new(&output_directory);
        encode_pdf_to_image(canvas, &temporary.path, &format, jpeg_quality)?;
        if cancelled.load(Ordering::SeqCst) {
            return Err("pdf-to-image:cancelled".to_string());
        }
        prepared.push(PdfToImagePreparedOutput {
            temporary,
            logical_stem: pdf_to_image_logical_stem(
                &base_name,
                mode,
                index,
                group,
                request.page_count,
            ),
            extension: extension.clone(),
            width: layout.width,
            height: layout.height,
            page_numbers: group.iter().map(|page| page.page_number).collect(),
        });
        progress(
            "encode",
            index + 1,
            groups.len(),
            12 + (((index + 1) * 73 / groups.len()) as u8),
        );
    }

    progress("publish", prepared.len(), prepared.len(), 90);
    let outputs = publish_pdf_to_image_batch(&prepared, &output_directory, cancelled)?;
    progress("complete", outputs.len(), outputs.len(), 100);
    Ok(PdfToImageExportResult {
        output_dir: cleanup_display_path(&output_directory),
        output_count: outputs.len(),
        page_count: pages.len(),
        outputs,
        format: format.to_ascii_uppercase(),
        export_mode: match mode {
            PdfToImageExportMode::Pages => "images".to_string(),
            PdfToImageExportMode::Long => "long".to_string(),
        },
    })
}

#[tauri::command]
async fn export_pdf_to_images(
    app_handle: tauri::AppHandle,
    request: PdfToImageExportRequest,
) -> Result<PdfToImageExportResult, String> {
    let job_id = request
        .job_id
        .clone()
        .unwrap_or_else(|| "desktop".to_string());
    let job_guard = PdfToImageJobGuard::register(job_id.clone())?;
    let _guard = begin_conversion().map_err(|_| "pdf-to-image:busy".to_string())?;
    let cleanup_session_id = request.session_id.clone();
    let cancelled = std::sync::Arc::clone(&job_guard.cancelled);
    let worker = tokio::task::spawn_blocking(move || {
        export_pdf_to_images_blocking(request, &cancelled, |phase, current, total, percent| {
            let _ = app_handle.emit(
                "pdf-to-image-progress",
                serde_json::json!({
                    "jobId": job_id,
                    "phase": phase,
                    "current": current,
                    "total": total,
                    "percent": percent
                }),
            );
        })
    })
    .await
    .map_err(|error| format!("pdf-to-image:worker-failed:{error}"));
    let _ = remove_pdf_to_image_session(&cleanup_session_id);
    worker?
}

#[cfg(test)]
mod pdf_to_image_backend_tests {
    use super::*;
    use image::{GenericImageView, ImageEncoder};
    use tauri::ipc::IpcResponse;

    fn test_directory(label: &str) -> std::path::PathBuf {
        let suffix = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("clock must be after Unix epoch")
            .as_nanos();
        let directory = std::env::temp_dir().join(format!(
            "toolknit-pdf-to-image-test-{}-{}-{}",
            label,
            std::process::id(),
            suffix
        ));
        std::fs::create_dir_all(&directory).expect("create PDF-to-image test directory");
        directory
    }

    fn solid_png(width: u32, height: u32, color: image::Rgba<u8>) -> Vec<u8> {
        let image = image::RgbaImage::from_pixel(width, height, color);
        let mut bytes = Vec::new();
        image::codecs::png::PngEncoder::new(&mut bytes)
            .write_image(
                image.as_raw(),
                width,
                height,
                image::ExtendedColorType::Rgba8,
            )
            .expect("encode test PNG");
        bytes
    }

    #[test]
    fn pdf_to_image_names_match_the_frontend_contract() {
        let page = PdfToImageSourcePage {
            page_number: 7,
            path: std::path::PathBuf::new(),
            width: 10,
            height: 20,
        };
        assert_eq!(
            pdf_to_image_logical_stem(
                "document",
                PdfToImageExportMode::Pages,
                0,
                std::slice::from_ref(&page),
                8,
            ),
            "document_page_07"
        );
        let mut second = page.clone();
        second.page_number = 105;
        assert_eq!(
            pdf_to_image_logical_stem(
                "document",
                PdfToImageExportMode::Long,
                1,
                &[page, second],
                200,
            ),
            "document_long_02_pages_007_105"
        );
        assert_eq!(
            pdf_to_image_page_number_from_file_name("page_00007.png"),
            Some(7)
        );
        assert_eq!(
            pdf_to_image_page_number_from_file_name("../page_00007.png"),
            None
        );
        assert!(normalize_image_stitch_output_name(Some(&"页面".repeat(32))).is_ok());
    }

    #[test]
    fn pdf_to_image_native_grouping_matches_the_frontend_plan() {
        let pages = (1..=16)
            .map(|page_number| PdfToImageSourcePage {
                page_number,
                path: std::path::PathBuf::new(),
                width: 100,
                height: 200,
            })
            .collect::<Vec<_>>();
        let groups = build_pdf_to_image_groups(
            &pages,
            PdfToImageExportMode::Long,
            PDF_TO_IMAGE_MAX_PAGES_PER_LONG_IMAGE,
            PDF_TO_IMAGE_MAX_LONG_PIXELS,
        )
        .expect("build 16-page long-image groups");

        assert_eq!(
            groups.iter().map(Vec::len).collect::<Vec<_>>(),
            vec![5, 5, 5, 1]
        );
        assert_eq!(
            groups
                .iter()
                .map(|group| group
                    .iter()
                    .map(|page| page.page_number)
                    .collect::<Vec<_>>())
                .collect::<Vec<_>>(),
            vec![
                vec![1, 2, 3, 4, 5],
                vec![6, 7, 8, 9, 10],
                vec![11, 12, 13, 14, 15],
                vec![16],
            ]
        );

        let memory_limited = build_pdf_to_image_groups(
            &pages[..6],
            PdfToImageExportMode::Long,
            PDF_TO_IMAGE_MAX_PAGES_PER_LONG_IMAGE,
            60_000,
        )
        .expect("split groups to respect the native pixel budget");
        assert_eq!(
            memory_limited.iter().map(Vec::len).collect::<Vec<_>>(),
            vec![3, 3]
        );
    }

    #[test]
    fn pdf_to_image_source_read_uses_a_raw_ipc_response() {
        let root = test_directory("raw-read");
        let input = root.join("sample.pdf");
        let expected = b"\xef\xbb\xbf%PDF-1.7\n%%EOF\n".to_vec();
        std::fs::write(&input, &expected).expect("write PDF fixture");
        let response = read_pdf_to_image_source(input.to_string_lossy().into_owned())
            .expect("read PDF fixture");
        match response.body().expect("build raw IPC body") {
            tauri::ipc::InvokeResponseBody::Raw(bytes) => assert_eq!(bytes, expected),
            tauri::ipc::InvokeResponseBody::Json(_) => panic!("PDF response must stay binary"),
        }
        std::fs::remove_dir_all(root).expect("remove test directory");
    }

    #[test]
    fn pdf_to_image_json_writer_accepts_frontend_page_bytes() {
        let session = create_pdf_to_image_session().expect("create page session");
        let bytes = solid_png(12, 8, image::Rgba([10, 20, 30, 255]));
        let result = write_pdf_to_image_page_json(
            session.session_id.clone(),
            "page_00003.png".to_string(),
            bytes,
        )
        .expect("write page through JSON command");

        assert_eq!(result.page_number, 3);
        assert_eq!(result.width, 12);
        assert_eq!(result.height, 8);
        remove_pdf_to_image_session(&session.session_id).expect("remove page session");
    }

    #[test]
    fn pdf_to_image_pre_cancelled_job_stops_before_file_access() {
        let _conversion_lock = test_conversion_lock();
        let job_id = format!(
            "pre-cancel-{}",
            PDF_TO_IMAGE_TEMP_COUNTER.fetch_add(1, Ordering::SeqCst)
        );
        cancel_pdf_to_image(job_id.clone()).expect("pre-cancel PDF export job");
        let job_guard = PdfToImageJobGuard::register(job_id).expect("register cancelled job");

        let error = export_pdf_to_images_blocking(
            PdfToImageExportRequest {
                session_id: "missing-session".to_string(),
                page_numbers: vec![1],
                page_count: 1,
                output_dir: "missing-output".to_string(),
                output_name: Some("cancelled".to_string()),
                format: "png".to_string(),
                export_mode: "images".to_string(),
                pages_per_long_image: Some(5),
                jpeg_quality: Some(92),
                background_rgba: Some("#FFFFFFFF".to_string()),
                job_id: None,
            },
            &job_guard.cancelled,
            |_, _, _, _| panic!("pre-cancelled export must not report progress"),
        )
        .expect_err("pre-cancelled export must stop immediately");

        assert_eq!(error, "pdf-to-image:cancelled");
    }

    #[test]
    fn pdf_to_image_rejects_duplicate_and_zero_page_numbers() {
        let _conversion_lock = test_conversion_lock();
        let cancelled = AtomicBool::new(false);
        let request_for = |page_numbers| PdfToImageExportRequest {
            session_id: "missing-session".to_string(),
            page_numbers,
            page_count: 2,
            output_dir: "missing-output".to_string(),
            output_name: Some("invalid-selection".to_string()),
            format: "png".to_string(),
            export_mode: "images".to_string(),
            pages_per_long_image: Some(5),
            jpeg_quality: Some(92),
            background_rgba: Some("#FFFFFFFF".to_string()),
            job_id: None,
        };

        for page_numbers in [vec![1, 1], vec![0]] {
            assert_eq!(
                export_pdf_to_images_blocking(
                    request_for(page_numbers),
                    &cancelled,
                    |_, _, _, _| panic!("invalid selection must not report progress"),
                )
                .expect_err("invalid page selection must fail before file access"),
                "pdf-to-image:invalid-selection"
            );
        }
    }

    #[test]
    fn pdf_to_image_cancel_does_not_touch_shared_conversion_flag() {
        let _conversion_lock = test_conversion_lock();
        CANCEL_FLAG.store(false, Ordering::SeqCst);
        let job_id = format!(
            "isolated-cancel-{}",
            PDF_TO_IMAGE_TEMP_COUNTER.fetch_add(1, Ordering::SeqCst)
        );

        cancel_pdf_to_image(job_id.clone()).expect("cancel isolated PDF export job");

        assert!(!CANCEL_FLAG.load(Ordering::SeqCst));
        let job_guard = PdfToImageJobGuard::register(job_id).expect("register cancelled job");
        assert!(job_guard.cancelled.load(Ordering::SeqCst));
    }

    #[test]
    fn pdf_to_image_duplicate_job_cannot_orphan_the_active_cancel_token() {
        let _conversion_lock = test_conversion_lock();
        let job_id = format!(
            "duplicate-job-{}",
            PDF_TO_IMAGE_TEMP_COUNTER.fetch_add(1, Ordering::SeqCst)
        );
        let active = PdfToImageJobGuard::register(job_id.clone()).expect("register active job");

        assert_eq!(
            PdfToImageJobGuard::register(job_id.clone())
                .err()
                .expect("duplicate job must fail"),
            "pdf-to-image:duplicate-job"
        );
        cancel_pdf_to_image(job_id).expect("cancel the original active job");
        assert!(active.cancelled.load(Ordering::SeqCst));
    }

    #[test]
    fn pdf_to_image_exports_a_single_page_long_group_as_webp() {
        let _conversion_lock = test_conversion_lock();
        let cancelled = AtomicBool::new(false);
        let root = test_directory("webp-single");
        let output = root.join("outputs");
        std::fs::create_dir_all(&output).expect("create output directory");
        let session = create_pdf_to_image_session().expect("create page session");
        let bytes = solid_png(6, 4, image::Rgba([12, 34, 56, 255]));
        write_pdf_to_image_page_bytes(&session.session_id, "page_00006.png", &bytes)
            .expect("write rendered PDF page");

        let result = export_pdf_to_images_blocking(
            PdfToImageExportRequest {
                session_id: session.session_id.clone(),
                page_numbers: vec![6],
                page_count: 6,
                output_dir: output.to_string_lossy().into_owned(),
                output_name: Some("sample".to_string()),
                format: "webp".to_string(),
                export_mode: "long".to_string(),
                pages_per_long_image: Some(5),
                jpeg_quality: Some(97),
                background_rgba: Some("#FFFFFFFF".to_string()),
                job_id: None,
            },
            &cancelled,
            |_, _, _, _| {},
        )
        .expect("export single-page WebP long group");
        assert_eq!(result.output_count, 1);
        assert_eq!(result.outputs[0].page_numbers, vec![6]);
        assert!(result.outputs[0]
            .output_path
            .ends_with("sample_long_01_pages_06.webp"));
        let decoded = image::open(&result.outputs[0].output_path)
            .expect("decode WebP output")
            .to_rgba8();
        assert_eq!(decoded.dimensions(), (6, 4));
        assert_eq!(decoded.get_pixel(2, 2).0, [12, 34, 56, 255]);

        remove_pdf_to_image_session(&session.session_id).expect("remove page session");
        std::fs::remove_dir_all(root).expect("remove test directory");
    }

    #[test]
    fn pdf_to_image_encodes_png_and_jpg_outputs() {
        let _conversion_lock = test_conversion_lock();
        let root = test_directory("png-jpg-encoding");
        let source = image::RgbaImage::from_pixel(8, 5, image::Rgba([48, 96, 144, 255]));

        for format in ["png", "jpg"] {
            let temporary = PdfToImageTemporaryFile::new(&root);
            encode_pdf_to_image(source.clone(), &temporary.path, format, 94)
                .expect("encode PDF page image");
            let decoded = image::ImageReader::open(&temporary.path)
                .expect("open encoded PDF page image")
                .with_guessed_format()
                .expect("detect encoded PDF page image format")
                .decode()
                .expect("decode encoded PDF page image");
            assert_eq!(decoded.dimensions(), (8, 5));
        }

        std::fs::remove_dir_all(root).expect("remove test directory");
    }

    #[test]
    fn pdf_to_image_exports_sixteen_pages_as_four_png_long_images() {
        let _conversion_lock = test_conversion_lock();
        let cancelled = AtomicBool::new(false);
        let root = test_directory("sixteen-page-long-images");
        let output = root.join("outputs");
        std::fs::create_dir_all(&output).expect("create output directory");
        let session = create_pdf_to_image_session().expect("create page session");
        for page_number in 1..=16u32 {
            let color = image::Rgba([page_number as u8, 40, 80, 255]);
            let bytes = solid_png(2, 2, color);
            write_pdf_to_image_page_bytes(
                &session.session_id,
                &format!("page_{page_number:05}.png"),
                &bytes,
            )
            .expect("write rendered PDF page");
        }

        let result = export_pdf_to_images_blocking(
            PdfToImageExportRequest {
                session_id: session.session_id.clone(),
                page_numbers: (1..=16).collect(),
                page_count: 16,
                output_dir: output.to_string_lossy().into_owned(),
                output_name: Some("sixteen".to_string()),
                format: "png".to_string(),
                export_mode: "long".to_string(),
                pages_per_long_image: Some(5),
                jpeg_quality: Some(94),
                background_rgba: Some("#FFFFFFFF".to_string()),
                job_id: None,
            },
            &cancelled,
            |_, _, _, _| {},
        )
        .expect("export sixteen PDF pages");

        assert_eq!(result.output_count, 4);
        assert_eq!(
            result
                .outputs
                .iter()
                .map(|item| item.page_numbers.clone())
                .collect::<Vec<_>>(),
            vec![
                vec![1, 2, 3, 4, 5],
                vec![6, 7, 8, 9, 10],
                vec![11, 12, 13, 14, 15],
                vec![16],
            ]
        );
        assert_eq!(
            result
                .outputs
                .iter()
                .map(|item| (item.width, item.height))
                .collect::<Vec<_>>(),
            vec![(2, 10), (2, 10), (2, 10), (2, 2)]
        );
        for item in &result.outputs {
            image::open(&item.output_path).expect("decode exported PNG long image");
        }
        assert!(result.outputs[3]
            .output_path
            .ends_with("sixteen_long_04_pages_16.png"));

        remove_pdf_to_image_session(&session.session_id).expect("remove page session");
        std::fs::remove_dir_all(root).expect("remove test directory");
    }

    #[test]
    fn pdf_to_image_long_layout_preserves_page_pixels_and_centers_narrow_pages() {
        let _conversion_lock = test_conversion_lock();
        let cancelled = AtomicBool::new(false);
        let root = test_directory("centering");
        let narrow_path = root.join("narrow.png");
        let wide_path = root.join("wide.png");
        std::fs::write(&narrow_path, solid_png(2, 2, image::Rgba([255, 0, 0, 255])))
            .expect("write narrow page");
        std::fs::write(&wide_path, solid_png(4, 1, image::Rgba([0, 0, 255, 255])))
            .expect("write wide page");
        let pages = vec![
            PdfToImageSourcePage {
                page_number: 1,
                path: narrow_path,
                width: 2,
                height: 2,
            },
            PdfToImageSourcePage {
                page_number: 2,
                path: wide_path,
                width: 4,
                height: 1,
            },
        ];
        let layout = pdf_to_image_group_layout(&pages, PDF_TO_IMAGE_MAX_LONG_PIXELS)
            .expect("calculate centered long layout");
        assert_eq!((layout.width, layout.height), (4, 3));
        assert_eq!(layout.sizes, vec![(2, 2), (4, 1)]);
        let canvas = compose_pdf_to_image_group(
            &pages,
            &layout,
            image::Rgba([255, 255, 255, 255]),
            "png",
            &cancelled,
        )
        .expect("compose centered long image");
        assert_eq!(canvas.get_pixel(0, 0).0, [255, 255, 255, 255]);
        assert_eq!(canvas.get_pixel(1, 0).0, [255, 0, 0, 255]);
        assert_eq!(canvas.get_pixel(0, 2).0, [0, 0, 255, 255]);
        std::fs::remove_dir_all(root).expect("remove test directory");
    }

    #[test]
    fn pdf_to_image_batch_publish_rolls_back_on_failure() {
        let _conversion_lock = test_conversion_lock();
        let cancelled = AtomicBool::new(false);
        let root = test_directory("rollback");
        let first_temporary = PdfToImageTemporaryFile::new(&root);
        let missing_temporary = PdfToImageTemporaryFile::new(&root);
        std::fs::write(&first_temporary.path, b"complete first output")
            .expect("write first temporary output");
        let prepared = vec![
            PdfToImagePreparedOutput {
                temporary: first_temporary,
                logical_stem: "rollback_first".to_string(),
                extension: ".png".to_string(),
                width: 1,
                height: 1,
                page_numbers: vec![1],
            },
            PdfToImagePreparedOutput {
                temporary: missing_temporary,
                logical_stem: "rollback_second".to_string(),
                extension: ".png".to_string(),
                width: 1,
                height: 1,
                page_numbers: vec![2],
            },
        ];
        assert_eq!(
            publish_pdf_to_image_batch(&prepared, &root, &cancelled)
                .expect_err("missing second temporary output must fail"),
            "pdf-to-image:publish-failed"
        );
        assert!(!root.join("rollback_first.png").exists());
        assert!(!root.join("rollback_second.png").exists());
        drop(prepared);
        std::fs::remove_dir_all(root).expect("remove test directory");
    }

    #[test]
    fn pdf_to_image_cancelled_batch_publishes_no_outputs() {
        let _conversion_lock = test_conversion_lock();
        let cancelled = AtomicBool::new(true);
        let root = test_directory("cancelled-publish");
        let temporary = PdfToImageTemporaryFile::new(&root);
        std::fs::write(&temporary.path, b"complete temporary output")
            .expect("write temporary output");
        let prepared = vec![PdfToImagePreparedOutput {
            temporary,
            logical_stem: "must_not_publish".to_string(),
            extension: ".png".to_string(),
            width: 1,
            height: 1,
            page_numbers: vec![1],
        }];

        assert_eq!(
            publish_pdf_to_image_batch(&prepared, &root, &cancelled)
                .expect_err("cancelled batch must not publish"),
            "pdf-to-image:cancelled"
        );
        assert!(!root.join("must_not_publish.png").exists());

        drop(prepared);
        std::fs::remove_dir_all(root).expect("remove test directory");
    }

    #[test]
    fn pdf_to_image_copy_fallback_is_complete_and_never_overwrites() {
        let _conversion_lock = test_conversion_lock();
        let root = test_directory("copy-fallback");
        let source = root.join("source.tmp");
        let target = root.join("target.png");
        let cancelled_target = root.join("cancelled.png");
        let payload = vec![0x5au8; 700_000];
        std::fs::write(&source, &payload).expect("write fallback source");

        let running = AtomicBool::new(false);
        copy_pdf_to_image_output(&source, &target, &running).expect("copy fallback output");
        assert_eq!(
            std::fs::read(&target).expect("read fallback output"),
            payload
        );

        std::fs::write(&source, b"replacement").expect("replace fallback source");
        assert_eq!(
            copy_pdf_to_image_output(&source, &target, &running)
                .expect_err("fallback must not overwrite an existing output")
                .kind(),
            std::io::ErrorKind::AlreadyExists
        );
        assert_eq!(
            std::fs::metadata(&target)
                .expect("read target metadata")
                .len(),
            700_000
        );

        let cancelled = AtomicBool::new(true);
        assert_eq!(
            copy_pdf_to_image_output(&source, &cancelled_target, &cancelled)
                .expect_err("cancelled fallback must stop before publication")
                .kind(),
            std::io::ErrorKind::Interrupted
        );
        assert!(!cancelled_target.exists());
        std::fs::remove_dir_all(root).expect("remove test directory");
    }

    #[test]
    fn shared_image_stitch_backend_accepts_webp() {
        let _conversion_lock = test_conversion_lock();
        let root = test_directory("shared-webp");
        let first = root.join("first.png");
        let second = root.join("second.png");
        std::fs::write(&first, solid_png(3, 2, image::Rgba([255, 0, 0, 255])))
            .expect("write first stitch page");
        std::fs::write(&second, solid_png(3, 1, image::Rgba([0, 0, 255, 255])))
            .expect("write second stitch page");
        let result = stitch_images_blocking(
            ImageStitchOptions {
                input_paths: vec![
                    first.to_string_lossy().into_owned(),
                    second.to_string_lossy().into_owned(),
                ],
                output_dir: root.to_string_lossy().into_owned(),
                output_name: Some("shared-stitch".to_string()),
                mode: "vertical".to_string(),
                reference: "first".to_string(),
                spacing_px: 0,
                scale_percent: 100,
                format: "webp".to_string(),
                jpeg_quality: 92,
                background_rgba: "#FFFFFFFF".to_string(),
            },
            |_, _, _, _| {},
        )
        .expect("export shared WebP stitch");
        assert!(result.output_path.ends_with("shared-stitch.webp"));
        assert_eq!(
            image::open(&result.output_path).unwrap().dimensions(),
            (3, 3)
        );
        std::fs::remove_dir_all(root).expect("remove test directory");
    }
}

#[cfg(test)]
mod image_conversion_tests {
    use super::*;
    use image::{GenericImage, GenericImageView, ImageEncoder};

    fn image_test_directory(label: &str) -> std::path::PathBuf {
        let unique = format!(
            "toolknit-image-{}-{}-{}",
            label,
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("system clock before Unix epoch")
                .as_nanos()
        );
        let directory = std::env::temp_dir().join(unique);
        std::fs::create_dir_all(&directory).expect("create temporary image test directory");
        directory
    }

    fn exif_orientation_payload(orientation: u16) -> Vec<u8> {
        let mut exif = vec![0_u8; 26];
        exif[0..2].copy_from_slice(b"II");
        exif[2..4].copy_from_slice(&42_u16.to_le_bytes());
        exif[4..8].copy_from_slice(&8_u32.to_le_bytes());
        exif[8..10].copy_from_slice(&1_u16.to_le_bytes());
        exif[10..12].copy_from_slice(&0x0112_u16.to_le_bytes());
        exif[12..14].copy_from_slice(&3_u16.to_le_bytes());
        exif[14..18].copy_from_slice(&1_u32.to_le_bytes());
        exif[18..20].copy_from_slice(&orientation.to_le_bytes());
        exif
    }

    fn write_exif_jpeg(path: &std::path::Path, image: &image::RgbImage, orientation: u16) {
        let file = std::fs::File::create(path).expect("create EXIF JPEG fixture");
        let writer = std::io::BufWriter::new(file);
        let mut encoder = image::codecs::jpeg::JpegEncoder::new_with_quality(writer, 100);
        encoder
            .set_exif_metadata(exif_orientation_payload(orientation))
            .expect("attach EXIF orientation");
        encoder
            .encode(
                image.as_raw(),
                image.width(),
                image.height(),
                image::ExtendedColorType::Rgb8,
            )
            .expect("encode EXIF JPEG fixture");
    }

    fn assert_rgb_near(actual: image::Rgb<u8>, expected: [u8; 3], tolerance: i16) {
        for (actual, expected) in actual.0.into_iter().zip(expected) {
            assert!(
                (i16::from(actual) - i16::from(expected)).abs() <= tolerance,
                "channel {actual} differs from expected {expected} by more than {tolerance}"
            );
        }
    }

    #[test]
    fn jpeg_writers_flatten_transparent_pixels_onto_white() {
        let directory = image_test_directory("jpeg-alpha");
        let input = directory.join("transparent.png");
        let converted_output = directory.join("converted.jpg");
        let compressed_output = directory.join("compressed.jpg");

        let source = image::RgbaImage::from_fn(64, 64, |x, y| match (x < 32, y < 32) {
            (true, true) => image::Rgba([255, 0, 0, 0]),
            (false, true) => image::Rgba([0, 255, 0, 255]),
            (true, false) => image::Rgba([0, 0, 255, 128]),
            (false, false) => image::Rgba([0, 0, 0, 0]),
        });
        source.save(&input).expect("write transparent PNG fixture");
        let decoded = decode_oriented_image(&input).expect("decode transparent PNG fixture");
        write_converted_image(&decoded, &converted_output, image::ImageFormat::Jpeg)
            .expect("RGBA image should convert to JPEG");
        write_compressed_image(
            &decoded,
            &compressed_output,
            image::ImageFormat::Jpeg,
            92,
            image::codecs::png::CompressionType::Default,
        )
        .expect("RGBA image should compress to JPEG");

        for output in [&converted_output, &compressed_output] {
            let decoded = image::open(output)
                .expect("JPEG output should be readable")
                .to_rgb8();
            assert_eq!((decoded.width(), decoded.height()), (64, 64));
            assert_rgb_near(*decoded.get_pixel(4, 4), [255, 255, 255], 20);
            assert_rgb_near(*decoded.get_pixel(59, 4), [0, 255, 0], 20);
            assert_rgb_near(*decoded.get_pixel(4, 59), [127, 127, 255], 24);
            assert_rgb_near(*decoded.get_pixel(59, 59), [255, 255, 255], 20);
        }
        std::fs::remove_dir_all(&directory).expect("remove temporary image test directory");
    }

    #[test]
    fn exif_orientation_is_applied_to_shared_decode_and_icon_preparation() {
        let directory = image_test_directory("exif-orientation");
        let input = directory.join("orientation-6.jpg");
        let converted = directory.join("orientation-applied.png");
        let source = image::RgbImage::from_fn(64, 32, |x, y| match (x < 32, y < 16) {
            (true, true) => image::Rgb([255, 0, 0]),
            (false, true) => image::Rgb([0, 255, 0]),
            (true, false) => image::Rgb([0, 0, 255]),
            (false, false) => image::Rgb([255, 255, 0]),
        });
        write_exif_jpeg(&input, &source, 6);

        let decoded = decode_oriented_image(&input).expect("decode oriented JPEG");
        assert_eq!((decoded.width(), decoded.height()), (32, 64));
        let decoded_rgb = decoded.to_rgb8();
        assert_rgb_near(*decoded_rgb.get_pixel(4, 4), [0, 0, 255], 28);
        assert_rgb_near(*decoded_rgb.get_pixel(27, 4), [255, 0, 0], 28);
        assert_rgb_near(*decoded_rgb.get_pixel(4, 59), [255, 255, 0], 28);
        assert_rgb_near(*decoded_rgb.get_pixel(27, 59), [0, 255, 0], 28);

        write_converted_image(&decoded, &converted, image::ImageFormat::Png)
            .expect("write orientation-normalized PNG");
        let normalized = image::open(&converted)
            .expect("read orientation-normalized PNG")
            .to_rgb8();
        assert_eq!(normalized.dimensions(), (32, 64));
        assert_rgb_near(*normalized.get_pixel(4, 4), [0, 0, 255], 28);

        let prepared = prepare_icon_source_image(input.to_string_lossy().into_owned())
            .expect("prepare oriented icon source");
        assert_eq!((prepared.width, prepared.height), (32, 64));
        let prepared_image = image::load_from_memory(&prepared.bytes)
            .expect("decode prepared icon PNG")
            .to_rgb8();
        assert_rgb_near(*prepared_image.get_pixel(4, 4), [0, 0, 255], 28);
        std::fs::remove_dir_all(&directory).expect("remove temporary image test directory");
    }

    #[test]
    fn svg_conversion_produces_a_standard_embedded_image_document() {
        let unique = format!(
            "toolknit-svg-test-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("system clock before Unix epoch")
                .as_nanos()
        );
        let directory = std::env::temp_dir().join(unique);
        std::fs::create_dir_all(&directory).expect("create temporary image test directory");
        let output = directory.join("converted.svg");
        let source = image::DynamicImage::new_rgba8(3, 2);
        write_raster_svg(&source, &output).expect("write SVG image document");

        let svg = std::fs::read_to_string(&output).expect("read SVG output");
        assert!(svg.contains("<svg xmlns=\"http://www.w3.org/2000/svg\""));
        assert!(svg.contains("width=\"3\" height=\"2\""));
        assert!(svg.contains("data:image/png;base64,"));
        std::fs::remove_dir_all(&directory).expect("remove temporary image test directory");
    }

    #[test]
    fn image_batch_rejects_duplicate_inputs_and_never_overwrites_outputs() {
        let unique = format!(
            "toolknit-image-publish-test-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("system clock before Unix epoch")
                .as_nanos()
        );
        let directory = std::env::temp_dir().join(unique);
        std::fs::create_dir_all(&directory).expect("create temporary image test directory");
        let input = directory.join("input.png");
        image::DynamicImage::new_rgba8(2, 2)
            .save_with_format(&input, image::ImageFormat::Png)
            .expect("write input PNG");

        let duplicate_result = validate_image_batch_inputs(&[
            input.to_string_lossy().to_string(),
            input.to_string_lossy().to_string(),
        ]);
        assert!(duplicate_result
            .expect_err("duplicate input must fail")
            .contains("Duplicate image file"));

        let temporary = directory.join("temporary.png");
        let output = directory.join("output.png");
        std::fs::write(&temporary, b"new-content").expect("write temporary output");
        std::fs::write(&output, b"existing-content").expect("write existing output");
        assert!(publish_image_output(&temporary, &output).is_err());
        assert_eq!(
            std::fs::read(&output).expect("read existing output"),
            b"existing-content"
        );
        assert!(temporary.exists());

        std::fs::remove_file(&output).expect("remove existing output");
        publish_image_output(&temporary, &output).expect("publish new output");
        assert_eq!(
            std::fs::read(&output).expect("read published output"),
            b"new-content"
        );
        assert!(!temporary.exists());
        std::fs::remove_dir_all(&directory).expect("remove temporary image test directory");
    }

    fn stitch_test_options(
        inputs: &[std::path::PathBuf],
        output: &std::path::Path,
        mode: &str,
        format: &str,
        background: &str,
    ) -> ImageStitchOptions {
        ImageStitchOptions {
            input_paths: inputs
                .iter()
                .map(|path| path.to_string_lossy().into_owned())
                .collect(),
            output_dir: output.to_string_lossy().into_owned(),
            output_name: None,
            mode: mode.to_string(),
            reference: "first".to_string(),
            spacing_px: 0,
            scale_percent: 100,
            format: format.to_string(),
            jpeg_quality: 92,
            background_rgba: background.to_string(),
        }
    }

    #[test]
    fn image_stitch_layout_rounds_and_counts_only_between_item_gaps() {
        let layout =
            calculate_image_stitch_layout(&[(101, 10), (5, 7)], "vertical", "first", 9, 50)
                .expect("calculate vertical layout");
        assert_eq!(layout.width, 51);
        assert_eq!(layout.sizes, vec![(51, 5), (51, 71)]);
        assert_eq!(layout.height, 5 + 9 + 71);

        let one_hundred = vec![(1, 1); 100];
        let boundary = calculate_image_stitch_layout(&one_hundred, "vertical", "smallest", 0, 100)
            .expect("100-image boundary should be valid");
        assert_eq!((boundary.width, boundary.height), (1, 100));
        assert!(
            calculate_image_stitch_layout(&vec![(1, 1); 101], "vertical", "first", 0, 100,)
                .is_err()
        );
    }

    #[test]
    fn image_stitch_outputs_are_complete_unique_and_pixel_correct() {
        let unique = format!(
            "toolknit-stitch-native-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("system clock before Unix epoch")
                .as_nanos()
        );
        let directory = std::env::temp_dir().join(unique);
        let output = directory.join("导出 结果");
        std::fs::create_dir_all(&output).expect("create stitch output directory");
        let red = directory.join("红 色.png");
        let blue = directory.join("blue.png");
        let transparent = directory.join("透明.png");
        image::RgbaImage::from_pixel(10, 20, image::Rgba([255, 0, 0, 255]))
            .save(&red)
            .expect("write red input");
        image::RgbaImage::from_pixel(20, 10, image::Rgba([0, 0, 255, 255]))
            .save(&blue)
            .expect("write blue input");
        image::RgbaImage::from_pixel(10, 10, image::Rgba([0, 0, 0, 0]))
            .save(&transparent)
            .expect("write transparent input");
        CANCEL_FLAG.store(false, Ordering::SeqCst);

        let first = stitch_images_blocking(
            stitch_test_options(
                &[red.clone(), blue.clone()],
                &output,
                "vertical",
                "png",
                "#FFFFFFFF",
            ),
            |_, _, _, _| {},
        )
        .expect("stitch vertical PNG");
        assert_eq!((first.width, first.height), (10, 25));
        let decoded = image::open(&first.output_path)
            .expect("read vertical output")
            .to_rgba8();
        assert_eq!(decoded.get_pixel(5, 19).0, [255, 0, 0, 255]);
        assert_eq!(decoded.get_pixel(5, 20).0, [0, 0, 255, 255]);

        let mut horizontal_options = stitch_test_options(
            &[red.clone(), blue.clone()],
            &output,
            "horizontal",
            "png",
            "#00FF00FF",
        );
        horizontal_options.spacing_px = 3;
        horizontal_options.reference = "largest".to_string();
        horizontal_options.scale_percent = 50;
        let second = stitch_images_blocking(horizontal_options, |_, _, _, _| {})
            .expect("stitch horizontal PNG");
        assert_eq!((second.width, second.height), (28, 10));
        assert_ne!(first.output_path, second.output_path);
        let horizontal = image::open(&second.output_path)
            .expect("read horizontal output")
            .to_rgba8();
        assert_eq!(horizontal.get_pixel(4, 5).0, [255, 0, 0, 255]);
        assert_eq!(horizontal.get_pixel(5, 5).0, [0, 255, 0, 255]);
        assert_eq!(horizontal.get_pixel(7, 5).0, [0, 255, 0, 255]);
        assert_eq!(horizontal.get_pixel(8, 5).0, [0, 0, 255, 255]);

        let alpha_result = stitch_images_blocking(
            stitch_test_options(
                &[transparent.clone(), blue.clone()],
                &output,
                "vertical",
                "png",
                "#12345600",
            ),
            |_, _, _, _| {},
        )
        .expect("stitch transparent PNG");
        let alpha = image::open(&alpha_result.output_path)
            .expect("read transparent output")
            .to_rgba8();
        assert_eq!(alpha.get_pixel(2, 2).0[3], 0);

        let jpeg_result = stitch_images_blocking(
            stitch_test_options(
                &[transparent, blue],
                &output,
                "vertical",
                "jpg",
                "#FF00FF00",
            ),
            |_, _, _, _| {},
        )
        .expect("stitch flattened JPEG");
        let jpeg = image::open(&jpeg_result.output_path)
            .expect("read JPEG output")
            .to_rgb8();
        let pixel = jpeg.get_pixel(2, 2).0;
        assert!(pixel[0] > 220 && pixel[2] > 220);
        assert!(!std::fs::read_dir(&output)
            .expect("read output directory")
            .filter_map(Result::ok)
            .any(|entry| entry
                .file_name()
                .to_string_lossy()
                .starts_with(".toolknit-stitch-")));
        std::fs::remove_dir_all(&directory).expect("remove stitch test directory");
    }

    #[test]
    fn image_stitch_rejects_damaged_duplicate_and_animated_inputs() {
        use image::codecs::gif::GifEncoder;
        use image::{Delay, Frame};
        let unique = format!("toolknit-stitch-invalid-{}", std::process::id());
        let directory = std::env::temp_dir().join(unique);
        std::fs::create_dir_all(&directory).expect("create invalid stitch test directory");
        let valid = directory.join("valid.png");
        let damaged = directory.join("damaged.png");
        let animated = directory.join("animated.gif");
        image::RgbaImage::from_pixel(2, 2, image::Rgba([1, 2, 3, 255]))
            .save(&valid)
            .expect("write valid input");
        std::fs::write(&damaged, b"not an image").expect("write damaged input");
        let gif_file = std::fs::File::create(&animated).expect("create animated GIF");
        let mut encoder = GifEncoder::new(gif_file);
        for color in [[255, 0, 0, 255], [0, 0, 255, 255]] {
            encoder
                .encode_frame(Frame::from_parts(
                    image::RgbaImage::from_pixel(2, 2, image::Rgba(color)),
                    0,
                    0,
                    Delay::from_numer_denom_ms(100, 1),
                ))
                .expect("encode GIF frame");
        }
        drop(encoder);

        assert!(validate_image_batch_inputs(&[
            valid.to_string_lossy().into_owned(),
            damaged.to_string_lossy().into_owned(),
        ])
        .is_err());
        assert!(validate_image_batch_inputs(&[
            valid.to_string_lossy().into_owned(),
            valid.to_string_lossy().into_owned(),
        ])
        .expect_err("duplicate must fail")
        .contains("Duplicate"));
        assert!(validate_image_batch_inputs(&[
            valid.to_string_lossy().into_owned(),
            animated.to_string_lossy().into_owned(),
        ])
        .expect_err("animated GIF must fail")
        .contains("animated"));
        std::fs::remove_dir_all(&directory).expect("remove invalid stitch test directory");
    }

    #[test]
    fn icon_archive_session_publishes_uniquely_and_discards_partial_output() {
        let unique = format!(
            "toolknit-icon-archive-test-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("system clock before Unix epoch")
                .as_nanos()
        );
        let directory = std::env::temp_dir().join(unique);
        std::fs::create_dir_all(&directory).expect("create temporary icon archive directory");
        std::fs::write(directory.join("icons.zip"), b"existing").expect("write existing archive");

        let session_id = begin_icon_archive_write(
            directory.to_string_lossy().to_string(),
            "icons.zip".to_string(),
        )
        .expect("begin archive write");
        append_icon_archive_chunk(session_id, b"generated".to_vec()).expect("append archive chunk");
        let output = finalize_icon_archive_write(session_id).expect("publish archive");
        assert!(output.ends_with("icons_1.zip"));
        assert_eq!(
            std::fs::read(&output).expect("read published archive"),
            b"generated"
        );
        assert_eq!(
            std::fs::read(directory.join("icons.zip")).expect("read original archive"),
            b"existing"
        );

        let discarded_session = begin_icon_archive_write(
            directory.to_string_lossy().to_string(),
            "discard.zip".to_string(),
        )
        .expect("begin archive discard test");
        append_icon_archive_chunk(discarded_session, b"partial".to_vec())
            .expect("append partial archive");
        discard_icon_archive_write(discarded_session).expect("discard partial archive");
        assert!(!directory.join("discard.zip").exists());
        std::fs::remove_dir_all(&directory).expect("remove temporary icon archive directory");
    }

    #[test]
    fn image_conversion_keeps_successful_outputs_when_one_input_is_damaged() {
        let _conversion_lock = test_conversion_lock();
        CANCEL_FLAG.store(false, Ordering::SeqCst);
        let directory = image_test_directory("partial-convert");
        let inputs = directory.join("inputs");
        let outputs = directory.join("outputs");
        std::fs::create_dir_all(&inputs).expect("create conversion input directory");
        let first = inputs.join("first.png");
        let damaged = inputs.join("damaged.png");
        let second = inputs.join("second.png");
        image::RgbaImage::from_pixel(8, 6, image::Rgba([240, 20, 30, 255]))
            .save(&first)
            .expect("write first conversion input");
        std::fs::write(&damaged, b"not an image").expect("write damaged conversion input");
        image::RgbaImage::from_pixel(5, 9, image::Rgba([10, 180, 220, 255]))
            .save(&second)
            .expect("write second conversion input");

        let mut progress = Vec::new();
        let result = convert_image_batch_blocking_with_progress(
            vec![
                first.to_string_lossy().into_owned(),
                damaged.to_string_lossy().into_owned(),
                second.to_string_lossy().into_owned(),
            ],
            outputs.to_string_lossy().into_owned(),
            "PNG".to_string(),
            |event| progress.push(event),
        )
        .expect("conversion batch should return a partial result");

        assert_eq!((result.success_count, result.fail_count), (2, 1));
        assert_eq!(result.errors.len(), 1);
        assert!(result.errors[0].contains("damaged.png"));
        assert_eq!(
            image::open(outputs.join("first.png")).unwrap().dimensions(),
            (8, 6)
        );
        assert_eq!(
            image::open(outputs.join("second.png"))
                .unwrap()
                .dimensions(),
            (5, 9)
        );
        let damaged_error = progress
            .iter()
            .position(|event| event.file_name == "damaged.png" && event.status == "error")
            .expect("damaged input should emit an error result");
        let later_success = progress
            .iter()
            .position(|event| event.file_name == "second.png" && event.status == "done")
            .expect("later valid input should still complete");
        assert!(damaged_error < later_success);
        assert!(!std::fs::read_dir(&outputs)
            .expect("read conversion output directory")
            .filter_map(Result::ok)
            .any(|entry| entry.file_name().to_string_lossy().contains("toolknit")));
        std::fs::remove_dir_all(&directory).expect("remove partial conversion test directory");
    }

    #[test]
    fn image_compression_keeps_successes_and_reports_bad_or_unsupported_inputs() {
        let _conversion_lock = test_conversion_lock();
        CANCEL_FLAG.store(false, Ordering::SeqCst);
        let directory = image_test_directory("partial-compress");
        let inputs = directory.join("inputs");
        let outputs = directory.join("outputs");
        std::fs::create_dir_all(&inputs).expect("create compression input directory");
        let first = inputs.join("first.jpg");
        let damaged = inputs.join("damaged.jpg");
        let unsupported = inputs.join("unsupported.bmp");
        let second = inputs.join("second.jpg");

        let mut source = image::DynamicImage::new_rgba8(256, 256);
        for y in 0..256 {
            for x in 0..256 {
                let value = ((x * 31 + y * 17) % 256) as u8;
                source.put_pixel(
                    x,
                    y,
                    image::Rgba([value, value.wrapping_mul(3), value.wrapping_mul(7), 255]),
                );
            }
        }
        write_converted_image(&source, &first, image::ImageFormat::Jpeg)
            .expect("write first JPEG input");
        std::fs::write(&damaged, b"not an image").expect("write damaged JPEG input");
        image::RgbaImage::from_pixel(12, 12, image::Rgba([30, 60, 90, 255]))
            .save(&unsupported)
            .expect("write unsupported BMP input");
        write_converted_image(&source, &second, image::ImageFormat::Jpeg)
            .expect("write second JPEG input");

        let input_paths = vec![
            first.to_string_lossy().into_owned(),
            damaged.to_string_lossy().into_owned(),
            unsupported.to_string_lossy().into_owned(),
            second.to_string_lossy().into_owned(),
        ];
        assert!(validate_image_compression_inputs(&input_paths, "low").is_err());
        let expected_original_size =
            std::fs::metadata(&first).unwrap().len() + std::fs::metadata(&second).unwrap().len();
        let mut progress = Vec::new();
        let result = compress_image_batch_blocking_with_progress(
            input_paths,
            outputs.to_string_lossy().into_owned(),
            "low".to_string(),
            |event| progress.push(event),
        )
        .expect("compression batch should return a partial result");

        assert_eq!((result.success_count, result.fail_count), (2, 2));
        assert_eq!(result.errors.len(), 2);
        assert!(result
            .errors
            .iter()
            .any(|error| error.contains("damaged.jpg")));
        assert!(result
            .errors
            .iter()
            .any(|error| error.contains("unsupported.bmp")));
        assert_eq!(result.original_size, Some(expected_original_size));
        assert!(result.compressed_size.unwrap() < expected_original_size);
        assert!(image::open(outputs.join("first.jpg")).is_ok());
        assert!(image::open(outputs.join("second.jpg")).is_ok());
        assert!(!outputs.join("damaged.jpg").exists());
        assert!(!outputs.join("unsupported.bmp").exists());
        let damaged_error = progress
            .iter()
            .position(|event| event.file_name == "damaged.jpg" && event.status == "error")
            .expect("damaged compression input should emit an error result");
        let later_success = progress
            .iter()
            .position(|event| event.file_name == "second.jpg" && event.status == "done")
            .expect("later compression input should still complete");
        assert!(damaged_error < later_success);
        assert!(!std::fs::read_dir(&outputs)
            .expect("read compression output directory")
            .filter_map(Result::ok)
            .any(|entry| entry.file_name().to_string_lossy().contains("toolknit")));
        std::fs::remove_dir_all(&directory).expect("remove partial compression test directory");
    }

    #[test]
    fn jpeg_compression_produces_a_smaller_readable_file() {
        let unique = format!(
            "toolknit-compression-test-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("system clock before Unix epoch")
                .as_nanos()
        );
        let directory = std::env::temp_dir().join(unique);
        std::fs::create_dir_all(&directory).expect("create temporary compression test directory");
        let source_path = directory.join("source.jpg");
        let compressed_path = directory.join("compressed.jpg");

        let mut source = image::DynamicImage::new_rgba8(256, 256);
        for y in 0..256 {
            for x in 0..256 {
                let value = ((x * 31 + y * 17) % 256) as u8;
                source.put_pixel(
                    x,
                    y,
                    image::Rgba([value, value.wrapping_mul(3), value.wrapping_mul(7), 255]),
                );
            }
        }
        write_converted_image(&source, &source_path, image::ImageFormat::Jpeg)
            .expect("write high-quality source JPEG");
        write_compressed_image(
            &source,
            &compressed_path,
            image::ImageFormat::Jpeg,
            35,
            image::codecs::png::CompressionType::Best,
        )
        .expect("write compressed JPEG");

        let source_size = std::fs::metadata(&source_path)
            .expect("source metadata")
            .len();
        let compressed_size = std::fs::metadata(&compressed_path)
            .expect("compressed metadata")
            .len();
        assert!(compressed_size < source_size);
        assert!(image::open(&compressed_path).is_ok());
        std::fs::remove_dir_all(&directory).expect("remove temporary compression test directory");
    }

    #[test]
    fn webp_compression_is_lossless_and_quality_independent() {
        let unique = format!(
            "toolknit-webp-compression-test-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("system clock before Unix epoch")
                .as_nanos()
        );
        let directory = std::env::temp_dir().join(unique);
        std::fs::create_dir_all(&directory).expect("create temporary image test directory");
        let high_quality_output = directory.join("high.webp");
        let low_quality_output = directory.join("low.webp");
        let mut source = image::DynamicImage::new_rgba8(2, 2);
        source.put_pixel(0, 0, image::Rgba([10, 20, 30, 40]));
        source.put_pixel(1, 1, image::Rgba([200, 150, 100, 50]));

        write_compressed_image(
            &source,
            &high_quality_output,
            image::ImageFormat::WebP,
            90,
            image::codecs::png::CompressionType::Fast,
        )
        .expect("write high preset lossless WebP");
        write_compressed_image(
            &source,
            &low_quality_output,
            image::ImageFormat::WebP,
            35,
            image::codecs::png::CompressionType::Best,
        )
        .expect("write low preset lossless WebP");
        assert_eq!(
            std::fs::read(&high_quality_output).expect("read high preset WebP"),
            std::fs::read(&low_quality_output).expect("read low preset WebP")
        );
        for output in [&high_quality_output, &low_quality_output] {
            let decoded = image::open(output).expect("decode WebP").to_rgba8();
            assert_eq!(decoded, source.to_rgba8());
        }
        std::fs::remove_dir_all(&directory).expect("remove temporary image test directory");
    }
}

fn convert_image_batch_blocking(
    app_handle: tauri::AppHandle,
    input_paths: Vec<String>,
    output_dir: String,
    target_format: String,
) -> Result<BatchConvertResult, String> {
    use tauri::Emitter;

    convert_image_batch_blocking_with_progress(input_paths, output_dir, target_format, |progress| {
        let _ = app_handle.emit("convert-progress", progress);
    })
}

fn image_crop_format(value: &str) -> Result<(image::ImageFormat, &'static str, String), String> {
    match value.trim().to_ascii_lowercase().as_str() {
        "png" => Ok((image::ImageFormat::Png, ".png", "PNG".to_string())),
        "jpg" | "jpeg" => Ok((image::ImageFormat::Jpeg, ".jpg", "JPG".to_string())),
        "webp" => Ok((image::ImageFormat::WebP, ".webp", "WEBP".to_string())),
        "bmp" => Ok((image::ImageFormat::Bmp, ".bmp", "BMP".to_string())),
        _ => Err("image-crop:unsupported-format".to_string()),
    }
}

fn transformed_crop_dimensions(
    width: u32,
    height: u32,
    rotation: u16,
) -> Result<(u32, u32), String> {
    match rotation {
        0 | 180 => Ok((width, height)),
        90 | 270 => Ok((height, width)),
        _ => Err("image-crop:invalid-rotation".to_string()),
    }
}

fn validate_image_crop_bounds(
    options: &ImageCropOptions,
    width: u32,
    height: u32,
) -> Result<(), String> {
    if options.crop_width == 0 || options.crop_height == 0 {
        return Err("image-crop:invalid-crop".to_string());
    }
    let right = options
        .crop_x
        .checked_add(options.crop_width)
        .ok_or_else(|| "image-crop:invalid-crop".to_string())?;
    let bottom = options
        .crop_y
        .checked_add(options.crop_height)
        .ok_or_else(|| "image-crop:invalid-crop".to_string())?;
    if right > width || bottom > height {
        return Err("image-crop:crop-out-of-bounds".to_string());
    }
    Ok(())
}

fn transform_image_for_crop(
    mut image: image::DynamicImage,
    rotation: u16,
    flip_horizontal: bool,
    flip_vertical: bool,
) -> Result<image::DynamicImage, String> {
    image = match rotation {
        0 => image,
        90 => image.rotate90(),
        180 => image.rotate180(),
        270 => image.rotate270(),
        _ => return Err("image-crop:invalid-rotation".to_string()),
    };
    if flip_horizontal {
        image = image.fliph();
    }
    if flip_vertical {
        image = image.flipv();
    }
    Ok(image)
}

fn write_image_crop(
    image: &image::DynamicImage,
    output_path: &std::path::Path,
    format: image::ImageFormat,
    jpeg_quality: u8,
    background: image::Rgba<u8>,
) -> Result<(), String> {
    use image::ImageEncoder;
    use std::io::BufWriter;

    let file =
        std::fs::File::create(output_path).map_err(|_| "image-crop:write-failed".to_string())?;
    let writer = BufWriter::new(file);
    match format {
        image::ImageFormat::Jpeg => {
            let rgb = flatten_image_to_rgb(
                image,
                image::Rgb([background[0], background[1], background[2]]),
            );
            image::codecs::jpeg::JpegEncoder::new_with_quality(writer, jpeg_quality).write_image(
                &rgb,
                rgb.width(),
                rgb.height(),
                image::ExtendedColorType::Rgb8,
            )
        }
        image::ImageFormat::Png => image::codecs::png::PngEncoder::new(writer).write_image(
            image.as_bytes(),
            image.width(),
            image.height(),
            image.color().into(),
        ),
        image::ImageFormat::WebP => {
            let rgba = image.to_rgba8();
            image::codecs::webp::WebPEncoder::new_lossless(writer).write_image(
                &rgba,
                rgba.width(),
                rgba.height(),
                image::ExtendedColorType::Rgba8,
            )
        }
        image::ImageFormat::Bmp => {
            drop(writer);
            image.save_with_format(output_path, image::ImageFormat::Bmp)
        }
        _ => unreachable!("validated crop output format"),
    }
    .map_err(|_| "image-crop:encode-failed".to_string())
}

fn crop_image_blocking(options: ImageCropOptions) -> Result<ImageCropResult, String> {
    let (input, _) = validate_image_batch_input(&options.input_path)
        .map_err(|_| "image-crop:invalid-input".to_string())?;
    let output_dir = validate_image_output_dir(&options.output_dir)
        .map_err(|_| "image-crop:invalid-output-dir".to_string())?;
    let (format, extension, format_label) = image_crop_format(&options.format)?;
    if !(1..=100).contains(&options.jpeg_quality) {
        return Err("image-crop:invalid-quality".to_string());
    }
    let background = stitch_background(&options.background_rgba)
        .map_err(|_| "image-crop:invalid-background".to_string())?;
    let decoded =
        decode_oriented_image(&input).map_err(|_| "image-crop:decode-failed".to_string())?;
    let (transformed_width, transformed_height) =
        transformed_crop_dimensions(decoded.width(), decoded.height(), options.rotation)?;
    validate_image_crop_bounds(&options, transformed_width, transformed_height)?;
    let transformed = transform_image_for_crop(
        decoded,
        options.rotation,
        options.flip_horizontal,
        options.flip_vertical,
    )?;
    let cropped = transformed.crop_imm(
        options.crop_x,
        options.crop_y,
        options.crop_width,
        options.crop_height,
    );

    let source_stem = input
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("image");
    let default_name = format!("{}_crop", source_stem);
    let output_name = options
        .output_name
        .as_deref()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or(&default_name);
    normalize_image_stitch_output_name(Some(output_name))
        .map_err(|_| "image-crop:invalid-output-name".to_string())?;

    let mut temporary = ImageStitchTemporaryFile::new(&output_dir);
    write_image_crop(
        &cropped,
        &temporary.path,
        format,
        options.jpeg_quality,
        background,
    )?;
    let output_path =
        publish_image_stitch_output(&mut temporary, &output_dir, Some(output_name), extension)
            .map_err(|_| "image-crop:publish-failed".to_string())?;
    let bytes = std::fs::metadata(&output_path)
        .map(|metadata| metadata.len())
        .unwrap_or(0);
    Ok(ImageCropResult {
        output_path,
        width: cropped.width(),
        height: cropped.height(),
        bytes,
        format: format_label,
    })
}

#[tauri::command]
async fn crop_image(
    input_path: String,
    output_dir: String,
    output_name: Option<String>,
    crop_x: u32,
    crop_y: u32,
    crop_width: u32,
    crop_height: u32,
    rotation: u16,
    flip_horizontal: bool,
    flip_vertical: bool,
    format: String,
    jpeg_quality: u8,
    background_rgba: String,
) -> Result<ImageCropResult, String> {
    tokio::task::spawn_blocking(move || {
        crop_image_blocking(ImageCropOptions {
            input_path,
            output_dir,
            output_name,
            crop_x,
            crop_y,
            crop_width,
            crop_height,
            rotation,
            flip_horizontal,
            flip_vertical,
            format,
            jpeg_quality,
            background_rgba,
        })
    })
    .await
    .map_err(|_| "image-crop:worker-failed".to_string())?
}

#[derive(Clone, Debug, serde::Serialize)]
struct ColorReplaceResult {
    output_path: String,
    width: u32,
    height: u32,
    bytes: u64,
    format: String,
    changed_pixels: u64,
}

#[derive(Clone)]
struct ColorReplaceOptions {
    app: Option<tauri::AppHandle>,
    operation_id: Option<String>,
    input_path: String,
    output_dir: String,
    output_name: String,
    source_rgb: Vec<u8>,
    target_rgb: Vec<u8>,
    threshold: f32,
    seed_x: u32,
    seed_y: u32,
    smart: bool,
    softness: f32,
    preserve_luminance: bool,
    format: String,
    jpeg_quality: u8,
    cancel_token: Option<std::sync::Arc<std::sync::atomic::AtomicBool>>,
}

fn color_linear_rgb_table() -> [f32; 256] {
    std::array::from_fn(|index| {
        let value = index as f32 / 255.0;
        if value <= 0.04045 { value / 12.92 } else { ((value + 0.055) / 1.055).powf(2.4) }
    })
}

fn color_rgb_to_lab_with_table(rgb: [u8; 3], table: &[f32; 256]) -> [f32; 3] {
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
fn color_rgb_to_lab(rgb: [u8; 3]) -> [f32; 3] {
    color_rgb_to_lab_with_table(rgb, &color_linear_rgb_table())
}

fn color_delta_e(first: [f32; 3], second: [f32; 3]) -> f32 {
    ((first[0] - second[0]).powi(2) + (first[1] - second[1]).powi(2) + (first[2] - second[2]).powi(2)).sqrt()
}

fn color_replace_weight(distance: f32, threshold: f32, softness: f32) -> f32 {
    if distance > threshold { return 0.0; }
    if softness <= 0.0 { return 1.0; }
    let feather = (threshold * softness / 100.0).max(0.25);
    let edge = (threshold - feather).max(0.0);
    if distance <= edge { return 1.0; }
    let t = ((threshold - distance) / feather).clamp(0.0, 1.0);
    t * t * (3.0 - 2.0 * t)
}

fn color_replace_format(value: &str) -> Result<(image::ImageFormat, &'static str, String), String> {
    match value.trim().to_ascii_lowercase().as_str() {
        "png" => Ok((image::ImageFormat::Png, ".png", "PNG".to_string())),
        "jpg" | "jpeg" => Ok((image::ImageFormat::Jpeg, ".jpg", "JPG".to_string())),
        "webp" => Ok((image::ImageFormat::WebP, ".webp", "WEBP".to_string())),
        "bmp" => Ok((image::ImageFormat::Bmp, ".bmp", "BMP".to_string())),
        _ => Err("color-replace:unsupported-format".to_string()),
    }
}

fn color_replace_cancelled(options: &ColorReplaceOptions) -> bool {
    options.cancel_token.as_ref().is_some_and(|token| token.load(std::sync::atomic::Ordering::Relaxed))
}

fn emit_color_replace_progress(options: &ColorReplaceOptions, phase: &str, percent: f64, processed: usize, total: usize) {
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

fn color_replace_blocking(options: ColorReplaceOptions) -> Result<ColorReplaceResult, String> {
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
async fn export_replaced_image(
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
struct ToolOperationProgress { operation_id: String, phase: String, percent: f64, processed_bytes: u64, total_bytes: u64 }

static TOOL_OPERATION_CANCELS: OnceLock<std::sync::Mutex<std::collections::HashMap<String, std::sync::Arc<std::sync::atomic::AtomicBool>>>> = OnceLock::new();

fn tool_operation_cancels() -> &'static std::sync::Mutex<std::collections::HashMap<String, std::sync::Arc<std::sync::atomic::AtomicBool>>> {
    TOOL_OPERATION_CANCELS.get_or_init(|| std::sync::Mutex::new(std::collections::HashMap::new()))
}

fn validate_tool_operation_id(operation_id: &str) -> Result<(), String> {
    if operation_id.is_empty() || operation_id.len() > 128 || !operation_id.bytes().all(|value| value.is_ascii_alphanumeric() || matches!(value, b'-' | b'_')) {
        return Err("tool-operation:invalid-id".to_string());
    }
    Ok(())
}

fn register_tool_operation(operation_id: &str) -> Result<std::sync::Arc<std::sync::atomic::AtomicBool>, String> {
    validate_tool_operation_id(operation_id)?;
    let token = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    let mut jobs = tool_operation_cancels().lock().map_err(|_| "tool-operation:lock".to_string())?;
    if jobs.insert(operation_id.to_string(), token.clone()).is_some() { return Err("tool-operation:duplicate-id".to_string()); }
    Ok(token)
}

fn finish_tool_operation(operation_id: &str) {
    if let Ok(mut jobs) = tool_operation_cancels().lock() { jobs.remove(operation_id); }
}

#[tauri::command]
fn cancel_tool_operation(operation_id: String) -> Result<(), String> {
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
struct FileHashResult { digests: std::collections::BTreeMap<String, String>, processed_bytes: u64, total_bytes: u64 }

#[tauri::command]
async fn hash_file(app: tauri::AppHandle, input_path: String, algorithms: Vec<String>, hmac_key: Option<String>, operation_id: String) -> Result<FileHashResult, String> {
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
struct TkaesResult { output_path: String, bytes: u64 }

const TKAE_MAGIC: &[u8; 4] = b"TKAE";
const TKAE_VERSION: u8 = 2;
const TKAE_CHUNK_SIZE: usize = 1024 * 1024;
const TKAE_ARGON_MEMORY_KIB: u32 = 19 * 1024;
const TKAE_ARGON_ITERATIONS: u32 = 2;
const TKAE_ARGON_LANES: u32 = 1;

fn tkaes_key(password: &str, salt: &[u8], memory_kib: u32, iterations: u32, lanes: u32) -> Result<aes_gcm::Aes256Gcm, String> {
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

fn tkaes_nonce(base: &[u8; 12], index: u64) -> [u8; 12] { let mut nonce = *base; let bytes = index.to_le_bytes(); for i in 0..8 { nonce[4 + i] ^= bytes[i]; } nonce }
fn tkaes_aad(index: u64, length: u32) -> Vec<u8> { let mut aad = Vec::with_capacity(16); aad.extend_from_slice(TKAE_MAGIC); aad.extend_from_slice(&index.to_le_bytes()); aad.extend_from_slice(&length.to_le_bytes()); aad }
fn publish_tkaes_temp(temp: &std::path::Path, dir: &std::path::Path, stem: &str, extension: &str) -> Result<String, String> { for index in 0..10000_u32 { let suffix = if index == 0 { String::new() } else { format!("_{}", index) }; let path = dir.join(format!("{}{}{}", stem, suffix, extension)); if path.exists() { continue; } match std::fs::rename(temp, &path) { Ok(()) => return Ok(path.to_string_lossy().into_owned()), Err(_) => continue } } Err("tkaes:publish-failed".to_string()) }

fn tkaes_temp_path(dir: &std::path::Path, kind: &str) -> Result<std::path::PathBuf, String> {
    let mut random = [0_u8; 8];
    getrandom::getrandom(&mut random).map_err(|_| "tkaes:random-failed".to_string())?;
    Ok(dir.join(format!(".toolknit-{}-{}-{}.part", kind, std::process::id(), hex::encode(random))))
}

fn tkaes_encrypted_stem(input: &std::path::Path) -> &str { input.file_name().and_then(|value| value.to_str()).unwrap_or("encrypted") }
fn tkaes_decrypted_stem(input: &std::path::Path) -> String { let name = input.file_name().and_then(|value| value.to_str()).unwrap_or("decrypted"); if name.to_ascii_lowercase().ends_with(".tkaes") { name[..name.len() - 6].to_string() } else { format!("{}.bin", name) } }

struct TkaesTempGuard { path: std::path::PathBuf, published: bool }
impl TkaesTempGuard { fn new(path: std::path::PathBuf) -> Self { Self { path, published: false } } fn path(&self) -> &std::path::Path { &self.path } fn mark_published(&mut self) { self.published = true; } }
impl Drop for TkaesTempGuard { fn drop(&mut self) { if !self.published { let _ = std::fs::remove_file(&self.path); } } }

fn tkaes_encrypt_blocking(app: Option<tauri::AppHandle>, input_path: String, output_dir: String, password: String, operation_id: String, token: std::sync::Arc<std::sync::atomic::AtomicBool>) -> Result<TkaesResult, String> {
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

fn read_tkaes_u32(file: &mut std::fs::File) -> Result<u32, String> { use std::io::Read; let mut bytes = [0_u8; 4]; file.read_exact(&mut bytes).map_err(|_| "tkaes:invalid-container".to_string())?; Ok(u32::from_le_bytes(bytes)) }

fn tkaes_decrypt_blocking(app: Option<tauri::AppHandle>, input_path: String, output_dir: String, password: String, operation_id: String, token: std::sync::Arc<std::sync::atomic::AtomicBool>) -> Result<TkaesResult, String> {
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
async fn encrypt_tkaes_file(app: tauri::AppHandle, input_path: String, output_dir: String, password: String, operation_id: String) -> Result<TkaesResult, String> {
    if password.is_empty() { return Err("tkaes:password-required".to_string()); }
    let token = register_tool_operation(&operation_id)?; let cleanup_id = operation_id.clone();
    let joined = tokio::task::spawn_blocking(move || tkaes_encrypt_blocking(Some(app), input_path, output_dir, password, operation_id, token)).await;
    finish_tool_operation(&cleanup_id);
    joined.map_err(|_| "tkaes:worker-failed".to_string())?
}

#[tauri::command]
async fn decrypt_tkaes_file(app: tauri::AppHandle, input_path: String, output_dir: String, password: String, operation_id: String) -> Result<TkaesResult, String> {
    if password.is_empty() { return Err("tkaes:password-required".to_string()); }
    let token = register_tool_operation(&operation_id)?; let cleanup_id = operation_id.clone();
    let joined = tokio::task::spawn_blocking(move || tkaes_decrypt_blocking(Some(app), input_path, output_dir, password, operation_id, token)).await;
    finish_tool_operation(&cleanup_id);
    joined.map_err(|_| "tkaes:worker-failed".to_string())?
}

fn convert_image_batch_blocking_with_progress<F>(
    input_paths: Vec<String>,
    output_dir: String,
    target_format: String,
    mut emit_progress: F,
) -> Result<BatchConvertResult, String>
where
    F: FnMut(ConvertProgress),
{
    use image::ImageFormat;

    let target_fmt = match target_format.trim().to_uppercase().as_str() {
        "JPG" | "JPEG" => Some(ImageFormat::Jpeg),
        "PNG" => Some(ImageFormat::Png),
        "WEBP" => Some(ImageFormat::WebP),
        "BMP" => Some(ImageFormat::Bmp),
        "GIF" => Some(ImageFormat::Gif),
        "SVG" => None,
        _ => return Err(format!("Unsupported target format: {}", target_format)),
    };
    let ext = match target_fmt {
        Some(ImageFormat::Jpeg) => ".jpg",
        Some(ImageFormat::Png) => ".png",
        Some(ImageFormat::WebP) => ".webp",
        Some(ImageFormat::Bmp) => ".bmp",
        Some(ImageFormat::Gif) => ".gif",
        None => ".svg",
        _ => ".png",
    };
    validate_image_batch_request(&input_paths)?;
    let output_dir_path = validate_image_output_dir(&output_dir)?;

    let total = input_paths.len();
    let mut success_count = 0usize;
    let mut fail_count = 0usize;
    let mut errors = Vec::new();
    let mut seen = std::collections::BTreeSet::new();

    for (i, input_path) in input_paths.iter().enumerate() {
        if CANCEL_FLAG.load(Ordering::SeqCst) {
            break;
        }

        let input_hint = std::path::Path::new(input_path);
        let file_name = input_hint
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_else(|| "unknown".to_string());
        let stem = input_hint
            .file_stem()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_else(|| "output".to_string());

        emit_progress(ConvertProgress {
            file_name: file_name.clone(),
            current: i + 1,
            total,
            progress: 0.0,
            status: "converting".to_string(),
        });

        let (input, _) = match validate_image_batch_input(input_path) {
            Ok(validated) => validated,
            Err(error) => {
                fail_count += 1;
                errors.push(error);
                emit_progress(ConvertProgress {
                    file_name,
                    current: i + 1,
                    total,
                    progress: 1.0,
                    status: "error".to_string(),
                });
                continue;
            }
        };
        if !seen.insert(input.clone()) {
            fail_count += 1;
            errors.push(format!("Duplicate image file: {}", file_name));
            emit_progress(ConvertProgress {
                file_name,
                current: i + 1,
                total,
                progress: 1.0,
                status: "error".to_string(),
            });
            continue;
        }

        let output_path = get_unique_output_path(&output_dir_path, &stem, ext);
        let temporary_output_path = output_dir_path.join(format!(
            ".{}-toolknit-{}-{}.tmp",
            stem,
            std::process::id(),
            i
        ));

        let result = decode_oriented_image(&input);
        match result {
            Ok(img) => {
                if CANCEL_FLAG.load(Ordering::SeqCst) {
                    break;
                }
                let save_result = match target_fmt {
                    Some(format) => write_converted_image(&img, &temporary_output_path, format)
                        .map_err(|error| error.to_string()),
                    None => write_raster_svg(&img, &temporary_output_path),
                };
                if save_result.is_ok() && !CANCEL_FLAG.load(Ordering::SeqCst) {
                    if let Err(error) = publish_image_output(&temporary_output_path, &output_path) {
                        fail_count += 1;
                        errors.push(format!("{}: {}", file_name, error));
                        let _ = std::fs::remove_file(&temporary_output_path);
                        emit_progress(ConvertProgress {
                            file_name,
                            current: i + 1,
                            total,
                            progress: 1.0,
                            status: "error".to_string(),
                        });
                        continue;
                    }
                    success_count += 1;
                    emit_progress(ConvertProgress {
                        file_name,
                        current: i + 1,
                        total,
                        progress: 1.0,
                        status: "done".to_string(),
                    });
                } else {
                    let cancelled = CANCEL_FLAG.load(Ordering::SeqCst);
                    fail_count += 1;
                    let e = save_result.err().map(|e| e.to_string()).unwrap_or_default();
                    if !cancelled {
                        errors.push(format!("{}: {}", file_name, e));
                    }
                    let _ = std::fs::remove_file(&temporary_output_path);
                    emit_progress(ConvertProgress {
                        file_name,
                        current: i + 1,
                        total,
                        progress: 1.0,
                        status: "error".to_string(),
                    });
                    if cancelled {
                        break;
                    }
                }
            }
            Err(e) => {
                fail_count += 1;
                errors.push(format!("{}: {}", file_name, e));
                emit_progress(ConvertProgress {
                    file_name,
                    current: i + 1,
                    total,
                    progress: 1.0,
                    status: "error".to_string(),
                });
            }
        }
    }

    Ok(BatchConvertResult {
        success_count,
        fail_count,
        output_dir: output_dir_path.to_string_lossy().to_string(),
        errors,
        original_size: None,
        compressed_size: None,
    })
}

#[tauri::command]
async fn compress_image_batch(
    app_handle: tauri::AppHandle,
    input_paths: Vec<String>,
    output_dir: String,
    quality: String,
) -> Result<BatchConvertResult, String> {
    let _conversion_guard = begin_conversion()?;
    tokio::task::spawn_blocking(move || {
        compress_image_batch_blocking(app_handle, input_paths, output_dir, quality)
    })
    .await
    .map_err(|error| format!("Image compression worker failed: {}", error))?
}

fn validate_image_compression_request(input_paths: &[String], quality: &str) -> Result<(), String> {
    validate_image_batch_request(input_paths)?;
    if !matches!(quality, "high" | "medium" | "low") {
        return Err("Unsupported image compression quality".to_string());
    }
    Ok(())
}

fn validate_image_compression_input(
    input_path: &str,
) -> Result<(std::path::PathBuf, image::ImageFormat, &'static str), String> {
    let input = std::path::Path::new(input_path);
    let file_name = input
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("input image");
    let (canonical, extension) = validate_image_batch_input(input_path)?;
    let (format, output_extension) = match extension.as_str() {
        "jpg" | "jpeg" => (image::ImageFormat::Jpeg, ".jpg"),
        "png" => (image::ImageFormat::Png, ".png"),
        "webp" => (image::ImageFormat::WebP, ".webp"),
        _ => {
            return Err(format!(
                "{} cannot be compressed safely while preserving its format",
                file_name
            ))
        }
    };
    Ok((canonical, format, output_extension))
}

#[cfg(test)]
fn validate_image_compression_inputs(input_paths: &[String], quality: &str) -> Result<(), String> {
    validate_image_compression_request(input_paths, quality)?;
    let mut seen = std::collections::BTreeSet::new();
    for input_path in input_paths {
        let file_name = std::path::Path::new(input_path)
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("input image");
        let (canonical, _, _) = validate_image_compression_input(input_path)?;
        if !seen.insert(canonical) {
            return Err(format!("Duplicate image file: {}", file_name));
        }
    }
    Ok(())
}

fn write_compressed_image(
    image: &image::DynamicImage,
    output_path: &std::path::Path,
    format: image::ImageFormat,
    jpeg_quality: u8,
    png_compression: image::codecs::png::CompressionType,
) -> image::ImageResult<()> {
    use image::codecs::jpeg::JpegEncoder;
    use image::codecs::png::{FilterType, PngEncoder};
    use image::codecs::webp::WebPEncoder;
    use std::io::BufWriter;

    let file = std::fs::File::create(output_path)?;
    let writer = BufWriter::new(file);
    match format {
        image::ImageFormat::Jpeg => {
            let mut encoder = JpegEncoder::new_with_quality(writer, jpeg_quality);
            let rgb = flatten_image_to_rgb(image, image::Rgb([255, 255, 255]));
            encoder.encode(
                &rgb,
                rgb.width(),
                rgb.height(),
                image::ExtendedColorType::Rgb8,
            )
        }
        image::ImageFormat::Png => {
            let encoder = PngEncoder::new_with_quality(writer, png_compression, FilterType::Sub);
            image.write_with_encoder(encoder)
        }
        image::ImageFormat::WebP => {
            let encoder = WebPEncoder::new_lossless(writer);
            let rgba = image.to_rgba8();
            encoder.encode(
                &rgba,
                image.width(),
                image.height(),
                image::ExtendedColorType::Rgba8,
            )
        }
        _ => unreachable!("validated image compression format"),
    }
}

fn compress_image_batch_blocking(
    app_handle: tauri::AppHandle,
    input_paths: Vec<String>,
    output_dir: String,
    quality: String,
) -> Result<BatchConvertResult, String> {
    use tauri::Emitter;

    compress_image_batch_blocking_with_progress(input_paths, output_dir, quality, |progress| {
        let _ = app_handle.emit("convert-progress", progress);
    })
}

fn compress_image_batch_blocking_with_progress<F>(
    input_paths: Vec<String>,
    output_dir: String,
    quality: String,
    mut emit_progress: F,
) -> Result<BatchConvertResult, String>
where
    F: FnMut(ConvertProgress),
{
    use image::codecs::png::CompressionType;

    validate_image_compression_request(&input_paths, &quality)?;

    let output_dir_path = validate_image_output_dir(&output_dir)?;

    // Quality presets: (jpeg_quality, png_compression)
    let (jpeg_quality, png_compression) = match quality.as_str() {
        "high" => (90u8, CompressionType::Fast),
        "medium" => (65u8, CompressionType::Default),
        "low" => (35u8, CompressionType::Best),
        _ => unreachable!("validated image compression quality"),
    };

    let total = input_paths.len();
    let mut success_count = 0usize;
    let mut fail_count = 0usize;
    let mut errors = Vec::new();
    let mut original_size: u64 = 0;
    let mut compressed_size: u64 = 0;
    let mut seen = std::collections::BTreeSet::new();

    for (i, input_path) in input_paths.iter().enumerate() {
        if CANCEL_FLAG.load(Ordering::SeqCst) {
            break;
        }

        let input_hint = std::path::Path::new(input_path);
        let file_name = input_hint
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_else(|| "unknown".to_string());
        let stem = input_hint
            .file_stem()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_else(|| "output".to_string());

        emit_progress(ConvertProgress {
            file_name: file_name.clone(),
            current: i + 1,
            total,
            progress: 0.0,
            status: "converting".to_string(),
        });

        let (input, format, out_ext) = match validate_image_compression_input(input_path) {
            Ok(validated) => validated,
            Err(error) => {
                fail_count += 1;
                errors.push(error);
                emit_progress(ConvertProgress {
                    file_name,
                    current: i + 1,
                    total,
                    progress: 1.0,
                    status: "error".to_string(),
                });
                continue;
            }
        };
        if !seen.insert(input.clone()) {
            fail_count += 1;
            errors.push(format!("Duplicate image file: {}", file_name));
            emit_progress(ConvertProgress {
                file_name,
                current: i + 1,
                total,
                progress: 1.0,
                status: "error".to_string(),
            });
            continue;
        }

        let output_path = get_unique_output_path(&output_dir_path, &stem, out_ext);
        let temporary_output_path = output_dir_path.join(format!(
            ".{}-toolknit-compress-{}-{}.tmp",
            stem,
            std::process::id(),
            i
        ));

        let result = decode_oriented_image(&input);
        match result {
            Ok(img) => {
                if CANCEL_FLAG.load(Ordering::SeqCst) {
                    break;
                }
                let save_result = write_compressed_image(
                    &img,
                    &temporary_output_path,
                    format,
                    jpeg_quality,
                    png_compression,
                );
                let input_size = std::fs::metadata(&input)
                    .map(|metadata| metadata.len())
                    .unwrap_or(0);
                let output_size = std::fs::metadata(&temporary_output_path)
                    .map(|metadata| metadata.len())
                    .unwrap_or(0);
                if save_result.is_ok()
                    && !CANCEL_FLAG.load(Ordering::SeqCst)
                    && output_size < input_size
                {
                    if let Err(error) = publish_image_output(&temporary_output_path, &output_path) {
                        fail_count += 1;
                        errors.push(format!("{}: {}", file_name, error));
                        let _ = std::fs::remove_file(&temporary_output_path);
                        emit_progress(ConvertProgress {
                            file_name,
                            current: i + 1,
                            total,
                            progress: 1.0,
                            status: "error".to_string(),
                        });
                        continue;
                    }
                    success_count += 1;
                    compressed_size += output_size;
                    original_size += input_size;
                    emit_progress(ConvertProgress {
                        file_name,
                        current: i + 1,
                        total,
                        progress: 1.0,
                        status: "done".to_string(),
                    });
                } else {
                    let cancelled = CANCEL_FLAG.load(Ordering::SeqCst);
                    fail_count += 1;
                    let e = save_result.err().map(|e| e.to_string()).unwrap_or_default();
                    if !cancelled {
                        let reason = if e.is_empty() {
                            "no smaller output was produced"
                        } else {
                            &e
                        };
                        errors.push(format!("{}: {}", file_name, reason));
                    }
                    let _ = std::fs::remove_file(&temporary_output_path);
                    emit_progress(ConvertProgress {
                        file_name,
                        current: i + 1,
                        total,
                        progress: 1.0,
                        status: "error".to_string(),
                    });
                    if cancelled {
                        break;
                    }
                }
            }
            Err(e) => {
                fail_count += 1;
                errors.push(format!("{}: {}", file_name, e));
                emit_progress(ConvertProgress {
                    file_name,
                    current: i + 1,
                    total,
                    progress: 1.0,
                    status: "error".to_string(),
                });
            }
        }
    }

    Ok(BatchConvertResult {
        success_count,
        fail_count,
        output_dir: output_dir_path.to_string_lossy().to_string(),
        errors,
        original_size: Some(original_size),
        compressed_size: Some(compressed_size),
    })
}

