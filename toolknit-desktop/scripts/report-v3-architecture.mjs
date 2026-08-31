import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function read(relativePath) {
  return readFile(path.join(root, relativePath), 'utf8');
}

async function collectFiles(relativeDirectory, extensions) {
  const directory = path.join(root, relativeDirectory);
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const relativePath = path.join(relativeDirectory, entry.name);
    if (entry.isDirectory()) files.push(...await collectFiles(relativePath, extensions));
    else if (extensions.has(path.extname(entry.name))) files.push(relativePath);
  }
  return files;
}

function matches(source, expression) {
  return [...source.matchAll(expression)];
}

function unique(values) {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

async function sourceMetric(relativePath) {
  const source = await read(relativePath);
  const metadata = await stat(path.join(root, relativePath));
  return {
    path: relativePath.replaceAll('\\', '/'),
    lines: source.split('\n').length,
    bytes: metadata.size
  };
}

const [html, mainSource, css, rustFiles, frontendFiles, mcpRegistry] = await Promise.all([
  read('index.html'),
  read('src/main.js'),
  read('src/styles.css'),
  collectFiles('src-tauri/src', new Set(['.rs'])),
  collectFiles('src', new Set(['.js', '.mjs'])),
  read('cli/lib/tool-registry.mjs')
]);

const [rustSources, frontendSources, sourceFiles] = await Promise.all([
  Promise.all(rustFiles.map(async file => ({ file, source: await read(file) }))),
  Promise.all(frontendFiles.map(async file => ({ file, source: await read(file) }))),
  Promise.all([
    sourceMetric('src/main.js'),
    sourceMetric('src/styles.css'),
    sourceMetric('index.html'),
    sourceMetric('src-tauri/src/lib.rs')
  ])
]);

const tauriCommands = unique(rustSources.flatMap(({ source }) =>
  matches(source, /#\[tauri::command\][\s\S]{0,500}?\b(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?fn\s+([A-Za-z0-9_]+)/g)
    .map(match => match[1])
));
const tauriCommandAttributeCount = rustSources.reduce((total, { source }) =>
  total + matches(source, /#\[tauri::command\]/g).length, 0);
const rustTestCount = rustSources.reduce((total, { source }) =>
  total + matches(source, /#\[(?:tokio::)?test\]/g).length, 0);
const frontendText = frontendSources.map(({ source }) => source).join('\n');
const htmlIds = matches(html, /\bid="([^"]+)"/g).map(match => match[1]);
const toolIds = unique(matches(html, /\bdata-tool="([^"]+)"/g).map(match => match[1]));
const duplicateHtmlIds = unique(htmlIds.filter((id, index) => htmlIds.indexOf(id) !== index));
const frontendInvokes = unique(matches(frontendText, /\binvoke\(\s*['"]([^'"]+)['"]/g).map(match => match[1]));
const frontendEvents = unique(matches(frontendText, /\blisten\(\s*['"]([^'"]+)['"]/g).map(match => match[1]));
const literalStorageKeys = unique(matches(frontendText, /\b(?:localStorage|sessionStorage)\.(?:getItem|setItem|removeItem)\(\s*['"]([^'"]+)['"]/g).map(match => match[1]));
const mcpTools = unique(matches(mcpRegistry, /\bname:\s*['"](toolknit_[^'"]+)['"]/g).map(match => match[1]));

const report = {
  generatedAt: new Date().toISOString(),
  gitBaseline: {
    branch: 'codex/v3.0',
    checkpoint: 'bae3c98'
  },
  sourceFiles,
  desktopCatalog: {
    count: toolIds.length,
    toolIds
  },
  htmlContract: {
    idCount: htmlIds.length,
    uniqueIdCount: unique(htmlIds).length,
    duplicateIds: duplicateHtmlIds
  },
  frontend: {
    staticMainImports: matches(mainSource, /^\s*import\s/gm).length,
    dynamicMainImports: matches(mainSource, /\bimport\s*\(/g).length,
    documentListenersInMain: matches(mainSource, /document\.addEventListener\(/g).length,
    windowListenersInMain: matches(mainSource, /window\.addEventListener\(/g).length,
    timeoutsInMain: matches(mainSource, /(?:window\.)?setTimeout\(/g).length,
    intervalsInMain: matches(mainSource, /(?:window\.)?setInterval\(/g).length,
    objectUrlsInMain: matches(mainSource, /URL\.createObjectURL\(/g).length,
    invokeCount: frontendInvokes.length,
    invokes: frontendInvokes,
    eventCount: frontendEvents.length,
    events: frontendEvents,
    literalStorageKeyCount: literalStorageKeys.length,
    literalStorageKeys
  },
  css: {
    importantCount: matches(css, /!important/g).length,
    zIndexCount: matches(css, /z-index\s*:/g).length,
    mediaQueryCount: matches(css, /@media\b/g).length
  },
  rust: {
    commandAttributeCount: tauriCommandAttributeCount,
    commandCount: tauriCommands.length,
    commands: tauriCommands,
    testCount: rustTestCount
  },
  mcp: {
    toolCount: mcpTools.length,
    tools: mcpTools
  },
  productionBundleBaseline: {
    mainJavaScriptBytes: 2_811_765,
    mainCssBytes: 816_198,
    indexHtmlBytes: 784_455,
    warnings: [
      'pdf-lib dynamic import is ineffective because static consumers keep it in the graph',
      'pdf-encrypt-core dynamic import is ineffective because pdf-editor-core imports it statically',
      'multiple production chunks exceed 500 kB'
    ]
  }
};

if (process.argv.includes('--check')) {
  const failures = [];
  if (report.desktopCatalog.count !== 65) failures.push(`expected 65 desktop tools, found ${report.desktopCatalog.count}`);
  if (report.htmlContract.duplicateIds.length) failures.push(`duplicate HTML ids: ${report.htmlContract.duplicateIds.join(', ')}`);
  if (report.rust.commandAttributeCount !== 127) failures.push(`expected 127 Tauri command implementations, found ${report.rust.commandAttributeCount}`);
  if (report.rust.commandCount !== 126) failures.push(`expected 126 unique Tauri command names, found ${report.rust.commandCount}`);
  if (report.rust.testCount < 93) failures.push(`expected at least 93 Rust tests, found ${report.rust.testCount}`);
  if (report.mcp.toolCount !== 46) failures.push(`expected 46 MCP tools, found ${report.mcp.toolCount}`);
  if (failures.length) {
    failures.forEach(failure => console.error(`Architecture baseline failure: ${failure}`));
    process.exit(1);
  }
}

if (process.argv.includes('--json')) {
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} else {
  console.log('ToolKnit V3 architecture baseline');
  for (const file of report.sourceFiles) console.log(`- ${file.path}: ${file.lines} lines, ${file.bytes} bytes`);
  console.log(`- desktop tools: ${report.desktopCatalog.count}`);
  console.log(`- HTML ids: ${report.htmlContract.idCount} (${report.htmlContract.duplicateIds.length} duplicates)`);
  console.log(`- Tauri commands: ${report.rust.commandAttributeCount} implementations, ${report.rust.commandCount} unique names`);
  console.log(`- Rust tests: ${report.rust.testCount}`);
  console.log(`- MCP tools: ${report.mcp.toolCount}`);
  console.log(`- frontend invoke names: ${report.frontend.invokeCount}`);
  console.log(`- frontend event names: ${report.frontend.eventCount}`);
}
