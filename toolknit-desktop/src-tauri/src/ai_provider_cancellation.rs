use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};
use tokio::sync::oneshot;

enum Entry {
    Running(oneshot::Sender<()>),
    Cancelled(Instant),
}
fn entries() -> &'static Mutex<HashMap<String, Entry>> {
    static ENTRIES: OnceLock<Mutex<HashMap<String, Entry>>> = OnceLock::new();
    ENTRIES.get_or_init(|| Mutex::new(HashMap::new()))
}
fn valid_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 64 && id.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'-')
}
fn prune(map: &mut HashMap<String, Entry>) {
    map.retain(|_, entry| !matches!(entry, Entry::Cancelled(time) if time.elapsed() > Duration::from_secs(180)));
}
pub(super) struct RequestGuard(String);
impl Drop for RequestGuard {
    fn drop(&mut self) {
        if let Ok(mut map) = entries().lock() { map.remove(&self.0); }
    }
}
pub(super) fn register(id: &str) -> Result<(RequestGuard, oneshot::Receiver<()>), String> {
    if !valid_id(id) { return Err("ai-provider:invalid_request".into()); }
    let mut map = entries().lock().map_err(|_| "ai-provider:invalid_request")?;
    prune(&mut map);
    if matches!(map.get(id), Some(Entry::Cancelled(_))) {
        map.remove(id);
        return Err("ai-provider:aborted".into());
    }
    if map.contains_key(id) || map.len() >= 256 { return Err("ai-provider:invalid_request".into()); }
    let (sender, receiver) = oneshot::channel();
    map.insert(id.to_string(), Entry::Running(sender));
    Ok((RequestGuard(id.to_string()), receiver))
}
pub(super) fn cancel(id: &str) -> Result<(), String> {
    if !valid_id(id) { return Err("ai-provider:invalid_request".into()); }
    let mut map = entries().lock().map_err(|_| "ai-provider:invalid_request")?;
    prune(&mut map);
    if let Some(Entry::Running(sender)) = map.remove(id) { let _ = sender.send(()); }
    // IPC cancellation may arrive before the async request begins. Bound these tombstones.
    if map.len() < 256 { map.insert(id.to_string(), Entry::Cancelled(Instant::now())); }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn cancels_active_and_pre_dispatch_requests() {
        let (guard, receiver) = register("active-test").unwrap();
        cancel("active-test").unwrap();
        receiver.await.unwrap();
        drop(guard);
        cancel("early-test").unwrap();
        assert!(matches!(register("early-test"), Err(code) if code == "ai-provider:aborted"));
        let (guard, _) = register("released-test").unwrap();
        drop(guard);
        assert!(!entries().lock().unwrap().contains_key("released-test"));
    }
}
