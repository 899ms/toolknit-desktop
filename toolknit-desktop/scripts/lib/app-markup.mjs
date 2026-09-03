import { readFileSync, readdirSync } from 'node:fs';

function collectHtmlFiles(directoryUrl, prefix = '') {
  const files = [];
  for (const entry of readdirSync(directoryUrl, { withFileTypes: true })) {
    const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      files.push(...collectHtmlFiles(new URL(`${entry.name}/`, directoryUrl), relativePath));
    } else if (entry.name.endsWith('.html')) {
      files.push(relativePath);
    }
  }
  return files;
}

export function readAppMarkup(importMetaUrl) {
  const projectRoot = new URL('../', importMetaUrl);
  const templatesDirectory = new URL('src/app/templates/', projectRoot);
  const templateNames = collectHtmlFiles(templatesDirectory)
    .sort((left, right) => left.localeCompare(right));
  const featureTemplatesDirectory = new URL('src/features/', projectRoot);
  const featureTemplateNames = collectHtmlFiles(featureTemplatesDirectory)
    .sort((left, right) => left.localeCompare(right));
  const sources = [readFileSync(new URL('index.html', projectRoot), 'utf8')];

  for (const name of templateNames) {
    sources.push(`<!-- static template: ${name} -->`);
    sources.push(readFileSync(new URL(name, templatesDirectory), 'utf8'));
  }
  for (const name of featureTemplateNames) {
    sources.push(`<!-- feature template: ${name} -->`);
    sources.push(readFileSync(new URL(name, featureTemplatesDirectory), 'utf8'));
  }

  return sources.join('\n');
}
