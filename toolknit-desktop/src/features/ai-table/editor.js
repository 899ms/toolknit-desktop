import { createLifecycleScope } from '../../app/tool-lifecycle.js';
import {
  AI_TABLE_LIMITS,
  assertAiTableTextBudget,
  parseAiTableNumber
} from '../../ai-table-core.js';
import { t } from '../../i18n.js';
import { createAiTableChartRenderer } from './charts.js';

const MAX_UNDO = 20;

function cloneData(data) {
  return data ? JSON.parse(JSON.stringify(data)) : null;
}

function valuesEqual(left, right) {
  return String(left ?? '') === String(right ?? '');
}

function appendIcon(button, name) {
  const icon = document.createElement('i');
  icon.dataset.lucide = name;
  button.appendChild(icon);
}

function appendIconLabel(button, iconName, label) {
  appendIcon(button, iconName);
  const text = document.createElement('span');
  text.textContent = label;
  button.appendChild(text);
}

function selectEditableContents(element) {
  const range = document.createRange();
  range.selectNodeContents(element);
  const selection = window.getSelection();
  selection.removeAllRanges();
  selection.addRange(range);
}

export function createAiTableEditor({
  empty,
  scroll,
  toolbar,
  undoButton,
  addChatMessage = () => null,
  openHelp = () => {},
  refreshIcons = () => {}
} = {}) {
  const lifecycle = createLifecycleScope();
  const charts = createAiTableChartRenderer();
  let session = null;
  let renderScope = null;
  let data = null;
  let undoStack = [];
  let sortColumn = -1;
  let sortAscending = true;

  const isOpen = () => Boolean(session && !session.disposed);

  // Finish editing before the document-level Escape guard blurs and rebuilds
  // the cell, which would remove its own key listener mid-dispatch.
  lifecycle.event(window, 'keydown', event => {
    if (event.key !== 'Escape' || !isOpen()) return;
    const cell = event.target?.closest?.('[contenteditable="true"]');
    if (!cell || !scroll?.contains(cell)) return;
    event.preventDefault();
    event.stopPropagation();
    cell.blur();
  }, true);

  function updateUndoButton() {
    if (!undoButton) return;
    const canUndo = undoStack.length > 0;
    undoButton.disabled = !canUndo;
    undoButton.title = canUndo ? t('home.aiTable.undo') : t('home.aiTable.undoEmpty');
  }

  function pushUndoState() {
    if (!data) return;
    undoStack.push(cloneData(data));
    if (undoStack.length > MAX_UNDO) undoStack.shift();
    updateUndoButton();
  }

  function normalizeCharts(source) {
    if (!source.charts?.length) {
      const labelColumn = source.columns.findIndex(column => column.type !== 'number');
      const valueColumn = source.columns.findIndex(column => column.type === 'number');
      if (valueColumn >= 0) {
        source.charts = [{
          type: 'bar',
          title: `${source.columns[valueColumn].label || t('home.aiTable.defaultChartValue')} ${t('home.aiTable.chartCompare')}`,
          labelColumn: labelColumn >= 0 ? labelColumn : 0,
          valueColumns: [valueColumn]
        }];
      }
    }
    source.charts = (source.charts || []).filter(chart => {
      const valueColumns = (chart.valueColumns || [])
        .filter(index => index >= 0 && index < source.columns.length);
      if (!valueColumns.length) return false;
      chart.valueColumns = valueColumns;
      if (!Number.isInteger(chart.labelColumn)
        || chart.labelColumn < 0
        || chart.labelColumn >= source.columns.length) {
        chart.labelColumn = 0;
      }
      return true;
    });
  }

  function createGuide(source) {
    const guide = document.createElement('div');
    guide.className = 'ai-table-edit-guide';
    const copy = document.createElement('div');
    copy.className = 'ai-table-edit-guide-copy';
    const title = document.createElement('div');
    title.className = 'ai-table-edit-guide-title';
    title.textContent = t('home.aiTable.editGuideTitle');
    const body = document.createElement('div');
    body.className = 'ai-table-edit-guide-text';
    body.textContent = t('home.aiTable.editGuideBody');
    copy.append(title, body);

    const side = document.createElement('div');
    side.className = 'ai-table-edit-guide-side';
    const stats = document.createElement('div');
    stats.className = 'ai-table-preview-stats';
    stats.textContent = t('home.aiTable.editGuideStats', {
      rows: source.rows.length,
      columns: source.columns.length,
      charts: source.charts.length
    });
    const help = document.createElement('button');
    help.type = 'button';
    help.className = 'ai-table-guide-link';
    appendIconLabel(help, 'circle-help', t('home.aiTable.help'));
    renderScope.event(help, 'click', () => openHelp('ai-table'));
    side.append(stats, help);
    guide.append(copy, side);
    return guide;
  }

  function createTitle() {
    if (!data?.title) return null;
    const title = document.createElement('h3');
    title.className = 'ai-table-title';
    title.textContent = data.title;
    title.title = t('home.aiTable.editTitleTip');
    renderScope.event(title, 'click', () => {
      if (title.isContentEditable) return;
      title.setAttribute('contenteditable', 'true');
      title.focus();
      selectEditableContents(title);
    });
    renderScope.event(title, 'blur', () => {
      title.removeAttribute('contenteditable');
      if (!data) return;
      const nextTitle = title.textContent.trim().slice(0, AI_TABLE_LIMITS.maxTitleChars);
      if (!valuesEqual(data.title, nextTitle)) {
        pushUndoState();
        data.title = nextTitle;
      }
      title.textContent = data.title;
    });
    return title;
  }

  function commitCell(cell, rowIndex, columnIndex, column) {
    cell.removeAttribute('contenteditable');
    if (!data?.rows[rowIndex]) return;
    const value = cell.textContent.trim().slice(0, AI_TABLE_LIMITS.maxCellChars);
    const previous = data.rows[rowIndex][columnIndex];
    if (column.type === 'number') {
      if (!value) {
        if (!valuesEqual(previous, '')) pushUndoState();
        data.rows[rowIndex][columnIndex] = '';
      } else {
        const number = parseAiTableNumber(value);
        if (number === null) {
          cell.textContent = previous == null ? '' : String(previous);
          addChatMessage('ai', t('home.aiTable.invalidNumber'));
          return;
        }
        if (!valuesEqual(previous, number)) pushUndoState();
        data.rows[rowIndex][columnIndex] = number;
      }
    } else {
      const textCharacters = data.rows.reduce((total, row, sourceRowIndex) => (
        total + row.reduce((rowTotal, sourceValue, sourceColumnIndex) => {
          if (sourceRowIndex === rowIndex && sourceColumnIndex === columnIndex) {
            return rowTotal + value.length;
          }
          return rowTotal + (typeof sourceValue === 'string' ? sourceValue.length : 0);
        }, 0)
      ), 0);
      try {
        assertAiTableTextBudget(textCharacters);
      } catch {
        cell.textContent = previous == null ? '' : String(previous);
        addChatMessage('ai', t('home.aiTable.tableTooLarge'));
        return;
      }
      if (!valuesEqual(previous, value)) pushUndoState();
      data.rows[rowIndex][columnIndex] = value;
    }
    cell.textContent = String(data.rows[rowIndex][columnIndex] ?? '');
    render();
  }

  function createRow(row, rowIndex, columns) {
    const tableRow = document.createElement('tr');
    tableRow.dataset.rowIdx = String(rowIndex);
    columns.forEach((column, columnIndex) => {
      const cell = document.createElement('td');
      cell.textContent = row[columnIndex] === undefined ? '' : String(row[columnIndex]);
      cell.dataset.colIdx = String(columnIndex);
      cell.title = t('home.aiTable.editCellTip');
      renderScope.event(cell, 'click', () => {
        if (cell.isContentEditable) return;
        cell.setAttribute('contenteditable', 'true');
        cell.focus();
        selectEditableContents(cell);
      });
      renderScope.event(cell, 'blur', () => commitCell(cell, rowIndex, columnIndex, column));
      tableRow.appendChild(cell);
    });

    const action = document.createElement('td');
    action.className = 'ai-table-action-col';
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'ai-table-del-btn';
    remove.title = t('home.aiTable.deleteRow');
    remove.setAttribute('aria-label', t('home.aiTable.deleteRow'));
    appendIcon(remove, 'trash-2');
    renderScope.event(remove, 'click', () => {
      if (!data?.rows[rowIndex]) return;
      pushUndoState();
      data.rows.splice(rowIndex, 1);
      render();
    });
    action.appendChild(remove);
    tableRow.appendChild(action);
    return tableRow;
  }

  function removeColumn(columnIndex) {
    if (!data || data.columns.length <= 1) {
      addChatMessage('ai', t('home.aiTable.minColumn'));
      return;
    }
    pushUndoState();
    data.columns.splice(columnIndex, 1);
    data.rows.forEach(row => row.splice(columnIndex, 1));
    data.charts = (data.charts || []).map(chart => {
      const remap = index => index === columnIndex ? null : index > columnIndex ? index - 1 : index;
      const valueColumns = (chart.valueColumns || []).map(remap).filter(index => index !== null);
      const labelColumn = remap(chart.labelColumn);
      return { ...chart, labelColumn: labelColumn === null ? 0 : labelColumn, valueColumns };
    }).filter(chart => chart.valueColumns.length > 0);
    render();
  }

  function sortBy(columnIndex) {
    if (!data?.columns[columnIndex] || data.rows.length < 2) return;
    const column = data.columns[columnIndex];
    if (sortColumn === columnIndex) sortAscending = !sortAscending;
    else {
      sortColumn = columnIndex;
      sortAscending = true;
    }
    const direction = sortAscending ? 1 : -1;
    pushUndoState();
    data.rows.sort((left, right) => {
      if (column.type === 'number') {
        return ((Number.parseFloat(left[columnIndex]) || 0)
          - (Number.parseFloat(right[columnIndex]) || 0)) * direction;
      }
      return String(left[columnIndex]).localeCompare(String(right[columnIndex]), 'zh') * direction;
    });
    render();
  }

  function createTable() {
    const wrapper = document.createElement('div');
    wrapper.className = 'ai-table-wrap';
    const table = document.createElement('table');
    table.className = 'ai-table-grid';
    const head = document.createElement('thead');
    const headerRow = document.createElement('tr');
    data.columns.forEach((column, columnIndex) => {
      const header = document.createElement('th');
      header.dataset.colIdx = String(columnIndex);
      const label = document.createElement('span');
      label.textContent = column.label || column.key;
      header.appendChild(label);
      renderScope.event(header, 'click', () => sortBy(columnIndex));
      if (data.columns.length > 1) {
        const remove = document.createElement('button');
        remove.type = 'button';
        remove.className = 'ai-table-col-delete';
        remove.title = t('home.aiTable.deleteColumn');
        remove.setAttribute('aria-label', t('home.aiTable.deleteColumn'));
        appendIcon(remove, 'trash-2');
        renderScope.event(remove, 'click', event => {
          event.stopPropagation();
          removeColumn(columnIndex);
        });
        header.appendChild(remove);
      }
      headerRow.appendChild(header);
    });
    const actionHeader = document.createElement('th');
    actionHeader.className = 'ai-table-action-col';
    headerRow.appendChild(actionHeader);
    head.appendChild(headerRow);
    table.appendChild(head);

    const body = document.createElement('tbody');
    data.rows.forEach((row, rowIndex) => body.appendChild(createRow(row, rowIndex, data.columns)));
    table.appendChild(body);
    wrapper.appendChild(table);

    const addRow = document.createElement('button');
    addRow.type = 'button';
    addRow.className = 'ai-table-add-btn';
    appendIconLabel(addRow, 'plus', t('home.aiTable.addRow'));
    renderScope.event(addRow, 'click', () => {
      if (data.rows.length >= AI_TABLE_LIMITS.maxRows) {
        addChatMessage('ai', t('home.aiTable.rowLimit', { max: AI_TABLE_LIMITS.maxRows }));
        return;
      }
      pushUndoState();
      data.rows.push(data.columns.map(column => column.type === 'number' ? 0 : ''));
      render();
    });
    wrapper.appendChild(addRow);

    const addColumn = document.createElement('button');
    addColumn.type = 'button';
    addColumn.className = 'ai-table-add-btn';
    appendIconLabel(addColumn, 'plus', t('home.aiTable.addCol'));
    renderScope.event(addColumn, 'click', () => {
      if (data.columns.length >= AI_TABLE_LIMITS.maxColumns) {
        addChatMessage('ai', t('home.aiTable.columnLimit', { max: AI_TABLE_LIMITS.maxColumns }));
        return;
      }
      pushUndoState();
      const usedKeys = new Set(data.columns.map(column => column.key));
      let keyIndex = data.columns.length + 1;
      while (usedKeys.has(`col_${keyIndex}`)) keyIndex += 1;
      data.columns.push({ key: `col_${keyIndex}`, label: t('home.aiTable.addCol'), type: 'text' });
      data.rows.forEach(row => row.push(''));
      render();
    });
    wrapper.appendChild(addColumn);
    return wrapper;
  }

  function createChartJob(chartDefinition, ownerRevision) {
    const wrapper = document.createElement('div');
    wrapper.className = 'ai-table-chart-wrap';
    const title = document.createElement('div');
    title.className = 'ai-table-chart-title';
    title.textContent = chartDefinition.title || t('home.aiTable.defaultChartTitle');
    const holder = document.createElement('div');
    holder.className = 'ai-table-chart-holder';
    const canvas = document.createElement('canvas');
    canvas.className = 'ai-table-chart-canvas';
    canvas.width = 760;
    canvas.height = 380;
    holder.appendChild(canvas);
    wrapper.append(title, holder);
    scroll.appendChild(wrapper);

    return new Promise(resolve => {
      let settled = false;
      const finish = result => {
        if (settled) return;
        settled = true;
        resolve(result);
      };
      const frame = requestAnimationFrame(async () => {
        try {
          finish({ ok: await charts.render(canvas, chartDefinition, data, ownerRevision) });
        } catch (error) {
          console.error('[AI Table] Chart render failed:', error);
          finish({ ok: false, error });
        }
      });
      renderScope.use(() => {
        cancelAnimationFrame(frame);
        finish({ ok: false, cancelled: true });
      });
    });
  }

  function render() {
    if (!isOpen() || !scroll || !data?.columns) return;
    renderScope?.dispose();
    renderScope = createLifecycleScope();
    const ownerRevision = charts.reset();
    normalizeCharts(data);
    empty && (empty.style.display = 'none');
    scroll.style.display = '';
    toolbar && (toolbar.style.display = '');
    scroll.replaceChildren();
    updateUndoButton();
    scroll.appendChild(createGuide(data));
    const title = createTitle();
    if (title) scroll.appendChild(title);
    scroll.appendChild(createTable());

    const jobs = data.charts.map(chartDefinition => createChartJob(chartDefinition, ownerRevision));
    charts.track(jobs).then(results => {
      if (!isOpen() || ownerRevision !== charts.revision) return;
      if (results.some(result => !result?.ok && !result?.cancelled)) {
        addChatMessage('ai', t('home.aiTable.errChart'));
      }
    });
    refreshIcons();
  }

  function undo() {
    const previous = undoStack.pop();
    if (!previous) {
      updateUndoButton();
      return;
    }
    data = previous;
    render();
    addChatMessage('ai', t('home.aiTable.undone'));
  }

  function reset() {
    renderScope?.dispose();
    renderScope = null;
    charts.reset();
    data = null;
    undoStack = [];
    sortColumn = -1;
    sortAscending = true;
    scroll?.replaceChildren();
    if (scroll) scroll.style.display = 'none';
    if (empty) empty.style.display = '';
    if (toolbar) toolbar.style.display = 'none';
    updateUndoButton();
  }

  function close() {
    session?.dispose();
    session = null;
    reset();
  }

  function dispose() {
    close();
    charts.dispose();
    lifecycle.dispose();
  }

  lifecycle.event(window, 'toolknit-interface-font-change', () => {
    if (isOpen() && data?.ready) render();
  });

  return {
    close,
    dispose,
    getChartEntries: charts.getEntries,
    getData: () => data,
    open() {
      session?.dispose();
      session = createLifecycleScope();
    },
    render,
    reset,
    scrollIntoView() {
      scroll?.scrollIntoView({ behavior: 'smooth' });
    },
    setData(value) {
      data = value;
      undoStack = [];
      sortColumn = -1;
      sortAscending = true;
      updateUndoButton();
      render();
      return data;
    },
    undo,
    waitForCharts: charts.ready
  };
}
