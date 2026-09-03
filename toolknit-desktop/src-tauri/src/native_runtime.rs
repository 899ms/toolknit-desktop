use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::sync::OnceLock;

use tauri::{
    Emitter, LogicalSize, Manager, PhysicalPosition, PhysicalSize, Position, Size, WebviewUrl,
    WebviewWindowBuilder,
};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};

use crate::{ai_provider, onnx_segmenter, platform, rsa_legacy_windows, system_cleanup, teleprompter_whisper};

// The implementation remains in one private namespace while it is being
// migrated. Each file owns one native responsibility and can be promoted to a
// Rust module later without changing the Tauri command protocol.
include!("native_runtime/core.rs");
include!("native_runtime/dependencies.rs");
include!("native_runtime/transcription.rs");
include!("native_runtime/pdf.rs");
include!("native_runtime/image.rs");
include!("native_runtime/media.rs");
include!("native_runtime/system.rs");
include!("native_runtime/office.rs");
include!("native_runtime/runner.rs");
include!("native_runtime/tests.rs");