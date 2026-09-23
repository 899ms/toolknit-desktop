use super::super::office::{libreoffice_io_error, probe_libreoffice_detailed};
#[cfg(target_os = "windows")]
use super::libreoffice_extract::{extract_msi, ExtractionProgress};
use super::*;

// These x64 DLLs are shipped in the pinned, SHA-256-verified MSI. Administrative
// extraction leaves them in System64; Windows loads app-local DLLs from program.
const MSVC_DLLS: &[&str] = &[
    "concrt140.dll",
    "msvcp140.dll",
    "msvcp140_1.dll",
    "msvcp140_2.dll",
    "msvcp140_atomic_wait.dll",
    "msvcp140_codecvt_ids.dll",
    "vccorlib140.dll",
    "vcruntime140.dll",
    "vcruntime140_1.dll",
    "vcruntime140_threads.dll",
];
static DEPLOY_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

fn regular_file(path: &std::path::Path) -> bool {
    std::fs::symlink_metadata(path).is_ok_and(|meta| {
        meta.is_file()
            && !meta.file_type().is_symlink()
            && meta.len() > 0
            && meta.len() <= 8 * 1024 * 1024
    })
}

pub(super) fn ensure_app_local_libraries(runtime: &std::path::Path) -> Result<(), String> {
    let _lock = DEPLOY_LOCK
        .lock()
        .map_err(|_| "libreoffice-runtime:runtime-files:busy".to_string())?;
    let program = runtime.join("program");
    let system64 = runtime.join("System64");
    for directory in [&program, &system64] {
        let meta = std::fs::symlink_metadata(directory)
            .map_err(|e| libreoffice_io_error("runtime-files", &e))?;
        if !meta.is_dir() || meta.file_type().is_symlink() {
            return Err("libreoffice-runtime:runtime-files".into());
        }
    }
    // Check the whole source set first so an incomplete extraction is not used.
    for name in MSVC_DLLS {
        if !regular_file(&system64.join(name)) {
            return Err(format!("libreoffice-runtime:runtime-files:{}", name));
        }
    }
    for name in MSVC_DLLS {
        let target = program.join(name);
        if regular_file(&target) {
            let source_size = std::fs::metadata(system64.join(name))
                .map_err(|e| libreoffice_io_error("runtime-files", &e))?
                .len();
            let target_size = std::fs::metadata(&target)
                .map_err(|e| libreoffice_io_error("runtime-files", &e))?
                .len();
            if source_size == target_size {
                continue;
            }
            std::fs::remove_file(&target).map_err(|e| libreoffice_io_error("runtime-files", &e))?;
        }
        if target.exists() || std::fs::symlink_metadata(&target).is_ok() {
            return Err(format!("libreoffice-runtime:runtime-files:{}", name));
        }
        // create_new also prevents following a DLL symlink or overwriting a file
        // that appeared after the metadata check.
        let mut output = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&target)
            .map_err(|e| libreoffice_io_error("runtime-files", &e))?;
        let copied = (|| {
            let mut input = std::fs::File::open(system64.join(name))?;
            std::io::copy(&mut input, &mut output)?;
            output.sync_all()
        })();
        drop(output);
        if let Err(error) = copied {
            let _ = std::fs::remove_file(&target);
            return Err(libreoffice_io_error("runtime-files", &error));
        }
    }
    Ok(())
}

pub(super) fn publish_validated_runtime(
    staged: &std::path::Path,
    destination: &std::path::Path,
    validate: impl FnOnce(&std::path::Path) -> Result<(), String>,
    cancelled: impl Fn() -> bool,
) -> Result<(), String> {
    ensure_app_local_libraries(staged)?;
    validate(&staged.join("program/soffice.com"))?;
    if cancelled() {
        return Err("dependency-download:cancelled".into());
    }
    let backup = destination.with_extension(format!(
        "previous-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos()
    ));
    let had_previous = destination.exists();
    if had_previous {
        std::fs::rename(destination, &backup).map_err(|e| libreoffice_io_error("publish", &e))?;
    }
    if let Err(error) = std::fs::rename(staged, destination) {
        if had_previous {
            let _ = std::fs::rename(&backup, destination);
        }
        return Err(libreoffice_io_error("publish", &error));
    }
    if had_previous {
        let _ = std::fs::remove_dir_all(backup);
    }
    Ok(())
}

#[cfg(target_os = "windows")]
pub(super) fn extract_and_validate(
    archive: &std::path::Path,
    destination: &std::path::Path,
    mut report: impl FnMut(&str, ExtractionProgress),
) -> Result<(), String> {
    // A service-side MSI operation can outlive its client on cancellation.
    // Never reuse/delete its directory while retrying a different session.
    let staged = destination.with_file_name(format!(
        "{}.installing-{}-{}",
        destination
            .file_name()
            .ok_or("libreoffice-runtime:extract:path")?
            .to_string_lossy(),
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos()
    ));
    std::fs::create_dir(&staged).map_err(|e| libreoffice_io_error("extract", &e))?;
    let result = (|| {
        let cancelled = || CANCEL_LIBREOFFICE_DOWNLOAD.load(Ordering::SeqCst);
        if cancelled() {
            return Err("dependency-download:cancelled".into());
        }
        let mut last_progress = ExtractionProgress::default();
        extract_msi(archive, &staged, cancelled, |progress| {
            last_progress = progress.clone();
            report("installing", progress);
        })?;
        publish_validated_runtime(
            &staged,
            destination,
            |executable| {
                report("verifying", last_progress);
                probe_libreoffice_detailed(executable, "managed", 30_000, cancelled).map(|_| ())
            },
            cancelled,
        )
    })();
    if result.is_err() {
        let _ = std::fs::remove_dir_all(&staged);
    }
    result
}

#[cfg(test)]
#[path = "libreoffice_install_tests.rs"]
mod tests;
