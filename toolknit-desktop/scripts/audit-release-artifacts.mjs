import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { listSourceFiles } from './lib/source-inventory.mjs';

const root = path.resolve(import.meta.dirname, '..');
const read = file => readFile(path.join(root, file), 'utf8');
async function files(directory) {
  const result = [];
  for (const entry of await readdir(path.join(root, directory), { withFileTypes: true })) {
    const name = `${directory}/${entry.name}`;
    if (entry.isDirectory()) result.push(...await files(name));
    else if (entry.isFile()) result.push(name);
    else throw new Error(`Unexpected non-regular release asset: ${name}`);
  }
  return result;
}

const pkg = JSON.parse(await read('package.json'));
const config = JSON.parse(await read('src-tauri/tauri.conf.json'));
assert.equal(config.version, pkg.version);
assert.equal(config.build.frontendDist, '../dist');
assert.ok(config.app.windows.every(window => window.devtools === false));
assert.ok(config.app.windows.every(window => !/remote-debugging|auto-open-devtools/i.test(window.additionalBrowserArgs || '')));
const publicFiles = await files('public');
const distFiles = await files('dist');
const obsolete = /(?:^|\/)(?:controls\.html|home-web-preview\.png|INTER-OFL\.txt|inter-variable\.woff2|Fonarto-[^/]+|font-lab)(?:\/|$)/i;
assert.ok(!publicFiles.some(file => obsolete.test(file)), 'Obsolete assets must stay outside public');
assert.ok(!distFiles.some(file => obsolete.test(file)), 'Obsolete assets must not be copied to dist');
assert.ok(!distFiles.some(file => /(?:\.map|\.pdb|\.log|\.zip|\.tgz)$/i.test(file)), 'Debug and test outputs must not ship');
for (const file of ['controls.html', 'assets/openjpeg.wasm', 'assets/qcms_bg.wasm']) {
  assert.ok(!distFiles.includes(`dist/${file}`), `Unreferenced legacy asset must not ship: ${file}`);
}
for (const file of ['openjpeg.wasm', 'qcms_bg.wasm']) {
  assert.ok(distFiles.includes(`dist/assets/pdfjs/wasm/${file}`), `Version-matched PDF.js decoder missing: ${file}`);
}
const fonts = ['Alibaba-PuHuiTi-Bold.ttf', 'Alibaba-PuHuiTi-Medium.ttf', 'Montserrat-Bold.otf',
  'Montserrat-Regular.otf', 'NotoSansSC-Regular.ttf', 'NotoSansSC-Semibold.ttf'];
assert.deepEqual(distFiles.filter(file => /^dist\/assets\/fonts\/.*\.(?:ttf|otf|woff2?)$/.test(file))
  .map(file => path.basename(file)).sort(), fonts.sort());
for (const language of ['zh', 'en']) {
  const source = await read(`src/locales/${language}.json`);
  const names = [...source.matchAll(/^  "([^"]+)":\s*\{/gm)].map(match => match[1]);
  assert.equal(new Set(names).size, names.length, `${language}: duplicate top-level locale group`);
  assert.ok(JSON.parse(source).common.openLinkFailed);
}

const forbiddenMarkers = ['ai-doc-editor-demo', 'ai-table-demo', 'AI Table development fixture',
  'AI document editor development fixture', 'plugin:webview|internal_toggle_devtools', 'remote-debugging-port=9223'];
for (const file of distFiles.filter(file => /\.(?:js|html)$/.test(file))) {
  const text = await read(file);
  for (const marker of forbiddenMarkers) assert.ok(!text.includes(marker), `Development marker in ${file}: ${marker}`);
}
const hashes = new Map();
let publicBytes = 0;
for (const file of publicFiles) {
  const contents = await readFile(path.join(root, file));
  publicBytes += contents.length;
  const digest = createHash('sha256').update(contents).digest('hex');
  const matches = hashes.get(digest) || [];
  matches.push(file);
  hashes.set(digest, matches);
}
const nativeResources = [];
for (const file of config.bundle.resources) {
  const info = await stat(path.resolve(root, 'src-tauri', file));
  assert.ok(info.isFile() && info.size > 0, `Missing bundle resource: ${file}`);
  nativeResources.push({ file, bytes: info.size });
}
const sourceFiles = listSourceFiles(path.dirname(root))
  .filter(file => /^toolknit-desktop\/(?:src|scripts|cli)\/.*\.(?:m?js|cjs|css|html)$/.test(file));
const sources = (await Promise.all(sourceFiles.map(file => readFile(path.resolve(root, '..', file), 'utf8')))).join('\n');
const dependencyReferences = Object.keys(pkg.dependencies).map(name => ({ name, referenced: sources.includes(name) }));
const report = { version: pkg.version, checkedAt: new Date().toISOString(), devtools: false,
  publicFileCount: publicFiles.length, publicBytes, distFileCount: distFiles.length,
  duplicatePublicFiles: [...hashes.values()].filter(group => group.length > 1), fonts,
  dependencyReferences, nativeResources, checks: 'passed' };
await mkdir(path.join(root, 'tmp'), { recursive: true });
await writeFile(path.join(root, 'tmp/v3-release-artifact-audit.json'), JSON.stringify(report, null, 2));
console.log(`Release artifact audit passed: ${publicFiles.length} public files, ${distFiles.length} built files, ${nativeResources.length} native resources.`);
console.log(`Exact public duplicates: ${report.duplicatePublicFiles.length}; dependencies requiring review: ${dependencyReferences.filter(item => !item.referenced).map(item => item.name).join(', ') || 'none'}.`);
