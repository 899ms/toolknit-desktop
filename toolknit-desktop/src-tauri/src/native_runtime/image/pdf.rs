
pub(crate) fn pdf_to_image_session_root() -> std::path::PathBuf {
    std::env::temp_dir().join(PDF_TO_IMAGE_SESSION_ROOT)
}

pub(crate) fn valid_pdf_to_image_session_id(session_id: &str) -> bool {
    !session_id.is_empty()
        && session_id.len() <= 96
        && session_id
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || character == '-')
}

pub(crate) fn pdf_to_image_session_directory(session_id: &str) -> Result<std::path::PathBuf, String> {
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

pub(crate) fn remove_pdf_to_image_session(session_id: &str) -> Result<(), String> {
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

pub(crate) fn cleanup_pdf_to_image_sessions() {
    let root = pdf_to_image_session_root();
    if root.is_dir() {
        let _ = std::fs::remove_dir_all(root);
    }
}

#[tauri::command]
pub(crate) fn create_pdf_to_image_session() -> Result<PdfToImageSession, String> {
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

pub(crate) fn pdf_to_image_session_usage(directory: &std::path::Path) -> Result<(usize, u64), String> {
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

pub(crate) fn pdf_to_image_page_number_from_file_name(file_name: &str) -> Option<u32> {
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

pub(crate) fn write_pdf_to_image_page_bytes(
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
pub(crate) fn write_pdf_to_image_page(
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
pub(crate) fn write_pdf_to_image_page_json(
    session_id: String,
    file_name: String,
    bytes: Vec<u8>,
) -> Result<PdfToImagePageWriteResult, String> {
    write_pdf_to_image_page_bytes(&session_id, &file_name, &bytes)
}

#[tauri::command]
pub(crate) fn read_pdf_to_image_source(path: String) -> Result<tauri::ipc::Response, String> {
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
pub(crate) fn discard_pdf_to_image_session(session_id: String) -> Result<(), String> {
    remove_pdf_to_image_session(&session_id)
}

pub(crate) fn normalize_pdf_to_image_format(value: &str) -> Result<(String, String), String> {
    match value.trim().to_ascii_lowercase().as_str() {
        "png" => Ok(("png".to_string(), ".png".to_string())),
        "jpg" | "jpeg" => Ok(("jpg".to_string(), ".jpg".to_string())),
        "webp" => Ok(("webp".to_string(), ".webp".to_string())),
        _ => Err("pdf-to-image:invalid-format".to_string()),
    }
}

pub(crate) fn normalize_pdf_to_image_mode(value: &str) -> Result<PdfToImageExportMode, String> {
    match value.trim().to_ascii_lowercase().as_str() {
        "images" | "pages" => Ok(PdfToImageExportMode::Pages),
        "long" => Ok(PdfToImageExportMode::Long),
        "long-horizontal" | "horizontal" => Ok(PdfToImageExportMode::Horizontal),
        "grid" => Ok(PdfToImageExportMode::Grid),
        _ => Err("pdf-to-image:invalid-mode".to_string()),
    }
}

pub(crate) fn load_pdf_to_image_source_pages(
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

pub(crate) fn pdf_to_image_group_layout(
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

pub(crate) fn pdf_to_image_horizontal_layout(
    pages: &[PdfToImageSourcePage],
    max_pixels: u64,
) -> Result<ImageStitchLayout, String> {
    if pages.is_empty() { return Err("pdf-to-image:invalid-selection".to_string()); }
    let width = pages.iter().try_fold(0u64, |sum, page| sum.checked_add(u64::from(page.width)))
        .ok_or_else(|| "pdf-to-image:output-too-large".to_string())?;
    let height = pages.iter().map(|page| page.height).max().unwrap_or(0);
    if width > u64::from(PDF_TO_IMAGE_MAX_LONG_SIDE) || height > PDF_TO_IMAGE_MAX_LONG_SIDE { return Err("pdf-to-image:output-too-large".to_string()); }
    let pixels = width.checked_mul(u64::from(height)).ok_or_else(|| "pdf-to-image:output-too-large".to_string())?;
    if pixels > max_pixels || pixels.saturating_mul(6) > PDF_TO_IMAGE_MAX_ESTIMATED_WORKING_BYTES { return Err("pdf-to-image:output-too-large-for-memory".to_string()); }
    Ok(ImageStitchLayout { sizes: pages.iter().map(|page| (page.width, page.height)).collect(), width: width as u32, height })
}

pub(crate) fn pdf_to_image_grid_layout(
    pages: &[PdfToImageSourcePage],
    max_pixels: u64,
) -> Result<ImageStitchLayout, String> {
    if pages.len() != 4 && pages.len() != 9 { return Err("pdf-to-image:invalid-grid-count".to_string()); }
    let columns = if pages.len() == 4 { 2 } else { 3 };
    let rows = (pages.len() + columns - 1) / columns;
    let gap = 24u64;
    let mut column_widths = vec![0u32; columns];
    let mut row_heights = vec![0u32; rows];
    for (index, page) in pages.iter().enumerate() {
        column_widths[index % columns] = column_widths[index % columns].max(page.width);
        row_heights[index / columns] = row_heights[index / columns].max(page.height);
    }
    let width = column_widths.iter().map(|value| u64::from(*value)).sum::<u64>() + gap * (columns as u64 - 1);
    let height = row_heights.iter().map(|value| u64::from(*value)).sum::<u64>() + gap * (rows as u64 - 1);
    let pixels = width.checked_mul(height).ok_or_else(|| "pdf-to-image:output-too-large".to_string())?;
    if width > u64::from(PDF_TO_IMAGE_MAX_LONG_SIDE) || height > u64::from(PDF_TO_IMAGE_MAX_LONG_SIDE) || pixels > max_pixels { return Err("pdf-to-image:output-too-large-for-memory".to_string()); }
    Ok(ImageStitchLayout { sizes: pages.iter().map(|page| (page.width, page.height)).collect(), width: width as u32, height: height as u32 })
}

pub(crate) fn build_pdf_to_image_groups(
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

    if mode == PdfToImageExportMode::Grid {
        if pages.len() != 4 && pages.len() != 9 { return Err("pdf-to-image:invalid-grid-count".to_string()); }
        pdf_to_image_grid_layout(pages, max_pixels)?;
        return Ok(vec![pages.to_vec()]);
    }
    let mut groups = Vec::new();
    let mut current = Vec::new();
    for page in pages.iter().cloned() {
        if current.len() >= pages_per_long_image {
            groups.push(std::mem::take(&mut current));
        }
        let mut candidate = current.clone();
        candidate.push(page.clone());
        let layout_ok = if mode == PdfToImageExportMode::Horizontal {
            pdf_to_image_horizontal_layout(&candidate, max_pixels).is_ok()
        } else {
            pdf_to_image_group_layout(&candidate, max_pixels).is_ok()
        };
        if layout_ok {
            current = candidate;
            continue;
        }
        if !current.is_empty() {
            groups.push(std::mem::take(&mut current));
        }
        if mode == PdfToImageExportMode::Horizontal { pdf_to_image_horizontal_layout(std::slice::from_ref(&page), max_pixels)?; }
        else { pdf_to_image_group_layout(std::slice::from_ref(&page), max_pixels)?; }
        current.push(page);
    }
    if !current.is_empty() {
        groups.push(current);
    }
    Ok(groups)
}

pub(crate) fn compose_pdf_to_image_group_with_mode(
    pages: &[PdfToImageSourcePage],
    layout: &ImageStitchLayout,
    background: image::Rgba<u8>,
    format: &str,
    cancelled: &AtomicBool,
    mode: PdfToImageExportMode,
) -> Result<image::RgbaImage, String> {
    let canvas_background = if format == "jpg" {
        image::Rgba([background.0[0], background.0[1], background.0[2], 255])
    } else {
        background
    };
    let mut canvas = image::RgbaImage::from_pixel(layout.width, layout.height, canvas_background);
    let mut cursor = 0u32;
    let columns = if pages.len() == 4 { 2 } else { 3 };
    let gap = 24u32;
    let column_widths = if mode == PdfToImageExportMode::Grid {
        (0..columns).map(|column| pages.iter().enumerate().filter(|(index, _)| index % columns == column).map(|(_, page)| page.width).max().unwrap_or(0)).collect::<Vec<_>>()
    } else { Vec::new() };
    let rows = if mode == PdfToImageExportMode::Grid { (pages.len() + columns - 1) / columns } else { 0 };
    let row_heights = if mode == PdfToImageExportMode::Grid {
        (0..rows).map(|row| pages.iter().skip(row * columns).take(columns).map(|page| page.height).max().unwrap_or(0)).collect::<Vec<_>>()
    } else { Vec::new() };
    let offset = |values: &[u32], index: usize| values.iter().take(index).copied().sum::<u32>() + gap * index as u32;
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
        let (x, y) = match mode {
            PdfToImageExportMode::Horizontal => (cursor, (layout.height.saturating_sub(*height)) / 2),
            PdfToImageExportMode::Grid => {
                let index = pages.iter().position(|candidate| candidate.page_number == page.page_number).unwrap_or(0);
                let column = index % columns;
                let row = index / columns;
                (offset(&column_widths, column) + (column_widths[column].saturating_sub(*width)) / 2,
                 offset(&row_heights, row) + (row_heights[row].saturating_sub(*height)) / 2)
            }
            PdfToImageExportMode::Pages | PdfToImageExportMode::Long => ((layout.width.saturating_sub(*width)) / 2, cursor)
        };
        image::imageops::overlay(&mut canvas, &rendered, i64::from(x), i64::from(y));
        cursor = cursor.saturating_add(if mode == PdfToImageExportMode::Horizontal { *width } else { *height });
    }
    Ok(canvas)
}

pub(crate) fn encode_pdf_to_image(
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

pub(crate) fn pdf_to_image_logical_stem(
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
    let prefix = match mode {
        PdfToImageExportMode::Horizontal => "horizontal",
        PdfToImageExportMode::Grid => "grid",
        PdfToImageExportMode::Long => "long",
        PdfToImageExportMode::Pages => unreachable!(),
    };
    if mode == PdfToImageExportMode::Grid {
        format!("{}_grid_pages_{}", base, page_label)
    } else {
        format!("{}_{}_{:02}_pages_{}", base, prefix, output_index + 1, page_label)
    }
}

pub(crate) fn pdf_to_image_candidate_path(
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

pub(crate) fn copy_pdf_to_image_output(
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

pub(crate) fn publish_pdf_to_image_output(
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

pub(crate) fn publish_pdf_to_image_batch(
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

pub(crate) fn export_pdf_to_images_blocking<F>(
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
    if matches!(mode, PdfToImageExportMode::Long | PdfToImageExportMode::Horizontal)
        && request.page_numbers.len() > PDF_TO_IMAGE_MAX_LONG_PAGES
    {
        return Err("pdf-to-image:too-many-long-pages".to_string());
    }
    if mode == PdfToImageExportMode::Grid && request.page_numbers.len() != 4 && request.page_numbers.len() != 9 {
        return Err("pdf-to-image:invalid-grid-count".to_string());
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
        let layout = match mode {
            PdfToImageExportMode::Horizontal => pdf_to_image_horizontal_layout(group, max_output_pixels)?,
            PdfToImageExportMode::Grid => pdf_to_image_grid_layout(group, max_output_pixels)?,
            PdfToImageExportMode::Pages | PdfToImageExportMode::Long => pdf_to_image_group_layout(group, max_output_pixels)?,
        };
        // Give each group one continuous progress slice because compose and
        // encode are performed back-to-back inside this loop.
        progress(
            "compose",
            index,
            groups.len(),
            12 + ((index * 72 / groups.len()) as u8),
        );
        let canvas = compose_pdf_to_image_group_with_mode(group, &layout, background, &format, cancelled, mode)?;
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
            12 + (((index + 1) * 72 / groups.len()) as u8),
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
            PdfToImageExportMode::Horizontal => "long-horizontal".to_string(),
            PdfToImageExportMode::Grid => "grid".to_string(),
        },
    })
}

#[tauri::command]
pub(crate) async fn export_pdf_to_images(
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
