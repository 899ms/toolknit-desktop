use std::sync::OnceLock;
use tauri::{
    Emitter, LogicalSize, Manager, PhysicalPosition, PhysicalSize, Position, Size, WebviewUrl,
    WebviewWindowBuilder,
};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};

use crate::{ai_provider, onnx_segmenter, platform, rsa_legacy_windows, system_cleanup, teleprompter_whisper};

static CUSTOM_BACKGROUND_SERVER_PORT: OnceLock<u16> = OnceLock::new();
static CUSTOM_BACKGROUND_SERVER_TOKEN: OnceLock<String> = OnceLock::new();
static CUSTOM_BACKGROUND_SERVER_INIT_LOCK: OnceLock<std::sync::Mutex<()>> = OnceLock::new();
static CUSTOM_BACKGROUND_IMPORT_LOCK: OnceLock<std::sync::Mutex<()>> = OnceLock::new();

#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x08000000;

/// The selected logical corner radius for the primary native window.
///
/// CSS can round the webview contents, but it cannot remove the rectangular
/// Win32 window that hosts those contents. Keep the value in Rust as well so
/// the native clipping region can be rebuilt after resizing or moving between
/// displays with a different DPI scale.
#[derive(Default)]
struct WindowCornerRadiusState {
    radius: std::sync::Mutex<u32>,
    reapply_generation: std::sync::atomic::AtomicU64,
}
const MAX_WINDOW_CORNER_RADIUS: u32 = 32;

const MAIN_WINDOW_MIN_WIDTH: f64 = 720.0;
const MAIN_WINDOW_MIN_HEIGHT: f64 = 480.0;
const MAIN_WINDOW_MAX_WIDTH: f64 = 1400.0;
const MAIN_WINDOW_MAX_HEIGHT: f64 = 900.0;
const MAIN_WINDOW_SAFE_MARGIN: f64 = 32.0;

#[derive(Clone, serde::Serialize)]
struct ScreenPickerBounds {
    x: i32,
    y: i32,
    width: u32,
    height: u32,
}

#[derive(Clone, serde::Serialize)]
struct ScreenColorSample {
    x: i32,
    y: i32,
    width: u32,
    height: u32,
    pixels: Vec<u8>,
    hex: String,
    rgb: String,
}

const DEFAULT_SCREEN_PICKER_SHORTCUT: &str = "Ctrl+Shift+C";

#[derive(Clone, serde::Serialize, serde::Deserialize)]
struct ScreenPickerShortcutConfig {
    shortcut: Option<String>,
}

impl Default for ScreenPickerShortcutConfig {
    fn default() -> Self {
        Self {
            shortcut: Some(DEFAULT_SCREEN_PICKER_SHORTCUT.to_string()),
        }
    }
}

#[derive(serde::Serialize)]
struct ScreenPickerShortcutInfo {
    value: String,
    default: String,
    enabled: bool,
}

fn screen_picker_shortcut_path() -> Result<std::path::PathBuf, String> {
    Ok(toolknit_app_data_dir()?.join("screen-picker-shortcut.json"))
}

fn load_screen_picker_shortcut_config() -> ScreenPickerShortcutConfig {
    let path = match screen_picker_shortcut_path() {
        Ok(path) => path,
        Err(_) => return ScreenPickerShortcutConfig::default(),
    };
    match std::fs::read_to_string(path) {
        Ok(content) => {
            serde_json::from_str::<ScreenPickerShortcutConfig>(&content).unwrap_or_default()
        }
        Err(_) => ScreenPickerShortcutConfig::default(),
    }
}

fn save_screen_picker_shortcut_config(config: &ScreenPickerShortcutConfig) -> Result<(), String> {
    let path = screen_picker_shortcut_path()?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    let bytes = serde_json::to_vec_pretty(config).map_err(|error| error.to_string())?;
    std::fs::write(path, bytes).map_err(|error| error.to_string())
}

fn register_screen_picker_shortcut(
    app: &tauri::AppHandle,
    shortcut_str: &str,
) -> Result<(), String> {
    match shortcut_str.parse::<Shortcut>() {
        Ok(_) => {}
        Err(error) => return Err(error.to_string()),
    }
    app.global_shortcut()
        .unregister_all()
        .map_err(|error| error.to_string())?;
    app.global_shortcut()
        .on_shortcut(shortcut_str, |app, _shortcut, event| {
            if event.state == ShortcutState::Pressed {
                let app = app.clone();
                tauri::async_runtime::spawn(async move {
                    let _ = open_screen_color_picker(app).await;
                });
            }
        })
        .map_err(|error| error.to_string())
}

#[cfg(all(target_os = "windows", debug_assertions))]
fn append_picker_debug(line: &str) {
    use std::io::Write;
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or(0);
    let path = std::env::temp_dir().join("toolknit-screen-picker-debug.log");
    if let Ok(mut file) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
    {
        let _ = writeln!(file, "[{}] {}", stamp, line);
    }
}

#[cfg(any(not(target_os = "windows"), not(debug_assertions)))]
fn append_picker_debug(_line: &str) {}

#[cfg(target_os = "windows")]
fn screen_picker_bounds_impl() -> Result<ScreenPickerBounds, String> {
    use windows::Win32::UI::WindowsAndMessaging::{
        GetSystemMetrics, SM_CXVIRTUALSCREEN, SM_CYVIRTUALSCREEN, SM_XVIRTUALSCREEN,
        SM_YVIRTUALSCREEN,
    };

    let x = unsafe { GetSystemMetrics(SM_XVIRTUALSCREEN) };
    let y = unsafe { GetSystemMetrics(SM_YVIRTUALSCREEN) };
    let width = unsafe { GetSystemMetrics(SM_CXVIRTUALSCREEN) };
    let height = unsafe { GetSystemMetrics(SM_CYVIRTUALSCREEN) };
    append_picker_debug(&format!("bounds x={x} y={y} w={width} h={height}"));
    if width <= 0 || height <= 0 {
        return Err("无法读取 Windows 虚拟桌面尺寸".to_string());
    }
    Ok(ScreenPickerBounds {
        x,
        y,
        width: width as u32,
        height: height as u32,
    })
}

#[cfg(not(target_os = "windows"))]
fn screen_picker_bounds_impl() -> Result<ScreenPickerBounds, String> {
    Err("屏幕取色目前仅支持 Windows".to_string())
}

#[cfg(target_os = "windows")]
fn screen_color_sample_impl(x: i32, y: i32) -> Result<ScreenColorSample, String> {
    use windows::Win32::{
        Foundation::HWND,
        Graphics::Gdi::{
            BitBlt, CreateCompatibleBitmap, CreateCompatibleDC, DeleteDC, DeleteObject, GetDC,
            GetDIBits, ReleaseDC, SelectObject, BITMAPINFO, BITMAPINFOHEADER, DIB_RGB_COLORS,
            SRCCOPY,
        },
    };

    const GRID_SIZE: i32 = 21;
    const HALF_GRID: i32 = GRID_SIZE / 2;

    let screen_dc = unsafe { GetDC(HWND::default()) };
    if screen_dc.0 == 0 {
        return Err("无法读取桌面屏幕像素".to_string());
    }

    let mem_dc = unsafe { CreateCompatibleDC(screen_dc) };
    if mem_dc.0 == 0 {
        unsafe { ReleaseDC(HWND::default(), screen_dc) };
        return Err("无法创建内存设备上下文".to_string());
    }

    let bitmap = unsafe { CreateCompatibleBitmap(screen_dc, GRID_SIZE, GRID_SIZE) };
    if bitmap.0 == 0 {
        unsafe {
            DeleteDC(mem_dc);
            ReleaseDC(HWND::default(), screen_dc);
        }
        return Err("无法创建取色位图".to_string());
    }

    let previous = unsafe { SelectObject(mem_dc, bitmap) };

    let blit_result = unsafe {
        BitBlt(
            mem_dc,
            0,
            0,
            GRID_SIZE,
            GRID_SIZE,
            screen_dc,
            x - HALF_GRID,
            y - HALF_GRID,
            SRCCOPY,
        )
    };

    if blit_result.is_err() {
        unsafe {
            SelectObject(mem_dc, previous);
            DeleteObject(bitmap);
            DeleteDC(mem_dc);
            ReleaseDC(HWND::default(), screen_dc);
        }
        return Err("屏幕区域复制失败".to_string());
    }

    // Read back as 32-bpp BGRA, top-down, so the byte order is predictable.
    let mut bmi = BITMAPINFO {
        bmiHeader: BITMAPINFOHEADER {
            biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
            biWidth: GRID_SIZE,
            biHeight: -GRID_SIZE,
            biPlanes: 1,
            biBitCount: 32,
            biCompression: 0,
            ..Default::default()
        },
        bmiColors: [Default::default(); 1],
    };
    let mut bgra = vec![0_u8; (GRID_SIZE * GRID_SIZE * 4) as usize];
    let copied_lines = unsafe {
        GetDIBits(
            mem_dc,
            bitmap,
            0,
            GRID_SIZE as u32,
            Some(bgra.as_mut_ptr() as *mut _),
            &mut bmi,
            DIB_RGB_COLORS,
        )
    };

    unsafe {
        SelectObject(mem_dc, previous);
        DeleteObject(bitmap);
        DeleteDC(mem_dc);
        ReleaseDC(HWND::default(), screen_dc);
    }

    if copied_lines == 0 {
        return Err("无法读取取色像素数据".to_string());
    }

    let mut pixels = Vec::with_capacity((GRID_SIZE * GRID_SIZE * 3) as usize);
    let center_index = (HALF_GRID * GRID_SIZE + HALF_GRID) as usize;
    let mut center = [0_u8; 3];
    for index in 0..(GRID_SIZE * GRID_SIZE) as usize {
        let b = bgra[index * 4];
        let g = bgra[index * 4 + 1];
        let r = bgra[index * 4 + 2];
        if index == center_index {
            center = [r, g, b];
        }
        pixels.extend_from_slice(&[r, g, b]);
    }

    Ok(ScreenColorSample {
        x,
        y,
        width: GRID_SIZE as u32,
        height: GRID_SIZE as u32,
        pixels,
        hex: format!("#{:02X}{:02X}{:02X}", center[0], center[1], center[2]),
        rgb: format!("rgb({}, {}, {})", center[0], center[1], center[2]),
    })
}

#[cfg(not(target_os = "windows"))]
fn screen_color_sample_impl(_x: i32, _y: i32) -> Result<ScreenColorSample, String> {
    Err("屏幕取色目前仅支持 Windows".to_string())
}

#[tauri::command]
fn screen_picker_bounds() -> Result<ScreenPickerBounds, String> {
    screen_picker_bounds_impl()
}

#[tauri::command]
fn screen_color_sample(x: i32, y: i32) -> Result<ScreenColorSample, String> {
    screen_color_sample_impl(x, y)
}

#[tauri::command]
async fn open_screen_color_picker(app: tauri::AppHandle) -> Result<ScreenPickerBounds, String> {
    minimize_main_window(&app);
    match launch_screen_color_picker(&app).await {
        Ok(bounds) => Ok(bounds),
        Err(error) => {
            // Creating a second WebView can fail because of an unavailable
            // display, a damaged WebView2 runtime, or a transient GPU error.
            // Never leave the only application window minimized in that case.
            show_main_window(&app);
            Err(error)
        }
    }
}

async fn launch_screen_color_picker(app: &tauri::AppHandle) -> Result<ScreenPickerBounds, String> {
    let bounds = screen_picker_bounds_impl()?;
    append_picker_debug(&format!(
        "open_screen_color_picker enter, bounds={},{},{}x{}",
        bounds.x, bounds.y, bounds.width, bounds.height
    ));
    if let Some(window) = app.get_webview_window("color-picker-overlay") {
        append_picker_debug("overlay window already exists, reusing");
        window
            .set_position(Position::Physical(PhysicalPosition::new(
                bounds.x, bounds.y,
            )))
            .map_err(|error| error.to_string())?;
        window
            .set_size(Size::Physical(PhysicalSize::new(
                bounds.width,
                bounds.height,
            )))
            .map_err(|error| error.to_string())?;
        window.show().map_err(|error| error.to_string())?;
        append_picker_debug("overlay window show() ok");
        window.set_focus().map_err(|error| error.to_string())?;
        // The overlay window is intentionally reused between picks. Notify its
        // renderer so a previous sampling loop is restarted after the window
        // has been hidden and shown again.
        let _ = window.emit("screen-picker-opened", &bounds);
        return Ok(bounds);
    }

    append_picker_debug("overlay window does not exist, building new window");
    let mut builder = WebviewWindowBuilder::new(
        app,
        "color-picker-overlay",
        WebviewUrl::App("index.html?screen-picker=1".into()),
    )
    .title("ToolKnit Screen Picker")
    .decorations(false)
    .transparent(true)
    .always_on_top(true)
    .visible_on_all_workspaces(true)
    .skip_taskbar(true)
    .shadow(false)
    .resizable(false)
    .devtools(false)
    .focused(true)
    .on_page_load(|_window, payload| {
        append_picker_debug(&format!("overlay webview page loaded: {}", payload.url()));
    });

    // WebView2 on Windows cannot reliably share one user-data directory between
    // the main webview and a second window created at runtime; attempting to do
    // so fails with HRESULT 0x8007139F (ERROR_GROUP_OR_RESOURCE_NOT_IN_CORRECT_STATE)
    // and the overlay webview never initializes. Give the picker its own data
    // directory so the two WebView2 environments stay isolated.
    #[cfg(target_os = "windows")]
    {
        let picker_data_dir = app
            .path()
            .app_config_dir()
            .map(|dir| dir.join("screen-picker-webview"))
            .unwrap_or_else(|_| std::env::temp_dir().join("toolknit-screen-picker-webview"));
        append_picker_debug(&format!(
            "overlay webview data_directory={}",
            picker_data_dir.display()
        ));
        builder = builder.data_directory(picker_data_dir);
    }

    let window = builder.build().map_err(|error| error.to_string())?;

    append_picker_debug("overlay window built ok");
    window
        .set_position(Position::Physical(PhysicalPosition::new(bounds.x, bounds.y)))
        .map_err(|error| error.to_string())?;
    window
        .set_size(Size::Physical(PhysicalSize::new(bounds.width, bounds.height)))
        .map_err(|error| error.to_string())?;
    window.show().map_err(|error| error.to_string())?;
    append_picker_debug("overlay window show() ok");
    window.set_focus().map_err(|error| error.to_string())?;
    append_picker_debug("overlay window focus() ok");
    let visible = window.is_visible().unwrap_or(false);
    let size = window.outer_size().map(|s| format!("{}x{}", s.width, s.height)).unwrap_or_else(|e| e.to_string());
    let pos = window.outer_position().map(|p| format!("{},{}", p.x, p.y)).unwrap_or_else(|e| e.to_string());
    append_picker_debug(&format!("overlay window after show: visible={visible} size={size} pos={pos}"));
    let window_for_later = window.clone();
    tauri::async_runtime::spawn(async move {
        for delay_ms in [500_u64, 1500, 3000] {
            tokio::time::sleep(std::time::Duration::from_millis(delay_ms)).await;
            let visible = window_for_later.is_visible().unwrap_or(false);
            let size = window_for_later.outer_size().map(|s| format!("{}x{}", s.width, s.height)).unwrap_or_else(|e| e.to_string());
            let pos = window_for_later.outer_position().map(|p| format!("{},{}", p.x, p.y)).unwrap_or_else(|e| e.to_string());
            append_picker_debug(&format!("overlay delayed check @{delay_ms}ms: visible={visible} size={size} pos={pos}"));
        }
    });
    Ok(bounds)
}

#[tauri::command]
fn close_screen_color_picker(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("color-picker-overlay") {
        window.hide().map_err(|error| error.to_string())?;
    }
    show_main_window(&app);
    Ok(())
}

#[tauri::command]
fn get_screen_picker_shortcut() -> Result<ScreenPickerShortcutInfo, String> {
    let config = load_screen_picker_shortcut_config();
    let default = ScreenPickerShortcutConfig::default()
        .shortcut
        .unwrap_or_default();
    Ok(ScreenPickerShortcutInfo {
        value: config.shortcut.clone().unwrap_or_default(),
        default,
        enabled: config.shortcut.is_some(),
    })
}

#[tauri::command]
fn set_screen_picker_shortcut(
    app: tauri::AppHandle,
    shortcut: Option<String>,
) -> Result<ScreenPickerShortcutInfo, String> {
    let mut config = load_screen_picker_shortcut_config();
    let value = shortcut.unwrap_or_default().trim().to_string();
    if value.is_empty() {
        config.shortcut = None;
        app.global_shortcut()
            .unregister_all()
            .map_err(|error| error.to_string())?;
    } else {
        register_screen_picker_shortcut(&app, &value)?;
        config.shortcut = Some(value);
    }
    save_screen_picker_shortcut_config(&config)?;
    let default = ScreenPickerShortcutConfig::default()
        .shortcut
        .unwrap_or_default();
    let enabled = config.shortcut.is_some();
    Ok(ScreenPickerShortcutInfo {
        value: config.shortcut.unwrap_or_default(),
        default,
        enabled,
    })
}

#[cfg(test)]
static TEST_CONVERSION_LOCK: OnceLock<std::sync::Mutex<()>> = OnceLock::new();

#[cfg(test)]
fn test_conversion_lock() -> std::sync::MutexGuard<'static, ()> {
    TEST_CONVERSION_LOCK
        .get_or_init(|| std::sync::Mutex::new(()))
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

// Tauri's build script embeds this compatibility manifest into application
// binaries. Cargo's lib unit-test harness needs to link it independently.
#[cfg(all(test, windows))]
#[link(name = "resource", kind = "static")]
extern "C" {}

/// Read the installer language at startup (from install_lang.txt).
/// Returns "zh" or "en", defaulting to "zh" on any error.
fn read_initial_lang() -> String {
    let exe = match std::env::current_exe() {
        Ok(e) => e,
        Err(_) => return "zh".to_string(),
    };
    let dir = match exe.parent() {
        Some(d) => d,
        None => return "zh".to_string(),
    };
    let lang_file = dir.join("install_lang.txt");
    match std::fs::read_to_string(&lang_file) {
        Ok(content) => match content.trim().parse::<u32>() {
            Ok(2052) => "zh".to_string(),
            _ => "en".to_string(),
        },
        Err(_) => "zh".to_string(),
    }
}

/// Build the tray menu with labels in the given language.
fn build_tray_menu(
    app: &tauri::AppHandle,
    lang: &str,
) -> Result<tauri::menu::Menu<tauri::Wry>, tauri::Error> {
    let (show_text, quit_text) = if lang == "zh" {
        (
            "\u{663e}\u{793a}\u{4e3b}\u{7a0b}\u{5e8f}",
            "\u{9000}\u{51fa} ToolKnit",
        )
    } else {
        ("Show ToolKnit", "Quit ToolKnit")
    };
    let show_i = tauri::menu::MenuItem::with_id(app, "show", show_text, true, None::<&str>)?;
    let quit_i = tauri::menu::MenuItem::with_id(app, "quit", quit_text, true, None::<&str>)?;
    tauri::menu::Menu::with_items(app, &[&show_i, &quit_i])
}

#[tauri::command]
fn set_tray_lang(app: tauri::AppHandle, lang: String) -> Result<(), String> {
    let menu = build_tray_menu(&app, &lang).map_err(|e| e.to_string())?;
    if let Some(tray) = app.tray_by_id("main-tray") {
        tray.set_menu(Some(menu)).map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Clears the legacy binary Win32 clipping region before the webview applies
/// its alpha-antialiased CSS window mask. GDI regions contain only fully on or
/// fully off pixels, which makes rounded corners visibly stair-step.
#[cfg(target_os = "windows")]
fn apply_native_window_corner_radius(
    window: &tauri::WebviewWindow,
    _logical_radius: u32,
) -> Result<(), String> {
    use windows::Win32::{
        Foundation::{BOOL, HWND},
        Graphics::Gdi::{SetWindowRgn, HRGN},
    };

    let tauri_hwnd = window.hwnd().map_err(|error| error.to_string())?;
    let hwnd = HWND(tauri_hwnd.0 as isize);
    let result = unsafe { SetWindowRgn(hwnd, HRGN::default(), BOOL(1)) };
    if result == 0 {
        return Err(format!(
            "Unable to clear the native window clipping region: {}",
            std::io::Error::last_os_error()
        ));
    }
    Ok(())
}

#[cfg(not(target_os = "windows"))]
fn apply_native_window_corner_radius(
    _window: &tauri::WebviewWindow,
    _logical_radius: u32,
) -> Result<(), String> {
    // Keep the command available on other desktop platforms. Their native
    // window systems either supply their own rounded corners or use CSS only.
    Ok(())
}

#[tauri::command]
fn set_window_corner_radius(
    window: tauri::WebviewWindow,
    radius: u32,
    state: tauri::State<'_, WindowCornerRadiusState>,
) -> Result<(), String> {
    // The configured radius belongs to the primary application window. In
    // particular, the full-screen screen picker must stay rectangular so it
    // can cover the whole virtual desktop and receive pointer input at every
    // edge.
    if window.label() != "main" {
        return Ok(());
    }
    let radius = radius.min(MAX_WINDOW_CORNER_RADIUS);
    let mut stored_radius = state
        .radius
        .lock()
        .map_err(|_| "Window corner radius state is unavailable".to_string())?;

    // Hold the state lock while applying so a resize cannot briefly rebuild a
    // stale region after the user has chosen a new radius.
    apply_native_window_corner_radius(&window, radius)?;
    *stored_radius = radius;
    Ok(())
}

fn reapply_native_window_corner_radius(window: &tauri::WebviewWindow) {
    let state = window.state::<WindowCornerRadiusState>();
    let radius = match state.radius.lock() {
        Ok(radius) => *radius,
        Err(_) => return,
    };
    if radius > 0 {
        // Window resize notifications cannot be surfaced to the user. The next
        // setting change will still report an error if the native API fails.
        let _ = apply_native_window_corner_radius(window, radius);
    }
}

fn schedule_native_window_corner_radius_reapply(window: tauri::WebviewWindow) {
    reapply_native_window_corner_radius(&window);

    // Resizing emits a stream of native events. Keep the corner region current
    // immediately, then do one trailing repair after Windows has settled.
    // Older generations become no-ops, so a drag cannot accumulate hundreds
    // of delayed GDI updates in the background.
    let state = window.state::<WindowCornerRadiusState>();
    let generation = state
        .reapply_generation
        .fetch_add(1, std::sync::atomic::Ordering::Relaxed)
        .saturating_add(1);
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(std::time::Duration::from_millis(180)).await;
        let state = window.state::<WindowCornerRadiusState>();
        if state
            .reapply_generation
            .load(std::sync::atomic::Ordering::Relaxed)
            == generation
        {
            reapply_native_window_corner_radius(&window);
        }
    });
}

/// Fit the first window to the monitor work area rather than assuming the
/// developer's screen. The values are logical pixels, so Windows DPI scaling
/// is accounted for before the native minimum size is applied.
fn fit_main_window_to_work_area(window: &tauri::WebviewWindow) -> Result<(), String> {
    let monitor = window
        .current_monitor()
        .map_err(|error| error.to_string())?
        .or(
            window
                .primary_monitor()
                .map_err(|error| error.to_string())?,
        );
    let Some(monitor) = monitor else {
        return Ok(());
    };

    let scale_factor = monitor.scale_factor().max(0.1);
    let work_area = monitor.work_area().size;
    let usable_width = ((work_area.width as f64 / scale_factor) - MAIN_WINDOW_SAFE_MARGIN).max(480.0);
    let usable_height = ((work_area.height as f64 / scale_factor) - MAIN_WINDOW_SAFE_MARGIN).max(360.0);
    let min_width = MAIN_WINDOW_MIN_WIDTH.min(usable_width).max(480.0);
    let min_height = MAIN_WINDOW_MIN_HEIGHT.min(usable_height).max(360.0);
    let max_width = MAIN_WINDOW_MAX_WIDTH.min(usable_width).max(min_width);
    let max_height = MAIN_WINDOW_MAX_HEIGHT.min(usable_height).max(min_height);
    let width = (usable_width * 0.84).round().clamp(min_width, max_width);
    let height = (usable_height * 0.88).round().clamp(min_height, max_height);

    window
        .set_min_size(Some(Size::Logical(LogicalSize::new(min_width, min_height))))
        .map_err(|error| error.to_string())?;
    window
        .set_max_size(None::<Size>)
        .map_err(|error| error.to_string())?;
    window
        .set_size(Size::Logical(LogicalSize::new(width, height)))
        .map_err(|error| error.to_string())?;
    window.center().map_err(|error| error.to_string())?;
    Ok(())
}

fn validate_external_url(url: &str) -> Result<url::Url, String> {
    platform::security::validate_external_url(url)
}

fn allow_webview_navigation(url: &url::Url) -> bool {
    platform::security::allow_webview_navigation(url)
}

#[tauri::command]
fn open_url(url: String) -> Result<(), String> {
    let parsed = validate_external_url(&url)?;
    opener::open(parsed.as_str()).map_err(|error| format!("Failed to open URL: {}", error))
}

#[tauri::command]
fn get_documents_dir() -> Result<String, String> {
    let dir = dirs::document_dir().ok_or("Cannot find Documents folder")?;
    Ok(dir.to_string_lossy().to_string())
}

#[tauri::command]
fn get_download_dir() -> Result<String, String> {
    let dir = dirs::download_dir().ok_or("Cannot find Downloads folder")?;
    Ok(dir.to_string_lossy().to_string())
}

#[derive(serde::Serialize, serde::Deserialize, Default)]
struct OutputRootConfig {
    output_root: Option<String>,
}

fn toolknit_app_data_dir() -> Result<std::path::PathBuf, String> {
    Ok(dirs::data_dir()
        .ok_or("Cannot find AppData folder")?
        .join("ToolKnit"))
}

const AI_API_KEY_FILE_NAME: &str = "ai-api-key.dpapi";
const AI_API_KEY_FILE_HEADER: &[u8] = b"TKDPAPI1";
const AI_API_KEY_MAX_BYTES: usize = 8 * 1024;
const AI_API_KEY_FILE_MAX_BYTES: u64 = 64 * 1024;

fn ai_api_key_path() -> Result<std::path::PathBuf, String> {
    Ok(toolknit_app_data_dir()?.join(AI_API_KEY_FILE_NAME))
}

fn validate_ai_api_key(api_key: &str) -> Result<(), String> {
    if api_key.is_empty()
        || api_key.len() > AI_API_KEY_MAX_BYTES
        || api_key.chars().any(char::is_control)
    {
        return Err("ai-api-key:invalid".to_string());
    }
    Ok(())
}

#[cfg(target_os = "windows")]
fn protect_ai_api_key_bytes(plaintext: &mut [u8]) -> Result<Vec<u8>, String> {
    use windows::core::PCWSTR;
    use windows::Win32::Foundation::{LocalFree, HLOCAL};
    use windows::Win32::Security::Cryptography::{
        CryptProtectData, CRYPT_INTEGER_BLOB, CRYPTPROTECT_UI_FORBIDDEN,
    };

    let input_length = u32::try_from(plaintext.len()).map_err(|_| "ai-api-key:invalid")?;
    let input = CRYPT_INTEGER_BLOB {
        cbData: input_length,
        pbData: plaintext.as_mut_ptr(),
    };
    let mut output = CRYPT_INTEGER_BLOB::default();
    unsafe {
        CryptProtectData(
            &input,
            PCWSTR::null(),
            None,
            None,
            None,
            CRYPTPROTECT_UI_FORBIDDEN,
            &mut output,
        )
        .map_err(|_| "ai-api-key:protect-failed".to_string())?;
        if output.pbData.is_null() || output.cbData == 0 {
            return Err("ai-api-key:protect-failed".to_string());
        }
        let protected = std::slice::from_raw_parts(output.pbData, output.cbData as usize).to_vec();
        let _ = LocalFree(HLOCAL(output.pbData.cast()));
        Ok(protected)
    }
}

#[cfg(target_os = "windows")]
fn unprotect_ai_api_key_bytes(protected: &mut [u8]) -> Result<Vec<u8>, String> {
    use windows::Win32::Foundation::{LocalFree, HLOCAL};
    use windows::Win32::Security::Cryptography::{
        CryptUnprotectData, CRYPT_INTEGER_BLOB, CRYPTPROTECT_UI_FORBIDDEN,
    };

    let input_length = u32::try_from(protected.len()).map_err(|_| "ai-api-key:invalid")?;
    let input = CRYPT_INTEGER_BLOB {
        cbData: input_length,
        pbData: protected.as_mut_ptr(),
    };
    let mut output = CRYPT_INTEGER_BLOB::default();
    unsafe {
        CryptUnprotectData(
            &input,
            None,
            None,
            None,
            None,
            CRYPTPROTECT_UI_FORBIDDEN,
            &mut output,
        )
        .map_err(|_| "ai-api-key:unprotect-failed".to_string())?;
        if output.pbData.is_null() || output.cbData == 0 {
            return Err("ai-api-key:unprotect-failed".to_string());
        }
        let plaintext = std::slice::from_raw_parts(output.pbData, output.cbData as usize).to_vec();
        let _ = LocalFree(HLOCAL(output.pbData.cast()));
        Ok(plaintext)
    }
}

#[cfg(target_os = "windows")]
fn replace_ai_api_key_file(
    temporary_path: &std::path::Path,
    destination_path: &std::path::Path,
) -> Result<(), String> {
    use std::os::windows::ffi::OsStrExt;
    use windows::core::PCWSTR;
    use windows::Win32::Storage::FileSystem::{
        MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
    };

    let temporary_wide = temporary_path
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    let destination_wide = destination_path
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    unsafe {
        MoveFileExW(
            PCWSTR(temporary_wide.as_ptr()),
            PCWSTR(destination_wide.as_ptr()),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
        .map_err(|_| "ai-api-key:write-failed".to_string())
    }
}

#[tauri::command]
fn store_ai_api_key(mut api_key: String) -> Result<(), String> {
    use std::io::Write;
    use zeroize::Zeroize;

    let normalized = api_key.trim().to_string();
    api_key.zeroize();
    validate_ai_api_key(&normalized)?;

    let mut plaintext = normalized.into_bytes();
    let protected_result = protect_ai_api_key_bytes(&mut plaintext);
    plaintext.zeroize();
    let mut protected = protected_result?;

    let destination_path = ai_api_key_path()?;
    let parent = destination_path
        .parent()
        .ok_or_else(|| "ai-api-key:write-failed".to_string())?;
    std::fs::create_dir_all(parent).map_err(|_| "ai-api-key:write-failed".to_string())?;
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or(0);
    let temporary_path = parent.join(format!(
        ".ai-api-key-{}-{}.tmp",
        std::process::id(),
        stamp
    ));
    let write_result = (|| -> Result<(), String> {
        let mut output = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary_path)
            .map_err(|_| "ai-api-key:write-failed".to_string())?;
        output
            .write_all(AI_API_KEY_FILE_HEADER)
            .and_then(|_| output.write_all(&protected))
            .and_then(|_| output.sync_all())
            .map_err(|_| "ai-api-key:write-failed".to_string())?;
        replace_ai_api_key_file(&temporary_path, &destination_path)
    })();
    protected.zeroize();
    if write_result.is_err() {
        let _ = std::fs::remove_file(&temporary_path);
    }
    write_result
}

#[tauri::command]
fn load_ai_api_key() -> Result<Option<String>, String> {
    use zeroize::Zeroize;

    let path = ai_api_key_path()?;
    let metadata = match std::fs::metadata(&path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err("ai-api-key:read-failed".to_string()),
    };
    if !metadata.is_file() || metadata.len() > AI_API_KEY_FILE_MAX_BYTES {
        return Err("ai-api-key:invalid-storage".to_string());
    }
    let mut stored = std::fs::read(&path).map_err(|_| "ai-api-key:read-failed".to_string())?;
    if !stored.starts_with(AI_API_KEY_FILE_HEADER) || stored.len() == AI_API_KEY_FILE_HEADER.len() {
        stored.zeroize();
        return Err("ai-api-key:invalid-storage".to_string());
    }
    let mut protected = stored.split_off(AI_API_KEY_FILE_HEADER.len());
    stored.zeroize();
    let plaintext_result = unprotect_ai_api_key_bytes(&mut protected);
    protected.zeroize();
    let mut plaintext = plaintext_result?;
    let key_result = std::str::from_utf8(&plaintext)
        .map(str::to_owned)
        .map_err(|_| "ai-api-key:invalid-storage".to_string());
    plaintext.zeroize();
    let key = key_result?;
    validate_ai_api_key(&key)?;
    Ok(Some(key))
}

#[tauri::command]
fn clear_ai_api_key() -> Result<(), String> {
    match std::fs::remove_file(ai_api_key_path()?) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(_) => Err("ai-api-key:clear-failed".to_string()),
    }
}

#[cfg(all(test, target_os = "windows"))]
mod ai_api_key_storage_tests {
    use super::*;
    use zeroize::Zeroize;

    #[test]
    fn dpapi_round_trip_is_bound_to_the_current_windows_user() {
        let mut plaintext = b"toolknit-test-api-key".to_vec();
        let mut protected = protect_ai_api_key_bytes(&mut plaintext).unwrap();
        assert_ne!(protected, plaintext);
        let mut restored = unprotect_ai_api_key_bytes(&mut protected).unwrap();
        assert_eq!(restored, plaintext);
        plaintext.zeroize();
        protected.zeroize();
        restored.zeroize();
    }
}

const CUSTOM_FONT_DIRECTORY: &str = "custom-fonts";
const CUSTOM_FONT_MAX_BYTES: u64 = 40 * 1024 * 1024;
const CUSTOM_FONT_SLOTS: [&str; 4] = ["cn-medium", "cn-bold", "en-regular", "en-bold"];
const CUSTOM_FONT_EXTENSIONS: [&str; 4] = ["ttf", "otf", "woff", "woff2"];

#[derive(serde::Serialize)]
struct CustomFontAsset {
    slot: String,
    path: String,
    file_name: String,
}

fn custom_font_dir() -> Result<std::path::PathBuf, String> {
    Ok(toolknit_app_data_dir()?.join(CUSTOM_FONT_DIRECTORY))
}

fn normalized_custom_font_slot(slot: &str) -> Result<&'static str, String> {
    let value = slot.trim().to_ascii_lowercase();
    CUSTOM_FONT_SLOTS
        .iter()
        .copied()
        .find(|candidate| *candidate == value)
        .ok_or("Unknown custom font slot".to_string())
}

fn normalized_custom_font_extension(path: &std::path::Path) -> Result<String, String> {
    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .map(|value| value.to_ascii_lowercase())
        .ok_or("Font file must use a supported extension".to_string())?;
    if CUSTOM_FONT_EXTENSIONS.contains(&extension.as_str()) {
        Ok(extension)
    } else {
        Err("Font file must be TTF, OTF, WOFF, or WOFF2".to_string())
    }
}

fn custom_font_slot_path(slot: &str, extension: &str) -> Result<std::path::PathBuf, String> {
    let normalized_slot = normalized_custom_font_slot(slot)?;
    if !CUSTOM_FONT_EXTENSIONS.contains(&extension) {
        return Err("Unsupported custom font extension".to_string());
    }
    Ok(custom_font_dir()?.join(format!("{}.{}", normalized_slot, extension)))
}

fn existing_custom_font_path(slot: &str) -> Result<Option<std::path::PathBuf>, String> {
    let normalized_slot = normalized_custom_font_slot(slot)?;
    let directory = custom_font_dir()?;
    for extension in CUSTOM_FONT_EXTENSIONS {
        let candidate = directory.join(format!("{}.{}", normalized_slot, extension));
        if candidate.is_file() {
            return Ok(Some(candidate));
        }
    }
    Ok(None)
}

fn remove_custom_font_slot_files(slot: &str) -> Result<(), String> {
    let normalized_slot = normalized_custom_font_slot(slot)?;
    let directory = custom_font_dir()?;
    for extension in CUSTOM_FONT_EXTENSIONS {
        let candidate = directory.join(format!("{}.{}", normalized_slot, extension));
        if candidate.exists() {
            std::fs::remove_file(&candidate)
                .map_err(|error| format!("Cannot remove custom font: {}", error))?;
        }
    }
    Ok(())
}

fn custom_font_magic_is_valid(extension: &str, header: &[u8]) -> bool {
    match extension {
        "ttf" => header.starts_with(&[0x00, 0x01, 0x00, 0x00]) || header.starts_with(b"true"),
        "otf" => header.starts_with(b"OTTO"),
        "woff" => header.starts_with(b"wOFF"),
        "woff2" => header.starts_with(b"wOF2"),
        _ => false,
    }
}

fn validate_custom_font_source(source: &std::path::Path) -> Result<(std::path::PathBuf, String, u64), String> {
    let canonical = source
        .canonicalize()
        .map_err(|error| format!("Cannot read font file: {}", error))?;
    let metadata = std::fs::metadata(&canonical)
        .map_err(|error| format!("Cannot inspect font file: {}", error))?;
    if !metadata.is_file() || metadata.len() == 0 || metadata.len() > CUSTOM_FONT_MAX_BYTES {
        return Err("Font file must be a non-empty file no larger than 40 MB".to_string());
    }
    let extension = normalized_custom_font_extension(&canonical)?;
    let mut input = std::fs::File::open(&canonical)
        .map_err(|error| format!("Cannot open font file: {}", error))?;
    let mut header = [0_u8; 4];
    use std::io::Read;
    input
        .read_exact(&mut header)
        .map_err(|_| "Invalid font file".to_string())?;
    if !custom_font_magic_is_valid(&extension, &header) {
        return Err("Font data does not match its file extension".to_string());
    }
    Ok((canonical, extension, metadata.len()))
}

#[tauri::command]
fn list_custom_fonts() -> Result<Vec<CustomFontAsset>, String> {
    let directory = custom_font_dir()?;
    if !directory.exists() {
        return Ok(Vec::new());
    }
    let root = directory
        .canonicalize()
        .map_err(|error| format!("Cannot inspect custom font folder: {}", error))?;
    let mut assets = Vec::new();
    for slot in CUSTOM_FONT_SLOTS {
        let Some(path) = existing_custom_font_path(slot)? else {
            continue;
        };
        let canonical = path
            .canonicalize()
            .map_err(|error| format!("Cannot inspect custom font: {}", error))?;
        if !canonical.starts_with(&root) {
            return Err("Custom font path is not permitted".to_string());
        }
        let metadata = std::fs::metadata(&canonical)
            .map_err(|error| format!("Cannot inspect custom font: {}", error))?;
        if !metadata.is_file() || metadata.len() == 0 || metadata.len() > CUSTOM_FONT_MAX_BYTES {
            return Err("Installed custom font has an invalid size".to_string());
        }
        let extension = normalized_custom_font_extension(&canonical)?;
        let mut input = std::fs::File::open(&canonical)
            .map_err(|error| format!("Cannot open custom font: {}", error))?;
        let mut header = [0_u8; 4];
        use std::io::Read;
        input
            .read_exact(&mut header)
            .map_err(|_| "Invalid custom font".to_string())?;
        if !custom_font_magic_is_valid(&extension, &header) {
            return Err("Installed custom font is invalid".to_string());
        }
        assets.push(CustomFontAsset {
            slot: slot.to_string(),
            path: canonical.to_string_lossy().into_owned(),
            file_name: canonical
                .file_name()
                .and_then(|value| value.to_str())
                .unwrap_or(slot)
                .to_string(),
        });
    }
    Ok(assets)
}

#[tauri::command]
fn import_custom_font(slot: String, source_path: String) -> Result<CustomFontAsset, String> {
    if source_path.contains('\0') {
        return Err("Invalid font file".to_string());
    }
    let normalized_slot = normalized_custom_font_slot(&slot)?;
    let (source, extension, _) = validate_custom_font_source(std::path::Path::new(&source_path))?;
    let directory = custom_font_dir()?;
    std::fs::create_dir_all(&directory)
        .map_err(|error| format!("Cannot prepare custom font folder: {}", error))?;
    let target = custom_font_slot_path(normalized_slot, &extension)?;
    let temporary = directory.join(format!(".{}.part.{}", normalized_slot, extension));
    std::fs::copy(&source, &temporary)
        .map_err(|error| format!("Cannot copy custom font: {}", error))?;
    if let Err(error) = validate_custom_font_source(&temporary) {
        let _ = std::fs::remove_file(&temporary);
        return Err(error);
    }
    remove_custom_font_slot_files(normalized_slot)?;
    std::fs::rename(&temporary, &target)
        .map_err(|error| format!("Cannot apply custom font: {}", error))?;
    let canonical = target
        .canonicalize()
        .map_err(|error| format!("Cannot finalize custom font: {}", error))?;
    Ok(CustomFontAsset {
        slot: normalized_slot.to_string(),
        path: canonical.to_string_lossy().into_owned(),
        file_name: canonical
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or(normalized_slot)
            .to_string(),
    })
}

#[tauri::command]
fn reset_custom_font(slot: String) -> Result<(), String> {
    remove_custom_font_slot_files(&slot)
}

#[cfg(test)]
mod custom_font_tests {
    use super::*;

    #[test]
    fn custom_font_slots_are_a_closed_allowlist() {
        assert_eq!(normalized_custom_font_slot("cn-medium").unwrap(), "cn-medium");
        assert_eq!(normalized_custom_font_slot(" EN-BOLD ").unwrap(), "en-bold");
        assert!(normalized_custom_font_slot("../outside").is_err());
        assert!(normalized_custom_font_slot("cn-heavy").is_err());
    }

    #[test]
    fn custom_font_signatures_must_match_declared_format() {
        assert!(custom_font_magic_is_valid("ttf", &[0x00, 0x01, 0x00, 0x00]));
        assert!(custom_font_magic_is_valid("otf", b"OTTO"));
        assert!(custom_font_magic_is_valid("woff", b"wOFF"));
        assert!(custom_font_magic_is_valid("woff2", b"wOF2"));
        assert!(!custom_font_magic_is_valid("ttf", b"OTTO"));
        assert!(!custom_font_magic_is_valid("exe", b"MZ\0\0"));
    }
}

fn output_root_config_path() -> Result<std::path::PathBuf, String> {
    Ok(toolknit_app_data_dir()?.join("output-location.json"))
}

fn configured_output_root() -> Option<std::path::PathBuf> {
    let config_path = output_root_config_path().ok()?;
    let config = std::fs::read_to_string(config_path)
        .ok()
        .and_then(|content| serde_json::from_str::<OutputRootConfig>(&content).ok())?;
    config
        .output_root
        .and_then(|path| std::path::PathBuf::from(path).canonicalize().ok())
}

#[tauri::command]
fn get_output_root() -> Result<Option<String>, String> {
    Ok(configured_output_root().map(|path| cleanup_display_path(&path)))
}

#[tauri::command]
fn get_default_output_root() -> Result<String, String> {
    let downloads = dirs::download_dir()
        .or_else(dirs::document_dir)
        .ok_or("Cannot find a default output folder")?;
    let root = downloads.join("ToolKnit");
    std::fs::create_dir_all(&root)
        .map_err(|error| format!("Cannot create default output folder: {}", error))?;
    root.canonicalize()
        .map(|path| cleanup_display_path(&path))
        .map_err(|error| format!("Cannot access default output folder: {}", error))
}

#[tauri::command]
fn set_output_root(output_dir: Option<String>) -> Result<(), String> {
    let output_root = match output_dir {
        Some(path) if !path.trim().is_empty() => {
            if path.contains('\0') {
                return Err("Invalid output folder".to_string());
            }
            let canonical = std::path::PathBuf::from(path)
                .canonicalize()
                .map_err(|error| format!("Cannot access output folder: {}", error))?;
            if !canonical.is_dir() {
                return Err("Output location must be a folder".to_string());
            }
            Some(cleanup_display_path(&canonical))
        }
        _ => None,
    };

    let config_path = output_root_config_path()?;
    let parent = config_path.parent().ok_or("Invalid AppData folder")?;
    std::fs::create_dir_all(parent)
        .map_err(|error| format!("Cannot create settings folder: {}", error))?;
    let content = serde_json::to_vec(&OutputRootConfig { output_root })
        .map_err(|error| format!("Cannot save output location: {}", error))?;
    std::fs::write(config_path, content)
        .map_err(|error| format!("Cannot save output location: {}", error))
}

#[derive(serde::Serialize)]
struct CustomBackgroundAsset {
    path: String,
    media_type: String,
}

#[derive(Clone, serde::Serialize)]
struct LargeFileCandidate {
    id: String,
    path: String,
    name: String,
    extension: String,
    category: String,
    size_bytes: u64,
    modified_at: Option<i64>,
    folder_hint: String,
    risk: String,
    local_reason: String,
}

#[derive(serde::Serialize)]
struct LargeFileScanResult {
    root_path: String,
    min_size_bytes: u64,
    mode: String,
    scanned_files: u64,
    skipped_dirs: u64,
    drive_space: Option<CleanupDriveSpace>,
    candidates: Vec<LargeFileCandidate>,
}

#[derive(Clone, serde::Deserialize, serde::Serialize)]
struct CleanupDriveSpace {
    drive: String,
    free_bytes: u64,
    total_bytes: u64,
}

#[derive(serde::Serialize)]
struct RecycleBinMoveItem {
    path: String,
    ok: bool,
    error: Option<String>,
}

#[derive(serde::Serialize)]
struct RecycleBinMoveResult {
    requested: usize,
    moved: usize,
    failed: usize,
    freed_bytes: u64,
    items: Vec<RecycleBinMoveItem>,
}

fn custom_background_dir(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|path| path.join("custom-background"))
        .map_err(|error| format!("Cannot find application data folder: {}", error))
}

fn custom_background_media_type(extension: &str) -> Option<&'static str> {
    match extension.to_ascii_lowercase().as_str() {
        "png" | "jpg" | "jpeg" | "webp" | "gif" | "bmp" => Some("image"),
        "mp4" | "webm" | "ogv" | "ogg" | "mov" => Some("video"),
        _ => None,
    }
}

#[tauri::command]
async fn import_custom_background(
    app: tauri::AppHandle,
    source_path: String,
    job_id: Option<String>,
) -> Result<CustomBackgroundAsset, String> {
    tokio::task::spawn_blocking(move || {
        import_custom_background_blocking(&app, source_path, job_id)
    })
    .await
    .map_err(|error| format!("Background import worker failed: {}", error))?
}

fn import_custom_background_blocking(
    app: &tauri::AppHandle,
    source_path: String,
    job_id: Option<String>,
) -> Result<CustomBackgroundAsset, String> {
    const MAX_BACKGROUND_BYTES: u64 = 250 * 1024 * 1024;
    let job_id = normalize_custom_background_job_id(job_id);
    let import_lock = CUSTOM_BACKGROUND_IMPORT_LOCK
        .get_or_init(|| std::sync::Mutex::new(()))
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());

    if source_path.contains('\0') {
        return Err("Invalid background file".to_string());
    }
    let source = std::path::PathBuf::from(source_path)
        .canonicalize()
        .map_err(|error| format!("Cannot access background file: {}", error))?;
    let metadata = std::fs::metadata(&source)
        .map_err(|error| format!("Cannot read background file: {}", error))?;
    if !metadata.is_file() || metadata.len() > MAX_BACKGROUND_BYTES {
        return Err("Background must be a file no larger than 250MB".to_string());
    }
    let extension = source
        .extension()
        .and_then(|value| value.to_str())
        .ok_or("Unsupported background file")?
        .to_ascii_lowercase();
    let media_type =
        custom_background_media_type(&extension).ok_or("Unsupported background format")?;

    emit_custom_background_import_progress(
        app,
        &job_id,
        "prepare",
        0.0,
        media_type,
        None,
        Some(metadata.len()),
    );

    let target_dir = custom_background_dir(app)?;
    std::fs::create_dir_all(&target_dir)
        .map_err(|error| format!("Cannot prepare background folder: {}", error))?;
    let unique_id = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|error| error.to_string())?
        .as_nanos();
    let target = target_dir.join(format!(
        "background-{}.{}",
        unique_id,
        if media_type == "video" {
            "mp4"
        } else {
            extension.as_str()
        }
    ));
    let temporary = custom_background_temporary_path(&target)?;

    let import_result = if media_type == "video" {
        let ffmpeg = get_ffmpeg_path()?;
        if !ffmpeg.is_file() {
            return Err(
                "Background video conversion requires the bundled FFmpeg engine".to_string(),
            );
        }
        convert_custom_background_video(app, &job_id, &ffmpeg, &source, &temporary, media_type)
    } else {
        copy_custom_background_image(
            app,
            &job_id,
            &source,
            &temporary,
            metadata.len(),
            media_type,
        )
    };

    if let Err(error) = import_result {
        let _ = std::fs::remove_file(&temporary);
        emit_custom_background_import_progress(
            app,
            &job_id,
            "error",
            1.0,
            media_type,
            None,
            Some(metadata.len()),
        );
        return Err(error);
    }

    emit_custom_background_import_progress(
        app,
        &job_id,
        "verify",
        0.98,
        media_type,
        None,
        Some(metadata.len()),
    );
    let target_metadata = std::fs::metadata(&temporary)
        .map_err(|error| format!("Cannot read imported background: {}", error))?;
    if !target_metadata.is_file()
        || target_metadata.len() == 0
        || target_metadata.len() > MAX_BACKGROUND_BYTES
    {
        let _ = std::fs::remove_file(&temporary);
        return Err(
            "Converted background must be a non-empty file no larger than 250MB".to_string(),
        );
    }

    if let Err(error) = std::fs::rename(&temporary, &target) {
        let _ = std::fs::remove_file(&temporary);
        emit_custom_background_import_progress(
            app,
            &job_id,
            "error",
            1.0,
            media_type,
            None,
            Some(metadata.len()),
        );
        return Err(format!("Cannot publish imported background: {}", error));
    }

    // The new file is now durable and addressable. Only after publishing it do
    // we remove previous completed backgrounds, so a failed import never
    // destroys the currently active setting.
    if let Ok(entries) = std::fs::read_dir(&target_dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path != target && path.is_file() && is_completed_custom_background_file(&path) {
                let _ = std::fs::remove_file(path);
            }
        }
    }

    emit_custom_background_import_progress(
        app,
        &job_id,
        "complete",
        1.0,
        media_type,
        Some(target_metadata.len()),
        Some(target_metadata.len()),
    );
    drop(import_lock);

    Ok(CustomBackgroundAsset {
        path: target.to_string_lossy().into_owned(),
        media_type: media_type.to_string(),
    })
}

fn normalize_custom_background_job_id(job_id: Option<String>) -> String {
    let value = job_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("desktop");
    value.chars().take(128).collect()
}

fn emit_custom_background_import_progress(
    app: &tauri::AppHandle,
    job_id: &str,
    phase: &str,
    percent: f64,
    media_type: &str,
    bytes_copied: Option<u64>,
    total_bytes: Option<u64>,
) {
    let _ = app.emit(
        "custom-background-import-progress",
        serde_json::json!({
            "jobId": job_id,
            "phase": phase,
            "percent": percent.clamp(0.0, 1.0),
            "mediaType": media_type,
            "bytesCopied": bytes_copied,
            "totalBytes": total_bytes,
        }),
    );
}

fn custom_background_temporary_path(
    target: &std::path::Path,
) -> Result<std::path::PathBuf, String> {
    let parent = target
        .parent()
        .ok_or("Cannot prepare temporary background path")?;
    let stem = target
        .file_stem()
        .and_then(|value| value.to_str())
        .ok_or("Cannot prepare temporary background path")?;
    let extension = target
        .extension()
        .and_then(|value| value.to_str())
        .ok_or("Cannot prepare temporary background path")?;
    Ok(parent.join(format!("{stem}.part.{extension}")))
}

fn is_completed_custom_background_file(path: &std::path::Path) -> bool {
    path.file_name()
        .and_then(|value| value.to_str())
        .map(|name| name.starts_with("background-") && !name.contains(".part."))
        .unwrap_or(false)
}

fn copy_custom_background_image(
    app: &tauri::AppHandle,
    job_id: &str,
    source: &std::path::Path,
    temporary: &std::path::Path,
    total_bytes: u64,
    media_type: &str,
) -> Result<(), String> {
    use std::io::{Read, Write};

    let input = std::fs::File::open(source)
        .map_err(|error| format!("Cannot read background file: {}", error))?;
    let output = std::fs::File::create(temporary)
        .map_err(|error| format!("Cannot prepare background file: {}", error))?;
    let mut reader = std::io::BufReader::with_capacity(512 * 1024, input);
    let mut writer = std::io::BufWriter::with_capacity(512 * 1024, output);
    let mut buffer = vec![0_u8; 512 * 1024];
    let mut copied = 0_u64;
    let mut last_reported = 0_u64;
    let mut last_report_at = std::time::Instant::now();

    emit_custom_background_import_progress(
        app,
        job_id,
        "copying",
        0.0,
        media_type,
        Some(0),
        Some(total_bytes),
    );
    loop {
        let read = reader
            .read(&mut buffer)
            .map_err(|error| format!("Cannot read background file: {}", error))?;
        if read == 0 {
            break;
        }
        writer
            .write_all(&buffer[..read])
            .map_err(|error| format!("Cannot import background file: {}", error))?;
        copied = copied.saturating_add(read as u64);
        let should_report = copied >= total_bytes
            || copied.saturating_sub(last_reported) >= 1_048_576
            || last_report_at.elapsed() >= std::time::Duration::from_millis(100);
        if should_report {
            let percent = if total_bytes == 0 {
                0.0
            } else {
                ((copied as f64 / total_bytes as f64) * 0.96).clamp(0.0, 0.96)
            };
            emit_custom_background_import_progress(
                app,
                job_id,
                "copying",
                percent,
                media_type,
                Some(copied),
                Some(total_bytes),
            );
            last_reported = copied;
            last_report_at = std::time::Instant::now();
        }
    }
    writer
        .flush()
        .map_err(|error| format!("Cannot finish importing background: {}", error))?;
    writer
        .get_ref()
        .sync_all()
        .map_err(|error| format!("Cannot finish importing background: {}", error))?;
    Ok(())
}

fn probe_custom_background_video_duration(
    ffmpeg: &std::path::Path,
    source: &std::path::Path,
) -> Option<f64> {
    let mut command = std::process::Command::new(ffmpeg);
    command
        .args(["-hide_banner", "-nostdin", "-i"])
        .arg(source)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::piped());
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    let output = command.output().ok()?;
    parse_ffmpeg_duration(&String::from_utf8_lossy(&output.stderr))
}

fn convert_custom_background_video(
    app: &tauri::AppHandle,
    job_id: &str,
    ffmpeg: &std::path::Path,
    source: &std::path::Path,
    temporary: &std::path::Path,
    media_type: &str,
) -> Result<(), String> {
    use std::io::{BufRead, Read};

    emit_custom_background_import_progress(app, job_id, "probing", 0.01, media_type, None, None);
    let duration = probe_custom_background_video_duration(ffmpeg, source);
    emit_custom_background_import_progress(
        app,
        job_id,
        "converting",
        0.02,
        media_type,
        None,
        None,
    );

    let mut command = std::process::Command::new(ffmpeg);
    command
        .args(["-hide_banner", "-nostdin", "-loglevel", "error", "-y", "-i"])
        .arg(source)
        .args([
            "-map",
            "0:v:0",
            "-an",
            "-c:v",
            "libx264",
            "-preset",
            "veryfast",
            "-crf",
            "22",
            "-pix_fmt",
            "yuv420p",
            "-movflags",
            "+faststart",
            "-progress",
            "pipe:1",
            "-nostats",
        ])
        .arg(temporary)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(CREATE_NO_WINDOW);
    }

    let mut child = command
        .spawn()
        .map_err(|error| format!("Cannot start background video conversion: {}", error))?;
    let stdout = child.stdout.take().ok_or_else(|| {
        let _ = child.kill();
        "Cannot read background video conversion progress".to_string()
    })?;
    let stderr = child.stderr.take().ok_or_else(|| {
        let _ = child.kill();
        "Cannot read background video conversion errors".to_string()
    })?;
    let stderr_reader = std::thread::spawn(move || {
        let mut bytes = Vec::new();
        let mut reader = std::io::BufReader::new(stderr);
        let _ = reader.read_to_end(&mut bytes);
        String::from_utf8_lossy(&bytes).into_owned()
    });

    let mut last_percent = 0.02_f64;
    let progress_result = (|| -> Result<(), String> {
        for line in std::io::BufReader::new(stdout).lines() {
            let line = line.map_err(|error| {
                format!(
                    "Cannot read background video conversion progress: {}",
                    error
                )
            })?;
            let Some(seconds) = parse_ffmpeg_progress_seconds(&line) else {
                continue;
            };
            let Some(duration) = duration.filter(|value| *value > 0.0) else {
                continue;
            };
            let percent = (0.02 + (seconds / duration).clamp(0.0, 0.96) * 0.94).clamp(0.02, 0.96);
            if percent - last_percent < 0.003 && percent < 0.96 {
                continue;
            }
            last_percent = percent;
            emit_custom_background_import_progress(
                app,
                job_id,
                "converting",
                percent,
                media_type,
                None,
                None,
            );
        }
        Ok(())
    })();
    if progress_result.is_err() {
        let _ = child.kill();
    }
    let status_result = child.wait();
    let stderr = stderr_reader.join().unwrap_or_default();
    progress_result?;
    let status = status_result
        .map_err(|error| format!("Cannot finish background video conversion: {}", error))?;
    if !status.success() {
        let details = compact_video_convert_error(&stderr);
        return Err(format!(
            "Cannot convert background video to H.264: {}",
            details
        ));
    }
    log::info!("Custom background video conversion completed");
    Ok(())
}

#[tauri::command]
fn log_custom_background_event(event: String) {
    // Keep release logs useful without persisting user file names or paths.
    let category = event
        .split(':')
        .next()
        .filter(|value| matches!(*value, "resolve-failed" | "media-error"))
        .unwrap_or("unknown");
    log::info!("Custom background event: {}", category);
}

fn custom_background_content_type(path: &std::path::Path) -> &'static str {
    match path.extension().and_then(|extension| extension.to_str()) {
        Some(extension) if extension.eq_ignore_ascii_case("mp4") => "video/mp4",
        Some(extension) if extension.eq_ignore_ascii_case("webm") => "video/webm",
        Some(extension) if extension.eq_ignore_ascii_case("png") => "image/png",
        Some(extension) if extension.eq_ignore_ascii_case("webp") => "image/webp",
        Some(extension) if extension.eq_ignore_ascii_case("gif") => "image/gif",
        Some(extension) if extension.eq_ignore_ascii_case("bmp") => "image/bmp",
        _ => "image/jpeg",
    }
}

fn write_background_http_error(
    stream: &mut std::net::TcpStream,
    status: &str,
) -> std::io::Result<()> {
    use std::io::Write;
    stream.write_all(
        format!("HTTP/1.1 {status}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").as_bytes(),
    )
}

fn parse_background_range(request: &str, file_len: u64) -> Option<(u64, u64)> {
    let range = request
        .lines()
        .find_map(|line| {
            line.strip_prefix("Range:")
                .or_else(|| line.strip_prefix("range:"))
        })?
        .trim()
        .strip_prefix("bytes=")?;
    let (start, end) = range.split_once('-')?;
    let start = if start.is_empty() {
        let suffix = end.parse::<u64>().ok()?;
        file_len.saturating_sub(suffix)
    } else {
        start.parse::<u64>().ok()?
    };
    if start >= file_len {
        return None;
    }
    let end = if end.is_empty() {
        file_len - 1
    } else {
        end.parse::<u64>().ok()?.min(file_len - 1)
    };
    (start <= end).then_some((start, end))
}

fn serve_custom_background_connection(
    mut stream: std::net::TcpStream,
    root: &std::path::Path,
    access_token: &str,
) -> std::io::Result<()> {
    use std::io::{Read, Seek, Write};

    stream.set_read_timeout(Some(std::time::Duration::from_secs(5)))?;
    let mut request_bytes = Vec::with_capacity(2048);
    let mut chunk = [0u8; 1024];
    while request_bytes.len() < 16 * 1024 {
        let count = stream.read(&mut chunk)?;
        if count == 0 {
            return Ok(());
        }
        request_bytes.extend_from_slice(&chunk[..count]);
        if request_bytes.windows(4).any(|window| window == b"\r\n\r\n") {
            break;
        }
    }
    let request = String::from_utf8_lossy(&request_bytes);
    let mut request_parts = request
        .lines()
        .next()
        .unwrap_or_default()
        .split_whitespace();
    let method = request_parts.next().unwrap_or_default();
    let url_path = request_parts
        .next()
        .unwrap_or_default()
        .split('?')
        .next()
        .unwrap_or_default();
    if !matches!(method, "GET" | "HEAD") {
        return write_background_http_error(&mut stream, "405 Method Not Allowed");
    }
    let protected_path = url_path
        .strip_prefix("/custom-background/")
        .unwrap_or_default();
    let (request_token, filename) = protected_path.split_once('/').unwrap_or_default();
    if request_token != access_token
        || filename.is_empty()
        || filename.contains(['/', '\\'])
        || filename.contains("..")
        || !filename.starts_with("background-")
    {
        return write_background_http_error(&mut stream, "404 Not Found");
    }
    let path = root.join(filename);
    let file = match std::fs::File::open(&path) {
        Ok(file) => file,
        Err(_) => return write_background_http_error(&mut stream, "404 Not Found"),
    };
    let file_len = file.metadata()?.len();
    if file_len == 0 {
        return write_background_http_error(&mut stream, "404 Not Found");
    }
    let range_header_present = request
        .lines()
        .any(|line| line.to_ascii_lowercase().starts_with("range:"));
    let range = parse_background_range(&request, file_len);
    if range_header_present && range.is_none() {
        return write_background_http_error(&mut stream, "416 Range Not Satisfiable");
    }
    let (start, end, status) = range
        .map(|(start, end)| (start, end, "206 Partial Content"))
        .unwrap_or((0, file_len - 1, "200 OK"));
    let content_len = end - start + 1;
    let mut response = format!(
        "HTTP/1.1 {status}\r\nContent-Type: {}\r\nContent-Length: {content_len}\r\nAccept-Ranges: bytes\r\nCache-Control: no-store\r\nConnection: close\r\n",
        custom_background_content_type(&path)
    );
    if status.starts_with("206") {
        response.push_str(&format!(
            "Content-Range: bytes {start}-{end}/{file_len}\r\n"
        ));
    }
    response.push_str("\r\n");
    stream.write_all(response.as_bytes())?;
    if method == "HEAD" {
        return Ok(());
    }
    let mut file = file;
    file.seek(std::io::SeekFrom::Start(start))?;
    let mut body = file.take(content_len);
    std::io::copy(&mut body, &mut stream)?;
    Ok(())
}

fn custom_background_server_token() -> Result<&'static str, String> {
    if let Some(token) = CUSTOM_BACKGROUND_SERVER_TOKEN.get() {
        return Ok(token.as_str());
    }
    let mut random = [0_u8; 16];
    getrandom::getrandom(&mut random)
        .map_err(|_| "Cannot secure local background media service".to_string())?;
    let generated = hex::encode(random);
    let _ = CUSTOM_BACKGROUND_SERVER_TOKEN.set(generated);
    CUSTOM_BACKGROUND_SERVER_TOKEN
        .get()
        .map(String::as_str)
        .ok_or_else(|| "Cannot secure local background media service".to_string())
}

fn custom_background_server_port(root: std::path::PathBuf) -> Result<u16, String> {
    if let Some(port) = CUSTOM_BACKGROUND_SERVER_PORT.get() {
        return Ok(*port);
    }
    let init_lock = CUSTOM_BACKGROUND_SERVER_INIT_LOCK.get_or_init(|| std::sync::Mutex::new(()));
    let _init_guard = init_lock
        .lock()
        .map_err(|_| "Cannot start local background media service".to_string())?;
    if let Some(port) = CUSTOM_BACKGROUND_SERVER_PORT.get() {
        return Ok(*port);
    }
    let listener = std::net::TcpListener::bind("127.0.0.1:0")
        .map_err(|error| format!("Cannot start local background media service: {error}"))?;
    let port = listener
        .local_addr()
        .map_err(|error| format!("Cannot read local background media port: {error}"))?
        .port();
    let access_token = custom_background_server_token()?.to_string();
    std::thread::Builder::new()
        .name("toolknit-background-media".to_string())
        .spawn(move || {
            for stream in listener.incoming().flatten() {
                if let Err(error) =
                    serve_custom_background_connection(stream, &root, &access_token)
                {
                    log::debug!("Custom background media request failed: {error}");
                }
            }
        })
        .map_err(|error| format!("Cannot run local background media service: {error}"))?;
    let _ = CUSTOM_BACKGROUND_SERVER_PORT.set(port);
    Ok(*CUSTOM_BACKGROUND_SERVER_PORT.get().unwrap_or(&port))
}

#[tauri::command]
fn get_custom_background_media_url(app: tauri::AppHandle, path: String) -> Result<String, String> {
    let root = custom_background_dir(&app)?;
    let root = root
        .canonicalize()
        .map_err(|error| format!("Cannot access background folder: {error}"))?;
    let file = std::path::PathBuf::from(path)
        .canonicalize()
        .map_err(|error| format!("Cannot access imported background: {error}"))?;
    if !file.starts_with(&root) || !file.is_file() {
        return Err("Custom background path is not permitted".to_string());
    }
    let filename = file
        .file_name()
        .and_then(|name| name.to_str())
        .filter(|name| name.starts_with("background-"))
        .ok_or("Invalid imported background file")?;
    let port = custom_background_server_port(root)?;
    let access_token = custom_background_server_token()?;
    Ok(format!(
        "http://127.0.0.1:{port}/custom-background/{access_token}/{filename}"
    ))
}

#[cfg(test)]
mod custom_background_media_tests {
    use super::*;
    use std::io::{Read, Write};

    #[test]
    fn background_temp_path_keeps_the_real_media_extension() {
        let target = std::path::Path::new("C:/temp/background-42.mp4");
        let temporary = custom_background_temporary_path(target).unwrap();
        assert_eq!(
            temporary,
            std::path::PathBuf::from("C:/temp/background-42.part.mp4")
        );
        assert!(is_completed_custom_background_file(target));
        assert!(!is_completed_custom_background_file(&temporary));
    }

    #[test]
    fn background_import_job_id_is_bounded_and_has_a_default() {
        assert_eq!(normalize_custom_background_job_id(None), "desktop");
        assert_eq!(
            normalize_custom_background_job_id(Some("  import-1  ".to_string())),
            "import-1"
        );
        assert_eq!(
            normalize_custom_background_job_id(Some(" ".to_string())),
            "desktop"
        );
        assert_eq!(
            normalize_custom_background_job_id(Some("x".repeat(256)))
                .chars()
                .count(),
            128
        );
    }

    #[test]
    fn serves_custom_background_with_http_range_support() {
        let root =
            std::env::temp_dir().join(format!("toolknit-background-test-{}", std::process::id()));
        std::fs::create_dir_all(&root).unwrap();
        let background = root.join("background-test.mp4");
        std::fs::write(&background, b"0123456789").unwrap();
        let port = custom_background_server_port(root.clone()).unwrap();
        let mut unauthorized = std::net::TcpStream::connect(("127.0.0.1", port)).unwrap();
        unauthorized
            .write_all(
                b"GET /custom-background/wrong/background-test.mp4 HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n",
            )
            .unwrap();
        let mut unauthorized_response = Vec::new();
        unauthorized.read_to_end(&mut unauthorized_response).unwrap();
        assert!(String::from_utf8(unauthorized_response)
            .unwrap()
            .starts_with("HTTP/1.1 404 Not Found"));

        let access_token = custom_background_server_token().unwrap();
        let mut client = std::net::TcpStream::connect(("127.0.0.1", port)).unwrap();
        client
            .write_all(format!(
                "GET /custom-background/{access_token}/background-test.mp4 HTTP/1.1\r\nHost: 127.0.0.1\r\nRange: bytes=2-5\r\n\r\n"
            ).as_bytes())
            .unwrap();
        let mut response = Vec::new();
        client.read_to_end(&mut response).unwrap();
        let response = String::from_utf8(response).unwrap();
        assert!(response.starts_with("HTTP/1.1 206 Partial Content"));
        assert!(response.contains("Content-Type: video/mp4"));
        assert!(response.contains("Content-Range: bytes 2-5/10"));
        assert!(response.ends_with("2345"));
        let _ = std::fs::remove_dir_all(root);
    }
}

#[tauri::command]
fn clear_custom_background(app: tauri::AppHandle) -> Result<(), String> {
    let target_dir = custom_background_dir(&app)?;
    if target_dir.exists() {
        std::fs::remove_dir_all(target_dir)
            .map_err(|error| format!("Cannot clear custom background: {}", error))?;
    }
    Ok(())
}

#[tauri::command]
fn get_install_lang() -> Result<String, String> {
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let dir = exe.parent().ok_or("Cannot find exe directory")?;
    let lang_file = dir.join("install_lang.txt");
    let content = std::fs::read_to_string(&lang_file).map_err(|e| e.to_string())?;
    let lang_id: u32 = content.trim().parse::<u32>().map_err(|e| e.to_string())?;
    // NSIS language IDs: 1033 = English, 2052 = Simplified Chinese
    match lang_id {
        2052 => Ok("zh".to_string()),
        _ => Ok("en".to_string()),
    }
}

#[derive(serde::Serialize)]
struct InstallConfig {
    language: String,
    install_path: String,
}

#[tauri::command]
fn get_install_config() -> Result<InstallConfig, String> {
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let dir = exe.parent().ok_or("Cannot find exe directory")?;

    // Search for install_config.json in exe dir, then parent dirs (up to 3 levels)
    let mut config_file = None;
    let mut search_dir = dir;
    for _ in 0..4 {
        let candidate = search_dir.join("install_config.json");
        if candidate.exists() {
            config_file = Some(candidate);
            break;
        }
        match search_dir.parent() {
            Some(p) => search_dir = p,
            None => break,
        }
    }

    // Fallback: return defaults if install_config.json not found (e.g. running without installer)
    if config_file.is_none() {
        let default_path = dirs::document_dir()
            .map(|d| d.join("ToolKnit").to_string_lossy().to_string())
            .unwrap_or_default();
        return Ok(InstallConfig {
            language: "zh".to_string(),
            install_path: default_path,
        });
    }

    let config_file = config_file.unwrap();
    let content = std::fs::read_to_string(&config_file)
        .map_err(|e| format!("Cannot read install_config.json: {}", e))?;
    let config: serde_json::Value = serde_json::from_str(&content)
        .map_err(|e| format!("Cannot parse install_config.json: {}", e))?;
    let language = config
        .get("language")
        .and_then(|v| v.as_str())
        .unwrap_or("zh")
        .to_string();
    let install_path = config
        .get("installPath")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    Ok(InstallConfig {
        language,
        install_path,
    })
}

// ===== Audio Conversion =====

use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};

static IS_CONVERTING: AtomicBool = AtomicBool::new(false);
static CANCEL_FLAG: AtomicBool = AtomicBool::new(false);
static CURRENT_CHILD_ID: AtomicU32 = AtomicU32::new(0);
static PDF_DECRYPT_TEMP_ID: AtomicU64 = AtomicU64::new(0);
static VIDEO_CONVERT_TEMP_ID: AtomicU64 = AtomicU64::new(0);
static AUDIO_CONVERT_TEMP_ID: AtomicU64 = AtomicU64::new(0);
static IS_MODEL_DOWNLOADING: AtomicBool = AtomicBool::new(false);
static IS_FFMPEG_DOWNLOADING: AtomicBool = AtomicBool::new(false);
static IS_LIBREOFFICE_DOWNLOADING: AtomicBool = AtomicBool::new(false);
static CANCEL_MODEL_DOWNLOAD: AtomicBool = AtomicBool::new(false);
static CANCEL_FFMPEG_DOWNLOAD: AtomicBool = AtomicBool::new(false);
static CANCEL_LIBREOFFICE_DOWNLOAD: AtomicBool = AtomicBool::new(false);
static TRANSCRIPTION_TEMP_ID: AtomicU64 = AtomicU64::new(0);
static PPT_RENDER_TEMP_ID: AtomicU64 = AtomicU64::new(0);
const PPT_RENDER_TIMEOUT_SECS: u64 = 180;
const PPT_RENDER_PROBE_TIMEOUT_MS: u128 = 10_000;
static ACTIVE_VIDEO_CHILDREN: std::sync::OnceLock<
    std::sync::Mutex<std::collections::BTreeSet<u32>>,
> = std::sync::OnceLock::new();
static ACTIVE_OFFICE_CHILDREN: std::sync::OnceLock<
    std::sync::Mutex<std::collections::BTreeSet<u32>>,
> = std::sync::OnceLock::new();
static ICON_ARCHIVE_WRITE_ID: AtomicU64 = AtomicU64::new(0);
static ICON_ARCHIVE_WRITES: std::sync::OnceLock<
    std::sync::Mutex<std::collections::BTreeMap<u64, IconArchiveWrite>>,
> = std::sync::OnceLock::new();
static PDF_ENHANCE_WRITE_ID: AtomicU64 = AtomicU64::new(0);
static PDF_ENHANCE_WRITES: std::sync::OnceLock<
    std::sync::Mutex<std::collections::BTreeMap<u64, PdfEnhanceWrite>>,
> = std::sync::OnceLock::new();

const MAX_ICON_ARCHIVE_BYTES: u64 = 32 * 1024 * 1024;
const MAX_PDF_ENHANCE_OUTPUT_BYTES: u64 = 100 * 1024 * 1024;
const MAX_PDF_ENHANCE_PAGES: u32 = 100;
const MAX_PDF_ENHANCE_WRITE_SESSIONS: usize = 4;

#[derive(Clone)]
struct IconArchiveWrite {
    temporary_path: std::path::PathBuf,
    output_directory: std::path::PathBuf,
    file_name: String,
}

struct PdfEnhanceWrite {
    file: std::fs::File,
    temporary_path: std::path::PathBuf,
    output_directory: std::path::PathBuf,
    file_name: String,
    expected_pages: u32,
    bytes_written: u64,
}

fn icon_archive_writes(
) -> &'static std::sync::Mutex<std::collections::BTreeMap<u64, IconArchiveWrite>> {
    ICON_ARCHIVE_WRITES.get_or_init(|| std::sync::Mutex::new(std::collections::BTreeMap::new()))
}

fn pdf_enhance_writes(
) -> &'static std::sync::Mutex<std::collections::BTreeMap<u64, PdfEnhanceWrite>> {
    PDF_ENHANCE_WRITES.get_or_init(|| std::sync::Mutex::new(std::collections::BTreeMap::new()))
}

fn active_video_children() -> &'static std::sync::Mutex<std::collections::BTreeSet<u32>> {
    ACTIVE_VIDEO_CHILDREN.get_or_init(|| std::sync::Mutex::new(std::collections::BTreeSet::new()))
}

fn active_office_children() -> &'static std::sync::Mutex<std::collections::BTreeSet<u32>> {
    ACTIVE_OFFICE_CHILDREN.get_or_init(|| std::sync::Mutex::new(std::collections::BTreeSet::new()))
}

fn terminate_conversion_process(pid: u32) {
    if pid == 0 {
        return;
    }
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        let _ = std::process::Command::new("taskkill")
            .args(["/F", "/T", "/PID", &pid.to_string()])
            .creation_flags(0x08000000)
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn();
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = std::process::Command::new("kill")
            .arg("-9")
            .arg(pid.to_string())
            .spawn();
    }
}

const MAX_IMAGE_BATCH_FILES: usize = 100;
const MAX_IMAGE_FILE_BYTES: u64 = 20 * 1024 * 1024;
const MAX_IMAGE_PIXELS: u64 = 40_000_000;

struct ConversionGuard;

impl Drop for ConversionGuard {
    fn drop(&mut self) {
        CURRENT_CHILD_ID.store(0, Ordering::SeqCst);
        IS_CONVERTING.store(false, Ordering::SeqCst);
        CANCEL_FLAG.store(false, Ordering::SeqCst);
    }
}

fn begin_conversion() -> Result<ConversionGuard, String> {
    IS_CONVERTING
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .map_err(|_| "Another file conversion is already in progress".to_string())?;
    CANCEL_FLAG.store(false, Ordering::SeqCst);
    Ok(ConversionGuard)
}

const FFMPEG_RUNTIME_DIRECTORY: &str = "ffmpeg";
const FFMPEG_ARCHIVE_BYTES: u64 = 29_581_307;
const FFMPEG_ARCHIVE_SHA256: &str =
    "8883a3dffbd0a16cf4ef95206ea05283f78908dbfb118f73c83f4951dcc06d77";
const FFMPEG_OFFICIAL_URL: &str =
    "https://github.com/eugeneware/ffmpeg-static/releases/download/b6.1.1/ffmpeg-win32-x64.gz";
const FFMPEG_CHINA_URL: &str =
    "https://cdn.npmmirror.com/binaries/ffmpeg-static/b6.1.1/ffmpeg-win32-x64.gz";
const FFMPEG_CHINA_FALLBACK_URL: &str = "https://gh-proxy.com/https://github.com/eugeneware/ffmpeg-static/releases/download/b6.1.1/ffmpeg-win32-x64.gz";

fn ffmpeg_runtime_dir() -> Result<std::path::PathBuf, String> {
    Ok(toolknit_app_data_dir()?.join(FFMPEG_RUNTIME_DIRECTORY))
}
fn ffmpeg_runtime_path() -> Result<std::path::PathBuf, String> {
    Ok(ffmpeg_runtime_dir()?.join(if cfg!(target_os = "windows") {
        "ffmpeg.exe"
    } else {
        "ffmpeg"
    }))
}

#[derive(Clone)]
struct ResolvedFfmpegRuntime {
    path: std::path::PathBuf,
    source: String,
    version: Option<String>,
}

static FFMPEG_RUNTIME_CACHE: OnceLock<std::sync::Mutex<Option<ResolvedFfmpegRuntime>>> =
    OnceLock::new();
const FFMPEG_PROBE_TIMEOUT_MS: u128 = 2_000;

fn ffmpeg_runtime_cache() -> &'static std::sync::Mutex<Option<ResolvedFfmpegRuntime>> {
    FFMPEG_RUNTIME_CACHE.get_or_init(|| std::sync::Mutex::new(None))
}

fn invalidate_ffmpeg_runtime_cache() {
    if let Ok(mut cache) = ffmpeg_runtime_cache().lock() {
        *cache = None;
    }
}

fn ffmpeg_candidates() -> Vec<(std::path::PathBuf, &'static str)> {
    let executable = if cfg!(target_os = "windows") {
        "ffmpeg.exe"
    } else {
        "ffmpeg"
    };
    let mut candidates = Vec::new();
    if let Ok(value) = std::env::var("TOOLKNIT_FFMPEG_PATH") {
        if !value.trim().is_empty() && !value.contains('\0') {
            candidates.push((std::path::PathBuf::from(value), "env:TOOLKNIT_FFMPEG_PATH"));
        }
    }
    if let Ok(managed) = ffmpeg_runtime_path() {
        candidates.push((managed, "managed"));
    }

    // These are fixed package-manager links or conventional install paths.
    // Avoid recursive disk and registry scans: all checks below are cheap file
    // metadata lookups and cover the common Winget, Scoop and Chocolatey cases.
    #[cfg(target_os = "windows")]
    {
        if let Ok(local_app_data) = std::env::var("LOCALAPPDATA") {
            candidates.push((
                std::path::PathBuf::from(local_app_data)
                    .join("Microsoft")
                    .join("WinGet")
                    .join("Links")
                    .join(executable),
                "system:winget",
            ));
        }
        if let Ok(user_profile) = std::env::var("USERPROFILE") {
            candidates.push((
                std::path::PathBuf::from(user_profile)
                    .join("scoop")
                    .join("shims")
                    .join(executable),
                "system:scoop",
            ));
        }
        if let Ok(chocolatey) = std::env::var("ChocolateyInstall") {
            candidates.push((
                std::path::PathBuf::from(chocolatey)
                    .join("bin")
                    .join(executable),
                "system:chocolatey",
            ));
        } else if let Ok(program_data) = std::env::var("ProgramData") {
            candidates.push((
                std::path::PathBuf::from(program_data)
                    .join("chocolatey")
                    .join("bin")
                    .join(executable),
                "system:chocolatey",
            ));
        }
        for key in ["ProgramFiles", "ProgramFiles(x86)"] {
            if let Ok(root) = std::env::var(key) {
                let root = std::path::PathBuf::from(root);
                candidates.push((
                    root.join("ffmpeg").join("bin").join(executable),
                    "system:windows-install",
                ));
                candidates.push((
                    root.join("FFmpeg").join("bin").join(executable),
                    "system:windows-install",
                ));
            }
        }
    }

    #[cfg(debug_assertions)]
    candidates.push((
        std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("resources")
            .join("ffmpeg")
            .join(executable),
        "debug-resource",
    ));

    if let Some(paths) = std::env::var_os("PATH") {
        candidates.extend(
            std::env::split_paths(&paths).map(|directory| (directory.join(executable), "PATH")),
        );
    }
    let mut seen = std::collections::BTreeSet::new();
    candidates
        .into_iter()
        .filter(|(path, _)| seen.insert(path.to_string_lossy().to_ascii_lowercase()))
        .collect()
}

fn probe_ffmpeg_runtime(
    path: &std::path::Path,
    source: &'static str,
) -> Option<ResolvedFfmpegRuntime> {
    if !std::fs::metadata(path)
        .map(|metadata| metadata.is_file())
        .unwrap_or(false)
    {
        return None;
    }
    let mut command = std::process::Command::new(path);
    command
        .arg("-version")
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    let mut child = command.spawn().ok()?;
    let child_id = child.id();
    let started_at = std::time::Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if started_at.elapsed().as_millis() < FFMPEG_PROBE_TIMEOUT_MS => {
                std::thread::sleep(std::time::Duration::from_millis(20));
            }
            _ => {
                terminate_conversion_process(child_id);
                let _ = child.wait();
                return None;
            }
        }
    }
    let output = child.wait_with_output().ok()?;
    if !output.status.success() {
        return None;
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    let version = stdout
        .lines()
        .chain(stderr.lines())
        .map(str::trim)
        .find(|line| line.to_ascii_lowercase().starts_with("ffmpeg version"))
        .map(str::to_string);
    Some(ResolvedFfmpegRuntime {
        path: path.to_path_buf(),
        source: source.to_string(),
        version,
    })
}

fn resolve_ffmpeg_runtime() -> Option<ResolvedFfmpegRuntime> {
    if let Ok(cache) = ffmpeg_runtime_cache().lock() {
        if let Some(runtime) = cache.as_ref() {
            if std::fs::metadata(&runtime.path)
                .map(|metadata| metadata.is_file())
                .unwrap_or(false)
            {
                return Some(runtime.clone());
            }
        }
    }
    for (candidate, source) in ffmpeg_candidates() {
        if let Some(runtime) = probe_ffmpeg_runtime(&candidate, source) {
            if let Ok(mut cache) = ffmpeg_runtime_cache().lock() {
                *cache = Some(runtime.clone());
            }
            return Some(runtime);
        }
    }
    None
}

fn get_ffmpeg_path() -> Result<std::path::PathBuf, String> {
    resolve_ffmpeg_runtime()
        .map(|runtime| runtime.path)
        .ok_or_else(|| {
            "ffmpeg not installed. Open Settings > FFmpeg Runtime to download it.".to_string()
        })
}

#[tauri::command]
fn check_ffmpeg() -> bool {
    get_ffmpeg_path()
        .map(|path| path.is_file())
        .unwrap_or(false)
}

#[derive(Clone, serde::Serialize)]
struct FfmpegRuntimeStatus {
    installed: bool,
    path: Option<String>,
    bytes: u64,
    source: Option<String>,
    version: Option<String>,
}
#[derive(Clone, serde::Serialize)]
struct FfmpegDownloadProgress {
    downloaded_bytes: u64,
    total_bytes: u64,
    phase: String,
}
struct FfmpegDownloadGuard;
impl Drop for FfmpegDownloadGuard {
    fn drop(&mut self) {
        IS_FFMPEG_DOWNLOADING.store(false, Ordering::SeqCst);
    }
}
fn begin_ffmpeg_download() -> Result<FfmpegDownloadGuard, String> {
    IS_FFMPEG_DOWNLOADING
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .map_err(|_| "An FFmpeg download is already in progress".to_string())?;
    CANCEL_FFMPEG_DOWNLOAD.store(false, Ordering::SeqCst);
    Ok(FfmpegDownloadGuard)
}

#[tauri::command]
fn get_ffmpeg_runtime_status() -> Result<FfmpegRuntimeStatus, String> {
    let runtime = resolve_ffmpeg_runtime();
    let path = runtime.as_ref().map(|runtime| runtime.path.as_path());
    Ok(FfmpegRuntimeStatus {
        installed: runtime.is_some(),
        path: path.map(cleanup_display_path),
        bytes: path
            .and_then(|path| std::fs::metadata(path).ok())
            .map(|metadata| metadata.len())
            .unwrap_or(0),
        source: runtime.as_ref().map(|runtime| runtime.source.clone()),
        version: runtime.and_then(|runtime| runtime.version),
    })
}

fn ffmpeg_download_candidates(source: &str) -> Result<Vec<(&'static str, &'static str)>, String> {
    let china = [
        ("china", FFMPEG_CHINA_URL),
        ("china-fallback", FFMPEG_CHINA_FALLBACK_URL),
    ];
    let official = [("official", FFMPEG_OFFICIAL_URL)];
    Ok(match source {
        "auto" | "auto-china" => china.into_iter().chain(official).collect(),
        "auto-official" => official.into_iter().chain(china).collect(),
        "china" => china.into_iter().collect(),
        "official" => official.into_iter().collect(),
        _ => return Err("Unknown FFmpeg download source".to_string()),
    })
}

fn extract_ffmpeg_executable(
    archive: &std::path::Path,
    destination: &std::path::Path,
) -> Result<(), String> {
    use flate2::read::GzDecoder;
    use std::io::{Read, Write};
    let file = std::fs::File::open(archive)
        .map_err(|error| format!("Cannot open FFmpeg archive: {}", error))?;
    let mut entry = GzDecoder::new(file);
    let temporary = destination.with_extension("exe.part");
    let mut output = std::fs::File::create(&temporary)
        .map_err(|error| format!("Cannot create FFmpeg runtime: {}", error))?;
    let mut buffer = [0_u8; 64 * 1024];
    let mut extracted = 0_u64;
    loop {
        let count = entry
            .read(&mut buffer)
            .map_err(|error| format!("Cannot extract FFmpeg: {}", error))?;
        if count == 0 {
            break;
        }
        extracted = extracted.saturating_add(count as u64);
        if extracted > 250 * 1024 * 1024 {
            drop(output);
            let _ = std::fs::remove_file(&temporary);
            return Err("FFmpeg executable in archive is invalid".to_string());
        }
        output
            .write_all(&buffer[..count])
            .map_err(|error| format!("Cannot write FFmpeg runtime: {}", error))?;
    }
    if extracted < 1024 * 1024 {
        drop(output);
        let _ = std::fs::remove_file(&temporary);
        return Err("FFmpeg executable in archive is invalid".to_string());
    }
    output
        .sync_all()
        .map_err(|error| format!("Cannot finalize FFmpeg runtime: {}", error))?;
    drop(output);
    if destination.exists() {
        let _ = std::fs::remove_file(destination);
    }
    std::fs::rename(&temporary, destination)
        .map_err(|error| format!("Cannot install FFmpeg runtime: {}", error))
}

#[tauri::command]
async fn download_ffmpeg_runtime(
    app_handle: tauri::AppHandle,
    source: Option<String>,
) -> Result<FfmpegRuntimeStatus, String> {
    use std::io::Write;
    let _guard = begin_ffmpeg_download()?;
    let directory = ffmpeg_runtime_dir()?;
    std::fs::create_dir_all(&directory)
        .map_err(|error| format!("Cannot create FFmpeg runtime directory: {}", error))?;
    let archive = directory.join("ffmpeg-download.gz.part");
    let _ = std::fs::remove_file(directory.join("ffmpeg-download.zip.part"));
    let requested = source
        .as_deref()
        .unwrap_or("auto")
        .trim()
        .to_ascii_lowercase();
    let candidates = ffmpeg_download_candidates(&requested)?;
    let client = reqwest::Client::builder()
        .user_agent("ToolKnit/2.3.1 ffmpeg-runtime-manager")
        .connect_timeout(std::time::Duration::from_secs(12))
        .build()
        .map_err(|error| format!("Cannot initialize FFmpeg download: {}", error))?;
    let mut last_error = None;
    for (candidate, url) in candidates {
        if CANCEL_FFMPEG_DOWNLOAD.load(Ordering::SeqCst) {
            return Err("dependency-download:cancelled".to_string());
        }
        let mut resume_from = std::fs::metadata(&archive)
            .map(|metadata| metadata.len())
            .unwrap_or(0);
        if resume_from > FFMPEG_ARCHIVE_BYTES {
            let _ = std::fs::remove_file(&archive);
            resume_from = 0;
        }
        let mut request = client.get(url);
        if resume_from > 0 {
            request = request.header(reqwest::header::RANGE, format!("bytes={}-", resume_from));
        }
        let mut response = match request.send().await {
            Ok(response) if response.status().is_success() => response,
            Ok(response) => {
                last_error = Some(format!("{}: HTTP {}", candidate, response.status()));
                continue;
            }
            Err(error) => {
                last_error = Some(format!("{}: {}", candidate, error));
                continue;
            }
        };
        let append = resume_from > 0 && response.status() == reqwest::StatusCode::PARTIAL_CONTENT;
        if !append && resume_from > 0 {
            resume_from = 0;
        }
        let mut downloaded = if append { resume_from } else { 0 };
        let mut file = std::fs::OpenOptions::new()
            .create(true)
            .write(true)
            .append(append)
            .truncate(!append)
            .open(&archive)
            .map_err(|error| format!("Cannot create FFmpeg download: {}", error))?;
        let _ = app_handle.emit(
            "ffmpeg-runtime-download-progress",
            FfmpegDownloadProgress {
                downloaded_bytes: downloaded,
                total_bytes: FFMPEG_ARCHIVE_BYTES,
                phase: "downloading".to_string(),
            },
        );
        let mut failed = None;
        loop {
            if CANCEL_FFMPEG_DOWNLOAD.load(Ordering::SeqCst) {
                let _ = file.sync_all();
                return Err("dependency-download:cancelled".to_string());
            }
            match response.chunk().await {
                Ok(Some(chunk)) => {
                    downloaded = downloaded.saturating_add(chunk.len() as u64);
                    if downloaded > FFMPEG_ARCHIVE_BYTES {
                        failed =
                            Some("FFmpeg package is larger than the expected size".to_string());
                        break;
                    }
                    if let Err(error) = file.write_all(&chunk) {
                        failed = Some(format!("Cannot write FFmpeg download: {}", error));
                        break;
                    }
                    let _ = app_handle.emit(
                        "ffmpeg-runtime-download-progress",
                        FfmpegDownloadProgress {
                            downloaded_bytes: downloaded,
                            total_bytes: FFMPEG_ARCHIVE_BYTES,
                            phase: "downloading".to_string(),
                        },
                    );
                }
                Ok(None) => break,
                Err(error) => {
                    failed = Some(format!("FFmpeg download interrupted: {}", error));
                    break;
                }
            }
        }
        let _ = file.sync_all();
        drop(file);
        if let Some(error) = failed {
            last_error = Some(error);
            continue;
        }
        if downloaded != FFMPEG_ARCHIVE_BYTES {
            last_error = Some(format!(
                "Downloaded FFmpeg package is incomplete ({}/{})",
                downloaded, FFMPEG_ARCHIVE_BYTES
            ));
            continue;
        }
        let archive_for_hash = archive.clone();
        let actual_hash = tokio::task::spawn_blocking(move || sha256_file(&archive_for_hash))
            .await
            .map_err(|error| format!("Cannot verify FFmpeg package: {}", error))??;
        if actual_hash != FFMPEG_ARCHIVE_SHA256 {
            let _ = std::fs::remove_file(&archive);
            last_error = Some("FFmpeg package integrity check failed".to_string());
            continue;
        }
        let _ = app_handle.emit(
            "ffmpeg-runtime-download-progress",
            FfmpegDownloadProgress {
                downloaded_bytes: downloaded,
                total_bytes: FFMPEG_ARCHIVE_BYTES,
                phase: "installing".to_string(),
            },
        );
        let archive_for_extract = archive.clone();
        let executable = ffmpeg_runtime_path()?;
        let extraction = tokio::task::spawn_blocking(move || {
            extract_ffmpeg_executable(&archive_for_extract, &executable)
        })
        .await
        .map_err(|error| format!("Cannot install FFmpeg runtime: {}", error))?;
        if let Err(error) = extraction {
            last_error = Some(error);
            let _ = std::fs::remove_file(&archive);
            continue;
        }
        let _ = std::fs::remove_file(&archive);
        let executable = ffmpeg_runtime_path()?;
        let valid = tokio::task::spawn_blocking(move || {
            std::process::Command::new(&executable)
                .arg("-version")
                .output()
                .map(|result| result.status.success())
                .unwrap_or(false)
        })
        .await
        .map_err(|error| format!("Cannot validate FFmpeg runtime: {}", error))?;
        if !valid {
            let _ = std::fs::remove_file(ffmpeg_runtime_path()?);
            return Err(
                "FFmpeg executable validation failed; the downloaded runtime was removed"
                    .to_string(),
            );
        }
        let _ = app_handle.emit(
            "ffmpeg-runtime-download-progress",
            FfmpegDownloadProgress {
                downloaded_bytes: downloaded,
                total_bytes: FFMPEG_ARCHIVE_BYTES,
                phase: "complete".to_string(),
            },
        );
        invalidate_ffmpeg_runtime_cache();
        return get_ffmpeg_runtime_status();
    }
    Err(format!(
        "Cannot download FFmpeg: {}",
        last_error.unwrap_or_else(|| "unknown error".to_string())
    ))
}

#[tauri::command]
fn delete_ffmpeg_runtime() -> Result<(), String> {
    let directory = ffmpeg_runtime_dir()?;
    if directory.exists() {
        std::fs::remove_dir_all(directory)
            .map_err(|error| format!("Cannot delete FFmpeg runtime: {}", error))?;
    }
    Ok(())
}

// ===== Managed LibreOffice runtime for PPT rendering =====
//
// LibreOffice remains an optional component. The desktop installer stays small;
// users download and extract it to ToolKnit's private AppData location only when
// PPT to PDF/image rendering is needed.
const LIBREOFFICE_RUNTIME_DIRECTORY: &str = "libreoffice";
const LIBREOFFICE_RUNTIME_VERSION: &str = "26.2.5";
const LIBREOFFICE_ARCHIVE_BYTES: u64 = 372_948_992;
const LIBREOFFICE_ARCHIVE_SHA256: &str =
    "f15ba07bfcb0186986cf3171063506f5d207c11f8cc051ba0d135209e9e915f9";
const LIBREOFFICE_OFFICIAL_URL: &str =
    "https://download.documentfoundation.org/libreoffice/stable/26.2.5/win/x86_64/LibreOffice_26.2.5_Win_x86-64.msi";
const LIBREOFFICE_CHINA_URL: &str =
    "https://mirrors.tuna.tsinghua.edu.cn/libreoffice/libreoffice/stable/26.2.5/win/x86_64/LibreOffice_26.2.5_Win_x86-64.msi";

fn libreoffice_runtime_dir() -> Result<std::path::PathBuf, String> {
    Ok(toolknit_app_data_dir()?
        .join(LIBREOFFICE_RUNTIME_DIRECTORY)
        .join(LIBREOFFICE_RUNTIME_VERSION))
}

fn libreoffice_runtime_path() -> Result<std::path::PathBuf, String> {
    Ok(libreoffice_runtime_dir()?
        .join("program")
        .join(if cfg!(target_os = "windows") {
            "soffice.com"
        } else {
            "soffice"
        }))
}

#[derive(Clone, serde::Serialize)]
struct LibreOfficeRuntimeStatus {
    installed: bool,
    path: Option<String>,
    bytes: u64,
    source: Option<String>,
    version: Option<String>,
}

#[derive(Default)]
struct LibreOfficeRuntimeCache {
    /// The last runtime path that was resolved successfully. Keeping this in
    /// memory avoids launching soffice --version for every PPT conversion.
    runtime: Option<LibreOfficeRuntimeInfo>,
    /// Directory size is only presentation metadata. It is populated by a
    /// background scan so opening a PPT tool never waits on thousands of files.
    bytes: Option<u64>,
    size_scan_in_progress: bool,
    size_scan_generation: u64,
}

static LIBREOFFICE_RUNTIME_CACHE: std::sync::OnceLock<
    std::sync::Mutex<LibreOfficeRuntimeCache>,
> = std::sync::OnceLock::new();
static LIBREOFFICE_CACHE_GENERATION: AtomicU64 = AtomicU64::new(0);

fn libreoffice_runtime_cache() -> &'static std::sync::Mutex<LibreOfficeRuntimeCache> {
    LIBREOFFICE_RUNTIME_CACHE.get_or_init(|| std::sync::Mutex::new(LibreOfficeRuntimeCache::default()))
}

fn invalidate_libreoffice_runtime_cache() {
    LIBREOFFICE_CACHE_GENERATION.fetch_add(1, Ordering::SeqCst);
    if let Ok(mut cache) = libreoffice_runtime_cache().lock() {
        *cache = LibreOfficeRuntimeCache::default();
    }
}

fn cache_libreoffice_runtime(runtime: LibreOfficeRuntimeInfo) {
    if let Ok(mut cache) = libreoffice_runtime_cache().lock() {
        cache.runtime = Some(runtime);
    }
}

fn cached_libreoffice_runtime() -> Option<LibreOfficeRuntimeInfo> {
    libreoffice_runtime_cache()
        .lock()
        .ok()
        .and_then(|cache| cache.runtime.clone())
}

#[derive(Clone, serde::Serialize)]
struct LibreOfficeDownloadProgress {
    downloaded_bytes: u64,
    total_bytes: u64,
    phase: String,
}

struct LibreOfficeDownloadGuard;

impl Drop for LibreOfficeDownloadGuard {
    fn drop(&mut self) {
        IS_LIBREOFFICE_DOWNLOADING.store(false, Ordering::SeqCst);
    }
}

fn begin_libreoffice_download() -> Result<LibreOfficeDownloadGuard, String> {
    IS_LIBREOFFICE_DOWNLOADING
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .map_err(|_| "A PPT runtime download is already in progress".to_string())?;
    CANCEL_LIBREOFFICE_DOWNLOAD.store(false, Ordering::SeqCst);
    Ok(LibreOfficeDownloadGuard)
}

fn directory_size_bytes(path: &std::path::Path) -> u64 {
    let mut total = 0_u64;
    let mut stack = vec![path.to_path_buf()];
    while let Some(directory) = stack.pop() {
        let entries = match std::fs::read_dir(directory) {
            Ok(entries) => entries,
            Err(_) => continue,
        };
        for entry in entries.flatten() {
            let path = entry.path();
            match entry.metadata() {
                Ok(metadata) if metadata.is_file() => total = total.saturating_add(metadata.len()),
                Ok(metadata) if metadata.is_dir() => stack.push(path),
                _ => {}
            }
        }
    }
    total
}

fn cached_or_schedule_libreoffice_size(root: &std::path::Path) -> u64 {
    let (cached, should_scan, generation) = match libreoffice_runtime_cache().lock() {
        Ok(mut cache) => {
            if let Some(bytes) = cache.bytes {
                (bytes, false, 0)
            } else if cache.size_scan_in_progress {
                (0, false, 0)
            } else {
                cache.size_scan_in_progress = true;
                let generation = LIBREOFFICE_CACHE_GENERATION.load(Ordering::SeqCst);
                cache.size_scan_generation = generation;
                (0, true, generation)
            }
        }
        Err(_) => (0, false, 0),
    };
    if !should_scan {
        return cached;
    }

    let root = root.to_path_buf();
    std::thread::spawn(move || {
        let bytes = directory_size_bytes(&root);
        // A delete/reinstall may have happened while the scan was running;
        // never publish an old size into the new runtime status.
        if generation != LIBREOFFICE_CACHE_GENERATION.load(Ordering::SeqCst) {
            return;
        }
        if let Ok(mut cache) = libreoffice_runtime_cache().lock() {
            if cache.size_scan_generation == generation {
                cache.bytes = Some(bytes);
                cache.size_scan_in_progress = false;
            }
        }
    });
    0
}

/// Resolve an installed executable without starting LibreOffice. This is the
/// hot-path check used while opening the two PPT tools. A successful metadata
/// check is sufficient because conversion performs the real process launch
/// and reports a renderer error if a custom path is invalid.
fn resolve_libreoffice_runtime_quick() -> Option<LibreOfficeRuntimeInfo> {
    for (candidate, source) in libreoffice_candidates() {
        let metadata = match std::fs::metadata(&candidate) {
            Ok(metadata) => metadata,
            Err(_) => continue,
        };
        if !metadata.is_file() {
            continue;
        }
        return Some(LibreOfficeRuntimeInfo {
            available: true,
            command: Some(candidate.to_string_lossy().into_owned()),
            source: Some(source.to_string()),
            version: cached_libreoffice_runtime().and_then(|runtime| runtime.version),
            message: None,
        });
    }
    None
}

#[tauri::command]
fn is_libreoffice_runtime_available() -> bool {
    if let Some(runtime) = cached_libreoffice_runtime() {
        if runtime
            .command
            .as_deref()
            .map(std::path::Path::new)
            .is_some_and(|path| std::fs::metadata(path).map(|meta| meta.is_file()).unwrap_or(false))
        {
            return true;
        }
    }
    if let Some(runtime) = resolve_libreoffice_runtime_quick() {
        cache_libreoffice_runtime(runtime);
        return true;
    }
    false
}

#[tauri::command]
fn get_libreoffice_runtime_status() -> Result<LibreOfficeRuntimeStatus, String> {
    // Status is also called from the settings page. Keep it responsive even
    // when the managed runtime contains tens of thousands of extracted files.
    // Detailed size metadata is filled asynchronously and appears on the next
    // refresh/open of the manager.
    let runtime = resolve_libreoffice_runtime_quick()
        .or_else(cached_libreoffice_runtime)
        .unwrap_or(LibreOfficeRuntimeInfo {
            available: false,
            command: None,
            source: None,
            version: None,
            message: None,
        });
    if runtime.available {
        cache_libreoffice_runtime(runtime.clone());
    }
    let bytes = if runtime.source.as_deref() == Some("managed") {
        cached_or_schedule_libreoffice_size(&libreoffice_runtime_dir()?)
    } else {
        0
    };
    Ok(LibreOfficeRuntimeStatus {
        installed: runtime.available,
        path: runtime.command,
        bytes,
        source: runtime.source,
        version: runtime.version,
    })
}

fn libreoffice_download_candidates(
    source: &str,
) -> Result<Vec<(&'static str, &'static str)>, String> {
    let china = [("china", LIBREOFFICE_CHINA_URL)];
    let official = [("official", LIBREOFFICE_OFFICIAL_URL)];
    Ok(match source {
        "auto" | "auto-china" => china.into_iter().chain(official).collect(),
        "auto-official" => official.into_iter().chain(china).collect(),
        "china" => china.into_iter().collect(),
        "official" => official.into_iter().collect(),
        _ => return Err("Unknown PPT runtime download source".to_string()),
    })
}

#[cfg(target_os = "windows")]
fn extract_libreoffice_msi(
    archive: &std::path::Path,
    destination: &std::path::Path,
) -> Result<(), String> {
    let staged = destination.with_extension("installing");
    if staged.exists() {
        let _ = std::fs::remove_dir_all(&staged);
    }
    std::fs::create_dir_all(&staged)
        .map_err(|error| format!("Cannot prepare PPT runtime directory: {}", error))?;
    let mut command = std::process::Command::new("msiexec.exe");
    command
        .arg("/a")
        .arg(archive)
        .arg("/qn")
        .arg("TARGETDIR=".to_string() + &staged.to_string_lossy());
    use std::os::windows::process::CommandExt;
    command.creation_flags(0x08000000);
    let output = command
        .output()
        .map_err(|error| format!("Cannot start LibreOffice extraction: {}", error))?;
    if !output.status.success() {
        let _ = std::fs::remove_dir_all(&staged);
        return Err(format!(
            "LibreOffice extraction failed: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    let extracted = staged.join("program").join("soffice.com");
    if !extracted.is_file() {
        let _ = std::fs::remove_dir_all(&staged);
        return Err("LibreOffice extraction did not produce soffice.com".to_string());
    }
    if destination.exists() {
        std::fs::remove_dir_all(destination)
            .map_err(|error| format!("Cannot replace old PPT runtime: {}", error))?;
    }
    std::fs::rename(&staged, destination)
        .map_err(|error| format!("Cannot finalize PPT runtime: {}", error))
}

#[cfg(not(target_os = "windows"))]
fn extract_libreoffice_msi(_: &std::path::Path, _: &std::path::Path) -> Result<(), String> {
    Err("Managed LibreOffice download is currently available on Windows only".to_string())
}

#[tauri::command]
async fn download_libreoffice_runtime(
    app_handle: tauri::AppHandle,
    source: Option<String>,
) -> Result<LibreOfficeRuntimeStatus, String> {
    use std::io::Write;
    let _guard = begin_libreoffice_download()?;
    invalidate_libreoffice_runtime_cache();
    let destination = libreoffice_runtime_dir()?;
    let parent = destination
        .parent()
        .ok_or("Invalid PPT runtime directory")?
        .to_path_buf();
    std::fs::create_dir_all(&parent)
        .map_err(|error| format!("Cannot create PPT runtime directory: {}", error))?;
    let archive = parent.join(format!(
        "LibreOffice_{}_Win_x86-64.msi.part",
        LIBREOFFICE_RUNTIME_VERSION
    ));
    let requested = source
        .as_deref()
        .unwrap_or("auto")
        .trim()
        .to_ascii_lowercase();
    let candidates = libreoffice_download_candidates(&requested)?;
    let client = reqwest::Client::builder()
        .user_agent("ToolKnit/2.3.1 libreoffice-runtime-manager")
        .connect_timeout(std::time::Duration::from_secs(15))
        .build()
        .map_err(|error| format!("Cannot initialize PPT runtime download: {}", error))?;
    let mut last_error = None;
    for (candidate, url) in candidates {
        if CANCEL_LIBREOFFICE_DOWNLOAD.load(Ordering::SeqCst) {
            return Err("dependency-download:cancelled".to_string());
        }
        let mut resume_from = std::fs::metadata(&archive)
            .map(|metadata| metadata.len())
            .unwrap_or(0);
        if resume_from > LIBREOFFICE_ARCHIVE_BYTES {
            let _ = std::fs::remove_file(&archive);
            resume_from = 0;
        }
        let mut request = client.get(url);
        if resume_from > 0 {
            request = request.header(reqwest::header::RANGE, format!("bytes={}-", resume_from));
        }
        let mut response = match request.send().await {
            Ok(response) if response.status().is_success() => response,
            Ok(response) => {
                last_error = Some(format!("{}: HTTP {}", candidate, response.status()));
                continue;
            }
            Err(error) => {
                last_error = Some(format!("{}: {}", candidate, error));
                continue;
            }
        };
        let append = resume_from > 0 && response.status() == reqwest::StatusCode::PARTIAL_CONTENT;
        if !append && resume_from > 0 {
            resume_from = 0;
        }
        let mut downloaded = if append { resume_from } else { 0 };
        let mut file = std::fs::OpenOptions::new()
            .create(true)
            .write(true)
            .append(append)
            .truncate(!append)
            .open(&archive)
            .map_err(|error| format!("Cannot create PPT runtime download: {}", error))?;
        let _ = app_handle.emit(
            "libreoffice-runtime-download-progress",
            LibreOfficeDownloadProgress {
                downloaded_bytes: downloaded,
                total_bytes: LIBREOFFICE_ARCHIVE_BYTES,
                phase: "downloading".to_string(),
            },
        );
        let mut failed = None;
        loop {
            if CANCEL_LIBREOFFICE_DOWNLOAD.load(Ordering::SeqCst) {
                let _ = file.sync_all();
                return Err("dependency-download:cancelled".to_string());
            }
            match response.chunk().await {
                Ok(Some(chunk)) => {
                    downloaded = downloaded.saturating_add(chunk.len() as u64);
                    if downloaded > LIBREOFFICE_ARCHIVE_BYTES {
                        failed = Some("PPT runtime package is larger than expected".to_string());
                        break;
                    }
                    if let Err(error) = file.write_all(&chunk) {
                        failed = Some(format!("Cannot write PPT runtime download: {}", error));
                        break;
                    }
                    let _ = app_handle.emit(
                        "libreoffice-runtime-download-progress",
                        LibreOfficeDownloadProgress {
                            downloaded_bytes: downloaded,
                            total_bytes: LIBREOFFICE_ARCHIVE_BYTES,
                            phase: "downloading".to_string(),
                        },
                    );
                }
                Ok(None) => break,
                Err(error) => {
                    failed = Some(format!("PPT runtime download interrupted: {}", error));
                    break;
                }
            }
        }
        let _ = file.sync_all();
        drop(file);
        if let Some(error) = failed {
            last_error = Some(error);
            continue;
        }
        if downloaded != LIBREOFFICE_ARCHIVE_BYTES {
            last_error = Some(format!(
                "Downloaded PPT runtime is incomplete ({}/{})",
                downloaded, LIBREOFFICE_ARCHIVE_BYTES
            ));
            continue;
        }
        let _ = app_handle.emit(
            "libreoffice-runtime-download-progress",
            LibreOfficeDownloadProgress {
                downloaded_bytes: downloaded,
                total_bytes: LIBREOFFICE_ARCHIVE_BYTES,
                phase: "verifying".to_string(),
            },
        );
        let archive_for_hash = archive.clone();
        let actual_hash = tokio::task::spawn_blocking(move || sha256_file(&archive_for_hash))
            .await
            .map_err(|error| format!("Cannot verify PPT runtime: {}", error))??;
        if actual_hash != LIBREOFFICE_ARCHIVE_SHA256 {
            let _ = std::fs::remove_file(&archive);
            last_error = Some("PPT runtime integrity check failed".to_string());
            continue;
        }
        let _ = app_handle.emit(
            "libreoffice-runtime-download-progress",
            LibreOfficeDownloadProgress {
                downloaded_bytes: downloaded,
                total_bytes: LIBREOFFICE_ARCHIVE_BYTES,
                phase: "installing".to_string(),
            },
        );
        let archive_for_extract = archive.clone();
        let destination_for_extract = destination.clone();
        let extraction = tokio::task::spawn_blocking(move || {
            extract_libreoffice_msi(&archive_for_extract, &destination_for_extract)
        })
        .await
        .map_err(|error| format!("Cannot install PPT runtime: {}", error))?;
        if let Err(error) = extraction {
            last_error = Some(error);
            continue;
        }
        let _ = std::fs::remove_file(&archive);
        let executable = libreoffice_runtime_path()?;
        let _ = app_handle.emit(
            "libreoffice-runtime-download-progress",
            LibreOfficeDownloadProgress {
                downloaded_bytes: downloaded,
                total_bytes: LIBREOFFICE_ARCHIVE_BYTES,
                phase: "verifying".to_string(),
            },
        );
        let valid = tokio::task::spawn_blocking(move || {
            probe_libreoffice(&executable, "managed").is_some()
        })
        .await
        .map_err(|error| format!("Cannot validate PPT runtime: {}", error))?;
        if !valid {
            let _ = std::fs::remove_dir_all(libreoffice_runtime_dir()?);
            return Err(
                "PPT runtime validation failed; the downloaded runtime was removed".to_string(),
            );
        }
        let _ = app_handle.emit(
            "libreoffice-runtime-download-progress",
            LibreOfficeDownloadProgress {
                downloaded_bytes: downloaded,
                total_bytes: LIBREOFFICE_ARCHIVE_BYTES,
                phase: "complete".to_string(),
            },
        );
        // Do not perform a recursive directory-size scan on the download
        // completion path. The manager can refresh the cached size later while
        // the newly installed runtime is immediately usable.
        return get_libreoffice_runtime_status();
    }
    Err(format!(
        "Cannot download PPT runtime: {}",
        last_error.unwrap_or_else(|| "unknown error".to_string())
    ))
}

#[tauri::command]
fn delete_libreoffice_runtime() -> Result<(), String> {
    let directory = libreoffice_runtime_dir()?;
    if directory.exists() {
        std::fs::remove_dir_all(&directory)
            .map_err(|error| format!("Cannot delete PPT runtime: {}", error))?;
    }
    invalidate_libreoffice_runtime_cache();
    Ok(())
}

#[tauri::command]
fn cancel_dependency_downloads() {
    CANCEL_FFMPEG_DOWNLOAD.store(true, Ordering::SeqCst);
    CANCEL_MODEL_DOWNLOAD.store(true, Ordering::SeqCst);
    CANCEL_LIBREOFFICE_DOWNLOAD.store(true, Ordering::SeqCst);
}

// ===== Offline transcription model management =====

const TRANSCRIPTION_MODEL_DIRECTORY: &str = "models";
const TRANSCRIPTION_MODEL_CONFIG: &str = "transcription-model.json";

struct TranscriptionModelSpec {
    id: &'static str,
    file_name: &'static str,
    display_name: &'static str,
    bytes: u64,
    sha256: &'static str,
}

const TRANSCRIPTION_MODELS: [TranscriptionModelSpec; 3] = [
    TranscriptionModelSpec {
        id: "base",
        file_name: "ggml-base.bin",
        display_name: "Whisper Base",
        bytes: 147_951_465,
        sha256: "60ed5bc3dd14eea856493d334349b405782ddcaf0028d4b5df4088345fba2efe",
    },
    TranscriptionModelSpec {
        id: "small",
        file_name: "ggml-small.bin",
        display_name: "Whisper Small",
        bytes: 487_601_967,
        sha256: "1be3a9b2063867b937e64e2ec7483364a79917e157fa98c5d94b5c1fffea987b",
    },
    TranscriptionModelSpec {
        id: "medium",
        file_name: "ggml-medium.bin",
        display_name: "Whisper Medium",
        bytes: 1_533_763_059,
        sha256: "6c14d5adee5f86394037b4e4e8b59f1673b6cee10e3cf0b11bbdbee79c156208",
    },
];

#[derive(serde::Serialize, serde::Deserialize, Default)]
struct TranscriptionModelConfig {
    current_model: Option<String>,
}

#[derive(serde::Serialize)]
struct TranscriptionModelStatus {
    id: String,
    display_name: String,
    bytes: u64,
    installed: bool,
    current: bool,
}

#[derive(Clone, serde::Serialize)]
struct ModelDownloadProgress {
    model_id: String,
    downloaded_bytes: u64,
    total_bytes: u64,
    phase: String,
}

#[derive(serde::Serialize)]
struct ModelDownloadResult {
    model_id: String,
    path: String,
    current: bool,
}

struct ModelDownloadGuard;

impl Drop for ModelDownloadGuard {
    fn drop(&mut self) {
        IS_MODEL_DOWNLOADING.store(false, Ordering::SeqCst);
    }
}

fn begin_model_download() -> Result<ModelDownloadGuard, String> {
    IS_MODEL_DOWNLOADING
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .map_err(|_| "A model download is already in progress".to_string())?;
    CANCEL_MODEL_DOWNLOAD.store(false, Ordering::SeqCst);
    Ok(ModelDownloadGuard)
}

fn transcription_model_spec(model_id: &str) -> Result<&'static TranscriptionModelSpec, String> {
    TRANSCRIPTION_MODELS
        .iter()
        .find(|model| model.id == model_id.trim().to_ascii_lowercase())
        .ok_or("Unknown transcription model".to_string())
}

fn transcription_models_dir() -> Result<std::path::PathBuf, String> {
    Ok(toolknit_app_data_dir()?.join(TRANSCRIPTION_MODEL_DIRECTORY))
}

fn transcription_model_path(model: &TranscriptionModelSpec) -> Result<std::path::PathBuf, String> {
    Ok(transcription_models_dir()?.join(model.file_name))
}

fn transcription_model_config_path() -> Result<std::path::PathBuf, String> {
    Ok(toolknit_app_data_dir()?.join(TRANSCRIPTION_MODEL_CONFIG))
}

fn read_transcription_model_config() -> TranscriptionModelConfig {
    transcription_model_config_path()
        .ok()
        .and_then(|path| std::fs::read_to_string(path).ok())
        .and_then(|content| serde_json::from_str(&content).ok())
        .unwrap_or_default()
}

fn write_transcription_model_config(config: &TranscriptionModelConfig) -> Result<(), String> {
    let path = transcription_model_config_path()?;
    let parent = path
        .parent()
        .ok_or("Invalid model configuration directory")?;
    std::fs::create_dir_all(parent)
        .map_err(|error| format!("Cannot create model configuration directory: {}", error))?;
    let encoded = serde_json::to_vec(config)
        .map_err(|error| format!("Cannot save model configuration: {}", error))?;
    std::fs::write(path, encoded)
        .map_err(|error| format!("Cannot save model configuration: {}", error))
}

fn installed_model_file(
    model: &TranscriptionModelSpec,
) -> Result<Option<std::path::PathBuf>, String> {
    let path = transcription_model_path(model)?;
    let metadata = match std::fs::metadata(&path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(format!("Cannot inspect model file: {}", error)),
    };
    if metadata.is_file() && metadata.len() == model.bytes {
        Ok(Some(path))
    } else {
        Ok(None)
    }
}

fn transcription_model_source(
    model: &TranscriptionModelSpec,
    source: Option<&str>,
) -> Result<String, String> {
    let source = source.unwrap_or("auto").trim().to_ascii_lowercase();
    let root = match source.as_str() {
        "official" => "https://huggingface.co/ggerganov/whisper.cpp/resolve/main",
        "china" => "https://hf-mirror.com/ggerganov/whisper.cpp/resolve/main",
        // The desktop can retry with `china` after an official failure. `auto` begins with the upstream source.
        "auto" => "https://huggingface.co/ggerganov/whisper.cpp/resolve/main",
        _ => return Err("Unknown model download source".to_string()),
    };
    Ok(format!("{}/{}", root, model.file_name))
}

fn sha256_file(path: &std::path::Path) -> Result<String, String> {
    use sha2::{Digest, Sha256};
    use std::io::Read;

    let mut file =
        std::fs::File::open(path).map_err(|error| format!("Cannot open model file: {}", error))?;
    let mut digest = Sha256::new();
    let mut buffer = [0_u8; 1024 * 1024];
    loop {
        let read = file
            .read(&mut buffer)
            .map_err(|error| format!("Cannot read model file: {}", error))?;
        if read == 0 {
            break;
        }
        digest.update(&buffer[..read]);
    }
    Ok(format!("{:x}", digest.finalize()))
}

fn get_whisper_cli_path() -> Result<std::path::PathBuf, String> {
    let executable = if cfg!(target_os = "windows") {
        "whisper-cli.exe"
    } else {
        "whisper-cli"
    };
    let exe = std::env::current_exe().map_err(|error| error.to_string())?;
    let exe_dir = exe.parent().ok_or("Cannot find executable directory")?;
    let bundled = exe_dir
        .join("resources")
        .join("whisper")
        .join("Release")
        .join(executable);
    if bundled.is_file() {
        return Ok(bundled);
    }

    let source_resource = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("resources")
        .join("whisper")
        .join("Release")
        .join(executable);
    if source_resource.is_file() {
        return Ok(source_resource);
    }
    Err("Offline transcription engine is unavailable. Please reinstall ToolKnit.".to_string())
}

#[tauri::command]
fn check_transcription_engine() -> bool {
    get_whisper_cli_path()
        .map(|path| path.is_file())
        .unwrap_or(false)
}

fn get_whisper_library_path() -> Result<std::path::PathBuf, String> {
    let library = if cfg!(target_os = "windows") {
        "whisper.dll"
    } else if cfg!(target_os = "macos") {
        "libwhisper.dylib"
    } else {
        "libwhisper.so"
    };
    let exe = std::env::current_exe().map_err(|error| error.to_string())?;
    let exe_dir = exe.parent().ok_or("Cannot find executable directory")?;
    let bundled = exe_dir
        .join("resources")
        .join("whisper")
        .join("Release")
        .join(library);
    if bundled.is_file() {
        return Ok(bundled);
    }

    let source_resource = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("resources")
        .join("whisper")
        .join("Release")
        .join(library);
    if source_resource.is_file() {
        return Ok(source_resource);
    }
    Err("Offline transcription engine is unavailable. Please reinstall ToolKnit.".to_string())
}

// ===== Teleprompter live offline recognition =====

#[derive(Default)]
struct TeleprompterRecognitionState {
    session: std::sync::Mutex<Option<TeleprompterRecognitionSession>>,
    generation: std::sync::atomic::AtomicU64,
    next_session_id: std::sync::atomic::AtomicU64,
}

struct TeleprompterRecognitionSession {
    id: String,
    model_id: String,
    language: String,
    whisper: std::sync::Arc<teleprompter_whisper::WhisperSession>,
    cancelled: std::sync::Arc<std::sync::atomic::AtomicBool>,
}

#[derive(serde::Serialize)]
struct TeleprompterRecognitionResult {
    text: String,
    confidence: f32,
    model_id: String,
}

fn teleprompter_recognition_language(language: &str) -> Result<String, String> {
    match language.trim().to_ascii_lowercase().as_str() {
        "auto" => Ok("auto".to_string()),
        "zh" | "zh-cn" | "chinese" => Ok("zh".to_string()),
        "en" | "en-us" | "english" => Ok("en".to_string()),
        _ => Err("teleprompter:invalid-language".to_string()),
    }
}

fn cancel_teleprompter_session(session: &TeleprompterRecognitionSession) {
    session
        .cancelled
        .store(true, std::sync::atomic::Ordering::SeqCst);
}

#[tauri::command]
async fn start_teleprompter_recognition(
    state: tauri::State<'_, TeleprompterRecognitionState>,
    language: String,
) -> Result<String, String> {
    let language = teleprompter_recognition_language(&language)?;
    let config = read_transcription_model_config();
    let model_id = config
        .current_model
        .ok_or("transcription:model-not-installed".to_string())?;
    let model = transcription_model_spec(&model_id)?;
    let model_path =
        installed_model_file(model)?.ok_or("transcription:model-not-installed".to_string())?;
    let whisper_library = get_whisper_library_path()
        .map_err(|_| "teleprompter:engine-unavailable".to_string())?;
    let generation = state
        .generation
        .fetch_add(1, std::sync::atomic::Ordering::SeqCst)
        .saturating_add(1);
    let numeric_id = state
        .next_session_id
        .fetch_add(1, std::sync::atomic::Ordering::SeqCst)
        .saturating_add(1);
    let session_id = format!("teleprompter-{}-{}", std::process::id(), numeric_id);

    {
        let mut current = state
            .session
            .lock()
            .map_err(|_| "teleprompter:state-unavailable".to_string())?;
        if let Some(existing) = current.take() {
            cancel_teleprompter_session(&existing);
        }
    }

    let whisper = tokio::task::spawn_blocking(move || {
        teleprompter_whisper::WhisperSession::load(&whisper_library, &model_path)
    })
    .await
    .map_err(|_| "teleprompter:model-load-failed".to_string())??;

    if state.generation.load(std::sync::atomic::Ordering::SeqCst) != generation {
        return Err("teleprompter:stopped".to_string());
    }

    let cancelled = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    let mut current = state
        .session
        .lock()
        .map_err(|_| "teleprompter:state-unavailable".to_string())?;
    *current = Some(TeleprompterRecognitionSession {
        id: session_id.clone(),
        model_id,
        language,
        whisper: std::sync::Arc::new(whisper),
        cancelled,
    });
    Ok(session_id)
}

#[tauri::command]
async fn transcribe_teleprompter_audio(
    state: tauri::State<'_, TeleprompterRecognitionState>,
    session_id: String,
    samples: Vec<i16>,
    prompt: Option<String>,
) -> Result<TeleprompterRecognitionResult, String> {
    const MIN_SAMPLES: usize = 8_000;
    const MAX_SAMPLES: usize = 16_000 * 12;
    if session_id.trim().is_empty() || samples.len() < MIN_SAMPLES || samples.len() > MAX_SAMPLES {
        return Err("teleprompter:invalid-audio".to_string());
    }
    let (model_id, language, whisper, cancelled) = {
        let current = state
            .session
            .lock()
            .map_err(|_| "teleprompter:state-unavailable".to_string())?;
        let current = current
            .as_ref()
            .filter(|session| session.id == session_id)
            .ok_or("teleprompter:session-not-found".to_string())?;
        (
            current.model_id.clone(),
            current.language.clone(),
            current.whisper.clone(),
            current.cancelled.clone(),
        )
    };
    let prompt = prompt
        .unwrap_or_default()
        .chars()
        .filter(|character| !character.is_control() || matches!(character, '\n' | '\t'))
        .take(600)
        .collect::<String>();

    let inference_cancelled = cancelled.clone();
    let result = tokio::task::spawn_blocking(move || {
        if inference_cancelled.load(std::sync::atomic::Ordering::SeqCst) {
            return Err("teleprompter:stopped".to_string());
        }
        whisper.transcribe(samples, &language, &prompt, inference_cancelled)
    })
    .await
    .map_err(|_| "teleprompter:recognition-failed".to_string())??;

    let is_current = state
        .session
        .lock()
        .map_err(|_| "teleprompter:state-unavailable".to_string())?
        .as_ref()
        .is_some_and(|session| session.id == session_id && !session.cancelled.load(std::sync::atomic::Ordering::SeqCst));
    if !is_current {
        return Err("teleprompter:stopped".to_string());
    }
    Ok(TeleprompterRecognitionResult {
        text: result.text,
        confidence: result.confidence,
        model_id,
    })
}

#[tauri::command]
fn stop_teleprompter_recognition(
    state: tauri::State<'_, TeleprompterRecognitionState>,
    session_id: String,
) -> Result<(), String> {
    let mut current = state
        .session
        .lock()
        .map_err(|_| "teleprompter:state-unavailable".to_string())?;
    if current
        .as_ref()
        .is_some_and(|session| session.id == session_id)
    {
        if let Some(session) = current.take() {
            cancel_teleprompter_session(&session);
        }
        state
            .generation
            .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    }
    Ok(())
}

#[tauri::command]
fn list_transcription_models() -> Result<Vec<TranscriptionModelStatus>, String> {
    let config = read_transcription_model_config();
    TRANSCRIPTION_MODELS
        .iter()
        .map(|model| {
            let installed = installed_model_file(model)?.is_some();
            Ok(TranscriptionModelStatus {
                id: model.id.to_string(),
                display_name: model.display_name.to_string(),
                bytes: model.bytes,
                installed,
                current: installed && config.current_model.as_deref() == Some(model.id),
            })
        })
        .collect()
}

#[tauri::command]
fn set_current_transcription_model(model_id: String) -> Result<(), String> {
    let model = transcription_model_spec(&model_id)?;
    if installed_model_file(model)?.is_none() {
        return Err("Install this offline model before selecting it".to_string());
    }
    write_transcription_model_config(&TranscriptionModelConfig {
        current_model: Some(model.id.to_string()),
    })
}

#[tauri::command]
fn delete_transcription_model(model_id: String) -> Result<(), String> {
    let model = transcription_model_spec(&model_id)?;
    let path = transcription_model_path(model)?;
    let partial = path.with_extension("bin.part");
    if path.exists() {
        std::fs::remove_file(&path).map_err(|error| format!("Cannot delete model: {}", error))?;
    }
    if partial.exists() {
        let _ = std::fs::remove_file(partial);
    }
    let mut config = read_transcription_model_config();
    if config.current_model.as_deref() == Some(model.id) {
        config.current_model = None;
        write_transcription_model_config(&config)?;
    }
    Ok(())
}

#[tauri::command]
async fn download_transcription_model(
    app_handle: tauri::AppHandle,
    model_id: String,
    source: Option<String>,
) -> Result<ModelDownloadResult, String> {
    use std::io::Write;

    let _download_guard = begin_model_download()?;
    let model = transcription_model_spec(&model_id)?;
    let target = transcription_model_path(model)?;
    let parent = target.parent().ok_or("Invalid model directory")?;
    std::fs::create_dir_all(parent)
        .map_err(|error| format!("Cannot create model directory: {}", error))?;

    if let Some(existing) = installed_model_file(model)? {
        let expected = model.sha256.to_string();
        let verified = tokio::task::spawn_blocking(move || sha256_file(&existing))
            .await
            .map_err(|error| format!("Cannot verify model: {}", error))??;
        if verified == expected {
            let config = read_transcription_model_config();
            return Ok(ModelDownloadResult {
                model_id: model.id.to_string(),
                path: target.to_string_lossy().into_owned(),
                current: config.current_model.as_deref() == Some(model.id),
            });
        }
        let _ = std::fs::remove_file(&target);
    }

    let partial = target.with_extension("bin.part");
    let client = reqwest::Client::builder()
        .user_agent("ToolKnit/2.3.1 offline-model-manager")
        .build()
        .map_err(|error| format!("Cannot initialize model download: {}", error))?;
    let requested_source = source
        .as_deref()
        .unwrap_or("auto")
        .trim()
        .to_ascii_lowercase();
    let candidates: Vec<&str> = match requested_source.as_str() {
        "auto" => vec!["official", "china"],
        "official" | "china" => vec![requested_source.as_str()],
        _ => return Err("Unknown model download source".to_string()),
    };
    let mut last_error = None;
    for candidate in candidates {
        if CANCEL_MODEL_DOWNLOAD.load(Ordering::SeqCst) {
            return Err("dependency-download:cancelled".to_string());
        }
        // A failed stream may have extended the partial file. Read its size
        // again for every mirror attempt so the Range header stays correct.
        let mut resume_from = std::fs::metadata(&partial)
            .map(|metadata| metadata.len())
            .unwrap_or(0);
        if resume_from > model.bytes {
            let _ = std::fs::remove_file(&partial);
            resume_from = 0;
        }
        let url = transcription_model_source(model, Some(candidate))?;
        let mut request = client.get(url);
        if resume_from > 0 {
            request = request.header(reqwest::header::RANGE, format!("bytes={}-", resume_from));
        }
        let mut response = match request.send().await {
            Ok(candidate_response) if candidate_response.status().is_success() => {
                candidate_response
            }
            Ok(candidate_response) => {
                last_error = Some(format!("HTTP {}", candidate_response.status()));
                continue;
            }
            Err(error) => {
                last_error = Some(error.to_string());
                continue;
            }
        };
        let append = resume_from > 0 && response.status() == reqwest::StatusCode::PARTIAL_CONTENT;
        if !append && resume_from > 0 {
            resume_from = 0;
        }
        let mut downloaded = if append { resume_from } else { 0 };
        let mut output = std::fs::OpenOptions::new()
            .create(true)
            .write(true)
            .append(append)
            .truncate(!append)
            .open(&partial)
            .map_err(|error| format!("Cannot create model download: {}", error))?;
        let _ = app_handle.emit(
            "transcription-model-download-progress",
            ModelDownloadProgress {
                model_id: model.id.to_string(),
                downloaded_bytes: downloaded,
                total_bytes: model.bytes,
                phase: "downloading".to_string(),
            },
        );
        let stream_error = loop {
            if CANCEL_MODEL_DOWNLOAD.load(Ordering::SeqCst) {
                output
                    .sync_all()
                    .map_err(|error| format!("Cannot preserve model download: {}", error))?;
                return Err("dependency-download:cancelled".to_string());
            }
            match response.chunk().await {
                Ok(Some(chunk)) => {
                    let next_downloaded = downloaded.saturating_add(chunk.len() as u64);
                    if next_downloaded > model.bytes {
                        break Some(
                            "Downloaded model is larger than the expected package".to_string(),
                        );
                    }
                    output
                        .write_all(&chunk)
                        .map_err(|error| format!("Cannot write model download: {}", error))?;
                    downloaded = next_downloaded;
                    let _ = app_handle.emit(
                        "transcription-model-download-progress",
                        ModelDownloadProgress {
                            model_id: model.id.to_string(),
                            downloaded_bytes: downloaded,
                            total_bytes: model.bytes,
                            phase: "downloading".to_string(),
                        },
                    );
                }
                Ok(None) => break None,
                Err(error) => break Some(error.to_string()),
            }
        };
        output
            .sync_all()
            .map_err(|error| format!("Cannot finalize model download: {}", error))?;
        drop(output);
        if let Some(error) = stream_error {
            last_error = Some(format!("Model download interrupted: {}", error));
            continue;
        }
        if downloaded != model.bytes {
            if downloaded >= model.bytes {
                let _ = std::fs::remove_file(&partial);
            }
            last_error =
                Some("Downloaded model size does not match the expected package".to_string());
            continue;
        }
        let _ = app_handle.emit(
            "transcription-model-download-progress",
            ModelDownloadProgress {
                model_id: model.id.to_string(),
                downloaded_bytes: downloaded,
                total_bytes: model.bytes,
                phase: "verifying".to_string(),
            },
        );
        let path_for_hash = partial.clone();
        let actual_hash = tokio::task::spawn_blocking(move || sha256_file(&path_for_hash))
            .await
            .map_err(|error| format!("Cannot verify model: {}", error))??;
        if actual_hash != model.sha256 {
            let _ = std::fs::remove_file(&partial);
            last_error =
                Some("Model integrity check failed. The incomplete file was removed.".to_string());
            continue;
        }
        if target.exists() {
            let _ = std::fs::remove_file(&target);
        }
        std::fs::rename(&partial, &target)
            .map_err(|error| format!("Cannot install model: {}", error))?;

        let mut config = read_transcription_model_config();
        if config.current_model.is_none() || model.id == "small" {
            config.current_model = Some(model.id.to_string());
            write_transcription_model_config(&config)?;
        }
        let current = config.current_model.as_deref() == Some(model.id);
        let _ = app_handle.emit(
            "transcription-model-download-progress",
            ModelDownloadProgress {
                model_id: model.id.to_string(),
                downloaded_bytes: model.bytes,
                total_bytes: model.bytes,
                phase: "complete".to_string(),
            },
        );
        return Ok(ModelDownloadResult {
            model_id: model.id.to_string(),
            path: target.to_string_lossy().into_owned(),
            current,
        });
    }
    Err(format!(
        "Cannot download model: {}",
        last_error.unwrap_or_else(|| "unknown error".to_string())
    ))
}

#[derive(serde::Serialize)]
struct TranscriptionResult {
    model_id: String,
    raw_json_path: String,
    raw_srt_path: String,
    raw_txt_path: String,
}

#[derive(Clone, serde::Serialize)]
struct TranscriptionProgress {
    phase: String,
    progress: u8,
}

fn transcription_input_path(input_path: &str) -> Result<std::path::PathBuf, String> {
    const SUPPORTED_EXTENSIONS: &[&str] = &[
        "mp3", "aac", "m4a", "wav", "flac", "alac", "ogg", "wma", "mp4", "mkv", "avi", "mov",
        "webm", "flv", "wmv", "ts",
    ];
    if input_path.trim().is_empty() || input_path.contains('\0') {
        return Err("transcription:invalid-input".to_string());
    }
    let path = std::path::PathBuf::from(input_path)
        .canonicalize()
        .map_err(|_| "transcription:input-not-found".to_string())?;
    let metadata =
        std::fs::metadata(&path).map_err(|_| "transcription:input-not-found".to_string())?;
    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    if !metadata.is_file()
        || metadata.len() == 0
        || metadata.len() > 10 * 1024 * 1024 * 1024
        || !SUPPORTED_EXTENSIONS.contains(&extension.as_str())
    {
        return Err("transcription:invalid-input".to_string());
    }
    Ok(path)
}

fn transcription_output_dir(output_dir: &str) -> Result<std::path::PathBuf, String> {
    if output_dir.trim().is_empty() || output_dir.contains('\0') {
        return Err("transcription:invalid-output".to_string());
    }
    let path = std::path::PathBuf::from(output_dir);
    is_path_safe(&path).map_err(|_| "transcription:invalid-output".to_string())?;
    std::fs::create_dir_all(&path).map_err(|_| "transcription:invalid-output".to_string())?;
    let path = path
        .canonicalize()
        .map_err(|_| "transcription:invalid-output".to_string())?;
    is_path_safe(&path).map_err(|_| "transcription:invalid-output".to_string())?;
    Ok(path)
}

fn transcription_language(language: &str) -> Result<&str, String> {
    match language.trim().to_ascii_lowercase().as_str() {
        "auto" => Ok("auto"),
        "zh" | "zh-cn" | "chinese" => Ok("zh"),
        "en" | "en-us" | "english" => Ok("en"),
        _ => Err("transcription:invalid-language".to_string()),
    }
}

fn transcription_output_stem(input: &std::path::Path) -> String {
    let stem = input
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("transcript");
    let normalized: String = stem
        .chars()
        .map(|character| {
            if matches!(
                character,
                '\\' | '/' | ':' | '*' | '?' | '"' | '<' | '>' | '|' | '\0'
            ) || character.is_control()
            {
                '_'
            } else {
                character
            }
        })
        .collect();
    let normalized = normalized.trim().trim_end_matches('.').trim_end();
    if normalized.is_empty() {
        "transcript".to_string()
    } else {
        normalized.chars().take(96).collect()
    }
}

fn create_transcription_temp_dir(
    output_dir: &std::path::Path,
) -> Result<std::path::PathBuf, String> {
    for _ in 0..10_000 {
        let id = TRANSCRIPTION_TEMP_ID.fetch_add(1, Ordering::SeqCst);
        let candidate = output_dir.join(format!(
            ".toolknit-transcription-{}-{}",
            std::process::id(),
            id
        ));
        match std::fs::create_dir(&candidate) {
            Ok(()) => return Ok(candidate),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(_) => return Err("transcription:invalid-output".to_string()),
        }
    }
    Err("transcription:invalid-output".to_string())
}

async fn run_transcription_command(
    command: &std::path::Path,
    arguments: &[std::ffi::OsString],
) -> Result<std::process::Output, String> {
    let mut process = tokio::process::Command::new(command);
    process
        .args(arguments)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    #[cfg(target_os = "windows")]
    {
        process.creation_flags(0x08000000);
    }
    let child = process
        .spawn()
        .map_err(|_| "transcription:engine-failed".to_string())?;
    CURRENT_CHILD_ID.store(child.id().unwrap_or(0), Ordering::SeqCst);
    let output = child
        .wait_with_output()
        .await
        .map_err(|_| "transcription:engine-failed".to_string())?;
    CURRENT_CHILD_ID.store(0, Ordering::SeqCst);
    if CANCEL_FLAG.load(Ordering::SeqCst) {
        return Err("transcription:cancelled".to_string());
    }
    Ok(output)
}

// Whisper models occasionally answer spoken Mandarin in traditional
// characters. Transcription outputs are rewritten to simplified so the
// published files match what Chinese users expect to edit and share.
fn simplify_char(character: char) -> char {
    match character {
        '艦' => '舰',
        '彙' | '匯' => '汇',
        '級' => '级',
        '創' => '创',
        '業' => '业',
        '實' => '实',
        '現' => '现',
        '點' => '点',
        '間' => '间',
        '時' => '时',
        '為' => '为',
        '會' => '会',
        '後' => '后',
        '裡' => '里',
        '這' => '这',
        '說' => '说',
        '對' => '对',
        '開' => '开',
        '關' => '关',
        '們' => '们',
        '從' => '从',
        '見' => '见',
        '車' => '车',
        '電' => '电',
        '動' => '动',
        '應' => '应',
        '話' => '话',
        '語' => '语',
        '讓' => '让',
        '體' => '体',
        '學' => '学',
        '將' => '将',
        '與' => '与',
        '於' => '于',
        '來' => '来',
        '內' => '内',
        '無' => '无',
        '節' => '节',
        '專' => '专',
        '號' => '号',
        '當' => '当',
        '處' => '处',
        '屬' => '属',
        '據' => '据',
        '備' => '备',
        '質' => '质',
        '資' => '资',
        '費' => '费',
        '環' => '环',
        '聲' => '声',
        '響' => '响',
        '顯' => '显',
        '飛' => '飞',
        '機' => '机',
        '構' => '构',
        '標' => '标',
        '統' => '统',
        '斷' => '断',
        '邊' => '边',
        '變' => '变',
        '輸' => '输',
        '轉' => '转',
        '連' => '连',
        '運' => '运',
        '進' => '进',
        '遠' => '远',
        '適' => '适',
        '選' => '选',
        '錄' => '录',
        '鍵' => '键',
        '盤' => '盘',
        '壓' => '压',
        '縮' => '缩',
        '織' => '织',
        '經' => '经',
        '濟' => '济',
        '廣' => '广',
        '滅' => '灭',
        '營' => '营',
        '藝' => '艺',
        '觀' => '观',
        '釋' => '释',
        '鏡' => '镜',
        '錯' => '错',
        '長' => '长',
        '門' => '门',
        '問' => '问',
        '單' => '单',
        '嚴' => '严',
        '優' => '优',
        '強' => '强',
        '獲' => '获',
        '證' => '证',
        '護' => '护',
        '觸' => '触',
        '覺' => '觉',
        other => other,
    }
}

fn simplify_chinese_text(input: &str) -> String {
    input.chars().map(simplify_char).collect()
}

fn simplify_transcription_outputs(temp_dir: &std::path::Path) -> Result<(), String> {
    for name in ["transcript.json", "transcript.srt", "transcript.txt"] {
        let path = temp_dir.join(name);
        let content = std::fs::read_to_string(&path)
            .map_err(|error| format!("Cannot read transcription output: {error}"))?;
        let simplified = simplify_chinese_text(&content);
        if simplified != content {
            std::fs::write(&path, simplified)
                .map_err(|error| format!("Cannot update transcription output: {error}"))?;
        }
    }
    Ok(())
}

fn publish_transcription_outputs(
    temp_dir: &std::path::Path,
    output_dir: &std::path::Path,
    stem: &str,
) -> Result<(std::path::PathBuf, std::path::PathBuf, std::path::PathBuf), String> {
    let source_json = temp_dir.join("transcript.json");
    let source_srt = temp_dir.join("transcript.srt");
    let source_txt = temp_dir.join("transcript.txt");
    if !source_json.is_file() || !source_srt.is_file() || !source_txt.is_file() {
        return Err("transcription:engine-failed".to_string());
    }
    for index in 0..10_000_u32 {
        let suffix = if index == 0 {
            String::new()
        } else {
            format!("_{}", index)
        };
        let json = output_dir.join(format!("{}_transcript{}.json", stem, suffix));
        let srt = output_dir.join(format!("{}_transcript{}.srt", stem, suffix));
        let txt = output_dir.join(format!("{}_transcript{}.txt", stem, suffix));
        if json.exists() || srt.exists() || txt.exists() {
            continue;
        }
        if std::fs::hard_link(&source_json, &json).is_err() {
            continue;
        }
        if std::fs::hard_link(&source_srt, &srt).is_err() {
            let _ = std::fs::remove_file(&json);
            continue;
        }
        if std::fs::hard_link(&source_txt, &txt).is_err() {
            let _ = std::fs::remove_file(&json);
            let _ = std::fs::remove_file(&srt);
            continue;
        }
        return Ok((json, srt, txt));
    }
    Err("transcription:invalid-output".to_string())
}

#[tauri::command]
async fn transcribe_media(
    app_handle: tauri::AppHandle,
    input_path: String,
    output_dir: String,
    language: String,
) -> Result<TranscriptionResult, String> {
    let _conversion_guard = begin_conversion()?;
    let input = transcription_input_path(&input_path)?;
    let output_dir = transcription_output_dir(&output_dir)?;
    let language = transcription_language(&language)?;
    let config = read_transcription_model_config();
    let model_id = config
        .current_model
        .ok_or("transcription:model-not-installed".to_string())?;
    let model = transcription_model_spec(&model_id)?;
    let model_path =
        installed_model_file(model)?.ok_or("transcription:model-not-installed".to_string())?;
    let ffmpeg = get_ffmpeg_path().map_err(|_| "transcription:ffmpeg-unavailable".to_string())?;
    let whisper =
        get_whisper_cli_path().map_err(|_| "transcription:engine-unavailable".to_string())?;
    let temp_dir = create_transcription_temp_dir(&output_dir)?;
    let wav = temp_dir.join("input.wav");
    let _ = app_handle.emit(
        "transcription-progress",
        TranscriptionProgress {
            phase: "preparing".to_string(),
            progress: 5,
        },
    );

    let ffmpeg_args = vec![
        std::ffi::OsString::from("-hide_banner"),
        std::ffi::OsString::from("-nostdin"),
        std::ffi::OsString::from("-y"),
        std::ffi::OsString::from("-i"),
        input.as_os_str().to_os_string(),
        std::ffi::OsString::from("-vn"),
        std::ffi::OsString::from("-ac"),
        std::ffi::OsString::from("1"),
        std::ffi::OsString::from("-ar"),
        std::ffi::OsString::from("16000"),
        std::ffi::OsString::from("-c:a"),
        std::ffi::OsString::from("pcm_s16le"),
        wav.as_os_str().to_os_string(),
    ];
    let prepared = run_transcription_command(&ffmpeg, &ffmpeg_args).await?;
    if !prepared.status.success() || !wav.is_file() {
        let _ = std::fs::remove_dir_all(&temp_dir);
        return Err("transcription:prepare-failed".to_string());
    }
    let _ = app_handle.emit(
        "transcription-progress",
        TranscriptionProgress {
            phase: "transcribing".to_string(),
            progress: 15,
        },
    );
    let whisper_args = vec![
        std::ffi::OsString::from("-m"),
        model_path.as_os_str().to_os_string(),
        std::ffi::OsString::from("-f"),
        wav.as_os_str().to_os_string(),
        std::ffi::OsString::from("-l"),
        std::ffi::OsString::from(language),
        std::ffi::OsString::from("-otxt"),
        std::ffi::OsString::from("-osrt"),
        std::ffi::OsString::from("-oj"),
        std::ffi::OsString::from("-ojf"),
        std::ffi::OsString::from("-np"),
        std::ffi::OsString::from("-of"),
        temp_dir.join("transcript").as_os_str().to_os_string(),
    ];
    let transcribed = run_transcription_command(&whisper, &whisper_args).await?;
    if !transcribed.status.success() {
        let _ = std::fs::remove_dir_all(&temp_dir);
        return Err("transcription:engine-failed".to_string());
    }
    let _ = app_handle.emit(
        "transcription-progress",
        TranscriptionProgress {
            phase: "publishing".to_string(),
            progress: 95,
        },
    );
    simplify_transcription_outputs(&temp_dir)?;
    let stem = transcription_output_stem(&input);
    let published = publish_transcription_outputs(&temp_dir, &output_dir, &stem);
    let _ = std::fs::remove_dir_all(&temp_dir);
    let (raw_json_path, raw_srt_path, raw_txt_path) = published?;
    let _ = app_handle.emit(
        "transcription-progress",
        TranscriptionProgress {
            phase: "complete".to_string(),
            progress: 100,
        },
    );
    Ok(TranscriptionResult {
        model_id: model.id.to_string(),
        raw_json_path: raw_json_path.to_string_lossy().into_owned(),
        raw_srt_path: raw_srt_path.to_string_lossy().into_owned(),
        raw_txt_path: raw_txt_path.to_string_lossy().into_owned(),
    })
}

const PDF_DECRYPT_MAX_INPUT_BYTES: u64 = 150 * 1024 * 1024;
const PDF_DECRYPT_MAX_PAGES: u32 = 200;
const PDF_ENCRYPT_MAX_INPUT_BYTES: u64 = 150 * 1024 * 1024;
const PDF_ENCRYPT_MAX_PAGES: u32 = 200;
const PDF_ENCRYPT_MIN_PASSWORD_CHARS: usize = 8;
const PDF_ENCRYPT_MAX_PASSWORD_BYTES: usize = 127;
const PDF_COMPRESS_MAX_INPUT_BYTES: u64 = 150 * 1024 * 1024;
const PDF_COMPRESS_MAX_PAGES: u32 = 500;
const QPDF_PROCESS_TIMEOUT_SECS: u64 = 120;

fn get_qpdf_path() -> Result<std::path::PathBuf, String> {
    let exe_name = if cfg!(target_os = "windows") {
        "qpdf.exe"
    } else {
        "qpdf"
    };
    let exe = std::env::current_exe().map_err(|_| "pdf-decrypt:qpdf-unavailable".to_string())?;
    let exe_dir = exe.parent().ok_or("pdf-decrypt:qpdf-unavailable")?;
    let bundled = exe_dir.join("resources").join("qpdf").join(exe_name);
    if bundled.exists() {
        return Ok(bundled);
    }

    // Tauri dev and direct Rust checks run outside the packaged resources directory.
    let source_resource = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("resources")
        .join("qpdf")
        .join(exe_name);
    if source_resource.exists() {
        return Ok(source_resource);
    }

    Err("pdf-decrypt:qpdf-unavailable".to_string())
}

fn clear_pdf_password(password: &mut String) {
    use zeroize::Zeroize;
    password.zeroize();
}

async fn run_qpdf_with_stdin(
    qpdf_path: &std::path::Path,
    args: &[std::ffi::OsString],
    stdin_data: Option<&[u8]>,
    capture_stdout: bool,
    failure_code: &str,
) -> Result<std::process::Output, String> {
    use tokio::io::AsyncWriteExt;

    let mut command = tokio::process::Command::new(qpdf_path);
    command
        .args(args)
        .kill_on_drop(true)
        .stdin(if stdin_data.is_some() {
            std::process::Stdio::piped()
        } else {
            std::process::Stdio::null()
        })
        .stdout(if capture_stdout {
            std::process::Stdio::piped()
        } else {
            std::process::Stdio::null()
        })
        .stderr(std::process::Stdio::piped());

    #[cfg(target_os = "windows")]
    {
        command.creation_flags(0x08000000);
    }

    let mut child = command
        .spawn()
        .map_err(|_| failure_code.to_string())?;
    if let Some(value) = stdin_data {
        let mut stdin = child.stdin.take().ok_or_else(|| failure_code.to_string())?;
        stdin
            .write_all(value)
            .await
            .map_err(|_| failure_code.to_string())?;
        stdin
            .shutdown()
            .await
            .map_err(|_| failure_code.to_string())?;
    }
    tokio::time::timeout(
        std::time::Duration::from_secs(QPDF_PROCESS_TIMEOUT_SECS),
        child.wait_with_output(),
    )
    .await
    .map_err(|_| failure_code.to_string())?
    .map_err(|_| failure_code.to_string())
}

async fn run_qpdf(
    qpdf_path: &std::path::Path,
    args: &[std::ffi::OsString],
    password: Option<&str>,
) -> Result<std::process::Output, String> {
    use zeroize::Zeroize;

    let mut stdin_data = password.map(|value| {
        let mut bytes = Vec::with_capacity(value.len() + 1);
        bytes.extend_from_slice(value.as_bytes());
        bytes.push(b'\n');
        bytes
    });
    let result = run_qpdf_with_stdin(
        qpdf_path,
        args,
        stdin_data.as_deref(),
        true,
        "pdf-decrypt:decryption-failed",
    )
    .await;
    if let Some(bytes) = stdin_data.as_mut() {
        bytes.zeroize();
    }
    result
}

fn create_pdf_decrypt_file_name(input_path: &std::path::Path) -> String {
    let raw_stem = input_path
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("document");
    let sanitized: String = raw_stem
        .chars()
        .map(|character| {
            if matches!(
                character,
                '\\' | '/' | ':' | '*' | '?' | '"' | '<' | '>' | '|'
            ) {
                '_'
            } else {
                character
            }
        })
        .collect();
    let trimmed = sanitized
        .trim()
        .trim_end_matches(|character| character == '.' || character == ' ');
    let stem = if trimmed.is_empty() {
        "document"
    } else {
        trimmed
    };
    format!("{}_decrypted.pdf", stem)
}

fn create_pdf_decrypt_temp_path(
    output_dir: &std::path::Path,
) -> Result<std::path::PathBuf, String> {
    use std::time::{SystemTime, UNIX_EPOCH};

    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| "pdf-decrypt:decryption-failed".to_string())?
        .as_nanos();
    for _ in 0..100 {
        let id = PDF_DECRYPT_TEMP_ID.fetch_add(1, Ordering::Relaxed);
        let candidate = output_dir.join(format!(
            ".toolknit-decrypt-{}-{}-{}.pdf",
            std::process::id(),
            timestamp,
            id
        ));
        if !candidate.exists() {
            return Ok(candidate);
        }
    }
    Err("pdf-decrypt:decryption-failed".to_string())
}

fn publish_pdf_decrypt_output(
    temporary_path: &std::path::Path,
    output_dir: &std::path::Path,
    file_name: &str,
) -> Result<String, String> {
    let source = std::path::Path::new(file_name);
    let stem = source
        .file_stem()
        .and_then(|value| value.to_str())
        .ok_or("pdf-decrypt:decryption-failed")?;
    let extension = source
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("pdf");

    for counter in 0..10_000_u32 {
        let candidate_name = if counter == 0 {
            file_name.to_string()
        } else {
            format!("{}_{}.{}", stem, counter, extension)
        };
        let candidate = output_dir.join(candidate_name);
        match std::fs::hard_link(temporary_path, &candidate) {
            Ok(()) => {
                std::fs::remove_file(temporary_path)
                    .map_err(|_| "pdf-decrypt:decryption-failed".to_string())?;
                return Ok(candidate.to_string_lossy().into_owned());
            }
            Err(_) if candidate.exists() => continue,
            Err(_) => return Err("pdf-decrypt:decryption-failed".to_string()),
        }
    }
    Err("pdf-decrypt:decryption-failed".to_string())
}

fn map_qpdf_decrypt_error(output: &std::process::Output) -> String {
    let details = String::from_utf8_lossy(&output.stderr).to_ascii_lowercase();
    if details.contains("invalid password") || details.contains("password supplied is incorrect") {
        "pdf-decrypt:invalid-password".to_string()
    } else if details.contains("not a pdf")
        || details.contains("damaged pdf")
        || details.contains("can't find pdf header")
    {
        "pdf-decrypt:invalid-pdf".to_string()
    } else {
        "pdf-decrypt:decryption-failed".to_string()
    }
}

#[tauri::command]
async fn decrypt_pdf(
    input_path: String,
    mut password: String,
    output_dir: Option<String>,
) -> Result<String, String> {
    let result = decrypt_pdf_inner(&input_path, &password, output_dir.as_deref()).await;
    clear_pdf_password(&mut password);
    result
}

async fn decrypt_pdf_inner(
    input_path: &str,
    password: &str,
    requested_output_dir: Option<&str>,
) -> Result<String, String> {
    let input = std::path::Path::new(&input_path);
    if input_path.contains('\0')
        || !input.is_file()
        || !input
            .extension()
            .and_then(|value| value.to_str())
            .is_some_and(|value| value.eq_ignore_ascii_case("pdf"))
    {
        return Err("pdf-decrypt:invalid-pdf".to_string());
    }
    let metadata = std::fs::metadata(input).map_err(|_| "pdf-decrypt:invalid-pdf".to_string())?;
    if metadata.len() > PDF_DECRYPT_MAX_INPUT_BYTES {
        return Err("pdf-decrypt:input-too-large".to_string());
    }

    let qpdf_path = get_qpdf_path()?;
    let output_dir = requested_output_dir
        .filter(|value| !value.trim().is_empty() && !value.contains('\0'))
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|| {
            dirs::document_dir()
                .unwrap_or_default()
                .join("ToolKnit")
                .join("PDF_Decrypt")
        });
    is_path_safe(&output_dir).map_err(|_| "pdf-decrypt:output-path".to_string())?;
    std::fs::create_dir_all(&output_dir)
        .map_err(|_| "pdf-decrypt:decryption-failed".to_string())?;
    is_path_safe(&output_dir).map_err(|_| "pdf-decrypt:output-path".to_string())?;
    let temporary_path = create_pdf_decrypt_temp_path(&output_dir)?;

    let mut decrypt_args = vec![
        std::ffi::OsString::from("--warning-exit-0"),
        std::ffi::OsString::from("--decrypt"),
        input.as_os_str().to_os_string(),
        temporary_path.as_os_str().to_os_string(),
    ];
    let use_password_pipe = !password.is_empty();
    if use_password_pipe {
        decrypt_args.insert(1, std::ffi::OsString::from("--password-file=-"));
    }
    let result = run_qpdf(
        &qpdf_path,
        &decrypt_args,
        if use_password_pipe {
            Some(password)
        } else {
            None
        },
    )
    .await;
    let output = result?;
    if !output.status.success() {
        let _ = std::fs::remove_file(&temporary_path);
        return Err(map_qpdf_decrypt_error(&output));
    }

    let page_output = run_qpdf(
        &qpdf_path,
        &[
            std::ffi::OsString::from("--show-npages"),
            temporary_path.as_os_str().to_os_string(),
        ],
        None,
    )
    .await?;
    let page_count = String::from_utf8_lossy(&page_output.stdout)
        .trim()
        .parse::<u32>()
        .ok();
    if !page_output.status.success() || !matches!(page_count, Some(1..=PDF_DECRYPT_MAX_PAGES)) {
        let _ = std::fs::remove_file(&temporary_path);
        return Err(
            if page_count.is_some_and(|count| count > PDF_DECRYPT_MAX_PAGES) {
                "pdf-decrypt:too-many-pages".to_string()
            } else {
                "pdf-decrypt:invalid-pdf".to_string()
            },
        );
    }

    publish_pdf_decrypt_output(
        &temporary_path,
        &output_dir,
        &create_pdf_decrypt_file_name(input),
    )
}

#[derive(Clone, serde::Deserialize)]
#[serde(untagged)]
enum PdfEncryptPrintingPermission {
    Enabled(bool),
    Quality(String),
}

impl Default for PdfEncryptPrintingPermission {
    fn default() -> Self {
        Self::Enabled(true)
    }
}

#[derive(Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct PdfEncryptPermissions {
    #[serde(default)]
    printing: PdfEncryptPrintingPermission,
    #[serde(default = "pdf_encrypt_permission_default")]
    modifying: bool,
    #[serde(default = "pdf_encrypt_permission_default")]
    copying: bool,
    #[serde(default = "pdf_encrypt_permission_default")]
    annotating: bool,
    #[serde(default = "pdf_encrypt_permission_default")]
    filling_forms: bool,
    #[serde(default = "pdf_encrypt_permission_default")]
    content_accessibility: bool,
    #[serde(default = "pdf_encrypt_permission_default")]
    document_assembly: bool,
}

fn pdf_encrypt_permission_default() -> bool {
    true
}

fn validate_pdf_encrypt_password(password: &str) -> Result<(), String> {
    if password.chars().count() < PDF_ENCRYPT_MIN_PASSWORD_CHARS {
        return Err("pdf-encrypt:password-too-short".to_string());
    }
    if password.len() > PDF_ENCRYPT_MAX_PASSWORD_BYTES {
        return Err("pdf-encrypt:password-too-long".to_string());
    }
    if password
        .chars()
        .any(|character| matches!(character, '\0' | '\r' | '\n'))
    {
        return Err("pdf-encrypt:password-unsupported".to_string());
    }
    invalidate_ffmpeg_runtime_cache();
    Ok(())
}

fn pdf_encrypt_print_option(
    permission: &PdfEncryptPrintingPermission,
) -> Result<&'static str, String> {
    match permission {
        PdfEncryptPrintingPermission::Enabled(true) => Ok("full"),
        PdfEncryptPrintingPermission::Enabled(false) => Ok("none"),
        PdfEncryptPrintingPermission::Quality(value) if value == "highResolution" => Ok("full"),
        PdfEncryptPrintingPermission::Quality(value) if value == "lowResolution" => Ok("low"),
        _ => Err("pdf-encrypt:invalid-permissions".to_string()),
    }
}

fn pdf_encrypt_yes_no(value: bool) -> &'static str {
    if value {
        "y"
    } else {
        "n"
    }
}

fn validate_pdf_encrypt_argument(value: &str, error_code: &str) -> Result<(), String> {
    if value
        .chars()
        .any(|character| matches!(character, '\0' | '\r' | '\n'))
    {
        Err(error_code.to_string())
    } else {
        Ok(())
    }
}

fn append_pdf_encrypt_argument(
    payload: &mut Vec<u8>,
    value: &str,
    error_code: &str,
) -> Result<(), String> {
    validate_pdf_encrypt_argument(value, error_code)?;
    payload.extend_from_slice(value.as_bytes());
    payload.push(b'\n');
    Ok(())
}

fn append_pdf_encrypt_option(
    payload: &mut Vec<u8>,
    prefix: &str,
    value: &str,
    error_code: &str,
) -> Result<(), String> {
    validate_pdf_encrypt_argument(value, error_code)?;
    payload.extend_from_slice(prefix.as_bytes());
    payload.extend_from_slice(value.as_bytes());
    payload.push(b'\n');
    Ok(())
}

fn create_pdf_encrypt_owner_password() -> Result<String, String> {
    use std::fmt::Write;
    use zeroize::Zeroize;

    let mut random_bytes = [0_u8; 32];
    getrandom::getrandom(&mut random_bytes)
        .map_err(|_| "pdf-encrypt:encryption-failed".to_string())?;
    let mut password = String::with_capacity(random_bytes.len() * 2);
    for byte in &random_bytes {
        write!(&mut password, "{:02x}", byte)
            .map_err(|_| "pdf-encrypt:encryption-failed".to_string())?;
    }
    random_bytes.zeroize();
    Ok(password)
}

fn create_pdf_encrypt_file_name(input_path: &std::path::Path) -> String {
    let raw_stem = input_path
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("document");
    let sanitized: String = raw_stem
        .chars()
        .map(|character| {
            if matches!(
                character,
                '\\' | '/' | ':' | '*' | '?' | '"' | '<' | '>' | '|'
            ) {
                '_'
            } else {
                character
            }
        })
        .collect();
    let trimmed = sanitized
        .trim()
        .trim_end_matches(|character| character == '.' || character == ' ');
    let stem = if trimmed.is_empty() {
        "document"
    } else {
        trimmed
    };
    format!("{}_encrypted.pdf", stem)
}

fn create_pdf_encrypt_temp_path(
    output_dir: &std::path::Path,
) -> Result<std::path::PathBuf, String> {
    use std::time::{SystemTime, UNIX_EPOCH};

    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| "pdf-encrypt:encryption-failed".to_string())?
        .as_nanos();
    for _ in 0..100 {
        let id = PDF_DECRYPT_TEMP_ID.fetch_add(1, Ordering::Relaxed);
        let candidate = output_dir.join(format!(
            ".toolknit-encrypt-{}-{}-{}.pdf",
            std::process::id(),
            timestamp,
            id
        ));
        if !candidate.exists() {
            return Ok(candidate);
        }
    }
    Err("pdf-encrypt:encryption-failed".to_string())
}

fn publish_pdf_encrypt_output(
    temporary_path: &std::path::Path,
    output_dir: &std::path::Path,
    file_name: &str,
) -> Result<String, String> {
    let source = std::path::Path::new(file_name);
    let stem = source
        .file_stem()
        .and_then(|value| value.to_str())
        .ok_or("pdf-encrypt:encryption-failed")?;

    for counter in 0..10_000_u32 {
        let candidate_name = if counter == 0 {
            file_name.to_string()
        } else {
            format!("{}_{}.pdf", stem, counter)
        };
        let candidate = output_dir.join(candidate_name);
        match std::fs::hard_link(temporary_path, &candidate) {
            Ok(()) => {
                std::fs::remove_file(temporary_path)
                    .map_err(|_| "pdf-encrypt:encryption-failed".to_string())?;
                return Ok(candidate.to_string_lossy().into_owned());
            }
            Err(_) if candidate.exists() => continue,
            Err(_) => return Err("pdf-encrypt:encryption-failed".to_string()),
        }
    }
    Err("pdf-encrypt:encryption-failed".to_string())
}

fn map_qpdf_encrypt_error(output: &std::process::Output) -> String {
    let details = String::from_utf8_lossy(&output.stderr).to_ascii_lowercase();
    if details.contains("invalid password")
        || details.contains("password supplied is incorrect")
        || details.contains("encrypted file")
    {
        "pdf-encrypt:password-protected".to_string()
    } else if details.contains("not a pdf")
        || details.contains("damaged pdf")
        || details.contains("can't find pdf header")
    {
        "pdf-encrypt:invalid-pdf".to_string()
    } else {
        "pdf-encrypt:encryption-failed".to_string()
    }
}

fn build_pdf_encrypt_qpdf_arguments(
    input: &std::path::Path,
    temporary_path: &std::path::Path,
    password: &str,
    owner_password: &str,
    permissions: &PdfEncryptPermissions,
) -> Result<Vec<u8>, String> {
    input
        .to_str()
        .ok_or("pdf-encrypt:invalid-pdf".to_string())?;
    temporary_path
        .to_str()
        .ok_or("pdf-encrypt:output-path".to_string())?;
    let input = cleanup_display_path(input);
    let output = cleanup_display_path(temporary_path);
    let print = pdf_encrypt_print_option(&permissions.printing)?;
    let mut payload = Vec::with_capacity(input.len() + output.len() + password.len() + 512);
    append_pdf_encrypt_argument(&mut payload, "--warning-exit-0", "pdf-encrypt:encryption-failed")?;
    append_pdf_encrypt_argument(&mut payload, "--password-mode=unicode", "pdf-encrypt:encryption-failed")?;
    append_pdf_encrypt_argument(&mut payload, "--encrypt", "pdf-encrypt:encryption-failed")?;
    append_pdf_encrypt_option(
        &mut payload,
        "--user-password=",
        password,
        "pdf-encrypt:password-unsupported",
    )?;
    append_pdf_encrypt_option(
        &mut payload,
        "--owner-password=",
        owner_password,
        "pdf-encrypt:encryption-failed",
    )?;
    append_pdf_encrypt_argument(&mut payload, "--bits=256", "pdf-encrypt:encryption-failed")?;
    append_pdf_encrypt_option(&mut payload, "--print=", print, "pdf-encrypt:invalid-permissions")?;
    append_pdf_encrypt_option(
        &mut payload,
        "--extract=",
        pdf_encrypt_yes_no(permissions.copying),
        "pdf-encrypt:invalid-permissions",
    )?;
    append_pdf_encrypt_option(
        &mut payload,
        "--modify-other=",
        pdf_encrypt_yes_no(permissions.modifying),
        "pdf-encrypt:invalid-permissions",
    )?;
    append_pdf_encrypt_option(
        &mut payload,
        "--annotate=",
        pdf_encrypt_yes_no(permissions.annotating),
        "pdf-encrypt:invalid-permissions",
    )?;
    append_pdf_encrypt_option(
        &mut payload,
        "--form=",
        pdf_encrypt_yes_no(permissions.filling_forms),
        "pdf-encrypt:invalid-permissions",
    )?;
    append_pdf_encrypt_option(
        &mut payload,
        "--accessibility=",
        pdf_encrypt_yes_no(permissions.content_accessibility),
        "pdf-encrypt:invalid-permissions",
    )?;
    append_pdf_encrypt_option(
        &mut payload,
        "--assemble=",
        pdf_encrypt_yes_no(permissions.document_assembly),
        "pdf-encrypt:invalid-permissions",
    )?;
    append_pdf_encrypt_argument(&mut payload, "--", "pdf-encrypt:encryption-failed")?;
    append_pdf_encrypt_argument(&mut payload, &input, "pdf-encrypt:invalid-pdf")?;
    append_pdf_encrypt_argument(&mut payload, &output, "pdf-encrypt:output-path")?;
    Ok(payload)
}

#[tauri::command]
async fn encrypt_pdf(
    input_path: String,
    mut password: String,
    permissions: PdfEncryptPermissions,
    output_dir: Option<String>,
) -> Result<String, String> {
    let result = encrypt_pdf_inner(
        &input_path,
        &password,
        &permissions,
        output_dir.as_deref(),
    )
    .await;
    clear_pdf_password(&mut password);
    result
}

async fn encrypt_pdf_inner(
    input_path: &str,
    password: &str,
    permissions: &PdfEncryptPermissions,
    requested_output_dir: Option<&str>,
) -> Result<String, String> {
    use zeroize::Zeroize;

    validate_pdf_encrypt_password(password)?;
    validate_pdf_encrypt_argument(input_path, "pdf-encrypt:invalid-pdf")?;
    let requested = std::path::Path::new(input_path);
    let requested_metadata = std::fs::symlink_metadata(requested)
        .map_err(|_| "pdf-encrypt:invalid-pdf".to_string())?;
    if requested_metadata.file_type().is_symlink() || !requested_metadata.is_file() {
        return Err("pdf-encrypt:invalid-pdf".to_string());
    }
    let input = requested
        .canonicalize()
        .map_err(|_| "pdf-encrypt:invalid-pdf".to_string())?;
    if !input
        .extension()
        .and_then(|value| value.to_str())
        .is_some_and(|value| value.eq_ignore_ascii_case("pdf"))
    {
        return Err("pdf-encrypt:invalid-pdf".to_string());
    }
    let input_size = std::fs::metadata(&input)
        .map_err(|_| "pdf-encrypt:invalid-pdf".to_string())?
        .len();
    if input_size == 0 {
        return Err("pdf-encrypt:invalid-pdf".to_string());
    }
    if input_size > PDF_ENCRYPT_MAX_INPUT_BYTES {
        return Err("pdf-encrypt:input-too-large".to_string());
    }

    let qpdf_path =
        get_qpdf_path().map_err(|_| "pdf-encrypt:qpdf-unavailable".to_string())?;
    let qpdf_input_path = std::path::PathBuf::from(cleanup_display_path(&input));
    let page_output = run_qpdf_with_stdin(
        &qpdf_path,
        &[
            std::ffi::OsString::from("--show-npages"),
            qpdf_input_path.as_os_str().to_os_string(),
        ],
        None,
        true,
        "pdf-encrypt:encryption-failed",
    )
    .await?;
    if !page_output.status.success() {
        return Err(map_qpdf_encrypt_error(&page_output));
    }
    let page_count = String::from_utf8_lossy(&page_output.stdout)
        .trim()
        .parse::<u32>()
        .map_err(|_| "pdf-encrypt:invalid-pdf".to_string())?;
    if page_count == 0 {
        return Err("pdf-encrypt:invalid-pdf".to_string());
    }
    if page_count > PDF_ENCRYPT_MAX_PAGES {
        return Err("pdf-encrypt:too-many-pages".to_string());
    }

    let output_dir = requested_output_dir
        .filter(|value| !value.trim().is_empty())
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|| {
            dirs::document_dir()
                .unwrap_or_default()
                .join("ToolKnit")
                .join("PDF_Encrypt")
        });
    let output_dir_text = output_dir
        .to_str()
        .ok_or("pdf-encrypt:output-path".to_string())?;
    validate_pdf_encrypt_argument(output_dir_text, "pdf-encrypt:output-path")?;
    is_path_safe(&output_dir).map_err(|_| "pdf-encrypt:output-path".to_string())?;
    std::fs::create_dir_all(&output_dir)
        .map_err(|_| "pdf-encrypt:encryption-failed".to_string())?;
    is_path_safe(&output_dir).map_err(|_| "pdf-encrypt:output-path".to_string())?;
    let temporary_path = create_pdf_encrypt_temp_path(&output_dir)?;

    let result = async {
        let mut owner_password = create_pdf_encrypt_owner_password()?;
        let arguments_result = build_pdf_encrypt_qpdf_arguments(
            &input,
            &temporary_path,
            password,
            &owner_password,
            permissions,
        );
        let mut argument_payload = match arguments_result {
            Ok(payload) => payload,
            Err(error) => {
                owner_password.zeroize();
                return Err(error);
            }
        };
        let encrypt_result = run_qpdf_with_stdin(
            &qpdf_path,
            &[std::ffi::OsString::from("@-")],
            Some(&argument_payload),
            false,
            "pdf-encrypt:engine-failed",
        )
        .await;
        argument_payload.zeroize();
        owner_password.zeroize();
        let mut encryption_output = encrypt_result?;
        if !encryption_output.status.success() {
            let mapped = map_qpdf_encrypt_error(&encryption_output);
            encryption_output.stdout.zeroize();
            encryption_output.stderr.zeroize();
            return Err(if mapped == "pdf-encrypt:encryption-failed" {
                "pdf-encrypt:engine-failed".to_string()
            } else {
                mapped
            });
        }
        encryption_output.stdout.zeroize();
        encryption_output.stderr.zeroize();
        if std::fs::metadata(&temporary_path)
            .map(|metadata| metadata.len() == 0)
            .unwrap_or(true)
        {
            return Err("pdf-encrypt:output-invalid".to_string());
        }

        let mut password_input = Vec::with_capacity(password.len() + 1);
        password_input.extend_from_slice(password.as_bytes());
        password_input.push(b'\n');
        let check_result = run_qpdf_with_stdin(
            &qpdf_path,
            &[
                std::ffi::OsString::from("--password-mode=unicode"),
                std::ffi::OsString::from("--password-file=-"),
                std::ffi::OsString::from("--check"),
                temporary_path.as_os_str().to_os_string(),
            ],
            Some(&password_input),
            false,
            "pdf-encrypt:verification-failed",
        )
        .await;
        password_input.zeroize();
        let mut check_output = check_result?;
        let check_succeeded = check_output.status.success();
        check_output.stdout.zeroize();
        check_output.stderr.zeroize();
        if !check_succeeded {
            return Err("pdf-encrypt:verification-failed".to_string());
        }

        publish_pdf_encrypt_output(
            &temporary_path,
            &output_dir,
            &create_pdf_encrypt_file_name(&input),
        )
    }
    .await;
    if result.is_err() {
        let _ = std::fs::remove_file(&temporary_path);
    }
    result
}

#[cfg(test)]
mod pdf_encrypt_backend_tests {
    use super::*;

    fn test_directory() -> std::path::PathBuf {
        let suffix = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("clock must be after epoch")
            .as_nanos();
        let directory = std::env::temp_dir().join(format!(
            "toolknit-pdf-encrypt-{}-{}",
            std::process::id(),
            suffix
        ));
        std::fs::create_dir_all(&directory).expect("create PDF encryption test directory");
        directory
    }

    fn structured_pdf_fixture() -> Vec<u8> {
        let objects = [
            "<< /Type /Catalog /Pages 2 0 R /AcroForm 5 0 R >>",
            "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
            "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources <<>> /Contents 4 0 R /Annots [6 0 R] >>",
            "<< /Length 0 >>\nstream\n\nendstream",
            "<< /Fields [6 0 R] /NeedAppearances true >>",
            "<< /Type /Annot /Subtype /Widget /FT /Tx /T (customer.name) /V (ToolKnit) /Rect [48 680 268 708] /P 3 0 R >>",
            "<< /Title (ToolKnit encryption structure regression) >>",
        ];
        let mut pdf = b"%PDF-1.7\n%\xE2\xE3\xCF\xD3\n".to_vec();
        let mut offsets = Vec::with_capacity(objects.len());
        for (index, object) in objects.iter().enumerate() {
            offsets.push(pdf.len());
            pdf.extend_from_slice(format!("{} 0 obj\n{}\nendobj\n", index + 1, object).as_bytes());
        }
        let xref_offset = pdf.len();
        pdf.extend_from_slice(format!("xref\n0 {}\n", objects.len() + 1).as_bytes());
        pdf.extend_from_slice(b"0000000000 65535 f \n");
        for offset in offsets {
            pdf.extend_from_slice(format!("{:010} 00000 n \n", offset).as_bytes());
        }
        pdf.extend_from_slice(
            format!(
                "trailer\n<< /Size {} /Root 1 0 R /Info 7 0 R >>\nstartxref\n{}\n%%EOF\n",
                objects.len() + 1,
                xref_offset
            )
            .as_bytes(),
        );
        pdf
    }

    fn default_permissions() -> PdfEncryptPermissions {
        PdfEncryptPermissions {
            printing: PdfEncryptPrintingPermission::Quality("lowResolution".to_string()),
            modifying: false,
            copying: false,
            annotating: true,
            filling_forms: true,
            content_accessibility: true,
            document_assembly: false,
        }
    }

    #[test]
    fn password_contract_prevents_qpdf_truncation() {
        assert!(validate_pdf_encrypt_password("中文密码安全测试-😀").is_ok());
        assert!(validate_pdf_encrypt_password(&"x".repeat(64)).is_ok());
        assert_eq!(
            validate_pdf_encrypt_password(&"x".repeat(PDF_ENCRYPT_MAX_PASSWORD_BYTES + 1))
                .unwrap_err(),
            "pdf-encrypt:password-too-long"
        );
        assert_eq!(
            validate_pdf_encrypt_password("valid-pass\nline").unwrap_err(),
            "pdf-encrypt:password-unsupported"
        );
    }

    #[tokio::test]
    async fn qpdf_encrypts_and_decrypts_unicode_password_without_losing_catalog_data() {
        let directory = test_directory();
        let source = directory.join("source.pdf");
        std::fs::write(&source, structured_pdf_fixture()).expect("write structured PDF fixture");
        let password = format!("中文密码安全测试-😀-{}", "long-password-".repeat(4));
        assert!(password.len() > 32);
        assert!(password.len() <= PDF_ENCRYPT_MAX_PASSWORD_BYTES);

        let encrypted = encrypt_pdf_inner(
            source.to_str().expect("UTF-8 source path"),
            &password,
            &default_permissions(),
            directory.to_str(),
        )
        .await
        .expect("encrypt Unicode password PDF");
        let encrypted_path = std::path::PathBuf::from(&encrypted);
        assert!(encrypted_path.is_file());

        let qpdf_path = get_qpdf_path().expect("bundled qpdf");
        let encryption_info = run_qpdf_with_stdin(
            &qpdf_path,
            &[
                std::ffi::OsString::from("--show-encryption"),
                encrypted_path.as_os_str().to_os_string(),
            ],
            None,
            true,
            "pdf-encrypt:encryption-failed",
        )
        .await
        .expect("inspect encryption");
        let encryption_info = String::from_utf8_lossy(&encryption_info.stdout);
        assert!(encryption_info.contains("R = 6"));
        assert!(encryption_info.contains("stream encryption method: AESv3"));
        assert!(!encryption_info.contains(&password));

        let wrong_password = decrypt_pdf_inner(
            encrypted_path.to_str().expect("UTF-8 encrypted path"),
            "wrong-password",
            directory.to_str(),
        )
        .await
        .expect_err("wrong password must fail");
        assert_eq!(wrong_password, "pdf-decrypt:invalid-password");

        let decrypted = decrypt_pdf_inner(
            encrypted_path.to_str().expect("UTF-8 encrypted path"),
            &password,
            directory.to_str(),
        )
        .await
        .expect("decrypt Unicode password PDF");
        let decrypted_path = std::path::PathBuf::from(&decrypted);
        let qdf_path = directory.join("decrypted-qdf.pdf");
        let qdf_output = run_qpdf_with_stdin(
            &qpdf_path,
            &[
                std::ffi::OsString::from("--qdf"),
                std::ffi::OsString::from("--object-streams=disable"),
                decrypted_path.as_os_str().to_os_string(),
                qdf_path.as_os_str().to_os_string(),
            ],
            None,
            false,
            "pdf-encrypt:encryption-failed",
        )
        .await
        .expect("write inspectable decrypted PDF");
        assert!(qdf_output.status.success());
        let qdf_bytes = std::fs::read(&qdf_path).expect("read decrypted QDF");
        let qdf = String::from_utf8_lossy(&qdf_bytes);
        assert!(qdf.contains("/AcroForm"));
        assert!(qdf.contains("/Title (ToolKnit encryption structure regression)"));
        assert!(qdf.contains("/T (customer.name)"));

        let encrypted_again = encrypt_pdf_inner(
            source.to_str().expect("UTF-8 source path"),
            &password,
            &default_permissions(),
            directory.to_str(),
        )
        .await
        .expect("publish a unique second encryption output");
        assert_ne!(encrypted, encrypted_again);
        assert!(std::path::Path::new(&encrypted_again).is_file());
        assert!(!std::fs::read_dir(&directory)
            .expect("inspect encryption temp cleanup")
            .filter_map(Result::ok)
            .any(|entry| entry.file_name().to_string_lossy().starts_with(".toolknit-encrypt-")));

        std::fs::remove_dir_all(&directory).expect("remove PDF encryption test directory");
    }
}

#[derive(serde::Serialize)]
struct PdfCompressResult {
    original_size: u64,
    compressed_size: u64,
    output_path: Option<String>,
    output_dir: String,
}

fn create_pdf_compress_temp_path(
    output_dir: &std::path::Path,
) -> Result<std::path::PathBuf, String> {
    use std::time::{SystemTime, UNIX_EPOCH};

    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| "pdf-compress:compression-failed".to_string())?
        .as_nanos();
    for _ in 0..100 {
        let id = PDF_DECRYPT_TEMP_ID.fetch_add(1, Ordering::Relaxed);
        let candidate = output_dir.join(format!(
            ".toolknit-compress-{}-{}-{}.pdf",
            std::process::id(),
            timestamp,
            id
        ));
        if !candidate.exists() {
            return Ok(candidate);
        }
    }
    Err("pdf-compress:compression-failed".to_string())
}

fn create_pdf_compress_file_name(input_path: &std::path::Path) -> String {
    let raw_stem = input_path
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("document");
    let sanitized: String = raw_stem
        .chars()
        .map(|character| {
            if matches!(
                character,
                '\\' | '/' | ':' | '*' | '?' | '"' | '<' | '>' | '|'
            ) {
                '_'
            } else {
                character
            }
        })
        .collect();
    let trimmed = sanitized
        .trim()
        .trim_end_matches(|character| character == '.' || character == ' ');
    let stem = if trimmed.is_empty() {
        "document"
    } else {
        trimmed
    };
    format!("{}_compressed.pdf", stem)
}

fn publish_pdf_compress_output(
    temporary_path: &std::path::Path,
    output_dir: &std::path::Path,
    file_name: &str,
) -> Result<String, String> {
    let file = std::path::Path::new(file_name);
    let stem = file
        .file_stem()
        .and_then(|value| value.to_str())
        .ok_or("pdf-compress:compression-failed")?;
    for counter in 0..10_000_u32 {
        let candidate_name = if counter == 0 {
            file_name.to_string()
        } else {
            format!("{}_{}.pdf", stem, counter)
        };
        let candidate = output_dir.join(candidate_name);
        match std::fs::hard_link(temporary_path, &candidate) {
            Ok(()) => {
                std::fs::remove_file(temporary_path)
                    .map_err(|_| "pdf-compress:compression-failed".to_string())?;
                return Ok(candidate.to_string_lossy().into_owned());
            }
            Err(_) if candidate.exists() => continue,
            Err(_) => return Err("pdf-compress:compression-failed".to_string()),
        }
    }
    Err("pdf-compress:compression-failed".to_string())
}

fn map_qpdf_compress_error(output: &std::process::Output) -> String {
    let details = String::from_utf8_lossy(&output.stderr).to_ascii_lowercase();
    if details.contains("invalid password") || details.contains("encrypted") {
        "pdf-compress:password-protected".to_string()
    } else if details.contains("not a pdf")
        || details.contains("damaged pdf")
        || details.contains("can't find pdf header")
    {
        "pdf-compress:invalid-pdf".to_string()
    } else {
        "pdf-compress:compression-failed".to_string()
    }
}

#[tauri::command]
async fn compress_pdf(
    input_path: String,
    level: String,
    output_dir: Option<String>,
) -> Result<PdfCompressResult, String> {
    let input = std::path::Path::new(&input_path);
    if input_path.contains('\0')
        || !input.is_file()
        || !input
            .extension()
            .and_then(|value| value.to_str())
            .is_some_and(|value| value.eq_ignore_ascii_case("pdf"))
    {
        return Err("pdf-compress:invalid-pdf".to_string());
    }
    let original_size = std::fs::metadata(input)
        .map_err(|_| "pdf-compress:invalid-pdf".to_string())?
        .len();
    if original_size > PDF_COMPRESS_MAX_INPUT_BYTES {
        return Err("pdf-compress:input-too-large".to_string());
    }
    if !matches!(level.as_str(), "low" | "medium" | "high") {
        return Err("pdf-compress:invalid-level".to_string());
    }

    let qpdf_path = get_qpdf_path().map_err(|_| "pdf-compress:qpdf-unavailable".to_string())?;
    let page_output = run_qpdf(
        &qpdf_path,
        &[
            std::ffi::OsString::from("--show-npages"),
            input.as_os_str().to_os_string(),
        ],
        None,
    )
    .await
    .map_err(|_| "pdf-compress:compression-failed".to_string())?;
    if !page_output.status.success() {
        return Err(map_qpdf_compress_error(&page_output));
    }
    let page_count = String::from_utf8_lossy(&page_output.stdout)
        .trim()
        .parse::<u32>()
        .map_err(|_| "pdf-compress:invalid-pdf".to_string())?;
    if page_count == 0 {
        return Err("pdf-compress:invalid-pdf".to_string());
    }
    if page_count > PDF_COMPRESS_MAX_PAGES {
        return Err("pdf-compress:too-many-pages".to_string());
    }

    let output_dir = output_dir
        .filter(|value| !value.trim().is_empty() && !value.contains('\0'))
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|| {
            dirs::document_dir()
                .unwrap_or_default()
                .join("ToolKnit")
                .join("PDF_Compress")
        });
    is_path_safe(&output_dir).map_err(|_| "pdf-compress:output-path".to_string())?;
    std::fs::create_dir_all(&output_dir)
        .map_err(|_| "pdf-compress:compression-failed".to_string())?;
    is_path_safe(&output_dir).map_err(|_| "pdf-compress:output-path".to_string())?;
    let temporary_path = create_pdf_compress_temp_path(&output_dir)?;
    let mut args = vec![
        std::ffi::OsString::from("--warning-exit-0"),
        std::ffi::OsString::from("--object-streams=generate"),
        std::ffi::OsString::from("--compress-streams=y"),
    ];
    if level != "low" {
        args.push(std::ffi::OsString::from("--recompress-flate"));
        args.push(std::ffi::OsString::from(if level == "high" {
            "--compression-level=9"
        } else {
            "--compression-level=6"
        }));
    }
    args.push(input.as_os_str().to_os_string());
    args.push(temporary_path.as_os_str().to_os_string());
    let output = run_qpdf(&qpdf_path, &args, None)
        .await
        .map_err(|_| "pdf-compress:compression-failed".to_string())?;
    if !output.status.success() {
        let _ = std::fs::remove_file(&temporary_path);
        return Err(map_qpdf_compress_error(&output));
    }
    let check_output = run_qpdf(
        &qpdf_path,
        &[
            std::ffi::OsString::from("--check"),
            temporary_path.as_os_str().to_os_string(),
        ],
        None,
    )
    .await
    .map_err(|_| "pdf-compress:compression-failed".to_string())?;
    if !check_output.status.success() {
        let _ = std::fs::remove_file(&temporary_path);
        return Err("pdf-compress:compression-failed".to_string());
    }
    let compressed_size = std::fs::metadata(&temporary_path)
        .map_err(|_| "pdf-compress:compression-failed".to_string())?
        .len();
    let output_path = if compressed_size < original_size {
        Some(publish_pdf_compress_output(
            &temporary_path,
            &output_dir,
            &create_pdf_compress_file_name(input),
        )?)
    } else {
        let _ = std::fs::remove_file(&temporary_path);
        None
    };
    Ok(PdfCompressResult {
        original_size,
        compressed_size,
        output_path,
        output_dir: output_dir.to_string_lossy().into_owned(),
    })
}

#[derive(serde::Serialize, Clone)]
struct ConvertProgress {
    file_name: String,
    current: usize,
    total: usize,
    progress: f64,
    status: String,
}

#[derive(serde::Serialize)]
struct BatchConvertResult {
    success_count: usize,
    fail_count: usize,
    output_dir: String,
    errors: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    original_size: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    compressed_size: Option<u64>,
}

#[derive(serde::Serialize)]
struct AudioBatchConvertResult {
    success_count: usize,
    fail_count: usize,
    output_dir: String,
    output_paths: Vec<String>,
    errors: Vec<String>,
}

fn normalize_audio_convert_quality(quality: Option<&str>) -> Result<&'static str, String> {
    match quality
        .unwrap_or("medium")
        .trim()
        .to_ascii_lowercase()
        .as_str()
    {
        "low" => Ok("low"),
        "medium" => Ok("medium"),
        "high" => Ok("high"),
        _ => Err("audio-convert:invalid-quality".to_string()),
    }
}

fn get_encoder_params(target_format: &str, quality: &str) -> (String, Vec<String>, &'static str) {
    // Returns (encoder, extra_args, extension)
    match target_format.to_uppercase().as_str() {
        "MP3" => {
            let q = match quality {
                "low" => "6",
                "high" => "2",
                _ => "4",
            };
            (
                "libmp3lame".to_string(),
                vec!["-q:a".to_string(), q.to_string()],
                ".mp3",
            )
        }
        "AAC" => {
            let q = match quality {
                "low" => "128k",
                "high" => "256k",
                _ => "192k",
            };
            (
                "aac".to_string(),
                vec![
                    "-b:a".to_string(),
                    q.to_string(),
                    "-movflags".to_string(),
                    "+faststart".to_string(),
                ],
                ".m4a",
            )
        }
        "WAV" => ("pcm_s16le".to_string(), vec![], ".wav"),
        "FLAC" => {
            let q = match quality {
                "low" => "2",
                "high" => "8",
                _ => "5",
            };
            (
                "flac".to_string(),
                vec!["-compression_level".to_string(), q.to_string()],
                ".flac",
            )
        }
        "ALAC" => (
            "alac".to_string(),
            vec!["-movflags".to_string(), "+faststart".to_string()],
            ".m4a",
        ),
        "OGG" => {
            let q = match quality {
                "low" => "3",
                "high" => "7",
                _ => "5",
            };
            (
                "libvorbis".to_string(),
                vec!["-q:a".to_string(), q.to_string()],
                ".ogg",
            )
        }
        _ => (
            "libmp3lame".to_string(),
            vec!["-q:a".to_string(), "4".to_string()],
            ".mp3",
        ),
    }
}

fn get_unique_output_path(
    output_dir: &std::path::Path,
    stem: &str,
    ext: &str,
) -> std::path::PathBuf {
    let mut path = output_dir.join(format!("{}{}", stem, ext));
    let mut counter = 1;
    while path.exists() {
        path = output_dir.join(format!("{}_{}{}", stem, counter, ext));
        counter += 1;
    }
    path
}

const AUDIO_CONVERT_MAX_INPUT_BYTES: u64 = 10 * 1024 * 1024 * 1024;
const AUDIO_CONVERT_MAX_FILES: usize = 100;

fn validate_audio_convert_inputs(
    input_paths: &[String],
) -> Result<Vec<std::path::PathBuf>, String> {
    if input_paths.is_empty() {
        return Err("audio-convert:missing-input".to_string());
    }
    if input_paths.len() > AUDIO_CONVERT_MAX_FILES {
        return Err("audio-convert:too-many-files".to_string());
    }

    let mut seen = std::collections::BTreeSet::new();
    let mut validated = Vec::with_capacity(input_paths.len());
    for input_path in input_paths {
        if input_path.contains('\0') {
            return Err("audio-convert:invalid-input".to_string());
        }
        let input = std::path::PathBuf::from(input_path);
        let metadata = std::fs::symlink_metadata(&input)
            .map_err(|_| "audio-convert:invalid-input".to_string())?;
        let extension = input
            .extension()
            .and_then(|value| value.to_str())
            .map(|value| value.to_ascii_lowercase());
        if metadata.file_type().is_symlink()
            || !metadata.is_file()
            || !matches!(
                extension.as_deref(),
                Some("mp3" | "aac" | "m4a" | "wav" | "flac" | "alac" | "ogg" | "wma")
            )
            || metadata.len() == 0
        {
            return Err("audio-convert:invalid-input".to_string());
        }
        if metadata.len() > AUDIO_CONVERT_MAX_INPUT_BYTES {
            return Err("audio-convert:input-too-large".to_string());
        }
        let canonical = input
            .canonicalize()
            .map_err(|_| "audio-convert:invalid-input".to_string())?;
        if !seen.insert(canonical.clone()) {
            return Err("audio-convert:duplicate-input".to_string());
        }
        validated.push(canonical);
    }
    Ok(validated)
}

fn validate_audio_convert_output_dir(output_dir: &str) -> Result<std::path::PathBuf, String> {
    if output_dir.trim().is_empty() || output_dir.contains('\0') {
        return Err("audio-convert:output-path".to_string());
    }
    let output_dir = std::path::PathBuf::from(output_dir);
    is_path_safe(&output_dir).map_err(|_| "audio-convert:output-path".to_string())?;
    std::fs::create_dir_all(&output_dir).map_err(|_| "audio-convert:output-path".to_string())?;
    if !output_dir.is_dir() {
        return Err("audio-convert:output-path".to_string());
    }
    is_path_safe(&output_dir).map_err(|_| "audio-convert:output-path".to_string())?;
    Ok(output_dir)
}

fn audio_convert_file_stem(input: &std::path::Path) -> String {
    let raw_stem = input
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("audio");
    let sanitized: String = raw_stem
        .chars()
        .map(|character| {
            if matches!(
                character,
                '\\' | '/' | ':' | '*' | '?' | '"' | '<' | '>' | '|'
            ) {
                '_'
            } else {
                character
            }
        })
        .collect();
    let trimmed = sanitized
        .trim()
        .trim_end_matches(|character| character == '.' || character == ' ');
    let safe_stem: String = trimmed.chars().take(96).collect();
    if safe_stem.is_empty() {
        "audio".to_string()
    } else {
        safe_stem
    }
}

fn create_audio_convert_temp_path(
    output_dir: &std::path::Path,
    extension: &str,
) -> Result<std::path::PathBuf, String> {
    for _ in 0..10_000 {
        let id = AUDIO_CONVERT_TEMP_ID.fetch_add(1, Ordering::SeqCst);
        let candidate = output_dir.join(format!(
            ".toolknit-audio-{}-{}{}",
            std::process::id(),
            id,
            extension
        ));
        if !candidate.exists() {
            return Ok(candidate);
        }
    }
    Err("audio-convert:output-path".to_string())
}

fn publish_audio_convert_output(
    temporary_path: &std::path::Path,
    output_dir: &std::path::Path,
    source_stem: &str,
    extension: &str,
) -> Result<String, String> {
    for counter in 0..10_000_u32 {
        let file_name = if counter == 0 {
            format!("{}{}", source_stem, extension)
        } else {
            format!("{}_{}{}", source_stem, counter, extension)
        };
        let candidate = output_dir.join(file_name);
        match std::fs::hard_link(temporary_path, &candidate) {
            Ok(()) => {
                std::fs::remove_file(temporary_path)
                    .map_err(|_| "audio-convert:output-path".to_string())?;
                return Ok(candidate.to_string_lossy().into_owned());
            }
            Err(_) if candidate.exists() => continue,
            Err(_) => return Err("audio-convert:output-path".to_string()),
        }
    }
    Err("audio-convert:output-path".to_string())
}

fn compact_audio_convert_error(stderr: &str) -> String {
    let detail = stderr
        .lines()
        .rev()
        .find(|line| !line.trim().is_empty())
        .unwrap_or("FFmpeg could not convert this audio file.");
    let compact = detail.trim().chars().take(480).collect::<String>();
    if compact.is_empty() {
        "FFmpeg could not convert this audio file.".to_string()
    } else {
        compact
    }
}

async fn convert_audio_file(
    app_handle: tauri::AppHandle,
    ffmpeg_path: std::path::PathBuf,
    input: std::path::PathBuf,
    output_dir: std::path::PathBuf,
    encoder: String,
    extra_args: Vec<String>,
    extension: &'static str,
    current: usize,
    total: usize,
) -> Result<String, String> {
    use tauri::Emitter;
    use tokio::io::{AsyncBufReadExt, AsyncReadExt, BufReader};

    if CANCEL_FLAG.load(Ordering::SeqCst) {
        return Err("audio-convert:cancelled".to_string());
    }
    let file_name = input
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("audio")
        .to_string();
    let _ = app_handle.emit(
        "convert-progress",
        ConvertProgress {
            file_name: file_name.clone(),
            current,
            total,
            progress: 0.0,
            status: "preparing".to_string(),
        },
    );
    let duration = probe_video_convert_duration(&ffmpeg_path, &input)
        .await
        .unwrap_or(0.0);
    if CANCEL_FLAG.load(Ordering::SeqCst) {
        return Err("audio-convert:cancelled".to_string());
    }
    let temporary_path = create_audio_convert_temp_path(&output_dir, extension)?;
    let mut command = tokio::process::Command::new(&ffmpeg_path);
    command
        .arg("-y")
        .arg("-i")
        .arg(&input)
        .arg("-c:a")
        .arg(&encoder)
        .args(&extra_args)
        .arg("-progress")
        .arg("pipe:1")
        .arg("-nostats")
        .arg(&temporary_path)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    #[cfg(target_os = "windows")]
    {
        command.creation_flags(0x08000000);
    }

    let mut child = command
        .spawn()
        .map_err(|_| "audio-convert:failed".to_string())?;
    let child_id = match child.id() {
        Some(id) => id,
        None => {
            let _ = child.kill().await;
            let _ = std::fs::remove_file(&temporary_path);
            return Err("audio-convert:failed".to_string());
        }
    };
    CURRENT_CHILD_ID.store(child_id, Ordering::SeqCst);
    if CANCEL_FLAG.load(Ordering::SeqCst) {
        terminate_conversion_process(child_id);
    }
    let stdout = match child.stdout.take() {
        Some(stdout) => stdout,
        None => {
            terminate_conversion_process(child_id);
            let _ = child.wait().await;
            CURRENT_CHILD_ID.store(0, Ordering::SeqCst);
            let _ = std::fs::remove_file(&temporary_path);
            return Err("audio-convert:failed".to_string());
        }
    };
    let stderr = match child.stderr.take() {
        Some(stderr) => stderr,
        None => {
            terminate_conversion_process(child_id);
            let _ = child.wait().await;
            CURRENT_CHILD_ID.store(0, Ordering::SeqCst);
            let _ = std::fs::remove_file(&temporary_path);
            return Err("audio-convert:failed".to_string());
        }
    };
    let progress_app = app_handle.clone();
    let progress_name = file_name.clone();
    let progress_task = tokio::spawn(async move {
        let mut lines = BufReader::new(stdout).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            if let Some(seconds) = parse_ffmpeg_progress_seconds(&line) {
                let progress = if duration > 0.0 {
                    (seconds / duration).clamp(0.0, 0.99)
                } else {
                    0.0
                };
                let _ = progress_app.emit(
                    "convert-progress",
                    ConvertProgress {
                        file_name: progress_name.clone(),
                        current,
                        total,
                        progress,
                        status: "converting".to_string(),
                    },
                );
            }
        }
    });
    let stderr_task = tokio::spawn(async move {
        let mut bytes = Vec::new();
        let mut reader = BufReader::new(stderr);
        let _ = reader.read_to_end(&mut bytes).await;
        String::from_utf8_lossy(&bytes).into_owned()
    });
    let status = child.wait().await;
    CURRENT_CHILD_ID.store(0, Ordering::SeqCst);
    let _ = progress_task.await;
    let stderr = stderr_task.await.unwrap_or_default();

    if CANCEL_FLAG.load(Ordering::SeqCst) {
        let _ = std::fs::remove_file(&temporary_path);
        return Err("audio-convert:cancelled".to_string());
    }
    match status {
        Ok(status) if status.success() => {
            let output_size = std::fs::metadata(&temporary_path)
                .map_err(|_| "audio-convert:failed".to_string())?
                .len();
            if output_size == 0 {
                let _ = std::fs::remove_file(&temporary_path);
                return Err("audio-convert:failed".to_string());
            }
            let output_path = match publish_audio_convert_output(
                &temporary_path,
                &output_dir,
                &audio_convert_file_stem(&input),
                extension,
            ) {
                Ok(path) => path,
                Err(error) => {
                    let _ = std::fs::remove_file(&temporary_path);
                    return Err(error);
                }
            };
            let _ = app_handle.emit(
                "convert-progress",
                ConvertProgress {
                    file_name,
                    current,
                    total,
                    progress: 1.0,
                    status: "done".to_string(),
                },
            );
            Ok(output_path)
        }
        _ => {
            let _ = std::fs::remove_file(&temporary_path);
            Err(compact_audio_convert_error(&stderr))
        }
    }
}

#[tauri::command]
async fn convert_audio_batch(
    app_handle: tauri::AppHandle,
    input_paths: Vec<String>,
    output_dir: String,
    target_format: String,
    quality: Option<String>,
) -> Result<AudioBatchConvertResult, String> {
    use tauri::Emitter;

    let _conversion_guard = begin_conversion()?;
    let input_paths = validate_audio_convert_inputs(&input_paths)?;
    let output_dir = validate_audio_convert_output_dir(&output_dir)?;
    let target_format = target_format.trim().to_ascii_uppercase();
    if !matches!(
        target_format.as_str(),
        "MP3" | "AAC" | "WAV" | "FLAC" | "ALAC" | "OGG"
    ) {
        return Err("audio-convert:invalid-target-format".to_string());
    }
    let quality = normalize_audio_convert_quality(quality.as_deref())?;
    let ffmpeg_path = get_ffmpeg_path()?;
    let (encoder, extra_args, extension) = get_encoder_params(&target_format, quality);
    let total = input_paths.len();
    let mut success_count = 0usize;
    let mut fail_count = 0usize;
    let mut output_paths = Vec::with_capacity(total);
    let mut errors = Vec::new();

    for (index, input) in input_paths.into_iter().enumerate() {
        let current = index + 1;
        let file_name = input
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or("audio")
            .to_string();
        match convert_audio_file(
            app_handle.clone(),
            ffmpeg_path.clone(),
            input,
            output_dir.clone(),
            encoder.clone(),
            extra_args.clone(),
            extension,
            current,
            total,
        )
        .await
        {
            Ok(output_path) => {
                success_count += 1;
                output_paths.push(output_path);
            }
            Err(error) if error == "audio-convert:cancelled" => return Err(error),
            Err(error) => {
                fail_count += 1;
                errors.push(format!("{}: {}", file_name, error));
                let _ = app_handle.emit(
                    "convert-progress",
                    ConvertProgress {
                        file_name,
                        current,
                        total,
                        progress: 1.0,
                        status: "error".to_string(),
                    },
                );
            }
        }
    }
    Ok(AudioBatchConvertResult {
        success_count,
        fail_count,
        output_dir: output_dir.to_string_lossy().to_string(),
        output_paths,
        errors,
    })
}

#[cfg(test)]
mod audio_conversion_tests {
    use super::*;

    fn test_directory(label: &str) -> std::path::PathBuf {
        let suffix = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("clock must be after epoch")
            .as_nanos();
        let directory =
            std::env::temp_dir().join(format!("toolknit-audio-convert-{}-{}", label, suffix));
        std::fs::create_dir_all(&directory).expect("create test directory");
        directory
    }

    #[test]
    fn audio_convert_rejects_duplicate_empty_and_unsupported_inputs() {
        let directory = test_directory("validation");
        let audio = directory.join("track.m4a");
        std::fs::write(&audio, [1_u8; 32]).expect("write audio fixture");
        let audio_path = audio.to_string_lossy().into_owned();
        assert_eq!(
            validate_audio_convert_inputs(&[audio_path.clone()])
                .expect("m4a input should be accepted")
                .len(),
            1,
        );
        assert_eq!(
            validate_audio_convert_inputs(&[audio_path.clone(), audio_path])
                .expect_err("duplicate input must be rejected"),
            "audio-convert:duplicate-input",
        );

        let empty = directory.join("empty.mp3");
        std::fs::write(&empty, []).expect("write empty fixture");
        assert_eq!(
            validate_audio_convert_inputs(&[empty.to_string_lossy().into_owned()])
                .expect_err("empty input must be rejected"),
            "audio-convert:invalid-input",
        );

        let unsupported = directory.join("notes.txt");
        std::fs::write(&unsupported, [1_u8; 32]).expect("write unsupported fixture");
        assert_eq!(
            validate_audio_convert_inputs(&[unsupported.to_string_lossy().into_owned()])
                .expect_err("unsupported input must be rejected"),
            "audio-convert:invalid-input",
        );
        std::fs::remove_dir_all(&directory).expect("remove test directory");
    }

    #[test]
    fn audio_convert_uses_bounded_quality_profiles() {
        assert_eq!(
            normalize_audio_convert_quality(Some(" HIGH ")).expect("high should normalize"),
            "high"
        );
        assert_eq!(
            normalize_audio_convert_quality(None).expect("default should normalize"),
            "medium"
        );
        assert_eq!(
            normalize_audio_convert_quality(Some("192k"))
                .expect_err("raw FFmpeg arguments must be rejected"),
            "audio-convert:invalid-quality"
        );

        let mp3 = get_encoder_params("MP3", "high");
        assert_eq!(mp3.0, "libmp3lame");
        assert_eq!(mp3.1, vec!["-q:a", "2"]);
        assert_eq!(mp3.2, ".mp3");

        let aac = get_encoder_params("AAC", "low");
        assert_eq!(aac.0, "aac");
        assert_eq!(aac.1, vec!["-b:a", "128k", "-movflags", "+faststart"]);
        assert_eq!(aac.2, ".m4a");

        let wav = get_encoder_params("WAV", "low");
        assert_eq!(wav.0, "pcm_s16le");
        assert!(wav.1.is_empty());
        assert_eq!(wav.2, ".wav");
    }

    #[test]
    fn audio_convert_publication_keeps_existing_output_and_removes_temporary_file() {
        let directory = test_directory("publish");
        let existing = directory.join("track.mp3");
        let temporary = directory.join(".toolknit-audio-test.mp3");
        std::fs::write(&existing, b"original-output").expect("write existing output");
        std::fs::write(&temporary, b"new-output").expect("write temporary output");

        let published = publish_audio_convert_output(&temporary, &directory, "track", ".mp3")
            .expect("publish unique audio output");
        assert!(published.ends_with("track_1.mp3"));
        assert_eq!(
            std::fs::read(&existing).expect("read existing output"),
            b"original-output"
        );
        assert_eq!(
            std::fs::read(&published).expect("read published output"),
            b"new-output"
        );
        assert!(!temporary.exists());
        std::fs::remove_dir_all(&directory).expect("remove test directory");
    }
}

#[derive(serde::Serialize)]
struct TrimResult {
    success: bool,
    output_path: String,
    error: Option<String>,
}

#[tauri::command]
async fn trim_audio(
    input_path: String,
    output_dir: String,
    start_time: f64,
    end_time: f64,
) -> Result<TrimResult, String> {
    let _conversion_guard = begin_conversion()?;
    if !start_time.is_finite()
        || !end_time.is_finite()
        || start_time < 0.0
        || end_time <= start_time
    {
        return Err("audio-clip:invalid-selection".to_string());
    }

    let ffmpeg_path = get_ffmpeg_path()?;
    let input = validate_audio_convert_inputs(&[input_path])
        .map_err(|_| "audio-clip:invalid-input".to_string())?
        .into_iter()
        .next()
        .ok_or("audio-clip:invalid-input")?;
    let input_size = std::fs::metadata(&input)
        .map_err(|_| "audio-clip:invalid-input".to_string())?
        .len();
    if input_size > 100 * 1024 * 1024 {
        return Err("audio-clip:input-too-large".to_string());
    }
    let output_dir_path = validate_audio_convert_output_dir(&output_dir)
        .map_err(|_| "audio-clip:output-path".to_string())?;
    let source_duration = probe_video_convert_duration(&ffmpeg_path, &input)
        .await
        .filter(|duration| duration.is_finite() && *duration > 0.0)
        .ok_or("audio-clip:invalid-input")?;
    if source_duration > 20.0 * 60.0 {
        return Err("audio-clip:audio-too-long".to_string());
    }
    if start_time >= source_duration || end_time > source_duration + 0.05 {
        return Err("audio-clip:invalid-selection".to_string());
    }

    let output_stem = format!("{}_clip", audio_convert_file_stem(&input));
    let original_extension = input
        .extension()
        .and_then(|extension| extension.to_str())
        .map(|extension| format!(".{}", extension.to_ascii_lowercase()))
        .ok_or("audio-clip:invalid-input")?;
    let temporary_path = create_audio_convert_temp_path(&output_dir_path, &original_extension)
        .map_err(|_| "audio-clip:output-path".to_string())?;
    let clip_duration = end_time - start_time;

    let mut cmd = tokio::process::Command::new(&ffmpeg_path);
    cmd.arg("-y")
        .arg("-i")
        .arg(&input)
        .arg("-ss")
        .arg(start_time.to_string())
        .arg("-t")
        .arg(clip_duration.to_string())
        .arg("-c")
        .arg("copy")
        .arg(&temporary_path)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());

    #[cfg(target_os = "windows")]
    {
        cmd.creation_flags(0x08000000);
    }

    let child = cmd.spawn().map_err(|_| "audio-clip:failed".to_string())?;
    if let Some(id) = child.id() {
        CURRENT_CHILD_ID.store(id, Ordering::SeqCst);
    }
    let output = match child.wait_with_output().await {
        Ok(output) => output,
        Err(_) => {
            CURRENT_CHILD_ID.store(0, Ordering::SeqCst);
            let _ = std::fs::remove_file(&temporary_path);
            return Err("audio-clip:failed".to_string());
        }
    };
    CURRENT_CHILD_ID.store(0, Ordering::SeqCst);

    if CANCEL_FLAG.load(Ordering::SeqCst) {
        let _ = std::fs::remove_file(&temporary_path);
        return Err("audio-clip:cancelled".to_string());
    }

    let copy_succeeded = output.status.success()
        && std::fs::metadata(&temporary_path)
            .map(|metadata| metadata.len() > 0)
            .unwrap_or(false);
    if copy_succeeded {
        let output_path = match publish_audio_convert_output(
            &temporary_path,
            &output_dir_path,
            &output_stem,
            &original_extension,
        ) {
            Ok(path) => path,
            Err(error) => {
                let _ = std::fs::remove_file(&temporary_path);
                return Err(error);
            }
        };
        return Ok(TrimResult {
            success: true,
            output_path,
            error: None,
        });
    }

    let _ = std::fs::remove_file(&temporary_path);
    let mp3_temporary_path = create_audio_convert_temp_path(&output_dir_path, ".mp3")
        .map_err(|_| "audio-clip:output-path".to_string())?;
    {
        let mut cmd2 = tokio::process::Command::new(&ffmpeg_path);
        cmd2.arg("-y")
            .arg("-i")
            .arg(&input)
            .arg("-ss")
            .arg(start_time.to_string())
            .arg("-t")
            .arg((end_time - start_time).to_string())
            .arg("-c:a")
            .arg("libmp3lame")
            .arg("-q:a")
            .arg("2")
            .arg(&mp3_temporary_path)
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped());

        #[cfg(target_os = "windows")]
        {
            cmd2.creation_flags(0x08000000);
        }

        let child2 = cmd2.spawn().map_err(|_| "audio-clip:failed".to_string())?;
        if let Some(id) = child2.id() {
            CURRENT_CHILD_ID.store(id, Ordering::SeqCst);
        }
        let output2 = match child2.wait_with_output().await {
            Ok(output) => output,
            Err(_) => {
                CURRENT_CHILD_ID.store(0, Ordering::SeqCst);
                let _ = std::fs::remove_file(&mp3_temporary_path);
                return Err("audio-clip:failed".to_string());
            }
        };
        CURRENT_CHILD_ID.store(0, Ordering::SeqCst);

        if CANCEL_FLAG.load(Ordering::SeqCst) {
            let _ = std::fs::remove_file(&mp3_temporary_path);
            return Err("audio-clip:cancelled".to_string());
        }

        if output2.status.success()
            && std::fs::metadata(&mp3_temporary_path)
                .map(|metadata| metadata.len() > 0)
                .unwrap_or(false)
        {
            let output_path = match publish_audio_convert_output(
                &mp3_temporary_path,
                &output_dir_path,
                &output_stem,
                ".mp3",
            ) {
                Ok(path) => path,
                Err(error) => {
                    let _ = std::fs::remove_file(&mp3_temporary_path);
                    return Err(error);
                }
            };
            Ok(TrimResult {
                success: true,
                output_path,
                error: None,
            })
        } else {
            let _ = std::fs::remove_file(&mp3_temporary_path);
            Ok(TrimResult {
                success: false,
                output_path: String::new(),
                error: Some(compact_audio_convert_error(&String::from_utf8_lossy(
                    &output2.stderr,
                ))),
            })
        }
    }
}

#[cfg(test)]
mod audio_clip_backend_tests {
    use super::*;

    fn test_directory() -> std::path::PathBuf {
        let suffix = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("clock must be after epoch")
            .as_nanos();
        let directory = std::env::temp_dir().join(format!("toolknit-audio-clip-{}", suffix));
        std::fs::create_dir_all(&directory).expect("create test directory");
        directory
    }

    #[tokio::test]
    async fn trim_audio_publishes_unique_nonempty_outputs_with_the_requested_duration() {
        let _conversion_lock = test_conversion_lock();
        let directory = test_directory();
        let input = directory.join("tone.wav");
        let ffmpeg = get_ffmpeg_path().expect("bundled FFmpeg must be available");
        let status = tokio::process::Command::new(&ffmpeg)
            .args([
                "-hide_banner",
                "-loglevel",
                "error",
                "-y",
                "-f",
                "lavfi",
                "-i",
                "sine=frequency=440:sample_rate=48000:duration=4",
                "-c:a",
                "pcm_s16le",
            ])
            .arg(&input)
            .status()
            .await
            .expect("start FFmpeg fixture generation");
        assert!(status.success(), "generate a valid audio fixture");

        let output_directory = directory.to_string_lossy().into_owned();
        let first = trim_audio(
            input.to_string_lossy().into_owned(),
            output_directory.clone(),
            1.0,
            2.25,
        )
        .await
        .expect("first trim must succeed");
        assert!(first.success);
        assert!(
            std::fs::metadata(&first.output_path)
                .expect("inspect first output")
                .len()
                > 0
        );
        let duration =
            probe_video_convert_duration(&ffmpeg, std::path::Path::new(&first.output_path))
                .await
                .expect("read output duration");
        assert!(
            (duration - 1.25).abs() < 0.08,
            "clip duration was {duration}"
        );

        let second = trim_audio(
            input.to_string_lossy().into_owned(),
            output_directory,
            1.0,
            2.25,
        )
        .await
        .expect("second trim must succeed");
        assert!(second.success);
        assert_ne!(first.output_path, second.output_path);
        assert!(second.output_path.ends_with("tone_clip_1.wav"));
        std::fs::remove_dir_all(&directory).expect("remove test directory");
    }
}

#[tauri::command]
fn cancel_convert() -> Result<(), String> {
    CANCEL_FLAG.store(true, Ordering::SeqCst);
    let pid = CURRENT_CHILD_ID.load(Ordering::SeqCst);
    terminate_conversion_process(pid);
    CURRENT_CHILD_ID.store(0, Ordering::SeqCst);

    let video_pids: Vec<u32> = active_video_children()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .iter()
        .copied()
        .collect();
    for video_pid in video_pids {
        terminate_conversion_process(video_pid);
    }
    let office_pids: Vec<u32> = active_office_children()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .iter()
        .copied()
        .collect();
    for office_pid in office_pids {
        terminate_conversion_process(office_pid);
    }
    Ok(())
}

// ===== Image Conversion =====

#[tauri::command]
async fn convert_image_batch(
    app_handle: tauri::AppHandle,
    input_paths: Vec<String>,
    output_dir: String,
    target_format: String,
) -> Result<BatchConvertResult, String> {
    let _conversion_guard = begin_conversion()?;
    tokio::task::spawn_blocking(move || {
        convert_image_batch_blocking(app_handle, input_paths, output_dir, target_format)
    })
    .await
    .map_err(|error| format!("Image conversion worker failed: {}", error))?
}

fn validate_image_batch_request(input_paths: &[String]) -> Result<(), String> {
    if input_paths.is_empty() {
        return Err("Select at least one image file".to_string());
    }
    if input_paths.len() > MAX_IMAGE_BATCH_FILES {
        return Err(format!(
            "A batch can contain at most {} image files",
            MAX_IMAGE_BATCH_FILES
        ));
    }
    Ok(())
}

fn validate_image_batch_input(input_path: &str) -> Result<(std::path::PathBuf, String), String> {
    if input_path.contains('\0') {
        return Err("An image input path is invalid".to_string());
    }
    let input = std::path::Path::new(input_path);
    let file_name = input
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("input image");
    let extension = input
        .extension()
        .and_then(|extension| extension.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    if !matches!(
        extension.as_str(),
        "jpg" | "jpeg" | "png" | "webp" | "bmp" | "gif"
    ) {
        return Err(format!("{} has an unsupported image format", file_name));
    }
    let metadata = std::fs::symlink_metadata(input)
        .map_err(|error| format!("Cannot read {}: {}", file_name, error))?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err(format!("{} is not a regular file", file_name));
    }
    if metadata.len() > MAX_IMAGE_FILE_BYTES {
        return Err(format!(
            "{} exceeds the {} MB file limit",
            file_name,
            MAX_IMAGE_FILE_BYTES / 1024 / 1024
        ));
    }
    let canonical = input
        .canonicalize()
        .map_err(|error| format!("Cannot resolve {}: {}", file_name, error))?;
    let (width, height) = image::image_dimensions(&canonical)
        .map_err(|error| format!("Cannot read dimensions for {}: {}", file_name, error))?;
    let pixels = u64::from(width) * u64::from(height);
    if width == 0 || height == 0 || pixels > MAX_IMAGE_PIXELS {
        return Err(format!(
            "{} exceeds the {} megapixel limit",
            file_name,
            MAX_IMAGE_PIXELS / 1_000_000
        ));
    }
    if extension == "gif" {
        let has_multiple_frames = image_has_multiple_gif_frames(&canonical)
            .map_err(|error| format!("Cannot inspect {}: {}", file_name, error))?;
        if has_multiple_frames {
            return Err(format!(
                "{} is animated and cannot be converted without losing frames",
                file_name
            ));
        }
    }
    Ok((canonical, extension))
}

fn validate_image_batch_inputs(input_paths: &[String]) -> Result<(), String> {
    validate_image_batch_request(input_paths)?;
    let mut seen = std::collections::BTreeSet::new();
    for input_path in input_paths {
        let file_name = std::path::Path::new(input_path)
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("input image");
        let (canonical, _) = validate_image_batch_input(input_path)?;
        if !seen.insert(canonical) {
            return Err(format!("Duplicate image file: {}", file_name));
        }
    }
    Ok(())
}

fn image_has_multiple_gif_frames(input: &std::path::Path) -> Result<bool, String> {
    use image::AnimationDecoder;
    use std::io::BufReader;

    let file = std::fs::File::open(input).map_err(|error| format!("Cannot read GIF: {}", error))?;
    let decoder = image::codecs::gif::GifDecoder::new(BufReader::new(file))
        .map_err(|error| format!("Cannot decode GIF: {}", error))?;
    let mut frames = decoder.into_frames();
    if frames
        .next()
        .transpose()
        .map_err(|error| format!("Cannot decode GIF: {}", error))?
        .is_none()
    {
        return Err("GIF has no image frames".to_string());
    }
    Ok(frames
        .next()
        .transpose()
        .map_err(|error| format!("Cannot decode GIF: {}", error))?
        .is_some())
}

fn validate_image_output_dir(output_dir: &str) -> Result<std::path::PathBuf, String> {
    if output_dir.trim().is_empty() || output_dir.contains('\0') {
        return Err("Image output directory is invalid".to_string());
    }
    let directory = std::path::PathBuf::from(output_dir);
    is_path_safe(&directory)?;
    std::fs::create_dir_all(&directory)
        .map_err(|error| format!("Cannot create image output directory: {}", error))?;
    if !directory.is_dir() {
        return Err("Image output path is not a directory".to_string());
    }
    let directory = directory
        .canonicalize()
        .map_err(|error| format!("Cannot resolve image output directory: {}", error))?;
    is_path_safe(&directory)?;
    Ok(directory)
}

fn publish_image_output(
    temporary_output_path: &std::path::Path,
    output_path: &std::path::Path,
) -> Result<(), String> {
    std::fs::hard_link(temporary_output_path, output_path)
        .map_err(|error| format!("Cannot publish image output: {}", error))?;
    let _ = std::fs::remove_file(temporary_output_path);
    Ok(())
}

fn flatten_image_to_rgb(
    source: &image::DynamicImage,
    background: image::Rgb<u8>,
) -> image::RgbImage {
    let rgba = source.to_rgba8();
    let mut output = image::RgbImage::new(rgba.width(), rgba.height());
    let [background_red, background_green, background_blue] = background.0;
    for (source_pixel, output_pixel) in rgba.pixels().zip(output.pixels_mut()) {
        let [red, green, blue, alpha] = source_pixel.0;
        let alpha = u32::from(alpha);
        let inverse_alpha = 255 - alpha;
        let blend = |channel: u8, background_channel: u8| {
            ((u32::from(channel) * alpha + u32::from(background_channel) * inverse_alpha + 127)
                / 255) as u8
        };
        *output_pixel = image::Rgb([
            blend(red, background_red),
            blend(green, background_green),
            blend(blue, background_blue),
        ]);
    }
    output
}

fn write_converted_image(
    image: &image::DynamicImage,
    output_path: &std::path::Path,
    target_format: image::ImageFormat,
) -> image::ImageResult<()> {
    match target_format {
        image::ImageFormat::Jpeg => {
            use image::codecs::jpeg::JpegEncoder;
            use std::io::BufWriter;

            let file = std::fs::File::create(output_path)?;
            let writer = BufWriter::new(file);
            let mut encoder = JpegEncoder::new_with_quality(writer, 92);
            let rgb = flatten_image_to_rgb(image, image::Rgb([255, 255, 255]));
            encoder.encode(
                &rgb,
                rgb.width(),
                rgb.height(),
                image::ExtendedColorType::Rgb8,
            )
        }
        _ => image.save_with_format(output_path, target_format),
    }
}

fn write_raster_svg(
    image: &image::DynamicImage,
    output_path: &std::path::Path,
) -> Result<(), String> {
    use base64::Engine;
    use image::ImageEncoder;

    let rgba = image.to_rgba8();
    let width = image.width();
    let height = image.height();
    let mut png = Vec::new();
    image::codecs::png::PngEncoder::new(&mut png)
        .write_image(&rgba, width, height, image::ExtendedColorType::Rgba8)
        .map_err(|error| format!("Cannot encode SVG image data: {}", error))?;
    let encoded = base64::engine::general_purpose::STANDARD.encode(png);
    let svg = format!(
        r#"<svg xmlns="http://www.w3.org/2000/svg" width="{width}" height="{height}" viewBox="0 0 {width} {height}"><image width="{width}" height="{height}" href="data:image/png;base64,{encoded}"/></svg>"#
    );
    std::fs::write(output_path, svg).map_err(|error| format!("Cannot write SVG output: {}", error))
}

#[derive(Clone, Debug, serde::Serialize)]
struct ImageStitchResult {
    output_path: String,
    width: u32,
    height: u32,
    count: usize,
    format: String,
}

#[derive(serde::Serialize)]
struct ImageStitchInputPreview {
    path: String,
    name: String,
    width: u32,
    height: u32,
    thumbnail_data_url: String,
    preview_data_url: String,
}

#[derive(Clone)]
struct ImageStitchOptions {
    input_paths: Vec<String>,
    output_dir: String,
    output_name: Option<String>,
    mode: String,
    reference: String,
    spacing_px: u32,
    scale_percent: u32,
    format: String,
    jpeg_quality: u8,
    background_rgba: String,
}

#[derive(Clone, Debug, PartialEq)]
struct ImageStitchLayout {
    sizes: Vec<(u32, u32)>,
    width: u32,
    height: u32,
}

pub(crate) fn decode_oriented_image(path: &std::path::Path) -> image::ImageResult<image::DynamicImage> {
    use image::ImageDecoder;
    let reader = image::ImageReader::open(path)
        .map_err(image::ImageError::IoError)?
        .with_guessed_format()
        .map_err(image::ImageError::IoError)?;
    let mut decoder = reader.into_decoder()?;
    let orientation = decoder.orientation()?;
    let mut decoded = image::DynamicImage::from_decoder(decoder)?;
    decoded.apply_orientation(orientation);
    Ok(decoded)
}

#[derive(Clone, Debug, serde::Serialize)]
struct ImageCropResult {
    output_path: String,
    width: u32,
    height: u32,
    bytes: u64,
    format: String,
}

#[derive(Clone)]
struct ImageCropOptions {
    input_path: String,
    output_dir: String,
    output_name: Option<String>,
    crop_x: u32,
    crop_y: u32,
    crop_width: u32,
    crop_height: u32,
    rotation: u16,
    flip_horizontal: bool,
    flip_vertical: bool,
    format: String,
    jpeg_quality: u8,
    background_rgba: String,
}

fn read_oriented_image(path: &std::path::Path) -> Result<image::DynamicImage, String> {
    decode_oriented_image(path).map_err(|_| "image-stitch:invalid-input".to_string())
}

fn oriented_image_dimensions(path: &std::path::Path) -> Result<(u32, u32), String> {
    use image::ImageDecoder;
    let reader = image::ImageReader::open(path)
        .map_err(|_| "image-stitch:invalid-input".to_string())?
        .with_guessed_format()
        .map_err(|_| "image-stitch:invalid-input".to_string())?;
    let mut decoder = reader
        .into_decoder()
        .map_err(|_| "image-stitch:invalid-input".to_string())?;
    let (width, height) = decoder.dimensions();
    let orientation = decoder
        .orientation()
        .map_err(|_| "image-stitch:invalid-input".to_string())?;
    if matches!(
        orientation,
        image::metadata::Orientation::Rotate90
            | image::metadata::Orientation::Rotate270
            | image::metadata::Orientation::Rotate90FlipH
            | image::metadata::Orientation::Rotate270FlipH
    ) {
        Ok((height, width))
    } else {
        Ok((width, height))
    }
}

fn stitch_background(value: &str) -> Result<image::Rgba<u8>, String> {
    let raw = value.trim().trim_start_matches('#');
    if raw.len() != 8 || !raw.chars().all(|character| character.is_ascii_hexdigit()) {
        return Err("image-stitch:invalid-background".to_string());
    }
    let part = |from| {
        u8::from_str_radix(&raw[from..from + 2], 16)
            .map_err(|_| "image-stitch:invalid-background".to_string())
    };
    Ok(image::Rgba([part(0)?, part(2)?, part(4)?, part(6)?]))
}

fn calculate_image_stitch_layout(
    dimensions: &[(u32, u32)],
    mode: &str,
    reference: &str,
    spacing_px: u32,
    scale_percent: u32,
) -> Result<ImageStitchLayout, String> {
    if dimensions.len() < 2
        || dimensions.len() > MAX_IMAGE_BATCH_FILES
        || spacing_px > 500
        || !(10..=100).contains(&scale_percent)
    {
        return Err("image-stitch:invalid-settings".to_string());
    }
    let vertical = match mode {
        "vertical" => true,
        "horizontal" => false,
        _ => return Err("image-stitch:invalid-settings".to_string()),
    };
    let axis = |dimensions: &(u32, u32)| if vertical { dimensions.0 } else { dimensions.1 };
    let chosen = match reference {
        "first" => dimensions[0],
        "smallest" => *dimensions
            .iter()
            .min_by_key(|dimensions| axis(dimensions))
            .ok_or_else(|| "image-stitch:invalid-settings".to_string())?,
        "largest" => *dimensions
            .iter()
            .max_by_key(|dimensions| axis(dimensions))
            .ok_or_else(|| "image-stitch:invalid-settings".to_string())?,
        _ => return Err("image-stitch:invalid-settings".to_string()),
    };
    let fixed = ((u64::from(axis(&chosen)) * u64::from(scale_percent) + 50) / 100).max(1);
    let sizes = dimensions
        .iter()
        .map(|(width, height)| {
            if vertical {
                let target_height = ((u64::from(*height) * fixed + u64::from(*width) / 2)
                    / u64::from(*width))
                .max(1);
                (fixed as u32, target_height as u32)
            } else {
                let target_width = ((u64::from(*width) * fixed + u64::from(*height) / 2)
                    / u64::from(*height))
                .max(1);
                (target_width as u32, fixed as u32)
            }
        })
        .collect::<Vec<_>>();
    let gap = u64::from(spacing_px) * (sizes.len() as u64 - 1);
    let width = if vertical {
        fixed
    } else {
        sizes
            .iter()
            .try_fold(gap, |sum, item| sum.checked_add(u64::from(item.0)))
            .ok_or_else(|| "image-stitch:output-too-large".to_string())?
    };
    let height = if vertical {
        sizes
            .iter()
            .try_fold(gap, |sum, item| sum.checked_add(u64::from(item.1)))
            .ok_or_else(|| "image-stitch:output-too-large".to_string())?
    } else {
        fixed
    };
    if width > 65_535 || height > 65_535 {
        return Err("image-stitch:output-too-large".to_string());
    }
    Ok(ImageStitchLayout {
        sizes,
        width: width as u32,
        height: height as u32,
    })
}

#[cfg(target_os = "windows")]
fn available_image_stitch_pixels() -> u64 {
    use windows::Win32::System::SystemInformation::{GlobalMemoryStatusEx, MEMORYSTATUSEX};
    let mut memory = MEMORYSTATUSEX::default();
    memory.dwLength = std::mem::size_of::<MEMORYSTATUSEX>() as u32;
    if unsafe { GlobalMemoryStatusEx(&mut memory) }.is_ok() {
        return (memory.ullAvailPhys / 12).clamp(4_000_000, 160_000_000);
    }
    80_000_000
}

#[cfg(not(target_os = "windows"))]
fn available_image_stitch_pixels() -> u64 {
    80_000_000
}

static IMAGE_STITCH_TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);
static IMAGE_STITCH_PDF_SESSION_COUNTER: AtomicU64 = AtomicU64::new(0);
static PDF_TO_IMAGE_SESSION_COUNTER: AtomicU64 = AtomicU64::new(0);
static PDF_TO_IMAGE_TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);

const IMAGE_STITCH_PDF_SESSION_ROOT: &str = "toolknit-image-stitch-pdf";
const PDF_TO_IMAGE_SESSION_ROOT: &str = "toolknit-pdf-to-image";
const PDF_TO_IMAGE_MAX_PAGE_BYTES: usize = 192 * 1024 * 1024;
const PDF_TO_IMAGE_MAX_SESSION_BYTES: u64 = 2 * 1024 * 1024 * 1024;
const PDF_TO_IMAGE_MAX_PAGES: usize = 200;
const PDF_TO_IMAGE_MAX_LONG_PAGES: usize = 20;
const PDF_TO_IMAGE_MAX_PAGES_PER_LONG_IMAGE: usize = 5;
const PDF_TO_IMAGE_MAX_RENDER_SIDE: u32 = 16_384;
const PDF_TO_IMAGE_MAX_RENDER_PIXELS: u64 = 40_000_000;
const PDF_TO_IMAGE_MAX_LONG_SIDE: u32 = 32_767;
const PDF_TO_IMAGE_MAX_LONG_PIXELS: u64 = 60_000_000;
const PDF_TO_IMAGE_MAX_ESTIMATED_WORKING_BYTES: u64 = 384 * 1024 * 1024;
struct PdfToImageJobState {
    cancelled: std::sync::Arc<std::sync::atomic::AtomicBool>,
    active: bool,
}

static PDF_TO_IMAGE_JOBS: std::sync::OnceLock<
    std::sync::Mutex<std::collections::BTreeMap<String, PdfToImageJobState>>,
> = std::sync::OnceLock::new();

fn pdf_to_image_jobs(
) -> &'static std::sync::Mutex<std::collections::BTreeMap<String, PdfToImageJobState>> {
    PDF_TO_IMAGE_JOBS.get_or_init(|| std::sync::Mutex::new(std::collections::BTreeMap::new()))
}

fn valid_pdf_to_image_job_id(job_id: &str) -> bool {
    !job_id.is_empty()
        && job_id.len() <= 128
        && job_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
}

struct PdfToImageJobGuard {
    job_id: String,
    cancelled: std::sync::Arc<std::sync::atomic::AtomicBool>,
}

impl PdfToImageJobGuard {
    fn register(job_id: String) -> Result<Self, String> {
        if !valid_pdf_to_image_job_id(&job_id) {
            return Err("pdf-to-image:invalid-job-id".to_string());
        }
        let mut jobs = pdf_to_image_jobs()
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let state = jobs
            .entry(job_id.clone())
            .or_insert_with(|| PdfToImageJobState {
                cancelled: std::sync::Arc::new(AtomicBool::new(false)),
                active: false,
            });
        if state.active {
            return Err("pdf-to-image:duplicate-job".to_string());
        }
        state.active = true;
        let cancelled = std::sync::Arc::clone(&state.cancelled);
        Ok(Self { job_id, cancelled })
    }
}

impl Drop for PdfToImageJobGuard {
    fn drop(&mut self) {
        let mut jobs = pdf_to_image_jobs()
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if jobs
            .get(&self.job_id)
            .is_some_and(|current| std::sync::Arc::ptr_eq(&current.cancelled, &self.cancelled))
        {
            jobs.remove(&self.job_id);
        }
    }
}

#[tauri::command]
fn cancel_pdf_to_image(job_id: String) -> Result<(), String> {
    if !valid_pdf_to_image_job_id(&job_id) {
        return Err("pdf-to-image:invalid-job-id".to_string());
    }
    let mut jobs = pdf_to_image_jobs()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if !jobs.contains_key(&job_id) && jobs.len() >= 128 {
        jobs.retain(|_, state| state.active || !state.cancelled.load(Ordering::SeqCst));
    }
    if !jobs.contains_key(&job_id) && jobs.len() >= 128 {
        return Err("pdf-to-image:too-many-jobs".to_string());
    }
    jobs.entry(job_id)
        .or_insert_with(|| PdfToImageJobState {
            cancelled: std::sync::Arc::new(AtomicBool::new(false)),
            active: false,
        })
        .cancelled
        .store(true, Ordering::SeqCst);
    Ok(())
}

#[derive(serde::Serialize)]
struct ImageStitchPdfSession {
    session_id: String,
    directory: String,
}

fn image_stitch_pdf_session_root() -> std::path::PathBuf {
    std::env::temp_dir().join(IMAGE_STITCH_PDF_SESSION_ROOT)
}

fn valid_image_stitch_session_id(session_id: &str) -> bool {
    !session_id.is_empty()
        && session_id.len() <= 96
        && session_id
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || character == '-')
}

fn image_stitch_pdf_session_directory(session_id: &str) -> Result<std::path::PathBuf, String> {
    if !valid_image_stitch_session_id(session_id) {
        return Err("image-stitch:invalid-pdf-session".to_string());
    }
    let root = image_stitch_pdf_session_root();
    let directory = root.join(session_id);
    let canonical_root = root
        .canonicalize()
        .map_err(|_| "image-stitch:invalid-pdf-session".to_string())?;
    let canonical_directory = directory
        .canonicalize()
        .map_err(|_| "image-stitch:invalid-pdf-session".to_string())?;
    if !canonical_directory.starts_with(canonical_root) {
        return Err("image-stitch:invalid-pdf-session".to_string());
    }
    Ok(canonical_directory)
}

fn cleanup_image_stitch_pdf_sessions() {
    let root = image_stitch_pdf_session_root();
    if root.is_dir() {
        let _ = std::fs::remove_dir_all(&root);
    }
}

#[tauri::command]
fn create_image_stitch_pdf_session() -> Result<ImageStitchPdfSession, String> {
    let root = image_stitch_pdf_session_root();
    std::fs::create_dir_all(&root)
        .map_err(|_| "image-stitch:pdf-session-create-failed".to_string())?;
    for _ in 0..10_000 {
        let counter = IMAGE_STITCH_PDF_SESSION_COUNTER.fetch_add(1, Ordering::SeqCst);
        let session_id = format!(
            "{}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos(),
            counter
        );
        let directory = root.join(&session_id);
        match std::fs::create_dir(&directory) {
            Ok(()) => {
                return Ok(ImageStitchPdfSession {
                    session_id,
                    directory: directory.to_string_lossy().into_owned(),
                });
            }
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(_) => return Err("image-stitch:pdf-session-create-failed".to_string()),
        }
    }
    Err("image-stitch:pdf-session-create-failed".to_string())
}

#[tauri::command]
fn write_image_stitch_pdf_page(
    session_id: String,
    page_number: u32,
    bytes: Vec<u8>,
) -> Result<String, String> {
    use std::io::Write;
    const MAX_PAGE_BYTES: usize = 20 * 1024 * 1024;
    if !(1..=100).contains(&page_number)
        || bytes.len() < 8
        || bytes.len() > MAX_PAGE_BYTES
        || bytes[..8] != [137, 80, 78, 71, 13, 10, 26, 10]
    {
        return Err("image-stitch:invalid-pdf-page".to_string());
    }
    let directory = image_stitch_pdf_session_directory(&session_id)?;
    let output_path = directory.join(format!("page_{:04}.png", page_number));
    let mut output = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&output_path)
        .map_err(|_| "image-stitch:pdf-page-write-failed".to_string())?;
    if let Err(error) = output.write_all(&bytes).and_then(|_| output.sync_all()) {
        drop(output);
        let _ = std::fs::remove_file(&output_path);
        return Err(format!("image-stitch:pdf-page-write-failed:{error}"));
    }
    drop(output);
    let valid = image::image_dimensions(&output_path)
        .map(|(width, height)| {
            width > 0 && height > 0 && u64::from(width) * u64::from(height) <= MAX_IMAGE_PIXELS
        })
        .unwrap_or(false);
    if !valid {
        let _ = std::fs::remove_file(&output_path);
        return Err("image-stitch:invalid-pdf-page".to_string());
    }
    Ok(output_path.to_string_lossy().into_owned())
}

#[tauri::command]
fn discard_image_stitch_pdf_session(session_id: String) -> Result<(), String> {
    let directory = image_stitch_pdf_session_directory(&session_id)?;
    std::fs::remove_dir_all(directory)
        .map_err(|_| "image-stitch:pdf-session-cleanup-failed".to_string())
}

struct ImageStitchTemporaryFile {
    path: std::path::PathBuf,
    published: bool,
}

impl ImageStitchTemporaryFile {
    fn new(directory: &std::path::Path) -> Self {
        let counter = IMAGE_STITCH_TEMP_COUNTER.fetch_add(1, Ordering::Relaxed);
        Self {
            path: directory.join(format!(
                ".toolknit-stitch-{}-{}-{}.tmp",
                std::process::id(),
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_nanos(),
                counter
            )),
            published: false,
        }
    }
}

impl Drop for ImageStitchTemporaryFile {
    fn drop(&mut self) {
        if !self.published {
            let _ = std::fs::remove_file(&self.path);
        }
    }
}

fn publish_image_stitch_output(
    temporary: &mut ImageStitchTemporaryFile,
    directory: &std::path::Path,
    output_name: Option<&str>,
    extension: &str,
) -> Result<String, String> {
    let stem = normalize_image_stitch_output_name(output_name)?;
    for index in 0..10_000u32 {
        let suffix = if index == 0 {
            String::new()
        } else {
            format!("_{}", index)
        };
        let target = directory.join(format!("{}{}{}", stem, suffix, extension));
        match std::fs::hard_link(&temporary.path, &target) {
            Ok(()) => {
                std::fs::remove_file(&temporary.path)
                    .map_err(|_| "image-stitch:output-path".to_string())?;
                temporary.published = true;
                return Ok(target.to_string_lossy().into_owned());
            }
            Err(_) if target.exists() => continue,
            Err(_) => return Err("image-stitch:output-path".to_string()),
        }
    }
    Err("image-stitch:output-path".to_string())
}

fn normalize_image_stitch_output_name(value: Option<&str>) -> Result<String, String> {
    let value = value.unwrap_or("stitched_image").trim();
    if value.is_empty()
        || value.chars().count() > 96
        || value == "."
        || value == ".."
        || value.chars().any(|character| {
            character.is_control()
                || matches!(
                    character,
                    '\\' | '/' | ':' | '*' | '?' | '"' | '<' | '>' | '|'
                )
        })
        || value.ends_with([' ', '.'])
    {
        return Err("image-stitch:invalid-output-name".to_string());
    }
    let reserved = value
        .split('.')
        .next()
        .unwrap_or(value)
        .trim_end()
        .to_ascii_uppercase();
    if matches!(reserved.as_str(), "CON" | "PRN" | "AUX" | "NUL")
        || (reserved.len() == 4
            && (reserved.starts_with("COM") || reserved.starts_with("LPT"))
            && matches!(reserved.as_bytes()[3], b'1'..=b'9'))
    {
        return Err("image-stitch:invalid-output-name".to_string());
    }
    Ok(value.to_string())
}

fn encode_image_stitch(
    canvas: &image::RgbaImage,
    temporary: &std::path::Path,
    format: &str,
    jpeg_quality: u8,
) -> Result<(), String> {
    use image::ImageEncoder;
    use std::io::{BufWriter, Write};
    let file = std::fs::OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(temporary)
        .map_err(|_| "image-stitch:output-path".to_string())?;
    let mut writer = BufWriter::new(file);
    if format == "jpg" {
        let rgb = image::DynamicImage::ImageRgba8(canvas.clone()).to_rgb8();
        image::codecs::jpeg::JpegEncoder::new_with_quality(&mut writer, jpeg_quality)
            .encode(
                &rgb,
                canvas.width(),
                canvas.height(),
                image::ExtendedColorType::Rgb8,
            )
            .map_err(|_| "image-stitch:encode-failed".to_string())?;
    } else if format == "webp" {
        image::codecs::webp::WebPEncoder::new_lossless(&mut writer)
            .encode(
                canvas.as_raw(),
                canvas.width(),
                canvas.height(),
                image::ExtendedColorType::Rgba8,
            )
            .map_err(|_| "image-stitch:encode-failed".to_string())?;
    } else {
        image::codecs::png::PngEncoder::new(&mut writer)
            .write_image(
                canvas.as_raw(),
                canvas.width(),
                canvas.height(),
                image::ExtendedColorType::Rgba8,
            )
            .map_err(|_| "image-stitch:encode-failed".to_string())?;
    }
    writer
        .flush()
        .map_err(|_| "image-stitch:output-path".to_string())?;
    writer
        .get_ref()
        .sync_all()
        .map_err(|_| "image-stitch:output-path".to_string())
}

fn stitch_images_blocking<F>(
    options: ImageStitchOptions,
    mut progress: F,
) -> Result<ImageStitchResult, String>
where
    F: FnMut(&str, usize, usize, u8),
{
    validate_image_batch_inputs(&options.input_paths)?;
    if options.input_paths.len() < 2
        || !(60..=100).contains(&options.jpeg_quality)
        || !matches!(options.format.as_str(), "png" | "jpg" | "webp")
    {
        return Err("image-stitch:invalid-settings".to_string());
    }
    let background = stitch_background(&options.background_rgba)?;
    let canvas_background = if options.format == "jpg" {
        image::Rgba([background.0[0], background.0[1], background.0[2], 255])
    } else {
        background
    };
    let output_directory = validate_image_output_dir(&options.output_dir)?;
    let inputs = options
        .input_paths
        .iter()
        .map(std::path::PathBuf::from)
        .collect::<Vec<_>>();
    progress("prepare", 0, inputs.len(), 2);

    let mut dimensions = Vec::with_capacity(inputs.len());
    for (index, input) in inputs.iter().enumerate() {
        if CANCEL_FLAG.load(Ordering::SeqCst) {
            return Err("image-stitch:cancelled".to_string());
        }
        dimensions.push(oriented_image_dimensions(input)?);
        progress(
            "inspect",
            index + 1,
            inputs.len(),
            10 + ((index + 1) * 15 / inputs.len()) as u8,
        );
    }

    let layout = calculate_image_stitch_layout(
        &dimensions,
        &options.mode,
        &options.reference,
        options.spacing_px,
        options.scale_percent,
    )?;
    let pixels = u64::from(layout.width)
        .checked_mul(u64::from(layout.height))
        .ok_or_else(|| "image-stitch:output-too-large".to_string())?;
    if pixels > available_image_stitch_pixels() {
        return Err("image-stitch:output-too-large-for-memory".to_string());
    }

    let mut canvas = image::RgbaImage::from_pixel(layout.width, layout.height, canvas_background);
    let vertical = options.mode == "vertical";
    let mut cursor = 0u32;
    for (index, (input, (width, height))) in inputs.iter().zip(layout.sizes.iter()).enumerate() {
        if CANCEL_FLAG.load(Ordering::SeqCst) {
            return Err("image-stitch:cancelled".to_string());
        }
        let resized = read_oriented_image(input)?
            .resize_exact(*width, *height, image::imageops::FilterType::Lanczos3)
            .to_rgba8();
        image::imageops::overlay(
            &mut canvas,
            &resized,
            if vertical { 0 } else { i64::from(cursor) },
            if vertical { i64::from(cursor) } else { 0 },
        );
        cursor = cursor
            .saturating_add(if vertical { *height } else { *width })
            .saturating_add(options.spacing_px);
        progress(
            "compose",
            index + 1,
            inputs.len(),
            25 + ((index + 1) * 60 / inputs.len()) as u8,
        );
    }

    if CANCEL_FLAG.load(Ordering::SeqCst) {
        return Err("image-stitch:cancelled".to_string());
    }
    progress("encode", inputs.len(), inputs.len(), 88);
    let mut temporary = ImageStitchTemporaryFile::new(&output_directory);
    encode_image_stitch(
        &canvas,
        &temporary.path,
        &options.format,
        options.jpeg_quality,
    )?;
    if CANCEL_FLAG.load(Ordering::SeqCst) {
        return Err("image-stitch:cancelled".to_string());
    }
    let extension = match options.format.as_str() {
        "png" => ".png",
        "jpg" => ".jpg",
        "webp" => ".webp",
        _ => unreachable!("validated image stitch format"),
    };
    let output_path = publish_image_stitch_output(
        &mut temporary,
        &output_directory,
        options.output_name.as_deref(),
        extension,
    )?;
    progress("complete", inputs.len(), inputs.len(), 100);
    Ok(ImageStitchResult {
        output_path,
        width: layout.width,
        height: layout.height,
        count: inputs.len(),
        format: options.format.to_ascii_uppercase(),
    })
}

#[tauri::command]
async fn inspect_image_stitch_inputs(
    input_paths: Vec<String>,
) -> Result<Vec<ImageStitchInputPreview>, String> {
    tokio::task::spawn_blocking(move || {
        use base64::Engine;
        use image::ImageEncoder;
        validate_image_batch_inputs(&input_paths)?;
        input_paths
            .iter()
            .map(|input_path| {
                let path = std::path::PathBuf::from(input_path);
                let decoded = read_oriented_image(&path)?;
                let thumbnail = decoded.thumbnail(180, 180).to_rgba8();
                let preview = decoded.thumbnail(960, 960).to_rgba8();
                let mut thumbnail_bytes = Vec::new();
                image::codecs::png::PngEncoder::new(&mut thumbnail_bytes)
                    .write_image(
                        thumbnail.as_raw(),
                        thumbnail.width(),
                        thumbnail.height(),
                        image::ExtendedColorType::Rgba8,
                    )
                    .map_err(|_| "image-stitch:thumbnail-failed".to_string())?;
                let mut preview_bytes = Vec::new();
                image::codecs::png::PngEncoder::new(&mut preview_bytes)
                    .write_image(
                        preview.as_raw(),
                        preview.width(),
                        preview.height(),
                        image::ExtendedColorType::Rgba8,
                    )
                    .map_err(|_| "image-stitch:thumbnail-failed".to_string())?;
                Ok(ImageStitchInputPreview {
                    path: input_path.clone(),
                    name: path
                        .file_name()
                        .and_then(|name| name.to_str())
                        .unwrap_or("image")
                        .to_string(),
                    width: decoded.width(),
                    height: decoded.height(),
                    thumbnail_data_url: format!(
                        "data:image/png;base64,{}",
                        base64::engine::general_purpose::STANDARD.encode(thumbnail_bytes)
                    ),
                    preview_data_url: format!(
                        "data:image/png;base64,{}",
                        base64::engine::general_purpose::STANDARD.encode(preview_bytes)
                    ),
                })
            })
            .collect::<Result<Vec<_>, String>>()
    })
    .await
    .map_err(|error| format!("image-stitch:worker-failed:{error}"))?
}

#[tauri::command]
async fn stitch_images(
    app_handle: tauri::AppHandle,
    input_paths: Vec<String>,
    output_dir: String,
    output_name: Option<String>,
    mode: String,
    reference: String,
    spacing_px: u32,
    scale_percent: u32,
    format: String,
    jpeg_quality: u8,
    background_rgba: String,
    job_id: Option<String>,
) -> Result<ImageStitchResult, String> {
    let _guard = begin_conversion()?;
    tokio::task::spawn_blocking(move || {
        let job_id = job_id.unwrap_or_else(|| "desktop".to_string());
        stitch_images_blocking(
            ImageStitchOptions {
                input_paths,
                output_dir,
                output_name,
                mode,
                reference,
                spacing_px,
                scale_percent,
                format,
                jpeg_quality,
                background_rgba,
            },
            |phase, current, total, percent| {
                let _ = app_handle.emit(
                    "image-stitch-progress",
                    serde_json::json!({
                        "jobId": job_id,
                        "phase": phase,
                        "current": current,
                        "total": total,
                        "percent": percent
                    }),
                );
            },
        )
    })
    .await
    .map_err(|error| format!("image-stitch:worker-failed:{error}"))?
}

#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct PdfToImageSession {
    session_id: String,
    directory: String,
}

#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct PdfToImagePageWriteResult {
    page_number: u32,
    path: String,
    width: u32,
    height: u32,
    byte_length: u64,
}

#[derive(Clone, Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct PdfToImageExportRequest {
    session_id: String,
    #[serde(rename = "pages", alias = "pageNumbers")]
    page_numbers: Vec<u32>,
    page_count: u32,
    output_dir: String,
    output_name: Option<String>,
    format: String,
    #[serde(rename = "mode", alias = "exportMode")]
    export_mode: String,
    pages_per_long_image: Option<u8>,
    jpeg_quality: Option<u8>,
    background_rgba: Option<String>,
    job_id: Option<String>,
}

#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct PdfToImageExportItem {
    output_path: String,
    width: u32,
    height: u32,
    page_numbers: Vec<u32>,
}

#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct PdfToImageExportResult {
    output_dir: String,
    outputs: Vec<PdfToImageExportItem>,
    output_count: usize,
    page_count: usize,
    format: String,
    export_mode: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum PdfToImageExportMode {
    Pages,
    Long,
}

#[derive(Clone, Debug)]
struct PdfToImageSourcePage {
    page_number: u32,
    path: std::path::PathBuf,
    width: u32,
    height: u32,
}

struct PdfToImageTemporaryFile {
    path: std::path::PathBuf,
}

impl PdfToImageTemporaryFile {
    fn new(directory: &std::path::Path) -> Self {
        let counter = PDF_TO_IMAGE_TEMP_COUNTER.fetch_add(1, Ordering::Relaxed);
        Self {
            path: directory.join(format!(
                ".toolknit-pdf-image-{}-{}-{}.tmp",
                std::process::id(),
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_nanos(),
                counter
            )),
        }
    }
}

impl Drop for PdfToImageTemporaryFile {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.path);
    }
}

struct PdfToImagePreparedOutput {
    temporary: PdfToImageTemporaryFile,
    logical_stem: String,
    extension: String,
    width: u32,
    height: u32,
    page_numbers: Vec<u32>,
}

fn pdf_to_image_session_root() -> std::path::PathBuf {
    std::env::temp_dir().join(PDF_TO_IMAGE_SESSION_ROOT)
}

fn valid_pdf_to_image_session_id(session_id: &str) -> bool {
    !session_id.is_empty()
        && session_id.len() <= 96
        && session_id
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || character == '-')
}

fn pdf_to_image_session_directory(session_id: &str) -> Result<std::path::PathBuf, String> {
    if !valid_pdf_to_image_session_id(session_id) {
        return Err("pdf-to-image:invalid-session".to_string());
    }
    let root = pdf_to_image_session_root();
    let directory = root.join(session_id);
    let canonical_root = root
        .canonicalize()
        .map_err(|_| "pdf-to-image:invalid-session".to_string())?;
    let canonical_directory = directory
        .canonicalize()
        .map_err(|_| "pdf-to-image:invalid-session".to_string())?;
    if !canonical_directory.starts_with(&canonical_root) || !canonical_directory.is_dir() {
        return Err("pdf-to-image:invalid-session".to_string());
    }
    Ok(canonical_directory)
}

fn remove_pdf_to_image_session(session_id: &str) -> Result<(), String> {
    if !valid_pdf_to_image_session_id(session_id) {
        return Err("pdf-to-image:invalid-session".to_string());
    }
    let directory = pdf_to_image_session_root().join(session_id);
    if !directory.exists() {
        return Ok(());
    }
    let directory = pdf_to_image_session_directory(session_id)?;
    std::fs::remove_dir_all(directory)
        .map_err(|_| "pdf-to-image:session-cleanup-failed".to_string())
}

fn cleanup_pdf_to_image_sessions() {
    let root = pdf_to_image_session_root();
    if root.is_dir() {
        let _ = std::fs::remove_dir_all(root);
    }
}

#[tauri::command]
fn create_pdf_to_image_session() -> Result<PdfToImageSession, String> {
    let root = pdf_to_image_session_root();
    std::fs::create_dir_all(&root).map_err(|_| "pdf-to-image:session-create-failed".to_string())?;
    for _ in 0..10_000 {
        let counter = PDF_TO_IMAGE_SESSION_COUNTER.fetch_add(1, Ordering::SeqCst);
        let session_id = format!(
            "{}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos(),
            counter
        );
        let directory = root.join(&session_id);
        match std::fs::create_dir(&directory) {
            Ok(()) => {
                return Ok(PdfToImageSession {
                    session_id,
                    directory: cleanup_display_path(&directory),
                });
            }
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(_) => return Err("pdf-to-image:session-create-failed".to_string()),
        }
    }
    Err("pdf-to-image:session-create-failed".to_string())
}

fn pdf_to_image_session_usage(directory: &std::path::Path) -> Result<(usize, u64), String> {
    let mut count = 0usize;
    let mut bytes = 0u64;
    for entry in
        std::fs::read_dir(directory).map_err(|_| "pdf-to-image:invalid-session".to_string())?
    {
        let entry = entry.map_err(|_| "pdf-to-image:invalid-session".to_string())?;
        let metadata = entry
            .metadata()
            .map_err(|_| "pdf-to-image:invalid-session".to_string())?;
        if metadata.is_file() {
            count = count.saturating_add(1);
            bytes = bytes.saturating_add(metadata.len());
        }
    }
    Ok((count, bytes))
}

fn pdf_to_image_page_number_from_file_name(file_name: &str) -> Option<u32> {
    let digits = file_name.strip_prefix("page_")?.strip_suffix(".png")?;
    if digits.len() != 5 || !digits.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    let page_number = digits.parse::<u32>().ok()?;
    if page_number == 0
        || page_number > 10_000
        || file_name != format!("page_{:05}.png", page_number)
    {
        return None;
    }
    Some(page_number)
}

fn write_pdf_to_image_page_bytes(
    session_id: &str,
    file_name: &str,
    bytes: &[u8],
) -> Result<PdfToImagePageWriteResult, String> {
    use std::io::Write;

    let page_number = pdf_to_image_page_number_from_file_name(file_name)
        .ok_or_else(|| "pdf-to-image:invalid-page-name".to_string())?;
    if bytes.len() < 8
        || bytes.len() > PDF_TO_IMAGE_MAX_PAGE_BYTES
        || bytes[..8] != [137, 80, 78, 71, 13, 10, 26, 10]
    {
        return Err("pdf-to-image:invalid-page".to_string());
    }
    let directory = pdf_to_image_session_directory(session_id)?;
    let output_path = directory.join(file_name);
    if output_path.exists() {
        return Err("pdf-to-image:duplicate-page".to_string());
    }
    let (page_count, session_bytes) = pdf_to_image_session_usage(&directory)?;
    if page_count >= PDF_TO_IMAGE_MAX_PAGES {
        return Err("pdf-to-image:too-many-pages".to_string());
    }
    if session_bytes.saturating_add(bytes.len() as u64) > PDF_TO_IMAGE_MAX_SESSION_BYTES {
        return Err("pdf-to-image:session-too-large".to_string());
    }

    let mut output = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&output_path)
        .map_err(|_| "pdf-to-image:page-write-failed".to_string())?;
    if let Err(error) = output.write_all(&bytes).and_then(|_| output.sync_all()) {
        drop(output);
        let _ = std::fs::remove_file(&output_path);
        return Err(format!("pdf-to-image:page-write-failed:{error}"));
    }
    drop(output);

    let dimensions = image::image_dimensions(&output_path).ok();
    let Some((width, height)) = dimensions else {
        let _ = std::fs::remove_file(&output_path);
        return Err("pdf-to-image:invalid-page".to_string());
    };
    let pixels = u64::from(width).saturating_mul(u64::from(height));
    if width == 0
        || height == 0
        || width > PDF_TO_IMAGE_MAX_RENDER_SIDE
        || height > PDF_TO_IMAGE_MAX_RENDER_SIDE
        || pixels > PDF_TO_IMAGE_MAX_RENDER_PIXELS
    {
        let _ = std::fs::remove_file(&output_path);
        return Err("pdf-to-image:invalid-page".to_string());
    }
    Ok(PdfToImagePageWriteResult {
        page_number,
        path: cleanup_display_path(&output_path),
        width,
        height,
        byte_length: bytes.len() as u64,
    })
}

#[tauri::command]
fn write_pdf_to_image_page(
    request: tauri::ipc::Request<'_>,
) -> Result<PdfToImagePageWriteResult, String> {
    let session_id = request
        .headers()
        .get("session-id")
        .and_then(|value| value.to_str().ok())
        .ok_or_else(|| "pdf-to-image:invalid-session".to_string())?;
    let file_name = request
        .headers()
        .get("file-name")
        .and_then(|value| value.to_str().ok())
        .ok_or_else(|| "pdf-to-image:invalid-page-name".to_string())?;
    let bytes = match request.body() {
        tauri::ipc::InvokeBody::Raw(bytes) => bytes.as_slice(),
        _ => return Err("pdf-to-image:raw-body-required".to_string()),
    };
    write_pdf_to_image_page_bytes(session_id, file_name, bytes)
}

#[tauri::command]
fn write_pdf_to_image_page_json(
    session_id: String,
    file_name: String,
    bytes: Vec<u8>,
) -> Result<PdfToImagePageWriteResult, String> {
    write_pdf_to_image_page_bytes(&session_id, &file_name, &bytes)
}

#[tauri::command]
fn read_pdf_to_image_source(path: String) -> Result<tauri::ipc::Response, String> {
    use std::io::Read;

    const MAX_PDF_BYTES: u64 = 150 * 1024 * 1024;
    if path.contains('\0') {
        return Err("pdf-to-image:invalid-pdf".to_string());
    }
    let requested = std::path::PathBuf::from(path);
    let requested_metadata = std::fs::symlink_metadata(&requested)
        .map_err(|_| "pdf-to-image:invalid-pdf".to_string())?;
    if requested_metadata.file_type().is_symlink() || !requested_metadata.is_file() {
        return Err("pdf-to-image:invalid-pdf".to_string());
    }
    let input = requested
        .canonicalize()
        .map_err(|_| "pdf-to-image:invalid-pdf".to_string())?;
    if !input
        .extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| extension.eq_ignore_ascii_case("pdf"))
    {
        return Err("pdf-to-image:invalid-pdf".to_string());
    }
    if requested_metadata.len() < 5 || requested_metadata.len() > MAX_PDF_BYTES {
        return Err(if requested_metadata.len() > MAX_PDF_BYTES {
            "pdf-to-image:pdf-too-large".to_string()
        } else {
            "pdf-to-image:invalid-pdf".to_string()
        });
    }
    let file = std::fs::File::open(&input).map_err(|_| "pdf-to-image:invalid-pdf".to_string())?;
    let mut reader = file.take(MAX_PDF_BYTES + 1);
    let mut bytes = Vec::with_capacity(requested_metadata.len() as usize);
    reader
        .read_to_end(&mut bytes)
        .map_err(|_| "pdf-to-image:invalid-pdf".to_string())?;
    if bytes.len() as u64 > MAX_PDF_BYTES {
        return Err("pdf-to-image:pdf-too-large".to_string());
    }
    let header_length = bytes.len().min(1024);
    if !bytes[..header_length]
        .windows(5)
        .any(|window| window == b"%PDF-")
    {
        return Err("pdf-to-image:invalid-pdf".to_string());
    }
    Ok(tauri::ipc::Response::new(bytes))
}

#[tauri::command]
fn discard_pdf_to_image_session(session_id: String) -> Result<(), String> {
    remove_pdf_to_image_session(&session_id)
}

fn normalize_pdf_to_image_format(value: &str) -> Result<(String, String), String> {
    match value.trim().to_ascii_lowercase().as_str() {
        "png" => Ok(("png".to_string(), ".png".to_string())),
        "jpg" | "jpeg" => Ok(("jpg".to_string(), ".jpg".to_string())),
        "webp" => Ok(("webp".to_string(), ".webp".to_string())),
        _ => Err("pdf-to-image:invalid-format".to_string()),
    }
}

fn normalize_pdf_to_image_mode(value: &str) -> Result<PdfToImageExportMode, String> {
    match value.trim().to_ascii_lowercase().as_str() {
        "images" | "pages" => Ok(PdfToImageExportMode::Pages),
        "long" => Ok(PdfToImageExportMode::Long),
        _ => Err("pdf-to-image:invalid-mode".to_string()),
    }
}

fn load_pdf_to_image_source_pages(
    session_directory: &std::path::Path,
    page_numbers: &[u32],
) -> Result<Vec<PdfToImageSourcePage>, String> {
    let mut seen = std::collections::BTreeSet::new();
    let mut pages = Vec::with_capacity(page_numbers.len());
    for page_number in page_numbers {
        if *page_number == 0 || *page_number > 10_000 || !seen.insert(*page_number) {
            return Err("pdf-to-image:invalid-selection".to_string());
        }
        let path = session_directory.join(format!("page_{:05}.png", page_number));
        let metadata = std::fs::symlink_metadata(&path)
            .map_err(|_| "pdf-to-image:missing-page".to_string())?;
        if metadata.file_type().is_symlink()
            || !metadata.is_file()
            || metadata.len() == 0
            || metadata.len() > PDF_TO_IMAGE_MAX_PAGE_BYTES as u64
        {
            return Err("pdf-to-image:invalid-page".to_string());
        }
        let canonical = path
            .canonicalize()
            .map_err(|_| "pdf-to-image:invalid-page".to_string())?;
        if !canonical.starts_with(session_directory) {
            return Err("pdf-to-image:invalid-page".to_string());
        }
        let (width, height) = image::image_dimensions(&canonical)
            .map_err(|_| "pdf-to-image:invalid-page".to_string())?;
        let pixels = u64::from(width).saturating_mul(u64::from(height));
        if width == 0
            || height == 0
            || width > PDF_TO_IMAGE_MAX_RENDER_SIDE
            || height > PDF_TO_IMAGE_MAX_RENDER_SIDE
            || pixels > PDF_TO_IMAGE_MAX_RENDER_PIXELS
        {
            return Err("pdf-to-image:invalid-page".to_string());
        }
        pages.push(PdfToImageSourcePage {
            page_number: *page_number,
            path: canonical,
            width,
            height,
        });
    }
    Ok(pages)
}

fn pdf_to_image_group_layout(
    pages: &[PdfToImageSourcePage],
    max_pixels: u64,
) -> Result<ImageStitchLayout, String> {
    if pages.is_empty() {
        return Err("pdf-to-image:invalid-selection".to_string());
    }
    let width = pages
        .iter()
        .map(|page| page.width)
        .max()
        .ok_or_else(|| "pdf-to-image:invalid-selection".to_string())?;
    let height = pages.iter().try_fold(0u64, |sum, page| {
        sum.checked_add(u64::from(page.height))
            .ok_or_else(|| "pdf-to-image:output-too-large".to_string())
    })?;
    if width > PDF_TO_IMAGE_MAX_LONG_SIDE || height > u64::from(PDF_TO_IMAGE_MAX_LONG_SIDE) {
        return Err("pdf-to-image:output-too-large".to_string());
    }
    let pixels = u64::from(width)
        .checked_mul(height)
        .ok_or_else(|| "pdf-to-image:output-too-large".to_string())?;
    if pixels > max_pixels {
        return Err("pdf-to-image:output-too-large-for-memory".to_string());
    }
    let max_page_pixels = pages
        .iter()
        .map(|page| u64::from(page.width) * u64::from(page.height))
        .max()
        .unwrap_or(0);
    let estimated_working_bytes = pixels
        .checked_mul(6)
        .and_then(|value| value.checked_add(max_page_pixels.saturating_mul(4)))
        .ok_or_else(|| "pdf-to-image:output-too-large-for-memory".to_string())?;
    if estimated_working_bytes > PDF_TO_IMAGE_MAX_ESTIMATED_WORKING_BYTES {
        return Err("pdf-to-image:output-too-large-for-memory".to_string());
    }
    Ok(ImageStitchLayout {
        sizes: pages.iter().map(|page| (page.width, page.height)).collect(),
        width,
        height: height as u32,
    })
}

fn build_pdf_to_image_groups(
    pages: &[PdfToImageSourcePage],
    mode: PdfToImageExportMode,
    pages_per_long_image: usize,
    max_pixels: u64,
) -> Result<Vec<Vec<PdfToImageSourcePage>>, String> {
    if mode == PdfToImageExportMode::Pages {
        for page in pages {
            pdf_to_image_group_layout(std::slice::from_ref(page), max_pixels)?;
        }
        return Ok(pages.iter().cloned().map(|page| vec![page]).collect());
    }

    let mut groups = Vec::new();
    let mut current = Vec::new();
    for page in pages.iter().cloned() {
        if current.len() >= pages_per_long_image {
            groups.push(std::mem::take(&mut current));
        }
        let mut candidate = current.clone();
        candidate.push(page.clone());
        if pdf_to_image_group_layout(&candidate, max_pixels).is_ok() {
            current = candidate;
            continue;
        }
        if !current.is_empty() {
            groups.push(std::mem::take(&mut current));
        }
        pdf_to_image_group_layout(std::slice::from_ref(&page), max_pixels)?;
        current.push(page);
    }
    if !current.is_empty() {
        groups.push(current);
    }
    Ok(groups)
}

fn compose_pdf_to_image_group(
    pages: &[PdfToImageSourcePage],
    layout: &ImageStitchLayout,
    background: image::Rgba<u8>,
    format: &str,
    cancelled: &AtomicBool,
) -> Result<image::RgbaImage, String> {
    let canvas_background = if format == "jpg" {
        image::Rgba([background.0[0], background.0[1], background.0[2], 255])
    } else {
        background
    };
    let mut canvas = image::RgbaImage::from_pixel(layout.width, layout.height, canvas_background);
    let mut cursor = 0u32;
    for (page, (width, height)) in pages.iter().zip(layout.sizes.iter()) {
        if cancelled.load(Ordering::SeqCst) {
            return Err("pdf-to-image:cancelled".to_string());
        }
        let decoded =
            read_oriented_image(&page.path).map_err(|_| "pdf-to-image:invalid-page".to_string())?;
        if decoded.width() != *width || decoded.height() != *height {
            return Err("pdf-to-image:invalid-page".to_string());
        }
        let rendered = decoded.into_rgba8();
        let x = (layout.width.saturating_sub(*width)) / 2;
        image::imageops::overlay(&mut canvas, &rendered, i64::from(x), i64::from(cursor));
        cursor = cursor.saturating_add(*height);
    }
    Ok(canvas)
}

fn encode_pdf_to_image(
    canvas: image::RgbaImage,
    temporary: &std::path::Path,
    format: &str,
    jpeg_quality: u8,
) -> Result<(), String> {
    use image::ImageEncoder;
    use std::io::{BufWriter, Write};

    let file = std::fs::OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(temporary)
        .map_err(|_| "pdf-to-image:output-path".to_string())?;
    let mut writer = BufWriter::new(file);
    match format {
        "jpg" => {
            let width = canvas.width();
            let height = canvas.height();
            let rgb = image::DynamicImage::ImageRgba8(canvas).into_rgb8();
            image::codecs::jpeg::JpegEncoder::new_with_quality(&mut writer, jpeg_quality)
                .encode(&rgb, width, height, image::ExtendedColorType::Rgb8)
                .map_err(|_| "pdf-to-image:encode-failed".to_string())?;
        }
        "webp" => {
            image::codecs::webp::WebPEncoder::new_lossless(&mut writer)
                .encode(
                    canvas.as_raw(),
                    canvas.width(),
                    canvas.height(),
                    image::ExtendedColorType::Rgba8,
                )
                .map_err(|_| "pdf-to-image:encode-failed".to_string())?;
        }
        "png" => {
            image::codecs::png::PngEncoder::new(&mut writer)
                .write_image(
                    canvas.as_raw(),
                    canvas.width(),
                    canvas.height(),
                    image::ExtendedColorType::Rgba8,
                )
                .map_err(|_| "pdf-to-image:encode-failed".to_string())?;
        }
        _ => return Err("pdf-to-image:invalid-format".to_string()),
    }
    writer
        .flush()
        .and_then(|_| writer.get_ref().sync_all())
        .map_err(|_| "pdf-to-image:output-path".to_string())
}

fn pdf_to_image_logical_stem(
    base: &str,
    mode: PdfToImageExportMode,
    output_index: usize,
    pages: &[PdfToImageSourcePage],
    page_count: u32,
) -> String {
    let digits = std::cmp::max(2, page_count.to_string().len());
    if mode == PdfToImageExportMode::Pages {
        return format!(
            "{}_page_{:0width$}",
            base,
            pages[0].page_number,
            width = digits
        );
    }
    let page_label = pages
        .iter()
        .map(|page| format!("{:0width$}", page.page_number, width = digits))
        .collect::<Vec<_>>()
        .join("_");
    format!("{}_long_{:02}_pages_{}", base, output_index + 1, page_label)
}

fn pdf_to_image_candidate_path(
    directory: &std::path::Path,
    prepared: &PdfToImagePreparedOutput,
    batch_suffix: u32,
) -> std::path::PathBuf {
    let suffix = if batch_suffix == 0 {
        String::new()
    } else {
        format!("_{}", batch_suffix)
    };
    directory.join(format!(
        "{}{}{}",
        prepared.logical_stem, suffix, prepared.extension
    ))
}

fn copy_pdf_to_image_output(
    source: &std::path::Path,
    target: &std::path::Path,
    cancelled: &AtomicBool,
) -> std::io::Result<()> {
    use std::io::{Read, Write};

    if cancelled.load(Ordering::SeqCst) {
        return Err(std::io::Error::new(
            std::io::ErrorKind::Interrupted,
            "PDF image export cancelled",
        ));
    }
    let input = std::fs::File::open(source)?;
    let output = std::fs::OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(target)?;
    let mut reader = std::io::BufReader::with_capacity(256 * 1024, input);
    let mut writer = std::io::BufWriter::with_capacity(256 * 1024, output);
    let result = (|| -> std::io::Result<()> {
        let mut buffer = vec![0u8; 256 * 1024];
        loop {
            if cancelled.load(Ordering::SeqCst) {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::Interrupted,
                    "PDF image export cancelled",
                ));
            }
            let read = reader.read(&mut buffer)?;
            if read == 0 {
                break;
            }
            writer.write_all(&buffer[..read])?;
        }
        if cancelled.load(Ordering::SeqCst) {
            return Err(std::io::Error::new(
                std::io::ErrorKind::Interrupted,
                "PDF image export cancelled",
            ));
        }
        writer.flush()?;
        writer.get_ref().sync_all()
    })();
    if result.is_err() {
        drop(writer);
        let _ = std::fs::remove_file(target);
    }
    result
}

fn publish_pdf_to_image_output(
    source: &std::path::Path,
    target: &std::path::Path,
    cancelled: &AtomicBool,
) -> std::io::Result<()> {
    match std::fs::hard_link(source, target) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => Err(error),
        Err(_) => copy_pdf_to_image_output(source, target, cancelled),
    }
}

fn publish_pdf_to_image_batch(
    prepared: &[PdfToImagePreparedOutput],
    directory: &std::path::Path,
    cancelled: &AtomicBool,
) -> Result<Vec<PdfToImageExportItem>, String> {
    if prepared.is_empty() {
        return Err("pdf-to-image:no-output".to_string());
    }
    for batch_suffix in 0..10_000u32 {
        if cancelled.load(Ordering::SeqCst) {
            return Err("pdf-to-image:cancelled".to_string());
        }
        let candidates = prepared
            .iter()
            .map(|item| pdf_to_image_candidate_path(directory, item, batch_suffix))
            .collect::<Vec<_>>();
        if candidates.iter().any(|candidate| candidate.exists()) {
            continue;
        }

        let mut published = Vec::with_capacity(prepared.len());
        let mut collision = false;
        let mut fatal = false;
        for (item, candidate) in prepared.iter().zip(candidates.iter()) {
            if cancelled.load(Ordering::SeqCst) {
                fatal = true;
                break;
            }
            match publish_pdf_to_image_output(&item.temporary.path, candidate, cancelled) {
                Ok(()) => published.push(candidate.clone()),
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                    collision = true;
                    break;
                }
                Err(_) => {
                    fatal = true;
                    break;
                }
            }
        }
        if cancelled.load(Ordering::SeqCst) {
            fatal = true;
        }
        if collision || fatal {
            for path in &published {
                let _ = std::fs::remove_file(path);
            }
            if collision {
                continue;
            }
            return Err(if cancelled.load(Ordering::SeqCst) {
                "pdf-to-image:cancelled".to_string()
            } else {
                "pdf-to-image:publish-failed".to_string()
            });
        }

        return Ok(prepared
            .iter()
            .zip(candidates)
            .map(|(item, output_path)| PdfToImageExportItem {
                output_path: cleanup_display_path(&output_path),
                width: item.width,
                height: item.height,
                page_numbers: item.page_numbers.clone(),
            })
            .collect());
    }
    Err("pdf-to-image:output-path".to_string())
}

fn export_pdf_to_images_blocking<F>(
    request: PdfToImageExportRequest,
    cancelled: &AtomicBool,
    mut progress: F,
) -> Result<PdfToImageExportResult, String>
where
    F: FnMut(&str, usize, usize, u8),
{
    if cancelled.load(Ordering::SeqCst) {
        return Err("pdf-to-image:cancelled".to_string());
    }
    let mode = normalize_pdf_to_image_mode(&request.export_mode)?;
    let unique_page_numbers = request
        .page_numbers
        .iter()
        .copied()
        .collect::<std::collections::BTreeSet<_>>();
    if request.page_count == 0
        || request.page_count as usize > PDF_TO_IMAGE_MAX_PAGES
        || request.page_numbers.is_empty()
        || request.page_numbers.len() > PDF_TO_IMAGE_MAX_PAGES
        || unique_page_numbers.len() != request.page_numbers.len()
        || request
            .page_numbers
            .iter()
            .any(|page_number| *page_number == 0 || *page_number > request.page_count)
    {
        return Err("pdf-to-image:invalid-selection".to_string());
    }
    if mode == PdfToImageExportMode::Long
        && request.page_numbers.len() > PDF_TO_IMAGE_MAX_LONG_PAGES
    {
        return Err("pdf-to-image:too-many-long-pages".to_string());
    }
    let pages_per_long_image = usize::from(
        request
            .pages_per_long_image
            .unwrap_or(PDF_TO_IMAGE_MAX_PAGES_PER_LONG_IMAGE as u8),
    );
    if pages_per_long_image == 0 || pages_per_long_image > PDF_TO_IMAGE_MAX_PAGES_PER_LONG_IMAGE {
        return Err("pdf-to-image:invalid-group-size".to_string());
    }
    let jpeg_quality = request.jpeg_quality.unwrap_or(92);
    if !(60..=100).contains(&jpeg_quality) {
        return Err("pdf-to-image:invalid-quality".to_string());
    }
    let (format, extension) = normalize_pdf_to_image_format(&request.format)?;
    let background = stitch_background(request.background_rgba.as_deref().unwrap_or("#FFFFFFFF"))
        .map_err(|_| "pdf-to-image:invalid-background".to_string())?;
    let base_name =
        normalize_image_stitch_output_name(request.output_name.as_deref().or(Some("document")))
            .map_err(|_| "pdf-to-image:invalid-output-name".to_string())?
            .trim()
            .to_string();
    let session_directory = pdf_to_image_session_directory(&request.session_id)?;
    let output_directory = validate_image_output_dir(&request.output_dir)
        .map_err(|_| "pdf-to-image:output-path".to_string())?;

    progress("prepare", 0, request.page_numbers.len(), 2);
    let pages = load_pdf_to_image_source_pages(&session_directory, &request.page_numbers)?;
    for (index, _) in pages.iter().enumerate() {
        if cancelled.load(Ordering::SeqCst) {
            return Err("pdf-to-image:cancelled".to_string());
        }
        progress(
            "inspect",
            index + 1,
            pages.len(),
            2 + (((index + 1) * 10 / pages.len()) as u8),
        );
    }

    let max_output_pixels = available_image_stitch_pixels().min(PDF_TO_IMAGE_MAX_LONG_PIXELS);
    let groups = build_pdf_to_image_groups(&pages, mode, pages_per_long_image, max_output_pixels)?;
    let mut prepared = Vec::with_capacity(groups.len());
    for (index, group) in groups.iter().enumerate() {
        if cancelled.load(Ordering::SeqCst) {
            return Err("pdf-to-image:cancelled".to_string());
        }
        let layout = pdf_to_image_group_layout(group, max_output_pixels)?;
        progress(
            "compose",
            index,
            groups.len(),
            12 + ((index * 65 / groups.len()) as u8),
        );
        let canvas = compose_pdf_to_image_group(group, &layout, background, &format, cancelled)?;
        let temporary = PdfToImageTemporaryFile::new(&output_directory);
        encode_pdf_to_image(canvas, &temporary.path, &format, jpeg_quality)?;
        if cancelled.load(Ordering::SeqCst) {
            return Err("pdf-to-image:cancelled".to_string());
        }
        prepared.push(PdfToImagePreparedOutput {
            temporary,
            logical_stem: pdf_to_image_logical_stem(
                &base_name,
                mode,
                index,
                group,
                request.page_count,
            ),
            extension: extension.clone(),
            width: layout.width,
            height: layout.height,
            page_numbers: group.iter().map(|page| page.page_number).collect(),
        });
        progress(
            "encode",
            index + 1,
            groups.len(),
            12 + (((index + 1) * 73 / groups.len()) as u8),
        );
    }

    progress("publish", prepared.len(), prepared.len(), 90);
    let outputs = publish_pdf_to_image_batch(&prepared, &output_directory, cancelled)?;
    progress("complete", outputs.len(), outputs.len(), 100);
    Ok(PdfToImageExportResult {
        output_dir: cleanup_display_path(&output_directory),
        output_count: outputs.len(),
        page_count: pages.len(),
        outputs,
        format: format.to_ascii_uppercase(),
        export_mode: match mode {
            PdfToImageExportMode::Pages => "images".to_string(),
            PdfToImageExportMode::Long => "long".to_string(),
        },
    })
}

#[tauri::command]
async fn export_pdf_to_images(
    app_handle: tauri::AppHandle,
    request: PdfToImageExportRequest,
) -> Result<PdfToImageExportResult, String> {
    let job_id = request
        .job_id
        .clone()
        .unwrap_or_else(|| "desktop".to_string());
    let job_guard = PdfToImageJobGuard::register(job_id.clone())?;
    let _guard = begin_conversion().map_err(|_| "pdf-to-image:busy".to_string())?;
    let cleanup_session_id = request.session_id.clone();
    let cancelled = std::sync::Arc::clone(&job_guard.cancelled);
    let worker = tokio::task::spawn_blocking(move || {
        export_pdf_to_images_blocking(request, &cancelled, |phase, current, total, percent| {
            let _ = app_handle.emit(
                "pdf-to-image-progress",
                serde_json::json!({
                    "jobId": job_id,
                    "phase": phase,
                    "current": current,
                    "total": total,
                    "percent": percent
                }),
            );
        })
    })
    .await
    .map_err(|error| format!("pdf-to-image:worker-failed:{error}"));
    let _ = remove_pdf_to_image_session(&cleanup_session_id);
    worker?
}

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

#[cfg(test)]
mod image_conversion_tests {
    use super::*;
    use image::{GenericImage, GenericImageView, ImageEncoder};

    fn image_test_directory(label: &str) -> std::path::PathBuf {
        let unique = format!(
            "toolknit-image-{}-{}-{}",
            label,
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("system clock before Unix epoch")
                .as_nanos()
        );
        let directory = std::env::temp_dir().join(unique);
        std::fs::create_dir_all(&directory).expect("create temporary image test directory");
        directory
    }

    fn exif_orientation_payload(orientation: u16) -> Vec<u8> {
        let mut exif = vec![0_u8; 26];
        exif[0..2].copy_from_slice(b"II");
        exif[2..4].copy_from_slice(&42_u16.to_le_bytes());
        exif[4..8].copy_from_slice(&8_u32.to_le_bytes());
        exif[8..10].copy_from_slice(&1_u16.to_le_bytes());
        exif[10..12].copy_from_slice(&0x0112_u16.to_le_bytes());
        exif[12..14].copy_from_slice(&3_u16.to_le_bytes());
        exif[14..18].copy_from_slice(&1_u32.to_le_bytes());
        exif[18..20].copy_from_slice(&orientation.to_le_bytes());
        exif
    }

    fn write_exif_jpeg(path: &std::path::Path, image: &image::RgbImage, orientation: u16) {
        let file = std::fs::File::create(path).expect("create EXIF JPEG fixture");
        let writer = std::io::BufWriter::new(file);
        let mut encoder = image::codecs::jpeg::JpegEncoder::new_with_quality(writer, 100);
        encoder
            .set_exif_metadata(exif_orientation_payload(orientation))
            .expect("attach EXIF orientation");
        encoder
            .encode(
                image.as_raw(),
                image.width(),
                image.height(),
                image::ExtendedColorType::Rgb8,
            )
            .expect("encode EXIF JPEG fixture");
    }

    fn assert_rgb_near(actual: image::Rgb<u8>, expected: [u8; 3], tolerance: i16) {
        for (actual, expected) in actual.0.into_iter().zip(expected) {
            assert!(
                (i16::from(actual) - i16::from(expected)).abs() <= tolerance,
                "channel {actual} differs from expected {expected} by more than {tolerance}"
            );
        }
    }

    #[test]
    fn jpeg_writers_flatten_transparent_pixels_onto_white() {
        let directory = image_test_directory("jpeg-alpha");
        let input = directory.join("transparent.png");
        let converted_output = directory.join("converted.jpg");
        let compressed_output = directory.join("compressed.jpg");

        let source = image::RgbaImage::from_fn(64, 64, |x, y| match (x < 32, y < 32) {
            (true, true) => image::Rgba([255, 0, 0, 0]),
            (false, true) => image::Rgba([0, 255, 0, 255]),
            (true, false) => image::Rgba([0, 0, 255, 128]),
            (false, false) => image::Rgba([0, 0, 0, 0]),
        });
        source.save(&input).expect("write transparent PNG fixture");
        let decoded = decode_oriented_image(&input).expect("decode transparent PNG fixture");
        write_converted_image(&decoded, &converted_output, image::ImageFormat::Jpeg)
            .expect("RGBA image should convert to JPEG");
        write_compressed_image(
            &decoded,
            &compressed_output,
            image::ImageFormat::Jpeg,
            92,
            image::codecs::png::CompressionType::Default,
        )
        .expect("RGBA image should compress to JPEG");

        for output in [&converted_output, &compressed_output] {
            let decoded = image::open(output)
                .expect("JPEG output should be readable")
                .to_rgb8();
            assert_eq!((decoded.width(), decoded.height()), (64, 64));
            assert_rgb_near(*decoded.get_pixel(4, 4), [255, 255, 255], 20);
            assert_rgb_near(*decoded.get_pixel(59, 4), [0, 255, 0], 20);
            assert_rgb_near(*decoded.get_pixel(4, 59), [127, 127, 255], 24);
            assert_rgb_near(*decoded.get_pixel(59, 59), [255, 255, 255], 20);
        }
        std::fs::remove_dir_all(&directory).expect("remove temporary image test directory");
    }

    #[test]
    fn exif_orientation_is_applied_to_shared_decode_and_icon_preparation() {
        let directory = image_test_directory("exif-orientation");
        let input = directory.join("orientation-6.jpg");
        let converted = directory.join("orientation-applied.png");
        let source = image::RgbImage::from_fn(64, 32, |x, y| match (x < 32, y < 16) {
            (true, true) => image::Rgb([255, 0, 0]),
            (false, true) => image::Rgb([0, 255, 0]),
            (true, false) => image::Rgb([0, 0, 255]),
            (false, false) => image::Rgb([255, 255, 0]),
        });
        write_exif_jpeg(&input, &source, 6);

        let decoded = decode_oriented_image(&input).expect("decode oriented JPEG");
        assert_eq!((decoded.width(), decoded.height()), (32, 64));
        let decoded_rgb = decoded.to_rgb8();
        assert_rgb_near(*decoded_rgb.get_pixel(4, 4), [0, 0, 255], 28);
        assert_rgb_near(*decoded_rgb.get_pixel(27, 4), [255, 0, 0], 28);
        assert_rgb_near(*decoded_rgb.get_pixel(4, 59), [255, 255, 0], 28);
        assert_rgb_near(*decoded_rgb.get_pixel(27, 59), [0, 255, 0], 28);

        write_converted_image(&decoded, &converted, image::ImageFormat::Png)
            .expect("write orientation-normalized PNG");
        let normalized = image::open(&converted)
            .expect("read orientation-normalized PNG")
            .to_rgb8();
        assert_eq!(normalized.dimensions(), (32, 64));
        assert_rgb_near(*normalized.get_pixel(4, 4), [0, 0, 255], 28);

        let prepared = prepare_icon_source_image(input.to_string_lossy().into_owned())
            .expect("prepare oriented icon source");
        assert_eq!((prepared.width, prepared.height), (32, 64));
        let prepared_image = image::load_from_memory(&prepared.bytes)
            .expect("decode prepared icon PNG")
            .to_rgb8();
        assert_rgb_near(*prepared_image.get_pixel(4, 4), [0, 0, 255], 28);
        std::fs::remove_dir_all(&directory).expect("remove temporary image test directory");
    }

    #[test]
    fn svg_conversion_produces_a_standard_embedded_image_document() {
        let unique = format!(
            "toolknit-svg-test-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("system clock before Unix epoch")
                .as_nanos()
        );
        let directory = std::env::temp_dir().join(unique);
        std::fs::create_dir_all(&directory).expect("create temporary image test directory");
        let output = directory.join("converted.svg");
        let source = image::DynamicImage::new_rgba8(3, 2);
        write_raster_svg(&source, &output).expect("write SVG image document");

        let svg = std::fs::read_to_string(&output).expect("read SVG output");
        assert!(svg.contains("<svg xmlns=\"http://www.w3.org/2000/svg\""));
        assert!(svg.contains("width=\"3\" height=\"2\""));
        assert!(svg.contains("data:image/png;base64,"));
        std::fs::remove_dir_all(&directory).expect("remove temporary image test directory");
    }

    #[test]
    fn image_batch_rejects_duplicate_inputs_and_never_overwrites_outputs() {
        let unique = format!(
            "toolknit-image-publish-test-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("system clock before Unix epoch")
                .as_nanos()
        );
        let directory = std::env::temp_dir().join(unique);
        std::fs::create_dir_all(&directory).expect("create temporary image test directory");
        let input = directory.join("input.png");
        image::DynamicImage::new_rgba8(2, 2)
            .save_with_format(&input, image::ImageFormat::Png)
            .expect("write input PNG");

        let duplicate_result = validate_image_batch_inputs(&[
            input.to_string_lossy().to_string(),
            input.to_string_lossy().to_string(),
        ]);
        assert!(duplicate_result
            .expect_err("duplicate input must fail")
            .contains("Duplicate image file"));

        let temporary = directory.join("temporary.png");
        let output = directory.join("output.png");
        std::fs::write(&temporary, b"new-content").expect("write temporary output");
        std::fs::write(&output, b"existing-content").expect("write existing output");
        assert!(publish_image_output(&temporary, &output).is_err());
        assert_eq!(
            std::fs::read(&output).expect("read existing output"),
            b"existing-content"
        );
        assert!(temporary.exists());

        std::fs::remove_file(&output).expect("remove existing output");
        publish_image_output(&temporary, &output).expect("publish new output");
        assert_eq!(
            std::fs::read(&output).expect("read published output"),
            b"new-content"
        );
        assert!(!temporary.exists());
        std::fs::remove_dir_all(&directory).expect("remove temporary image test directory");
    }

    fn stitch_test_options(
        inputs: &[std::path::PathBuf],
        output: &std::path::Path,
        mode: &str,
        format: &str,
        background: &str,
    ) -> ImageStitchOptions {
        ImageStitchOptions {
            input_paths: inputs
                .iter()
                .map(|path| path.to_string_lossy().into_owned())
                .collect(),
            output_dir: output.to_string_lossy().into_owned(),
            output_name: None,
            mode: mode.to_string(),
            reference: "first".to_string(),
            spacing_px: 0,
            scale_percent: 100,
            format: format.to_string(),
            jpeg_quality: 92,
            background_rgba: background.to_string(),
        }
    }

    #[test]
    fn image_stitch_layout_rounds_and_counts_only_between_item_gaps() {
        let layout =
            calculate_image_stitch_layout(&[(101, 10), (5, 7)], "vertical", "first", 9, 50)
                .expect("calculate vertical layout");
        assert_eq!(layout.width, 51);
        assert_eq!(layout.sizes, vec![(51, 5), (51, 71)]);
        assert_eq!(layout.height, 5 + 9 + 71);

        let one_hundred = vec![(1, 1); 100];
        let boundary = calculate_image_stitch_layout(&one_hundred, "vertical", "smallest", 0, 100)
            .expect("100-image boundary should be valid");
        assert_eq!((boundary.width, boundary.height), (1, 100));
        assert!(
            calculate_image_stitch_layout(&vec![(1, 1); 101], "vertical", "first", 0, 100,)
                .is_err()
        );
    }

    #[test]
    fn image_stitch_outputs_are_complete_unique_and_pixel_correct() {
        let unique = format!(
            "toolknit-stitch-native-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("system clock before Unix epoch")
                .as_nanos()
        );
        let directory = std::env::temp_dir().join(unique);
        let output = directory.join("导出 结果");
        std::fs::create_dir_all(&output).expect("create stitch output directory");
        let red = directory.join("红 色.png");
        let blue = directory.join("blue.png");
        let transparent = directory.join("透明.png");
        image::RgbaImage::from_pixel(10, 20, image::Rgba([255, 0, 0, 255]))
            .save(&red)
            .expect("write red input");
        image::RgbaImage::from_pixel(20, 10, image::Rgba([0, 0, 255, 255]))
            .save(&blue)
            .expect("write blue input");
        image::RgbaImage::from_pixel(10, 10, image::Rgba([0, 0, 0, 0]))
            .save(&transparent)
            .expect("write transparent input");
        CANCEL_FLAG.store(false, Ordering::SeqCst);

        let first = stitch_images_blocking(
            stitch_test_options(
                &[red.clone(), blue.clone()],
                &output,
                "vertical",
                "png",
                "#FFFFFFFF",
            ),
            |_, _, _, _| {},
        )
        .expect("stitch vertical PNG");
        assert_eq!((first.width, first.height), (10, 25));
        let decoded = image::open(&first.output_path)
            .expect("read vertical output")
            .to_rgba8();
        assert_eq!(decoded.get_pixel(5, 19).0, [255, 0, 0, 255]);
        assert_eq!(decoded.get_pixel(5, 20).0, [0, 0, 255, 255]);

        let mut horizontal_options = stitch_test_options(
            &[red.clone(), blue.clone()],
            &output,
            "horizontal",
            "png",
            "#00FF00FF",
        );
        horizontal_options.spacing_px = 3;
        horizontal_options.reference = "largest".to_string();
        horizontal_options.scale_percent = 50;
        let second = stitch_images_blocking(horizontal_options, |_, _, _, _| {})
            .expect("stitch horizontal PNG");
        assert_eq!((second.width, second.height), (28, 10));
        assert_ne!(first.output_path, second.output_path);
        let horizontal = image::open(&second.output_path)
            .expect("read horizontal output")
            .to_rgba8();
        assert_eq!(horizontal.get_pixel(4, 5).0, [255, 0, 0, 255]);
        assert_eq!(horizontal.get_pixel(5, 5).0, [0, 255, 0, 255]);
        assert_eq!(horizontal.get_pixel(7, 5).0, [0, 255, 0, 255]);
        assert_eq!(horizontal.get_pixel(8, 5).0, [0, 0, 255, 255]);

        let alpha_result = stitch_images_blocking(
            stitch_test_options(
                &[transparent.clone(), blue.clone()],
                &output,
                "vertical",
                "png",
                "#12345600",
            ),
            |_, _, _, _| {},
        )
        .expect("stitch transparent PNG");
        let alpha = image::open(&alpha_result.output_path)
            .expect("read transparent output")
            .to_rgba8();
        assert_eq!(alpha.get_pixel(2, 2).0[3], 0);

        let jpeg_result = stitch_images_blocking(
            stitch_test_options(
                &[transparent, blue],
                &output,
                "vertical",
                "jpg",
                "#FF00FF00",
            ),
            |_, _, _, _| {},
        )
        .expect("stitch flattened JPEG");
        let jpeg = image::open(&jpeg_result.output_path)
            .expect("read JPEG output")
            .to_rgb8();
        let pixel = jpeg.get_pixel(2, 2).0;
        assert!(pixel[0] > 220 && pixel[2] > 220);
        assert!(!std::fs::read_dir(&output)
            .expect("read output directory")
            .filter_map(Result::ok)
            .any(|entry| entry
                .file_name()
                .to_string_lossy()
                .starts_with(".toolknit-stitch-")));
        std::fs::remove_dir_all(&directory).expect("remove stitch test directory");
    }

    #[test]
    fn image_stitch_rejects_damaged_duplicate_and_animated_inputs() {
        use image::codecs::gif::GifEncoder;
        use image::{Delay, Frame};
        let unique = format!("toolknit-stitch-invalid-{}", std::process::id());
        let directory = std::env::temp_dir().join(unique);
        std::fs::create_dir_all(&directory).expect("create invalid stitch test directory");
        let valid = directory.join("valid.png");
        let damaged = directory.join("damaged.png");
        let animated = directory.join("animated.gif");
        image::RgbaImage::from_pixel(2, 2, image::Rgba([1, 2, 3, 255]))
            .save(&valid)
            .expect("write valid input");
        std::fs::write(&damaged, b"not an image").expect("write damaged input");
        let gif_file = std::fs::File::create(&animated).expect("create animated GIF");
        let mut encoder = GifEncoder::new(gif_file);
        for color in [[255, 0, 0, 255], [0, 0, 255, 255]] {
            encoder
                .encode_frame(Frame::from_parts(
                    image::RgbaImage::from_pixel(2, 2, image::Rgba(color)),
                    0,
                    0,
                    Delay::from_numer_denom_ms(100, 1),
                ))
                .expect("encode GIF frame");
        }
        drop(encoder);

        assert!(validate_image_batch_inputs(&[
            valid.to_string_lossy().into_owned(),
            damaged.to_string_lossy().into_owned(),
        ])
        .is_err());
        assert!(validate_image_batch_inputs(&[
            valid.to_string_lossy().into_owned(),
            valid.to_string_lossy().into_owned(),
        ])
        .expect_err("duplicate must fail")
        .contains("Duplicate"));
        assert!(validate_image_batch_inputs(&[
            valid.to_string_lossy().into_owned(),
            animated.to_string_lossy().into_owned(),
        ])
        .expect_err("animated GIF must fail")
        .contains("animated"));
        std::fs::remove_dir_all(&directory).expect("remove invalid stitch test directory");
    }

    #[test]
    fn icon_archive_session_publishes_uniquely_and_discards_partial_output() {
        let unique = format!(
            "toolknit-icon-archive-test-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("system clock before Unix epoch")
                .as_nanos()
        );
        let directory = std::env::temp_dir().join(unique);
        std::fs::create_dir_all(&directory).expect("create temporary icon archive directory");
        std::fs::write(directory.join("icons.zip"), b"existing").expect("write existing archive");

        let session_id = begin_icon_archive_write(
            directory.to_string_lossy().to_string(),
            "icons.zip".to_string(),
        )
        .expect("begin archive write");
        append_icon_archive_chunk(session_id, b"generated".to_vec()).expect("append archive chunk");
        let output = finalize_icon_archive_write(session_id).expect("publish archive");
        assert!(output.ends_with("icons_1.zip"));
        assert_eq!(
            std::fs::read(&output).expect("read published archive"),
            b"generated"
        );
        assert_eq!(
            std::fs::read(directory.join("icons.zip")).expect("read original archive"),
            b"existing"
        );

        let discarded_session = begin_icon_archive_write(
            directory.to_string_lossy().to_string(),
            "discard.zip".to_string(),
        )
        .expect("begin archive discard test");
        append_icon_archive_chunk(discarded_session, b"partial".to_vec())
            .expect("append partial archive");
        discard_icon_archive_write(discarded_session).expect("discard partial archive");
        assert!(!directory.join("discard.zip").exists());
        std::fs::remove_dir_all(&directory).expect("remove temporary icon archive directory");
    }

    #[test]
    fn image_conversion_keeps_successful_outputs_when_one_input_is_damaged() {
        let _conversion_lock = test_conversion_lock();
        CANCEL_FLAG.store(false, Ordering::SeqCst);
        let directory = image_test_directory("partial-convert");
        let inputs = directory.join("inputs");
        let outputs = directory.join("outputs");
        std::fs::create_dir_all(&inputs).expect("create conversion input directory");
        let first = inputs.join("first.png");
        let damaged = inputs.join("damaged.png");
        let second = inputs.join("second.png");
        image::RgbaImage::from_pixel(8, 6, image::Rgba([240, 20, 30, 255]))
            .save(&first)
            .expect("write first conversion input");
        std::fs::write(&damaged, b"not an image").expect("write damaged conversion input");
        image::RgbaImage::from_pixel(5, 9, image::Rgba([10, 180, 220, 255]))
            .save(&second)
            .expect("write second conversion input");

        let mut progress = Vec::new();
        let result = convert_image_batch_blocking_with_progress(
            vec![
                first.to_string_lossy().into_owned(),
                damaged.to_string_lossy().into_owned(),
                second.to_string_lossy().into_owned(),
            ],
            outputs.to_string_lossy().into_owned(),
            "PNG".to_string(),
            |event| progress.push(event),
        )
        .expect("conversion batch should return a partial result");

        assert_eq!((result.success_count, result.fail_count), (2, 1));
        assert_eq!(result.errors.len(), 1);
        assert!(result.errors[0].contains("damaged.png"));
        assert_eq!(
            image::open(outputs.join("first.png")).unwrap().dimensions(),
            (8, 6)
        );
        assert_eq!(
            image::open(outputs.join("second.png"))
                .unwrap()
                .dimensions(),
            (5, 9)
        );
        let damaged_error = progress
            .iter()
            .position(|event| event.file_name == "damaged.png" && event.status == "error")
            .expect("damaged input should emit an error result");
        let later_success = progress
            .iter()
            .position(|event| event.file_name == "second.png" && event.status == "done")
            .expect("later valid input should still complete");
        assert!(damaged_error < later_success);
        assert!(!std::fs::read_dir(&outputs)
            .expect("read conversion output directory")
            .filter_map(Result::ok)
            .any(|entry| entry.file_name().to_string_lossy().contains("toolknit")));
        std::fs::remove_dir_all(&directory).expect("remove partial conversion test directory");
    }

    #[test]
    fn image_compression_keeps_successes_and_reports_bad_or_unsupported_inputs() {
        let _conversion_lock = test_conversion_lock();
        CANCEL_FLAG.store(false, Ordering::SeqCst);
        let directory = image_test_directory("partial-compress");
        let inputs = directory.join("inputs");
        let outputs = directory.join("outputs");
        std::fs::create_dir_all(&inputs).expect("create compression input directory");
        let first = inputs.join("first.jpg");
        let damaged = inputs.join("damaged.jpg");
        let unsupported = inputs.join("unsupported.bmp");
        let second = inputs.join("second.jpg");

        let mut source = image::DynamicImage::new_rgba8(256, 256);
        for y in 0..256 {
            for x in 0..256 {
                let value = ((x * 31 + y * 17) % 256) as u8;
                source.put_pixel(
                    x,
                    y,
                    image::Rgba([value, value.wrapping_mul(3), value.wrapping_mul(7), 255]),
                );
            }
        }
        write_converted_image(&source, &first, image::ImageFormat::Jpeg)
            .expect("write first JPEG input");
        std::fs::write(&damaged, b"not an image").expect("write damaged JPEG input");
        image::RgbaImage::from_pixel(12, 12, image::Rgba([30, 60, 90, 255]))
            .save(&unsupported)
            .expect("write unsupported BMP input");
        write_converted_image(&source, &second, image::ImageFormat::Jpeg)
            .expect("write second JPEG input");

        let input_paths = vec![
            first.to_string_lossy().into_owned(),
            damaged.to_string_lossy().into_owned(),
            unsupported.to_string_lossy().into_owned(),
            second.to_string_lossy().into_owned(),
        ];
        assert!(validate_image_compression_inputs(&input_paths, "low").is_err());
        let expected_original_size =
            std::fs::metadata(&first).unwrap().len() + std::fs::metadata(&second).unwrap().len();
        let mut progress = Vec::new();
        let result = compress_image_batch_blocking_with_progress(
            input_paths,
            outputs.to_string_lossy().into_owned(),
            "low".to_string(),
            |event| progress.push(event),
        )
        .expect("compression batch should return a partial result");

        assert_eq!((result.success_count, result.fail_count), (2, 2));
        assert_eq!(result.errors.len(), 2);
        assert!(result
            .errors
            .iter()
            .any(|error| error.contains("damaged.jpg")));
        assert!(result
            .errors
            .iter()
            .any(|error| error.contains("unsupported.bmp")));
        assert_eq!(result.original_size, Some(expected_original_size));
        assert!(result.compressed_size.unwrap() < expected_original_size);
        assert!(image::open(outputs.join("first.jpg")).is_ok());
        assert!(image::open(outputs.join("second.jpg")).is_ok());
        assert!(!outputs.join("damaged.jpg").exists());
        assert!(!outputs.join("unsupported.bmp").exists());
        let damaged_error = progress
            .iter()
            .position(|event| event.file_name == "damaged.jpg" && event.status == "error")
            .expect("damaged compression input should emit an error result");
        let later_success = progress
            .iter()
            .position(|event| event.file_name == "second.jpg" && event.status == "done")
            .expect("later compression input should still complete");
        assert!(damaged_error < later_success);
        assert!(!std::fs::read_dir(&outputs)
            .expect("read compression output directory")
            .filter_map(Result::ok)
            .any(|entry| entry.file_name().to_string_lossy().contains("toolknit")));
        std::fs::remove_dir_all(&directory).expect("remove partial compression test directory");
    }

    #[test]
    fn jpeg_compression_produces_a_smaller_readable_file() {
        let unique = format!(
            "toolknit-compression-test-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("system clock before Unix epoch")
                .as_nanos()
        );
        let directory = std::env::temp_dir().join(unique);
        std::fs::create_dir_all(&directory).expect("create temporary compression test directory");
        let source_path = directory.join("source.jpg");
        let compressed_path = directory.join("compressed.jpg");

        let mut source = image::DynamicImage::new_rgba8(256, 256);
        for y in 0..256 {
            for x in 0..256 {
                let value = ((x * 31 + y * 17) % 256) as u8;
                source.put_pixel(
                    x,
                    y,
                    image::Rgba([value, value.wrapping_mul(3), value.wrapping_mul(7), 255]),
                );
            }
        }
        write_converted_image(&source, &source_path, image::ImageFormat::Jpeg)
            .expect("write high-quality source JPEG");
        write_compressed_image(
            &source,
            &compressed_path,
            image::ImageFormat::Jpeg,
            35,
            image::codecs::png::CompressionType::Best,
        )
        .expect("write compressed JPEG");

        let source_size = std::fs::metadata(&source_path)
            .expect("source metadata")
            .len();
        let compressed_size = std::fs::metadata(&compressed_path)
            .expect("compressed metadata")
            .len();
        assert!(compressed_size < source_size);
        assert!(image::open(&compressed_path).is_ok());
        std::fs::remove_dir_all(&directory).expect("remove temporary compression test directory");
    }

    #[test]
    fn webp_compression_is_lossless_and_quality_independent() {
        let unique = format!(
            "toolknit-webp-compression-test-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("system clock before Unix epoch")
                .as_nanos()
        );
        let directory = std::env::temp_dir().join(unique);
        std::fs::create_dir_all(&directory).expect("create temporary image test directory");
        let high_quality_output = directory.join("high.webp");
        let low_quality_output = directory.join("low.webp");
        let mut source = image::DynamicImage::new_rgba8(2, 2);
        source.put_pixel(0, 0, image::Rgba([10, 20, 30, 40]));
        source.put_pixel(1, 1, image::Rgba([200, 150, 100, 50]));

        write_compressed_image(
            &source,
            &high_quality_output,
            image::ImageFormat::WebP,
            90,
            image::codecs::png::CompressionType::Fast,
        )
        .expect("write high preset lossless WebP");
        write_compressed_image(
            &source,
            &low_quality_output,
            image::ImageFormat::WebP,
            35,
            image::codecs::png::CompressionType::Best,
        )
        .expect("write low preset lossless WebP");
        assert_eq!(
            std::fs::read(&high_quality_output).expect("read high preset WebP"),
            std::fs::read(&low_quality_output).expect("read low preset WebP")
        );
        for output in [&high_quality_output, &low_quality_output] {
            let decoded = image::open(output).expect("decode WebP").to_rgba8();
            assert_eq!(decoded, source.to_rgba8());
        }
        std::fs::remove_dir_all(&directory).expect("remove temporary image test directory");
    }
}

fn convert_image_batch_blocking(
    app_handle: tauri::AppHandle,
    input_paths: Vec<String>,
    output_dir: String,
    target_format: String,
) -> Result<BatchConvertResult, String> {
    use tauri::Emitter;

    convert_image_batch_blocking_with_progress(input_paths, output_dir, target_format, |progress| {
        let _ = app_handle.emit("convert-progress", progress);
    })
}

fn image_crop_format(value: &str) -> Result<(image::ImageFormat, &'static str, String), String> {
    match value.trim().to_ascii_lowercase().as_str() {
        "png" => Ok((image::ImageFormat::Png, ".png", "PNG".to_string())),
        "jpg" | "jpeg" => Ok((image::ImageFormat::Jpeg, ".jpg", "JPG".to_string())),
        "webp" => Ok((image::ImageFormat::WebP, ".webp", "WEBP".to_string())),
        "bmp" => Ok((image::ImageFormat::Bmp, ".bmp", "BMP".to_string())),
        _ => Err("image-crop:unsupported-format".to_string()),
    }
}

fn transformed_crop_dimensions(
    width: u32,
    height: u32,
    rotation: u16,
) -> Result<(u32, u32), String> {
    match rotation {
        0 | 180 => Ok((width, height)),
        90 | 270 => Ok((height, width)),
        _ => Err("image-crop:invalid-rotation".to_string()),
    }
}

fn validate_image_crop_bounds(
    options: &ImageCropOptions,
    width: u32,
    height: u32,
) -> Result<(), String> {
    if options.crop_width == 0 || options.crop_height == 0 {
        return Err("image-crop:invalid-crop".to_string());
    }
    let right = options
        .crop_x
        .checked_add(options.crop_width)
        .ok_or_else(|| "image-crop:invalid-crop".to_string())?;
    let bottom = options
        .crop_y
        .checked_add(options.crop_height)
        .ok_or_else(|| "image-crop:invalid-crop".to_string())?;
    if right > width || bottom > height {
        return Err("image-crop:crop-out-of-bounds".to_string());
    }
    Ok(())
}

fn transform_image_for_crop(
    mut image: image::DynamicImage,
    rotation: u16,
    flip_horizontal: bool,
    flip_vertical: bool,
) -> Result<image::DynamicImage, String> {
    image = match rotation {
        0 => image,
        90 => image.rotate90(),
        180 => image.rotate180(),
        270 => image.rotate270(),
        _ => return Err("image-crop:invalid-rotation".to_string()),
    };
    if flip_horizontal {
        image = image.fliph();
    }
    if flip_vertical {
        image = image.flipv();
    }
    Ok(image)
}

fn write_image_crop(
    image: &image::DynamicImage,
    output_path: &std::path::Path,
    format: image::ImageFormat,
    jpeg_quality: u8,
    background: image::Rgba<u8>,
) -> Result<(), String> {
    use image::ImageEncoder;
    use std::io::BufWriter;

    let file =
        std::fs::File::create(output_path).map_err(|_| "image-crop:write-failed".to_string())?;
    let writer = BufWriter::new(file);
    match format {
        image::ImageFormat::Jpeg => {
            let rgb = flatten_image_to_rgb(
                image,
                image::Rgb([background[0], background[1], background[2]]),
            );
            image::codecs::jpeg::JpegEncoder::new_with_quality(writer, jpeg_quality).write_image(
                &rgb,
                rgb.width(),
                rgb.height(),
                image::ExtendedColorType::Rgb8,
            )
        }
        image::ImageFormat::Png => image::codecs::png::PngEncoder::new(writer).write_image(
            image.as_bytes(),
            image.width(),
            image.height(),
            image.color().into(),
        ),
        image::ImageFormat::WebP => {
            let rgba = image.to_rgba8();
            image::codecs::webp::WebPEncoder::new_lossless(writer).write_image(
                &rgba,
                rgba.width(),
                rgba.height(),
                image::ExtendedColorType::Rgba8,
            )
        }
        image::ImageFormat::Bmp => {
            drop(writer);
            image.save_with_format(output_path, image::ImageFormat::Bmp)
        }
        _ => unreachable!("validated crop output format"),
    }
    .map_err(|_| "image-crop:encode-failed".to_string())
}

fn crop_image_blocking(options: ImageCropOptions) -> Result<ImageCropResult, String> {
    let (input, _) = validate_image_batch_input(&options.input_path)
        .map_err(|_| "image-crop:invalid-input".to_string())?;
    let output_dir = validate_image_output_dir(&options.output_dir)
        .map_err(|_| "image-crop:invalid-output-dir".to_string())?;
    let (format, extension, format_label) = image_crop_format(&options.format)?;
    if !(1..=100).contains(&options.jpeg_quality) {
        return Err("image-crop:invalid-quality".to_string());
    }
    let background = stitch_background(&options.background_rgba)
        .map_err(|_| "image-crop:invalid-background".to_string())?;
    let decoded =
        decode_oriented_image(&input).map_err(|_| "image-crop:decode-failed".to_string())?;
    let (transformed_width, transformed_height) =
        transformed_crop_dimensions(decoded.width(), decoded.height(), options.rotation)?;
    validate_image_crop_bounds(&options, transformed_width, transformed_height)?;
    let transformed = transform_image_for_crop(
        decoded,
        options.rotation,
        options.flip_horizontal,
        options.flip_vertical,
    )?;
    let cropped = transformed.crop_imm(
        options.crop_x,
        options.crop_y,
        options.crop_width,
        options.crop_height,
    );

    let source_stem = input
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("image");
    let default_name = format!("{}_crop", source_stem);
    let output_name = options
        .output_name
        .as_deref()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or(&default_name);
    normalize_image_stitch_output_name(Some(output_name))
        .map_err(|_| "image-crop:invalid-output-name".to_string())?;

    let mut temporary = ImageStitchTemporaryFile::new(&output_dir);
    write_image_crop(
        &cropped,
        &temporary.path,
        format,
        options.jpeg_quality,
        background,
    )?;
    let output_path =
        publish_image_stitch_output(&mut temporary, &output_dir, Some(output_name), extension)
            .map_err(|_| "image-crop:publish-failed".to_string())?;
    let bytes = std::fs::metadata(&output_path)
        .map(|metadata| metadata.len())
        .unwrap_or(0);
    Ok(ImageCropResult {
        output_path,
        width: cropped.width(),
        height: cropped.height(),
        bytes,
        format: format_label,
    })
}

#[tauri::command]
async fn crop_image(
    input_path: String,
    output_dir: String,
    output_name: Option<String>,
    crop_x: u32,
    crop_y: u32,
    crop_width: u32,
    crop_height: u32,
    rotation: u16,
    flip_horizontal: bool,
    flip_vertical: bool,
    format: String,
    jpeg_quality: u8,
    background_rgba: String,
) -> Result<ImageCropResult, String> {
    tokio::task::spawn_blocking(move || {
        crop_image_blocking(ImageCropOptions {
            input_path,
            output_dir,
            output_name,
            crop_x,
            crop_y,
            crop_width,
            crop_height,
            rotation,
            flip_horizontal,
            flip_vertical,
            format,
            jpeg_quality,
            background_rgba,
        })
    })
    .await
    .map_err(|_| "image-crop:worker-failed".to_string())?
}

#[derive(Clone, Debug, serde::Serialize)]
struct ColorReplaceResult {
    output_path: String,
    width: u32,
    height: u32,
    bytes: u64,
    format: String,
    changed_pixels: u64,
}

#[derive(Clone)]
struct ColorReplaceOptions {
    app: Option<tauri::AppHandle>,
    operation_id: Option<String>,
    input_path: String,
    output_dir: String,
    output_name: String,
    source_rgb: Vec<u8>,
    target_rgb: Vec<u8>,
    threshold: f32,
    seed_x: u32,
    seed_y: u32,
    smart: bool,
    softness: f32,
    preserve_luminance: bool,
    format: String,
    jpeg_quality: u8,
    cancel_token: Option<std::sync::Arc<std::sync::atomic::AtomicBool>>,
}

fn color_linear_rgb_table() -> [f32; 256] {
    std::array::from_fn(|index| {
        let value = index as f32 / 255.0;
        if value <= 0.04045 { value / 12.92 } else { ((value + 0.055) / 1.055).powf(2.4) }
    })
}

fn color_rgb_to_lab_with_table(rgb: [u8; 3], table: &[f32; 256]) -> [f32; 3] {
    let linear = |value: u8| table[value as usize];
    let r = linear(rgb[0]); let g = linear(rgb[1]); let b = linear(rgb[2]);
    let x = (r * 0.4124564 + g * 0.3575761 + b * 0.1804375) / 0.95047;
    let y = r * 0.2126729 + g * 0.7151522 + b * 0.072175;
    let z = (r * 0.0193339 + g * 0.119192 + b * 0.9503041) / 1.08883;
    let f = |value: f32| if value > 0.008856 { value.cbrt() } else { 7.787 * value + 16.0 / 116.0 };
    let fx = f(x); let fy = f(y); let fz = f(z);
    [116.0 * fy - 16.0, 500.0 * (fx - fy), 200.0 * (fy - fz)]
}

#[cfg(test)]
fn color_rgb_to_lab(rgb: [u8; 3]) -> [f32; 3] {
    color_rgb_to_lab_with_table(rgb, &color_linear_rgb_table())
}

fn color_delta_e(first: [f32; 3], second: [f32; 3]) -> f32 {
    ((first[0] - second[0]).powi(2) + (first[1] - second[1]).powi(2) + (first[2] - second[2]).powi(2)).sqrt()
}

fn color_replace_weight(distance: f32, threshold: f32, softness: f32) -> f32 {
    if distance > threshold { return 0.0; }
    if softness <= 0.0 { return 1.0; }
    let feather = (threshold * softness / 100.0).max(0.25);
    let edge = (threshold - feather).max(0.0);
    if distance <= edge { return 1.0; }
    let t = ((threshold - distance) / feather).clamp(0.0, 1.0);
    t * t * (3.0 - 2.0 * t)
}

fn color_replace_format(value: &str) -> Result<(image::ImageFormat, &'static str, String), String> {
    match value.trim().to_ascii_lowercase().as_str() {
        "png" => Ok((image::ImageFormat::Png, ".png", "PNG".to_string())),
        "jpg" | "jpeg" => Ok((image::ImageFormat::Jpeg, ".jpg", "JPG".to_string())),
        "webp" => Ok((image::ImageFormat::WebP, ".webp", "WEBP".to_string())),
        "bmp" => Ok((image::ImageFormat::Bmp, ".bmp", "BMP".to_string())),
        _ => Err("color-replace:unsupported-format".to_string()),
    }
}

fn color_replace_cancelled(options: &ColorReplaceOptions) -> bool {
    options.cancel_token.as_ref().is_some_and(|token| token.load(std::sync::atomic::Ordering::Relaxed))
}

fn emit_color_replace_progress(options: &ColorReplaceOptions, phase: &str, percent: f64, processed: usize, total: usize) {
    if let (Some(app), Some(operation_id)) = (&options.app, &options.operation_id) {
        let _ = app.emit("tool-operation-progress", ToolOperationProgress {
            operation_id: operation_id.clone(),
            phase: phase.to_string(),
            percent,
            processed_bytes: processed as u64,
            total_bytes: total as u64,
        });
    }
}

fn color_replace_blocking(options: ColorReplaceOptions) -> Result<ColorReplaceResult, String> {
    let (input, _) = validate_image_batch_input(&options.input_path).map_err(|_| "color-replace:invalid-input".to_string())?;
    let output_dir = validate_image_output_dir(&options.output_dir).map_err(|_| "color-replace:output-dir".to_string())?;
    let (format, extension, format_label) = color_replace_format(&options.format)?;
    if options.source_rgb.len() != 3 || options.target_rgb.len() != 3 || !(0.0..=100.0).contains(&options.threshold) || !(0.0..=100.0).contains(&options.softness) || !(1..=100).contains(&options.jpeg_quality) {
        return Err("color-replace:invalid-options".to_string());
    }
    let mut image = decode_oriented_image(&input).map_err(|_| "color-replace:decode-failed".to_string())?.to_rgba8();
    let width = image.width(); let height = image.height();
    if options.seed_x >= width || options.seed_y >= height { return Err("color-replace:invalid-seed".to_string()); }
    let source = [options.source_rgb[0], options.source_rgb[1], options.source_rgb[2]];
    let target = [options.target_rgb[0], options.target_rgb[1], options.target_rgb[2]];
    let linear_table = color_linear_rgb_table();
    let source_lab = color_rgb_to_lab_with_table(source, &linear_table);
    let pixels = (width as usize).checked_mul(height as usize).ok_or("color-replace:too-large")?;
    let mut candidates = vec![false; pixels]; let mut weights = vec![0.0_f32; pixels];
    let progress_step = (pixels / 100).max(1);
    emit_color_replace_progress(&options, "analyze", 0.0, 0, pixels);
    for (index, pixel) in image.pixels().enumerate() {
        if index % 4096 == 0 && color_replace_cancelled(&options) { return Err("tool-operation:cancelled".to_string()); }
        if pixel[3] == 0 { continue; }
        let distance = color_delta_e(color_rgb_to_lab_with_table([pixel[0], pixel[1], pixel[2]], &linear_table), source_lab);
        let weight = color_replace_weight(distance, options.threshold, options.softness);
        if weight > 0.0 { candidates[index] = true; weights[index] = weight; }
        if index % progress_step == 0 { emit_color_replace_progress(&options, "analyze", index as f64 / pixels as f64 * 45.0, index, pixels); }
    }
    let selected = if options.smart {
        let mut selected = vec![false; pixels];
        let seed = (options.seed_y as usize) * width as usize + options.seed_x as usize;
        if candidates[seed] {
            let mut queue = std::collections::VecDeque::from([seed]); selected[seed] = true;
            let mut visited = 0_usize;
            while let Some(current) = queue.pop_front() {
                visited += 1;
                if visited % 4096 == 0 && color_replace_cancelled(&options) { return Err("tool-operation:cancelled".to_string()); }
                let x = current % width as usize; let y = current / width as usize;
                for dy in -1_i32..=1 { for dx in -1_i32..=1 {
                    if dx == 0 && dy == 0 { continue; }
                    let nx = x as i32 + dx; let ny = y as i32 + dy;
                    if nx < 0 || ny < 0 || nx >= width as i32 || ny >= height as i32 { continue; }
                    let next = ny as usize * width as usize + nx as usize;
                    if candidates[next] && !selected[next] { selected[next] = true; queue.push_back(next); }
                }}
            }
        }
        selected
    } else { candidates };
    emit_color_replace_progress(&options, "replace", 55.0, 0, pixels);
    let source_lum = f32::from(source[0]) * 0.2126 + f32::from(source[1]) * 0.7152 + f32::from(source[2]) * 0.0722;
    let mut changed_pixels = 0_u64;
    for (index, pixel) in image.pixels_mut().enumerate() {
        if index % 4096 == 0 && color_replace_cancelled(&options) { return Err("tool-operation:cancelled".to_string()); }
        if !selected[index] { continue; }
        let current = [pixel[0], pixel[1], pixel[2]];
        let current_lum = f32::from(current[0]) * 0.2126 + f32::from(current[1]) * 0.7152 + f32::from(current[2]) * 0.0722;
        let delta = if options.preserve_luminance { current_lum - source_lum } else { 0.0 };
        let replacement = [f32::from(target[0]) + delta, f32::from(target[1]) + delta, f32::from(target[2]) + delta];
        let weight = weights[index];
        pixel[0] = (f32::from(current[0]) + (replacement[0] - f32::from(current[0])) * weight).round().clamp(0.0, 255.0) as u8;
        pixel[1] = (f32::from(current[1]) + (replacement[1] - f32::from(current[1])) * weight).round().clamp(0.0, 255.0) as u8;
        pixel[2] = (f32::from(current[2]) + (replacement[2] - f32::from(current[2])) * weight).round().clamp(0.0, 255.0) as u8;
        changed_pixels += 1;
        if index % progress_step == 0 { emit_color_replace_progress(&options, "replace", 55.0 + index as f64 / pixels as f64 * 40.0, index, pixels); }
    }
    let output_name = normalize_image_stitch_output_name(Some(&options.output_name)).map_err(|_| "color-replace:invalid-output-name".to_string())?;
    let mut temporary = ImageStitchTemporaryFile::new(&output_dir);
    if color_replace_cancelled(&options) { return Err("tool-operation:cancelled".to_string()); }
    emit_color_replace_progress(&options, "write", 96.0, pixels, pixels);
    write_image_crop(&image::DynamicImage::ImageRgba8(image), &temporary.path, format, options.jpeg_quality, image::Rgba([255, 255, 255, 255]))?;
    if color_replace_cancelled(&options) { return Err("tool-operation:cancelled".to_string()); }
    let output_path = publish_image_stitch_output(&mut temporary, &output_dir, Some(&output_name), extension).map_err(|_| "color-replace:publish-failed".to_string())?;
    let bytes = std::fs::metadata(&output_path).map(|value| value.len()).unwrap_or(0);
    emit_color_replace_progress(&options, "complete", 100.0, pixels, pixels);
    Ok(ColorReplaceResult { output_path, width, height, bytes, format: format_label, changed_pixels })
}

#[tauri::command]
async fn export_replaced_image(
    app: tauri::AppHandle, input_path: String, output_dir: String, output_name: String, source_rgb: Vec<u8>, target_rgb: Vec<u8>, threshold: f32, seed_x: u32, seed_y: u32, smart: bool, softness: f32, preserve_luminance: bool, format: String, jpeg_quality: u8, operation_id: Option<String>,
) -> Result<ColorReplaceResult, String> {
    let (operation_key, cancel_token) = match operation_id {
        Some(value) if !value.trim().is_empty() => {
            let token = register_tool_operation(&value)?;
            (Some(value), Some(token))
        }
        _ => (None, None),
    };
    let progress_operation_id = operation_key.clone();
    let result = tokio::task::spawn_blocking(move || color_replace_blocking(ColorReplaceOptions { app: Some(app), operation_id: progress_operation_id, input_path, output_dir, output_name, source_rgb, target_rgb, threshold, seed_x, seed_y, smart, softness, preserve_luminance, format, jpeg_quality, cancel_token })).await;
    if let Some(key) = operation_key { finish_tool_operation(&key); }
    result.map_err(|_| "color-replace:worker-failed".to_string())?
}

#[derive(Clone, serde::Serialize)]
struct ToolOperationProgress { operation_id: String, phase: String, percent: f64, processed_bytes: u64, total_bytes: u64 }

static TOOL_OPERATION_CANCELS: OnceLock<std::sync::Mutex<std::collections::HashMap<String, std::sync::Arc<std::sync::atomic::AtomicBool>>>> = OnceLock::new();

fn tool_operation_cancels() -> &'static std::sync::Mutex<std::collections::HashMap<String, std::sync::Arc<std::sync::atomic::AtomicBool>>> {
    TOOL_OPERATION_CANCELS.get_or_init(|| std::sync::Mutex::new(std::collections::HashMap::new()))
}

fn validate_tool_operation_id(operation_id: &str) -> Result<(), String> {
    if operation_id.is_empty() || operation_id.len() > 128 || !operation_id.bytes().all(|value| value.is_ascii_alphanumeric() || matches!(value, b'-' | b'_')) {
        return Err("tool-operation:invalid-id".to_string());
    }
    Ok(())
}

fn register_tool_operation(operation_id: &str) -> Result<std::sync::Arc<std::sync::atomic::AtomicBool>, String> {
    validate_tool_operation_id(operation_id)?;
    let token = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    let mut jobs = tool_operation_cancels().lock().map_err(|_| "tool-operation:lock".to_string())?;
    if jobs.insert(operation_id.to_string(), token.clone()).is_some() { return Err("tool-operation:duplicate-id".to_string()); }
    Ok(token)
}

fn finish_tool_operation(operation_id: &str) {
    if let Ok(mut jobs) = tool_operation_cancels().lock() { jobs.remove(operation_id); }
}

#[tauri::command]
fn cancel_tool_operation(operation_id: String) -> Result<(), String> {
    validate_tool_operation_id(&operation_id)?;
    if let Ok(jobs) = tool_operation_cancels().lock() {
        if let Some(token) = jobs.get(&operation_id) {
            token.store(true, std::sync::atomic::Ordering::Relaxed);
            return Ok(());
        }
    }
    Err("tool-operation:not-found".to_string())
}

#[derive(Clone, serde::Serialize)]
struct FileHashResult { digests: std::collections::BTreeMap<String, String>, processed_bytes: u64, total_bytes: u64 }

#[tauri::command]
async fn hash_file(app: tauri::AppHandle, input_path: String, algorithms: Vec<String>, hmac_key: Option<String>, operation_id: String) -> Result<FileHashResult, String> {
    let token = register_tool_operation(&operation_id)?;
    let operation = operation_id.clone();
    let joined = tokio::task::spawn_blocking(move || {
        use hmac::Mac;
        use sha2::Digest;
        use std::io::Read;

        let selected: std::collections::BTreeSet<String> = algorithms.iter().map(|value| value.to_ascii_lowercase()).collect();
        const SUPPORTED: [&str; 5] = ["md5", "sha1", "sha256", "sha512", "hmac-sha256"];
        if selected.is_empty() { return Err("file-hash:no-algorithm".to_string()); }
        if selected.iter().any(|value| !SUPPORTED.contains(&value.as_str())) { return Err("file-hash:unsupported-algorithm".to_string()); }
        if hmac_key.as_ref().is_some_and(|value| value.len() > 1024 * 1024) { return Err("file-hash:invalid-hmac-key".to_string()); }

        let path = std::path::PathBuf::from(&input_path);
        let meta = std::fs::symlink_metadata(&path).map_err(|_| "file-hash:invalid-input".to_string())?;
        if meta.file_type().is_symlink() || !meta.is_file() { return Err("file-hash:invalid-input".to_string()); }
        let total = meta.len();
        let mut file = std::fs::File::open(&path).map_err(|_| "file-hash:read-failed".to_string())?;
        let mut md5_state = selected.contains("md5").then(md5::Md5::new);
        let mut sha1_state = selected.contains("sha1").then(sha1::Sha1::new);
        let mut sha256_state = selected.contains("sha256").then(sha2::Sha256::new);
        let mut sha512_state = selected.contains("sha512").then(sha2::Sha512::new);
        let mut hmac_state = if selected.contains("hmac-sha256") {
            let key = hmac_key.as_deref().filter(|value| !value.is_empty()).ok_or_else(|| "file-hash:invalid-hmac-key".to_string())?;
            Some(hmac::Hmac::<sha2::Sha256>::new_from_slice(key.as_bytes()).map_err(|_| "file-hash:invalid-hmac-key".to_string())?)
        } else { None };
        let mut buffer = vec![0_u8; 1024 * 1024];
        let mut processed = 0_u64;
        let mut last_percent = 0_f64;
        loop {
            if token.load(std::sync::atomic::Ordering::Relaxed) { return Err("tool-operation:cancelled".to_string()); }
            let read = file.read(&mut buffer).map_err(|_| "file-hash:read-failed".to_string())?;
            if read == 0 { break; }
            let chunk = &buffer[..read];
            if let Some(state) = md5_state.as_mut() { state.update(chunk); }
            if let Some(state) = sha1_state.as_mut() { state.update(chunk); }
            if let Some(state) = sha256_state.as_mut() { state.update(chunk); }
            if let Some(state) = sha512_state.as_mut() { state.update(chunk); }
            if let Some(state) = hmac_state.as_mut() { state.update(chunk); }
            processed += read as u64;
            let percent = if total == 0 { 100.0 } else { processed as f64 / total as f64 * 100.0 };
            if percent - last_percent >= 1.0 || processed == total {
                last_percent = percent;
                let _ = app.emit("tool-operation-progress", ToolOperationProgress { operation_id: operation.clone(), phase: "hash".to_string(), percent, processed_bytes: processed, total_bytes: total });
            }
        }
        let mut digests = std::collections::BTreeMap::new();
        if let Some(state) = md5_state { digests.insert("md5".to_string(), hex::encode(state.finalize())); }
        if let Some(state) = sha1_state { digests.insert("sha1".to_string(), hex::encode(state.finalize())); }
        if let Some(state) = sha256_state { digests.insert("sha256".to_string(), hex::encode(state.finalize())); }
        if let Some(state) = sha512_state { digests.insert("sha512".to_string(), hex::encode(state.finalize())); }
        if let Some(state) = hmac_state { digests.insert("hmac-sha256".to_string(), hex::encode(state.finalize().into_bytes())); }
        let _ = app.emit("tool-operation-progress", ToolOperationProgress { operation_id: operation, phase: "complete".to_string(), percent: 100.0, processed_bytes: processed, total_bytes: total });
        Ok(FileHashResult { digests, processed_bytes: processed, total_bytes: total })
    }).await;
    finish_tool_operation(&operation_id);
    joined.map_err(|_| "file-hash:worker-failed".to_string())?
}

#[derive(Clone, Debug, serde::Serialize)]
struct TkaesResult { output_path: String, bytes: u64 }

const TKAE_MAGIC: &[u8; 4] = b"TKAE";
const TKAE_VERSION: u8 = 2;
const TKAE_CHUNK_SIZE: usize = 1024 * 1024;
const TKAE_ARGON_MEMORY_KIB: u32 = 19 * 1024;
const TKAE_ARGON_ITERATIONS: u32 = 2;
const TKAE_ARGON_LANES: u32 = 1;

fn tkaes_key(password: &str, salt: &[u8], memory_kib: u32, iterations: u32, lanes: u32) -> Result<aes_gcm::Aes256Gcm, String> {
    if !(8 * 1024..=256 * 1024).contains(&memory_kib) || !(1..=10).contains(&iterations) || !(1..=8).contains(&lanes) {
        return Err("tkaes:kdf-params".to_string());
    }
    let params = argon2::Params::new(memory_kib, iterations, lanes, Some(32)).map_err(|_| "tkaes:kdf-params".to_string())?;
    let mut key = [0_u8; 32];
    argon2::Argon2::new(argon2::Algorithm::Argon2id, argon2::Version::V0x13, params).hash_password_into(password.as_bytes(), salt, &mut key).map_err(|_| "tkaes:kdf-failed".to_string())?;
    use aes_gcm::KeyInit;
    use zeroize::Zeroize;
    let cipher = aes_gcm::Aes256Gcm::new_from_slice(&key).map_err(|_| "tkaes:key-failed".to_string());
    key.zeroize();
    cipher
}

fn tkaes_nonce(base: &[u8; 12], index: u64) -> [u8; 12] { let mut nonce = *base; let bytes = index.to_le_bytes(); for i in 0..8 { nonce[4 + i] ^= bytes[i]; } nonce }
fn tkaes_aad(index: u64, length: u32) -> Vec<u8> { let mut aad = Vec::with_capacity(16); aad.extend_from_slice(TKAE_MAGIC); aad.extend_from_slice(&index.to_le_bytes()); aad.extend_from_slice(&length.to_le_bytes()); aad }
fn publish_tkaes_temp(temp: &std::path::Path, dir: &std::path::Path, stem: &str, extension: &str) -> Result<String, String> { for index in 0..10000_u32 { let suffix = if index == 0 { String::new() } else { format!("_{}", index) }; let path = dir.join(format!("{}{}{}", stem, suffix, extension)); if path.exists() { continue; } match std::fs::rename(temp, &path) { Ok(()) => return Ok(path.to_string_lossy().into_owned()), Err(_) => continue } } Err("tkaes:publish-failed".to_string()) }

fn tkaes_temp_path(dir: &std::path::Path, kind: &str) -> Result<std::path::PathBuf, String> {
    let mut random = [0_u8; 8];
    getrandom::getrandom(&mut random).map_err(|_| "tkaes:random-failed".to_string())?;
    Ok(dir.join(format!(".toolknit-{}-{}-{}.part", kind, std::process::id(), hex::encode(random))))
}

fn tkaes_encrypted_stem(input: &std::path::Path) -> &str { input.file_name().and_then(|value| value.to_str()).unwrap_or("encrypted") }
fn tkaes_decrypted_stem(input: &std::path::Path) -> String { let name = input.file_name().and_then(|value| value.to_str()).unwrap_or("decrypted"); if name.to_ascii_lowercase().ends_with(".tkaes") { name[..name.len() - 6].to_string() } else { format!("{}.bin", name) } }

struct TkaesTempGuard { path: std::path::PathBuf, published: bool }
impl TkaesTempGuard { fn new(path: std::path::PathBuf) -> Self { Self { path, published: false } } fn path(&self) -> &std::path::Path { &self.path } fn mark_published(&mut self) { self.published = true; } }
impl Drop for TkaesTempGuard { fn drop(&mut self) { if !self.published { let _ = std::fs::remove_file(&self.path); } } }

fn tkaes_encrypt_blocking(app: Option<tauri::AppHandle>, input_path: String, output_dir: String, password: String, operation_id: String, token: std::sync::Arc<std::sync::atomic::AtomicBool>) -> Result<TkaesResult, String> {
    use aes_gcm::{aead::{Aead, Payload}, Nonce};
    use std::io::{Read, Write};
    let input = std::path::PathBuf::from(input_path);
    let meta = std::fs::metadata(&input).map_err(|_| "tkaes:invalid-input".to_string())?;
    if !meta.is_file() { return Err("tkaes:invalid-input".to_string()); }
    let dir = validate_image_output_dir(&output_dir).map_err(|_| "tkaes:output-dir".to_string())?;
    let mut salt = [0_u8; 16]; let mut base_nonce = [0_u8; 12];
    getrandom::getrandom(&mut salt).map_err(|_| "tkaes:random-failed".to_string())?;
    getrandom::getrandom(&mut base_nonce).map_err(|_| "tkaes:random-failed".to_string())?;
    let cipher = tkaes_key(&password, &salt, TKAE_ARGON_MEMORY_KIB, TKAE_ARGON_ITERATIONS, TKAE_ARGON_LANES)?;
    let mut input_file = std::fs::File::open(&input).map_err(|_| "tkaes:read-failed".to_string())?;
    let stem = tkaes_encrypted_stem(&input);
    let mut guard = TkaesTempGuard::new(tkaes_temp_path(&dir, "encrypt")?);
    let mut output = std::fs::OpenOptions::new().write(true).create_new(true).open(guard.path()).map_err(|_| "tkaes:temp-failed".to_string())?;
    output.write_all(TKAE_MAGIC).map_err(|_| "tkaes:write-failed".to_string())?;
    output.write_all(&[TKAE_VERSION]).map_err(|_| "tkaes:write-failed".to_string())?;
    output.write_all(&(TKAE_CHUNK_SIZE as u32).to_le_bytes()).map_err(|_| "tkaes:write-failed".to_string())?;
    output.write_all(&meta.len().to_le_bytes()).map_err(|_| "tkaes:write-failed".to_string())?;
    output.write_all(&TKAE_ARGON_MEMORY_KIB.to_le_bytes()).map_err(|_| "tkaes:write-failed".to_string())?;
    output.write_all(&TKAE_ARGON_ITERATIONS.to_le_bytes()).map_err(|_| "tkaes:write-failed".to_string())?;
    output.write_all(&TKAE_ARGON_LANES.to_le_bytes()).map_err(|_| "tkaes:write-failed".to_string())?;
    output.write_all(&salt).map_err(|_| "tkaes:write-failed".to_string())?;
    output.write_all(&base_nonce).map_err(|_| "tkaes:write-failed".to_string())?;
    let mut buffer = vec![0_u8; TKAE_CHUNK_SIZE]; let mut index = 0_u64; let mut processed = 0_u64;
    loop {
        if token.load(std::sync::atomic::Ordering::Relaxed) { return Err("tool-operation:cancelled".to_string()); }
        let read = input_file.read(&mut buffer).map_err(|_| "tkaes:read-failed".to_string())?;
        if read == 0 { break; }
        let aad = tkaes_aad(index, read as u32); let nonce = tkaes_nonce(&base_nonce, index);
        let encrypted = cipher.encrypt(Nonce::from_slice(&nonce), Payload { msg: &buffer[..read], aad: &aad }).map_err(|_| "tkaes:encrypt-failed".to_string())?;
        output.write_all(&(read as u32).to_le_bytes()).map_err(|_| "tkaes:write-failed".to_string())?;
        output.write_all(&encrypted).map_err(|_| "tkaes:write-failed".to_string())?;
        processed += read as u64; index += 1;
        if let Some(app) = &app { let _ = app.emit("tool-operation-progress", ToolOperationProgress { operation_id: operation_id.clone(), phase: "encrypt".to_string(), percent: processed as f64 / meta.len().max(1) as f64 * 100.0, processed_bytes: processed, total_bytes: meta.len() }); }
    }
    output.sync_all().map_err(|_| "tkaes:write-failed".to_string())?; drop(output);
    let output_path = publish_tkaes_temp(guard.path(), &dir, stem, ".tkaes")?; guard.mark_published();
    Ok(TkaesResult { bytes: std::fs::metadata(&output_path).map(|value| value.len()).unwrap_or(0), output_path })
}

fn read_tkaes_u32(file: &mut std::fs::File) -> Result<u32, String> { use std::io::Read; let mut bytes = [0_u8; 4]; file.read_exact(&mut bytes).map_err(|_| "tkaes:invalid-container".to_string())?; Ok(u32::from_le_bytes(bytes)) }

fn tkaes_decrypt_blocking(app: Option<tauri::AppHandle>, input_path: String, output_dir: String, password: String, operation_id: String, token: std::sync::Arc<std::sync::atomic::AtomicBool>) -> Result<TkaesResult, String> {
    use aes_gcm::{aead::{Aead, Payload}, Nonce};
    use std::io::{Read, Write};
    let input = std::path::PathBuf::from(input_path); let dir = validate_image_output_dir(&output_dir).map_err(|_| "tkaes:output-dir".to_string())?;
    let mut file = std::fs::File::open(&input).map_err(|_| "tkaes:read-failed".to_string())?;
    let mut magic = [0_u8; 4]; file.read_exact(&mut magic).map_err(|_| "tkaes:invalid-container".to_string())?;
    if &magic != TKAE_MAGIC { return Err("tkaes:invalid-container".to_string()); }
    let mut version = [0_u8; 1]; file.read_exact(&mut version).map_err(|_| "tkaes:invalid-container".to_string())?;
    if ![1, TKAE_VERSION].contains(&version[0]) { return Err("tkaes:unsupported-version".to_string()); }
    let chunk_size = read_tkaes_u32(&mut file)? as usize;
    if chunk_size == 0 || chunk_size > 16 * 1024 * 1024 { return Err("tkaes:invalid-container".to_string()); }
    let mut length_buf = [0_u8; 8]; file.read_exact(&mut length_buf).map_err(|_| "tkaes:invalid-container".to_string())?; let total = u64::from_le_bytes(length_buf);
    let (memory_kib, iterations, lanes) = if version[0] == 1 { (TKAE_ARGON_MEMORY_KIB, TKAE_ARGON_ITERATIONS, TKAE_ARGON_LANES) } else { (read_tkaes_u32(&mut file)?, read_tkaes_u32(&mut file)?, read_tkaes_u32(&mut file)?) };
    let mut salt = [0_u8; 16]; let mut base_nonce = [0_u8; 12];
    file.read_exact(&mut salt).map_err(|_| "tkaes:invalid-container".to_string())?; file.read_exact(&mut base_nonce).map_err(|_| "tkaes:invalid-container".to_string())?;
    let cipher = tkaes_key(&password, &salt, memory_kib, iterations, lanes)?;
    let stem = tkaes_decrypted_stem(&input); let mut guard = TkaesTempGuard::new(tkaes_temp_path(&dir, "decrypt")?);
    let mut output = std::fs::OpenOptions::new().write(true).create_new(true).open(guard.path()).map_err(|_| "tkaes:temp-failed".to_string())?;
    let mut processed = 0_u64; let mut index = 0_u64;
    while processed < total {
        if token.load(std::sync::atomic::Ordering::Relaxed) { return Err("tool-operation:cancelled".to_string()); }
        let plain_len = read_tkaes_u32(&mut file)? as usize;
        if plain_len == 0 || plain_len > chunk_size || processed + plain_len as u64 > total { return Err("tkaes:invalid-container".to_string()); }
        let mut encrypted = vec![0_u8; plain_len + 16]; file.read_exact(&mut encrypted).map_err(|_| "tkaes:invalid-container".to_string())?;
        let nonce = tkaes_nonce(&base_nonce, index); let aad = tkaes_aad(index, plain_len as u32);
        let plain = cipher.decrypt(Nonce::from_slice(&nonce), Payload { msg: &encrypted, aad: &aad }).map_err(|_| "tkaes:authentication-failed".to_string())?;
        output.write_all(&plain).map_err(|_| "tkaes:write-failed".to_string())?; processed += plain.len() as u64; index += 1;
        if let Some(app) = &app { let _ = app.emit("tool-operation-progress", ToolOperationProgress { operation_id: operation_id.clone(), phase: "decrypt".to_string(), percent: processed as f64 / total.max(1) as f64 * 100.0, processed_bytes: processed, total_bytes: total }); }
    }
    if file.read(&mut [0_u8; 1]).map_err(|_| "tkaes:read-failed".to_string())? != 0 { return Err("tkaes:trailing-data".to_string()); }
    output.sync_all().map_err(|_| "tkaes:write-failed".to_string())?; drop(output);
    let output_path = publish_tkaes_temp(guard.path(), &dir, &stem, "")?; guard.mark_published();
    Ok(TkaesResult { bytes: std::fs::metadata(&output_path).map(|value| value.len()).unwrap_or(0), output_path })
}

#[tauri::command]
async fn encrypt_tkaes_file(app: tauri::AppHandle, input_path: String, output_dir: String, password: String, operation_id: String) -> Result<TkaesResult, String> {
    if password.is_empty() { return Err("tkaes:password-required".to_string()); }
    let token = register_tool_operation(&operation_id)?; let cleanup_id = operation_id.clone();
    let joined = tokio::task::spawn_blocking(move || tkaes_encrypt_blocking(Some(app), input_path, output_dir, password, operation_id, token)).await;
    finish_tool_operation(&cleanup_id);
    joined.map_err(|_| "tkaes:worker-failed".to_string())?
}

#[tauri::command]
async fn decrypt_tkaes_file(app: tauri::AppHandle, input_path: String, output_dir: String, password: String, operation_id: String) -> Result<TkaesResult, String> {
    if password.is_empty() { return Err("tkaes:password-required".to_string()); }
    let token = register_tool_operation(&operation_id)?; let cleanup_id = operation_id.clone();
    let joined = tokio::task::spawn_blocking(move || tkaes_decrypt_blocking(Some(app), input_path, output_dir, password, operation_id, token)).await;
    finish_tool_operation(&cleanup_id);
    joined.map_err(|_| "tkaes:worker-failed".to_string())?
}

fn convert_image_batch_blocking_with_progress<F>(
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
async fn compress_image_batch(
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

fn validate_image_compression_request(input_paths: &[String], quality: &str) -> Result<(), String> {
    validate_image_batch_request(input_paths)?;
    if !matches!(quality, "high" | "medium" | "low") {
        return Err("Unsupported image compression quality".to_string());
    }
    Ok(())
}

fn validate_image_compression_input(
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
fn validate_image_compression_inputs(input_paths: &[String], quality: &str) -> Result<(), String> {
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

fn write_compressed_image(
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
            let encoder = PngEncoder::new_with_quality(writer, png_compression, FilterType::Sub);
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

fn compress_image_batch_blocking(
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

fn compress_image_batch_blocking_with_progress<F>(
    input_paths: Vec<String>,
    output_dir: String,
    quality: String,
    mut emit_progress: F,
) -> Result<BatchConvertResult, String>
where
    F: FnMut(ConvertProgress),
{
    use image::codecs::png::CompressionType;

    validate_image_compression_request(&input_paths, &quality)?;

    let output_dir_path = validate_image_output_dir(&output_dir)?;

    // Quality presets: (jpeg_quality, png_compression)
    let (jpeg_quality, png_compression) = match quality.as_str() {
        "high" => (90u8, CompressionType::Fast),
        "medium" => (65u8, CompressionType::Default),
        "low" => (35u8, CompressionType::Best),
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

        let result = decode_oriented_image(&input);
        match result {
            Ok(img) => {
                if CANCEL_FLAG.load(Ordering::SeqCst) {
                    break;
                }
                let save_result = write_compressed_image(
                    &img,
                    &temporary_output_path,
                    format,
                    jpeg_quality,
                    png_compression,
                );
                let input_size = std::fs::metadata(&input)
                    .map(|metadata| metadata.len())
                    .unwrap_or(0);
                let output_size = std::fs::metadata(&temporary_output_path)
                    .map(|metadata| metadata.len())
                    .unwrap_or(0);
                if save_result.is_ok()
                    && !CANCEL_FLAG.load(Ordering::SeqCst)
                    && output_size < input_size
                {
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
                    compressed_size += output_size;
                    original_size += input_size;
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
                        let reason = if e.is_empty() {
                            "no smaller output was produced"
                        } else {
                            &e
                        };
                        errors.push(format!("{}: {}", file_name, reason));
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
        original_size: Some(original_size),
        compressed_size: Some(compressed_size),
    })
}

const VIDEO_CONVERT_MAX_BATCH_FILES: usize = 30;
const VIDEO_CONVERT_MAX_INPUT_BYTES: u64 = 10 * 1024 * 1024 * 1024;

fn video_convert_profile(
    target_format: &str,
) -> Result<
    (
        Option<&'static str>,
        &'static str,
        &'static str,
        &'static str,
    ),
    String,
> {
    match target_format.trim().to_ascii_uppercase().as_str() {
        "MP4" => Ok((Some("h264_nvenc"), "libx264", "aac", ".mp4")),
        "MKV" => Ok((Some("h264_nvenc"), "libx264", "aac", ".mkv")),
        "MOV" => Ok((Some("h264_nvenc"), "libx264", "aac", ".mov")),
        "AVI" => Ok((None, "mpeg4", "libmp3lame", ".avi")),
        "WEBM" => Ok((None, "libvpx-vp9", "libopus", ".webm")),
        "FLV" => Ok((Some("h264_nvenc"), "libx264", "aac", ".flv")),
        "WMV" => Ok((None, "wmv2", "wmav2", ".wmv")),
        "TS" => Ok((Some("h264_nvenc"), "libx264", "aac", ".ts")),
        _ => Err("video-convert:invalid-target-format".to_string()),
    }
}

fn validate_video_convert_inputs(
    input_paths: &[String],
) -> Result<Vec<std::path::PathBuf>, String> {
    if input_paths.is_empty() {
        return Err("video-convert:missing-input".to_string());
    }
    if input_paths.len() > VIDEO_CONVERT_MAX_BATCH_FILES {
        return Err("video-convert:too-many-files".to_string());
    }

    let mut seen = std::collections::BTreeSet::new();
    let mut validated = Vec::with_capacity(input_paths.len());
    for input_path in input_paths {
        if input_path.contains('\0') {
            return Err("video-convert:invalid-input".to_string());
        }
        let input = std::path::PathBuf::from(input_path);
        let metadata = std::fs::symlink_metadata(&input)
            .map_err(|_| "video-convert:invalid-input".to_string())?;
        let extension = input
            .extension()
            .and_then(|value| value.to_str())
            .map(|value| value.to_ascii_lowercase());
        if metadata.file_type().is_symlink()
            || !metadata.is_file()
            || !matches!(
                extension.as_deref(),
                Some("mp4" | "avi" | "mkv" | "mov" | "webm" | "flv" | "wmv" | "ts" | "m4v")
            )
            || metadata.len() == 0
        {
            return Err("video-convert:invalid-input".to_string());
        }
        if metadata.len() > VIDEO_CONVERT_MAX_INPUT_BYTES {
            return Err("video-convert:input-too-large".to_string());
        }
        let canonical = input
            .canonicalize()
            .map_err(|_| "video-convert:invalid-input".to_string())?;
        if !seen.insert(canonical.clone()) {
            return Err("video-convert:duplicate-input".to_string());
        }
        validated.push(canonical);
    }
    Ok(validated)
}

fn validate_video_convert_output_dir(output_dir: &str) -> Result<std::path::PathBuf, String> {
    if output_dir.trim().is_empty() || output_dir.contains('\0') {
        return Err("video-convert:output-path".to_string());
    }
    let output_dir = std::path::PathBuf::from(output_dir);
    is_path_safe(&output_dir).map_err(|_| "video-convert:output-path".to_string())?;
    std::fs::create_dir_all(&output_dir).map_err(|_| "video-convert:output-path".to_string())?;
    if !output_dir.is_dir() {
        return Err("video-convert:output-path".to_string());
    }
    is_path_safe(&output_dir).map_err(|_| "video-convert:output-path".to_string())?;
    Ok(output_dir)
}

fn video_convert_file_stem(input: &std::path::Path) -> String {
    let raw_stem = input
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("video");
    let sanitized: String = raw_stem
        .chars()
        .map(|character| {
            if matches!(
                character,
                '\\' | '/' | ':' | '*' | '?' | '"' | '<' | '>' | '|'
            ) {
                '_'
            } else {
                character
            }
        })
        .collect();
    let trimmed = sanitized
        .trim()
        .trim_end_matches(|character| character == '.' || character == ' ');
    let safe_stem: String = trimmed.chars().take(96).collect();
    if safe_stem.is_empty() {
        "video".to_string()
    } else {
        safe_stem
    }
}

fn create_video_convert_temp_path(
    output_dir: &std::path::Path,
    extension: &str,
) -> Result<std::path::PathBuf, String> {
    for _ in 0..10_000 {
        let id = VIDEO_CONVERT_TEMP_ID.fetch_add(1, Ordering::SeqCst);
        let candidate = output_dir.join(format!(
            ".toolknit-video-{}-{}{}",
            std::process::id(),
            id,
            extension
        ));
        if !candidate.exists() {
            return Ok(candidate);
        }
    }
    Err("video-convert:output-path".to_string())
}

fn publish_video_convert_output(
    temporary_path: &std::path::Path,
    output_dir: &std::path::Path,
    source_stem: &str,
    extension: &str,
) -> Result<String, String> {
    for counter in 0..10_000_u32 {
        let file_name = if counter == 0 {
            format!("{}_converted{}", source_stem, extension)
        } else {
            format!("{}_converted_{}{}", source_stem, counter, extension)
        };
        let candidate = output_dir.join(file_name);
        match std::fs::hard_link(temporary_path, &candidate) {
            Ok(()) => {
                std::fs::remove_file(temporary_path)
                    .map_err(|_| "video-convert:output-path".to_string())?;
                return Ok(candidate.to_string_lossy().into_owned());
            }
            Err(_) if candidate.exists() => continue,
            Err(_) => return Err("video-convert:output-path".to_string()),
        }
    }
    Err("video-convert:output-path".to_string())
}

fn parse_ffmpeg_timestamp(value: &str) -> Option<f64> {
    let mut segments = value.trim().split(':');
    let hours: f64 = segments.next()?.trim().parse().ok()?;
    let minutes: f64 = segments.next()?.trim().parse().ok()?;
    let seconds: f64 = segments.next()?.trim().parse().ok()?;
    if segments.next().is_some()
        || !hours.is_finite()
        || !minutes.is_finite()
        || !seconds.is_finite()
        || hours < 0.0
        || minutes < 0.0
        || seconds < 0.0
    {
        return None;
    }
    Some(hours * 3600.0 + minutes * 60.0 + seconds)
}

fn parse_ffmpeg_duration(stderr: &str) -> Option<f64> {
    stderr.lines().find_map(|line| {
        let duration = line.split_once("Duration:")?.1.trim();
        let value = duration.split(',').next()?.trim();
        parse_ffmpeg_timestamp(value)
    })
}

fn parse_ffmpeg_progress_seconds(line: &str) -> Option<f64> {
    if let Some(value) = line.strip_prefix("out_time=") {
        return parse_ffmpeg_timestamp(value);
    }
    let value = line
        .strip_prefix("out_time_us=")
        .or_else(|| line.strip_prefix("out_time_ms="))?;
    value
        .trim()
        .parse::<f64>()
        .ok()
        .filter(|value| value.is_finite() && *value >= 0.0)
        .map(|value| value / 1_000_000.0)
}

fn compact_video_convert_error(stderr: &str) -> String {
    let detail = stderr
        .lines()
        .rev()
        .find(|line| !line.trim().is_empty())
        .unwrap_or("FFmpeg could not convert this video.");
    let compact = detail.trim().chars().take(480).collect::<String>();
    if compact.is_empty() {
        "FFmpeg could not convert this video.".to_string()
    } else {
        compact
    }
}

async fn probe_video_convert_duration(
    ffmpeg_path: &std::path::Path,
    input: &std::path::Path,
) -> Option<f64> {
    let mut command = tokio::process::Command::new(ffmpeg_path);
    command
        .arg("-hide_banner")
        .arg("-i")
        .arg(input)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::piped());
    #[cfg(target_os = "windows")]
    {
        command.creation_flags(0x08000000);
    }
    let output = command.output().await.ok()?;
    parse_ffmpeg_duration(&String::from_utf8_lossy(&output.stderr))
}

async fn has_video_nvenc_encoder(ffmpeg_path: &std::path::Path, encoder: &str) -> bool {
    let mut probe = tokio::process::Command::new(ffmpeg_path);
    probe
        .arg("-hide_banner")
        .arg("-f")
        .arg("lavfi")
        .arg("-i")
        .arg("nullsrc=s=64x64:d=0.1")
        .arg("-c:v")
        .arg(encoder)
        .arg("-f")
        .arg("null")
        .arg("-")
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null());
    #[cfg(target_os = "windows")]
    {
        probe.creation_flags(0x08000000);
    }
    probe
        .status()
        .await
        .map(|status| status.success())
        .unwrap_or(false)
}

async fn convert_video_file(
    app_handle: tauri::AppHandle,
    ffmpeg_path: std::path::PathBuf,
    input: std::path::PathBuf,
    output_dir: std::path::PathBuf,
    video_encoder: String,
    audio_encoder: String,
    extension: &'static str,
    current: usize,
    total: usize,
) -> Result<(), String> {
    use tauri::Emitter;
    use tokio::io::{AsyncBufReadExt, AsyncReadExt, BufReader};

    if CANCEL_FLAG.load(Ordering::SeqCst) {
        return Err("video-convert:cancelled".to_string());
    }
    let file_name = input
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("video")
        .to_string();
    let _ = app_handle.emit(
        "convert-progress",
        ConvertProgress {
            file_name: file_name.clone(),
            current,
            total,
            progress: 0.0,
            status: "preparing".to_string(),
        },
    );
    let duration = probe_video_convert_duration(&ffmpeg_path, &input)
        .await
        .unwrap_or(0.0);
    if CANCEL_FLAG.load(Ordering::SeqCst) {
        return Err("video-convert:cancelled".to_string());
    }
    let temporary_path = create_video_convert_temp_path(&output_dir, extension)?;
    let mut command = tokio::process::Command::new(&ffmpeg_path);
    command
        .arg("-y")
        .arg("-i")
        .arg(&input)
        .arg("-c:v")
        .arg(&video_encoder)
        .arg("-c:a")
        .arg(&audio_encoder)
        .arg("-pix_fmt")
        .arg("yuv420p");
    match video_encoder.as_str() {
        "h264_nvenc" => {
            command
                .arg("-preset")
                .arg("fast")
                .arg("-rc")
                .arg("vbr")
                .arg("-cq")
                .arg("23");
        }
        "libx264" => {
            command.arg("-preset").arg("fast").arg("-crf").arg("23");
        }
        "libvpx-vp9" => {
            command
                .arg("-row-mt")
                .arg("1")
                .arg("-speed")
                .arg("2")
                .arg("-crf")
                .arg("32")
                .arg("-b:v")
                .arg("0");
        }
        _ => {}
    }
    command
        .arg("-progress")
        .arg("pipe:1")
        .arg("-nostats")
        .arg(&temporary_path)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    #[cfg(target_os = "windows")]
    {
        command.creation_flags(0x08000000);
    }

    let mut child = command
        .spawn()
        .map_err(|_| "video-convert:failed".to_string())?;
    let child_id = match child.id() {
        Some(id) => id,
        None => {
            let _ = child.kill().await;
            let _ = std::fs::remove_file(&temporary_path);
            return Err("video-convert:failed".to_string());
        }
    };
    active_video_children()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .insert(child_id);
    if CANCEL_FLAG.load(Ordering::SeqCst) {
        terminate_conversion_process(child_id);
    }

    let stdout = match child.stdout.take() {
        Some(stdout) => stdout,
        None => {
            terminate_conversion_process(child_id);
            active_video_children()
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .remove(&child_id);
            let _ = child.wait().await;
            let _ = std::fs::remove_file(&temporary_path);
            return Err("video-convert:failed".to_string());
        }
    };
    let stderr = match child.stderr.take() {
        Some(stderr) => stderr,
        None => {
            terminate_conversion_process(child_id);
            active_video_children()
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .remove(&child_id);
            let _ = child.wait().await;
            let _ = std::fs::remove_file(&temporary_path);
            return Err("video-convert:failed".to_string());
        }
    };
    let progress_app = app_handle.clone();
    let progress_name = file_name.clone();
    let progress_task = tokio::spawn(async move {
        let mut lines = BufReader::new(stdout).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            if let Some(seconds) = parse_ffmpeg_progress_seconds(&line) {
                let progress = if duration > 0.0 {
                    (seconds / duration).clamp(0.0, 0.99)
                } else {
                    0.0
                };
                let _ = progress_app.emit(
                    "convert-progress",
                    ConvertProgress {
                        file_name: progress_name.clone(),
                        current,
                        total,
                        progress,
                        status: "converting".to_string(),
                    },
                );
            }
        }
    });
    let stderr_task = tokio::spawn(async move {
        let mut bytes = Vec::new();
        let mut reader = BufReader::new(stderr);
        let _ = reader.read_to_end(&mut bytes).await;
        String::from_utf8_lossy(&bytes).into_owned()
    });
    let status = child.wait().await;
    active_video_children()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .remove(&child_id);
    let _ = progress_task.await;
    let stderr = stderr_task.await.unwrap_or_default();

    if CANCEL_FLAG.load(Ordering::SeqCst) {
        let _ = std::fs::remove_file(&temporary_path);
        return Err("video-convert:cancelled".to_string());
    }
    match status {
        Ok(status) if status.success() => {
            publish_video_convert_output(
                &temporary_path,
                &output_dir,
                &video_convert_file_stem(&input),
                extension,
            )?;
            let _ = app_handle.emit(
                "convert-progress",
                ConvertProgress {
                    file_name,
                    current,
                    total,
                    progress: 1.0,
                    status: "done".to_string(),
                },
            );
            Ok(())
        }
        _ => {
            let _ = std::fs::remove_file(&temporary_path);
            Err(compact_video_convert_error(&stderr))
        }
    }
}

#[tauri::command]
async fn convert_video_batch(
    app_handle: tauri::AppHandle,
    input_paths: Vec<String>,
    output_dir: String,
    target_format: String,
) -> Result<BatchConvertResult, String> {
    use tauri::Emitter;

    let _conversion_guard = begin_conversion()?;
    let input_paths = validate_video_convert_inputs(&input_paths)?;
    let output_dir = validate_video_convert_output_dir(&output_dir)?;
    let (nvenc_encoder, cpu_encoder, audio_encoder, extension) =
        video_convert_profile(&target_format)?;
    let ffmpeg_path = get_ffmpeg_path()?;
    let video_encoder = match nvenc_encoder {
        Some(encoder) if has_video_nvenc_encoder(&ffmpeg_path, encoder).await => encoder,
        _ => cpu_encoder,
    }
    .to_string();
    let total = input_paths.len();
    let max_parallel = std::cmp::min(2, total);
    let mut success_count = 0usize;
    let mut fail_count = 0usize;
    let mut errors = Vec::new();
    let mut join_set = tokio::task::JoinSet::new();

    for (index, input) in input_paths.into_iter().enumerate() {
        if CANCEL_FLAG.load(Ordering::SeqCst) {
            break;
        }
        let file_name = input
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or("video")
            .to_string();
        let ffmpeg_path = ffmpeg_path.clone();
        let output_dir = output_dir.clone();
        let worker_app_handle = app_handle.clone();
        let video_encoder = video_encoder.clone();
        let audio_encoder = audio_encoder.to_string();
        join_set.spawn(async move {
            let result = convert_video_file(
                worker_app_handle,
                ffmpeg_path,
                input,
                output_dir,
                video_encoder,
                audio_encoder,
                extension,
                index + 1,
                total,
            )
            .await;
            (index + 1, file_name, result)
        });

        while join_set.len() >= max_parallel {
            if let Some(result) = join_set.join_next().await {
                match result {
                    Ok((_current, _file_name, Ok(()))) => success_count += 1,
                    Ok((current, file_name, Err(error))) if error != "video-convert:cancelled" => {
                        fail_count += 1;
                        errors.push(format!("{}: {}", file_name, error));
                        let _ = app_handle.emit(
                            "convert-progress",
                            ConvertProgress {
                                file_name,
                                current,
                                total,
                                progress: 1.0,
                                status: "error".to_string(),
                            },
                        );
                    }
                    Ok(_) => {}
                    Err(error) => {
                        fail_count += 1;
                        errors.push(format!("Video worker failed: {}", error));
                    }
                }
            }
        }
    }

    while let Some(result) = join_set.join_next().await {
        match result {
            Ok((_current, _file_name, Ok(()))) => success_count += 1,
            Ok((current, file_name, Err(error))) if error != "video-convert:cancelled" => {
                fail_count += 1;
                errors.push(format!("{}: {}", file_name, error));
                let _ = app_handle.emit(
                    "convert-progress",
                    ConvertProgress {
                        file_name,
                        current,
                        total,
                        progress: 1.0,
                        status: "error".to_string(),
                    },
                );
            }
            Ok(_) => {}
            Err(error) => {
                fail_count += 1;
                errors.push(format!("Video worker failed: {}", error));
            }
        }
    }

    if CANCEL_FLAG.load(Ordering::SeqCst) {
        return Err("video-convert:cancelled".to_string());
    }
    Ok(BatchConvertResult {
        success_count,
        fail_count,
        output_dir: output_dir.to_string_lossy().to_string(),
        errors,
        original_size: None,
        compressed_size: None,
    })
}

#[cfg(test)]
mod video_conversion_tests {
    use super::*;

    fn test_directory(label: &str) -> std::path::PathBuf {
        let suffix = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("system clock is valid")
            .as_nanos();
        let directory = std::env::temp_dir().join(format!(
            "toolknit-video-{}-{}-{}",
            label,
            std::process::id(),
            suffix
        ));
        std::fs::create_dir_all(&directory).expect("create temporary test directory");
        directory
    }

    #[test]
    fn video_convert_accepts_only_declared_target_formats() {
        let webm = video_convert_profile(" webm ").expect("webm should be supported");
        assert_eq!(webm.1, "libvpx-vp9");
        assert!(
            webm.0.is_none(),
            "WebM must not use an incompatible H.264 NVENC encoder"
        );
        assert!(video_convert_profile("mpeg").is_err());
    }

    #[test]
    fn video_convert_rejects_duplicate_or_invalid_input_paths() {
        let directory = test_directory("validation");
        let video = directory.join("clip.m4v");
        std::fs::write(&video, [0_u8; 32]).expect("write fixture video");
        let video_path = video.to_string_lossy().into_owned();
        assert_eq!(
            validate_video_convert_inputs(&[video_path.clone()])
                .expect("m4v input should be accepted")
                .len(),
            1
        );
        assert_eq!(
            validate_video_convert_inputs(&[video_path.clone(), video_path])
                .expect_err("duplicate input must be rejected"),
            "video-convert:duplicate-input"
        );
        let invalid = directory.join("clip.txt");
        std::fs::write(&invalid, [0_u8; 32]).expect("write invalid fixture");
        assert_eq!(
            validate_video_convert_inputs(&[invalid.to_string_lossy().into_owned()])
                .expect_err("non-video input must be rejected"),
            "video-convert:invalid-input"
        );
        std::fs::remove_dir_all(&directory).expect("remove temporary test directory");
    }

    #[test]
    fn video_convert_parses_timestamp_progress() {
        assert_eq!(parse_ffmpeg_timestamp("01:02:03.5"), Some(3723.5));
        assert_eq!(
            parse_ffmpeg_progress_seconds("out_time=00:00:05.25"),
            Some(5.25)
        );
        assert_eq!(
            parse_ffmpeg_progress_seconds("out_time_us=2500000"),
            Some(2.5)
        );
        assert_eq!(parse_ffmpeg_timestamp("bad"), None);
    }

    #[test]
    fn video_convert_publishes_unique_output_without_overwriting() {
        let directory = test_directory("publish");
        let existing = directory.join("sample_converted.mp4");
        let temporary = directory.join(".toolknit-video-temp.mp4");
        std::fs::write(&existing, b"original-output").expect("write existing output");
        std::fs::write(&temporary, b"new-output").expect("write temporary output");

        let published = publish_video_convert_output(&temporary, &directory, "sample", ".mp4")
            .expect("publish a unique output");
        assert!(published.ends_with("sample_converted_1.mp4"));
        assert_eq!(
            std::fs::read(&existing).expect("read existing output"),
            b"original-output"
        );
        assert_eq!(
            std::fs::read(&published).expect("read published output"),
            b"new-output"
        );
        assert!(!temporary.exists());
        std::fs::remove_dir_all(&directory).expect("remove temporary test directory");
    }
}

#[derive(serde::Serialize)]
struct ProbeResult {
    duration: f64,
    file_size: u64,
    audio_tracks: Vec<AudioTrack>,
    frame_rate: f64,
    width: u32,
    height: u32,
}

#[derive(serde::Serialize)]
struct AudioTrack {
    index: usize,
    codec: String,
    language: String,
    channels: String,
}

const AUDIO_EXTRACT_MAX_INPUT_BYTES: u64 = 10 * 1024 * 1024 * 1024;
const AUDIO_EXTRACT_MAX_TRACK_INDEX: usize = 31;

fn validate_audio_extract_input(input_path: &str) -> Result<std::path::PathBuf, String> {
    if input_path.contains('\0') {
        return Err("audio-extract:invalid-input".to_string());
    }
    let input = std::path::PathBuf::from(input_path);
    let extension = input
        .extension()
        .and_then(|value| value.to_str())
        .map(|value| value.to_ascii_lowercase());
    let metadata =
        std::fs::symlink_metadata(&input).map_err(|_| "audio-extract:invalid-input".to_string())?;
    if metadata.file_type().is_symlink()
        || !metadata.is_file()
        || !matches!(
            extension.as_deref(),
            Some("mp4" | "mkv" | "avi" | "mov" | "webm" | "flv" | "wmv" | "ts" | "m4v")
        )
    {
        return Err("audio-extract:invalid-input".to_string());
    }
    if metadata.len() == 0 {
        return Err("audio-extract:invalid-input".to_string());
    }
    if metadata.len() > AUDIO_EXTRACT_MAX_INPUT_BYTES {
        return Err("audio-extract:input-too-large".to_string());
    }
    input
        .canonicalize()
        .map_err(|_| "audio-extract:invalid-input".to_string())
}

fn validate_audio_extract_output_dir(output_dir: &str) -> Result<std::path::PathBuf, String> {
    if output_dir.trim().is_empty() || output_dir.contains('\0') {
        return Err("audio-extract:output-path".to_string());
    }
    let output_dir = std::path::PathBuf::from(output_dir);
    is_path_safe(&output_dir).map_err(|_| "audio-extract:output-path".to_string())?;
    std::fs::create_dir_all(&output_dir).map_err(|_| "audio-extract:output-path".to_string())?;
    if !output_dir.is_dir() {
        return Err("audio-extract:output-path".to_string());
    }
    let output_dir = output_dir
        .canonicalize()
        .map_err(|_| "audio-extract:output-path".to_string())?;
    is_path_safe(&output_dir).map_err(|_| "audio-extract:output-path".to_string())?;
    Ok(output_dir)
}

fn normalize_audio_extract_format(value: &str) -> Result<&'static str, String> {
    match value.trim().to_ascii_uppercase().as_str() {
        "MP3" => Ok("MP3"),
        "AAC" => Ok("AAC"),
        "WAV" => Ok("WAV"),
        "FLAC" => Ok("FLAC"),
        "OGG" => Ok("OGG"),
        _ => Err("audio-extract:invalid-target-format".to_string()),
    }
}

fn create_audio_extract_temp_path(
    output_dir: &std::path::Path,
    extension: &str,
) -> Result<std::path::PathBuf, String> {
    use std::time::{SystemTime, UNIX_EPOCH};

    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| "audio-extract:output-path".to_string())?
        .as_nanos();
    for attempt in 0..100_u32 {
        let candidate = output_dir.join(format!(
            ".toolknit-audio-extract-{}-{}-{}{}",
            std::process::id(),
            timestamp,
            attempt,
            extension
        ));
        if !candidate.exists() {
            return Ok(candidate);
        }
    }
    Err("audio-extract:output-path".to_string())
}

fn audio_extract_file_stem(input: &std::path::Path) -> String {
    let raw_stem = input
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("video");
    let sanitized: String = raw_stem
        .chars()
        .map(|character| {
            if matches!(
                character,
                '\\' | '/' | ':' | '*' | '?' | '"' | '<' | '>' | '|'
            ) {
                '_'
            } else {
                character
            }
        })
        .collect();
    let trimmed = sanitized
        .trim()
        .trim_end_matches(|character| character == '.' || character == ' ');
    let safe_stem: String = trimmed.chars().take(96).collect();
    if safe_stem.is_empty() {
        "video".to_string()
    } else {
        safe_stem
    }
}

fn publish_audio_extract_output(
    temporary_path: &std::path::Path,
    output_dir: &std::path::Path,
    source_stem: &str,
    extension: &str,
) -> Result<String, String> {
    for counter in 0..10_000_u32 {
        let name = if counter == 0 {
            format!("{}_audio{}", source_stem, extension)
        } else {
            format!("{}_audio_{}{}", source_stem, counter, extension)
        };
        let candidate = output_dir.join(name);
        match std::fs::hard_link(temporary_path, &candidate) {
            Ok(()) => {
                std::fs::remove_file(temporary_path)
                    .map_err(|_| "audio-extract:output-path".to_string())?;
                return Ok(candidate.to_string_lossy().into_owned());
            }
            Err(_) if candidate.exists() => continue,
            Err(_) => return Err("audio-extract:output-path".to_string()),
        }
    }
    Err("audio-extract:output-path".to_string())
}

#[tauri::command]
async fn probe_video(input_path: String) -> Result<ProbeResult, String> {
    let input = validate_audio_extract_input(&input_path)?;
    let ffmpeg_path = get_ffmpeg_path()?;
    let mut cmd = tokio::process::Command::new(&ffmpeg_path);
    cmd.arg("-i")
        .arg(&input)
        .arg("-hide_banner")
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());

    #[cfg(target_os = "windows")]
    {
        cmd.creation_flags(0x08000000);
    }

    let output = cmd
        .spawn()
        .map_err(|e| format!("Failed to run ffmpeg: {}", e))?
        .wait_with_output()
        .await
        .map_err(|e| format!("ffmpeg wait failed: {}", e))?;

    let stderr = String::from_utf8_lossy(&output.stderr).to_string();

    // Parse duration
    let mut duration: f64 = 0.0;
    for line in stderr.lines() {
        if line.contains("Duration:") {
            let start = line.find("Duration:").map(|i| i + 9);
            if let Some(s) = start {
                let dur_str = line[s..].trim();
                let end = dur_str.find(',').unwrap_or(dur_str.len());
                let parts: Vec<&str> = dur_str[..end].trim().split(':').collect();
                if parts.len() == 3 {
                    let h: f64 = parts[0].trim().parse().unwrap_or(0.0);
                    let m: f64 = parts[1].trim().parse().unwrap_or(0.0);
                    let s: f64 = parts[2].trim().parse().unwrap_or(0.0);
                    duration = h * 3600.0 + m * 60.0 + s;
                }
            }
            break;
        }
    }

    // Parse the primary video stream's declared frame rate for desktop frame stepping.
    let mut frame_rate = 0.0;
    let mut video_width: u32 = 0;
    let mut video_height: u32 = 0;
    for line in stderr.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with("Stream #") && trimmed.contains("Video:") {
            let tokens: Vec<&str> = trimmed.split_whitespace().collect();
            for token in &tokens {
                let clean = token.trim_end_matches(',').trim();
                if let Some((w, h)) = clean.split_once('x') {
                    if let (Ok(parsed_w), Ok(parsed_h)) = (w.parse::<u32>(), h.parse::<u32>()) {
                        if parsed_w > 0 && parsed_h > 0 {
                            video_width = parsed_w;
                            video_height = parsed_h;
                            break;
                        }
                    }
                }
            }
            for pair in tokens.windows(2) {
                if pair[1].eq_ignore_ascii_case("fps") {
                    frame_rate = pair[0].trim_end_matches(',').parse::<f64>().unwrap_or(0.0);
                    break;
                }
            }
            break;
        }
    }

    // Parse audio tracks
    let mut audio_tracks = Vec::new();
    for line in stderr.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with("Stream #") && trimmed.contains("Audio:") {
            let index = audio_tracks.len();
            let codec = if trimmed.contains("mp3") {
                "MP3"
            } else if trimmed.contains("aac") {
                "AAC"
            } else if trimmed.contains("ac3") {
                "AC3"
            } else if trimmed.contains("vorbis") {
                "Vorbis"
            } else if trimmed.contains("opus") {
                "Opus"
            } else if trimmed.contains("flac") {
                "FLAC"
            } else if trimmed.contains("pcm") {
                "PCM"
            } else {
                "Unknown"
            };
            let language = if trimmed.contains("(") {
                let lang_start = trimmed.rfind("(").map(|i| i + 1);
                let lang_end = trimmed.rfind(")").unwrap_or(trimmed.len());
                if let Some(s) = lang_start {
                    trimmed[s..lang_end].to_string()
                } else {
                    "default".to_string()
                }
            } else {
                "default".to_string()
            };
            let channels = if trimmed.contains("mono") {
                "mono"
            } else if trimmed.contains("stereo") {
                "stereo"
            } else if trimmed.contains("5.1") {
                "5.1"
            } else if trimmed.contains("7.1") {
                "7.1"
            } else {
                "unknown"
            };
            audio_tracks.push(AudioTrack {
                index,
                codec: codec.to_string(),
                language,
                channels: channels.to_string(),
            });
        }
    }

    let file_size = std::fs::metadata(&input).map(|m| m.len()).unwrap_or(0);

    Ok(ProbeResult {
        duration,
        file_size,
        audio_tracks,
        frame_rate,
        width: video_width,
        height: video_height,
    })
}

#[derive(serde::Serialize)]
struct VideoPreviewFrame {
    image_data_url: String,
    timestamp_ms: u64,
}

#[derive(serde::Serialize)]
struct VideoPreviewClip {
    media_data_url: String,
    start_ms: u64,
    end_ms: u64,
}

fn validate_video_preview_clip_range(start_ms: u64, end_ms: u64) -> Result<(), String> {
    const MAX_TIMESTAMP_MS: u64 = 24 * 60 * 60 * 1000;
    const MAX_DURATION_MS: u64 = 30_000;
    if end_ms <= start_ms || end_ms > MAX_TIMESTAMP_MS || end_ms - start_ms > MAX_DURATION_MS {
        return Err("video-preview:invalid-range".to_string());
    }
    Ok(())
}

/// Render a lightweight preview with the same FFmpeg decoder used for exports.
/// WebView media support varies by installed Windows codecs, so the desktop UI
/// deliberately does not depend on HTML video decoding for frame selection.
#[tauri::command]
async fn render_video_preview_frame(
    input_path: String,
    timestamp_ms: u64,
) -> Result<VideoPreviewFrame, String> {
    use base64::Engine;

    const MAX_TIMESTAMP_MS: u64 = 24 * 60 * 60 * 1000;
    const MAX_PREVIEW_BYTES: usize = 8 * 1024 * 1024;

    let input = validate_audio_extract_input(&input_path)?;
    if timestamp_ms > MAX_TIMESTAMP_MS {
        return Err("video-preview:invalid-timestamp".to_string());
    }
    let ffmpeg = get_ffmpeg_path()?;
    let mut command = tokio::process::Command::new(&ffmpeg);
    command
        .arg("-hide_banner")
        .arg("-nostdin")
        .arg("-loglevel")
        .arg("error")
        .arg("-i")
        .arg(&input)
        // Put -ss after the input so keyboard frame stepping matches export.
        .arg("-ss")
        .arg(format!("{:.3}", timestamp_ms as f64 / 1000.0))
        .arg("-map")
        .arg("0:v:0")
        .arg("-frames:v")
        .arg("1")
        .arg("-vf")
        .arg("scale=w='min(1280,iw)':h='min(720,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2:flags=lanczos")
        .arg("-c:v")
        .arg("mjpeg")
        .arg("-q:v")
        .arg("4")
        .arg("-f")
        .arg("image2pipe")
        .arg("pipe:1")
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    #[cfg(target_os = "windows")]
    {
        command.creation_flags(0x08000000);
    }

    let output = command
        .spawn()
        .map_err(|_| "video-preview:engine-failed".to_string())?
        .wait_with_output()
        .await
        .map_err(|_| "video-preview:engine-failed".to_string())?;
    if !output.status.success() || output.stdout.is_empty() {
        return Err("video-preview:engine-failed".to_string());
    }
    if output.stdout.len() > MAX_PREVIEW_BYTES {
        return Err("video-preview:output-too-large".to_string());
    }

    Ok(VideoPreviewFrame {
        image_data_url: format!(
            "data:image/jpeg;base64,{}",
            base64::engine::general_purpose::STANDARD.encode(output.stdout)
        ),
        timestamp_ms,
    })
}

/// Transcode the selected range to a small, browser-compatible stream. The source
/// file itself is never exposed to the WebView, whose codec support is inconsistent.
#[tauri::command]
async fn render_video_preview_clip(
    input_path: String,
    start_ms: u64,
    end_ms: u64,
) -> Result<VideoPreviewClip, String> {
    use base64::Engine;

    const MAX_PREVIEW_BYTES: usize = 10 * 1024 * 1024;

    validate_video_preview_clip_range(start_ms, end_ms)?;
    let input = validate_audio_extract_input(&input_path)?;
    let ffmpeg = get_ffmpeg_path()?;
    let source_duration = probe_video_convert_duration(&ffmpeg, &input)
        .await
        .unwrap_or(0.0);
    if source_duration > 0.0 && end_ms as f64 > source_duration * 1000.0 + 1.0 {
        return Err("video-preview:timestamp-out-of-range".to_string());
    }

    let mut command = tokio::process::Command::new(&ffmpeg);
    command
        .arg("-hide_banner")
        .arg("-nostdin")
        .arg("-loglevel")
        .arg("error")
        .arg("-i")
        .arg(&input)
        .arg("-ss")
        .arg(format!("{:.3}", start_ms as f64 / 1000.0))
        .arg("-t")
        .arg(format!("{:.3}", (end_ms - start_ms) as f64 / 1000.0))
        .arg("-map")
        .arg("0:v:0")
        .arg("-an")
        .arg("-vf")
        .arg("fps=12,scale=w='min(960,iw)':h='min(540,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2:flags=lanczos")
        .arg("-c:v")
        .arg("libx264")
        .arg("-profile:v")
        .arg("baseline")
        .arg("-level:v")
        .arg("3.1")
        .arg("-preset")
        .arg("veryfast")
        .arg("-crf")
        .arg("27")
        .arg("-maxrate")
        .arg("900k")
        .arg("-bufsize")
        .arg("1800k")
        .arg("-pix_fmt")
        .arg("yuv420p")
        .arg("-movflags")
        .arg("+frag_keyframe+empty_moov+default_base_moof")
        .arg("-f")
        .arg("mp4")
        .arg("pipe:1")
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    #[cfg(target_os = "windows")]
    {
        command.creation_flags(0x08000000);
    }

    let output = command
        .spawn()
        .map_err(|_| "video-preview:engine-failed".to_string())?
        .wait_with_output()
        .await
        .map_err(|_| "video-preview:engine-failed".to_string())?;
    if !output.status.success() || output.stdout.is_empty() {
        return Err("video-preview:engine-failed".to_string());
    }
    if output.stdout.len() > MAX_PREVIEW_BYTES {
        return Err("video-preview:output-too-large".to_string());
    }

    Ok(VideoPreviewClip {
        media_data_url: format!(
            "data:video/mp4;base64,{}",
            base64::engine::general_purpose::STANDARD.encode(output.stdout)
        ),
        start_ms,
        end_ms,
    })
}

#[cfg(test)]
mod video_preview_contract_tests {
    use super::*;

    #[test]
    fn preview_clip_accepts_a_gif_sized_selection_only() {
        assert!(validate_video_preview_clip_range(0, 30_000).is_ok());
        assert_eq!(
            validate_video_preview_clip_range(0, 30_001).unwrap_err(),
            "video-preview:invalid-range"
        );
        assert_eq!(
            validate_video_preview_clip_range(4_000, 4_000).unwrap_err(),
            "video-preview:invalid-range"
        );
    }

    #[tokio::test]
    async fn preview_clip_transcodes_to_a_browser_compatible_mp4_stream() {
        use base64::Engine;

        let _guard = test_conversion_lock();
        let Ok(ffmpeg) = get_ffmpeg_path() else {
            return;
        };
        let unique = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("system clock is valid")
            .as_nanos();
        let directory = std::env::temp_dir().join(format!(
            "toolknit-video-preview-{}-{}",
            std::process::id(),
            unique
        ));
        std::fs::create_dir_all(&directory).expect("create preview test directory");
        let source = directory.join("sample.mp4");
        let generated = std::process::Command::new(&ffmpeg)
            .args([
                "-hide_banner",
                "-loglevel",
                "error",
                "-y",
                "-f",
                "lavfi",
                "-i",
                "testsrc2=size=320x180:rate=12",
                "-t",
                "2",
                "-c:v",
                "libx264",
                "-pix_fmt",
                "yuv420p",
            ])
            .arg(&source)
            .status()
            .expect("start fixture encoder");
        assert!(generated.success(), "create preview fixture");

        let preview = render_video_preview_clip(source.to_string_lossy().into_owned(), 0, 1_000)
            .await
            .expect("render preview clip");
        let encoded = preview
            .media_data_url
            .strip_prefix("data:video/mp4;base64,")
            .expect("video preview data URL");
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(encoded)
            .expect("decode preview video");
        assert!(bytes.windows(4).any(|chunk| chunk == b"ftyp"));
        assert!(bytes.len() > 1_000, "preview stream is non-empty");

        std::fs::remove_dir_all(&directory).expect("remove preview test directory");
    }
}

#[derive(serde::Serialize)]
struct VideoFrameResult {
    output_path: String,
    timestamp_ms: u64,
    format: String,
}

fn publish_video_frame_output(
    temporary_path: &std::path::Path,
    output_dir: &std::path::Path,
    source_stem: &str,
    timestamp_ms: u64,
    extension: &str,
) -> Result<String, String> {
    for counter in 0..10_000_u32 {
        let suffix = if counter == 0 {
            String::new()
        } else {
            format!("_{}", counter)
        };
        let candidate = output_dir.join(format!(
            "{}_frame_{}ms{}{}",
            source_stem, timestamp_ms, suffix, extension
        ));
        match std::fs::hard_link(temporary_path, &candidate) {
            Ok(()) => {
                std::fs::remove_file(temporary_path)
                    .map_err(|_| "video-frame:output-path".to_string())?;
                return Ok(candidate.to_string_lossy().into_owned());
            }
            Err(_) if candidate.exists() => continue,
            Err(_) => return Err("video-frame:output-path".to_string()),
        }
    }
    Err("video-frame:output-path".to_string())
}

#[tauri::command]
async fn extract_video_frame(
    app_handle: tauri::AppHandle,
    input_path: String,
    output_dir: String,
    timestamp_ms: u64,
    format: String,
) -> Result<VideoFrameResult, String> {
    use tauri::Emitter;
    let _guard = begin_conversion()?;
    let input = validate_audio_extract_input(&input_path)?;
    if timestamp_ms > 24 * 60 * 60 * 1000 {
        return Err("video-frame:invalid-timestamp".to_string());
    }
    let normalized_format = match format.trim().to_ascii_lowercase().as_str() {
        "png" => "png",
        "jpg" | "jpeg" => "jpg",
        _ => return Err("video-frame:invalid-format".to_string()),
    };
    let output_dir = validate_audio_extract_output_dir(&output_dir)?;
    let ffmpeg = get_ffmpeg_path()?;
    let duration = probe_video_convert_duration(&ffmpeg, &input)
        .await
        .unwrap_or(0.0);
    if duration > 0.0 && timestamp_ms as f64 > duration * 1000.0 + 1.0 {
        return Err("video-frame:timestamp-out-of-range".to_string());
    }
    let extension = if normalized_format == "png" {
        ".png"
    } else {
        ".jpg"
    };
    let temporary = create_audio_extract_temp_path(&output_dir, extension)?;
    let _ = app_handle.emit(
        "video-frame-progress",
        serde_json::json!({ "progress": 0.1, "phase": "prepare" }),
    );
    let mut command = tokio::process::Command::new(&ffmpeg);
    command
        .arg("-hide_banner")
        .arg("-nostdin")
        .arg("-y")
        .arg("-i")
        .arg(&input)
        .arg("-ss")
        .arg(format!("{:.3}", timestamp_ms as f64 / 1000.0))
        .arg("-map")
        .arg("0:v:0")
        .arg("-frames:v")
        .arg("1");
    if normalized_format == "png" {
        command.arg("-c:v").arg("png");
    } else {
        command.arg("-q:v").arg("2");
    }
    command
        .arg(&temporary)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    #[cfg(target_os = "windows")]
    {
        command.creation_flags(0x08000000);
    }
    let result = command
        .spawn()
        .map_err(|_| "video-frame:engine-failed".to_string())?
        .wait_with_output()
        .await
        .map_err(|_| "video-frame:engine-failed".to_string())?;
    if CANCEL_FLAG.load(Ordering::SeqCst) {
        let _ = std::fs::remove_file(&temporary);
        return Err("video-frame:cancelled".to_string());
    }
    if !result.status.success()
        || !temporary.is_file()
        || std::fs::metadata(&temporary).map(|m| m.len()).unwrap_or(0) == 0
    {
        let _ = std::fs::remove_file(&temporary);
        return Err("video-frame:engine-failed".to_string());
    }
    let _ = app_handle.emit(
        "video-frame-progress",
        serde_json::json!({ "progress": 0.9, "phase": "publish" }),
    );
    let output_path = publish_video_frame_output(
        &temporary,
        &output_dir,
        &audio_extract_file_stem(&input),
        timestamp_ms,
        extension,
    )?;
    let _ = app_handle.emit(
        "video-frame-progress",
        serde_json::json!({ "progress": 1.0, "phase": "complete" }),
    );
    Ok(VideoFrameResult {
        output_path,
        timestamp_ms,
        format: normalized_format.to_string(),
    })
}

#[derive(serde::Serialize)]
struct VideoGifResult {
    output_path: String,
    start_ms: u64,
    end_ms: u64,
    duration_ms: u64,
    frame_rate: u32,
    width: u32,
    quality: String,
    output_size: u64,
}

fn publish_video_gif_output(
    temporary_path: &std::path::Path,
    output_dir: &std::path::Path,
    source_stem: &str,
    start_ms: u64,
    end_ms: u64,
) -> Result<String, String> {
    for counter in 0..10_000_u32 {
        let suffix = if counter == 0 {
            String::new()
        } else {
            format!("_{}", counter)
        };
        let candidate = output_dir.join(format!(
            "{}_clip_{}-{}ms{}.gif",
            source_stem, start_ms, end_ms, suffix
        ));
        match std::fs::hard_link(temporary_path, &candidate) {
            Ok(()) => {
                std::fs::remove_file(temporary_path)
                    .map_err(|_| "video-gif:output-path".to_string())?;
                return Ok(candidate.to_string_lossy().into_owned());
            }
            Err(_) if candidate.exists() => continue,
            Err(_) => return Err("video-gif:output-path".to_string()),
        }
    }
    Err("video-gif:output-path".to_string())
}

#[tauri::command]
async fn extract_video_gif(
    app_handle: tauri::AppHandle,
    input_path: String,
    output_dir: String,
    start_ms: u64,
    end_ms: u64,
    frame_rate: Option<u32>,
    width: Option<u32>,
    quality: Option<String>,
) -> Result<VideoGifResult, String> {
    use tauri::Emitter;
    const MAX_GIF_DURATION_MS: u64 = 30_000;
    const MAX_GIF_OUTPUT_BYTES: u64 = 500 * 1024 * 1024;
    let _guard = begin_conversion()?;
    let input = validate_audio_extract_input(&input_path)?;
    if end_ms <= start_ms || end_ms - start_ms > MAX_GIF_DURATION_MS || end_ms > 24 * 60 * 60 * 1000
    {
        return Err("video-gif:invalid-range".to_string());
    }
    let frame_rate = frame_rate.unwrap_or(12);
    let width = width.unwrap_or(640);
    if !(1..=20).contains(&frame_rate) || !(160..=1920).contains(&width) {
        return Err("video-gif:invalid-settings".to_string());
    }
    let quality = quality
        .unwrap_or_else(|| "balanced".to_string())
        .trim()
        .to_ascii_lowercase();
    let (max_colors, dither) = match quality.as_str() {
        "high" => (256_u32, "sierra2_4a"),
        "balanced" => (192_u32, "bayer:bayer_scale=3"),
        "small" => (128_u32, "bayer:bayer_scale=4"),
        "tiny" => (96_u32, "bayer:bayer_scale=5"),
        _ => return Err("video-gif:invalid-quality".to_string()),
    };
    let output_dir = validate_audio_extract_output_dir(&output_dir)?;
    let ffmpeg = get_ffmpeg_path()?;
    let duration = probe_video_convert_duration(&ffmpeg, &input)
        .await
        .unwrap_or(0.0);
    if duration > 0.0 && end_ms as f64 > duration * 1000.0 + 1.0 {
        return Err("video-gif:timestamp-out-of-range".to_string());
    }
    let temporary = create_audio_extract_temp_path(&output_dir, ".gif")?;
    let _ = app_handle.emit(
        "video-gif-progress",
        serde_json::json!({ "progress": 0.05, "phase": "prepare" }),
    );
    let filter = format!("fps={},scale=w='min({},iw)':h=-2:flags=lanczos,split[a][b];[a]palettegen=max_colors={}:stats_mode=diff[p];[b][p]paletteuse=dither={}:diff_mode=rectangle[out]", frame_rate, width, max_colors, dither);
    let mut command = tokio::process::Command::new(&ffmpeg);
    command
        .arg("-hide_banner")
        .arg("-nostdin")
        .arg("-y")
        .arg("-i")
        .arg(&input)
        .arg("-ss")
        .arg(format!("{:.3}", start_ms as f64 / 1000.0))
        .arg("-t")
        .arg(format!("{:.3}", (end_ms - start_ms) as f64 / 1000.0))
        .arg("-filter_complex")
        .arg(filter)
        .arg("-map")
        .arg("[out]")
        .arg("-loop")
        .arg("0")
        .arg(&temporary)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    #[cfg(target_os = "windows")]
    {
        command.creation_flags(0x08000000);
    }
    let result = command
        .spawn()
        .map_err(|_| "video-gif:engine-failed".to_string())?
        .wait_with_output()
        .await
        .map_err(|_| "video-gif:engine-failed".to_string())?;
    if CANCEL_FLAG.load(Ordering::SeqCst) {
        let _ = std::fs::remove_file(&temporary);
        return Err("video-gif:cancelled".to_string());
    }
    let metadata =
        std::fs::metadata(&temporary).map_err(|_| "video-gif:engine-failed".to_string())?;
    if !result.status.success() || !metadata.is_file() || metadata.len() == 0 {
        let _ = std::fs::remove_file(&temporary);
        return Err("video-gif:engine-failed".to_string());
    }
    if metadata.len() > MAX_GIF_OUTPUT_BYTES {
        let _ = std::fs::remove_file(&temporary);
        return Err("video-gif:output-too-large".to_string());
    }
    let output_size = metadata.len();
    let _ = app_handle.emit(
        "video-gif-progress",
        serde_json::json!({ "progress": 0.92, "phase": "publish" }),
    );
    let output_path = publish_video_gif_output(
        &temporary,
        &output_dir,
        &audio_extract_file_stem(&input),
        start_ms,
        end_ms,
    )?;
    let _ = app_handle.emit(
        "video-gif-progress",
        serde_json::json!({ "progress": 1.0, "phase": "complete" }),
    );
    Ok(VideoGifResult {
        output_path,
        start_ms,
        end_ms,
        duration_ms: end_ms - start_ms,
        frame_rate,
        width,
        quality,
        output_size,
    })
}

#[derive(serde::Serialize)]
struct ExtractResult {
    success: bool,
    output_path: String,
    error: Option<String>,
}

fn emit_audio_extract_progress(app_handle: &Option<tauri::AppHandle>, status: &str, progress: f64) {
    use tauri::Emitter;

    if let Some(app_handle) = app_handle {
        let _ = app_handle.emit(
            "audio-extract-progress",
            serde_json::json!({
                "status": status,
                "progress": progress.clamp(0.0, 1.0),
            }),
        );
    }
}

#[tauri::command]
async fn extract_audio(
    app_handle: tauri::AppHandle,
    input_path: String,
    output_dir: String,
    target_format: String,
    track_index: Option<usize>,
) -> Result<ExtractResult, String> {
    extract_audio_inner(
        Some(app_handle),
        input_path,
        output_dir,
        target_format,
        track_index,
    )
    .await
}

async fn extract_audio_inner(
    app_handle: Option<tauri::AppHandle>,
    input_path: String,
    output_dir: String,
    target_format: String,
    track_index: Option<usize>,
) -> Result<ExtractResult, String> {
    let _conversion_guard = begin_conversion()?;
    let input = validate_audio_extract_input(&input_path)?;
    let target_format = normalize_audio_extract_format(&target_format)?;
    if track_index.is_some_and(|index| index > AUDIO_EXTRACT_MAX_TRACK_INDEX) {
        return Err("audio-extract:invalid-track".to_string());
    }
    let ffmpeg_path = get_ffmpeg_path()?;
    let output_dir_path = validate_audio_extract_output_dir(&output_dir)?;
    emit_audio_extract_progress(&app_handle, "probe", 0.0);
    let duration = probe_video_convert_duration(&ffmpeg_path, &input)
        .await
        .unwrap_or(0.0);
    if CANCEL_FLAG.load(Ordering::SeqCst) {
        emit_audio_extract_progress(&app_handle, "cancelled", 1.0);
        return Err("audio-extract:cancelled".to_string());
    }
    emit_audio_extract_progress(&app_handle, "prepare", 0.05);

    let (encoder, extra_args, ext) = get_encoder_params(target_format, "medium");
    let temporary_path = create_audio_extract_temp_path(&output_dir_path, ext)?;

    let mut cmd = tokio::process::Command::new(&ffmpeg_path);
    cmd.arg("-y")
        .arg("-i")
        .arg(&input)
        .arg("-vn")
        .arg("-map")
        .arg(format!("0:a:{}", track_index.unwrap_or(0)));

    cmd.arg("-c:a")
        .arg(&encoder)
        .args(&extra_args)
        .arg("-progress")
        .arg("pipe:1")
        .arg("-nostats")
        .arg(&temporary_path)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());

    #[cfg(target_os = "windows")]
    {
        cmd.creation_flags(0x08000000);
    }

    let mut child = match cmd.spawn() {
        Ok(child) => child,
        Err(_) => {
            emit_audio_extract_progress(&app_handle, "failed", 1.0);
            return Err("audio-extract:failed".to_string());
        }
    };
    if let Some(id) = child.id() {
        CURRENT_CHILD_ID.store(id, Ordering::SeqCst);
    }
    let stdout = match child.stdout.take() {
        Some(stdout) => stdout,
        None => {
            let _ = child.kill().await;
            CURRENT_CHILD_ID.store(0, Ordering::SeqCst);
            let _ = std::fs::remove_file(&temporary_path);
            emit_audio_extract_progress(&app_handle, "failed", 1.0);
            return Err("audio-extract:failed".to_string());
        }
    };
    let stderr = match child.stderr.take() {
        Some(stderr) => stderr,
        None => {
            let _ = child.kill().await;
            CURRENT_CHILD_ID.store(0, Ordering::SeqCst);
            let _ = std::fs::remove_file(&temporary_path);
            emit_audio_extract_progress(&app_handle, "failed", 1.0);
            return Err("audio-extract:failed".to_string());
        }
    };
    let progress_app = app_handle.clone();
    let progress_task = tokio::spawn(async move {
        use tauri::Emitter;
        use tokio::io::{AsyncBufReadExt, BufReader};

        let mut lines = BufReader::new(stdout).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            let Some(seconds) = parse_ffmpeg_progress_seconds(&line) else {
                continue;
            };
            let progress = if duration > 0.0 {
                0.05 + (seconds / duration).clamp(0.0, 0.9)
            } else {
                0.05
            };
            if let Some(app_handle) = &progress_app {
                let _ = app_handle.emit(
                    "audio-extract-progress",
                    serde_json::json!({ "status": "extract", "progress": progress }),
                );
            }
        }
    });
    let stderr_task = tokio::spawn(async move {
        use tokio::io::{AsyncReadExt, BufReader};

        let mut bytes = Vec::new();
        let mut reader = BufReader::new(stderr);
        let _ = reader.read_to_end(&mut bytes).await;
        String::from_utf8_lossy(&bytes).into_owned()
    });
    let status = match child.wait().await {
        Ok(status) => status,
        Err(_) => {
            CURRENT_CHILD_ID.store(0, Ordering::SeqCst);
            let _ = progress_task.await;
            let _ = stderr_task.await;
            let _ = std::fs::remove_file(&temporary_path);
            emit_audio_extract_progress(&app_handle, "failed", 1.0);
            return Err("audio-extract:failed".to_string());
        }
    };
    CURRENT_CHILD_ID.store(0, Ordering::SeqCst);
    let _ = progress_task.await;
    let stderr = stderr_task.await.unwrap_or_default();

    if CANCEL_FLAG.load(Ordering::SeqCst) {
        let _ = std::fs::remove_file(&temporary_path);
        emit_audio_extract_progress(&app_handle, "cancelled", 1.0);
        return Err("audio-extract:cancelled".to_string());
    }

    if status.success() {
        if std::fs::metadata(&temporary_path)
            .map(|metadata| metadata.len() == 0)
            .unwrap_or(true)
        {
            let _ = std::fs::remove_file(&temporary_path);
            emit_audio_extract_progress(&app_handle, "failed", 1.0);
            return Err("audio-extract:failed".to_string());
        }
        emit_audio_extract_progress(&app_handle, "publish", 0.97);
        let output_path = match publish_audio_extract_output(
            &temporary_path,
            &output_dir_path,
            &audio_extract_file_stem(&input),
            ext,
        ) {
            Ok(path) => path,
            Err(error) => {
                let _ = std::fs::remove_file(&temporary_path);
                emit_audio_extract_progress(&app_handle, "failed", 1.0);
                return Err(error);
            }
        };
        emit_audio_extract_progress(&app_handle, "done", 1.0);
        Ok(ExtractResult {
            success: true,
            output_path,
            error: None,
        })
    } else {
        let _ = std::fs::remove_file(&temporary_path);
        emit_audio_extract_progress(&app_handle, "failed", 1.0);
        let stderr = stderr.to_ascii_lowercase();
        if stderr.contains("matches no streams") || stderr.contains("does not contain any stream") {
            Err("audio-extract:no-audio-track".to_string())
        } else {
            Err("audio-extract:failed".to_string())
        }
    }
}

#[cfg(test)]
mod audio_extract_backend_tests {
    use super::*;

    fn test_directory() -> std::path::PathBuf {
        let suffix = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("clock must be after epoch")
            .as_nanos();
        let directory = std::env::temp_dir().join(format!("toolknit-audio-extract-{}", suffix));
        std::fs::create_dir_all(&directory).expect("create test directory");
        directory
    }

    #[tokio::test]
    async fn audio_extract_rejects_symlinks_and_publishes_unique_outputs() {
        let _conversion_lock = test_conversion_lock();
        let directory = test_directory();
        let video = directory.join("sample.mp4");
        let ffmpeg = get_ffmpeg_path().expect("bundled FFmpeg must be available");
        let status = tokio::process::Command::new(&ffmpeg)
            .args([
                "-hide_banner",
                "-loglevel",
                "error",
                "-y",
                "-f",
                "lavfi",
                "-i",
                "color=c=black:s=32x32:d=1",
                "-f",
                "lavfi",
                "-i",
                "sine=frequency=440:sample_rate=48000:duration=1",
                "-shortest",
                "-c:v",
                "mpeg4",
                "-c:a",
                "aac",
            ])
            .arg(&video)
            .status()
            .await
            .expect("start video fixture generation");
        assert!(status.success(), "generate a video with audio");

        let output_directory = directory.to_string_lossy().into_owned();
        let first = extract_audio_inner(
            None,
            video.to_string_lossy().into_owned(),
            output_directory.clone(),
            "MP3".to_string(),
            Some(0),
        )
        .await
        .expect("first extraction must succeed");
        assert!(first.success);
        assert!(
            std::fs::metadata(&first.output_path)
                .expect("inspect output")
                .len()
                > 0
        );

        let second = extract_audio_inner(
            None,
            video.to_string_lossy().into_owned(),
            output_directory,
            "MP3".to_string(),
            Some(0),
        )
        .await
        .expect("second extraction must succeed");
        assert!(second.success);
        assert_ne!(first.output_path, second.output_path);
        assert!(second.output_path.ends_with("sample_audio_1.mp3"));

        #[cfg(unix)]
        {
            use std::os::unix::fs::symlink;
            let symlink_path = directory.join("linked.mp4");
            symlink(&video, &symlink_path).expect("create symbolic link");
            assert_eq!(
                validate_audio_extract_input(&symlink_path.to_string_lossy())
                    .expect_err("symbolic link must be rejected"),
                "audio-extract:invalid-input",
            );
        }
        std::fs::remove_dir_all(&directory).expect("remove test directory");
    }
}

fn is_path_safe(path: &std::path::Path) -> Result<(), String> {
    // Try to canonicalize the path. If it doesn't exist (e.g. a new output file
    // or a not-yet-created subdirectory), walk up ancestors until one exists.
    let canonical = path
        .canonicalize()
        .or_else(|_| {
            let mut ancestor = path.parent();
            while let Some(a) = ancestor {
                if let Ok(c) = a.canonicalize() {
                    return Ok(c);
                }
                ancestor = a.parent();
            }
            Err(std::io::Error::new(
                std::io::ErrorKind::NotFound,
                "No existing ancestor",
            ))
        })
        .map_err(|e| format!("Invalid path: {}", e))?;
    let docs = dirs::document_dir().ok_or("Cannot find Documents folder")?;
    let dl = dirs::download_dir().ok_or("Cannot find Download folder")?;
    let appdata = dirs::data_dir().ok_or("Cannot find AppData folder")?;
    let temp = std::env::temp_dir();
    // Canonicalize all comparison dirs so prefixes match (Windows \\?\ prefix)
    let docs_c = docs.canonicalize().unwrap_or(docs.clone());
    let dl_c = dl.canonicalize().unwrap_or(dl.clone());
    let appdata_c = appdata.canonicalize().unwrap_or(appdata.clone());
    let temp_c = temp.canonicalize().unwrap_or(temp.clone());
    // Also allow the exe's parent directory (install directory) for output files
    let exe_dir = std::env::current_exe()
        .ok()
        .and_then(|e| e.parent().map(|p| p.to_path_buf()))
        .and_then(|p| p.canonicalize().ok().or(Some(p)));
    // Also allow the install_path from install_config.json (may differ from exe_dir if exe is in a subdirectory)
    let install_dir = {
        let exe = std::env::current_exe().ok();
        exe.and_then(|e| {
            e.parent().and_then(|p| {
                let mut search = p.to_path_buf();
                for _ in 0..4 {
                    let candidate = search.join("install_config.json");
                    if candidate.exists() {
                        if let Ok(content) = std::fs::read_to_string(&candidate) {
                            if let Ok(config) = serde_json::from_str::<serde_json::Value>(&content)
                            {
                                if let Some(ip) = config.get("installPath").and_then(|v| v.as_str())
                                {
                                    let p = std::path::PathBuf::from(ip);
                                    return p.canonicalize().ok().or(Some(p));
                                }
                            }
                        }
                    }
                    match search.parent() {
                        Some(p2) => search = p2.to_path_buf(),
                        None => break,
                    }
                }
                None
            })
        })
    };
    let output_root = configured_output_root();
    let is_allowed = canonical.starts_with(&docs_c)
        || canonical.starts_with(&dl_c)
        || canonical.starts_with(&appdata_c)
        || canonical.starts_with(&temp_c)
        || exe_dir.as_ref().map_or(false, |d| canonical.starts_with(d))
        || install_dir
            .as_ref()
            .map_or(false, |d| canonical.starts_with(d))
        || output_root
            .as_ref()
            .map_or(false, |d| canonical.starts_with(d));
    if is_allowed {
        Ok(())
    } else {
        Err("Path outside allowed directories".to_string())
    }
}

#[tauri::command]
fn read_file_bytes(path: String) -> Result<Vec<u8>, String> {
    // Reject files larger than 500MB to prevent OOM
    const MAX_FILE_SIZE: u64 = 500 * 1024 * 1024;
    if path.contains('\0') {
        return Err("Invalid path".to_string());
    }
    let metadata =
        std::fs::metadata(&path).map_err(|e| format!("Failed to read file metadata: {}", e))?;
    if metadata.len() > MAX_FILE_SIZE {
        return Err(format!(
            "File too large ({}MB, max 500MB)",
            metadata.len() / 1024 / 1024
        ));
    }
    std::fs::read(&path).map_err(|e| format!("Failed to read file: {}", e))
}

#[tauri::command]
fn read_file_bytes_limited(path: String, max_bytes: u64) -> Result<Vec<u8>, String> {
    use std::io::Read;

    const ABSOLUTE_MAX_FILE_SIZE: u64 = 500 * 1024 * 1024;
    if path.contains('\0') || max_bytes == 0 || max_bytes > ABSOLUTE_MAX_FILE_SIZE {
        return Err("Invalid file read request".to_string());
    }

    let metadata =
        std::fs::metadata(&path).map_err(|e| format!("Failed to read file metadata: {}", e))?;
    if !metadata.is_file() {
        return Err("Input path must be a file".to_string());
    }
    if metadata.len() > max_bytes {
        return Err(format!(
            "File too large ({}MB)",
            metadata.len() / 1024 / 1024
        ));
    }

    // Read one byte past the limit so a concurrent file replacement cannot bypass the size check.
    let file = std::fs::File::open(&path).map_err(|e| format!("Failed to open file: {}", e))?;
    let mut reader = file.take(max_bytes + 1);
    let mut bytes = Vec::with_capacity(metadata.len() as usize);
    reader
        .read_to_end(&mut bytes)
        .map_err(|e| format!("Failed to read file: {}", e))?;
    if bytes.len() as u64 > max_bytes {
        return Err(format!(
            "File too large (max {}MB)",
            max_bytes / 1024 / 1024
        ));
    }
    Ok(bytes)
}

#[derive(serde::Serialize)]
struct PreparedIconSourceImage {
    bytes: Vec<u8>,
    width: u32,
    height: u32,
    source_bytes: u64,
}

#[tauri::command]
fn prepare_icon_source_image(path: String) -> Result<PreparedIconSourceImage, String> {
    use image::ImageEncoder;

    const MAX_INPUT_BYTES: u64 = 20 * 1024 * 1024;
    const MAX_INPUT_PIXELS: u64 = 20_000_000;
    if path.contains('\0') {
        return Err("Invalid image path".to_string());
    }
    let source = std::path::PathBuf::from(path)
        .canonicalize()
        .map_err(|error| format!("Cannot access image file: {}", error))?;
    let extension = source
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    if !matches!(extension.as_str(), "png" | "jpg" | "jpeg" | "webp") {
        return Err("Only PNG, JPEG, and WebP images can be used for icon generation.".to_string());
    }
    let metadata = std::fs::metadata(&source)
        .map_err(|error| format!("Cannot read image file metadata: {}", error))?;
    if !metadata.is_file() {
        return Err("Input path must be an image file".to_string());
    }
    if metadata.len() == 0 || metadata.len() > MAX_INPUT_BYTES {
        return Err(
            "The image file is empty or exceeds the supported file size limit.".to_string(),
        );
    }

    let image = decode_oriented_image(&source)
        .map_err(|error| format!("Cannot decode image file: {}", error))?;
    let width = image.width();
    let height = image.height();
    let pixels = u64::from(width).saturating_mul(u64::from(height));
    if width == 0 || height == 0 || pixels > MAX_INPUT_PIXELS {
        return Err("Image dimensions exceed the supported pixel limit.".to_string());
    }

    let rgba = image.to_rgba8();
    let mut bytes = Vec::new();
    image::codecs::png::PngEncoder::new(&mut bytes)
        .write_image(&rgba, width, height, image::ColorType::Rgba8.into())
        .map_err(|error| format!("Cannot prepare image for icon generation: {}", error))?;
    if bytes.is_empty() || bytes.len() as u64 > MAX_INPUT_BYTES {
        return Err("Prepared image exceeds the supported file size limit.".to_string());
    }

    Ok(PreparedIconSourceImage {
        bytes,
        width,
        height,
        source_bytes: metadata.len(),
    })
}

#[tauri::command]
fn write_file_bytes(path: String, bytes: Vec<u8>) -> Result<(), String> {
    use std::fs;
    use std::path::Path;
    let path = Path::new(&path);
    is_path_safe(path)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("Failed to create directory: {}", e))?;
    }
    fs::write(path, bytes).map_err(|e| format!("Failed to write file: {}", e))
}

#[tauri::command]
fn write_unique_file_bytes(
    directory: String,
    file_name: String,
    bytes: Vec<u8>,
) -> Result<String, String> {
    use std::fs::{self, OpenOptions};
    use std::io::Write;
    use std::path::Path;

    if directory.contains('\0') || file_name.contains('\0') {
        return Err("Invalid path".to_string());
    }
    let directory = Path::new(&directory);
    let file_path = Path::new(&file_name);
    if file_path.is_absolute() || file_path.components().count() != 1 {
        return Err("Output file name must not contain a path".to_string());
    }
    is_path_safe(directory)?;
    fs::create_dir_all(directory).map_err(|e| format!("Failed to create directory: {}", e))?;

    let stem = file_path
        .file_stem()
        .and_then(|value| value.to_str())
        .ok_or("Invalid output file name")?;
    let extension = file_path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("");

    for counter in 0..10_000_u32 {
        let candidate = if counter == 0 {
            file_name.clone()
        } else if extension.is_empty() {
            format!("{}_{}", stem, counter)
        } else {
            format!("{}_{}.{}", stem, counter, extension)
        };
        let output_path = directory.join(candidate);
        let mut output = match OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&output_path)
        {
            Ok(file) => file,
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(format!("Failed to create output file: {}", error)),
        };

        if let Err(error) = output.write_all(&bytes).and_then(|_| output.sync_all()) {
            drop(output);
            let _ = fs::remove_file(&output_path);
            return Err(format!("Failed to write output file: {}", error));
        }
        return Ok(output_path.to_string_lossy().into_owned());
    }

    Err("Unable to reserve a unique output file name".to_string())
}

#[derive(serde::Serialize)]
struct PairedFileWriteResult {
    first_path: String,
    second_path: String,
}

#[tauri::command]
fn write_unique_file_pair(
    directory: String,
    first_file_name: String,
    first_bytes: Vec<u8>,
    second_file_name: String,
    second_bytes: Vec<u8>,
) -> Result<PairedFileWriteResult, String> {
    use std::fs::{self, OpenOptions};
    use std::io::Write;
    use std::path::Path;

    const MAX_BYTES_PER_FILE: usize = 10 * 1024 * 1024;
    if directory.contains('\0')
        || first_file_name.contains('\0')
        || second_file_name.contains('\0')
        || first_bytes.len() > MAX_BYTES_PER_FILE
        || second_bytes.len() > MAX_BYTES_PER_FILE
    {
        return Err("Invalid paired output request".to_string());
    }
    let directory = Path::new(&directory);
    let first_path = Path::new(&first_file_name);
    let second_path = Path::new(&second_file_name);
    if first_file_name == second_file_name
        || first_path.is_absolute()
        || second_path.is_absolute()
        || first_path.components().count() != 1
        || second_path.components().count() != 1
    {
        return Err("Output file names must be distinct base names without paths".to_string());
    }
    is_path_safe(directory)?;
    fs::create_dir_all(directory)
        .map_err(|error| format!("Failed to create directory: {}", error))?;

    let first_stem = first_path
        .file_stem()
        .and_then(|value| value.to_str())
        .ok_or("Invalid first output name")?;
    let first_extension = first_path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("");
    let second_stem = second_path
        .file_stem()
        .and_then(|value| value.to_str())
        .ok_or("Invalid second output name")?;
    let second_extension = second_path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("");

    for counter in 0..10_000_u32 {
        let suffix = if counter == 0 {
            String::new()
        } else {
            format!("_{}", counter)
        };
        let first_name = if first_extension.is_empty() {
            format!("{}{}", first_stem, suffix)
        } else {
            format!("{}{}.{}", first_stem, suffix, first_extension)
        };
        let second_name = if second_extension.is_empty() {
            format!("{}{}", second_stem, suffix)
        } else {
            format!("{}{}.{}", second_stem, suffix, second_extension)
        };
        let first_output = directory.join(first_name);
        let second_output = directory.join(second_name);
        let mut first = match OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&first_output)
        {
            Ok(file) => file,
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => {
                return Err(format!(
                    "Failed to create refined subtitle output: {}",
                    error
                ))
            }
        };
        if let Err(error) = first.write_all(&first_bytes).and_then(|_| first.sync_all()) {
            drop(first);
            let _ = fs::remove_file(&first_output);
            return Err(format!(
                "Failed to write refined subtitle output: {}",
                error
            ));
        }
        drop(first);
        let mut second = match OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&second_output)
        {
            Ok(file) => file,
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                let _ = fs::remove_file(&first_output);
                continue;
            }
            Err(error) => {
                let _ = fs::remove_file(&first_output);
                return Err(format!("Failed to create refined text output: {}", error));
            }
        };
        if let Err(error) = second
            .write_all(&second_bytes)
            .and_then(|_| second.sync_all())
        {
            drop(second);
            let _ = fs::remove_file(&first_output);
            let _ = fs::remove_file(&second_output);
            return Err(format!("Failed to write refined text output: {}", error));
        }
        return Ok(PairedFileWriteResult {
            first_path: first_output.to_string_lossy().into_owned(),
            second_path: second_output.to_string_lossy().into_owned(),
        });
    }
    Err("Unable to reserve paired output file names".to_string())
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct MarkdownBundleAsset { file_name: String, bytes: Vec<u8> }

#[derive(serde::Serialize)]
struct MarkdownBundleResult { directory: String, markdown_path: String, asset_count: usize }

#[tauri::command]
fn export_markdown_bundle(output_root: String, base_name: String, markdown_bytes: Vec<u8>, assets: Vec<MarkdownBundleAsset>) -> Result<MarkdownBundleResult, String> {
    use std::io::Write;
    if output_root.trim().is_empty() || output_root.contains('\0') || markdown_bytes.len() > 20 * 1024 * 1024 || assets.len() > 100 { return Err("markdown:invalid-export".to_string()); }
    let root = std::path::PathBuf::from(output_root).join("Markdown"); is_path_safe(&root)?; std::fs::create_dir_all(&root).map_err(|_| "markdown:output-dir".to_string())?;
    let clean = base_name.trim().replace(['<','>','"','/','\\','|','?','*',':'], "-").trim_end_matches([' ','.']).to_string(); let clean = if clean.is_empty() { "toolknit-document".to_string() } else { clean.chars().take(80).collect::<String>() };
    let mut asset_names = std::collections::BTreeSet::new(); let mut asset_bytes = 0usize;
    for asset in &assets { if asset.file_name.is_empty() || asset.file_name.contains(['\\','/','\0']) || asset.file_name == "." || asset.file_name == ".." || asset.bytes.len() > 20 * 1024 * 1024 || !asset_names.insert(asset.file_name.clone()) { return Err("markdown:invalid-asset".to_string()); } asset_bytes = asset_bytes.checked_add(asset.bytes.len()).ok_or("markdown:invalid-assets")?; if asset_bytes > 100 * 1024 * 1024 { return Err("markdown:assets-too-large".to_string()); } }
    for index in 0..10_000_u32 {
        let suffix = if index == 0 { String::new() } else { format!("_{}", index) }; let directory = root.join(format!("{}{}", clean, suffix)); if directory.exists() { continue; }
        let temporary = root.join(format!(".{}.part.{}", clean, std::process::id())); let _ = std::fs::remove_dir_all(&temporary); std::fs::create_dir_all(temporary.join("assets")).map_err(|_| "markdown:temp-dir".to_string())?;
        let write_result = (|| -> Result<(), String> {
            let mut markdown = std::fs::File::create(temporary.join(format!("{}.md", clean))).map_err(|_| "markdown:write-failed".to_string())?; markdown.write_all(&markdown_bytes).map_err(|_| "markdown:write-failed".to_string())?; markdown.sync_all().map_err(|_| "markdown:write-failed".to_string())?;
            for asset in &assets { if asset.file_name.is_empty() || asset.file_name.contains(['\\','/','\0']) || asset.bytes.len() > 20 * 1024 * 1024 { return Err("markdown:invalid-asset".to_string()); } let path=temporary.join("assets").join(&asset.file_name); let mut file=std::fs::File::create(path).map_err(|_| "markdown:asset-write-failed".to_string())?; file.write_all(&asset.bytes).map_err(|_| "markdown:asset-write-failed".to_string())?; file.sync_all().map_err(|_| "markdown:asset-write-failed".to_string())?; }
            Ok(())
        })();
        if let Err(error) = write_result { let _=std::fs::remove_dir_all(&temporary); return Err(error); }
        match std::fs::rename(&temporary, &directory) { Ok(()) => return Ok(MarkdownBundleResult { markdown_path: directory.join(format!("{}.md", clean)).to_string_lossy().into_owned(), directory: directory.to_string_lossy().into_owned(), asset_count: assets.len() }), Err(_) => { let _=std::fs::remove_dir_all(&temporary); continue; } }
    }
    Err("markdown:publish-failed".to_string())
}

#[cfg(test)]
mod paired_file_write_tests {
    use super::*;

    fn test_directory() -> std::path::PathBuf {
        let suffix = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("clock must be after epoch")
            .as_nanos();
        let directory = std::env::temp_dir().join(format!("toolknit-paired-output-{}", suffix));
        std::fs::create_dir_all(&directory).expect("create test directory");
        directory
    }

    #[test]
    fn paired_write_uses_one_shared_unique_suffix_without_overwriting() {
        let directory = test_directory();
        let directory_string = directory.to_string_lossy().into_owned();

        let first = write_unique_file_pair(
            directory_string.clone(),
            "meeting_refined.srt".to_string(),
            b"first srt".to_vec(),
            "meeting_refined.txt".to_string(),
            b"first txt".to_vec(),
        )
        .expect("first pair should be written");
        let second = write_unique_file_pair(
            directory_string,
            "meeting_refined.srt".to_string(),
            b"second srt".to_vec(),
            "meeting_refined.txt".to_string(),
            b"second txt".to_vec(),
        )
        .expect("second pair should be uniquely written");

        assert!(first.first_path.ends_with("meeting_refined.srt"));
        assert!(first.second_path.ends_with("meeting_refined.txt"));
        assert!(second.first_path.ends_with("meeting_refined_1.srt"));
        assert!(second.second_path.ends_with("meeting_refined_1.txt"));
        assert_eq!(
            std::fs::read_to_string(&first.first_path).expect("read first SRT"),
            "first srt"
        );
        assert_eq!(
            std::fs::read_to_string(&second.second_path).expect("read second TXT"),
            "second txt"
        );

        std::fs::remove_dir_all(&directory).expect("remove test directory");
    }

    #[test]
    fn paired_write_rejects_paths_and_duplicate_file_names() {
        let directory = test_directory();
        let result = write_unique_file_pair(
            directory.to_string_lossy().into_owned(),
            "../unsafe.srt".to_string(),
            vec![],
            "unsafe.txt".to_string(),
            vec![],
        );
        assert!(result.is_err());

        let duplicate = write_unique_file_pair(
            directory.to_string_lossy().into_owned(),
            "same.txt".to_string(),
            vec![],
            "same.txt".to_string(),
            vec![],
        );
        assert!(duplicate.is_err());
        std::fs::remove_dir_all(&directory).expect("remove test directory");
    }
}

fn validate_icon_archive_file_name(file_name: &str) -> Result<(String, String), String> {
    if file_name.contains('\0') {
        return Err("Invalid icon archive file name".to_string());
    }
    let path = std::path::Path::new(file_name);
    if path.is_absolute() || path.components().count() != 1 {
        return Err("Icon archive file name must not contain a path".to_string());
    }
    let stem = path
        .file_stem()
        .and_then(|value| value.to_str())
        .ok_or("Invalid icon archive file name")?;
    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .ok_or("Icon archive file must use .zip")?;
    if stem.is_empty() || !extension.eq_ignore_ascii_case("zip") {
        return Err("Icon archive file must use .zip".to_string());
    }
    Ok((stem.to_string(), extension.to_string()))
}

fn unique_icon_archive_path(
    directory: &std::path::Path,
    file_name: &str,
    counter: u32,
) -> Result<std::path::PathBuf, String> {
    let (stem, extension) = validate_icon_archive_file_name(file_name)?;
    let candidate = if counter == 0 {
        format!("{}.{}", stem, extension)
    } else {
        format!("{}_{}.{}", stem, counter, extension)
    };
    Ok(directory.join(candidate))
}

#[tauri::command]
fn begin_icon_archive_write(directory: String, file_name: String) -> Result<u64, String> {
    if directory.contains('\0') {
        return Err("Invalid icon archive output directory".to_string());
    }
    validate_icon_archive_file_name(&file_name)?;
    let output_directory = std::path::PathBuf::from(directory);
    is_path_safe(&output_directory)?;
    std::fs::create_dir_all(&output_directory)
        .map_err(|error| format!("Failed to create icon output directory: {}", error))?;
    if !output_directory.is_dir() {
        return Err("Icon archive output path is not a directory".to_string());
    }
    let output_directory = output_directory
        .canonicalize()
        .map_err(|error| format!("Invalid icon output directory: {}", error))?;
    is_path_safe(&output_directory)?;

    for _ in 0..10_000 {
        let session_id = ICON_ARCHIVE_WRITE_ID.fetch_add(1, Ordering::SeqCst);
        let temporary_path = output_directory.join(format!(
            ".toolknit-icon-{}-{}.part",
            std::process::id(),
            session_id
        ));
        match std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary_path)
        {
            Ok(_) => {
                let write = IconArchiveWrite {
                    temporary_path,
                    output_directory,
                    file_name,
                };
                icon_archive_writes()
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner())
                    .insert(session_id, write);
                return Ok(session_id);
            }
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(format!("Failed to create icon archive: {}", error)),
        }
    }
    Err("Unable to reserve icon archive output".to_string())
}

#[tauri::command]
fn append_icon_archive_chunk(session_id: u64, bytes: Vec<u8>) -> Result<(), String> {
    use std::io::Write;

    if bytes.is_empty() {
        return Err("Icon archive chunk is empty".to_string());
    }
    let temporary_path = icon_archive_writes()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .get(&session_id)
        .map(|write| write.temporary_path.clone())
        .ok_or("Icon archive write session is unavailable")?;
    let current_size = std::fs::metadata(&temporary_path)
        .map_err(|error| format!("Cannot inspect icon archive: {}", error))?
        .len();
    let next_size = current_size
        .checked_add(bytes.len() as u64)
        .ok_or("Icon archive is too large")?;
    if next_size > MAX_ICON_ARCHIVE_BYTES {
        return Err("Icon archive exceeds the 32 MB limit".to_string());
    }
    let mut output = std::fs::OpenOptions::new()
        .append(true)
        .open(&temporary_path)
        .map_err(|error| format!("Cannot append icon archive: {}", error))?;
    output
        .write_all(&bytes)
        .map_err(|error| format!("Cannot write icon archive: {}", error))
}

#[tauri::command]
fn finalize_icon_archive_write(session_id: u64) -> Result<String, String> {
    let write = icon_archive_writes()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .remove(&session_id)
        .ok_or("Icon archive write session is unavailable")?;
    let result = (|| {
        let size = std::fs::metadata(&write.temporary_path)
            .map_err(|error| format!("Cannot inspect icon archive: {}", error))?
            .len();
        if size == 0 || size > MAX_ICON_ARCHIVE_BYTES {
            return Err("Icon archive has an invalid size".to_string());
        }
        for counter in 0..10_000_u32 {
            let output_path =
                unique_icon_archive_path(&write.output_directory, &write.file_name, counter)?;
            match std::fs::hard_link(&write.temporary_path, &output_path) {
                Ok(()) => return Ok(cleanup_display_path(&output_path)),
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
                Err(error) => return Err(format!("Cannot publish icon archive: {}", error)),
            }
        }
        Err("Unable to reserve a unique icon archive name".to_string())
    })();
    let _ = std::fs::remove_file(&write.temporary_path);
    result
}

#[tauri::command]
fn discard_icon_archive_write(session_id: u64) -> Result<(), String> {
    let write = icon_archive_writes()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .remove(&session_id)
        .ok_or("Icon archive write session is unavailable")?;
    std::fs::remove_file(&write.temporary_path)
        .map_err(|error| format!("Cannot discard icon archive: {}", error))
}

fn validate_pdf_enhance_file_name(file_name: &str) -> Result<String, String> {
    if file_name.contains('\0')
        || file_name.encode_utf16().count() > 240
        || file_name
            .chars()
            .any(|character| character.is_control() || "<>:\"/\\|?*".contains(character))
    {
        return Err("pdf-enhance:output-path".to_string());
    }
    let path = std::path::Path::new(file_name);
    if path.is_absolute() || path.components().count() != 1 {
        return Err("pdf-enhance:output-path".to_string());
    }
    let stem = path
        .file_stem()
        .and_then(|value| value.to_str())
        .filter(|value| !value.is_empty())
        .ok_or("pdf-enhance:output-path")?;
    let is_pdf = path
        .extension()
        .and_then(|value| value.to_str())
        .is_some_and(|value| value.eq_ignore_ascii_case("pdf"));
    if !is_pdf {
        return Err("pdf-enhance:output-path".to_string());
    }
    let normalized_stem = stem.trim_end_matches(['.', ' ']).to_ascii_uppercase();
    let is_reserved = matches!(
        normalized_stem.as_str(),
        "CON" | "PRN" | "AUX" | "NUL" | "CLOCK$"
    ) || (normalized_stem.len() == 4
        && (normalized_stem.starts_with("COM") || normalized_stem.starts_with("LPT"))
        && normalized_stem
            .as_bytes()
            .last()
            .copied()
            .is_some_and(|value| matches!(value, b'1'..=b'9')));
    if normalized_stem != stem.to_ascii_uppercase() || is_reserved {
        return Err("pdf-enhance:output-path".to_string());
    }
    Ok(stem.to_string())
}

fn unique_pdf_enhance_path(
    directory: &std::path::Path,
    file_name: &str,
    counter: u32,
) -> Result<std::path::PathBuf, String> {
    let stem = validate_pdf_enhance_file_name(file_name)?;
    let candidate = if counter == 0 {
        format!("{}.pdf", stem)
    } else {
        format!("{}_{}.pdf", stem, counter)
    };
    Ok(directory.join(candidate))
}

#[tauri::command]
fn begin_pdf_enhance_write(
    directory: String,
    file_name: String,
    expected_pages: u32,
) -> Result<u64, String> {
    if expected_pages == 0 || expected_pages > MAX_PDF_ENHANCE_PAGES {
        return Err("pdf-enhance:too-many-pages".to_string());
    }
    if directory.contains('\0') {
        return Err("pdf-enhance:output-path".to_string());
    }
    validate_pdf_enhance_file_name(&file_name)?;

    let output_directory = std::path::PathBuf::from(directory);
    is_path_safe(&output_directory).map_err(|_| "pdf-enhance:output-path".to_string())?;
    std::fs::create_dir_all(&output_directory)
        .map_err(|_| "pdf-enhance:output-path".to_string())?;
    if !output_directory.is_dir() {
        return Err("pdf-enhance:output-path".to_string());
    }
    let output_directory = output_directory
        .canonicalize()
        .map_err(|_| "pdf-enhance:output-path".to_string())?;
    is_path_safe(&output_directory).map_err(|_| "pdf-enhance:output-path".to_string())?;

    let mut writes = pdf_enhance_writes()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if writes.len() >= MAX_PDF_ENHANCE_WRITE_SESSIONS {
        return Err("pdf-enhance:enhancement-failed".to_string());
    }

    for _ in 0..10_000 {
        let session_id = PDF_ENHANCE_WRITE_ID.fetch_add(1, Ordering::SeqCst);
        let temporary_path = output_directory.join(format!(
            ".toolknit-pdf-enhance-{}-{}.part",
            std::process::id(),
            session_id
        ));
        match std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary_path)
        {
            Ok(file) => {
                writes.insert(
                    session_id,
                    PdfEnhanceWrite {
                        file,
                        temporary_path,
                        output_directory,
                        file_name,
                        expected_pages,
                        bytes_written: 0,
                    },
                );
                return Ok(session_id);
            }
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(_) => return Err("pdf-enhance:output-path".to_string()),
        }
    }
    Err("pdf-enhance:output-path".to_string())
}

#[tauri::command]
fn append_pdf_enhance_chunk(session_id: u64, bytes: Vec<u8>) -> Result<(), String> {
    use std::io::Write;

    if bytes.is_empty() {
        return Err("pdf-enhance:enhancement-failed".to_string());
    }
    let mut writes = pdf_enhance_writes()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let write = writes
        .get_mut(&session_id)
        .ok_or("pdf-enhance:enhancement-failed")?;
    let next_size = write
        .bytes_written
        .checked_add(bytes.len() as u64)
        .ok_or("pdf-enhance:output-too-large")?;
    if next_size > MAX_PDF_ENHANCE_OUTPUT_BYTES {
        return Err("pdf-enhance:output-too-large".to_string());
    }
    write
        .file
        .write_all(&bytes)
        .map_err(|_| "pdf-enhance:enhancement-failed".to_string())?;
    write.bytes_written = next_size;
    Ok(())
}

async fn validate_pdf_enhance_output(
    path: &std::path::Path,
    expected_pages: u32,
) -> Result<(), String> {
    let qpdf_path = get_qpdf_path().map_err(|_| "pdf-enhance:enhancement-failed".to_string())?;
    let qpdf_input_path = std::path::PathBuf::from(cleanup_display_path(path));
    let check_output = run_qpdf_with_stdin(
        &qpdf_path,
        &[
            std::ffi::OsString::from("--warning-exit-0"),
            std::ffi::OsString::from("--check"),
            qpdf_input_path.as_os_str().to_os_string(),
        ],
        None,
        false,
        "pdf-enhance:enhancement-failed",
    )
    .await?;
    if !check_output.status.success() {
        return Err("pdf-enhance:enhancement-failed".to_string());
    }

    let page_output = run_qpdf_with_stdin(
        &qpdf_path,
        &[
            std::ffi::OsString::from("--show-npages"),
            qpdf_input_path.as_os_str().to_os_string(),
        ],
        None,
        true,
        "pdf-enhance:enhancement-failed",
    )
    .await?;
    let page_count = String::from_utf8_lossy(&page_output.stdout)
        .trim()
        .parse::<u32>()
        .ok();
    if !page_output.status.success() || page_count != Some(expected_pages) {
        return Err("pdf-enhance:enhancement-failed".to_string());
    }
    Ok(())
}

fn publish_pdf_enhance_output(
    temporary_path: &std::path::Path,
    output_directory: &std::path::Path,
    file_name: &str,
) -> Result<String, String> {
    for counter in 0..10_000_u32 {
        let output_path = unique_pdf_enhance_path(output_directory, file_name, counter)?;
        #[cfg(target_os = "windows")]
        {
            use std::os::windows::ffi::OsStrExt;
            use windows::core::PCWSTR;
            use windows::Win32::Storage::FileSystem::{MoveFileExW, MOVE_FILE_FLAGS};

            let source_wide = temporary_path
                .as_os_str()
                .encode_wide()
                .chain(std::iter::once(0))
                .collect::<Vec<_>>();
            let output_wide = output_path
                .as_os_str()
                .encode_wide()
                .chain(std::iter::once(0))
                .collect::<Vec<_>>();
            let move_result = unsafe {
                MoveFileExW(
                    PCWSTR(source_wide.as_ptr()),
                    PCWSTR(output_wide.as_ptr()),
                    MOVE_FILE_FLAGS(0),
                )
            };
            match move_result {
                Ok(()) => return Ok(cleanup_display_path(&output_path)),
                Err(_) if output_path.exists() => continue,
                Err(_) => return Err("pdf-enhance:output-path".to_string()),
            }
        }
        #[cfg(not(target_os = "windows"))]
        {
            match std::fs::hard_link(temporary_path, &output_path) {
                Ok(()) => {
                    let _ = std::fs::remove_file(temporary_path);
                    return Ok(cleanup_display_path(&output_path));
                }
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
                Err(_) => return Err("pdf-enhance:output-path".to_string()),
            }
        }
    }
    Err("pdf-enhance:output-path".to_string())
}

#[tauri::command]
async fn finalize_pdf_enhance_write(session_id: u64) -> Result<String, String> {
    let write = pdf_enhance_writes()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .remove(&session_id)
        .ok_or("pdf-enhance:enhancement-failed")?;
    let PdfEnhanceWrite {
        file,
        temporary_path,
        output_directory,
        file_name,
        expected_pages,
        bytes_written,
    } = write;

    let sync_result = file.sync_all();
    drop(file);
    if bytes_written == 0 || bytes_written > MAX_PDF_ENHANCE_OUTPUT_BYTES || sync_result.is_err() {
        let _ = std::fs::remove_file(&temporary_path);
        return Err("pdf-enhance:enhancement-failed".to_string());
    }
    if let Err(error) = validate_pdf_enhance_output(&temporary_path, expected_pages).await {
        let _ = std::fs::remove_file(&temporary_path);
        return Err(error);
    }
    let result = publish_pdf_enhance_output(
        &temporary_path,
        &output_directory,
        &file_name,
    );
    if result.is_err() {
        let _ = std::fs::remove_file(&temporary_path);
    }
    result
}

#[tauri::command]
fn discard_pdf_enhance_write(session_id: u64) -> Result<(), String> {
    let write = pdf_enhance_writes()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .remove(&session_id)
        .ok_or("pdf-enhance:enhancement-failed")?;
    let temporary_path = write.temporary_path.clone();
    drop(write);
    match std::fs::remove_file(temporary_path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(_) => Err("pdf-enhance:enhancement-failed".to_string()),
    }
}

#[cfg(test)]
mod pdf_enhance_write_tests {
    use super::*;

    fn test_directory() -> std::path::PathBuf {
        let suffix = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("clock must be after epoch")
            .as_nanos();
        let directory = std::env::temp_dir().join(format!(
            "toolknit-pdf-enhance-write-{}-{}",
            std::process::id(),
            suffix
        ));
        std::fs::create_dir_all(&directory).expect("create PDF enhance test directory");
        directory
    }

    #[test]
    fn pdf_enhance_chunk_session_discards_partial_output() {
        let directory = test_directory();
        assert!(begin_pdf_enhance_write(
            directory.to_string_lossy().into_owned(),
            "stream:name.pdf".to_string(),
            1,
        )
        .is_err());
        assert!(begin_pdf_enhance_write(
            directory.to_string_lossy().into_owned(),
            "CON.pdf".to_string(),
            1,
        )
        .is_err());
        let session_id = begin_pdf_enhance_write(
            directory.to_string_lossy().into_owned(),
            "scan_enhanced.pdf".to_string(),
            1,
        )
        .expect("begin PDF enhance write");
        append_pdf_enhance_chunk(session_id, b"partial".to_vec())
            .expect("append PDF enhance chunk");
        let temporary_path = pdf_enhance_writes()
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .get(&session_id)
            .expect("PDF enhance write session")
            .temporary_path
            .clone();
        assert!(temporary_path.exists());
        discard_pdf_enhance_write(session_id).expect("discard PDF enhance write");
        assert!(!temporary_path.exists());
        assert!(!directory.join("scan_enhanced.pdf").exists());
        std::fs::remove_dir_all(directory).expect("remove PDF enhance test directory");
    }

    #[test]
    fn pdf_enhance_publish_never_overwrites_an_existing_file() {
        let directory = test_directory();
        let existing = directory.join("scan_enhanced.pdf");
        let temporary = directory.join(".validated.part");
        std::fs::write(&existing, b"existing").expect("write existing output");
        std::fs::write(&temporary, b"validated").expect("write validated output");
        let published = publish_pdf_enhance_output(
            &temporary,
            &directory,
            "scan_enhanced.pdf",
        )
        .expect("publish unique PDF enhance output");
        assert!(published.ends_with("scan_enhanced_1.pdf"));
        assert_eq!(std::fs::read(existing).expect("read existing output"), b"existing");
        assert_eq!(
            std::fs::read(&published).expect("read published output"),
            b"validated"
        );
        assert!(!temporary.exists());
        std::fs::remove_dir_all(directory).expect("remove PDF enhance test directory");
    }

    #[tokio::test]
    async fn pdf_enhance_validation_removes_invalid_staging_file() {
        if get_qpdf_path().is_err() {
            return;
        }
        let directory = test_directory();
        let session_id = begin_pdf_enhance_write(
            directory.to_string_lossy().into_owned(),
            "broken_enhanced.pdf".to_string(),
            1,
        )
        .expect("begin invalid PDF enhance write");
        append_pdf_enhance_chunk(session_id, b"%PDF-1.7\ninvalid".to_vec())
            .expect("append invalid PDF bytes");
        assert!(finalize_pdf_enhance_write(session_id).await.is_err());
        let entries = std::fs::read_dir(&directory)
            .expect("read PDF enhance test directory")
            .collect::<Result<Vec<_>, _>>()
            .expect("collect PDF enhance test entries");
        assert!(entries.is_empty());
        std::fs::remove_dir_all(directory).expect("remove PDF enhance test directory");
    }
}

#[tauri::command]
fn write_file_chunk(path: String, offset: u64, bytes: Vec<u8>) -> Result<(), String> {
    use std::fs::OpenOptions;
    use std::io::{Seek, SeekFrom, Write};
    is_path_safe(std::path::Path::new(&path))?;
    if let Some(parent) = std::path::Path::new(&path).parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create directory: {}", e))?;
    }
    let mut file = OpenOptions::new()
        .create(true)
        .write(true)
        .truncate(offset == 0)
        .open(&path)
        .map_err(|e| format!("Failed to open file: {}", e))?;
    if offset > 0 {
        file.seek(SeekFrom::Start(offset))
            .map_err(|e| format!("Failed to seek: {}", e))?;
    }
    file.write_all(&bytes)
        .map_err(|e| format!("Failed to write: {}", e))
}

#[tauri::command]
fn exists_path(path: String) -> Result<bool, String> {
    if path.contains('\0') {
        return Err("Invalid path".to_string());
    }
    Ok(std::path::Path::new(&path).exists())
}

#[tauri::command]
fn get_file_size(path: String) -> Result<u64, String> {
    if path.contains('\0') {
        return Err("Invalid path".to_string());
    }
    std::fs::metadata(&path)
        .map(|m| m.len())
        .map_err(|e| format!("Failed to read file metadata: {}", e))
}

#[cfg(target_os = "windows")]
const HARDWARE_PROVIDER_PREAMBLE: &str = r#"
$script:__tkProviderMap = @{}
$script:__tkDcomSession = $null
$script:__tkDcomAttempted = $false

function Get-ToolKnitRegistryInstance {
  param([string]$ClassName)
  switch ($ClassName) {
    'Win32_ComputerSystem' {
      $biosKey = 'HKLM:\HARDWARE\DESCRIPTION\System\BIOS'
      $p = Get-ItemProperty -Path $biosKey -ErrorAction SilentlyContinue
      if (-not $p) { return $null }
      $mfg = [string]$p.SystemManufacturer
      $model = [string]$p.SystemProductName
      if (-not $mfg -and -not $model) { return $null }
      return [PSCustomObject]@{ Manufacturer = $mfg; Model = $model; PCSystemType = $null; TotalPhysicalMemory = $null }
    }
    'Win32_OperatingSystem' {
      $key = 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion'
      $p = Get-ItemProperty -Path $key -ErrorAction SilentlyContinue
      if (-not $p) { return $null }
      $caption = [string]$p.ProductName
      if (-not $caption) { $caption = 'Windows' }
      $version = if ($p.DisplayVersion) { [string]$p.DisplayVersion } else { [string]$p.ReleaseId }
      return [PSCustomObject]@{
        Caption = $caption
        Version = $version
        BuildNumber = [string]$p.CurrentBuildNumber
        OSArchitecture = if ([Environment]::Is64BitOperatingSystem) { '64-bit' } else { '32-bit' }
        InstallDate = $null
        LastBootUpTime = $null
        FreePhysicalMemory = $null
        TotalVisibleMemorySize = $null
      }
    }
    'Win32_Processor' {
      $base = 'HKLM:\HARDWARE\DESCRIPTION\System\CentralProcessor'
      $subkeys = @(Get-ChildItem $base -ErrorAction SilentlyContinue)
      $p = Get-ItemProperty -Path "$base\0" -ErrorAction SilentlyContinue
      if (-not $p) { return $null }
      return [PSCustomObject]@{
        Name = [string]$p.ProcessorNameString
        Manufacturer = [string]$p.VendorIdentifier
        NumberOfCores = $null
        NumberOfLogicalProcessors = [int]$subkeys.Count
        VirtualizationFirmwareEnabled = $null
        SocketDesignation = 'CPU'
        AddressWidth = if ([Environment]::Is64BitOperatingSystem) { 64 } else { 32 }
        MaxClockSpeed = [int]$p.'~MHz'
        CurrentClockSpeed = [int]$p.'~MHz'
        L2CacheSize = $null
        L3CacheSize = $null
        VMMonitorModeExtensions = $null
        SecondLevelAddressTranslationExtensions = $null
        LoadPercentage = $null
      }
    }
    'Win32_BaseBoard' {
      $biosKey = 'HKLM:\HARDWARE\DESCRIPTION\System\BIOS'
      $p = Get-ItemProperty -Path $biosKey -ErrorAction SilentlyContinue
      if (-not $p -or (-not $p.BaseBoardProduct -and -not $p.BaseBoardManufacturer)) { return $null }
      return [PSCustomObject]@{ Manufacturer = [string]$p.BaseBoardManufacturer; Product = [string]$p.BaseBoardProduct; Version = [string]$p.BaseBoardVersion; Status = '' }
    }
    'Win32_BIOS' {
      $biosKey = 'HKLM:\HARDWARE\DESCRIPTION\System\BIOS'
      $p = Get-ItemProperty -Path $biosKey -ErrorAction SilentlyContinue
      if (-not $p) { return $null }
      $relDate = $null
      if ($p.BIOSReleaseDate) {
        try { $relDate = [DateTime]::ParseExact([string]$p.BIOSReleaseDate, 'MM/dd/yyyy', $null) } catch {}
      }
      return [PSCustomObject]@{ Manufacturer = [string]$p.BIOSVendor; SMBIOSBIOSVersion = [string]$p.BIOSVersion; ReleaseDate = $relDate; SMBIOSMajorVersion = $null; SMBIOSMinorVersion = $null }
    }
    default { return $null }
  }
}

function Get-ToolKnitInstance {
  param(
    [Parameter(Position=0)][string]$ClassName,
    [string]$Namespace = 'root\cimv2',
    [string]$Filter = $null
  )
  $key = "$($Namespace):$($ClassName)"
  $cimArgs = @{ ClassName = $ClassName; Namespace = $Namespace; ErrorAction = 'Stop' }
  if ($Filter) { $cimArgs.Filter = $Filter }

  if ($null -eq $script:__tkDcomSession -and -not $script:__tkDcomAttempted) {
    $script:__tkDcomAttempted = $true
    try {
      $opt = New-CimSessionOption -Protocol Dcom -ErrorAction Stop
      $script:__tkDcomSession = New-CimSession -ComputerName localhost -SessionOption $opt -ErrorAction Stop
    } catch {}
  }

  if ($null -ne $script:__tkDcomSession) {
    try {
      $items = @(Get-CimInstance -CimSession $script:__tkDcomSession @cimArgs)
      if ($items.Count -gt 0) { $script:__tkProviderMap[$key] = 'cim-dcom'; if ($items.Count -eq 1) { return $items[0] }; return $items }
    } catch {}
  }

  try {
    $items = @(Get-CimInstance @cimArgs)
    if ($items.Count -gt 0) { $script:__tkProviderMap[$key] = 'cim-wsman'; if ($items.Count -eq 1) { return $items[0] }; return $items }
  } catch {}

  try {
    if (Get-Command Get-WmiObject -ErrorAction SilentlyContinue) {
      $wmiArgs = @{ Class = $ClassName; Namespace = $Namespace; ErrorAction = 'Stop' }
      if ($Filter) { $wmiArgs.Filter = $Filter }
      $items = @(Get-WmiObject @wmiArgs)
      if ($items.Count -gt 0) { $script:__tkProviderMap[$key] = 'wmi'; if ($items.Count -eq 1) { return $items[0] }; return $items }
    }
  } catch {}

  try {
    $item = Get-ToolKnitRegistryInstance -ClassName $ClassName
    if ($null -ne $item) { $script:__tkProviderMap[$key] = 'registry'; return $item }
  } catch {}

  $script:__tkProviderMap[$key] = 'unavailable'
  return
}
"#;

#[cfg(target_os = "windows")]
const PROVIDER_ATTACH: &str = r#"
if ($script:__tkProviderMap -and $script:__tkProviderMap.Count -gt 0) {
  try {
    $__tk_obj = $__toolknit_payload | ConvertFrom-Json
    if ($__tk_obj -is [pscustomobject]) {
      $__tk_prov = [ordered]@{}
      foreach ($__tk_kv in $script:__tkProviderMap.GetEnumerator() | Sort-Object Key) { $__tk_prov[$__tk_kv.Key] = $__tk_kv.Value }
      $__tk_obj | Add-Member -NotePropertyName providers -NotePropertyValue $__tk_prov -Force
      $__toolknit_payload = $__tk_obj | ConvertTo-Json -Depth 8 -Compress
    }
  } catch {}
}
"#;

#[cfg(all(target_os = "windows", debug_assertions))]
fn append_hardware_debug(line: &str) {
    use std::io::Write;
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or(0);
    let path = std::env::temp_dir().join("toolknit-hardware-debug.log");
    if let Ok(mut file) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
    {
        let _ = writeln!(file, "[{}] {}", stamp, line);
    }
}

#[cfg(any(not(target_os = "windows"), not(debug_assertions)))]
fn append_hardware_debug(_line: &str) {}

#[cfg(target_os = "windows")]
fn run_windows_powershell_json(script: &str, context: &str) -> Result<serde_json::Value, String> {
    use std::os::windows::process::CommandExt;

    let provider_script = script.replace("Get-CimInstance", "Get-ToolKnitInstance");
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or(0);
    let out_path = std::env::temp_dir().join(format!(
        "toolknit-hw-out-{}-{}.txt",
        std::process::id(),
        stamp
    ));
    let err_path = std::env::temp_dir().join(format!(
        "toolknit-hw-err-{}-{}.txt",
        std::process::id(),
        stamp
    ));
    let cleanup_paths = || {
        let _ = std::fs::remove_file(&out_path);
        let _ = std::fs::remove_file(&err_path);
    };

    // Write the JSON payload to a temporary file instead of stdout. This avoids
    // fragile console/stdout encoding issues on some Windows builds, and lets us
    // capture a real exception message when the probe fails.
    let wrapped_script = format!(
        r#"
$ErrorActionPreference = 'Stop'
try {{
{0}
$__toolknit_payload = & {{
{1}
}}
if ($null -eq $__toolknit_payload) {{ $__toolknit_payload = '' }}
{2}
$__toolknit_text = ($__toolknit_payload | Out-String).Trim()
Set-Content -LiteralPath $env:TOOLKNIT_HW_OUT -Value ([string]$__toolknit_text) -Encoding UTF8
}} catch {{
Set-Content -LiteralPath $env:TOOLKNIT_HW_ERR -Value $_.Exception.ToString() -Encoding UTF8
exit 1
}}
"#,
        HARDWARE_PROVIDER_PREAMBLE,
        provider_script,
        PROVIDER_ATTACH,
    );

    let output = match std::process::Command::new("powershell.exe")
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-Command",
            &wrapped_script,
        ])
        .env("TOOLKNIT_HW_OUT", &out_path)
        .env("TOOLKNIT_HW_ERR", &err_path)
        .creation_flags(0x08000000)
        .output()
    {
        Ok(output) => output,
        Err(error) => {
            cleanup_paths();
            return Err(format!("Cannot start {}: {}", context, error));
        }
    };

    if !output.status.success() || !out_path.exists() {
        let err_text = std::fs::read_to_string(&err_path)
            .unwrap_or_default()
            .trim_start_matches('\u{FEFF}')
            .trim()
            .to_string();
        let err_flat = err_text.replace(['\r', '\n'], " ");
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        let exit = output.status.code().unwrap_or(-1);
        let detail = if !err_flat.is_empty() {
            format!(
                "exit={}; error={}",
                exit,
                err_flat.chars().take(700).collect::<String>()
            )
        } else if !stderr.is_empty() {
            format!("exit={}; stderr={}", exit, stderr.chars().take(480).collect::<String>())
        } else {
            format!("exit={}", exit)
        };
        append_hardware_debug(&format!(
            "{} | exit={} | error={} | stderr={}",
            context, exit, err_text, stderr
        ));
        cleanup_paths();
        return Err(format!("{} failed: {}", context, detail));
    }

    let payload = match std::fs::read_to_string(&out_path) {
        Ok(payload) => payload
            .trim_start_matches('\u{FEFF}')
            .trim()
            .to_string(),
        Err(error) => {
            cleanup_paths();
            return Err(format!("{} failed to read output: {}", context, error));
        }
    };
    cleanup_paths();

    if payload.is_empty() {
        append_hardware_debug(&format!("{} | returned no data", context));
        return Err(format!("{} returned no data", context));
    }
    serde_json::from_str(&payload).map_err(|error| {
        append_hardware_debug(&format!(
            "{} | invalid json: {} | payload={}",
            context, error, payload
        ));
        format!("{} returned invalid data: {}", context, error)
    })
}

#[tauri::command]
async fn get_hardware_overview() -> Result<serde_json::Value, String> {
    tokio::task::spawn_blocking(collect_hardware_overview)
        .await
        .map_err(|error| format!("Hardware inspection worker failed: {}", error))?
}

#[cfg(target_os = "windows")]
fn collect_hardware_overview() -> Result<serde_json::Value, String> {
    // A single read-only PowerShell/CIM request avoids a chain of WMI calls on
    // the UI thread. The payload deliberately excludes serial numbers, UUIDs,
    // account names, MAC addresses, and any other machine-identifying values.
    const SCRIPT: &str = r#"
$ErrorActionPreference = 'SilentlyContinue'
# Windows PowerShell 5.1 otherwise writes non-ASCII JSON using the active
# console code page. The Rust process correctly expects UTF-8 JSON.
function Epoch($value) {
  if ($null -eq $value) { return $null }
  try { return [long](($value).ToUniversalTime().Subtract([DateTime]'1970-01-01').TotalMilliseconds) } catch { return $null }
}
function DeviceType($value) {
  switch ([int]$value) {
    1 { 'desktop' }
    2 { 'laptop' }
    3 { 'workstation' }
    4 { 'server' }
    default { 'other' }
  }
}
$computer = Get-CimInstance Win32_ComputerSystem
$system = Get-CimInstance Win32_OperatingSystem
$cpu = Get-CimInstance Win32_Processor | Select-Object -First 1
$board = Get-CimInstance Win32_BaseBoard | Select-Object -First 1
$bios = Get-CimInstance Win32_BIOS | Select-Object -First 1
$gpus = @(Get-CimInstance Win32_VideoController | ForEach-Object {
  [ordered]@{ name = [string]$_.Name; driver_version = [string]$_.DriverVersion }
})
$disks = @(Get-CimInstance Win32_DiskDrive | ForEach-Object {
  [ordered]@{ model = [string]$_.Model; size_bytes = [Int64]$_.Size }
})
$volumes = @(Get-CimInstance Win32_LogicalDisk -Filter 'DriveType = 3' | ForEach-Object {
  [ordered]@{ id = [string]$_.DeviceID; size_bytes = [Int64]$_.Size; free_bytes = [Int64]$_.FreeSpace }
})
$secureBoot = 'unavailable'
try { if (Confirm-SecureBootUEFI) { $secureBoot = 'enabled' } else { $secureBoot = 'disabled' } } catch {}
$bootMode = if (Test-Path 'HKLM:\SYSTEM\CurrentControlSet\Control\SecureBoot\State') { 'uefi' } else { 'legacy_or_unavailable' }
$tpm = $null
try { $tpm = Get-Tpm } catch {}
$batteries = @(Get-CimInstance Win32_Battery)
[ordered]@{
  device = [ordered]@{
    manufacturer = [string]$computer.Manufacturer
    model = [string]$computer.Model
    device_type = DeviceType $computer.PCSystemType
  }
  system = [ordered]@{
    caption = [string]$system.Caption
    version = [string]$system.Version
    build = [string]$system.BuildNumber
    architecture = [string]$system.OSArchitecture
    install_at = Epoch $system.InstallDate
    boot_at = Epoch $system.LastBootUpTime
  }
  core = [ordered]@{
    cpu_name = [string]$cpu.Name
    cpu_cores = [int]$cpu.NumberOfCores
    cpu_threads = [int]$cpu.NumberOfLogicalProcessors
    memory_total_bytes = [Int64]$computer.TotalPhysicalMemory
    memory_available_bytes = [Int64]$system.FreePhysicalMemory * 1024
    gpus = $gpus
    disks = $disks
    volumes = $volumes
  }
  firmware = [ordered]@{
    mainboard = @([string]$board.Manufacturer, [string]$board.Product | Where-Object { $_ } ) -join ' '
    bios_version = [string]$bios.SMBIOSBIOSVersion
    bios_release_at = Epoch $bios.ReleaseDate
    boot_mode = $bootMode
    secure_boot = $secureBoot
    tpm_present = [bool]$tpm.TpmPresent
    tpm_ready = [bool]$tpm.TpmReady
    virtualization_enabled = [bool]$cpu.VirtualizationFirmwareEnabled
  }
  battery = [ordered]@{
    status = if ($batteries.Count -gt 0) { 'present' } else { 'not_detected' }
  }
} | ConvertTo-Json -Depth 6 -Compress
"#;

    run_windows_powershell_json(SCRIPT, "Windows hardware inspection")
}

#[cfg(not(target_os = "windows"))]
fn collect_hardware_overview() -> Result<serde_json::Value, String> {
    Err("Hardware inspection is currently available on Windows only".to_string())
}

#[tauri::command]
async fn get_cpu_memory_info() -> Result<serde_json::Value, String> {
    tokio::task::spawn_blocking(collect_cpu_memory_info)
        .await
        .map_err(|error| format!("CPU and memory inspection worker failed: {}", error))?
}

#[tauri::command]
async fn get_cpu_memory_live_stats() -> Result<serde_json::Value, String> {
    tokio::task::spawn_blocking(collect_cpu_memory_live_stats)
        .await
        .map_err(|error| format!("CPU and memory live stats worker failed: {}", error))?
}

#[cfg(target_os = "windows")]
fn collect_cpu_memory_info() -> Result<serde_json::Value, String> {
    // Keep identifiers private: memory serial numbers and physical addresses
    // are intentionally not read or included in this local-only payload.
    const SCRIPT: &str = r#"
$ErrorActionPreference = 'SilentlyContinue'
$cpu = Get-CimInstance Win32_Processor | Select-Object -First 1
$system = Get-CimInstance Win32_OperatingSystem
$memoryArray = Get-CimInstance Win32_PhysicalMemoryArray | Select-Object -First 1
$memoryModules = @(Get-CimInstance Win32_PhysicalMemory | ForEach-Object {
  [ordered]@{
    slot = [string]$_.DeviceLocator
    bank = [string]$_.BankLabel
    manufacturer = [string]$_.Manufacturer
    part_number = [string]$_.PartNumber
    capacity_bytes = [Int64]$_.Capacity
    speed_mhz = [int]$_.Speed
    configured_clock_mhz = [int]$_.ConfiguredClockSpeed
    smbios_memory_type = [int]$_.SMBIOSMemoryType
  }
})
$perfCpu = Get-CimInstance Win32_PerfFormattedData_PerfOS_Processor | Where-Object { $_.Name -eq '_Total' } | Select-Object -First 1
$perfMemory = Get-CimInstance Win32_PerfFormattedData_PerfOS_Memory | Select-Object -First 1
$cpuUsage = if ($null -ne $perfCpu -and $null -ne $perfCpu.PercentProcessorTime) { [int]$perfCpu.PercentProcessorTime } else { [int]$cpu.LoadPercentage }
$availableBytes = if ($null -ne $perfMemory -and $null -ne $perfMemory.AvailableBytes) { [Int64]$perfMemory.AvailableBytes } else { [Int64]$system.FreePhysicalMemory * 1024 }
[ordered]@{
  cpu = [ordered]@{
    name = [string]$cpu.Name
    manufacturer = [string]$cpu.Manufacturer
    socket = [string]$cpu.SocketDesignation
    address_width = [int]$cpu.AddressWidth
    cores = [int]$cpu.NumberOfCores
    threads = [int]$cpu.NumberOfLogicalProcessors
    max_clock_mhz = [int]$cpu.MaxClockSpeed
    current_clock_mhz = [int]$cpu.CurrentClockSpeed
    l2_cache_kb = [int]$cpu.L2CacheSize
    l3_cache_kb = [int]$cpu.L3CacheSize
    virtualization_firmware_enabled = [bool]$cpu.VirtualizationFirmwareEnabled
    vm_monitor_extensions = [bool]$cpu.VMMonitorModeExtensions
    slat_extensions = [bool]$cpu.SecondLevelAddressTranslationExtensions
  }
  memory = [ordered]@{
    total_bytes = [Int64]$system.TotalVisibleMemorySize * 1024
    available_bytes = $availableBytes
    slots_reported = [int]$memoryArray.MemoryDevices
    error_correction_code = [int]$memoryArray.MemoryErrorCorrection
    modules = $memoryModules
  }
  current = [ordered]@{
    cpu_usage_percent = $cpuUsage
    memory_available_bytes = $availableBytes
    committed_bytes = if ($null -ne $perfMemory) { [Int64]$perfMemory.CommittedBytes } else { 0 }
    commit_limit_bytes = if ($null -ne $perfMemory) { [Int64]$perfMemory.CommitLimit } else { 0 }
  }
} | ConvertTo-Json -Depth 6 -Compress
"#;

    run_windows_powershell_json(SCRIPT, "CPU and memory inspection")
}

#[cfg(target_os = "windows")]
fn collect_cpu_memory_live_stats() -> Result<serde_json::Value, String> {
    const SCRIPT: &str = r#"
$ErrorActionPreference = 'SilentlyContinue'
$cpu = Get-CimInstance Win32_Processor | Select-Object -First 1
$system = Get-CimInstance Win32_OperatingSystem
$perfCpu = Get-CimInstance Win32_PerfFormattedData_PerfOS_Processor | Where-Object { $_.Name -eq '_Total' } | Select-Object -First 1
$perfMemory = Get-CimInstance Win32_PerfFormattedData_PerfOS_Memory | Select-Object -First 1
[ordered]@{
  cpu_usage_percent = if ($null -ne $perfCpu -and $null -ne $perfCpu.PercentProcessorTime) { [int]$perfCpu.PercentProcessorTime } else { [int]$cpu.LoadPercentage }
  memory_available_bytes = if ($null -ne $perfMemory -and $null -ne $perfMemory.AvailableBytes) { [Int64]$perfMemory.AvailableBytes } else { [Int64]$system.FreePhysicalMemory * 1024 }
  committed_bytes = if ($null -ne $perfMemory) { [Int64]$perfMemory.CommittedBytes } else { 0 }
  commit_limit_bytes = if ($null -ne $perfMemory) { [Int64]$perfMemory.CommitLimit } else { 0 }
} | ConvertTo-Json -Compress
"#;

    run_windows_powershell_json(SCRIPT, "CPU and memory live stats")
}

#[cfg(not(target_os = "windows"))]
fn collect_cpu_memory_info() -> Result<serde_json::Value, String> {
    Err("CPU and memory inspection is currently available on Windows only".to_string())
}

#[cfg(not(target_os = "windows"))]
fn collect_cpu_memory_live_stats() -> Result<serde_json::Value, String> {
    Err("CPU and memory inspection is currently available on Windows only".to_string())
}

#[derive(serde::Serialize)]
struct DxgiAdapterInfo {
    description: String,
    vendor_id: u32,
    device_id: u32,
    dedicated_video_memory: u64,
    shared_system_memory: u64,
    flags: u32,
}

#[derive(serde::Serialize)]
struct ActiveDisplayConfiguration {
    adapter_name: String,
    device_name: String,
    monitor_key: String,
    width: u32,
    height: u32,
    refresh_hz: u32,
}

#[tauri::command]
async fn get_gpu_display_info() -> Result<serde_json::Value, String> {
    tokio::task::spawn_blocking(collect_gpu_display_info)
        .await
        .map_err(|error| format!("GPU and display inspection worker failed: {}", error))?
}

#[cfg(target_os = "windows")]
fn collect_gpu_display_info() -> Result<serde_json::Value, String> {
    // WMI supplies display EDID and driver metadata. DXGI and GDI below are
    // intentionally used for data WMI cannot represent correctly, especially
    // dedicated memory on modern GPUs and per-display refresh rates.
    const SCRIPT: &str = r#"
$ErrorActionPreference = 'SilentlyContinue'
function DecodeWmiText($values) {
  if ($null -eq $values) { return '' }
  return (($values | Where-Object { $_ -ne 0 } | ForEach-Object { [char]$_ }) -join '').Trim()
}
$gpus = @(Get-CimInstance Win32_VideoController | ForEach-Object {
  [ordered]@{
    name = [string]$_.Name
    video_processor = [string]$_.VideoProcessor
    driver_version = [string]$_.DriverVersion
    driver_date = if ($_.DriverDate) { ([DateTime]$_.DriverDate).ToString('yyyy-MM-dd') } else { '' }
  }
})
$basicByInstance = @{}
Get-CimInstance -Namespace root\wmi -ClassName WmiMonitorBasicDisplayParams | Where-Object { $_.Active } | ForEach-Object { $basicByInstance[$_.InstanceName] = $_ }
$connectionByInstance = @{}
Get-CimInstance -Namespace root\wmi -ClassName WmiMonitorConnectionParams | Where-Object { $_.Active } | ForEach-Object { $connectionByInstance[$_.InstanceName] = $_ }
$monitors = @(Get-CimInstance -Namespace root\wmi -ClassName WmiMonitorID | Where-Object { $_.Active } | ForEach-Object {
  $basic = $basicByInstance[$_.InstanceName]
  $connection = $connectionByInstance[$_.InstanceName]
  $displayKey = if ([string]$_.InstanceName -match 'DISPLAY\\([^\\]+)') { $Matches[1] } else { '' }
  [ordered]@{
    display_key = $displayKey
    manufacturer = DecodeWmiText $_.ManufacturerName
    model = DecodeWmiText $_.UserFriendlyName
    product_code = DecodeWmiText $_.ProductCodeID
    width_cm = if ($basic) { [int]$basic.MaxHorizontalImageSize } else { 0 }
    height_cm = if ($basic) { [int]$basic.MaxVerticalImageSize } else { 0 }
    connection_code = if ($null -ne $connection -and $null -ne $connection.VideoOutputTechnology) {
      try { [Int64]$connection.VideoOutputTechnology } catch { [Int64]-1 }
    } else { [Int64]-1 }
  }
})
[ordered]@{ gpus = $gpus; monitors = $monitors } | ConvertTo-Json -Depth 5 -Compress
"#;

    let mut value = run_windows_powershell_json(SCRIPT, "GPU and display inspection")?;
    let object = value
        .as_object_mut()
        .ok_or("GPU and display inspection returned an invalid payload")?;
    object.insert(
        "dxgi_adapters".to_string(),
        serde_json::to_value(enumerate_dxgi_adapters()).map_err(|error| error.to_string())?,
    );
    object.insert(
        "display_configurations".to_string(),
        serde_json::to_value(enumerate_active_displays()).map_err(|error| error.to_string())?,
    );
    Ok(value)
}

#[cfg(target_os = "windows")]
fn utf16z_to_string(value: &[u16]) -> String {
    let end = value
        .iter()
        .position(|character| *character == 0)
        .unwrap_or(value.len());
    String::from_utf16_lossy(&value[..end]).trim().to_string()
}

#[cfg(target_os = "windows")]
fn windows_display_match_key(value: &str) -> String {
    let uppercase = value.to_ascii_uppercase();
    for prefix in ["MONITOR\\", "DISPLAY\\", "MONITOR#", "DISPLAY#"] {
        if let Some(start) = uppercase.find(prefix) {
            let rest = &value[start + prefix.len()..];
            let end = rest
                .find(|character| character == '\\' || character == '#')
                .unwrap_or(rest.len());
            return rest[..end].trim().to_string();
        }
    }
    String::new()
}

#[cfg(target_os = "windows")]
fn enumerate_dxgi_adapters() -> Vec<DxgiAdapterInfo> {
    use windows::Win32::Graphics::Dxgi::{CreateDXGIFactory1, IDXGIFactory1, DXGI_ADAPTER_DESC1};

    let factory: IDXGIFactory1 = match unsafe { CreateDXGIFactory1() } {
        Ok(factory) => factory,
        Err(error) => {
            log::warn!("DXGI adapter enumeration is unavailable: {}", error);
            return Vec::new();
        }
    };
    let mut adapters = Vec::new();
    for index in 0..32_u32 {
        let adapter = match unsafe { factory.EnumAdapters1(index) } {
            Ok(adapter) => adapter,
            Err(_) => break,
        };
        let mut description = DXGI_ADAPTER_DESC1::default();
        if unsafe { adapter.GetDesc1(&mut description) }.is_err() {
            continue;
        }
        adapters.push(DxgiAdapterInfo {
            description: utf16z_to_string(&description.Description),
            vendor_id: description.VendorId,
            device_id: description.DeviceId,
            dedicated_video_memory: description.DedicatedVideoMemory as u64,
            shared_system_memory: description.SharedSystemMemory as u64,
            flags: description.Flags,
        });
    }
    adapters
}

#[cfg(target_os = "windows")]
fn enumerate_active_displays() -> Vec<ActiveDisplayConfiguration> {
    use windows::core::PCWSTR;
    use windows::Win32::Graphics::Gdi::{
        EnumDisplayDevicesW, EnumDisplaySettingsW, DEVMODEW, DISPLAY_DEVICEW,
        DISPLAY_DEVICE_ATTACHED_TO_DESKTOP, ENUM_CURRENT_SETTINGS,
    };

    let mut displays = Vec::new();
    for index in 0..32_u32 {
        let mut adapter = DISPLAY_DEVICEW::default();
        adapter.cb = std::mem::size_of::<DISPLAY_DEVICEW>() as u32;
        if !unsafe { EnumDisplayDevicesW(None, index, &mut adapter, 0) }.as_bool() {
            break;
        }
        if adapter.StateFlags & DISPLAY_DEVICE_ATTACHED_TO_DESKTOP == 0 {
            continue;
        }
        let mut mode = DEVMODEW::default();
        mode.dmSize = std::mem::size_of::<DEVMODEW>() as u16;
        if !unsafe {
            EnumDisplaySettingsW(
                PCWSTR(adapter.DeviceName.as_ptr()),
                ENUM_CURRENT_SETTINGS,
                &mut mode,
            )
        }
        .as_bool()
        {
            continue;
        }
        let mut monitor = DISPLAY_DEVICEW::default();
        monitor.cb = std::mem::size_of::<DISPLAY_DEVICEW>() as u32;
        let has_monitor =
            unsafe { EnumDisplayDevicesW(PCWSTR(adapter.DeviceName.as_ptr()), 0, &mut monitor, 0) }
                .as_bool();
        displays.push(ActiveDisplayConfiguration {
            adapter_name: utf16z_to_string(&adapter.DeviceString),
            device_name: utf16z_to_string(&adapter.DeviceName),
            monitor_key: if has_monitor {
                windows_display_match_key(&utf16z_to_string(&monitor.DeviceID))
            } else {
                String::new()
            },
            width: mode.dmPelsWidth,
            height: mode.dmPelsHeight,
            refresh_hz: mode.dmDisplayFrequency,
        });
    }
    displays
}

#[cfg(not(target_os = "windows"))]
fn collect_gpu_display_info() -> Result<serde_json::Value, String> {
    Err("GPU and display inspection is currently available on Windows only".to_string())
}

#[tauri::command]
async fn get_mainboard_firmware_info() -> Result<serde_json::Value, String> {
    tokio::task::spawn_blocking(collect_mainboard_firmware_info)
        .await
        .map_err(|error| format!("Mainboard and firmware inspection worker failed: {}", error))?
}

#[cfg(target_os = "windows")]
fn collect_mainboard_firmware_info() -> Result<serde_json::Value, String> {
    // This inventory intentionally leaves out board serial numbers, UUIDs,
    // PnP instance paths, and any other machine-identifying values. Windows
    // exposes PCI device names and status without needing those identifiers.
    const SCRIPT: &str = r#"
$ErrorActionPreference = 'SilentlyContinue'
function Epoch($value) {
  if ($null -eq $value) { return $null }
  try { return [long](($value).ToUniversalTime().Subtract([DateTime]'1970-01-01').TotalMilliseconds) } catch { return $null }
}
$board = Get-CimInstance Win32_BaseBoard | Select-Object -First 1
$bios = Get-CimInstance Win32_BIOS | Select-Object -First 1
$computer = Get-CimInstance Win32_ComputerSystem
$cpu = Get-CimInstance Win32_Processor | Select-Object -First 1
$enclosure = Get-CimInstance Win32_SystemEnclosure | Select-Object -First 1
$secureBoot = 'unavailable'
try { if (Confirm-SecureBootUEFI) { $secureBoot = 'enabled' } else { $secureBoot = 'disabled' } } catch {}
$bootMode = if (Test-Path 'HKLM:\SYSTEM\CurrentControlSet\Control\SecureBoot\State') { 'uefi' } else { 'legacy_or_unavailable' }
$tpm = $null
try { $tpm = Get-Tpm } catch {}
$rawPci = @(Get-CimInstance Win32_PnPEntity | Where-Object { $_.PNPDeviceID -like 'PCI\*' } | Sort-Object PNPClass, Name)
$pciDevices = @($rawPci | Group-Object { "$($_.PNPClass)`u001f$($_.Name)`u001f$($_.Manufacturer)`u001f$($_.Status)`u001f$($_.ConfigManagerErrorCode)" } | ForEach-Object {
  $sample = $_.Group | Select-Object -First 1
  [ordered]@{
    name = [string]$sample.Name
    manufacturer = [string]$sample.Manufacturer
    pnp_class = [string]$sample.PNPClass
    status = [string]$sample.Status
    problem_code = [int]$sample.ConfigManagerErrorCode
    count = [int]$_.Count
  }
} | Select-Object -First 40)
[ordered]@{
  board = [ordered]@{
    manufacturer = [string]$board.Manufacturer
    product = [string]$board.Product
    version = [string]$board.Version
    status = [string]$board.Status
  }
  firmware = [ordered]@{
    manufacturer = [string]$bios.Manufacturer
    bios_version = [string]$bios.SMBIOSBIOSVersion
    release_at = Epoch $bios.ReleaseDate
    smbios_major = [int]$bios.SMBIOSMajorVersion
    smbios_minor = [int]$bios.SMBIOSMinorVersion
    boot_mode = $bootMode
  }
  security = [ordered]@{
    secure_boot = $secureBoot
    tpm_present = [bool]$tpm.TpmPresent
    tpm_ready = [bool]$tpm.TpmReady
    tpm_manufacturer = ([string]$tpm.ManufacturerIdTxt).Trim([char]0)
    virtualization_enabled = [bool]$cpu.VirtualizationFirmwareEnabled
  }
  chassis = [ordered]@{
    types = @($enclosure.ChassisTypes | ForEach-Object { [int]$_ })
    manufacturer = [string]$computer.Manufacturer
    model = [string]$computer.Model
  }
  pci_devices = $pciDevices
} | ConvertTo-Json -Depth 6 -Compress
"#;

    run_windows_powershell_json(SCRIPT, "Mainboard and firmware inspection")
}

#[cfg(not(target_os = "windows"))]
fn collect_mainboard_firmware_info() -> Result<serde_json::Value, String> {
    Err("Mainboard and firmware inspection is currently available on Windows only".to_string())
}

#[tauri::command]
async fn get_storage_health_info() -> Result<serde_json::Value, String> {
    tokio::task::spawn_blocking(collect_storage_health_info)
        .await
        .map_err(|error| format!("Storage and health inspection worker failed: {}", error))?
}

#[cfg(target_os = "windows")]
fn collect_storage_health_info() -> Result<serde_json::Value, String> {
    // Storage serials and volume labels are deliberately excluded. The page
    // needs only non-identifying capacity, health, and reliability data.
    const SCRIPT: &str = r#"
$ErrorActionPreference = 'SilentlyContinue'
function MaybeInt($value) {
  if ($null -eq $value) { return $null }
  return [Int64]$value
}
$physicalDisks = @()
try { $physicalDisks = @(Get-PhysicalDisk) } catch {}
$physicalById = @{}
foreach ($physical in $physicalDisks) { $physicalById[[string]$physical.DeviceId] = $physical }
$reliabilityById = @{}
if ($physicalDisks.Count -gt 0) {
  foreach ($physical in $physicalDisks) {
    try { @(Get-StorageReliabilityCounter -PhysicalDisk $physical) | ForEach-Object {
      $reliabilityById[[string]$_.DeviceId] = $_
    } } catch {}
  }
}
$disks = @()
try { $disks = @(Get-Disk | ForEach-Object {
  $disk = $_
  $physical = $physicalById[[string]$disk.Number]
  if ($null -eq $physical) {
    $physical = $physicalDisks | Where-Object { $_.FriendlyName -eq $disk.FriendlyName } | Select-Object -First 1
  }
  $reliability = if ($physical) { $reliabilityById[[string]$physical.DeviceId] } else { $reliabilityById[[string]$disk.Number] }
  [ordered]@{
    number = [int]$disk.Number
    friendly_name = if ($physical) { [string]$physical.FriendlyName } else { [string]$disk.FriendlyName }
    media_type = if ($physical) { [string]$physical.MediaType } else { '' }
    bus_type = if ($physical) { [string]$physical.BusType } else { [string]$disk.BusType }
    size_bytes = [Int64]$disk.Size
    firmware_version = if ($physical) { [string]$physical.FirmwareVersion } else { '' }
    partition_style = [string]$disk.PartitionStyle
    health_status = if ($physical -and $physical.HealthStatus) { [string]$physical.HealthStatus } else { [string]$disk.HealthStatus }
    operational_status = if ($physical -and $physical.OperationalStatus) { @($physical.OperationalStatus) -join ', ' } else { @($disk.OperationalStatus) -join ', ' }
    is_system = [bool]$disk.IsSystem
    is_boot = [bool]$disk.IsBoot
    is_offline = [bool]$disk.IsOffline
    reliability = [ordered]@{
      temperature_c = if ($reliability -and $null -ne $reliability.Temperature) { MaybeInt $reliability.Temperature } else { $null }
      wear_percent = if ($reliability -and $null -ne $reliability.Wear) { MaybeInt $reliability.Wear } else { $null }
      power_on_hours = if ($reliability -and $null -ne $reliability.PowerOnHours) { MaybeInt $reliability.PowerOnHours } else { $null }
      read_errors_total = if ($reliability -and $null -ne $reliability.ReadErrorsTotal) { MaybeInt $reliability.ReadErrorsTotal } else { $null }
      write_errors_total = if ($reliability -and $null -ne $reliability.WriteErrorsTotal) { MaybeInt $reliability.WriteErrorsTotal } else { $null }
    }
  }
}) } catch {}
$volumes = @()
try { $volumes = @(Get-Volume | Where-Object { $_.DriveLetter -and $_.DriveType -eq 'Fixed' } | Sort-Object DriveLetter | ForEach-Object {
  [ordered]@{
    drive_letter = [string]$_.DriveLetter
    file_system = [string]$_.FileSystem
    size_bytes = [Int64]$_.Size
    free_bytes = [Int64]$_.SizeRemaining
    health_status = [string]$_.HealthStatus
  }
}) } catch {}
[ordered]@{ disks = $disks; volumes = $volumes } | ConvertTo-Json -Depth 6 -Compress
"#;

    run_windows_powershell_json(SCRIPT, "Storage and health inspection")
}

#[cfg(not(target_os = "windows"))]
fn collect_storage_health_info() -> Result<serde_json::Value, String> {
    Err("Storage and health inspection is currently available on Windows only".to_string())
}

#[tauri::command]
async fn get_network_devices_info() -> Result<serde_json::Value, String> {
    tokio::task::spawn_blocking(collect_network_devices_info)
        .await
        .map_err(|error| format!("Network and device inspection worker failed: {}", error))?
}

#[cfg(target_os = "windows")]
fn collect_network_devices_info() -> Result<serde_json::Value, String> {
    // Deliberately exclude addresses and identifiers: IP, MAC, Bluetooth
    // address, device instance path, and serial values do not help this page.
    const SCRIPT: &str = r#"
$ErrorActionPreference = 'SilentlyContinue'
function GroupDevices($items) {
  return @($items | Group-Object { "$($_.name)`u001f$($_.manufacturer)`u001f$($_.status)" } | ForEach-Object {
    $sample = $_.Group | Select-Object -First 1
    [ordered]@{
      name = [string]$sample.name
      manufacturer = [string]$sample.manufacturer
      status = [string]$sample.status
      count = [int]$_.Count
    }
  } | Select-Object -First 40)
}
$networkAdapters = @()
try { $networkAdapters = @(Get-NetAdapter -IncludeHidden | Where-Object { $_.Status -ne 'Not Present' } | ForEach-Object {
  [ordered]@{
    name = [string]$_.Name
    description = [string]$_.InterfaceDescription
    status = [string]$_.Status
    link_speed = [string]$_.LinkSpeed
    physical = [bool]$_.HardwareInterface
  }
}) } catch {}
$bluetoothRaw = @(Get-CimInstance Win32_PnPEntity | Where-Object {
  $_.PNPClass -eq 'Bluetooth' -and $_.Present -and $_.Name -notmatch '(?i)(service|profile|enumerator|rfcomm|服务|配置文件|枚举器)'
} | ForEach-Object { [ordered]@{ name = [string]$_.Name; manufacturer = [string]$_.Manufacturer; status = [string]$_.Status } })
$usbRaw = @(Get-CimInstance Win32_PnPEntity | Where-Object {
  $_.PNPClass -eq 'USB' -and $_.Present
} | ForEach-Object { [ordered]@{ name = [string]$_.Name; manufacturer = [string]$_.Manufacturer; status = [string]$_.Status } })
$cameraRaw = @(Get-CimInstance Win32_PnPEntity | Where-Object {
  $_.PNPClass -in @('Camera', 'Image') -and $_.Present
} | ForEach-Object { [ordered]@{ name = [string]$_.Name; manufacturer = [string]$_.Manufacturer; status = [string]$_.Status } })
$audioRaw = @(Get-CimInstance Win32_SoundDevice | ForEach-Object {
  [ordered]@{ name = [string]$_.Name; manufacturer = [string]$_.Manufacturer; status = [string]$_.Status }
})
[ordered]@{
  network_adapters = $networkAdapters
  bluetooth_devices = GroupDevices $bluetoothRaw
  audio_devices = GroupDevices $audioRaw
  usb_devices = GroupDevices $usbRaw
  cameras = GroupDevices $cameraRaw
} | ConvertTo-Json -Depth 6 -Compress
"#;

    run_windows_powershell_json(SCRIPT, "Network and device inspection")
}

#[cfg(not(target_os = "windows"))]
fn collect_network_devices_info() -> Result<serde_json::Value, String> {
    Err("Network and device inspection is currently available on Windows only".to_string())
}

#[tauri::command]
async fn get_power_sensors_info() -> Result<serde_json::Value, String> {
    tokio::task::spawn_blocking(collect_power_sensors_info)
        .await
        .map_err(|error| format!("Power and sensor inspection worker failed: {}", error))?
}

#[cfg(target_os = "windows")]
fn collect_power_sensors_info() -> Result<serde_json::Value, String> {
    // Battery serial numbers, power-plan GUIDs, and sensor instance paths are
    // deliberately omitted. This page only needs human-readable read-only data.
    const SCRIPT: &str = r#"
$ErrorActionPreference = 'SilentlyContinue'
function MaybeInt($value) {
  if ($null -eq $value) { return $null }
  return [Int64]$value
}
function MaybeFloat($value) {
  if ($null -eq $value) { return $null }
  return [double]$value
}
function CelsiusFromAcpi($value) {
  if ($null -eq $value -or [double]$value -le 0) { return $null }
  return [double]("{0:F1}" -f (([double]$value / 10.0) - 273.15))
}
function BatteryStatusName($value) {
  switch ([int]$value) {
    1 { 'other' }
    2 { 'unknown' }
    3 { 'fully_charged' }
    4 { 'low' }
    5 { 'critical' }
    6 { 'charging' }
    7 { 'charging_high' }
    8 { 'charging_low' }
    9 { 'charging_critical' }
    10 { 'undefined' }
    11 { 'partially_charged' }
    default { 'unknown' }
  }
}
$activePlan = Get-CimInstance -Namespace root\cimv2\power -ClassName Win32_PowerPlan | Where-Object { $_.IsActive } | Select-Object -First 1
$batteryStatic = @(Get-CimInstance -Namespace root\wmi -ClassName BatteryStaticData)
$batteryFull = @(Get-CimInstance -Namespace root\wmi -ClassName BatteryFullChargedCapacity)
$batteries = @(Get-CimInstance Win32_Battery)
$batteryItems = @()
for ($i = 0; $i -lt $batteries.Count; $i++) {
  $battery = $batteries[$i]
  $static = if ($i -lt $batteryStatic.Count) { $batteryStatic[$i] } else { $null }
  $full = if ($i -lt $batteryFull.Count) { $batteryFull[$i] } else { $null }
  $designCapacity = if ($static -and $null -ne $static.DesignedCapacity) { MaybeInt $static.DesignedCapacity } else { $null }
  $fullCapacity = if ($full -and $null -ne $full.FullChargedCapacity) { MaybeInt $full.FullChargedCapacity } else { $null }
  $health = if ($designCapacity -and $designCapacity -gt 0 -and $fullCapacity -and $fullCapacity -gt 0) { [int](($fullCapacity / $designCapacity) * 100 + 0.5) } else { $null }
  $batteryItems += [ordered]@{
    name = [string]$battery.Name
    status = BatteryStatusName $battery.BatteryStatus
    status_code = MaybeInt $battery.BatteryStatus
    charge_percent = MaybeInt $battery.EstimatedChargeRemaining
    estimated_run_time_min = if ($battery.EstimatedRunTime -and [int]$battery.EstimatedRunTime -lt 71582788) { MaybeInt $battery.EstimatedRunTime } else { $null }
    design_capacity_mwh = $designCapacity
    full_charge_capacity_mwh = $fullCapacity
    health_percent = $health
  }
}
$thermalZones = @(Get-CimInstance -Namespace root\wmi -ClassName MSAcpi_ThermalZoneTemperature | ForEach-Object -Begin { $zoneIndex = 0 } -Process {
  $zoneIndex += 1
  [ordered]@{
    name = "ACPI Thermal Zone $zoneIndex"
    source = 'acpi'
    current_c = CelsiusFromAcpi $_.CurrentTemperature
    critical_c = CelsiusFromAcpi $_.CriticalTripPoint
    passive_c = CelsiusFromAcpi $_.PassiveTripPoint
  }
})
$fans = @(Get-CimInstance Win32_Fan | ForEach-Object {
  [ordered]@{
    name = [string]$_.Name
    status = [string]$_.Status
    desired_speed_rpm = MaybeInt $_.DesiredSpeed
    active_cooling = if ($null -ne $_.ActiveCooling) { [bool]$_.ActiveCooling } else { $null }
  }
})
[ordered]@{
  power_plan = [ordered]@{
    name = if ($activePlan) { [string]$activePlan.ElementName } else { '' }
    caption = if ($activePlan) { [string]$activePlan.Caption } else { '' }
    active = [bool]($activePlan -and $activePlan.IsActive)
  }
  batteries = $batteryItems
  thermal_zones = $thermalZones
  fans = $fans
} | ConvertTo-Json -Depth 6 -Compress
"#;

    run_windows_powershell_json(SCRIPT, "Power and sensor inspection")
}

#[cfg(not(target_os = "windows"))]
fn collect_power_sensors_info() -> Result<serde_json::Value, String> {
    Err("Power and sensor inspection is currently available on Windows only".to_string())
}

#[tauri::command]
async fn scan_large_files(
    root_path: String,
    min_size_mb: Option<u64>,
    mode: Option<String>,
) -> Result<LargeFileScanResult, String> {
    tokio::task::spawn_blocking(move || collect_large_files(root_path, min_size_mb, mode))
        .await
        .map_err(|error| format!("Large file scan worker failed: {}", error))?
}

fn collect_large_files(
    root_path: String,
    min_size_mb: Option<u64>,
    mode: Option<String>,
) -> Result<LargeFileScanResult, String> {
    let root = canonical_scan_root(&root_path)?;
    let min_size_mb = min_size_mb.unwrap_or(50).clamp(10, 102_400);
    let min_size_bytes = min_size_mb.saturating_mul(1024 * 1024);
    let mode = normalize_large_file_mode(mode.as_deref());
    let mut scanned_files = 0_u64;
    let mut skipped_dirs = 0_u64;
    let mut candidates = Vec::new();
    let mut stack = vec![root.clone()];
    const MAX_SCAN_FILES: u64 = 250_000;
    const MAX_RESULTS: usize = 1200;

    while let Some(directory) = stack.pop() {
        if should_skip_cleanup_dir(&directory, &root) {
            skipped_dirs += 1;
            continue;
        }
        let entries = match std::fs::read_dir(&directory) {
            Ok(entries) => entries,
            Err(_) => {
                skipped_dirs += 1;
                continue;
            }
        };
        for entry in entries.flatten() {
            if scanned_files >= MAX_SCAN_FILES {
                break;
            }
            let path = entry.path();
            let metadata = match entry.metadata() {
                Ok(metadata) => metadata,
                Err(_) => continue,
            };
            if metadata.is_dir() {
                stack.push(path);
                continue;
            }
            if !metadata.is_file() {
                continue;
            }
            scanned_files += 1;
            let size_bytes = metadata.len();
            if size_bytes < min_size_bytes {
                continue;
            }
            let extension = path
                .extension()
                .and_then(|value| value.to_str())
                .unwrap_or("")
                .to_ascii_lowercase();
            let category = cleanup_file_category(&extension);
            if category == "other" || !cleanup_mode_allows(&mode, category) {
                continue;
            }
            let name = path
                .file_name()
                .and_then(|value| value.to_str())
                .unwrap_or("")
                .to_string();
            if name.is_empty() {
                continue;
            }
            let modified_at = metadata
                .modified()
                .ok()
                .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
                .and_then(|duration| i64::try_from(duration.as_millis()).ok());
            let (risk, local_reason) = cleanup_local_risk(&path, category, size_bytes);
            candidates.push(LargeFileCandidate {
                id: format!("lf-{}", candidates.len() + 1),
                path: cleanup_display_path(&path),
                name,
                extension,
                category: category.to_string(),
                size_bytes,
                modified_at,
                folder_hint: cleanup_folder_hint(&path, &root),
                risk,
                local_reason,
            });
            if candidates.len() >= MAX_RESULTS {
                break;
            }
        }
        if scanned_files >= MAX_SCAN_FILES || candidates.len() >= MAX_RESULTS {
            break;
        }
    }

    candidates.sort_by(|a, b| {
        b.size_bytes
            .cmp(&a.size_bytes)
            .then_with(|| a.name.cmp(&b.name))
    });
    let drive_space = cleanup_drive_space_from_path(&cleanup_display_path(&root))
        .ok()
        .flatten();
    Ok(LargeFileScanResult {
        root_path: cleanup_display_path(&root),
        min_size_bytes,
        mode,
        scanned_files,
        skipped_dirs,
        drive_space,
        candidates,
    })
}

#[tauri::command]
fn get_cleanup_drive_space(root_path: String) -> Result<Option<CleanupDriveSpace>, String> {
    cleanup_drive_space_from_path(&root_path)
}

#[cfg(target_os = "windows")]
fn cleanup_drive_space_from_path(root_path: &str) -> Result<Option<CleanupDriveSpace>, String> {
    use std::os::windows::process::CommandExt;

    if root_path.contains('\0') {
        return Err("Invalid drive path".to_string());
    }
    let Some(drive) = cleanup_drive_root_letter_from_input(root_path) else {
        return Ok(None);
    };
    let script = format!(
        r#"
$ErrorActionPreference = 'SilentlyContinue'
$disk = Get-CimInstance Win32_LogicalDisk -Filter "DeviceID='{}:'" | Select-Object -First 1
if ($null -ne $disk) {{
  [ordered]@{{ drive = '{}:\'; free_bytes = [Int64]$disk.FreeSpace; total_bytes = [Int64]$disk.Size }} | ConvertTo-Json -Compress
}}
"#,
        drive, drive
    );
    let output = std::process::Command::new("powershell.exe")
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-Command",
            &script,
        ])
        .creation_flags(0x08000000)
        .output()
        .map_err(|error| format!("Cannot read drive space: {}", error))?;
    if !output.status.success() {
        let details = String::from_utf8_lossy(&output.stderr)
            .trim()
            .replace(['\r', '\n'], " ");
        return Err(if details.is_empty() {
            "Cannot read drive space".to_string()
        } else {
            format!(
                "Cannot read drive space: {}",
                details.chars().take(240).collect::<String>()
            )
        });
    }
    let payload = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if payload.is_empty() {
        return Ok(None);
    }
    serde_json::from_str::<CleanupDriveSpace>(&payload)
        .map(Some)
        .map_err(|error| format!("Drive space returned invalid data: {}", error))
}

#[cfg(not(target_os = "windows"))]
fn cleanup_drive_space_from_path(_root_path: &str) -> Result<Option<CleanupDriveSpace>, String> {
    Ok(None)
}

#[cfg(target_os = "windows")]
fn cleanup_drive_root_letter_from_input(root_path: &str) -> Option<char> {
    let trimmed = root_path.trim();
    let without_verbatim = trimmed.strip_prefix(r"\\?\").unwrap_or(trimmed);
    let bytes = without_verbatim.as_bytes();
    if bytes.len() >= 2 && bytes[1] == b':' && bytes[0].is_ascii_alphabetic() {
        let rest = &without_verbatim[2..];
        if rest.is_empty() || rest.chars().all(|ch| ch == '\\' || ch == '/') {
            return Some((bytes[0] as char).to_ascii_uppercase());
        }
    }
    cleanup_drive_root_letter(std::path::Path::new(root_path))
}

fn canonical_scan_root(root_path: &str) -> Result<std::path::PathBuf, String> {
    if root_path.contains('\0') {
        return Err("Invalid scan folder".to_string());
    }
    let root = std::path::PathBuf::from(root_path)
        .canonicalize()
        .map_err(|error| format!("Cannot access scan folder: {}", error))?;
    if !root.is_dir() {
        return Err("Scan target must be a folder".to_string());
    }
    if is_broad_or_protected_cleanup_root(&root) {
        return Err("System drive root is blocked. Please choose a user folder such as Downloads, Desktop, Videos, or a project export folder.".to_string());
    }
    Ok(root)
}

fn normalize_large_file_mode(mode: Option<&str>) -> String {
    match mode.unwrap_or("video").to_ascii_lowercase().as_str() {
        "all" | "video" | "archives" | "installers" | "documents" | "images" | "audio"
        | "models" => mode.unwrap_or("video").to_ascii_lowercase(),
        _ => "video".to_string(),
    }
}

fn cleanup_file_category(extension: &str) -> &'static str {
    match extension {
        "mp4" | "mov" | "mkv" | "avi" | "webm" | "flv" | "m4v" | "wmv" | "ts" | "mpeg" | "mpg" => {
            "video"
        }
        "zip" | "rar" | "7z" | "tar" | "gz" | "bz2" | "xz" | "iso" => "archives",
        "exe" | "msi" | "msix" | "appx" => "installers",
        "pdf" | "ppt" | "pptx" | "doc" | "docx" | "xls" | "xlsx" | "csv" => "documents",
        "psd" | "ai" | "fig" | "raw" | "arw" | "cr2" | "nef" | "tif" | "tiff" | "png" | "jpg"
        | "jpeg" | "webp" | "bmp" => "images",
        "wav" | "flac" | "mp3" | "aac" | "m4a" | "ogg" | "wma" | "alac" => "audio",
        "gguf" | "safetensors" | "pth" | "pt" | "onnx" | "bin" | "ckpt" | "model" => "models",
        _ => "other",
    }
}

fn cleanup_mode_allows(mode: &str, category: &str) -> bool {
    mode == "all" || mode == category
}

fn is_broad_or_protected_cleanup_root(path: &std::path::Path) -> bool {
    let text = path.to_string_lossy().to_ascii_lowercase();
    #[cfg(target_os = "windows")]
    {
        if let Some(drive) = cleanup_drive_root_letter(path) {
            return drive == 'C';
        }
    }
    let mut normal_components = 0_usize;
    let mut has_root_or_prefix = false;
    for component in path.components() {
        match component {
            std::path::Component::Normal(_) => normal_components += 1,
            std::path::Component::Prefix(_) | std::path::Component::RootDir => {
                has_root_or_prefix = true
            }
            _ => {}
        }
    }
    if (has_root_or_prefix && normal_components == 0) || text == r"\" || text == "/" {
        return true;
    }
    protected_cleanup_dir_names(path).iter().any(|name| {
        matches!(
            name.as_str(),
            "windows"
                | "program files"
                | "program files (x86)"
                | "programdata"
                | "$recycle.bin"
                | "system volume information"
        )
    })
}

#[cfg(target_os = "windows")]
fn cleanup_drive_root_letter(path: &std::path::Path) -> Option<char> {
    let mut components = path.components();
    let drive = match components.next() {
        Some(std::path::Component::Prefix(prefix)) => match prefix.kind() {
            std::path::Prefix::Disk(letter) | std::path::Prefix::VerbatimDisk(letter) => {
                Some((letter as char).to_ascii_uppercase())
            }
            _ => None,
        },
        _ => None,
    }?;
    if !matches!(components.next(), Some(std::path::Component::RootDir)) {
        return None;
    }
    if components.next().is_some() {
        return None;
    }
    Some(drive)
}

fn cleanup_display_path(path: &std::path::Path) -> String {
    let text = path.to_string_lossy().into_owned();
    #[cfg(target_os = "windows")]
    {
        if let Some(rest) = text.strip_prefix(r"\\?\UNC\") {
            return format!(r"\\{}", rest);
        }
        if let Some(rest) = text.strip_prefix(r"\\?\") {
            return rest.to_string();
        }
    }
    text
}

fn protected_cleanup_dir_names(path: &std::path::Path) -> Vec<String> {
    path.components()
        .filter_map(|component| match component {
            std::path::Component::Normal(value) => {
                Some(value.to_string_lossy().to_ascii_lowercase())
            }
            _ => None,
        })
        .collect()
}

fn should_skip_cleanup_dir(path: &std::path::Path, root: &std::path::Path) -> bool {
    if path != root && is_broad_or_protected_cleanup_root(path) {
        return true;
    }
    let name = path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    matches!(
        name.as_str(),
        ".git"
            | "node_modules"
            | "target"
            | "dist"
            | "build"
            | ".venv"
            | "venv"
            | "__pycache__"
            | ".cache"
            | "cache"
            | "tmp"
            | "temp"
    )
}

fn cleanup_folder_hint(path: &std::path::Path, root: &std::path::Path) -> String {
    let parent = path.parent().unwrap_or(root);
    let relative = parent.strip_prefix(root).unwrap_or(parent);
    let hint = relative.to_string_lossy().trim().to_string();
    if hint.is_empty() || hint == "." {
        "selected folder".to_string()
    } else {
        hint
    }
}

fn cleanup_local_risk(path: &std::path::Path, category: &str, size_bytes: u64) -> (String, String) {
    let text = path.to_string_lossy().to_ascii_lowercase();
    let file_name = path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    if text.contains("\\wechat") || text.contains("\\xwechat") || text.contains("\\wxid_") {
        return (
            "high".to_string(),
            "聊天文件目录，默认不建议自动删除".to_string(),
        );
    }
    if text.contains("\\projects\\")
        || text.contains("\\source\\")
        || text.contains("\\repo")
        || text.contains("\\src\\")
    {
        return (
            "high".to_string(),
            "疑似项目或源码目录，需要人工确认".to_string(),
        );
    }
    if matches!(category, "models") {
        return (
            "high".to_string(),
            "模型或开发资源通常可重新下载但体积大，删除前需要确认".to_string(),
        );
    }
    if matches!(category, "installers" | "archives")
        && (text.contains("\\download") || text.contains("\\downloads") || text.contains("\\下载"))
    {
        return (
            "low".to_string(),
            "下载目录中的安装包或压缩包，通常适合清理".to_string(),
        );
    }
    if category == "video"
        && (file_name.contains("录屏")
            || file_name.contains("record")
            || file_name.contains("capture")
            || file_name.contains("temp"))
    {
        return ("low".to_string(), "疑似录屏、导出或临时视频".to_string());
    }
    if size_bytes >= 1024 * 1024 * 1024 {
        return (
            "medium".to_string(),
            "体积超过 1GB，建议优先人工确认用途".to_string(),
        );
    }
    (
        "medium".to_string(),
        "大文件候选项，需要结合用途确认".to_string(),
    )
}

#[tauri::command]
async fn move_files_to_recycle_bin(paths: Vec<String>) -> Result<RecycleBinMoveResult, String> {
    tokio::task::spawn_blocking(move || move_files_to_recycle_bin_blocking(paths))
        .await
        .map_err(|error| format!("Recycle bin worker failed: {}", error))?
}

#[cfg(target_os = "windows")]
fn move_files_to_recycle_bin_blocking(paths: Vec<String>) -> Result<RecycleBinMoveResult, String> {
    let mut items = Vec::new();
    let mut moved = 0_usize;
    let mut failed = 0_usize;
    let mut freed_bytes = 0_u64;

    for path in paths.into_iter().take(200) {
        if path.contains('\0') {
            failed += 1;
            items.push(RecycleBinMoveItem {
                path,
                ok: false,
                error: Some("Invalid file path".to_string()),
            });
            continue;
        }
        let canonical = match std::path::PathBuf::from(&path).canonicalize() {
            Ok(path) => path,
            Err(error) => {
                failed += 1;
                items.push(RecycleBinMoveItem {
                    path,
                    ok: false,
                    error: Some(format!("Cannot access file: {}", error)),
                });
                continue;
            }
        };
        let display_path = cleanup_display_path(&canonical);
        if !canonical.is_file() || is_broad_or_protected_cleanup_root(&canonical) {
            failed += 1;
            items.push(RecycleBinMoveItem {
                path: display_path,
                ok: false,
                error: Some(if canonical.is_file() {
                    "Protected file path is not allowed".to_string()
                } else {
                    "Target is not a regular file".to_string()
                }),
            });
            continue;
        }
        let size = std::fs::metadata(&canonical)
            .map(|metadata| metadata.len())
            .unwrap_or(0);
        match move_single_file_to_recycle_bin(&canonical) {
            Ok(()) if !canonical.exists() => {
                moved += 1;
                freed_bytes = freed_bytes.saturating_add(size);
                items.push(RecycleBinMoveItem {
                    path: display_path,
                    ok: true,
                    error: None,
                });
            }
            Ok(()) => {
                failed += 1;
                items.push(RecycleBinMoveItem {
                    path: display_path,
                    ok: false,
                    error: Some("Windows reported success, but the file still exists. It may be in use or blocked by permissions.".to_string()),
                });
            }
            Err(error) => {
                failed += 1;
                items.push(RecycleBinMoveItem {
                    path: display_path,
                    ok: false,
                    error: Some(error),
                });
            }
        }
    }

    Ok(RecycleBinMoveResult {
        requested: items.len(),
        moved,
        failed,
        freed_bytes,
        items,
    })
}

#[cfg(target_os = "windows")]
fn move_single_file_to_recycle_bin(path: &std::path::Path) -> Result<(), String> {
    use windows::core::PCWSTR;
    use windows::Win32::UI::Shell::{
        SHFileOperationW, FOF_ALLOWUNDO, FOF_NOCONFIRMATION, FOF_NOERRORUI, FOF_SILENT, FO_DELETE,
        SHFILEOPSTRUCTW,
    };

    // SHFileOperationW expects a double-null-terminated UTF-16 path list.
    // Use the display path instead of the canonical \\?\ form because the
    // legacy Shell operation is more reliable with normal absolute paths.
    let display_path = cleanup_display_path(path);
    let mut from: Vec<u16> = display_path.encode_utf16().collect();
    from.push(0);
    from.push(0);

    let mut operation = SHFILEOPSTRUCTW::default();
    operation.wFunc = FO_DELETE;
    operation.pFrom = PCWSTR(from.as_ptr());
    operation.fFlags =
        (FOF_ALLOWUNDO.0 | FOF_NOCONFIRMATION.0 | FOF_NOERRORUI.0 | FOF_SILENT.0) as u16;

    let result = unsafe { SHFileOperationW(&mut operation) };
    if result != 0 {
        return Err(format!(
            "Windows Recycle Bin API failed with code {}",
            result
        ));
    }
    if operation.fAnyOperationsAborted.as_bool() {
        return Err("Recycle bin operation was cancelled or blocked by Windows".to_string());
    }
    Ok(())
}

#[cfg(target_os = "windows")]
#[allow(dead_code)]
fn move_files_to_recycle_bin_blocking_powershell_fallback(
    paths: Vec<String>,
) -> Result<RecycleBinMoveResult, String> {
    use std::io::Write;
    use std::os::windows::process::CommandExt;

    let mut entries = Vec::new();
    let mut preflight_items = Vec::new();
    for path in paths.into_iter().take(200) {
        if path.contains('\0') {
            preflight_items.push(RecycleBinMoveItem {
                path,
                ok: false,
                error: Some("Invalid file path".to_string()),
            });
            continue;
        }
        let canonical = match std::path::PathBuf::from(&path).canonicalize() {
            Ok(path) => path,
            Err(error) => {
                preflight_items.push(RecycleBinMoveItem {
                    path,
                    ok: false,
                    error: Some(format!("Cannot access file: {}", error)),
                });
                continue;
            }
        };
        if !canonical.is_file() || is_broad_or_protected_cleanup_root(&canonical) {
            preflight_items.push(RecycleBinMoveItem {
                path: cleanup_display_path(&canonical),
                ok: false,
                error: Some(if canonical.is_file() {
                    "Protected file path is not allowed".to_string()
                } else {
                    "Target is not a regular file".to_string()
                }),
            });
            continue;
        }
        let size = std::fs::metadata(&canonical)
            .map(|metadata| metadata.len())
            .unwrap_or(0);
        entries.push(serde_json::json!({
            "path": cleanup_display_path(&canonical),
            "size": size
        }));
    }
    if entries.is_empty() {
        return Ok(RecycleBinMoveResult {
            requested: preflight_items.len(),
            moved: 0,
            failed: preflight_items.len(),
            freed_bytes: 0,
            items: preflight_items,
        });
    }
    let payload = serde_json::to_string(&entries).map_err(|error| error.to_string())?;
    const SCRIPT: &str = r#"
$ErrorActionPreference = 'SilentlyContinue'
$items = ConvertFrom-Json ([Console]::In.ReadToEnd())
Add-Type -AssemblyName Microsoft.VisualBasic
$ui = [Microsoft.VisualBasic.FileIO.UIOption]::OnlyErrorDialogs
$recycle = [Microsoft.VisualBasic.FileIO.RecycleOption]::SendToRecycleBin
$result = @()
foreach ($item in @($items)) {
  $path = [string]$item.path
  $ok = $false
  $err = $null
    try {
    if (Test-Path -LiteralPath $path -PathType Leaf) {
      [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile($path, $ui, $recycle)
      $ok = -not (Test-Path -LiteralPath $path -PathType Leaf)
      if (-not $ok -and -not $err) {
        $err = 'Windows did not move the file to the Recycle Bin. The file may be in use, protected, or blocked by permissions.'
      }
    } else {
      $err = 'File no longer exists'
    }
  } catch {
    $err = $_.Exception.Message
  }
  $result += [ordered]@{ path = $path; ok = [bool]$ok; error = $err; size = [Int64]$item.size }
}
$result | ConvertTo-Json -Depth 4 -Compress
"#;
    let mut child = std::process::Command::new("powershell.exe")
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-Command",
            SCRIPT,
        ])
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .creation_flags(0x08000000)
        .spawn()
        .map_err(|error| format!("Cannot start recycle bin operation: {}", error))?;
    if let Some(stdin) = child.stdin.as_mut() {
        stdin
            .write_all(payload.as_bytes())
            .map_err(|error| format!("Cannot send recycle bin payload: {}", error))?;
    }
    let output = child
        .wait_with_output()
        .map_err(|error| format!("Recycle bin operation failed: {}", error))?;
    if !output.status.success() {
        let details = String::from_utf8_lossy(&output.stderr)
            .trim()
            .replace(['\r', '\n'], " ");
        return Err(if details.is_empty() {
            "Recycle bin operation failed".to_string()
        } else {
            format!(
                "Recycle bin operation failed: {}",
                details.chars().take(240).collect::<String>()
            )
        });
    }
    let raw = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let parsed: serde_json::Value = serde_json::from_str(&raw)
        .map_err(|error| format!("Recycle bin operation returned invalid data: {}", error))?;
    let rows = match parsed {
        serde_json::Value::Array(rows) => rows,
        serde_json::Value::Object(_) => vec![parsed],
        _ => Vec::new(),
    };
    let mut moved = 0_usize;
    let mut failed = preflight_items.len();
    let mut freed_bytes = 0_u64;
    let mut items = preflight_items;
    for row in rows {
        let path = row
            .get("path")
            .and_then(|value| value.as_str())
            .unwrap_or("")
            .to_string();
        let ok = row
            .get("ok")
            .and_then(|value| value.as_bool())
            .unwrap_or(false);
        let size = row
            .get("size")
            .and_then(|value| value.as_u64())
            .unwrap_or(0);
        let error = row
            .get("error")
            .and_then(|value| value.as_str())
            .map(|value| value.to_string());
        if ok {
            moved += 1;
            freed_bytes = freed_bytes.saturating_add(size);
        } else {
            failed += 1;
        }
        items.push(RecycleBinMoveItem { path, ok, error });
    }
    Ok(RecycleBinMoveResult {
        requested: items.len(),
        moved,
        failed,
        freed_bytes,
        items,
    })
}

#[cfg(not(target_os = "windows"))]
fn move_files_to_recycle_bin_blocking(_paths: Vec<String>) -> Result<RecycleBinMoveResult, String> {
    Err("Recycle bin cleanup is currently available on Windows only".to_string())
}

#[cfg(test)]
mod cleanup_large_file_tests {
    use super::*;
    use std::io::Write;

    const MB: u64 = 1024 * 1024;

    fn cleanup_test_dir(label: &str) -> std::path::PathBuf {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("system clock")
            .as_nanos();
        let dir = std::env::temp_dir().join(format!(
            "toolknit-cleanup-{}-{}-{}",
            label,
            std::process::id(),
            nanos
        ));
        std::fs::create_dir_all(&dir).expect("create cleanup test dir");
        dir
    }

    fn make_sparse_file(path: &std::path::Path, size: u64) {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).expect("create file parent");
        }
        let mut file = std::fs::File::create(path).expect("create sparse file");
        file.write_all(b"toolknit").expect("seed sparse file");
        file.set_len(size).expect("resize sparse file");
    }

    #[test]
    fn cleanup_scan_filters_mode_and_skips_dependency_dirs() {
        let dir = cleanup_test_dir("mode-skip");
        make_sparse_file(&dir.join("screen-record.mp4"), 11 * MB);
        make_sparse_file(&dir.join("installer.zip"), 12 * MB);
        make_sparse_file(&dir.join("node_modules").join("cached-video.mp4"), 12 * MB);

        let result = collect_large_files(
            dir.to_string_lossy().into_owned(),
            Some(10),
            Some("video".to_string()),
        )
        .expect("scan video mode");

        assert_eq!(result.candidates.len(), 1);
        assert_eq!(result.candidates[0].name, "screen-record.mp4");
        assert_eq!(result.candidates[0].category, "video");
        assert!(result.skipped_dirs >= 1);

        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn cleanup_scan_all_keeps_supported_large_files_only() {
        let dir = cleanup_test_dir("all-supported");
        make_sparse_file(&dir.join("backup.iso"), 11 * MB);
        make_sparse_file(&dir.join("notes.tmp"), 12 * MB);
        make_sparse_file(&dir.join("report.pdf"), 13 * MB);

        let result = collect_large_files(
            dir.to_string_lossy().into_owned(),
            Some(10),
            Some("all".to_string()),
        )
        .expect("scan all mode");
        let names: Vec<_> = result
            .candidates
            .iter()
            .map(|item| item.name.as_str())
            .collect();

        assert!(names.contains(&"backup.iso"));
        assert!(names.contains(&"report.pdf"));
        assert!(!names.contains(&"notes.tmp"));

        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn cleanup_scan_rejects_system_drive_root_only() {
        #[cfg(target_os = "windows")]
        {
            assert!(is_broad_or_protected_cleanup_root(std::path::Path::new(
                "C:\\"
            )));
            assert!(!is_broad_or_protected_cleanup_root(std::path::Path::new(
                "D:\\"
            )));
            let error =
                match collect_large_files("C:\\".to_string(), Some(10), Some("all".to_string())) {
                    Ok(_) => panic!("system drive root should be rejected"),
                    Err(error) => error,
                };
            assert!(error.contains("System drive root is blocked"));
        }
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn cleanup_recycle_bin_moves_temp_file() {
        let dir = cleanup_test_dir("recycle");
        let file_path = dir.join("delete-me.tmp");
        make_sparse_file(&file_path, 1024);

        let result =
            move_files_to_recycle_bin_blocking(vec![file_path.to_string_lossy().into_owned()])
                .expect("move temp file to recycle bin");

        assert_eq!(result.requested, 1);
        assert_eq!(result.moved, 1);
        assert_eq!(result.failed, 0);
        assert!(!file_path.exists());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn cleanup_recycle_bin_moves_unicode_video_file() {
        let dir = cleanup_test_dir("recycle-unicode");
        let file_path = dir.join("error [レッドゾーン] (1080p_60fps_H264-128kbit_AAC).mp4");
        make_sparse_file(&file_path, 1024);

        let result =
            move_files_to_recycle_bin_blocking(vec![file_path.to_string_lossy().into_owned()])
                .expect("move unicode video file to recycle bin");

        assert_eq!(result.requested, 1);
        assert_eq!(
            result.moved,
            1,
            "items: {}",
            serde_json::to_string(&result.items).unwrap()
        );
        assert_eq!(result.failed, 0);
        assert!(!file_path.exists());
        let _ = std::fs::remove_dir_all(dir);
    }
}

const PPT_RENDER_MAX_INPUT_BYTES: u64 = 200 * 1024 * 1024;
const PPT_RENDER_MAX_SLIDES: usize = 500;

#[derive(Clone, Debug)]
struct PptRenderInput {
    path: std::path::PathBuf,
    name: String,
    bytes: u64,
    slide_count: usize,
}

#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct LibreOfficeRuntimeInfo {
    available: bool,
    command: Option<String>,
    source: Option<String>,
    version: Option<String>,
    message: Option<String>,
}

#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct PptToPdfResult {
    tool: String,
    source_name: String,
    input_path: String,
    input_bytes: u64,
    renderer: LibreOfficeRuntimeInfo,
    slide_count: usize,
    page_count: usize,
    page_count_matches_slides: bool,
    output_dir: String,
    output_path: String,
    output_file: String,
    output_bytes: u64,
    manifest_path: String,
    warnings: Vec<String>,
}

fn normalize_zip_entry_name(value: &str) -> String {
    value
        .replace('\\', "/")
        .trim_start_matches('/')
        .split('/')
        .filter(|part| !part.is_empty() && *part != ".")
        .collect::<Vec<_>>()
        .join("/")
}

fn pptx_central_directory_entries(bytes: &[u8]) -> Vec<String> {
    let mut entries = Vec::new();
    let mut index = 0usize;
    while index + 46 <= bytes.len() {
        if &bytes[index..index + 4] != b"PK\x01\x02" {
            index += 1;
            continue;
        }
        let file_name_len = u16::from_le_bytes([bytes[index + 28], bytes[index + 29]]) as usize;
        let extra_len = u16::from_le_bytes([bytes[index + 30], bytes[index + 31]]) as usize;
        let comment_len = u16::from_le_bytes([bytes[index + 32], bytes[index + 33]]) as usize;
        let name_start = index + 46;
        let name_end = name_start.saturating_add(file_name_len);
        let next = name_end
            .saturating_add(extra_len)
            .saturating_add(comment_len);
        if name_end <= bytes.len() && next <= bytes.len() {
            let name = String::from_utf8_lossy(&bytes[name_start..name_end]);
            let normalized = normalize_zip_entry_name(&name);
            if !normalized.is_empty() && !normalized.split('/').any(|part| part == "..") {
                entries.push(normalized);
            }
            index = next;
        } else {
            index += 4;
        }
    }
    entries
}

fn pptx_entry_eq(entry: &str, expected: &str) -> bool {
    entry.eq_ignore_ascii_case(expected)
}

fn is_pptx_slide_entry(entry: &str) -> bool {
    let lower = entry.to_ascii_lowercase();
    let Some(number) = lower
        .strip_prefix("ppt/slides/slide")
        .and_then(|value| value.strip_suffix(".xml"))
    else {
        return false;
    };
    !number.is_empty() && number.bytes().all(|byte| byte.is_ascii_digit())
}

fn sanitize_ppt_render_base_name(value: &str) -> String {
    let file_name = std::path::Path::new(value)
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("presentation.pptx");
    let stem = std::path::Path::new(file_name)
        .file_stem()
        .and_then(|name| name.to_str())
        .unwrap_or("presentation");
    let mut result = String::new();
    let mut previous_was_underscore = false;
    for character in stem.chars() {
        let invalid = matches!(
            character,
            '\\' | '/' | ':' | '*' | '?' | '"' | '<' | '>' | '|' | '\0'..='\u{1f}'
        );
        let next = if invalid || character.is_whitespace() {
            '_'
        } else {
            character
        };
        if next == '_' {
            if previous_was_underscore {
                continue;
            }
            previous_was_underscore = true;
        } else {
            previous_was_underscore = false;
        }
        result.push(next);
        if result.chars().count() >= 80 {
            break;
        }
    }
    let trimmed = result.trim_matches(|character| character == '.' || character == '_');
    let reserved = matches!(
        trimmed.to_ascii_lowercase().as_str(),
        "con"
            | "prn"
            | "aux"
            | "nul"
            | "com1"
            | "com2"
            | "com3"
            | "com4"
            | "com5"
            | "com6"
            | "com7"
            | "com8"
            | "com9"
            | "lpt1"
            | "lpt2"
            | "lpt3"
            | "lpt4"
            | "lpt5"
            | "lpt6"
            | "lpt7"
            | "lpt8"
            | "lpt9"
    );
    if trimmed.is_empty() || reserved {
        "presentation".to_string()
    } else {
        trimmed.to_string()
    }
}

fn inspect_ppt_render_input(input_path: &str) -> Result<PptRenderInput, String> {
    if input_path.trim().is_empty() || input_path.contains('\0') {
        return Err("ppt-render:invalid-input".to_string());
    }
    let requested = std::path::PathBuf::from(input_path);
    let extension = requested
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    if extension != "pptx" {
        return Err("ppt-render:invalid-extension".to_string());
    }
    let metadata = std::fs::symlink_metadata(&requested)
        .map_err(|_| "ppt-render:input-not-found".to_string())?;
    if metadata.file_type().is_symlink() || !metadata.is_file() || metadata.len() == 0 {
        return Err("ppt-render:invalid-input".to_string());
    }
    if metadata.len() > PPT_RENDER_MAX_INPUT_BYTES {
        return Err("ppt-render:input-too-large".to_string());
    }
    let path = requested
        .canonicalize()
        .map_err(|_| "ppt-render:invalid-input".to_string())?;
    let name = path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("presentation.pptx")
        .to_string();
    let bytes = std::fs::read(&path).map_err(|_| "ppt-render:read-failed".to_string())?;
    if bytes.len() < 4 || bytes[0] != 0x50 || bytes[1] != 0x4b {
        return Err("ppt-render:invalid-pptx".to_string());
    }
    let entries = pptx_central_directory_entries(&bytes);
    if !entries
        .iter()
        .any(|entry| pptx_entry_eq(entry, "[Content_Types].xml"))
        || !entries
            .iter()
            .any(|entry| pptx_entry_eq(entry, "ppt/presentation.xml"))
    {
        return Err("ppt-render:invalid-pptx".to_string());
    }
    let slide_count = entries
        .iter()
        .filter(|entry| is_pptx_slide_entry(entry))
        .count();
    if slide_count == 0 {
        return Err("ppt-render:empty-ppt".to_string());
    }
    if slide_count > PPT_RENDER_MAX_SLIDES {
        return Err("ppt-render:too-many-slides".to_string());
    }
    Ok(PptRenderInput {
        path,
        name,
        bytes: metadata.len(),
        slide_count,
    })
}

fn ppt_render_output_parent(output_dir: &str) -> Result<std::path::PathBuf, String> {
    validate_image_output_dir(output_dir).map_err(|_| "ppt-render:output-path".to_string())
}

fn unique_ppt_render_output_dir(
    parent: &std::path::Path,
    base_name: &str,
    suffix_name: &str,
) -> Result<std::path::PathBuf, String> {
    let base = sanitize_ppt_render_base_name(base_name);
    for counter in 0..10_000_u32 {
        let suffix = if counter == 0 {
            String::new()
        } else {
            format!("_{}", counter)
        };
        let candidate = parent.join(format!("{}_{}{}", base, suffix_name, suffix));
        match std::fs::symlink_metadata(&candidate) {
            Ok(_) => continue,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(candidate),
            Err(_) => return Err("ppt-render:output-path".to_string()),
        }
    }
    Err("ppt-render:output-path".to_string())
}

fn create_ppt_render_temp_dir(parent: &std::path::Path) -> Result<std::path::PathBuf, String> {
    for _ in 0..10_000 {
        let counter = PPT_RENDER_TEMP_ID.fetch_add(1, Ordering::SeqCst);
        let candidate = parent.join(format!(
            ".toolknit-ppt-render-{}-{}",
            std::process::id(),
            counter
        ));
        match std::fs::create_dir(&candidate) {
            Ok(()) => return Ok(candidate),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(_) => return Err("ppt-render:output-path".to_string()),
        }
    }
    Err("ppt-render:output-path".to_string())
}

fn shell_path_candidates_from_path_env(file_names: &[&str]) -> Vec<std::path::PathBuf> {
    std::env::var_os("PATH")
        .map(|value| {
            std::env::split_paths(&value)
                .flat_map(|directory| file_names.iter().map(move |name| directory.join(name)))
                .collect()
        })
        .unwrap_or_default()
}

fn libreoffice_candidates() -> Vec<(std::path::PathBuf, &'static str)> {
    let exe_name = if cfg!(target_os = "windows") {
        "soffice.com"
    } else {
        "soffice"
    };
    let mut candidates = Vec::new();
    if let Ok(value) = std::env::var("TOOLKNIT_LIBREOFFICE_PATH") {
        if !value.trim().is_empty() && !value.contains('\0') {
            candidates.push((
                std::path::PathBuf::from(value),
                "env:TOOLKNIT_LIBREOFFICE_PATH",
            ));
        }
    }
    if let Ok(managed) = libreoffice_runtime_path() {
        candidates.push((managed, "managed"));
    }
    #[cfg(target_os = "windows")]
    {
        for key in ["ProgramFiles", "ProgramFiles(x86)"] {
            if let Ok(root) = std::env::var(key) {
                let directory = std::path::PathBuf::from(root)
                    .join("LibreOffice")
                    .join("program");
                candidates.push((directory.join("soffice.com"), "windows-install"));
                candidates.push((directory.join("soffice.exe"), "windows-install"));
            }
        }
    }
    if let Ok(current_dir) = std::env::current_dir() {
        for ancestor in current_dir.ancestors().take(6) {
            candidates.push((
                ancestor
                    .join("_research")
                    .join("runtime-cache")
                    .join("libreoffice-26.2.5")
                    .join("program")
                    .join(exe_name),
                "dev-runtime-cache",
            ));
            if let Some(parent) = ancestor.parent() {
                candidates.push((
                    parent
                        .join("_research")
                        .join("runtime-cache")
                        .join("libreoffice-26.2.5")
                        .join("program")
                        .join(exe_name),
                    "dev-runtime-cache",
                ));
            }
        }
    }
    if let Ok(current_exe) = std::env::current_exe() {
        for ancestor in current_exe.ancestors().take(8) {
            candidates.push((
                ancestor
                    .join("_research")
                    .join("runtime-cache")
                    .join("libreoffice-26.2.5")
                    .join("program")
                    .join(exe_name),
                "dev-runtime-cache",
            ));
        }
    }
    #[cfg(target_os = "windows")]
    {
        candidates.extend(
            shell_path_candidates_from_path_env(&["soffice.com", "soffice.exe"])
                .into_iter()
                .map(|path| (path, "PATH")),
        );
    }
    #[cfg(not(target_os = "windows"))]
    {
        candidates.extend(
            shell_path_candidates_from_path_env(&["soffice", "libreoffice"])
                .into_iter()
                .map(|path| (path, "PATH")),
        );
    }
    let mut seen = std::collections::BTreeSet::new();
    candidates
        .into_iter()
        .filter(|(path, _)| {
            let key = path.to_string_lossy().to_ascii_lowercase();
            if seen.contains(&key) {
                return false;
            }
            seen.insert(key)
        })
        .collect()
}

fn probe_libreoffice(
    path: &std::path::Path,
    source: &'static str,
) -> Option<LibreOfficeRuntimeInfo> {
    let metadata = std::fs::metadata(path).ok()?;
    if !metadata.is_file() {
        return None;
    }
    // Isolate the probe into a throwaway profile. LibreOffice can block on the
    // default profile lock, and the desktop app plus the CLI can probe
    // concurrently from separate processes; a shared profile makes `--version`
    // hang (LibreOffice then relaunches itself in safe mode) and leaves
    // orphaned soffice workers behind.
    let profile_dir = std::env::temp_dir().join(format!(
        "toolknit-lo-probe-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|duration| duration.as_nanos())
            .unwrap_or(0)
    ));
    let _ = std::fs::create_dir_all(&profile_dir);
    let mut command = std::process::Command::new(path);
    command
        .arg(format!(
            "-env:UserInstallation={}",
            file_url_for_libreoffice(&profile_dir)
        ))
        .arg("--version")
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    let mut child = command.spawn().ok()?;
    let child_id = child.id();
    let started_at = std::time::Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) => {
                if started_at.elapsed().as_millis() >= PPT_RENDER_PROBE_TIMEOUT_MS {
                    terminate_conversion_process(child_id);
                    let _ = child.wait();
                    let _ = std::fs::remove_dir_all(&profile_dir);
                    return None;
                }
                std::thread::sleep(std::time::Duration::from_millis(40));
            }
            Err(_) => {
                terminate_conversion_process(child_id);
                let _ = child.wait();
                let _ = std::fs::remove_dir_all(&profile_dir);
                return None;
            }
        }
    }
    let output = child.wait_with_output();
    let _ = std::fs::remove_dir_all(&profile_dir);
    match output {
        Ok(output) if output.status.success() => {
            let stdout = String::from_utf8_lossy(&output.stdout);
            let stderr = String::from_utf8_lossy(&output.stderr);
            let version = stdout
                .lines()
                .chain(stderr.lines())
                .map(str::trim)
                .find(|line| !line.is_empty())
                .unwrap_or("LibreOffice")
                .to_string();
            Some(LibreOfficeRuntimeInfo {
                available: true,
                command: Some(path.to_string_lossy().into_owned()),
                source: Some(source.to_string()),
                version: Some(version),
                message: None,
            })
        }
        _ => None,
    }
}

fn resolve_libreoffice_runtime() -> LibreOfficeRuntimeInfo {
    // Reuse a validated path for conversions. The command itself is still
    // launched by the conversion worker; this only avoids repeated probes.
    if let Some(runtime) = cached_libreoffice_runtime() {
        let valid = runtime
            .command
            .as_deref()
            .map(std::path::Path::new)
            .is_some_and(|path| std::fs::metadata(path).map(|meta| meta.is_file()).unwrap_or(false));
        if valid {
            return runtime;
        }
        invalidate_libreoffice_runtime_cache();
    }
    if let Some(runtime) = resolve_libreoffice_runtime_quick() {
        cache_libreoffice_runtime(runtime.clone());
        return runtime;
    }
    for (candidate, source) in libreoffice_candidates() {
        if let Some(runtime) = probe_libreoffice(&candidate, source) {
            cache_libreoffice_runtime(runtime.clone());
            return runtime;
        }
    }
    LibreOfficeRuntimeInfo {
        available: false,
        command: None,
        source: None,
        version: None,
        message: Some(
            "LibreOffice runtime was not found. Install LibreOffice or set TOOLKNIT_LIBREOFFICE_PATH to soffice.com/soffice.exe.".to_string(),
        ),
    }
}

fn file_url_for_libreoffice(path: &std::path::Path) -> String {
    let mut text = cleanup_display_path(path).replace('\\', "/");
    text = text
        .replace('%', "%25")
        .replace(' ', "%20")
        .replace('#', "%23")
        .replace('?', "%3F");
    #[cfg(target_os = "windows")]
    {
        if !text.starts_with('/') {
            return format!("file:///{}", text);
        }
    }
    format!("file://{}", text)
}

/// Seed the LibreOffice user profile so headless conversions never ask the
/// Windows print spooler for the document's embedded printer. Impress loads
/// printer settings by default (`LoadPrinterSettings` defaults to `true`),
/// which makes an offline/slow WSD printer stall a conversion for up to the
/// spooler timeout. Writing `false` into `registrymodifications.xcu` keeps the
/// conversion fully file based.
fn seed_libreoffice_printer_profile(profile_dir: &std::path::Path) {
    let user_dir = profile_dir.join("user");
    if std::fs::create_dir_all(&user_dir).is_err() {
        return;
    }
    let xcu_path = user_dir.join("registrymodifications.xcu");
    let existing = std::fs::read_to_string(&xcu_path).unwrap_or_default();
    let header = "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<oor:items xmlns:oor=\"http://openoffice.org/2001/registry\" xmlns:xs=\"http://www.w3.org/2001/XMLSchema\" xmlns:xsi=\"http://www.w3.org/2001/XMLSchema-instance\">";
    let footer = "</oor:items>";
    let printer_item = "<item oor:path=\"/org.openoffice.Office.Common/LoadSave/General\"><prop oor:name=\"LoadPrinterSettings\" oor:op=\"fuse\"><value>false</value></prop></item>";

    let mut updated = if existing.trim().is_empty() {
        format!("{}\n{}\n{}\n", header, printer_item, footer)
    } else if existing.contains("LoadPrinterSettings") {
        existing
            .lines()
            .map(|line| {
                if line.contains("LoadPrinterSettings") {
                    printer_item.to_string()
                } else {
                    line.to_string()
                }
            })
            .collect::<Vec<_>>()
            .join("\n")
    } else if let Some(footer_pos) = existing.rfind("</oor:items>") {
        let mut seeded = existing.clone();
        seeded.insert_str(footer_pos, &format!("{}\n", printer_item));
        seeded
    } else {
        existing
    };
    if !updated.ends_with('\n') {
        updated.push('\n');
    }
    let _ = std::fs::write(&xcu_path, updated);
}

fn find_rendered_pdf(
    directory: &std::path::Path,
    input_name: &str,
) -> Result<std::path::PathBuf, String> {
    let expected = format!("{}.pdf", sanitize_ppt_render_base_name(input_name));
    let mut fallback = None;
    for entry in std::fs::read_dir(directory).map_err(|_| "ppt-render:render-failed".to_string())? {
        let entry = entry.map_err(|_| "ppt-render:render-failed".to_string())?;
        let path = entry.path();
        if path
            .extension()
            .and_then(|value| value.to_str())
            .map(|value| value.eq_ignore_ascii_case("pdf"))
            != Some(true)
        {
            continue;
        }
        let name = path
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or_default();
        if name.eq_ignore_ascii_case(&expected) {
            return Ok(path);
        }
        fallback.get_or_insert(path);
    }
    fallback.ok_or_else(|| "ppt-render:render-failed".to_string())
}

fn count_pdf_pages_rough(bytes: &[u8]) -> usize {
    let mut count = 0usize;
    let needle = b"/Type";
    let mut index = 0usize;
    while index + needle.len() <= bytes.len() {
        if &bytes[index..index + needle.len()] != needle {
            index += 1;
            continue;
        }
        let mut cursor = index + needle.len();
        while cursor < bytes.len() && matches!(bytes[cursor], b' ' | b'\t' | b'\r' | b'\n') {
            cursor += 1;
        }
        if cursor + 5 <= bytes.len()
            && &bytes[cursor..cursor + 5] == b"/Page"
            && bytes.get(cursor + 5).copied() != Some(b's')
        {
            count += 1;
        }
        index = cursor.saturating_add(5);
    }
    count
}

fn validate_ppt_rendered_pdf(
    path: &std::path::Path,
    expected_slides: usize,
) -> Result<(usize, u64, Vec<String>), String> {
    let metadata = std::fs::metadata(path).map_err(|_| "ppt-render:render-failed".to_string())?;
    if !metadata.is_file() || metadata.len() < 16 {
        return Err("ppt-render:render-failed".to_string());
    }
    let bytes = std::fs::read(path).map_err(|_| "ppt-render:render-failed".to_string())?;
    if !bytes.starts_with(b"%PDF-") {
        return Err("ppt-render:render-failed".to_string());
    }
    let mut warnings = Vec::new();
    let page_count = count_pdf_pages_rough(&bytes);
    let page_count = if page_count == 0 {
        warnings.push(
            "PDF page count could not be verified exactly; using PPT slide count.".to_string(),
        );
        expected_slides
    } else {
        page_count
    };
    if page_count != expected_slides {
        warnings.push(format!(
            "Rendered PDF page count ({}) differs from PPT slide count ({}).",
            page_count, expected_slides
        ));
    }
    Ok((page_count, metadata.len(), warnings))
}

async fn run_libreoffice_ppt_to_pdf(
    runtime: &LibreOfficeRuntimeInfo,
    input: &PptRenderInput,
    work_dir: &std::path::Path,
) -> Result<std::path::PathBuf, String> {
    let command = runtime
        .command
        .as_ref()
        .ok_or_else(|| "ppt-render:runtime-missing".to_string())?;
    let out_dir = work_dir.join("out");
    let profile_dir = toolknit_app_data_dir()?
        .join("libreoffice-profile")
        .join(LIBREOFFICE_RUNTIME_VERSION);
    std::fs::create_dir_all(&out_dir).map_err(|_| "ppt-render:output-path".to_string())?;
    std::fs::create_dir_all(&profile_dir).map_err(|_| "ppt-render:output-path".to_string())?;
    seed_libreoffice_printer_profile(&profile_dir);
    let user_installation = file_url_for_libreoffice(&profile_dir);
    let mut command_builder = tokio::process::Command::new(command);
    command_builder
        .arg("--headless")
        .arg("--invisible")
        .arg("--nologo")
        .arg("--nofirststartwizard")
        .arg("--nodefault")
        .arg("--nolockcheck")
        .arg("--norestore")
        .arg(format!("-env:UserInstallation={}", user_installation))
        .arg("--convert-to")
        .arg("pdf:impress_pdf_Export")
        .arg("--outdir")
        .arg(&out_dir)
        .arg(&input.path)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    // Force LibreOffice's non-GUI VCL backend and disable printer-list
    // enumeration. `SAL_DISABLE_PRINTERLIST` is the only supported LibreOffice
    // variable here; Impress can otherwise wait for an offline WSD printer.
    command_builder.env("SAL_USE_VCLPLUGIN", "svp");
    command_builder.env("SAL_DISABLE_PRINTERLIST", "1");
    #[cfg(target_os = "windows")]
    {
        command_builder.creation_flags(0x08000000);
    }
    let child = command_builder
        .spawn()
        .map_err(|_| "ppt-render:runtime-missing".to_string())?;
    let child_id = child.id().unwrap_or(0);
    CURRENT_CHILD_ID.store(child_id, Ordering::SeqCst);
    let output = match tokio::time::timeout(
        std::time::Duration::from_secs(PPT_RENDER_TIMEOUT_SECS),
        child.wait_with_output(),
    )
    .await
    {
        Ok(Ok(output)) => Ok(output),
        Ok(Err(_)) => Err("ppt-render:render-failed".to_string()),
        Err(_) => {
            terminate_conversion_process(child_id);
            CURRENT_CHILD_ID.store(0, Ordering::SeqCst);
            if CANCEL_FLAG.load(Ordering::SeqCst) {
                return Err("ppt-render:cancelled".to_string());
            }
            return Err("ppt-render:timeout".to_string());
        }
    };
    CURRENT_CHILD_ID.store(0, Ordering::SeqCst);
    if CANCEL_FLAG.load(Ordering::SeqCst) {
        return Err("ppt-render:cancelled".to_string());
    }
    let output = output?;
    if !output.status.success() {
        let stdout = String::from_utf8_lossy(&output.stdout);
        let stderr = String::from_utf8_lossy(&output.stderr);
        let detail = stderr
            .lines()
            .chain(stdout.lines())
            .map(str::trim)
            .find(|line| !line.is_empty())
            .unwrap_or("LibreOffice conversion failed.");
        return Err(format!("ppt-render:render-failed:{}", detail));
    }
    find_rendered_pdf(&out_dir, &input.name)
}

#[tauri::command]
async fn convert_ppt_to_pdf(
    input_path: String,
    output_dir: String,
    output_name: Option<String>,
) -> Result<PptToPdfResult, String> {
    let _conversion_guard = begin_conversion().map_err(|_| "ppt-render:busy".to_string())?;
    let input = inspect_ppt_render_input(&input_path)?;
    let runtime = resolve_libreoffice_runtime();
    if !runtime.available {
        return Err("ppt-render:runtime-missing".to_string());
    }
    let output_parent = ppt_render_output_parent(&output_dir)?;
    let base_name = sanitize_ppt_render_base_name(output_name.as_deref().unwrap_or(&input.name));
    let output_file = format!("{}.pdf", base_name);
    let final_dir = unique_ppt_render_output_dir(&output_parent, &base_name, "ppt_to_pdf")?;
    let temp_dir = create_ppt_render_temp_dir(&output_parent)?;
    let work_dir = temp_dir.join(".work");
    std::fs::create_dir_all(&work_dir).map_err(|_| "ppt-render:output-path".to_string())?;
    let result = async {
        let rendered = run_libreoffice_ppt_to_pdf(&runtime, &input, &work_dir).await?;
        let output_path = temp_dir.join(&output_file);
        std::fs::copy(&rendered, &output_path)
            .map_err(|_| "ppt-render:write-failed".to_string())?;
        let (page_count, output_bytes, mut warnings) =
            validate_ppt_rendered_pdf(&output_path, input.slide_count)?;
        let _ = std::fs::remove_dir_all(&work_dir);
        if runtime.source.as_deref() == Some("dev-runtime-cache") {
            warnings.push("Using local development LibreOffice runtime cache.".to_string());
        }
        let manifest_path = temp_dir.join("manifest.json");
        let manifest = serde_json::json!({
            "tool": "ppt.to-pdf",
            "sourceName": input.name.clone(),
            "inputPath": cleanup_display_path(&input.path),
            "inputBytes": input.bytes,
            "renderer": runtime.clone(),
            "slideCount": input.slide_count,
            "pageCount": page_count,
            "pageCountMatchesSlides": page_count == input.slide_count,
            "outputDir": cleanup_display_path(&final_dir),
            "outputPath": cleanup_display_path(&final_dir.join(&output_file)),
            "outputFile": output_file.clone(),
            "outputBytes": output_bytes,
            "warnings": warnings.clone()
        });
        std::fs::write(
            &manifest_path,
            serde_json::to_vec_pretty(&manifest)
                .map_err(|_| "ppt-render:write-failed".to_string())?,
        )
        .map_err(|_| "ppt-render:write-failed".to_string())?;
        std::fs::rename(&temp_dir, &final_dir)
            .map_err(|_| "ppt-render:publish-failed".to_string())?;
        let final_output_path = final_dir.join(&output_file);
        let final_manifest_path = final_dir.join("manifest.json");
        Ok(PptToPdfResult {
            tool: "ppt.to-pdf".to_string(),
            source_name: input.name,
            input_path: cleanup_display_path(&input.path),
            input_bytes: input.bytes,
            renderer: runtime,
            slide_count: input.slide_count,
            page_count,
            page_count_matches_slides: page_count == input.slide_count,
            output_dir: cleanup_display_path(&final_dir),
            output_path: cleanup_display_path(&final_output_path),
            output_file,
            output_bytes,
            manifest_path: cleanup_display_path(&final_manifest_path),
            warnings,
        })
    }
    .await;
    if result.is_err() {
        let _ = std::fs::remove_dir_all(&temp_dir);
    }
    result
}

const EXCEL_RENDER_MAX_FILES: usize = 20;
const EXCEL_RENDER_MAX_INPUT_BYTES: u64 = 200 * 1024 * 1024;
const EXCEL_WPS_METADATA_MAX_BYTES: u64 = 512 * 1024;
const EXCEL_RENDER_TIMEOUT_SECS: u64 = 180;
static EXCEL_RENDER_TEMP_ID: AtomicU64 = AtomicU64::new(0);

const EXCEL_TO_PDF_UNO_SCRIPT: &str = r#"import json
import os
import sys
import time
import uno
from com.sun.star.beans import PropertyValue


def prop(name, value):
    item = PropertyValue()
    item.Name = name
    item.Value = value
    return item


def input_filter(path):
    extension = os.path.splitext(path)[1].lower()
    filters = {
        ".xlsx": "Calc MS Excel 2007 XML",
        ".xls": "MS Excel 97",
        ".ods": "calc8",
    }
    return filters.get(extension)


def connect(pipe_name):
    local_context = uno.getComponentContext()
    resolver = local_context.ServiceManager.createInstanceWithContext(
        "com.sun.star.bridge.UnoUrlResolver", local_context
    )
    target = "uno:pipe,name=%s;urp;StarOffice.ComponentContext" % pipe_name
    last_error = None
    for _ in range(160):
        try:
            return resolver.resolve(target)
        except Exception as error:
            last_error = error
            time.sleep(0.1)
    raise RuntimeError("LibreOffice listener did not become ready: %s" % last_error)


def set_page_property(style, name, value):
    info = style.getPropertySetInfo()
    if not info.hasPropertyByName(name):
        raise RuntimeError("Calc page style does not expose %s" % name)
    style.setPropertyValue(name, value)


def apply_page_setup(document, options):
    sheets = document.getSheets()
    names = list(sheets.getElementNames())
    visible_before = 0
    for name in names:
        sheet = sheets.getByName(name)
        if bool(sheet.getPropertyValue("IsVisible")):
            visible_before += 1
        elif options["sheetRange"] == "all":
            sheet.setPropertyValue("IsVisible", True)

    page_styles = document.getStyleFamilies().getByName("PageStyles")
    configured_styles = set()
    for name in names:
        sheet = sheets.getByName(name)
        if not bool(sheet.getPropertyValue("IsVisible")):
            continue
        style_name = str(sheet.getPropertyValue("PageStyle"))
        if style_name in configured_styles:
            continue
        configured_styles.add(style_name)
        style = page_styles.getByName(style_name)

        current_width = int(style.getPropertyValue("Width"))
        current_height = int(style.getPropertyValue("Height"))
        current_landscape = bool(style.getPropertyValue("IsLandscape"))
        requested_orientation = options["orientation"]
        landscape = current_landscape if requested_orientation == "source" else requested_orientation == "landscape"
        paper = options["paper"]
        if paper == "a4":
            short_edge, long_edge = 21000, 29700
        elif paper == "letter":
            short_edge, long_edge = 21590, 27940
        else:
            short_edge, long_edge = min(current_width, current_height), max(current_width, current_height)
        set_page_property(style, "IsLandscape", landscape)
        set_page_property(style, "Width", long_edge if landscape else short_edge)
        set_page_property(style, "Height", short_edge if landscape else long_edge)

        if options["scale"] == "fit":
            set_page_property(style, "ScaleToPages", 0)
            set_page_property(style, "ScaleToPagesX", 1)
            set_page_property(style, "ScaleToPagesY", 0)
        else:
            set_page_property(style, "ScaleToPages", 0)
            set_page_property(style, "ScaleToPagesX", 0)
            set_page_property(style, "ScaleToPagesY", 0)
            set_page_property(style, "PageScale", 100)

    return {
        "sheetCount": len(names),
        "visibleSheetCount": visible_before,
        "exportedSheetCount": len(names) if options["sheetRange"] == "all" else visible_before,
    }


def main():
    pipe_name, input_path, output_path, options_json, metadata_path = sys.argv[1:6]
    options = json.loads(options_json)
    context = connect(pipe_name)
    service_manager = context.ServiceManager
    desktop = service_manager.createInstanceWithContext("com.sun.star.frame.Desktop", context)
    document = None
    try:
        load_properties = [
            prop("Hidden", True),
            prop("ReadOnly", False),
            prop("UpdateDocMode", 0),
            prop("MacroExecutionMode", 0),
        ]
        input_url = uno.systemPathToFileUrl(os.path.abspath(input_path))
        try:
            document = desktop.loadComponentFromURL(
                input_url, "_blank", 0, tuple(load_properties)
            )
        except Exception:
            filter_name = input_filter(input_path)
            if not filter_name:
                raise
            document = desktop.loadComponentFromURL(
                input_url,
                "_blank",
                0,
                tuple(load_properties + [prop("FilterName", filter_name)]),
            )
        if document is None or not document.supportsService("com.sun.star.sheet.SpreadsheetDocument"):
            implementation = "none" if document is None else str(document.getImplementationName())
            services = [] if document is None else list(document.getSupportedServiceNames())
            raise RuntimeError(
                "The selected file is not a spreadsheet document "
                "(implementation=%s, services=%s)" % (implementation, ",".join(services))
            )
        metadata = apply_page_setup(document, options)
        try:
            document.calculateAll()
        except Exception:
            pass
        export_properties = (
            prop("FilterName", "calc_pdf_Export"),
            prop("Overwrite", True),
        )
        document.storeToURL(
            uno.systemPathToFileUrl(os.path.abspath(output_path)), export_properties
        )
        metadata["outputPath"] = os.path.abspath(output_path)
        with open(metadata_path, "w", encoding="utf-8") as handle:
            json.dump(metadata, handle, ensure_ascii=True)
    finally:
        if document is not None:
            try:
                document.close(True)
            except Exception:
                try:
                    document.dispose()
                except Exception:
                    pass
        try:
            desktop.terminate()
        except Exception:
            pass


if __name__ == "__main__":
    main()
"#;

#[derive(Clone, Debug)]
struct ExcelRenderInput {
    path: std::path::PathBuf,
    name: String,
    bytes: u64,
}

#[derive(Clone, Debug, serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct ExcelToPdfOptions {
    sheet_range: String,
    orientation: String,
    paper: String,
    scale: String,
}

#[derive(Clone, Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct ExcelUnoMetadata {
    sheet_count: usize,
    visible_sheet_count: usize,
    exported_sheet_count: usize,
}

#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct ExcelToPdfFileResult {
    source_name: String,
    input_path: String,
    input_bytes: u64,
    output_path: String,
    output_file: String,
    output_bytes: u64,
    page_count: usize,
    sheet_count: usize,
    visible_sheet_count: usize,
    exported_sheet_count: usize,
    warnings: Vec<String>,
}

#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct ExcelToPdfBatchResult {
    tool: String,
    success_count: usize,
    fail_count: usize,
    output_dir: String,
    outputs: Vec<ExcelToPdfFileResult>,
    errors: Vec<String>,
    warnings: Vec<String>,
    renderer: LibreOfficeRuntimeInfo,
    manifest_path: String,
}

#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct ExcelToPdfProgress {
    file_name: String,
    current: usize,
    total: usize,
    percent: u8,
    phase: String,
}

fn normalize_excel_to_pdf_options(
    mut options: ExcelToPdfOptions,
) -> Result<ExcelToPdfOptions, String> {
    options.sheet_range = options.sheet_range.trim().to_ascii_lowercase();
    options.orientation = options.orientation.trim().to_ascii_lowercase();
    options.paper = options.paper.trim().to_ascii_lowercase();
    options.scale = options.scale.trim().to_ascii_lowercase();
    if !matches!(options.sheet_range.as_str(), "all" | "visible")
        || !matches!(
            options.orientation.as_str(),
            "source" | "portrait" | "landscape"
        )
        || !matches!(options.paper.as_str(), "auto" | "a4" | "letter")
        || !matches!(options.scale.as_str(), "fit" | "original")
    {
        return Err("excel-render:invalid-options".to_string());
    }
    Ok(options)
}

fn inspect_excel_render_input(input_path: &str) -> Result<ExcelRenderInput, String> {
    if input_path.trim().is_empty() || input_path.contains('\0') {
        return Err("excel-render:invalid-input".to_string());
    }
    let requested = std::path::PathBuf::from(input_path);
    let extension = requested
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    if !matches!(extension.as_str(), "xlsx" | "xls" | "ods") {
        return Err("excel-render:invalid-extension".to_string());
    }
    let metadata = std::fs::symlink_metadata(&requested)
        .map_err(|_| "excel-render:input-not-found".to_string())?;
    if metadata.file_type().is_symlink() || !metadata.is_file() || metadata.len() == 0 {
        return Err("excel-render:invalid-input".to_string());
    }
    if metadata.len() > EXCEL_RENDER_MAX_INPUT_BYTES {
        return Err("excel-render:input-too-large".to_string());
    }
    let path = requested
        .canonicalize()
        .map_err(|_| "excel-render:invalid-input".to_string())?;
    let mut signature = [0_u8; 8];
    let mut file = std::fs::File::open(&path)
        .map_err(|_| "excel-render:read-failed".to_string())?;
    use std::io::Read as _;
    let read = file
        .read(&mut signature)
        .map_err(|_| "excel-render:read-failed".to_string())?;
    let valid = if extension == "xls" {
        read >= 8 && signature == [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]
    } else {
        read >= 4 && signature[..4] == [0x50, 0x4b, 0x03, 0x04]
    };
    if !valid {
        return Err("excel-render:invalid-workbook".to_string());
    }
    let name = path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("workbook.xlsx")
        .to_string();
    Ok(ExcelRenderInput {
        path,
        name,
        bytes: metadata.len(),
    })
}

fn is_wps_generated_xlsx(path: &std::path::Path) -> bool {
    if !path
        .extension()
        .and_then(|value| value.to_str())
        .is_some_and(|extension| extension.eq_ignore_ascii_case("xlsx"))
    {
        return false;
    }
    let Ok(file) = std::fs::File::open(path) else {
        return false;
    };
    let Ok(mut archive) = zip::ZipArchive::new(file) else {
        return false;
    };
    for entry_name in ["docProps/app.xml", "docProps/custom.xml", "xl/workbook.xml"] {
        let Ok(entry) = archive.by_name(entry_name) else {
            continue;
        };
        if entry.size() > EXCEL_WPS_METADATA_MAX_BYTES {
            continue;
        }
        let mut metadata = Vec::with_capacity(entry.size() as usize);
        use std::io::Read as _;
        if entry
            .take(EXCEL_WPS_METADATA_MAX_BYTES + 1)
            .read_to_end(&mut metadata)
            .is_err()
            || metadata.len() as u64 > EXCEL_WPS_METADATA_MAX_BYTES
        {
            continue;
        }
        let metadata = String::from_utf8_lossy(&metadata).to_ascii_lowercase();
        if metadata.contains("wps office")
            || metadata.contains("ksoproductbuildver")
            || metadata.contains("web.wps.cn")
        {
            return true;
        }
    }
    false
}

fn libreoffice_python_path(runtime: &LibreOfficeRuntimeInfo) -> Result<std::path::PathBuf, String> {
    let command = runtime
        .command
        .as_deref()
        .map(std::path::PathBuf::from)
        .ok_or_else(|| "excel-render:runtime-missing".to_string())?;
    let directory = command
        .parent()
        .ok_or_else(|| "excel-render:python-missing".to_string())?;
    let names: &[&str] = if cfg!(target_os = "windows") {
        &["python.exe"]
    } else {
        &["python", "python3"]
    };
    names
        .iter()
        .map(|name| directory.join(name))
        .find(|path| std::fs::metadata(path).map(|meta| meta.is_file()).unwrap_or(false))
        .ok_or_else(|| "excel-render:python-missing".to_string())
}

fn unique_excel_render_output_dir(
    parent: &std::path::Path,
    inputs: &[ExcelRenderInput],
) -> Result<std::path::PathBuf, String> {
    let label = if inputs.len() == 1 {
        sanitize_ppt_render_base_name(&inputs[0].name)
    } else {
        "excel_batch".to_string()
    };
    for counter in 0..10_000_u32 {
        let suffix = if counter == 0 {
            String::new()
        } else {
            format!("_{}", counter)
        };
        let candidate = parent.join(format!("{}_to_pdf{}", label, suffix));
        match std::fs::symlink_metadata(&candidate) {
            Ok(_) => continue,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(candidate),
            Err(_) => return Err("excel-render:output-path".to_string()),
        }
    }
    Err("excel-render:output-path".to_string())
}

fn create_excel_render_temp_dir(parent: &std::path::Path) -> Result<std::path::PathBuf, String> {
    for _ in 0..10_000 {
        let counter = EXCEL_RENDER_TEMP_ID.fetch_add(1, Ordering::SeqCst);
        let candidate = parent.join(format!(
            ".toolknit-excel-render-{}-{}",
            std::process::id(),
            counter
        ));
        match std::fs::create_dir(&candidate) {
            Ok(()) => return Ok(candidate),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(_) => return Err("excel-render:output-path".to_string()),
        }
    }
    Err("excel-render:output-path".to_string())
}

fn unique_excel_output_file(
    directory: &std::path::Path,
    input_name: &str,
    used_names: &mut std::collections::BTreeSet<String>,
) -> Result<(String, std::path::PathBuf), String> {
    let base = sanitize_ppt_render_base_name(input_name);
    for counter in 0..10_000_u32 {
        let suffix = if counter == 0 {
            String::new()
        } else {
            format!("_{}", counter)
        };
        let file_name = format!("{}{}.pdf", base, suffix);
        if used_names.insert(file_name.to_ascii_lowercase()) {
            return Ok((file_name.clone(), directory.join(file_name)));
        }
    }
    Err("excel-render:output-path".to_string())
}

fn excel_render_error_detail(stdout: &[u8], stderr: &[u8]) -> String {
    let stderr = String::from_utf8_lossy(stderr);
    let stdout = String::from_utf8_lossy(stdout);
    stderr
        .lines()
        .rev()
        .chain(stdout.lines().rev())
        .map(str::trim)
        .find(|line| !line.is_empty())
        .unwrap_or("LibreOffice Calc export failed.")
        .to_string()
}

async fn normalize_excel_input_with_libreoffice(
    runtime: &LibreOfficeRuntimeInfo,
    input: &ExcelRenderInput,
    work_dir: &std::path::Path,
) -> Result<std::path::PathBuf, String> {
    let soffice = runtime
        .command
        .as_deref()
        .ok_or_else(|| "excel-render:runtime-missing".to_string())?;
    let normalize_dir = work_dir.join("compatibility-import");
    let output_dir = normalize_dir.join("output");
    let profile_dir = normalize_dir.join("profile");
    std::fs::create_dir_all(&output_dir)
        .map_err(|_| "excel-render:output-path".to_string())?;
    std::fs::create_dir_all(&profile_dir)
        .map_err(|_| "excel-render:output-path".to_string())?;
    seed_libreoffice_printer_profile(&profile_dir);
    let extension = input
        .path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("xlsx")
        .to_ascii_lowercase();
    let staged_input = normalize_dir.join(format!("input.{}", extension));
    std::fs::copy(&input.path, &staged_input)
        .map_err(|_| "excel-render:read-failed".to_string())?;

    let mut command = tokio::process::Command::new(soffice);
    command
        .arg(format!(
            "-env:UserInstallation={}",
            file_url_for_libreoffice(&profile_dir)
        ))
        .arg("--headless")
        .arg("--invisible")
        .arg("--nologo")
        .arg("--nofirststartwizard")
        .arg("--nodefault")
        .arg("--nolockcheck")
        .arg("--norestore")
        .arg("--convert-to")
        .arg("ods")
        .arg("--outdir")
        .arg(&output_dir)
        .arg(&staged_input)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .env("SAL_USE_VCLPLUGIN", "svp")
        .env("SAL_DISABLE_PRINTERLIST", "1");
    #[cfg(target_os = "windows")]
    {
        command.creation_flags(0x08000000);
    }
    let child = command
        .spawn()
        .map_err(|_| "excel-render:runtime-missing".to_string())?;
    let child_id = child.id().unwrap_or(0);
    active_office_children()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .insert(child_id);
    CURRENT_CHILD_ID.store(child_id, Ordering::SeqCst);
    let command_output = tokio::time::timeout(
        std::time::Duration::from_secs(EXCEL_RENDER_TIMEOUT_SECS),
        child.wait_with_output(),
    )
    .await;
    CURRENT_CHILD_ID.store(0, Ordering::SeqCst);
    active_office_children()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .remove(&child_id);
    if CANCEL_FLAG.load(Ordering::SeqCst) {
        terminate_conversion_process(child_id);
        return Err("excel-render:cancelled".to_string());
    }
    let output = match command_output {
        Ok(Ok(output)) => output,
        Ok(Err(_)) => return Err("excel-render:render-failed".to_string()),
        Err(_) => {
            terminate_conversion_process(child_id);
            return Err("excel-render:timeout".to_string());
        }
    };
    if !output.status.success() {
        return Err(format!(
            "excel-render:render-failed:{}",
            excel_render_error_detail(&output.stdout, &output.stderr)
        ));
    }
    let normalized = output_dir.join("input.ods");
    let metadata = std::fs::metadata(&normalized)
        .map_err(|_| "excel-render:render-failed".to_string())?;
    if !metadata.is_file() || metadata.len() < 16 {
        return Err("excel-render:render-failed".to_string());
    }
    Ok(normalized)
}

async fn run_libreoffice_excel_to_pdf(
    runtime: &LibreOfficeRuntimeInfo,
    input: &ExcelRenderInput,
    output_path: &std::path::Path,
    options: &ExcelToPdfOptions,
    work_dir: &std::path::Path,
) -> Result<ExcelUnoMetadata, String> {
    let soffice = runtime
        .command
        .as_deref()
        .ok_or_else(|| "excel-render:runtime-missing".to_string())?;
    let python = libreoffice_python_path(runtime)?;
    let profile_dir = work_dir.join("profile");
    std::fs::create_dir_all(&profile_dir)
        .map_err(|_| "excel-render:output-path".to_string())?;
    // LibreOffice's remote UNO loader can fail type detection for otherwise
    // valid WPS/Excel workbooks when the source URL contains non-ASCII path
    // segments. Stage the input under a stable ASCII name for the renderer;
    // the published PDF still keeps the original workbook name.
    let input_extension = input
        .path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("xlsx")
        .to_ascii_lowercase();
    let staged_input = work_dir.join(format!("input.{}", input_extension));
    std::fs::copy(&input.path, &staged_input)
        .map_err(|_| "excel-render:read-failed".to_string())?;
    seed_libreoffice_printer_profile(&profile_dir);
    let script_path = work_dir.join("excel-to-pdf.py");
    let metadata_path = work_dir.join("metadata.json");
    std::fs::write(&script_path, EXCEL_TO_PDF_UNO_SCRIPT.as_bytes())
        .map_err(|_| "excel-render:write-failed".to_string())?;
    let pipe_name = format!(
        "toolknit_excel_{}_{}",
        std::process::id(),
        EXCEL_RENDER_TEMP_ID.fetch_add(1, Ordering::SeqCst)
    );
    let user_installation = file_url_for_libreoffice(&profile_dir);
    let mut office_command = tokio::process::Command::new(soffice);
    office_command
        .arg("--headless")
        .arg("--invisible")
        .arg("--nologo")
        .arg("--nofirststartwizard")
        .arg("--nodefault")
        .arg("--nolockcheck")
        .arg("--norestore")
        .arg(format!("-env:UserInstallation={}", user_installation))
        .arg(format!(
            "--accept=pipe,name={};urp;StarOffice.ComponentContext",
            pipe_name
        ))
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .env("SAL_USE_VCLPLUGIN", "svp")
        .env("SAL_DISABLE_PRINTERLIST", "1");
    #[cfg(target_os = "windows")]
    {
        office_command.creation_flags(0x08000000);
    }
    let mut office = office_command
        .spawn()
        .map_err(|_| "excel-render:runtime-missing".to_string())?;
    let office_id = office.id().unwrap_or(0);
    active_office_children()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .insert(office_id);

    let options_json = serde_json::to_string(options)
        .map_err(|_| "excel-render:invalid-options".to_string())?;
    let mut python_command = tokio::process::Command::new(&python);
    python_command
        .arg(&script_path)
        .arg(&pipe_name)
        .arg(&staged_input)
        .arg(output_path)
        .arg(options_json)
        .arg(&metadata_path)
        .current_dir(python.parent().unwrap_or_else(|| std::path::Path::new(".")))
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    #[cfg(target_os = "windows")]
    {
        python_command.creation_flags(0x08000000);
    }
    let python_child = match python_command.spawn() {
        Ok(child) => child,
        Err(_) => {
            terminate_conversion_process(office_id);
            let _ = office.wait().await;
            active_office_children()
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .remove(&office_id);
            return Err("excel-render:python-missing".to_string());
        }
    };
    let python_id = python_child.id().unwrap_or(0);
    active_office_children()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .insert(python_id);
    CURRENT_CHILD_ID.store(python_id, Ordering::SeqCst);
    let python_output = tokio::time::timeout(
        std::time::Duration::from_secs(EXCEL_RENDER_TIMEOUT_SECS),
        python_child.wait_with_output(),
    )
    .await;
    CURRENT_CHILD_ID.store(0, Ordering::SeqCst);
    active_office_children()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .remove(&python_id);
    if CANCEL_FLAG.load(Ordering::SeqCst) || !matches!(&python_output, Ok(Ok(_))) {
        terminate_conversion_process(python_id);
    }
    if tokio::time::timeout(std::time::Duration::from_secs(2), office.wait())
        .await
        .is_err()
    {
        terminate_conversion_process(office_id);
        let _ = tokio::time::timeout(std::time::Duration::from_secs(3), office.wait()).await;
    }
    active_office_children()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .remove(&office_id);

    if CANCEL_FLAG.load(Ordering::SeqCst) {
        terminate_conversion_process(python_id);
        return Err("excel-render:cancelled".to_string());
    }
    let output = match python_output {
        Ok(Ok(output)) => output,
        Ok(Err(_)) => return Err("excel-render:render-failed".to_string()),
        Err(_) => {
            terminate_conversion_process(python_id);
            return Err("excel-render:timeout".to_string());
        }
    };
    if !output.status.success() {
        return Err(format!(
            "excel-render:render-failed:{}",
            excel_render_error_detail(&output.stdout, &output.stderr)
        ));
    }
    let metadata_bytes = std::fs::read(&metadata_path)
        .map_err(|_| "excel-render:render-failed".to_string())?;
    serde_json::from_slice(&metadata_bytes)
        .map_err(|_| "excel-render:render-failed".to_string())
}

async fn run_compatible_excel_to_pdf(
    runtime: &LibreOfficeRuntimeInfo,
    input: &ExcelRenderInput,
    output_path: &std::path::Path,
    options: &ExcelToPdfOptions,
    work_dir: &std::path::Path,
) -> Result<ExcelUnoMetadata, String> {
    let normalized_path = normalize_excel_input_with_libreoffice(runtime, input, work_dir).await?;
    let normalized_input = ExcelRenderInput {
        path: normalized_path,
        name: input.name.clone(),
        bytes: input.bytes,
    };
    let retry_work_dir = work_dir.join("normalized-render");
    std::fs::create_dir_all(&retry_work_dir)
        .map_err(|_| "excel-render:output-path".to_string())?;
    run_libreoffice_excel_to_pdf(
        runtime,
        &normalized_input,
        output_path,
        options,
        &retry_work_dir,
    )
    .await
}

async fn convert_excel_to_pdf_core<F>(
    input_paths: Vec<String>,
    output_dir: String,
    options: ExcelToPdfOptions,
    mut progress: F,
) -> Result<ExcelToPdfBatchResult, String>
where
    F: FnMut(ExcelToPdfProgress),
{
    if input_paths.is_empty() || input_paths.len() > EXCEL_RENDER_MAX_FILES {
        return Err("excel-render:invalid-file-count".to_string());
    }
    let options = normalize_excel_to_pdf_options(options)?;
    let inputs = input_paths
        .iter()
        .map(|path| inspect_excel_render_input(path))
        .collect::<Result<Vec<_>, _>>()?;
    let runtime = resolve_libreoffice_runtime();
    if !runtime.available {
        return Err("excel-render:runtime-missing".to_string());
    }
    let output_parent = validate_image_output_dir(&output_dir)
        .map_err(|_| "excel-render:output-path".to_string())?;
    let final_dir = unique_excel_render_output_dir(&output_parent, &inputs)?;
    let temp_dir = create_excel_render_temp_dir(&output_parent)?;
    let total = inputs.len();
    let mut outputs = Vec::new();
    let mut errors = Vec::new();
    let mut batch_warnings = Vec::new();
    let mut used_names = std::collections::BTreeSet::new();

    for (index, input) in inputs.iter().enumerate() {
        if CANCEL_FLAG.load(Ordering::SeqCst) {
            let _ = std::fs::remove_dir_all(&temp_dir);
            return Err("excel-render:cancelled".to_string());
        }
        progress(ExcelToPdfProgress {
            file_name: input.name.clone(),
            current: index + 1,
            total,
            percent: ((index * 100) / total).min(95) as u8,
            phase: "preparing".to_string(),
        });
        let (output_file, temporary_output_path) =
            unique_excel_output_file(&temp_dir, &input.name, &mut used_names)?;
        // Keep LibreOffice's profile outside the publish directory. Windows
        // may retain short-lived handles to profile files after soffice exits,
        // which must not prevent the completed PDFs from being published.
        let work_dir = create_excel_render_temp_dir(&output_parent)?;
        progress(ExcelToPdfProgress {
            file_name: input.name.clone(),
            current: index + 1,
            total,
            percent: (((index * 100) + 18) / total).min(96) as u8,
            phase: "converting".to_string(),
        });
        let mut used_compatibility_import = is_wps_generated_xlsx(&input.path);
        let direct_result = if used_compatibility_import {
            run_compatible_excel_to_pdf(
                &runtime,
                input,
                &temporary_output_path,
                &options,
                &work_dir,
            )
            .await
        } else {
            run_libreoffice_excel_to_pdf(
                &runtime,
                input,
                &temporary_output_path,
                &options,
                &work_dir,
            )
            .await
        };
        let render_result = match direct_result {
            Err(error)
                if !used_compatibility_import
                    && error.starts_with("excel-render:render-failed")
                    && input
                        .path
                        .extension()
                        .and_then(|value| value.to_str())
                        .is_some_and(|extension| !extension.eq_ignore_ascii_case("ods")) =>
            {
                used_compatibility_import = true;
                match run_compatible_excel_to_pdf(
                    &runtime,
                    input,
                    &temporary_output_path,
                    &options,
                    &work_dir,
                )
                .await
                {
                    Ok(metadata) => Ok(metadata),
                    Err(normalize_error) => Err(format!("{} | {}", error, normalize_error)),
                }
            }
            result => result,
        };
        match render_result {
            Ok(metadata) => {
                let output_metadata = std::fs::metadata(&temporary_output_path)
                    .map_err(|_| "excel-render:render-failed".to_string())?;
                let bytes = std::fs::read(&temporary_output_path)
                    .map_err(|_| "excel-render:render-failed".to_string())?;
                if !output_metadata.is_file()
                    || output_metadata.len() < 16
                    || !bytes.starts_with(b"%PDF-")
                {
                    errors.push(format!("{}: excel-render:render-failed", input.name));
                    let _ = std::fs::remove_file(&temporary_output_path);
                } else {
                    let page_count = count_pdf_pages_rough(&bytes);
                    let mut warnings = Vec::new();
                    if used_compatibility_import {
                        warnings.push(
                            "Workbook was normalized through LibreOffice compatibility import before rendering."
                                .to_string(),
                        );
                    }
                    if page_count == 0 {
                        warnings.push("PDF page count could not be verified exactly.".to_string());
                    }
                    outputs.push(ExcelToPdfFileResult {
                        source_name: input.name.clone(),
                        input_path: cleanup_display_path(&input.path),
                        input_bytes: input.bytes,
                        output_path: cleanup_display_path(&final_dir.join(&output_file)),
                        output_file,
                        output_bytes: output_metadata.len(),
                        page_count,
                        sheet_count: metadata.sheet_count,
                        visible_sheet_count: metadata.visible_sheet_count,
                        exported_sheet_count: metadata.exported_sheet_count,
                        warnings,
                    });
                }
            }
            Err(error) if error == "excel-render:cancelled" => {
                let _ = std::fs::remove_dir_all(&work_dir);
                let _ = std::fs::remove_dir_all(&temp_dir);
                return Err(error);
            }
            Err(error) => errors.push(format!("{}: {}", input.name, error)),
        }
        let _ = std::fs::remove_dir_all(&work_dir);
        progress(ExcelToPdfProgress {
            file_name: input.name.clone(),
            current: index + 1,
            total,
            percent: (((index + 1) * 100) / total).min(99) as u8,
            phase: "publishing".to_string(),
        });
    }

    if outputs.is_empty() {
        let _ = std::fs::remove_dir_all(&temp_dir);
        return Err(format!(
            "excel-render:all-failed:{}",
            errors.join(" | ")
        ));
    }
    if runtime.source.as_deref() == Some("dev-runtime-cache") {
        batch_warnings.push("Using local development LibreOffice runtime cache.".to_string());
    }
    let manifest_path = temp_dir.join("manifest.json");
    let manifest = serde_json::json!({
        "tool": "excel.to-pdf",
        "options": &options,
        "renderer": &runtime,
        "successCount": outputs.len(),
        "failCount": errors.len(),
        "outputDir": cleanup_display_path(&final_dir),
        "outputs": &outputs,
        "errors": &errors,
        "warnings": &batch_warnings,
    });
    std::fs::write(
        &manifest_path,
        serde_json::to_vec_pretty(&manifest)
            .map_err(|_| "excel-render:write-failed".to_string())?,
    )
    .map_err(|_| "excel-render:write-failed".to_string())?;
    std::fs::rename(&temp_dir, &final_dir)
        .map_err(|error| format!("excel-render:publish-failed:{}", error))?;
    progress(ExcelToPdfProgress {
        file_name: String::new(),
        current: total,
        total,
        percent: 100,
        phase: "complete".to_string(),
    });
    Ok(ExcelToPdfBatchResult {
        tool: "excel.to-pdf".to_string(),
        success_count: outputs.len(),
        fail_count: errors.len(),
        output_dir: cleanup_display_path(&final_dir),
        outputs,
        errors,
        warnings: batch_warnings,
        renderer: runtime,
        manifest_path: cleanup_display_path(&final_dir.join("manifest.json")),
    })
}

#[tauri::command]
async fn convert_excel_to_pdf(
    app_handle: tauri::AppHandle,
    input_paths: Vec<String>,
    output_dir: String,
    options: ExcelToPdfOptions,
) -> Result<ExcelToPdfBatchResult, String> {
    use tauri::Emitter;
    let _conversion_guard = begin_conversion().map_err(|_| "excel-render:busy".to_string())?;
    convert_excel_to_pdf_core(input_paths, output_dir, options, |event| {
        let _ = app_handle.emit("excel-to-pdf-progress", event);
    })
    .await
}

#[cfg(test)]
mod excel_to_pdf_tests {
    use super::*;

    fn default_options() -> ExcelToPdfOptions {
        ExcelToPdfOptions {
            sheet_range: "all".to_string(),
            orientation: "source".to_string(),
            paper: "auto".to_string(),
            scale: "fit".to_string(),
        }
    }

    #[test]
    fn excel_options_reject_unknown_values() {
        let mut options = default_options();
        options.paper = "legal".to_string();
        assert_eq!(
            normalize_excel_to_pdf_options(options).unwrap_err(),
            "excel-render:invalid-options"
        );
    }

    #[test]
    fn excel_input_rejects_fake_workbooks() {
        let directory = std::env::temp_dir().join(format!(
            "toolknit-excel-validation-{}-{}",
            std::process::id(),
            EXCEL_RENDER_TEMP_ID.fetch_add(1, Ordering::SeqCst)
        ));
        std::fs::create_dir_all(&directory).unwrap();
        let path = directory.join("fake.xlsx");
        std::fs::write(&path, b"not an xlsx").unwrap();
        assert_eq!(
            inspect_excel_render_input(path.to_str().unwrap()).unwrap_err(),
            "excel-render:invalid-workbook"
        );
        let _ = std::fs::remove_dir_all(directory);
    }

    #[test]
    fn excel_render_error_reports_the_traceback_cause() {
        let stderr = b"Traceback (most recent call last):\n  File \"excel-to-pdf.py\", line 1\nRuntimeError: type detection failed\n";
        assert_eq!(
            excel_render_error_detail(b"", stderr),
            "RuntimeError: type detection failed"
        );
    }

    fn write_xlsx_metadata_fixture(path: &std::path::Path, metadata: &str) {
        use std::io::Write as _;
        let file = std::fs::File::create(path).unwrap();
        let mut archive = zip::ZipWriter::new(file);
        archive
            .start_file(
                "docProps/app.xml",
                zip::write::SimpleFileOptions::default()
                    .compression_method(zip::CompressionMethod::Deflated),
            )
            .unwrap();
        archive.write_all(metadata.as_bytes()).unwrap();
        archive.finish().unwrap();
    }

    #[test]
    fn excel_detects_wps_metadata_for_fast_compatibility_import() {
        let directory = std::env::temp_dir().join(format!(
            "toolknit-excel-wps-detection-{}-{}",
            std::process::id(),
            EXCEL_RENDER_TEMP_ID.fetch_add(1, Ordering::SeqCst)
        ));
        std::fs::create_dir_all(&directory).unwrap();
        let wps_path = directory.join("wps.xlsx");
        let excel_path = directory.join("excel.xlsx");
        write_xlsx_metadata_fixture(&wps_path, "<Application>WPS Office</Application>");
        write_xlsx_metadata_fixture(&excel_path, "<Application>Microsoft Excel</Application>");
        assert!(is_wps_generated_xlsx(&wps_path));
        assert!(!is_wps_generated_xlsx(&excel_path));
        let _ = std::fs::remove_dir_all(directory);
    }

    #[tokio::test]
    #[ignore = "requires LibreOffice and TOOLKNIT_EXCEL_QA_FILE"]
    async fn excel_real_runtime_qa() {
        let input = std::env::var("TOOLKNIT_EXCEL_QA_FILE").unwrap();
        let retained_output = std::env::var_os("TOOLKNIT_EXCEL_QA_OUTPUT_DIR")
            .map(std::path::PathBuf::from);
        let output = retained_output.clone().unwrap_or_else(|| {
            std::env::temp_dir().join(format!(
                "toolknit-excel-runtime-qa-{}",
                EXCEL_RENDER_TEMP_ID.fetch_add(1, Ordering::SeqCst)
            ))
        });
        std::fs::create_dir_all(&output).unwrap();
        let _guard = begin_conversion().unwrap();
        let all_sheets = convert_excel_to_pdf_core(
            vec![input.clone()],
            output.to_string_lossy().into_owned(),
            default_options(),
            |_| {},
        )
        .await
        .unwrap();
        assert_eq!(all_sheets.success_count, 1);
        assert_eq!(all_sheets.fail_count, 0);
        let all_pdf = std::path::Path::new(&all_sheets.outputs[0].output_path);
        assert!(all_pdf.is_file());
        assert!(all_sheets.outputs[0].output_bytes > 0);
        assert!(std::fs::read(all_pdf).unwrap().starts_with(b"%PDF-"));
        assert!(all_sheets.outputs[0].page_count > 0);
        assert_eq!(
            all_sheets.outputs[0].exported_sheet_count,
            all_sheets.outputs[0].sheet_count
        );
        assert!(std::path::Path::new(&all_sheets.manifest_path).is_file());

        let visible_options = ExcelToPdfOptions {
            sheet_range: "visible".to_string(),
            orientation: "landscape".to_string(),
            paper: "letter".to_string(),
            scale: "original".to_string(),
        };
        let visible_sheets = convert_excel_to_pdf_core(
            vec![input],
            output.to_string_lossy().into_owned(),
            visible_options,
            |_| {},
        )
        .await
        .unwrap();
        assert_eq!(visible_sheets.success_count, 1);
        assert_eq!(visible_sheets.fail_count, 0);
        let visible_pdf = std::path::Path::new(&visible_sheets.outputs[0].output_path);
        assert!(visible_pdf.is_file());
        assert!(std::fs::read(visible_pdf).unwrap().starts_with(b"%PDF-"));
        assert!(visible_sheets.outputs[0].page_count > 0);
        assert_eq!(
            visible_sheets.outputs[0].exported_sheet_count,
            visible_sheets.outputs[0].visible_sheet_count
        );
        assert!(std::path::Path::new(&visible_sheets.manifest_path).is_file());
        assert!(
            all_sheets.outputs[0].exported_sheet_count
                >= visible_sheets.outputs[0].exported_sheet_count
        );
        println!("all-sheets PDF: {}", all_sheets.outputs[0].output_path);
        println!("visible-sheets PDF: {}", visible_sheets.outputs[0].output_path);

        if retained_output.is_none() {
            let _ = std::fs::remove_dir_all(output);
        }
    }
}

#[cfg(test)]
mod image_crop_tests {
    use super::*;
    use image::{GenericImageView, ImageEncoder};

    fn crop_test_directory(label: &str) -> std::path::PathBuf {
        let directory = std::env::temp_dir().join(format!(
            "toolknit-crop-{}-{}-{}",
            label,
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&directory).unwrap();
        directory
    }

    fn crop_options(
        input: &std::path::Path,
        output: &std::path::Path,
        format: &str,
    ) -> ImageCropOptions {
        ImageCropOptions {
            input_path: input.to_string_lossy().into_owned(),
            output_dir: output.to_string_lossy().into_owned(),
            output_name: Some(format!("crop-{format}")),
            crop_x: 0,
            crop_y: 0,
            crop_width: 2,
            crop_height: 2,
            rotation: 0,
            flip_horizontal: false,
            flip_vertical: false,
            format: format.to_string(),
            jpeg_quality: 96,
            background_rgba: "#FFFFFFFF".to_string(),
        }
    }

    fn write_crop_exif_jpeg(path: &std::path::Path, image: &image::RgbImage, orientation: u16) {
        let mut exif = vec![0_u8; 26];
        exif[0..2].copy_from_slice(b"II");
        exif[2..4].copy_from_slice(&42_u16.to_le_bytes());
        exif[4..8].copy_from_slice(&8_u32.to_le_bytes());
        exif[8..10].copy_from_slice(&1_u16.to_le_bytes());
        exif[10..12].copy_from_slice(&0x0112_u16.to_le_bytes());
        exif[12..14].copy_from_slice(&3_u16.to_le_bytes());
        exif[14..18].copy_from_slice(&1_u32.to_le_bytes());
        exif[18..20].copy_from_slice(&orientation.to_le_bytes());
        let file = std::fs::File::create(path).unwrap();
        let mut encoder = image::codecs::jpeg::JpegEncoder::new_with_quality(file, 100);
        encoder.set_exif_metadata(exif).unwrap();
        encoder
            .encode(
                image.as_raw(),
                image.width(),
                image.height(),
                image::ExtendedColorType::Rgb8,
            )
            .unwrap();
    }

    #[test]
    fn crop_rejects_out_of_bounds_rectangles() {
        let mut options = crop_options(
            std::path::Path::new("unused.png"),
            std::path::Path::new("unused"),
            "png",
        );
        options.crop_x = 9;
        options.crop_width = 2;
        assert_eq!(
            validate_image_crop_bounds(&options, 10, 10),
            Err("image-crop:crop-out-of-bounds".to_string())
        );
        options.crop_width = 0;
        assert_eq!(
            validate_image_crop_bounds(&options, 10, 10),
            Err("image-crop:invalid-crop".to_string())
        );
    }

    #[test]
    fn crop_transform_order_is_rotate_then_flip_then_crop() {
        let source = image::RgbaImage::from_fn(2, 3, |x, y| {
            let colors = [
                [[255, 0, 0, 255], [0, 255, 0, 255]],
                [[0, 0, 255, 255], [255, 255, 0, 255]],
                [[255, 0, 255, 255], [0, 255, 255, 255]],
            ];
            image::Rgba(colors[y as usize][x as usize])
        });
        let transformed =
            transform_image_for_crop(image::DynamicImage::ImageRgba8(source), 90, true, false)
                .unwrap();
        assert_eq!(transformed.dimensions(), (3, 2));
        assert_eq!(transformed.get_pixel(0, 0), image::Rgba([255, 0, 0, 255]));
        assert_eq!(transformed.get_pixel(0, 1), image::Rgba([0, 255, 0, 255]));
    }

    #[test]
    fn crop_exports_all_formats_and_never_overwrites() {
        let directory = crop_test_directory("formats");
        let input = directory.join("source.png");
        image::RgbaImage::from_fn(4, 4, |x, y| {
            image::Rgba([
                (x * 50) as u8,
                (y * 50) as u8,
                120,
                if x == 0 { 0 } else { 255 },
            ])
        })
        .save(&input)
        .unwrap();

        for format in ["png", "jpg", "webp", "bmp"] {
            let options = crop_options(&input, &directory, format);
            let first = crop_image_blocking(options.clone()).unwrap();
            let second = crop_image_blocking(options).unwrap();
            assert_ne!(first.output_path, second.output_path);
            assert_eq!(
                image::open(&first.output_path).unwrap().dimensions(),
                (2, 2)
            );
            assert!(first.bytes > 0);
        }
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn crop_jpeg_uses_requested_background_for_transparency() {
        let directory = crop_test_directory("background");
        let input = directory.join("transparent.png");
        image::RgbaImage::from_pixel(2, 2, image::Rgba([0, 0, 0, 0]))
            .save(&input)
            .unwrap();
        let mut options = crop_options(&input, &directory, "jpg");
        options.background_rgba = "#20A060FF".to_string();
        let result = crop_image_blocking(options).unwrap();
        let pixel = image::open(result.output_path)
            .unwrap()
            .to_rgb8()
            .get_pixel(0, 0)
            .0;
        assert!((i16::from(pixel[0]) - 32).abs() < 16);
        assert!((i16::from(pixel[1]) - 160).abs() < 16);
        assert!((i16::from(pixel[2]) - 96).abs() < 16);
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn crop_coordinates_follow_exif_oriented_pixels() {
        let directory = crop_test_directory("exif");
        let input = directory.join("orientation-6.jpg");
        let source = image::RgbImage::from_fn(64, 32, |x, y| match (x < 32, y < 16) {
            (true, true) => image::Rgb([255, 0, 0]),
            (false, true) => image::Rgb([0, 255, 0]),
            (true, false) => image::Rgb([0, 0, 255]),
            (false, false) => image::Rgb([255, 255, 0]),
        });
        write_crop_exif_jpeg(&input, &source, 6);
        let mut options = crop_options(&input, &directory, "png");
        options.crop_width = 12;
        options.crop_height = 12;
        let result = crop_image_blocking(options).unwrap();
        let pixel = image::open(result.output_path).unwrap().to_rgb8().get_pixel(4, 4).0;
        assert!(pixel[2] > 200 && pixel[0] < 40 && pixel[1] < 40);
        std::fs::remove_dir_all(directory).unwrap();
    }
}

#[tauri::command]
fn reveal_in_folder(path: String) -> Result<(), String> {
    // Legacy frontend builds used this command name for output actions. Keep
    // the command available for compatibility, but enforce the current rule that
    // an "open folder" action opens a directory only and never selects or opens
    // the output file itself.
    open_path(path)
}

fn resolve_open_folder(path: &str) -> Result<std::path::PathBuf, String> {
    if path.contains('\0') {
        return Err("Invalid path".to_string());
    }
    let requested = std::path::PathBuf::from(path);
    if !requested.is_absolute() {
        return Err("Path must be absolute".to_string());
    }
    let canonical = requested
        .canonicalize()
        .map_err(|_| "Path does not exist".to_string())?;
    let metadata = std::fs::metadata(&canonical).map_err(|_| "Path is unavailable".to_string())?;
    let target = if metadata.is_file() {
        canonical
            .parent()
            .map(|parent| parent.to_path_buf())
            .ok_or_else(|| "File has no parent folder".to_string())?
    } else if metadata.is_dir() {
        canonical
    } else {
        return Err("Path must be a file or folder".to_string());
    };
    Ok(target)
}

#[tauri::command]
fn open_path(path: String) -> Result<(), String> {
    let target = resolve_open_folder(&path)?;
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        std::process::Command::new("explorer")
            .arg(&target)
            .creation_flags(0x08000000)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg(&target)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    #[cfg(target_os = "linux")]
    {
        std::process::Command::new("xdg-open")
            .arg(&target)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
fn open_recycle_bin() -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        std::process::Command::new("explorer")
            .arg("shell:RecycleBinFolder")
            .creation_flags(0x08000000)
            .spawn()
            .map_err(|e| e.to_string())?;
        Ok(())
    }
    #[cfg(not(target_os = "windows"))]
    {
        Err("Opening the Recycle Bin is currently available on Windows only.".to_string())
    }
}

#[cfg(test)]
mod external_open_security_tests {
    use super::*;

    #[test]
    fn external_urls_require_web_protocol_host_and_no_credentials() {
        assert!(validate_external_url("https://toolknit.com/changelog.html").is_ok());
        assert!(validate_external_url("http://127.0.0.1:1420/").is_ok());
        assert!(validate_external_url("file:///C:/Windows/System32/calc.exe").is_err());
        assert!(validate_external_url("https://user:secret@example.com/").is_err());
        assert!(validate_external_url("javascript:alert(1)").is_err());
        assert!(validate_external_url("https://example.com/\nnext").is_err());
    }

    #[test]
    fn webviews_can_only_navigate_within_the_packaged_application() {
        assert!(allow_webview_navigation(
            &url::Url::parse("tauri://localhost/index.html").unwrap()
        ));
        assert!(allow_webview_navigation(
            &url::Url::parse("http://tauri.localhost/index.html?screen-picker=1").unwrap()
        ));
        assert!(!allow_webview_navigation(
            &url::Url::parse("https://toolknit.com/").unwrap()
        ));
        assert!(!allow_webview_navigation(
            &url::Url::parse("data:text/html,external").unwrap()
        ));
    }

    #[test]
    fn open_folder_resolution_requires_an_existing_absolute_path() {
        let root = std::env::temp_dir().join(format!(
            "toolknit-open-folder-test-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&root).unwrap();
        let file = root.join("result.pdf");
        std::fs::write(&file, b"test").unwrap();

        assert_eq!(resolve_open_folder(root.to_str().unwrap()).unwrap(), root.canonicalize().unwrap());
        assert_eq!(resolve_open_folder(file.to_str().unwrap()).unwrap(), root.canonicalize().unwrap());
        assert!(resolve_open_folder("relative-output").is_err());
        assert!(resolve_open_folder(root.join("missing").to_str().unwrap()).is_err());

        std::fs::remove_dir_all(root).unwrap();
    }
}

#[cfg(test)]
mod image_color_replace_tests {
    use super::*;

    #[test]
    fn perceptual_distance_and_feather_are_bounded() {
        let white = color_rgb_to_lab([255, 255, 255]);
        assert_eq!(color_delta_e(white, white), 0.0);
        assert_eq!(color_replace_weight(0.0, 20.0, 24.0), 1.0);
        assert_eq!(color_replace_weight(21.0, 20.0, 24.0), 0.0);
        assert!((0.0..=1.0).contains(&color_replace_weight(19.0, 20.0, 24.0)));
    }

    #[test]
    fn smart_and_global_exports_match_the_frontend_fixture() {
        let suffix = hex::encode({ let mut value = [0_u8; 8]; getrandom::getrandom(&mut value).unwrap(); value });
        let root = std::env::temp_dir().join(format!("toolknit-color-replace-test-{}", suffix));
        let output = root.join("output");
        std::fs::create_dir_all(&root).unwrap();
        let input = root.join("fixture.png");
        let bytes = vec![
            255,255,255,255, 255,255,255,255, 0,0,0,255, 255,255,255,255,
            255,255,255,255, 255,255,255,255, 0,0,0,255, 255,255,255,255,
            0,0,0,255,       0,0,0,255,       0,0,0,255, 255,255,255,255,
        ];
        image::RgbaImage::from_raw(4, 3, bytes).unwrap().save(&input).unwrap();
        let options = |smart, name: &str| ColorReplaceOptions {
            app: None,
            operation_id: None,
            input_path: input.to_string_lossy().into_owned(),
            output_dir: output.to_string_lossy().into_owned(),
            output_name: name.to_string(),
            source_rgb: vec![255, 255, 255],
            target_rgb: vec![0, 0, 255],
            threshold: 2.0,
            seed_x: 0,
            seed_y: 0,
            smart,
            softness: 0.0,
            preserve_luminance: false,
            format: "png".to_string(),
            jpeg_quality: 92,
            cancel_token: None,
        };
        let smart = color_replace_blocking(options(true, "smart")).unwrap();
        let global = color_replace_blocking(options(false, "global")).unwrap();
        assert_eq!(smart.changed_pixels, 4);
        assert_eq!(global.changed_pixels, 7);
        let smart_pixels = image::open(smart.output_path).unwrap().to_rgba8();
        assert_eq!(smart_pixels.get_pixel(0, 0).0, [0, 0, 255, 255]);
        assert_eq!(smart_pixels.get_pixel(3, 2).0, [255, 255, 255, 255]);
        let global_pixels = image::open(global.output_path).unwrap().to_rgba8();
        assert_eq!(global_pixels.get_pixel(3, 2).0, [0, 0, 255, 255]);
        std::fs::remove_dir_all(root).unwrap();
    }
}

#[cfg(test)]
mod crypto_tool_tests {
    use super::*;

    #[test]
    fn tkaes_header_helpers_are_deterministic_and_nonce_is_per_chunk() {
        let base = [7_u8; 12];
        assert_ne!(tkaes_nonce(&base, 0), tkaes_nonce(&base, 1));
        assert_eq!(&tkaes_aad(3, 42)[..4], TKAE_MAGIC);
        assert_eq!(tkaes_aad(3, 42).len(), 16);
        assert_eq!(TKAE_VERSION, 2);
        assert_eq!(tkaes_encrypted_stem(std::path::Path::new("document.pdf")), "document.pdf");
        assert_eq!(tkaes_decrypted_stem(std::path::Path::new("document.pdf.tkaes")), "document.pdf");
        assert!(validate_tool_operation_id("123e4567-e89b-12d3-a456-426614174000").is_ok());
        assert!(validate_tool_operation_id("../invalid").is_err());
    }

    #[test]
    fn tkaes_round_trip_preserves_name_and_rejects_wrong_password() {
        let suffix = hex::encode({ let mut value = [0_u8; 8]; getrandom::getrandom(&mut value).unwrap(); value });
        let root = std::env::temp_dir().join(format!("toolknit-tkaes-test-{}", suffix));
        let encrypted_dir = root.join("encrypted");
        let decrypted_dir = root.join("decrypted");
        let rejected_dir = root.join("rejected");
        std::fs::create_dir_all(&root).unwrap();
        let input = root.join("document.txt");
        let payload = b"ToolKnit authenticated file container\n".repeat(64);
        std::fs::write(&input, &payload).unwrap();
        let token = || std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));

        let encrypted = tkaes_encrypt_blocking(None, input.to_string_lossy().into_owned(), encrypted_dir.to_string_lossy().into_owned(), "correct horse battery staple".to_string(), "test-encrypt".to_string(), token()).unwrap();
        assert!(encrypted.output_path.ends_with("document.txt.tkaes"));
        let decrypted = tkaes_decrypt_blocking(None, encrypted.output_path.clone(), decrypted_dir.to_string_lossy().into_owned(), "correct horse battery staple".to_string(), "test-decrypt".to_string(), token()).unwrap();
        assert!(decrypted.output_path.ends_with("document.txt"));
        assert_eq!(std::fs::read(&decrypted.output_path).unwrap(), payload);

        let rejected = tkaes_decrypt_blocking(None, encrypted.output_path, rejected_dir.to_string_lossy().into_owned(), "wrong password".to_string(), "test-reject".to_string(), token());
        assert_eq!(rejected.unwrap_err(), "tkaes:authentication-failed");
        assert!(std::fs::read_dir(&rejected_dir).map(|mut entries| entries.next().is_none()).unwrap_or(true));
        std::fs::remove_dir_all(root).unwrap();
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    system_cleanup::await_previous_instance_for_elevated_relaunch();
    tauri::Builder::default()
        .manage(WindowCornerRadiusState::default())
        .manage(onnx_segmenter::MattingState::default())
        .manage(TeleprompterRecognitionState::default())
        .invoke_handler(tauri::generate_handler![
            open_url,
            ai_provider::request_private_ai_completion,
            store_ai_api_key,
            load_ai_api_key,
            clear_ai_api_key,
            set_window_corner_radius,
            get_documents_dir,
            get_download_dir,
            get_install_lang,
            get_install_config,
            get_output_root,
            get_default_output_root,
            set_output_root,
            list_custom_fonts,
            import_custom_font,
            reset_custom_font,
            import_custom_background,
            clear_custom_background,
            log_custom_background_event,
            get_custom_background_media_url,
            check_transcription_engine,
            start_teleprompter_recognition,
            transcribe_teleprompter_audio,
            stop_teleprompter_recognition,
            onnx_segmenter::list_matting_models,
        onnx_segmenter::set_current_matting_model,
        onnx_segmenter::download_matting_model,
            onnx_segmenter::cancel_matting_model_download,
            onnx_segmenter::delete_matting_model,
            onnx_segmenter::segment_image,
            onnx_segmenter::cancel_matting_segmentation,
            onnx_segmenter::discard_matting_preview,
            onnx_segmenter::export_segmented_image,
        list_transcription_models,
            set_current_transcription_model,
            delete_transcription_model,
            download_transcription_model,
            transcribe_media,
            convert_audio_batch,
            cancel_convert,
            open_path,
            open_recycle_bin,
            reveal_in_folder,
            read_file_bytes,
            read_file_bytes_limited,
            prepare_icon_source_image,
            write_file_bytes,
            write_unique_file_bytes,
            write_unique_file_pair,
            export_markdown_bundle,
            write_file_chunk,
            begin_icon_archive_write,
            append_icon_archive_chunk,
            finalize_icon_archive_write,
            discard_icon_archive_write,
            begin_pdf_enhance_write,
            append_pdf_enhance_chunk,
            finalize_pdf_enhance_write,
            discard_pdf_enhance_write,
            exists_path,
            get_file_size,
            get_hardware_overview,
            get_cpu_memory_info,
            get_cpu_memory_live_stats,
            get_gpu_display_info,
            get_mainboard_firmware_info,
            get_storage_health_info,
            get_network_devices_info,
            get_power_sensors_info,
            scan_large_files,
            get_cleanup_drive_space,
            move_files_to_recycle_bin,
            encrypt_pdf,
            decrypt_pdf,
            compress_pdf,
            trim_audio,
            probe_video,
            render_video_preview_frame,
            render_video_preview_clip,
            extract_audio,
            extract_video_frame,
            extract_video_gif,
            check_ffmpeg,
            get_ffmpeg_runtime_status,
            download_ffmpeg_runtime,
            delete_ffmpeg_runtime,
            get_libreoffice_runtime_status,
            is_libreoffice_runtime_available,
            download_libreoffice_runtime,
            delete_libreoffice_runtime,
            cancel_dependency_downloads,
            convert_image_batch,
            compress_image_batch,
            crop_image,
            export_replaced_image,
            hash_file,
            cancel_tool_operation,
            encrypt_tkaes_file,
            decrypt_tkaes_file,
            rsa_legacy_windows::rsa_legacy_operation,
            inspect_image_stitch_inputs,
            create_image_stitch_pdf_session,
            write_image_stitch_pdf_page,
            discard_image_stitch_pdf_session,
            stitch_images,
            create_pdf_to_image_session,
            read_pdf_to_image_source,
            write_pdf_to_image_page,
            write_pdf_to_image_page_json,
            discard_pdf_to_image_session,
            cancel_pdf_to_image,
            export_pdf_to_images,
            convert_ppt_to_pdf,
            convert_excel_to_pdf,
            convert_video_batch,
            set_tray_lang,
            screen_picker_bounds,
            screen_color_sample,
            open_screen_color_picker,
            close_screen_color_picker,
            get_screen_picker_shortcut,
            set_screen_picker_shortcut,
            system_cleanup::system_cleanup_is_admin,
            system_cleanup::system_cleanup_relaunch_as_admin,
            system_cleanup::system_cleanup_scan,
            system_cleanup::system_cleanup_run,
        ])
        .plugin(tauri_plugin_dialog::init())
        .plugin(
            tauri::plugin::Builder::<tauri::Wry>::new("navigation-guard")
                .on_navigation(|_webview, url| allow_webview_navigation(url))
                .build(),
        )
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            show_main_window(app);
        }))
        .on_window_event(|window, event| {
            if window.label() == "main"
                && matches!(
                    event,
                    tauri::WindowEvent::Resized(_) | tauri::WindowEvent::ScaleFactorChanged { .. }
                )
            {
                if let Some(webview_window) = window.app_handle().get_webview_window(window.label())
                {
                    schedule_native_window_corner_radius_reapply(webview_window);
                }
            }
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                match window.label() {
                    // The main window intentionally follows the conventional
                    // close-to-tray behavior used by ToolKnit.
                    "main" => {
                        api.prevent_close();
                        let _ = window.hide();
                    }
                    // The picker minimizes the main window while it is active.
                    // A system close request (Alt+F4, taskbar command, etc.)
                    // must restore the application instead of leaving both
                    // windows hidden.
                    "color-picker-overlay" => {
                        api.prevent_close();
                        let _ = window.hide();
                        show_main_window(window.app_handle());
                    }
                    // Do not globally suppress close behavior for future
                    // auxiliary windows. They should retain their own normal
                    // lifecycle unless they opt into one explicitly.
                    _ => {}
                }
            }
        })
        .setup(|app| {
            cleanup_image_stitch_pdf_sessions();
            cleanup_pdf_to_image_sessions();
            app.handle().plugin(
                tauri_plugin_log::Builder::default()
                    .level(log::LevelFilter::Info)
                    .build(),
            )?;

            // 系统托盘
            let lang = read_initial_lang();
            let menu = build_tray_menu(app.handle(), &lang)?;

            let _tray = tauri::tray::TrayIconBuilder::with_id("main-tray")
                .icon(app.default_window_icon().unwrap().clone())
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "show" => {
                        show_main_window(app);
                    }
                    "quit" => {
                        app.exit(0);
                    }
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let tauri::tray::TrayIconEvent::Click {
                        button,
                        button_state,
                        ..
                    } = event
                    {
                        if button == tauri::tray::MouseButton::Left
                            && button_state == tauri::tray::MouseButtonState::Up
                        {
                            show_main_window(tray.app_handle());
                        }
                    }
                })
                .build(app)?;

            // 同步置顶状态到托盘菜单（可选）
            if let Some(window) = app.get_webview_window("main") {
                if let Err(error) = fit_main_window_to_work_area(&window) {
                    log::warn!("Unable to fit main window to monitor work area: {error}");
                }
                let _ = window.set_always_on_top(false);
            }

            // 注册屏幕取色全局快捷键（如果用户已配置）。
            let shortcut_config = load_screen_picker_shortcut_config();
            if let Some(shortcut) = shortcut_config.shortcut.as_deref() {
                if !shortcut.trim().is_empty() {
                    let _ = register_screen_picker_shortcut(app.handle(), shortcut);
                }
            }

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

fn show_main_window(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

fn minimize_main_window(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.minimize();
    }
}


#[cfg(test)]
mod simplify_tests {
    use super::*;

    #[test]
    fn simplify_converts_common_whisper_variants() {
        let converted = simplify_chinese_text("旗艦模型升級，創作與理解能力。");
        assert_eq!(converted, "旗舰模型升级，创作与理解能力。");
        assert_eq!(simplify_chinese_text("English stays untouched 123"), "English stays untouched 123");
    }

    #[test]
    fn simplify_transcription_outputs_rewrites_temp_files() {
        let dir = std::env::temp_dir().join(format!("toolknit-simplify-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        for name in ["transcript.json", "transcript.srt", "transcript.txt"] {
            std::fs::write(dir.join(name), format!("{name}}}: 旗艦模型升級 {{}}")).unwrap();
        }
        simplify_transcription_outputs(&dir).unwrap();
        let txt = std::fs::read_to_string(dir.join("transcript.txt")).unwrap();
        assert!(txt.contains("旗舰模型升级"));
        let json = std::fs::read_to_string(dir.join("transcript.json")).unwrap();
        assert!(json.starts_with("transcript.json}:"));
        for name in ["transcript.json", "transcript.srt", "transcript.txt"] {
            let _ = std::fs::remove_file(dir.join(name));
        }
        let _ = std::fs::remove_dir(&dir);
    }
}
