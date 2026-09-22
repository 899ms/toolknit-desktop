pub(crate) fn convert_image_batch_blocking_with_progress<F>(
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
pub(crate) async fn compress_image_batch(
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

pub(crate) fn validate_image_compression_request(input_paths: &[String], quality: &str) -> Result<(), String> {
    validate_image_batch_request(input_paths)?;
    if !matches!(quality, "high" | "medium" | "low") {
        return Err("Unsupported image compression quality".to_string());
    }
    Ok(())
}

pub(crate) fn validate_image_compression_input(
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
pub(crate) fn validate_image_compression_inputs(input_paths: &[String], quality: &str) -> Result<(), String> {
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

pub(crate) fn write_compressed_image(
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
            let encoder = PngEncoder::new_with_quality(writer, png_compression, FilterType::Adaptive);
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

fn write_compressed_image_file(
    input: &std::path::Path,
    output: &std::path::Path,
    format: image::ImageFormat,
    jpeg_quality: u8,
) -> Result<(), String> {
    if CANCEL_FLAG.load(Ordering::SeqCst) {
        return Err("Image compression cancelled".to_string());
    }
    if format == image::ImageFormat::Png {
        // Optimize the original PNG, preserving its metadata and exact samples.
        // Re-encoding a decoded RGB image loses palette/bit-depth opportunities.
        let bytes = std::fs::read(input).map_err(|error| error.to_string())?;
        let options = oxipng::Options {
            timeout: Some(std::time::Duration::from_secs(20)),
            max_decompressed_size: Some((MAX_IMAGE_PIXELS * 9 + 1024) as usize),
            optimize_alpha: false,
            scale_16: false,
            strip: oxipng::StripChunks::None,
            ..oxipng::Options::from_preset(2)
        };
        let optimized = oxipng::optimize_from_memory(&bytes, &options)
            .map_err(|error| error.to_string())?;
        if CANCEL_FLAG.load(Ordering::SeqCst) {
            return Err("Image compression cancelled".to_string());
        }
        std::fs::write(output, optimized).map_err(|error| error.to_string())
    } else {
        let decoded = decode_oriented_image(input).map_err(|error| error.to_string())?;
        if CANCEL_FLAG.load(Ordering::SeqCst) {
            return Err("Image compression cancelled".to_string());
        }
        write_compressed_image(
            &decoded, output, format, jpeg_quality, image::codecs::png::CompressionType::Best,
        ).map_err(|error| error.to_string())
    }
}

pub(crate) fn compress_image_batch_blocking(
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

pub(crate) fn compress_image_batch_blocking_with_progress<F>(
    input_paths: Vec<String>,
    output_dir: String,
    quality: String,
    mut emit_progress: F,
) -> Result<BatchConvertResult, String>
where
    F: FnMut(ConvertProgress),
{
    validate_image_compression_request(&input_paths, &quality)?;

    let output_dir_path = validate_image_output_dir(&output_dir)?;

    // PNG and WebP stay lossless; only JPEG changes visual quality.
    let jpeg_quality = match quality.as_str() {
        "high" => 90u8,
        "medium" => 65u8,
        "low" => 35u8,
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

        let result = write_compressed_image_file(&input, &temporary_output_path, format, jpeg_quality)
            .and_then(|()| {
                let input_size = std::fs::metadata(&input).map_err(|error| error.to_string())?.len();
                let output_size = std::fs::metadata(&temporary_output_path).map_err(|error| error.to_string())?.len();
                if output_size == 0 {
                    return Err("Image encoder produced an empty output".to_string());
                }
                Ok((input_size, output_size))
            });
        if CANCEL_FLAG.load(Ordering::SeqCst) {
            let _ = std::fs::remove_file(&temporary_output_path);
            break;
        }
        match result {
            Ok((input_size, output_size)) => {
                if output_size < input_size {
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
                } else {
                    // A valid image without a smaller candidate is unchanged, not failed.
                    // success_count remains the number of files actually published.
                    let _ = std::fs::remove_file(&temporary_output_path);
                }
                compressed_size += output_size.min(input_size);
                original_size += input_size;
                emit_progress(ConvertProgress {
                    file_name,
                    current: i + 1,
                    total,
                    progress: 1.0,
                    status: "done".to_string(),
                });
            }
            Err(e) => {
                let _ = std::fs::remove_file(&temporary_output_path);
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
