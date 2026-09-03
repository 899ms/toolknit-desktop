import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const [html, main, styles, rust, zh, en] = await Promise.all([
  readFile(new URL('../index.html', import.meta.url), 'utf8'),
  readFile(new URL('../src/main.js', import.meta.url), 'utf8').then(async main => `${main}\n${await readFile(new URL('../src/application.js', import.meta.url), 'utf8')}`),
  readFile(new URL('../src/styles/legacy.css', import.meta.url), 'utf8'),
  Promise.all([
    'native_runtime.rs',
    'native_runtime/core.rs',
    'native_runtime/dependencies.rs',
    'native_runtime/transcription.rs',
    'native_runtime/pdf.rs',
    'native_runtime/image.rs',
    'native_runtime/media.rs',
    'native_runtime/system.rs',
    'native_runtime/office.rs',
    'native_runtime/runner.rs',
    'native_runtime/tests.rs'
  ].map(relativePath => readFile(new URL(`../src-tauri/src/${relativePath}`, import.meta.url), 'utf8')))
    .then(parts => parts.join('\n')),
  readFile(new URL('../src/locales/zh.json', import.meta.url), 'utf8').then(JSON.parse),
  readFile(new URL('../src/locales/en.json', import.meta.url), 'utf8').then(JSON.parse)
]);

const audioSection = html.match(/<div class="content-section" data-category="audio">[\s\S]*?<div class="content-section" data-category="video">/)?.[0] || '';
const textSection = html.match(/<div class="content-section" data-category="text">[\s\S]*?<div class="content-section" data-category="calculator">/)?.[0] || '';
assert.doesNotMatch(audioSection, /data-tool="transcription"/, 'transcription must not remain in the audio category');
assert.match(textSection, /data-tool="transcription"[\s\S]*?home\.toolNames\.textCategoryTag/, 'transcription must be listed under text tools');

assert.match(html, /id="dependencyGateOverlay"[\s\S]*?audio-convert-success-dialog dependency-gate-dialog/, 'dependency gate must reuse the white result-dialog layout');
assert.match(html, /id="dependencyGateCancel"[\s\S]*?id="dependencyGateInstall"/, 'dependency gate must provide cancel and install-all actions');
assert.match(styles, /\.dependency-gate-overlay\s*\{[\s\S]*?z-index:\s*1400/, 'dependency gate must stay above tool overlays');

assert.match(main, /showDependencyGate\(\{ openFn, needsFfmpeg: true, needsModel: false \}\)/, 'FFmpeg tools must open the dependency gate');
assert.match(main, /download_transcription_model'[\s\S]*?modelId:\s*'small'/, 'transcription dependency install must default to Whisper Small');
assert.match(main, /invoke\('cancel_dependency_downloads'\)/, 'dependency downloads must be cancellable');

assert.match(rust, /cdn\.npmmirror\.com\/binaries\/ffmpeg-static\/b6\.1\.1\/ffmpeg-win32-x64\.gz/, 'China source must use the npm mirror CDN');
assert.match(rust, /const FFMPEG_ARCHIVE_BYTES: u64 = 29_581_307;/, 'FFmpeg download must use the compact compressed binary');
assert.match(rust, /reqwest::header::RANGE/, 'FFmpeg downloads must support resume');
assert.match(rust, /FFMPEG_ARCHIVE_SHA256/, 'FFmpeg downloads must be integrity checked');
assert.match(rust, /TOOLKNIT_FFMPEG_PATH/, 'FFmpeg detection must support an explicit system path');
assert.match(rust, /Microsoft[\s\S]*WinGet[\s\S]*Links/, 'FFmpeg detection must check the Winget link directory');
assert.match(rust, /system:scoop/, 'FFmpeg detection must check the Scoop shim directory');
assert.match(rust, /system:chocolatey/, 'FFmpeg detection must check the Chocolatey bin directory');
assert.match(rust, /FFMPEG_PROBE_TIMEOUT_MS/, 'FFmpeg candidates must be verified with a bounded process probe');
assert.match(rust, /fn libreoffice_candidates\(\)/, 'LibreOffice detection must use bounded known-path candidates');
assert.match(rust, /ProgramFiles\(x86\)/, 'LibreOffice detection must include standard Windows install directories');
assert.match(main, /isManagedRuntime\(ffmpegRuntimeStatus\)/, 'system FFmpeg installations must not expose ToolKnit delete actions');
assert.match(main, /isManagedRuntime\(libreOfficeRuntimeStatus\)/, 'system LibreOffice installations must not expose ToolKnit delete actions');
assert.match(rust, /fn cancel_dependency_downloads\(\)/, 'the native layer must expose dependency cancellation');

for (const locale of [zh, en]) {
  assert.ok(locale.home?.dependencies?.installAll);
  assert.ok(locale.home?.dependencies?.transcriptionDesc);
}

console.log('Dependency gate and runtime contract checks passed');
