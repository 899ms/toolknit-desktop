export function bindTextDocumentDrop({
  lifecycle,
  overlay,
  dropZone,
  dropCard,
  isTauri = false,
  onFile,
  onError = () => {}
}) {
  if (!lifecycle || !overlay) return;

  const leave = () => {
    overlay.classList.remove('drag-over');
    dropZone?.classList.remove('visible');
    dropCard?.classList.remove('is-dragging');
  };
  const enter = () => {
    if (!overlay.classList.contains('visible')) return;
    overlay.classList.add('drag-over');
    dropZone?.classList.add('visible');
    dropCard?.classList.add('is-dragging');
  };
  lifecycle.use(leave);

  if (isTauri) {
    void import('@tauri-apps/api/webview').then(async ({ getCurrentWebview }) => {
      const unlisten = await getCurrentWebview().onDragDropEvent(event => {
        if (!overlay.classList.contains('visible')) return;
        const payload = event.payload;
        if (payload.type === 'enter' || payload.type === 'over') enter();
        else if (payload.type === 'leave') leave();
        else if (payload.type === 'drop') {
          leave();
          const path = payload.paths?.[0];
          if (path) void onFile?.({ path, name: String(path).split(/[/\\]/).pop() });
        }
      });
      if (lifecycle.disposed) unlisten?.();
      else lifecycle.use(() => unlisten?.());
    }).catch(onError);
    return;
  }

  lifecycle.event(overlay, 'dragover', event => {
    event.preventDefault();
    enter();
  });
  lifecycle.event(overlay, 'dragleave', event => {
    if (event.relatedTarget && overlay.contains(event.relatedTarget)) return;
    leave();
  });
  lifecycle.event(overlay, 'drop', event => {
    event.preventDefault();
    leave();
    const file = event.dataTransfer?.files?.[0];
    if (file) void onFile?.(file);
  });
}
