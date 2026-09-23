pub(crate) static CUSTOM_BACKGROUND_SERVER_PORT: OnceLock<u16> = OnceLock::new();
pub(crate) static CUSTOM_BACKGROUND_SERVER_TOKEN: OnceLock<String> = OnceLock::new();
pub(crate) static CUSTOM_BACKGROUND_SERVER_INIT_LOCK: OnceLock<std::sync::Mutex<()>> = OnceLock::new();
pub(crate) static CUSTOM_BACKGROUND_IMPORT_LOCK: OnceLock<std::sync::Mutex<()>> = OnceLock::new();

#[cfg(target_os = "windows")]
pub(crate) const CREATE_NO_WINDOW: u32 = 0x08000000;

/// The selected logical corner radius for the primary native window.
///
/// CSS can round the webview contents, but it cannot remove the rectangular
/// Win32 window that hosts those contents. Keep the value in Rust as well so
/// the native clipping region can be rebuilt after resizing or moving between
/// displays with a different DPI scale.
#[derive(Default)]
pub(crate) struct WindowCornerRadiusState {
    pub(crate) radius: std::sync::Mutex<u32>,
    pub(crate) reapply_generation: std::sync::atomic::AtomicU64,
}
pub(crate) const MAX_WINDOW_CORNER_RADIUS: u32 = 32;

pub(crate) const MAIN_WINDOW_MIN_WIDTH: f64 = 720.0;
pub(crate) const MAIN_WINDOW_MIN_HEIGHT: f64 = 480.0;
pub(crate) const MAIN_WINDOW_MAX_WIDTH: f64 = 1400.0;
pub(crate) const MAIN_WINDOW_MAX_HEIGHT: f64 = 900.0;
pub(crate) const MAIN_WINDOW_SAFE_MARGIN: f64 = 32.0;

#[derive(Clone, serde::Serialize)]
pub(crate) struct ScreenPickerBounds {
    pub(crate) x: i32,
    pub(crate) y: i32,
    pub(crate) width: u32,
    pub(crate) height: u32,
}

#[derive(Clone, serde::Serialize)]
pub(crate) struct ScreenColorSample {
    pub(crate) x: i32,
    pub(crate) y: i32,
    pub(crate) width: u32,
    pub(crate) height: u32,
    pub(crate) pixels: Vec<u8>,
    pub(crate) hex: String,
    pub(crate) rgb: String,
}

pub(crate) const DEFAULT_SCREEN_PICKER_SHORTCUT: &str = "Ctrl+Shift+C";

#[derive(Clone, serde::Serialize, serde::Deserialize)]
pub(crate) struct ScreenPickerShortcutConfig {
    pub(crate) shortcut: Option<String>,
}

impl Default for ScreenPickerShortcutConfig {
    fn default() -> Self {
        Self {
            shortcut: Some(DEFAULT_SCREEN_PICKER_SHORTCUT.to_string()),
        }
    }
}

#[derive(serde::Serialize)]
pub(crate) struct ScreenPickerShortcutInfo {
    pub(crate) value: String,
    pub(crate) default: String,
    pub(crate) enabled: bool,
}

pub(crate) fn screen_picker_shortcut_path() -> Result<std::path::PathBuf, String> {
    Ok(toolknit_app_data_dir()?.join("screen-picker-shortcut.json"))
}

pub(crate) fn load_screen_picker_shortcut_config() -> ScreenPickerShortcutConfig {
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

pub(crate) fn save_screen_picker_shortcut_config(config: &ScreenPickerShortcutConfig) -> Result<(), String> {
    let path = screen_picker_shortcut_path()?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    let bytes = serde_json::to_vec_pretty(config).map_err(|error| error.to_string())?;
    std::fs::write(path, bytes).map_err(|error| error.to_string())
}

pub(crate) fn register_screen_picker_shortcut(
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
pub(crate) fn append_picker_debug(line: &str) {
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
pub(crate) fn append_picker_debug(_line: &str) {}

#[cfg(target_os = "windows")]
pub(crate) fn screen_picker_bounds_impl() -> Result<ScreenPickerBounds, String> {
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
pub(crate) fn screen_picker_bounds_impl() -> Result<ScreenPickerBounds, String> {
    Err("屏幕取色目前仅支持 Windows".to_string())
}

#[cfg(target_os = "windows")]
pub(crate) fn screen_color_sample_impl(x: i32, y: i32) -> Result<ScreenColorSample, String> {
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
pub(crate) fn screen_color_sample_impl(_x: i32, _y: i32) -> Result<ScreenColorSample, String> {
    Err("屏幕取色目前仅支持 Windows".to_string())
}

#[tauri::command]
pub(crate) fn screen_picker_bounds() -> Result<ScreenPickerBounds, String> {
    screen_picker_bounds_impl()
}

#[tauri::command]
pub(crate) fn screen_color_sample(x: i32, y: i32) -> Result<ScreenColorSample, String> {
    screen_color_sample_impl(x, y)
}

#[tauri::command]
pub(crate) async fn open_screen_color_picker(app: tauri::AppHandle) -> Result<ScreenPickerBounds, String> {
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

pub(crate) async fn launch_screen_color_picker(app: &tauri::AppHandle) -> Result<ScreenPickerBounds, String> {
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
pub(crate) fn close_screen_color_picker(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("color-picker-overlay") {
        window.hide().map_err(|error| error.to_string())?;
    }
    show_main_window(&app);
    Ok(())
}

#[tauri::command]
pub(crate) fn get_screen_picker_shortcut() -> Result<ScreenPickerShortcutInfo, String> {
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
pub(crate) fn set_screen_picker_shortcut(
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
pub(crate) static TEST_CONVERSION_LOCK: OnceLock<std::sync::Mutex<()>> = OnceLock::new();

#[cfg(test)]
pub(crate) fn test_conversion_lock() -> std::sync::MutexGuard<'static, ()> {
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
