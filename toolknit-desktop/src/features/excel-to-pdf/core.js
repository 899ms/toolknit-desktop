export const EXCEL_TO_PDF_MAX_FILES = 20;

const SUPPORTED_WORKBOOK = /\.(?:xlsx|xls|ods)$/i;

export function excelWorkbookNameFromPath(path) {
  return String(path || '').split(/[\\/]/).pop() || '';
}

export function isSupportedExcelWorkbook(name) {
  return SUPPORTED_WORKBOOK.test(String(name || ''));
}

export function excelWorkbookKey(file) {
  return `${String(file?.path || file?.name || '').toLowerCase()}::${Number(file?.size) || 0}`;
}

export function normalizeExcelWorkbookRecord(record, id) {
  const name = String(record?.name || excelWorkbookNameFromPath(record?.path));
  return {
    id,
    name,
    extension: name.split('.').pop() || '',
    size: record?.size,
    path: String(record?.path || '')
  };
}

export function formatExcelWorkbookBytes(bytes, unknownLabel = '') {
  const value = Number(bytes);
  if (!Number.isFinite(value) || value < 0) return unknownLabel;
  if (value >= 1024 * 1024) {
    return `${(value / 1024 / 1024).toFixed(value >= 10 * 1024 * 1024 ? 0 : 1)} MB`;
  }
  if (value >= 1024) return `${Math.round(value / 1024)} KB`;
  return `${value} B`;
}

export function getExcelToPdfErrorKey(error) {
  const message = String(error?.message || error || '');
  if (/runtime-missing|python-missing/i.test(message)) return 'runtimeMissing';
  if (/invalid-extension|invalid-workbook|invalid-input|input-not-found|read-failed/i.test(message)) {
    return 'invalidWorkbook';
  }
  if (/input-too-large/i.test(message)) return 'fileTooLarge';
  if (/invalid-file-count/i.test(message)) return 'tooMany';
  if (/invalid-options/i.test(message)) return 'invalidOptions';
  if (/busy|another file conversion/i.test(message)) return 'busy';
  if (/cancelled|canceled/i.test(message)) return 'cancelled';
  if (/timeout/i.test(message)) return 'timeout';
  if (/render-failed|all-failed/i.test(message)) return 'renderFailed';
  return 'conversionFailed';
}
