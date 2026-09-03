import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const [cleanupController, nativeCleanup, nativeEntry, nativeRunner, cargo] = await Promise.all([
  readFile(new URL('../src/features/cleanup-tools/c-drive-controller.js', import.meta.url), 'utf8'),
  readFile(new URL('../src-tauri/src/system_cleanup.rs', import.meta.url), 'utf8'),
  readFile(new URL('../src-tauri/src/native_runtime.rs', import.meta.url), 'utf8'),
  readFile(new URL('../src-tauri/src/native_runtime/runner.rs', import.meta.url), 'utf8'),
  readFile(new URL('../src-tauri/Cargo.toml', import.meta.url), 'utf8')
]);

const scanFunction = cleanupController.slice(
  cleanupController.indexOf('async function cDriveCleanupStartScan()'),
  cleanupController.indexOf('async function cDriveCleanupRunSelected()')
);
assert.ok(scanFunction.indexOf("cDriveCleanupInvoke('system_cleanup_is_admin')") >= 0);
assert.ok(
  scanFunction.indexOf("cDriveCleanupInvoke('system_cleanup_is_admin')")
    < scanFunction.indexOf("cDriveCleanupInvoke('system_cleanup_scan')"),
  'administrator status must be checked before the expensive cleanup scan'
);
assert.match(scanFunction, /if \(isAdmin === false\) \{[\s\S]*cDriveCleanupShowAdminMask\(\)/);
assert.match(scanFunction, /if \(isAdmin !== true\) \{[\s\S]*admin-check-failed/);
assert.match(cleanupController, /cDriveCleanupAdminRelaunch\.disabled = cDriveCleanupRelaunching/);
assert.match(cleanupController, /adminRelaunching/);
assert.match(cleanupController, /if \(cDriveCleanupRelaunching\) return/);

assert.match(nativeCleanup, /OpenProcessToken\(GetCurrentProcess\(\), TOKEN_QUERY/);
assert.match(nativeCleanup, /GetTokenInformation\([\s\S]*TokenElevation/);
assert.match(nativeCleanup, /ShellExecuteExW\(&mut execute\)/);
assert.doesNotMatch(nativeCleanup, /Start-Process -FilePath/);
assert.match(nativeCleanup, /ELEVATED_RELAUNCH_PARENT_PREFIX/);
assert.match(nativeCleanup, /OpenProcess\(PROCESS_SYNCHRONIZE, false, parent_pid\)/);
assert.match(nativeCleanup, /if !query_admin_status\(\)\? \{[\s\S]*system-cleanup:admin-required/);

const runEntry = nativeRunner;
assert.ok(
  runEntry.indexOf('await_previous_instance_for_elevated_relaunch()')
    < runEntry.indexOf('tauri::Builder::default()'),
  'the elevated child must wait before the single-instance plugin is initialized'
);
assert.match(cargo, /"Win32_Security"/);
assert.match(cargo, /"Win32_System_Threading"/);

console.log('system cleanup elevation contract passed');
