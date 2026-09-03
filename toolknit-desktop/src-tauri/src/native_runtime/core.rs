
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

