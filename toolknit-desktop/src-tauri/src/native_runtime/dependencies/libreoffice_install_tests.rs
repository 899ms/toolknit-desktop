use super::*;

struct Fixture(std::path::PathBuf);
impl Fixture {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!(
            "toolknit-lo-install-test-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&path).unwrap();
        Self(path)
    }
    fn runtime(&self, name: &str) -> std::path::PathBuf {
        let root = self.0.join(name);
        std::fs::create_dir_all(root.join("program")).unwrap();
        std::fs::create_dir_all(root.join("System64")).unwrap();
        std::fs::write(root.join("program/soffice.com"), b"test executable").unwrap();
        for name in MSVC_DLLS {
            std::fs::write(root.join("System64").join(name), name.as_bytes()).unwrap();
        }
        root
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

#[test]
fn libreoffice_install_deploys_complete_crt_beside_executable() {
    let fixture = Fixture::new();
    let root = fixture.runtime("staged");
    ensure_app_local_libraries(&root).unwrap();
    for name in MSVC_DLLS {
        assert_eq!(
            std::fs::read(root.join("program").join(name)).unwrap(),
            name.as_bytes()
        );
    }
    ensure_app_local_libraries(&root).unwrap();
    // Existing extracted installations receive the same repair without MSI/network.
    std::fs::remove_file(root.join("program/vcruntime140_1.dll")).unwrap();
    ensure_app_local_libraries(&root).unwrap();
    assert!(root.join("program/vcruntime140_1.dll").is_file());
    std::fs::write(root.join("program/msvcp140.dll"), b"partial").unwrap();
    ensure_app_local_libraries(&root).unwrap();
    assert_eq!(
        std::fs::read(root.join("program/msvcp140.dll")).unwrap(),
        b"msvcp140.dll"
    );
}

#[test]
fn libreoffice_install_rejects_incomplete_crt_before_copying() {
    let fixture = Fixture::new();
    let root = fixture.runtime("staged");
    std::fs::remove_file(root.join("System64/vcruntime140_1.dll")).unwrap();
    assert!(ensure_app_local_libraries(&root)
        .unwrap_err()
        .contains("vcruntime140_1.dll"));
    assert!(!root.join("program/msvcp140.dll").exists());
}

#[test]
fn libreoffice_install_preserves_previous_runtime_on_validation_failure() {
    let fixture = Fixture::new();
    let staged = fixture.runtime("staged");
    let destination = fixture.runtime("current");
    std::fs::write(destination.join("original"), b"keep").unwrap();
    let error = publish_validated_runtime(
        &staged,
        &destination,
        |_| Err("libreoffice-runtime:missing-library:0xC0000135".into()),
        || false,
    )
    .unwrap_err();
    assert_eq!(error, "libreoffice-runtime:missing-library:0xC0000135");
    assert!(destination.join("original").is_file());
    assert!(staged.exists());
}

#[test]
fn libreoffice_install_cancellation_does_not_publish() {
    let fixture = Fixture::new();
    let staged = fixture.runtime("staged");
    let destination = fixture.0.join("current");
    assert_eq!(
        publish_validated_runtime(&staged, &destination, |_| Ok(()), || true).unwrap_err(),
        "dependency-download:cancelled"
    );
    assert!(!destination.exists());
}

#[test]
fn libreoffice_install_validates_local_dlls_before_publication() {
    let fixture = Fixture::new();
    let staged = fixture.runtime("staged");
    let destination = fixture.runtime("current");
    std::fs::write(destination.join("original"), b"old").unwrap();
    publish_validated_runtime(
        &staged,
        &destination,
        |exe| {
            assert!(exe.is_file());
            for name in MSVC_DLLS {
                assert!(exe.parent().unwrap().join(name).is_file());
            }
            assert!(destination.join("original").is_file());
            Ok(())
        },
        || false,
    )
    .unwrap();
    assert!(!staged.exists());
    assert!(!destination.join("original").exists());
    assert!(destination.join("program/msvcp140.dll").exists());
    assert_eq!(std::fs::read_dir(&fixture.0).unwrap().count(), 1);
}

#[test]
fn libreoffice_install_restores_previous_on_publish_failure() {
    let fixture = Fixture::new();
    let staged = fixture.runtime("staged");
    let destination = fixture.runtime("current");
    std::fs::write(destination.join("original"), b"keep").unwrap();
    let result = publish_validated_runtime(
        &staged,
        &destination,
        |_| {
            std::fs::remove_dir_all(&staged).unwrap();
            Ok(())
        },
        || false,
    );
    assert!(result
        .unwrap_err()
        .starts_with("libreoffice-runtime:publish:"));
    assert!(destination.join("original").is_file());
}

#[test]
#[cfg(target_os = "windows")]
#[ignore = "requires the pinned LibreOffice MSI via TOOLKNIT_OFFICE_INSTALL_TEST_MSI"]
fn libreoffice_install_real_msi_startup() {
    let fixture = Fixture::new();
    let archive =
        std::path::PathBuf::from(std::env::var_os("TOOLKNIT_OFFICE_INSTALL_TEST_MSI").unwrap());
    assert_eq!(sha256_file(&archive).unwrap(), LIBREOFFICE_ARCHIVE_SHA256);
    let destination = fixture.0.join("runtime");
    let mut progress = Vec::new();
    extract_and_validate(&archive, &destination, |phase, value| {
        progress.push((phase.to_string(), value))
    })
    .unwrap();
    assert!(progress
        .iter()
        .any(|(phase, value)| phase == "installing" && value.extracted_files > 0));
    // MSI can schedule InstallFiles and InstallFinalize within one poll. Require
    // a real live action, excluding the synthetic final/verifying reports.
    assert!(
        progress
            .iter()
            .take(progress.len().saturating_sub(2))
            .any(|(phase, value)| phase == "installing" && !value.action.is_empty()),
        "live MSI action records must be parsed before completion"
    );
    assert_eq!(progress.last().unwrap().0, "verifying");
    assert!(progress.last().unwrap().1.extracted_files > 1000);
    assert_eq!(
        std::fs::read_dir(&fixture.0).unwrap().count(),
        1,
        "staging directory and raw MSI log cleaned up"
    );
    println!(
        "MSI extraction completed: {} files, {} bytes, {} seconds",
        progress.last().unwrap().1.extracted_files,
        progress.last().unwrap().1.extracted_bytes,
        progress.last().unwrap().1.elapsed_seconds
    );
    for name in MSVC_DLLS {
        assert_eq!(
            sha256_file(&destination.join("program").join(name)).unwrap(),
            sha256_file(&destination.join("System64").join(name)).unwrap()
        );
    }
    let info = probe_libreoffice_detailed(
        &destination.join("program/soffice.com"),
        "managed",
        30_000,
        || false,
    )
    .unwrap();
    assert!(info.version.unwrap().contains(LIBREOFFICE_RUNTIME_VERSION));

    // A CRT-free loader fixture excludes the Windows/system/PATH search dirs,
    // proving the fix does not rely on this developer machine's installed CRT.
    let loader = std::path::PathBuf::from(
        std::env::var_os("TOOLKNIT_OFFICE_DLL_PROBE").expect("CRT-free loader fixture"),
    );
    let isolated = fixture.0.join("isolated");
    std::fs::create_dir_all(isolated.join("program")).unwrap();
    std::fs::create_dir_all(isolated.join("System64")).unwrap();
    let exe = isolated.join("program/loader-probe.exe");
    std::fs::copy(loader, &exe).unwrap();
    for name in MSVC_DLLS {
        std::fs::copy(
            destination.join("System64").join(name),
            isolated.join("System64").join(name),
        )
        .unwrap();
    }
    let status = || {
        use std::os::windows::process::CommandExt;
        std::process::Command::new(&exe)
            .creation_flags(0x08000000)
            .status()
            .unwrap()
    };
    assert_eq!(
        status().code(),
        Some(126),
        "missing local CRT must fail despite installed system CRT"
    );
    ensure_app_local_libraries(&isolated).unwrap();
    assert!(
        status().success(),
        "the deployed DLLs must load with system CRT lookup excluded"
    );
    // This explicitly selected integration test is the only test process using
    // the CRT-free fixture; exercise termination without touching real Office.
    let prior = std::env::var_os("TOOLKNIT_OFFICE_PROBE_SLEEP");
    std::env::set_var("TOOLKNIT_OFFICE_PROBE_SLEEP", "1");
    let started = std::time::Instant::now();
    let timed_out = probe_libreoffice_detailed(&exe, "managed", 80, || false);
    let cancelled_at = std::time::Instant::now();
    let cancelled = probe_libreoffice_detailed(&exe, "managed", 30_000, || {
        cancelled_at.elapsed().as_millis() >= 80
    });
    if let Some(prior) = prior {
        std::env::set_var("TOOLKNIT_OFFICE_PROBE_SLEEP", prior);
    } else {
        std::env::remove_var("TOOLKNIT_OFFICE_PROBE_SLEEP");
    }
    assert_eq!(timed_out.unwrap_err(), "libreoffice-runtime:timeout:80ms");
    assert_eq!(cancelled.unwrap_err(), "dependency-download:cancelled");
    assert!(
        started.elapsed().as_secs() < 10,
        "slow children must be terminated promptly"
    );
}
