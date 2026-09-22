use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};
use tokio::io::{AsyncRead, AsyncReadExt};
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

pub(super) struct PreviewJob {
    id: String,
    cancelled: oneshot::Receiver<()>,
}

impl Drop for PreviewJob {
    fn drop(&mut self) {
        if let Ok(mut map) = entries().lock() {
            map.remove(&self.id);
        }
    }
}

impl PreviewJob {
    pub(super) fn register(id: Option<String>) -> Result<Self, String> {
        static SEQUENCE: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        // Older GIF callers omit the ID; still bound their jobs and resources.
        let id = id.unwrap_or_else(|| {
            format!(
                "legacy-{}",
                SEQUENCE.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
            )
        });
        if !valid_id(&id) {
            return Err("video-preview:invalid-request".into());
        }
        let mut map = entries()
            .lock()
            .map_err(|_| "video-preview:engine-failed")?;
        prune(&mut map);
        if matches!(map.get(&id), Some(Entry::Cancelled(_))) {
            map.remove(&id);
            return Err("video-preview:cancelled".into());
        }
        if map.contains_key(&id)
            || map.len() >= 256
            || map
                .values()
                .filter(|entry| matches!(entry, Entry::Running(_)))
                .count()
                >= 8
        {
            return Err("video-preview:busy".into());
        }
        let (sender, cancelled) = oneshot::channel();
        map.insert(id.clone(), Entry::Running(sender));
        Ok(Self { id, cancelled })
    }

    pub(super) async fn output(
        mut self,
        command: &mut tokio::process::Command,
        limit: usize,
        timeout: Duration,
    ) -> Result<Vec<u8>, String> {
        let result = self.run(command, limit, timeout).await?;
        if !result.status.success() || result.stdout.is_empty() {
            return Err("video-preview:engine-failed".into());
        }
        Ok(result.stdout)
    }

    pub(super) async fn duration(
        &mut self,
        ffmpeg: &std::path::Path,
        input: &std::path::Path,
    ) -> Result<Option<f64>, String> {
        let mut command = tokio::process::Command::new(ffmpeg);
        command
            .arg("-hide_banner")
            .arg("-nostdin")
            .arg("-i")
            .arg(input);
        // FFmpeg's metadata-only invocation exits nonzero by design.
        let result = self
            .run(&mut command, 64 * 1024, Duration::from_secs(10))
            .await?;
        Ok(super::parse_ffmpeg_duration(&String::from_utf8_lossy(
            &result.stderr,
        )))
    }

    async fn run(
        &mut self,
        command: &mut tokio::process::Command,
        limit: usize,
        timeout: Duration,
    ) -> Result<std::process::Output, String> {
        if self.cancelled.try_recv().is_ok() {
            return Err("video-preview:cancelled".into());
        }
        command
            .kill_on_drop(true)
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped());
        #[cfg(target_os = "windows")]
        command.creation_flags(0x08000000);
        let mut child = command.spawn().map_err(|_| "video-preview:engine-failed")?;
        let stdout = child.stdout.take().ok_or("video-preview:engine-failed")?;
        let stderr = child.stderr.take().ok_or("video-preview:engine-failed")?;
        let result = tokio::select! {
            biased;
            _ = &mut self.cancelled => Err("video-preview:cancelled".to_string()),
            _ = tokio::time::sleep(timeout) => Err("video-preview:timeout".to_string()),
            output = async {
                let (status, stdout, stderr) = tokio::try_join!(
                    async { child.wait().await.map_err(|_| "video-preview:engine-failed".to_string()) },
                    read_bounded(stdout, limit),
                    read_bounded(stderr, 64 * 1024)
                )?;
                Ok(std::process::Output { status, stdout, stderr })
            } => output,
        };
        if result.is_err() {
            // Reap explicitly; kill_on_drop also covers an aborted command future.
            let _ = child.kill().await;
            let _ = child.wait().await;
        }
        result
    }
}

async fn read_bounded(reader: impl AsyncRead + Unpin, limit: usize) -> Result<Vec<u8>, String> {
    let mut bytes = Vec::new();
    reader
        .take(limit as u64 + 1)
        .read_to_end(&mut bytes)
        .await
        .map_err(|_| "video-preview:engine-failed")?;
    if bytes.len() > limit {
        return Err("video-preview:output-too-large".into());
    }
    Ok(bytes)
}

#[tauri::command]
pub(crate) fn cancel_video_preview(request_id: String) -> Result<(), String> {
    if !valid_id(&request_id) {
        return Err("video-preview:invalid-request".into());
    }
    let mut map = entries()
        .lock()
        .map_err(|_| "video-preview:engine-failed")?;
    prune(&mut map);
    if let Some(Entry::Running(sender)) = map.remove(&request_id) {
        let _ = sender.send(());
    }
    // A cancel IPC may arrive before the render IPC is dispatched.
    if map.len() < 256 {
        map.insert(request_id, Entry::Cancelled(Instant::now()));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn cancellation_isolated_and_remembered_before_dispatch() {
        let mut a = PreviewJob::register(Some("isolation-a".into())).unwrap();
        let mut b = PreviewJob::register(Some("isolation-b".into())).unwrap();
        cancel_video_preview("isolation-a".into()).unwrap();
        assert!(a.cancelled.try_recv().is_ok());
        assert!(matches!(
            b.cancelled.try_recv(),
            Err(oneshot::error::TryRecvError::Empty)
        ));
        cancel_video_preview("early-preview".into()).unwrap();
        assert!(
            matches!(PreviewJob::register(Some("early-preview".into())), Err(code) if code == "video-preview:cancelled")
        );
        assert!(cancel_video_preview("../invalid".into()).is_err());
    }

    #[tokio::test]
    async fn bounded_reader_rejects_excess_output() {
        assert_eq!(
            read_bounded(&b"12345"[..], 4).await.unwrap_err(),
            "video-preview:output-too-large"
        );
        assert_eq!(read_bounded(&b"1234"[..], 4).await.unwrap(), b"1234");
    }

    #[tokio::test]
    async fn child_timeout_and_cancellation_terminate_promptly() {
        let ffmpeg = match super::super::get_ffmpeg_path() {
            Ok(path) => path,
            Err(_) => return,
        };
        let command = || {
            let mut cmd = tokio::process::Command::new(&ffmpeg);
            cmd.args([
                "-hide_banner",
                "-loglevel",
                "error",
                "-re",
                "-f",
                "lavfi",
                "-i",
                "color=size=16x16:rate=1",
                "-t",
                "60",
                "-f",
                "null",
                "-",
            ]);
            cmd
        };
        let job = PreviewJob::register(Some("timeout-preview".into())).unwrap();
        assert_eq!(
            job.output(&mut command(), 1024, Duration::from_millis(100))
                .await
                .unwrap_err(),
            "video-preview:timeout"
        );
        let job = PreviewJob::register(Some("cancel-child-preview".into())).unwrap();
        let task = tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(100)).await;
            cancel_video_preview("cancel-child-preview".into()).unwrap();
        });
        assert_eq!(
            job.output(&mut command(), 1024, Duration::from_secs(5))
                .await
                .unwrap_err(),
            "video-preview:cancelled"
        );
        task.await.unwrap();
        assert!(!entries()
            .lock()
            .unwrap()
            .contains_key("cancel-child-preview"));
    }
}
