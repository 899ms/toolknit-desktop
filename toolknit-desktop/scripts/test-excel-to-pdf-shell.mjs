import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const [html, main, lazyTools, ui, css, rust, zh, en] = await Promise.all([
  readFile(new URL('../index.html', import.meta.url), 'utf8'),
  readFile(new URL('../src/main.js', import.meta.url), 'utf8'),
  readFile(new URL('../src/features/lazy-tools.js', import.meta.url), 'utf8'),
  readFile(new URL('../src/excel-to-pdf-ui.js', import.meta.url), 'utf8'),
  readFile(new URL('../src/excel-to-pdf.css', import.meta.url), 'utf8'),
  readFile(new URL('../src-tauri/src/lib.rs', import.meta.url), 'utf8'),
  readFile(new URL('../src/locales/zh.json', import.meta.url), 'utf8'),
  readFile(new URL('../src/locales/en.json', import.meta.url), 'utf8')
]);

assert.match(html, /data-tool="excel-to-pdf"/);
assert.match(html, /data-category="pdf"[\s\S]*data-tool="excel-to-pdf"/);
assert.match(html, /id="excelToPdfOverlay"/);
assert.match(lazyTools, /'excel-to-pdf':[\s\S]*import\('\.\.\/excel-to-pdf-ui\.js'\)[\s\S]*initExcelToPdfTool/);
assert.match(main, /createLazyToolRegistry\([\s\S]*specs:\s*LAZY_TOOL_SPECS/);
assert.match(main, /currentPhase === 'installing'[\s\S]*home\.dependencies\.installingDetail/);
assert.match(main, /currentPhase === 'verifying'[\s\S]*home\.dependencies\.verifyingDetail/);
assert.match(main, /dataset\.indeterminate = isPostDownload/);
assert.match(ui, /accept="\.xlsx,\.xls,\.ods"/);
assert.match(ui, /data-setting-group="sheets"/);
assert.match(ui, /data-setting-group="orientation"/);
assert.match(ui, /data-setting-group="paper"/);
assert.match(ui, /data-setting-group="scale"/);
assert.match(ui, /class="audio-convert-process-btn pdf-merge-v2-process"[^>]*\bdisabled\b/);
assert.match(ui, /data-excel-action="convert"/);
assert.match(ui, /invoke\('convert_excel_to_pdf'/);
assert.match(ui, /sheetRange:\s*settings\.sheets/);
assert.match(ui, /render-failed\|all-failed[\s\S]*renderFailed/);
assert.match(rust, /async fn convert_excel_to_pdf\(/);
assert.match(rust, /convert_excel_to_pdf,[\s\S]*convert_video_batch/);
assert.match(rust, /"\.xlsx": "Calc MS Excel 2007 XML"/);
assert.match(rust, /"\.xls": "MS Excel 97"/);
assert.match(rust, /"\.ods": "calc8"/);
assert.match(css, /grid-template-columns:\s*repeat\(4, minmax\(0, 1fr\)\)/);
assert.match(css, /\.excel-to-pdf-overlay \.audio-clip-success-btn-secondary\s*\{[\s\S]*?color:\s*#333/);
assert.match(css, /\.excel-to-pdf-overlay \.audio-clip-success-btn-secondary:hover\s*\{[\s\S]*?color:\s*#222/);
assert.match(css, /@media \(max-width: 980px\)/);
assert.match(css, /@media \(max-width: 620px\)/);

const zhLocale = JSON.parse(zh);
const enLocale = JSON.parse(en);
assert.equal(zhLocale.home.toolNames.excelToPdf, 'Excel 转 PDF');
assert.equal(enLocale.home.toolNames.excelToPdf, 'Excel to PDF');
assert.equal(zhLocale.home.excelToPdfPage.paperLetter, '美式信纸');
assert.equal(zhLocale.home.excelToPdfPage.startButton, '开始转换');
assert.equal(enLocale.home.excelToPdfPage.startButton, 'Start conversion');
assert.equal(zhLocale.home.excelToPdfPage.renderFailed, 'LibreOffice 无法读取或渲染这个工作簿，请先用 Excel 或 WPS 重新另存为标准 XLSX 后再试。');
assert.equal(enLocale.home.excelToPdfPage.renderFailed, 'LibreOffice could not read or render this workbook. Save it as a standard XLSX in Excel or WPS, then try again.');
assert.equal(zhLocale.home.dependencies.installingDetail, '正在安装 {name}，请稍等...');
assert.equal(zhLocale.home.dependencies.verifyingDetail, '正在校验 {name}，请稍等...');
assert.equal(enLocale.home.dependencies.installingDetail, 'Installing {name}. Please wait...');
assert.equal(enLocale.home.dependencies.verifyingDetail, 'Verifying {name}. Please wait...');

console.log('Excel to PDF feature contract passed');
