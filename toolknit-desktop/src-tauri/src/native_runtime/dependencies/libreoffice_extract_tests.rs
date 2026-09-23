use super::*;

#[test]
fn slow_active_msi_is_not_killed_at_three_minutes() {
    let mut activity = Activity::default();
    for seconds in (0..=1200).step_by(10) {
        activity.observe(
            Duration::from_secs(seconds),
            seconds * 4096,
            seconds * 10,
            seconds * 100_000,
        );
        assert!(activity
            .timeout(Duration::from_secs(seconds), IDLE_LIMIT, TOTAL_LIMIT)
            .is_none());
    }
    assert!(activity
        .timeout(TOTAL_LIMIT, IDLE_LIMIT, TOTAL_LIMIT)
        .unwrap()
        .contains("extract-timeout"));
}

#[test]
fn no_activity_times_out_with_safe_stage_details() {
    let mut activity = Activity {
        action: "InstallFiles".into(),
        ..Default::default()
    };
    activity.observe(Duration::from_secs(10), 500, 12, 1000);
    activity.observe(Duration::from_secs(309), 500, 12, 1000);
    assert!(activity
        .timeout(Duration::from_secs(309), IDLE_LIMIT, TOTAL_LIMIT)
        .is_none());
    assert_eq!(
        activity
            .timeout(Duration::from_secs(310), IDLE_LIMIT, TOTAL_LIMIT)
            .unwrap(),
        "libreoffice-runtime:extract-stalled:action=InstallFiles_elapsed=310s_idle=300s_files=12"
    );
    activity.observe(Duration::from_secs(310), 500, 13, 1100);
    assert!(activity
        .timeout(Duration::from_secs(310), IDLE_LIMIT, TOTAL_LIMIT)
        .is_none());
}

#[test]
fn installer_log_and_growing_file_each_reset_idle_without_extending_total() {
    let mut activity = Activity::default();
    activity.observe(Duration::from_secs(290), 100, 0, 0);
    activity.observe(Duration::from_secs(580), 200, 0, 0);
    assert!(activity
        .timeout(Duration::from_secs(879), IDLE_LIMIT, TOTAL_LIMIT)
        .is_none());
    activity.observe(Duration::from_secs(880), 200, 1, 1024);
    activity.observe(Duration::from_secs(1170), 200, 1, 2048);
    assert!(activity
        .timeout(Duration::from_secs(1469), IDLE_LIMIT, TOTAL_LIMIT)
        .is_none());
    activity.observe(TOTAL_LIMIT, 300, 2, 4096);
    assert!(activity
        .timeout(TOTAL_LIMIT, IDLE_LIMIT, TOTAL_LIMIT)
        .unwrap()
        .contains("extract-timeout"));
}

#[test]
fn installer_log_exposes_only_allowed_actions_in_both_encodings() {
    let text = "MSI (s) (00:00) [12:00:00]: Doing action: CostInitialize\r\nAction start 12:00:00: InstallFiles.\r\nProperty: USERNAME=private-person\r\nAction start 12:00:00: private-action.\r\nFile: C:\\Private\\document.pdf";
    assert_eq!(
        last_action(text.as_bytes()).as_deref(),
        Some("InstallFiles")
    );
    let utf16: Vec<u8> = text.encode_utf16().flat_map(u16::to_le_bytes).collect();
    assert_eq!(last_action(&utf16).as_deref(), Some("InstallFiles"));
    assert_eq!(
        last_action(b"MSI (s): Doing action: InstallFiles/private-data"),
        None
    );
    assert_eq!(last_action(b"USER: InstallFiles"), None);
    assert_eq!(
        exit_error(Some(1618), "InstallInitialize"),
        "libreoffice-runtime:installer-busy:exit=1618_action=InstallInitialize"
    );
    assert!(exit_error(Some(1625), "").starts_with("libreoffice-runtime:installer-policy:"));
}

#[test]
fn installer_log_keeps_actions_across_bounded_reads() {
    let file = std::env::temp_dir().join(format!(
        "toolknit-extract-log-{}-{}.log",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    let prefix = "Action start 12:00:00: CostInitialize.\r\n";
    let padding = "x".repeat(512 * 1024 / 2 - prefix.len() - 24);
    let text = format!(
        "{prefix}{padding}\r\nAction start 12:00:00: InstallFiles.\r\n{}",
        "File: private-fixture-data\r\n".repeat(20000)
    );
    let bytes: Vec<u8> = text.encode_utf16().flat_map(u16::to_le_bytes).collect();
    std::fs::write(&file, bytes).unwrap();
    let mut log = ActivityLog::default();
    let (_, first) = log.read(&file);
    let (_, second) = log.read(&file);
    std::fs::remove_file(&file).unwrap();
    assert_eq!(first.as_deref(), Some("CostInitialize"));
    assert_eq!(second.as_deref(), Some("InstallFiles"));
    assert!(log.tail.len() <= 1024);
    assert_eq!(log.offset, 1024 * 1024);
}

#[test]
fn extraction_progress_retains_existing_download_event_shape() {
    use super::super::{LibreOfficeDownloadProgress, LibreOfficeInstallProgress};
    let event = LibreOfficeInstallProgress {
        download: LibreOfficeDownloadProgress {
            downloaded_bytes: 100,
            total_bytes: 100,
            phase: "installing".into(),
        },
        extraction: ExtractionProgress {
            elapsed_seconds: 181,
            extracted_files: 12,
            extracted_bytes: 1024,
            action: "InstallFiles".into(),
        },
    };
    let value = serde_json::to_value(event).unwrap();
    assert_eq!(value["phase"], "installing");
    assert_eq!(value["downloaded_bytes"], 100);
    assert_eq!(value["extraction"]["elapsed_seconds"], 181);
    assert_eq!(value["extraction"]["extracted_files"], 12);
}

#[cfg(target_os = "windows")]
#[test]
fn extraction_monitor_reaps_stalled_and_cancelled_children() {
    use std::os::windows::io::{AsHandle, AsRawHandle};
    use std::os::windows::process::CommandExt;
    use windows::Win32::Foundation::{HANDLE, WAIT_OBJECT_0};
    use windows::Win32::System::Threading::WaitForSingleObject;
    let temp = std::env::temp_dir().join(format!(
        "toolknit-extract-monitor-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    std::fs::create_dir(&temp).unwrap();
    let launch = |script| {
        std::process::Command::new("powershell.exe")
            .args(["-NoProfile", "-NonInteractive", "-Command", script])
            .creation_flags(0x08000000)
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
            .unwrap()
    };
    let started = Instant::now();
    let child = launch("Start-Sleep -Seconds 30");
    let stalled_handle = child.as_handle().try_clone_to_owned().unwrap();
    let stalled = wait_for_extraction(
        child,
        &temp,
        &temp.join("log"),
        || false,
        |_| {},
        Duration::from_millis(80),
        Duration::from_secs(20),
    );
    let child = launch("Start-Sleep -Seconds 30");
    let cancelled_handle = child.as_handle().try_clone_to_owned().unwrap();
    let cancelled = wait_for_extraction(
        child,
        &temp,
        &temp.join("log"),
        || true,
        |_| {},
        Duration::from_secs(10),
        Duration::from_secs(20),
    );
    for handle in [&stalled_handle, &cancelled_handle] {
        assert_eq!(
            unsafe { WaitForSingleObject(HANDLE(handle.as_raw_handle() as isize), 0) },
            WAIT_OBJECT_0,
            "the owned process has exited, not just returned an error"
        );
    }
    let mut completed = launch("exit 0");
    assert!(completed.wait().unwrap().success());
    let mut reports = Vec::new();
    wait_for_extraction(
        completed,
        &temp,
        &temp.join("log"),
        || false,
        |progress| reports.push(progress),
        Duration::ZERO,
        Duration::ZERO,
    )
    .unwrap();
    assert_eq!(
        reports.last().unwrap().action,
        "InstallFinalize",
        "completed extraction wins over a deadline"
    );
    std::fs::remove_dir_all(&temp).unwrap();
    assert!(stalled
        .unwrap_err()
        .starts_with("libreoffice-runtime:extract-stalled:"));
    assert_eq!(cancelled.unwrap_err(), "dependency-download:cancelled");
    assert!(started.elapsed() < Duration::from_secs(10));
}
