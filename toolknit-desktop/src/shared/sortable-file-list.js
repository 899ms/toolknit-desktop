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

export function bindPointerSortableFileList({
  scope,
  container,
  items,
  render,
  isLocked = () => false,
  guardNativeDrop = () => {}
} = {}) {
  if (!scope?.event || !container || !Array.isArray(items) || typeof render !== 'function') return;
  const rows = Array.from(container.querySelectorAll(':scope > .audio-convert-file-item'));
  const sortable = rows.length > 1 && !isLocked();

  const clearDropTargets = () => {
    for (const row of rows) {
      row.classList.remove('drag-target', 'drag-target-before', 'drag-target-after');
    }
  };

  rows.forEach((row, sourceIndex) => {
    row.draggable = false;
    row.classList.toggle('is-sortable', sortable);
    row.setAttribute('aria-grabbed', 'false');
    if (!sortable) return;

    let activePointerId = null;
    let startX = 0;
    let startY = 0;
    let dragging = false;
    let destinationIndex = sourceIndex;

    const resolveDestination = clientY => {
      let insertionSlot = rows.length;
      for (let index = 0; index < rows.length; index += 1) {
        const bounds = rows[index].getBoundingClientRect();
        if (clientY < bounds.top + bounds.height / 2) {
          insertionSlot = index;
          break;
        }
      }
      destinationIndex = Math.max(
        0,
        Math.min(rows.length - 1, insertionSlot - (sourceIndex < insertionSlot ? 1 : 0))
      );
      clearDropTargets();
      if (destinationIndex === sourceIndex) return;
      const marker = insertionSlot >= rows.length ? rows.at(-1) : rows[insertionSlot];
      marker?.classList.add(
        'drag-target',
        insertionSlot >= rows.length ? 'drag-target-after' : 'drag-target-before'
      );
    };

    const finish = (event, cancelled = false) => {
      if (activePointerId === null || event.pointerId !== activePointerId) return;
      const shouldMove = dragging && !cancelled && !isLocked()
        && destinationIndex !== sourceIndex;
      activePointerId = null;
      dragging = false;
      try {
        if (row.hasPointerCapture(event.pointerId)) row.releasePointerCapture(event.pointerId);
      } catch {}
      row.classList.remove('dragging');
      row.setAttribute('aria-grabbed', 'false');
      container.classList.remove('is-reordering');
      clearDropTargets();
      guardNativeDrop(250);
      if (!shouldMove) return;
      const [moved] = items.splice(sourceIndex, 1);
      items.splice(destinationIndex, 0, moved);
      render();
    };

    scope.event(row, 'pointerdown', event => {
      const target = event.target instanceof Element ? event.target : null;
      if (event.button !== 0 || isLocked()
        || target?.closest('button, input, select, textarea, a')) return;
      event.preventDefault();
      activePointerId = event.pointerId;
      startX = event.clientX;
      startY = event.clientY;
      destinationIndex = sourceIndex;
      guardNativeDrop(1000);
      row.setPointerCapture(event.pointerId);
    });
    scope.event(row, 'pointermove', event => {
      if (activePointerId === null || event.pointerId !== activePointerId) return;
      if (!dragging && Math.hypot(event.clientX - startX, event.clientY - startY) < 5) return;
      event.preventDefault();
      if (!dragging) {
        dragging = true;
        row.classList.add('dragging');
        row.setAttribute('aria-grabbed', 'true');
        container.classList.add('is-reordering');
      }
      guardNativeDrop(1000);
      const listBounds = container.getBoundingClientRect();
      const edgeSize = Math.min(44, listBounds.height / 4);
      if (event.clientY < listBounds.top + edgeSize) container.scrollTop -= 12;
      else if (event.clientY > listBounds.bottom - edgeSize) container.scrollTop += 12;
      resolveDestination(event.clientY);
    });
    scope.event(row, 'pointerup', event => finish(event));
    scope.event(row, 'pointercancel', event => finish(event, true));
    scope.event(row, 'lostpointercapture', event => finish(event, true));
  });
}
