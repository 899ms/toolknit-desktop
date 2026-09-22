mod store;
mod types;
#[cfg(target_os = "windows")]
mod windows;

use std::sync::{
    atomic::{AtomicBool, AtomicU64, AtomicU8, Ordering},
    Arc, Mutex,
};
use tauri::{Emitter, Manager};
use types::*;

#[derive(Default)]
pub(crate) struct ClipboardHistoryState {
    service: Mutex<Option<Arc<Service>>>,
    tray: Mutex<Option<(tauri::menu::MenuItem<tauri::Wry>, String)>>,
    exit_phase: AtomicU8,
}
struct Service {
    store: Mutex<store::Store>,
    settings: Arc<Mutex<Settings>>,
    status: Mutex<Status>,
    generation: Arc<AtomicU64>,
    query_revision: AtomicU64,
    closing: AtomicBool,
    last_pruned: AtomicU64,
    transition: Mutex<()>,
    dropped: Arc<AtomicU64>,
    app: tauri::AppHandle,
    #[cfg(target_os = "windows")]
    monitor: Mutex<Option<windows::Monitor>>,
    #[cfg(target_os = "windows")]
    sender: Mutex<Option<std::sync::mpsc::SyncSender<windows::Notice>>>,
    #[cfg(target_os = "windows")]
    worker: Mutex<Option<std::thread::JoinHandle<()>>>,
}
fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|e| e.into_inner())
}

impl ClipboardHistoryState {
    fn get(&self, app: &tauri::AppHandle) -> Result<Arc<Service>, String> {
        let mut slot = lock(&self.service);
        if self.exit_phase.load(Ordering::Acquire) != 0 {
            return Err("clipboard:cancelled".into());
        }
        if let Some(service) = slot.as_ref() {
            return Ok(service.clone());
        }
        let directory = app
            .path()
            .app_local_data_dir()
            .map_err(|_| "clipboard:storage-failed")?
            .join("clipboard-history");
        let store = store::Store::open(&directory)?;
        let settings = store.settings()?;
        let service = Arc::new(Service {
            store: Mutex::new(store),
            settings: Arc::new(Mutex::new(settings)),
            status: Mutex::new(Status::default()),
            generation: Arc::new(AtomicU64::new(0)),
            query_revision: AtomicU64::new(0),
            closing: AtomicBool::new(false),
            last_pruned: AtomicU64::new(0),
            transition: Mutex::new(()),
            dropped: Arc::new(AtomicU64::new(0)),
            app: app.clone(),
            #[cfg(target_os = "windows")]
            monitor: Mutex::new(None),
            #[cfg(target_os = "windows")]
            sender: Mutex::new(None),
            #[cfg(target_os = "windows")]
            worker: Mutex::new(None),
        });
        #[cfg(target_os = "windows")]
        service.create_worker()?;
        *slot = Some(service.clone());
        Ok(service)
    }
    pub(crate) fn enabled(&self) -> bool {
        lock(&self.service)
            .as_ref()
            .is_some_and(|s| lock(&s.status).enabled)
    }
    pub(crate) fn register_tray(&self, item: tauri::menu::MenuItem<tauri::Wry>, lang: &str) {
        *lock(&self.tray) = Some((item, lang.into()));
    }
    fn update_tray(&self, enabled: bool) {
        let tray = lock(&self.tray).clone();
        if let Some((item, lang)) = tray {
            let _ = item.set_text(match (lang == "zh", enabled) {
                (true, true) => "剪贴板监控：暂停记录",
                (true, false) => "剪贴板监控：开启记录",
                (false, true) => "Clipboard: pause recording",
                (false, false) => "Clipboard: start recording",
            });
        }
    }
}
impl Service {
    #[cfg(target_os = "windows")]
    fn create_worker(self: &Arc<Self>) -> Result<(), String> {
        let (sender, receiver) = std::sync::mpsc::sync_channel(2);
        let weak = Arc::downgrade(self);
        let worker = std::thread::Builder::new()
            .name("clipboard-storage".into())
            .spawn(move || {
                while let Ok(notice) = receiver.recv() {
                    let Some(service) = weak.upgrade() else {
                        break;
                    };
                    match notice {
                        windows::Notice::Capture(capture) => {
                            if capture.generation != service.generation.load(Ordering::Acquire) {
                                continue;
                            }
                            let result = windows::normalize(capture.raw).and_then(|content| {
                                let store = lock(&service.store);
                                if capture.generation != service.generation.load(Ordering::Acquire)
                                    || !lock(&service.status).enabled
                                {
                                    return Err("clipboard:cancelled".into());
                                }
                                store.insert(
                                    &content,
                                    capture.source,
                                    capture.timestamp,
                                    capture.offset,
                                    &lock(&service.settings),
                                )
                            });
                            let mut status = lock(&service.status);
                            match result {
                                Ok(_) => {
                                    status.captured += 1;
                                    status.last_error = None;
                                }
                                Err(error) if error == "clipboard:cancelled" => continue,
                                Err(error) => {
                                    status.failed += 1;
                                    status.last_error = Some(error.clone());
                                    if error == "clipboard:capacity"
                                        || error == "clipboard:storage-failed"
                                    {
                                        status.enabled = false;
                                        service.generation.fetch_add(1, Ordering::AcqRel);
                                    }
                                }
                            }
                        }
                        windows::Notice::Skipped => lock(&service.status).skipped += 1,
                        windows::Notice::Failed(error) => {
                            let mut status = lock(&service.status);
                            status.failed += 1;
                            status.last_error = Some(error.into());
                        }
                    }
                    service.changed();
                }
            })
            .map_err(|_| "clipboard:listener-failed")?;
        *lock(&self.sender) = Some(sender);
        *lock(&self.worker) = Some(worker);
        Ok(())
    }
    fn changed(&self) {
        if self.closing.load(Ordering::Acquire) {
            return;
        }
        let revision = {
            let mut status = lock(&self.status);
            status.revision += 1;
            status.revision
        };
        let _ = self
            .app
            .emit_to("main", "clipboard-history-changed", revision);
        let enabled = lock(&self.status).enabled;
        self.app
            .state::<ClipboardHistoryState>()
            .update_tray(enabled);
        if !enabled {
            let _ = self.persist_resume();
        }
        if let Some(tray) = self.app.tray_by_id("main-tray") {
            let _ = tray.set_tooltip(Some(if enabled {
                "ToolKnit · Clipboard ON"
            } else {
                "ToolKnit · Clipboard OFF"
            }));
        }
    }
    fn persist_resume(&self) -> Result<(), String> {
        let resume = lock(&self.settings).resume_on_launch && lock(&self.status).enabled;
        let path = lock(&self.store).directory.join("resume.json");
        std::fs::write(
            path,
            if resume {
                b"true".as_slice()
            } else {
                b"false".as_slice()
            },
        )
        .map_err(|_| "clipboard:storage-failed".into())
    }
    fn persist_and_notify(&self) -> Result<(), String> {
        let result = self.persist_resume();
        if let Err(error) = &result {
            self.stop_inner();
            lock(&self.status).last_error = Some(error.clone());
        }
        self.changed();
        result
    }
    fn start(&self) -> Result<(), String> {
        let _transition = lock(&self.transition);
        if self.closing.load(Ordering::Acquire) {
            return Err("clipboard:cancelled".into());
        }
        if lock(&self.status).enabled {
            return Ok(());
        }
        #[cfg(not(target_os = "windows"))]
        return Err("clipboard:desktop-only".into());
        #[cfg(target_os = "windows")]
        {
            if let Some(mut previous) = lock(&self.monitor).take() {
                previous.stop();
            }
            lock(&self.store).prune(&lock(&self.settings))?;
            self.generation.fetch_add(1, Ordering::AcqRel);
            let sender = lock(&self.sender)
                .as_ref()
                .ok_or("clipboard:listener-failed")?
                .clone();
            let monitor = windows::Monitor::start(
                sender,
                self.settings.clone(),
                self.generation.clone(),
                self.dropped.clone(),
            )?;
            *lock(&self.monitor) = Some(monitor);
            {
                let mut status = lock(&self.status);
                status.enabled = true;
                status.started_at = Some(now_ms());
                status.captured = 0;
                status.skipped = 0;
                status.failed = 0;
                status.last_error = None;
            }
            self.dropped.store(0, Ordering::Release);
            if let Err(error) = self.persist_resume() {
                self.stop_inner();
                lock(&self.status).last_error = Some(error.clone());
                self.changed();
                return Err(error);
            }
            self.changed();
            Ok(())
        }
    }
    fn stop_inner(&self) {
        self.generation.fetch_add(1, Ordering::AcqRel);
        lock(&self.status).enabled = false;
        #[cfg(target_os = "windows")]
        if let Some(mut monitor) = lock(&self.monitor).take() {
            monitor.stop();
        }
        // Wait for an already-started transaction before acknowledging stop.
        drop(lock(&self.store));
    }
    fn stop(&self) -> Result<(), String> {
        let _transition = lock(&self.transition);
        self.stop_inner();
        self.persist_and_notify()
    }
    fn status(&self) -> Result<Status, String> {
        let now = now_ms() as u64;
        if now.saturating_sub(self.last_pruned.load(Ordering::Acquire)) >= 60_000 {
            let _transition = lock(&self.transition);
            let settings = lock(&self.settings).clone();
            let result = lock(&self.store).prune(&settings);
            self.last_pruned.store(now, Ordering::Release);
            if let Err(error) = result {
                self.stop_inner();
                lock(&self.status).last_error = Some(error);
                self.changed();
            }
        }
        #[cfg(target_os = "windows")]
        let offset = windows::offset_minutes();
        #[cfg(not(target_os = "windows"))]
        let offset = 0;
        let local = now_ms() + i64::from(offset) * 60_000;
        let day_start = local.div_euclid(86_400_000) * 86_400_000 - i64::from(offset) * 60_000;
        let (total, today, bytes) = lock(&self.store).stats(day_start)?;
        let latest_id = lock(&self.store).latest_id()?;
        let mut status = lock(&self.status).clone();
        status.total = total;
        status.today = today;
        status.bytes = bytes;
        status.latest_id = latest_id;
        status.settings = lock(&self.settings).clone();
        status.failed += self.dropped.load(Ordering::Relaxed);
        Ok(status)
    }
    fn request(&self, request: Request, query_token: u64) -> Result<serde_json::Value, String> {
        let json = |value| {
            serde_json::to_value(value).map_err(|_| "clipboard:response-failed".to_string())
        };
        match request {
            Request::Status => {}
            Request::Start => self.start()?,
            Request::Stop => self.stop()?,
            Request::Settings { settings } => {
                settings.validate()?;
                let _transition = lock(&self.transition);
                lock(&self.store).save_settings(&settings)?;
                *lock(&self.settings) = settings.clone();
                let result = lock(&self.store).prune(&settings);
                if let Err(error) = result {
                    self.stop_inner();
                    lock(&self.status).last_error = Some(error);
                } else {
                    lock(&self.status).last_error = None;
                }
                self.persist_and_notify()?;
            }
            Request::List { query } => {
                return serde_json::to_value(lock(&self.store).page(&query, || {
                    self.query_revision.load(Ordering::Acquire) != query_token
                })?)
                .map_err(|_| "clipboard:response-failed".into())
            }
            Request::Detail { id } => {
                return serde_json::to_value(lock(&self.store).detail(id)?)
                    .map_err(|_| "clipboard:response-failed".into())
            }
            Request::Favorite { id, favorite } => {
                lock(&self.store).favorite(id, favorite)?;
                self.changed();
            }
            Request::Delete { ids } => {
                lock(&self.store).delete(&ids)?;
                self.changed();
            }
            Request::Clear { include_favorites } => {
                let _transition = lock(&self.transition);
                let was_enabled = lock(&self.status).enabled;
                self.stop_inner();
                let result = lock(&self.store).clear(include_favorites);
                if let Err(error) = &result {
                    lock(&self.status).last_error = Some(error.clone());
                }
                self.persist_and_notify()?;
                result?;
                drop(_transition);
                if was_enabled {
                    self.start()?;
                }
            }
            Request::Copy { id, paths } => {
                let content = lock(&self.store).content(id)?;
                #[cfg(target_os = "windows")]
                windows::write(&content, false, paths)?;
                #[cfg(not(target_os = "windows"))]
                {
                    let _ = (content, paths);
                    return Err("clipboard:desktop-only".into());
                }
                lock(&self.store).used(id)?;
                self.changed();
            }
        }
        json(self.status()?)
    }
}

#[tauri::command]
pub(crate) async fn clipboard_history(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    request: Request,
) -> Result<serde_json::Value, String> {
    if window.label() != "main" {
        return Err("clipboard:window-denied".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let service = app.state::<ClipboardHistoryState>().get(&app)?;
        let token = if matches!(request, Request::List { .. }) {
            service.query_revision.fetch_add(1, Ordering::AcqRel) + 1
        } else {
            0
        };
        service.request(request, token)
    })
    .await
    .map_err(|_| "clipboard:worker-failed".to_string())?
}

#[tauri::command]
pub(crate) async fn copy_sensitive_text(
    window: tauri::WebviewWindow,
    text: String,
) -> Result<(), String> {
    if window.label() != "main" || text.len() > MAX_TEXT {
        return Err("clipboard:window-denied".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        #[cfg(target_os = "windows")]
        {
            windows::write(&Content::Text { text, rich: false }, true, false)
        }
        #[cfg(not(target_os = "windows"))]
        {
            let _ = text;
            Err("clipboard:desktop-only".into())
        }
    })
    .await
    .map_err(|_| "clipboard:worker-failed".to_string())?
}
pub(crate) fn bootstrap(app: &tauri::AppHandle) {
    let resume = app
        .path()
        .app_local_data_dir()
        .ok()
        .and_then(|dir| std::fs::read(dir.join("clipboard-history/resume.json")).ok())
        .is_some_and(|v| v == b"true");
    if resume {
        let app = app.clone();
        tauri::async_runtime::spawn_blocking(move || {
            if let Ok(service) = app.state::<ClipboardHistoryState>().get(&app) {
                let resume = lock(&service.settings).resume_on_launch;
                if resume {
                    let _ = service.start();
                }
            }
        });
    }
}
pub(crate) fn tray_toggle(app: &tauri::AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        if let Ok(service) = app.state::<ClipboardHistoryState>().get(&app) {
            let enabled = lock(&service.status).enabled;
            if enabled {
                let _ = service.stop();
            } else {
                let _ = service.start();
            }
        }
    });
}
fn shutdown(app: &tauri::AppHandle) {
    let service = lock(&app.state::<ClipboardHistoryState>().service).clone();
    if let Some(service) = service {
        service.closing.store(true, Ordering::Release);
        service.query_revision.fetch_add(1, Ordering::AcqRel);
        let _transition = lock(&service.transition);
        let resume = lock(&service.settings).resume_on_launch && lock(&service.status).enabled;
        let resume_path = lock(&service.store).directory.join("resume.json");
        service.stop_inner();
        #[cfg(target_os = "windows")]
        {
            lock(&service.sender).take();
            if let Some(worker) = lock(&service.worker).take() {
                let _ = worker.join();
            }
        }
        let _ = std::fs::write(
            resume_path,
            if resume {
                b"true".as_slice()
            } else {
                b"false".as_slice()
            },
        );
    }
}

pub(crate) fn on_exit_requested(
    app: &tauri::AppHandle,
    api: &tauri::ExitRequestApi,
    code: Option<i32>,
) {
    let state = app.state::<ClipboardHistoryState>();
    if state.exit_phase.load(Ordering::Acquire) == 2 {
        return;
    }
    api.prevent_exit();
    if state
        .exit_phase
        .compare_exchange(0, 1, Ordering::AcqRel, Ordering::Acquire)
        .is_err()
    {
        return;
    }
    // Workers may still dispatch tray updates to the UI thread; never join them there.
    let app = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        shutdown(&app);
        app.state::<ClipboardHistoryState>()
            .exit_phase
            .store(2, Ordering::Release);
        app.exit(code.unwrap_or(0));
    });
}
