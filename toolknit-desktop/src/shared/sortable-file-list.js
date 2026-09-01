export function bindSortableFileList({
  scope,
  container,
  items,
  render,
  isLocked = () => false
} = {}) {
  if (!scope?.event || !container || !Array.isArray(items) || typeof render !== 'function') return;
  const rows = Array.from(container.querySelectorAll(':scope > .audio-convert-file-item'));
  let draggingIndex = -1;

  const clearDragState = () => {
    draggingIndex = -1;
    for (const row of rows) row.classList.remove('dragging', 'drag-target');
  };

  rows.forEach((row, index) => {
    row.dataset.sortIndex = String(index);
    row.draggable = items.length > 1 && !isLocked();
    row.classList.toggle('is-sortable', row.draggable);

    scope.event(row, 'dragstart', event => {
      const target = event.target instanceof Element ? event.target : null;
      if (!row.draggable || target?.closest('button, input, select, textarea, a')) {
        event.preventDefault();
        return;
      }
      draggingIndex = index;
      row.classList.add('dragging');
      event.dataTransfer?.setData('text/plain', String(index));
      if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move';
    });
    scope.event(row, 'dragend', clearDragState);
    scope.event(row, 'dragover', event => {
      if (draggingIndex < 0 || isLocked()) return;
      event.preventDefault();
      for (const item of rows) item.classList.remove('drag-target');
      if (draggingIndex !== index) row.classList.add('drag-target');
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
    });
    scope.event(row, 'drop', event => {
      if (draggingIndex < 0 || isLocked()) return;
      event.preventDefault();
      const from = draggingIndex;
      const to = Number(row.dataset.sortIndex);
      if (!Number.isInteger(to) || from === to || from < 0 || from >= items.length
        || to < 0 || to >= items.length) {
        clearDragState();
        return;
      }
      const [moved] = items.splice(from, 1);
      items.splice(to, 0, moved);
      render();
    });
  });
}
