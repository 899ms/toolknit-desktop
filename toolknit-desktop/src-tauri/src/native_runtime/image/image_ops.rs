pub(crate) fn convert_image_batch_blocking(
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

pub(crate) fn image_crop_format(value: &str) -> Result<(image::ImageFormat, &'static str, String), String> {
    match value.trim().to_ascii_lowercase().as_str() {
        "png" => Ok((image::ImageFormat::Png, ".png", "PNG".to_string())),
        "jpg" | "jpeg" => Ok((image::ImageFormat::Jpeg, ".jpg", "JPG".to_string())),
        "webp" => Ok((image::ImageFormat::WebP, ".webp", "WEBP".to_string())),
        "bmp" => Ok((image::ImageFormat::Bmp, ".bmp", "BMP".to_string())),
        _ => Err("image-crop:unsupported-format".to_string()),
    }
}

pub(crate) fn transformed_crop_dimensions(
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

pub(crate) fn validate_image_crop_bounds(
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

pub(crate) fn transform_image_for_crop(
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

pub(crate) fn write_image_crop(
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

pub(crate) fn crop_image_blocking(options: ImageCropOptions) -> Result<ImageCropResult, String> {
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
pub(crate) async fn crop_image(
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
pub(crate) struct ColorReplaceResult {
    pub(crate) output_path: String,
    pub(crate) width: u32,
    pub(crate) height: u32,
    pub(crate) bytes: u64,
    pub(crate) format: String,
    pub(crate) changed_pixels: u64,
}

#[derive(Clone)]
pub(crate) struct ColorReplaceOptions {
    pub(crate) app: Option<tauri::AppHandle>,
    pub(crate) operation_id: Option<String>,
    pub(crate) input_path: String,
    pub(crate) output_dir: String,
    pub(crate) output_name: String,
    pub(crate) source_rgb: Vec<u8>,
    pub(crate) target_rgb: Vec<u8>,
    pub(crate) threshold: f32,
    pub(crate) seed_x: u32,
    pub(crate) seed_y: u32,
    pub(crate) smart: bool,
    pub(crate) softness: f32,
    pub(crate) preserve_luminance: bool,
    pub(crate) format: String,
    pub(crate) jpeg_quality: u8,
    pub(crate) cancel_token: Option<std::sync::Arc<std::sync::atomic::AtomicBool>>,
}
