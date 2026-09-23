const DEFAULT_LABELS = { contents: 'Contents', overview: 'AI reading guide', image: 'Image', formula: 'Formula', note: 'Recognition note', column: 'Column', failed: 'Page recognition failed', blank: 'Blank page', source: 'Source content' };

// Model output is document text. Prevent it from adding HTML or remote images.
function literal(value) {
  return String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/[\\`*_[\]#!|]/g, '\\$&');
}
function cell(value) { return literal(value).replace(/[\r\n]+/g, ' '); }

function blockMarkdown(block, labels) {
  if (block.type === 'heading') return `${'#'.repeat(block.level)} ${literal(block.text)}`;
  if (block.type === 'list') return block.items.map((item, index) => `${block.ordered ? `${index + 1}.` : '-'} ${literal(item).replace(/\n/g, '\n  ')}`).join('\n');
  if (block.type === 'table') {
    const width = Math.max(block.columns.length, ...block.rows.map(row => row.length));
    const columns = Array.from({ length: width }, (_, index) => block.columns[index] || `${labels.column} ${index + 1}`);
    return [block.caption ? literal(block.caption) + '\n' : '', `| ${columns.map(cell).join(' | ')} |`,
      `| ${columns.map(() => '---').join(' | ')} |`,
      ...block.rows.map(row => `| ${columns.map((_, index) => cell(row[index] ?? '')).join(' | ')} |`)].filter(Boolean).join('\n');
  }
  if (block.type === 'image') return `> ${labels.image}: ${literal(block.description)}`;
  if (block.type === 'formula') return block.latex ? `$$\n${block.latex}\n$$` : `> ${labels.formula}: ${literal(block.description)}`;
  return literal(block.text);
}

export function serializeAiPage(page, customLabels = {}) {
  const labels = { ...DEFAULT_LABELS, ...customLabels };
  const parts = [`<!-- source-page: ${page.pageNumber} -->`];
  if (page.failed) parts.push(`> ${labels.failed}`);
  else if (page.pageType === 'blank') parts.push(`> ${labels.blank}`);
  for (const block of page.blocks || []) parts.push(blockMarkdown(block, labels));
  for (const warning of page.warnings || []) parts.push(`> ${labels.note}: ${literal(warning)}`);
  return parts.join('\n\n');
}

export function serializeAiMarkdown({ fileName = 'document.pdf', pages = [], summary = {}, labels: customLabels = {} } = {}) {
  const labels = { ...DEFAULT_LABELS, ...customLabels };
  const output = [`# ${literal(summary.title || fileName.replace(/\.pdf$/i, ''))}`];
  if (summary.summary) output.push(`## ${labels.overview}`, literal(summary.summary));
  if (summary.outline?.length) output.push(`## ${labels.contents}`, summary.outline.map(item => `- ${literal(item)}`).join('\n'));
  if (summary.summary) output.push(`## ${labels.source}`);
  for (const page of pages) output.push(serializeAiPage(page, labels));
  return output.join('\n\n').trim() + '\n';
}
