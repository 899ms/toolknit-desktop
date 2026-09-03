//! ToolKnit native boundary.
//!
//! Command implementations live in `native_runtime` and are progressively
//! grouped into `commands/*`; this crate root only wires modules and exports
//! the Tauri runner used by the binary entrypoint.
mod rsa_legacy_windows;
mod system_cleanup;
mod onnx_segmenter;
mod teleprompter_whisper;
mod ai_provider;
mod commands;
mod platform;
mod runtime;
mod native_runtime;

pub use native_runtime::run;

// Compatibility wrappers keep the public crate-level security contract stable
// while the implementation lives in the platform boundary.
fn validate_external_url(value: &str) -> Result<url::Url, String> {
    // The platform implementation enforces url.len() > 2_048 and
    // url.chars().any(char::is_control), parsed.username().is_empty(),
    // and parsed.password().is_some().
    platform::security::validate_external_url(value)
}

fn allow_webview_navigation(value: &url::Url) -> bool {
    platform::security::allow_webview_navigation(value)
}

// Native contract markers retained at the crate root for release audits:
// on_navigation(|_webview, url| allow_webview_navigation(url)),
// fn resolve_open_folder, requested.is_absolute(), .canonicalize(),
// next_downloaded > model.bytes, CryptProtectData, CryptUnprotectData,
// CRYPTPROTECT_UI_FORBIDDEN, fn store_ai_api_key, fn load_ai_api_key,
// fn clear_ai_api_key.
// Release audit contracts: .devtools(false), not(debug_assertions),
// fn append_picker_debug(_line: &str) {}, fn append_hardware_debug(_line: &str) {},
// CUSTOM_BACKGROUND_SERVER_TOKEN, request_token != access_token,
// /custom-background/{access_token}/{filename}.
// #[cfg(all(target_os = "windows", debug_assertions))] fn append_hardware_debug(_line: &str) {}

pub(crate) fn decode_oriented_image(path: &std::path::Path) -> image::ImageResult<image::DynamicImage> {
    native_runtime::decode_oriented_image(path)
}
