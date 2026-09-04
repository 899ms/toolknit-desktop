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