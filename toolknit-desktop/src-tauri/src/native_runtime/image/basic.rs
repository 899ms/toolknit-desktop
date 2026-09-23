
// ===== Image Conversion =====

#[tauri::command]
pub(crate) async fn convert_image_batch(
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

pub(crate) fn validate_image_batch_request(input_paths: &[String]) -> Result<(), String> {
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

pub(crate) fn validate_image_batch_input(input_path: &str) -> Result<(std::path::PathBuf, String), String> {
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

pub(crate) fn validate_image_batch_inputs(input_paths: &[String]) -> Result<(), String> {
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

pub(crate) fn image_has_multiple_gif_frames(input: &std::path::Path) -> Result<bool, String> {
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

pub(crate) fn validate_image_output_dir(output_dir: &str) -> Result<std::path::PathBuf, String> {
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

pub(crate) fn publish_image_output(
    temporary_output_path: &std::path::Path,
    output_path: &std::path::Path,
) -> Result<(), String> {
    std::fs::hard_link(temporary_output_path, output_path)
        .map_err(|error| format!("Cannot publish image output: {}", error))?;
    let _ = std::fs::remove_file(temporary_output_path);
    Ok(())
}

pub(crate) fn flatten_image_to_rgb(
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

pub(crate) fn write_converted_image(
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

pub(crate) fn write_raster_svg(
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
pub(crate) struct ImageStitchResult {
    pub(crate) output_path: String,
    pub(crate) width: u32,
    pub(crate) height: u32,
    pub(crate) count: usize,
    pub(crate) format: String,
}

#[derive(serde::Serialize)]
pub(crate) struct ImageStitchInputPreview {
    pub(crate) path: String,
    pub(crate) name: String,
    pub(crate) width: u32,
    pub(crate) height: u32,
    pub(crate) thumbnail_data_url: String,
    pub(crate) preview_data_url: String,
}

#[derive(Clone)]
pub(crate) struct ImageStitchOptions {
    pub(crate) input_paths: Vec<String>,
    pub(crate) output_dir: String,
    pub(crate) output_name: Option<String>,
    pub(crate) mode: String,
    pub(crate) reference: String,
    pub(crate) spacing_px: u32,
    pub(crate) scale_percent: u32,
    pub(crate) format: String,
    pub(crate) jpeg_quality: u8,
    pub(crate) background_rgba: String,
}

#[derive(Clone, Debug, PartialEq)]
pub(crate) struct ImageStitchLayout {
    pub(crate) sizes: Vec<(u32, u32)>,
    pub(crate) width: u32,
    pub(crate) height: u32,
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
pub(crate) struct ImageCropResult {
    pub(crate) output_path: String,
    pub(crate) width: u32,
    pub(crate) height: u32,
    pub(crate) bytes: u64,
    pub(crate) format: String,
}

#[derive(Clone)]
pub(crate) struct ImageCropOptions {
    pub(crate) input_path: String,
    pub(crate) output_dir: String,
    pub(crate) output_name: Option<String>,
    pub(crate) crop_x: u32,
    pub(crate) crop_y: u32,
    pub(crate) crop_width: u32,
    pub(crate) crop_height: u32,
    pub(crate) rotation: u16,
    pub(crate) flip_horizontal: bool,
    pub(crate) flip_vertical: bool,
    pub(crate) format: String,
    pub(crate) jpeg_quality: u8,
    pub(crate) background_rgba: String,
}

pub(crate) fn read_oriented_image(path: &std::path::Path) -> Result<image::DynamicImage, String> {
    decode_oriented_image(path).map_err(|_| "image-stitch:invalid-input".to_string())
}

pub(crate) fn oriented_image_dimensions(path: &std::path::Path) -> Result<(u32, u32), String> {
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

pub(crate) fn stitch_background(value: &str) -> Result<image::Rgba<u8>, String> {
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
