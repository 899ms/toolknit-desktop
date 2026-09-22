//! UI-thread-owned, noninteractive companion surface. No WebView or polling.
use super::Shape;
use std::{cell::RefCell, mem::size_of, sync::OnceLock};
use windows::{
    core::{w, GUID},
    Win32::{
        Foundation::{COLORREF, HINSTANCE, HWND, LPARAM, LRESULT, POINT, SIZE, WPARAM},
        Graphics::{
            Dwm::{DwmGetWindowAttribute, DWMWA_CLOAKED},
            Gdi::*,
        },
        System::{
            Com::{CoCreateInstance, CLSCTX_INPROC_SERVER},
            LibraryLoader::GetModuleHandleW,
        },
        UI::{
            Accessibility::{SetWinEventHook, UnhookWinEvent, HWINEVENTHOOK},
            HiDpi::GetDpiForWindow,
            Shell::{
                DefSubclassProc, GetWindowSubclass, IVirtualDesktopManager, RemoveWindowSubclass,
                SetWindowSubclass, VirtualDesktopManager,
            },
            WindowsAndMessaging::*,
        },
    },
};

const SUBCLASS_ID: usize = 0x544b5348;
const SYNC_DESKTOP: u32 = WM_APP + 0x534;
const CLASS_NAME: windows::core::PCWSTR = w!("ToolKnit.RoundedShadow");

struct Shadow {
    hwnd: HWND,
    radius: u32,
    enabled: bool,
    shape: Option<Shape>,
    hook: HWINEVENTHOOK,
    desktops: Option<IVirtualDesktopManager>,
    desktop: Option<GUID>,
    desktop_dirty: bool,
}

impl Drop for Shadow {
    fn drop(&mut self) {
        unsafe {
            let _ = UnhookWinEvent(self.hook);
            let _ = DestroyWindow(self.hwnd);
        }
    }
}

unsafe extern "system" fn shadow_proc(
    hwnd: HWND,
    message: u32,
    wparam: WPARAM,
    lparam: LPARAM,
) -> LRESULT {
    match message {
        WM_NCHITTEST => LRESULT(HTTRANSPARENT as isize),
        WM_MOUSEACTIVATE => LRESULT(MA_NOACTIVATE as isize),
        _ => DefWindowProcW(hwnd, message, wparam, lparam),
    }
}

fn create_surface() -> Result<HWND, String> {
    static REGISTERED: OnceLock<Result<(), String>> = OnceLock::new();
    REGISTERED
        .get_or_init(|| unsafe {
            let instance = HINSTANCE(GetModuleHandleW(None).map_err(|e| e.to_string())?.0);
            let class = WNDCLASSW {
                lpfnWndProc: Some(shadow_proc),
                hInstance: instance,
                lpszClassName: CLASS_NAME,
                ..Default::default()
            };
            if RegisterClassW(&class) == 0 {
                return Err("Unable to register shadow surface".into());
            }
            Ok(())
        })
        .clone()?;
    unsafe {
        let hwnd = CreateWindowExW(
            WS_EX_LAYERED | WS_EX_TRANSPARENT | WS_EX_NOACTIVATE | WS_EX_TOOLWINDOW,
            CLASS_NAME,
            w!(""),
            WS_POPUP,
            0,
            0,
            1,
            1,
            HWND::default(),
            None,
            HINSTANCE(GetModuleHandleW(None).map_err(|e| e.to_string())?.0),
            None,
        );
        if hwnd.0 == 0 {
            Err("Unable to create shadow surface".into())
        } else {
            Ok(hwnd)
        }
    }
}

struct BitmapDc {
    dc: HDC,
    bitmap: HBITMAP,
    previous: HGDIOBJ,
}
impl Drop for BitmapDc {
    fn drop(&mut self) {
        unsafe {
            SelectObject(self.dc, self.previous);
            let _ = DeleteObject(self.bitmap);
            let _ = DeleteDC(self.dc);
        }
    }
}

fn paint(hwnd: HWND, shape: Shape, position: POINT) -> Result<(), String> {
    let (width, height, _) = shape.dimensions()?;
    let pixels = shape.raster()?;
    unsafe {
        let dc = CreateCompatibleDC(HDC::default());
        if dc.0 == 0 {
            return Err("Unable to create shadow device context".into());
        }
        let info = BITMAPINFO {
            bmiHeader: BITMAPINFOHEADER {
                biSize: size_of::<BITMAPINFOHEADER>() as u32,
                biWidth: width as i32,
                biHeight: -(height as i32),
                biPlanes: 1,
                biBitCount: 32,
                biCompression: BI_RGB.0,
                ..Default::default()
            },
            ..Default::default()
        };
        let mut bits = std::ptr::null_mut();
        let bitmap = match CreateDIBSection(dc, &info, DIB_RGB_COLORS, &mut bits, None, 0) {
            Ok(bitmap) => bitmap,
            Err(error) => {
                let _ = DeleteDC(dc);
                return Err(error.to_string());
            }
        };
        let previous = SelectObject(dc, bitmap);
        let surface = BitmapDc {
            dc,
            bitmap,
            previous,
        };
        if bits.is_null() {
            return Err("Unable to map shadow bitmap".into());
        }
        std::ptr::copy_nonoverlapping(pixels.as_ptr(), bits as *mut u8, pixels.len());
        let size = SIZE {
            cx: width as i32,
            cy: height as i32,
        };
        let blend = BLENDFUNCTION {
            BlendOp: AC_SRC_OVER as u8,
            BlendFlags: 0,
            SourceConstantAlpha: 255,
            AlphaFormat: AC_SRC_ALPHA as u8,
        };
        UpdateLayeredWindow(
            hwnd,
            HDC::default(),
            Some(&position),
            Some(&size),
            surface.dc,
            Some(&POINT::default()),
            COLORREF(0),
            Some(&blend),
            ULW_ALPHA,
        )
        .map_err(|e| e.to_string())
    }
}

impl Shadow {
    fn sync(&mut self, main: HWND) -> Result<(), String> {
        unsafe {
            let mut cloaked = 0_u32;
            let _ = DwmGetWindowAttribute(
                main,
                DWMWA_CLOAKED,
                &mut cloaked as *mut u32 as _,
                size_of::<u32>() as u32,
            );
            if !self.enabled
                || !IsWindowVisible(main).as_bool()
                || IsIconic(main).as_bool()
                || IsZoomed(main).as_bool()
                || cloaked != 0
            {
                let _ = ShowWindow(self.hwnd, SW_HIDE);
                return Ok(());
            }
            let mut rect = Default::default();
            GetClientRect(main, &mut rect).map_err(|e| e.to_string())?;
            let mut origin = POINT::default();
            if !ClientToScreen(main, &mut origin).as_bool() {
                return Err("Unable to locate shadow owner".into());
            }
            let width = (rect.right - rect.left).max(0) as u32;
            let height = (rect.bottom - rect.top).max(0) as u32;
            let mut monitor = MONITORINFO {
                cbSize: size_of::<MONITORINFO>() as u32,
                ..Default::default()
            };
            if GetMonitorInfoW(
                MonitorFromWindow(main, MONITOR_DEFAULTTONEAREST),
                &mut monitor,
            )
            .as_bool()
                && origin.x <= monitor.rcMonitor.left
                && origin.y <= monitor.rcMonitor.top
                && origin.x + width as i32 >= monitor.rcMonitor.right
                && origin.y + height as i32 >= monitor.rcMonitor.bottom
            {
                let _ = ShowWindow(self.hwnd, SW_HIDE);
                return Ok(());
            }
            if self.desktop_dirty {
                if let Some(manager) = &self.desktops {
                    if let Ok(desktop) = manager.GetWindowDesktopId(main) {
                        if desktop != GUID::zeroed() && self.desktop != Some(desktop) {
                            if manager.GetWindowDesktopId(self.hwnd).ok() != Some(desktop) {
                                manager
                                    .MoveWindowToDesktop(self.hwnd, &desktop)
                                    .map_err(|e| e.to_string())?;
                            }
                            self.desktop = Some(desktop);
                        }
                    }
                }
                self.desktop_dirty = false;
            }
            let shape = Shape {
                width,
                height,
                radius: self.radius,
                dpi: GetDpiForWindow(main).max(96),
            };
            let padding = shape.padding() as i32;
            let position = POINT {
                x: origin.x - padding,
                y: origin.y - padding,
            };
            let (width, height, _) = shape.dimensions()?;
            if self.shape != Some(shape) {
                paint(self.hwnd, shape, position)?;
                self.shape = Some(shape);
            }
            // A sibling directly BELOW the owner, never topmost and never an
            // owned popup (Win32 owned popups would stay ABOVE their owner).
            SetWindowPos(
                self.hwnd,
                main,
                position.x,
                position.y,
                width as i32,
                height as i32,
                SWP_NOACTIVATE | SWP_SHOWWINDOW | SWP_NOOWNERZORDER,
            )
            .map_err(|e| e.to_string())
        }
    }
}

// UI-thread only. The returned reference must not outlive the HWND or be kept
// across owner destruction; all production callers use it in this dispatch.
unsafe fn state<'a>(main: HWND) -> Option<&'a RefCell<Shadow>> {
    let mut data = 0;
    if GetWindowSubclass(main, Some(owner_proc), SUBCLASS_ID, Some(&mut data)).as_bool()
        && data != 0
    {
        Some(&*(data as *const RefCell<Shadow>))
    } else {
        None
    }
}

unsafe extern "system" fn desktop_event(
    _hook: HWINEVENTHOOK,
    _event: u32,
    hwnd: HWND,
    _object: i32,
    _child: i32,
    _thread: u32,
    _time: u32,
) {
    if state(hwnd).is_some() {
        let _ = PostMessageW(hwnd, SYNC_DESKTOP, WPARAM(0), LPARAM(0));
    }
}

unsafe extern "system" fn owner_proc(
    main: HWND,
    message: u32,
    wparam: WPARAM,
    lparam: LPARAM,
    _id: usize,
    data: usize,
) -> LRESULT {
    if message == WM_NCDESTROY {
        let _ = RemoveWindowSubclass(main, Some(owner_proc), SUBCLASS_ID);
        drop(Box::from_raw(data as *mut RefCell<Shadow>));
        return DefSubclassProc(main, message, wparam, lparam);
    }
    let result = DefSubclassProc(main, message, wparam, lparam);
    if matches!(
        message,
        WM_WINDOWPOSCHANGED
            | WM_SHOWWINDOW
            | WM_SIZE
            | WM_DPICHANGED
            | WM_DISPLAYCHANGE
            | SYNC_DESKTOP
    ) {
        if let Some(cell) = state(main) {
            // Native positioning may synchronously reenter the owner's proc.
            if let Ok(mut shadow) = cell.try_borrow_mut() {
                if message == WM_DISPLAYCHANGE {
                    shadow.shape = None;
                }
                if message == SYNC_DESKTOP {
                    shadow.desktop_dirty = true;
                }
                if shadow.sync(main).is_err() {
                    let _ = ShowWindow(shadow.hwnd, SW_HIDE);
                }
            }
        }
    }
    result
}

/// Must be called on the thread that created `main`; state dies with that HWND.
pub(crate) fn configure(main: HWND, radius: u32, enabled: Option<bool>) -> Result<(), String> {
    unsafe {
        if state(main).is_none() {
            if enabled != Some(true) {
                return Ok(());
            }
            let hwnd = create_surface()?;
            let hook = SetWinEventHook(
                EVENT_OBJECT_CLOAKED,
                EVENT_OBJECT_UNCLOAKED,
                None,
                Some(desktop_event),
                std::process::id(),
                0,
                WINEVENT_OUTOFCONTEXT,
            );
            if hook.0 == 0 {
                let _ = DestroyWindow(hwnd);
                return Err("Unable to observe virtual desktop visibility".into());
            }
            let shadow = Box::new(RefCell::new(Shadow {
                hwnd,
                radius,
                enabled: false,
                shape: None,
                hook,
                desktops: CoCreateInstance(&VirtualDesktopManager, None, CLSCTX_INPROC_SERVER).ok(),
                desktop: None,
                desktop_dirty: true,
            }));
            let data = Box::into_raw(shadow);
            if !SetWindowSubclass(main, Some(owner_proc), SUBCLASS_ID, data as usize).as_bool() {
                drop(Box::from_raw(data));
                return Err("Unable to observe shadow owner".into());
            }
        }
        let cell = state(main).ok_or("Shadow owner is unavailable")?;
        let mut shadow = cell
            .try_borrow_mut()
            .map_err(|_| "Shadow update is already active")?;
        shadow.radius = radius.min(32);
        shadow.desktop_dirty = true;
        if let Some(enabled) = enabled {
            shadow.enabled = enabled;
        }
        if let Err(error) = shadow.sync(main) {
            let _ = ShowWindow(shadow.hwnd, SW_HIDE);
            return Err(error);
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use windows::Win32::Graphics::Dwm::{DwmSetWindowAttribute, DWMWA_CLOAK};
    use windows::Win32::System::Com::{CoInitializeEx, CoUninitialize, COINIT_APARTMENTTHREADED};

    struct Apartment;
    impl Drop for Apartment {
        fn drop(&mut self) {
            unsafe {
                CoUninitialize();
            }
        }
    }

    struct TestWindow(HWND);
    impl Drop for TestWindow {
        fn drop(&mut self) {
            unsafe {
                let _ = DestroyWindow(self.0);
            }
        }
    }

    #[test]
    fn native_shadow_tracks_owner_without_focus_or_input() {
        // Real HWNDs entirely offscreen; never open a visible development UI.
        unsafe {
            CoInitializeEx(None, COINIT_APARTMENTTHREADED).ok().unwrap();
            let _apartment = Apartment;
            let main = CreateWindowExW(
                WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE,
                w!("STATIC"),
                w!(""),
                WS_POPUP,
                -20000,
                -20000,
                320,
                200,
                HWND::default(),
                None,
                None,
                None,
            );
            assert_ne!(main.0, 0);
            let owner = TestWindow(main);
            configure(main, 18, Some(false)).unwrap();
            assert!(
                state(main).is_none(),
                "dark startup does not create a surface"
            );
            configure(main, 18, Some(true)).unwrap();
            assert!(
                state(main).unwrap().borrow().desktops.is_some(),
                "test the actual shell COM adapter, not only the fallback"
            );
            let shadow = state(main).unwrap().borrow().hwnd;
            assert!(!IsWindowVisible(shadow).as_bool());
            let _ = ShowWindow(main, SW_SHOWNOACTIVATE);
            assert!(IsWindowVisible(shadow).as_bool());
            assert_ne!(GetForegroundWindow(), main);
            assert_ne!(GetForegroundWindow(), shadow);
            assert_eq!(
                GetWindow(main, GW_HWNDNEXT),
                shadow,
                "shadow is directly behind its owner"
            );
            let ex_style = GetWindowLongW(shadow, GWL_EXSTYLE) as u32;
            assert_ne!(ex_style & WS_EX_TOOLWINDOW.0, 0);
            assert_ne!(ex_style & WS_EX_NOACTIVATE.0, 0);
            assert_ne!(ex_style & WS_EX_TRANSPARENT.0, 0);
            assert_eq!(ex_style & WS_EX_TOPMOST.0, 0);
            assert_eq!(
                SendMessageW(shadow, WM_NCHITTEST, WPARAM(0), LPARAM(0)),
                LRESULT(HTTRANSPARENT as isize)
            );
            let original = state(main).unwrap().borrow().shape.unwrap();
            SetWindowPos(
                main,
                HWND::default(),
                -19000,
                -19500,
                400,
                250,
                SWP_NOACTIVATE | SWP_NOZORDER,
            )
            .unwrap();
            let updated = state(main).unwrap().borrow().shape.unwrap();
            assert_ne!(original, updated);
            let mut bounds = Default::default();
            GetWindowRect(shadow, &mut bounds).unwrap();
            assert_eq!(bounds.left, -19000 - updated.padding() as i32);
            assert_eq!(bounds.top, -19500 - updated.padding() as i32);
            assert_eq!(
                bounds.right - bounds.left,
                updated.dimensions().unwrap().0 as i32
            );
            configure(main, 32, None).unwrap();
            assert_eq!(state(main).unwrap().borrow().shape.unwrap().radius, 32);
            configure(main, 10, Some(false)).unwrap();
            assert!(!IsWindowVisible(shadow).as_bool());
            configure(main, 10, Some(true)).unwrap();
            assert!(IsWindowVisible(shadow).as_bool());
            for cloaked in [1_u32, 0] {
                DwmSetWindowAttribute(
                    main,
                    DWMWA_CLOAK,
                    &cloaked as *const u32 as _,
                    size_of::<u32>() as u32,
                )
                .unwrap();
                SendMessageW(main, SYNC_DESKTOP, WPARAM(0), LPARAM(0));
                assert_eq!(
                    IsWindowVisible(shadow).as_bool(),
                    cloaked == 0,
                    "DWM cloaking cannot leave an orphaned shadow"
                );
            }
            let _ = ShowWindow(main, SW_HIDE);
            assert!(
                !IsWindowVisible(shadow).as_bool(),
                "close-to-tray also hides shadow"
            );
            let _ = ShowWindow(main, SW_SHOWNOACTIVATE);
            assert!(IsWindowVisible(shadow).as_bool());
            let _ = ShowWindow(main, SW_SHOWMINNOACTIVE);
            assert!(
                !IsWindowVisible(shadow).as_bool(),
                "minimization cannot orphan the shadow"
            );
            drop(owner);
            assert!(
                !IsWindow(shadow).as_bool(),
                "owner destruction frees the native surface"
            );
        }
    }
}
