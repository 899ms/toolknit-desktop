pub fn install<R: tauri::Runtime>(webview: &tauri::Webview<R>) {
    if webview.label() != "main" {
        return;
    }
    if let Err(error) = webview.eval(include_str!("qa-devtools.js")) {
        log::warn!("Could not install test-package DevTools shortcut: {error}");
    }
}
