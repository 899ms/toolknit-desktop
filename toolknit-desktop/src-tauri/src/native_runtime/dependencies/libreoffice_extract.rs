use super::super::office::{libreoffice_io_error, stop_office_child};
use std::io::{Read, Seek, SeekFrom};
use std::path::Path;
use std::time::{Duration, Instant};

// Administrative MSI extraction can legitimately exceed three minutes on slow
// disks. Bound inactivity separately from the total duration.
const IDLE_LIMIT: Duration = Duration::from_secs(300);
const TOTAL_LIMIT: Duration = Duration::from_secs(1800);
const LOG_LIMIT: u64 = 64 * 1024 * 1024;
const ACTIONS: &[&str] = &[
    "AdminInitialize",
    "CostInitialize",
    "FileCost",
    "CostFinalize",
    "InstallValidate",
    "InstallInitialize",
    "InstallAdminPackage",
    "InstallFiles",
    "InstallFinalize",
    "AdminFinalize",
    "LaunchConditions",
    "AppSearch",
    "ValidateProductID",
];

#[derive(Clone, Debug, Default, serde::Serialize)]
pub(super) struct ExtractionProgress {
    pub elapsed_seconds: u64,
    pub extracted_files: u64,
    pub extracted_bytes: u64,
    pub action: String,
}

#[derive(Default)]
struct Activity {
    log_bytes: u64,
    files: u64,
    bytes: u64,
    last_change: Duration,
    action: String,
}

impl Activity {
    fn observe(&mut self, now: Duration, log_bytes: u64, files: u64, bytes: u64) {
        if (log_bytes, files, bytes) != (self.log_bytes, self.files, self.bytes) {
            self.last_change = now;
            self.log_bytes = log_bytes;
            self.files = files;
            self.bytes = bytes;
        }
    }

    fn timeout(&self, now: Duration, idle: Duration, total: Duration) -> Option<String> {
        let reason = if now >= total {
            "extract-timeout"
        } else if now.saturating_sub(self.last_change) >= idle {
            "extract-stalled"
        } else {
            return None;
        };
        Some(format!(
            "libreoffice-runtime:{}:action={}_elapsed={}s_idle={}s_files={}",
            reason,
            if self.action.is_empty() {
                "starting"
            } else {
                &self.action
            },
            now.as_secs(),
            now.saturating_sub(self.last_change).as_secs(),
            self.files
        ))
    }

    fn progress(&self, now: Duration) -> ExtractionProgress {
        ExtractionProgress {
            elapsed_seconds: now.as_secs(),
            extracted_files: self.files,
            extracted_bytes: self.bytes,
            action: self.action.clone(),
        }
    }
}

// Raw MSI logs contain private paths. Only whitelisted action identifiers leave
// this module; the session-owned log is removed after extraction.
fn last_action(bytes: &[u8]) -> Option<String> {
    let text = if bytes.iter().take(128).filter(|byte| **byte == 0).count() > 16 {
        String::from_utf16_lossy(
            &bytes
                .chunks_exact(2)
                .map(|pair| u16::from_le_bytes([pair[0], pair[1]]))
                .collect::<Vec<_>>(),
        )
    } else {
        String::from_utf8_lossy(bytes).into_owned()
    };
    text.lines()
        .filter_map(|line| {
            let candidate = if let Some((_, value)) = line.split_once("Doing action: ") {
                value.trim()
            } else if line.starts_with("Action start ") {
                line.rsplit_once(": ")
                    .map(|(_, value)| value.trim_end_matches('.'))?
            } else {
                return None;
            };
            ACTIONS.contains(&candidate).then(|| candidate.to_string())
        })
        .last()
}

#[derive(Default)]
struct ActivityLog {
    offset: u64,
    tail: Vec<u8>,
}

impl ActivityLog {
    fn read(&mut self, path: &Path) -> (u64, Option<String>) {
        let Ok(mut file) = std::fs::File::open(path) else {
            return (0, None);
        };
        let size = file.metadata().map(|meta| meta.len()).unwrap_or(0);
        if size < self.offset {
            self.offset = 0;
            self.tail.clear();
        }
        if size > LOG_LIMIT || file.seek(SeekFrom::Start(self.offset)).is_err() {
            return (size, None);
        }
        // Read new records, not only the tail: InstallFiles can be followed by
        // thousands of file entries between polls. Keep a bounded split-line tail.
        let mut bytes = Vec::new();
        let _ = file.take(512 * 1024).read_to_end(&mut bytes);
        bytes.truncate(bytes.len() & !1);
        self.offset += bytes.len() as u64;
        let mut text = std::mem::take(&mut self.tail);
        text.extend_from_slice(&bytes);
        let action = last_action(&text);
        self.tail = text[text.len().saturating_sub(1024)..].to_vec();
        (size, action)
    }
}

fn extracted_size(root: &Path) -> (u64, u64) {
    let mut stack = vec![(root.to_path_buf(), 0)];
    let mut files = 0_u64;
    let mut bytes = 0_u64;
    let mut visited = 0;
    while let Some((directory, depth)) = stack.pop() {
        if depth > 32 {
            continue;
        }
        let Ok(entries) = std::fs::read_dir(directory) else {
            continue;
        };
        for entry in entries.flatten() {
            visited += 1;
            if visited > 100_000 {
                return (files, bytes);
            }
            let Ok(meta) = std::fs::symlink_metadata(entry.path()) else {
                continue;
            };
            if meta.file_type().is_symlink() {
                continue;
            }
            if meta.is_dir() {
                stack.push((entry.path(), depth + 1));
            } else if meta.is_file() {
                files += 1;
                bytes = bytes.saturating_add(meta.len());
            }
        }
    }
    (files, bytes)
}

fn exit_error(code: Option<i32>, action: &str) -> String {
    let code = code.unwrap_or(-1);
    let reason = match code {
        1618 => "installer-busy",
        1625 => "installer-policy",
        _ => "extract",
    };
    format!(
        "libreoffice-runtime:{}:exit={}_action={}",
        reason,
        code,
        if action.is_empty() {
            "starting"
        } else {
            action
        }
    )
}

struct ExtractionChild(std::process::Child);
impl Drop for ExtractionChild {
    fn drop(&mut self) {
        if !matches!(self.0.try_wait(), Ok(Some(_))) {
            stop_office_child(&mut self.0);
        }
    }
}

fn wait_for_extraction(
    child: std::process::Child,
    staged: &Path,
    log: &Path,
    cancelled: impl Fn() -> bool,
    mut report: impl FnMut(ExtractionProgress),
    idle_limit: Duration,
    total_limit: Duration,
) -> Result<(), String> {
    let mut child = ExtractionChild(child);
    let started = Instant::now();
    let mut activity = Activity::default();
    let mut activity_log = ActivityLog::default();
    let mut next_scan = Duration::ZERO;
    let mut next_report = Duration::ZERO;
    loop {
        if cancelled() {
            return Err("dependency-download:cancelled".into());
        }
        // Always accept successful completion before evaluating timeout limits.
        if let Some(status) = child
            .0
            .try_wait()
            .map_err(|e| libreoffice_io_error("extract", &e))?
        {
            if !status.success() {
                let (_, action) = activity_log.read(log);
                return Err(exit_error(
                    status.code(),
                    action.as_deref().unwrap_or(&activity.action),
                ));
            }
            let (files, bytes) = extracted_size(staged);
            report(ExtractionProgress {
                elapsed_seconds: started.elapsed().as_secs(),
                extracted_files: files,
                extracted_bytes: bytes,
                action: "InstallFinalize".into(),
            });
            return Ok(());
        }
        let now = started.elapsed();
        if now >= next_report {
            let (log_bytes, action) = activity_log.read(log);
            if log_bytes > LOG_LIMIT {
                return Err("libreoffice-runtime:extract:log-limit".into());
            }
            if let Some(action) = action {
                activity.action = action;
            }
            let (files, bytes) = if now >= next_scan {
                next_scan = now + Duration::from_secs(5);
                extracted_size(staged)
            } else {
                (activity.files, activity.bytes)
            };
            activity.observe(now, log_bytes, files, bytes);
            report(activity.progress(now));
            next_report = now + Duration::from_secs(1);
        }
        if let Some(error) = activity.timeout(now, idle_limit, total_limit) {
            return Err(error);
        }
        std::thread::sleep(Duration::from_millis(80));
    }
}

#[cfg(target_os = "windows")]
pub(super) fn extract_msi(
    archive: &Path,
    staged: &Path,
    cancelled: impl Fn() -> bool,
    report: impl FnMut(ExtractionProgress),
) -> Result<(), String> {
    use std::os::windows::process::CommandExt;
    struct SessionLog(std::path::PathBuf);
    impl Drop for SessionLog {
        fn drop(&mut self) {
            let _ = std::fs::remove_file(&self.0);
        }
    }
    let log = SessionLog(staged.with_file_name(format!(
        "{}.msi.log",
        staged
            .file_name()
            .ok_or("libreoffice-runtime:extract:path")?
            .to_string_lossy()
    )));
    if cancelled() {
        return Err("dependency-download:cancelled".into());
    }
    let child = std::process::Command::new("msiexec.exe")
        .arg("/a")
        .arg(archive)
        // Administrative extraction needs verbose records for action names.
        // Do not force a disk flush per line; file growth also reports activity.
        .args(["/qn", "/norestart", "/L*v"])
        .arg(&log.0)
        .arg("TARGETDIR=".to_owned() + &staged.to_string_lossy())
        .creation_flags(0x08000000)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
        .map_err(|e| libreoffice_io_error("extract", &e))?;
    wait_for_extraction(
        child,
        staged,
        &log.0,
        cancelled,
        report,
        IDLE_LIMIT,
        TOTAL_LIMIT,
    )
}

#[cfg(test)]
#[path = "libreoffice_extract_tests.rs"]
mod tests;
