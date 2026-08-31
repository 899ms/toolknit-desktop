import { spawnSync } from 'node:child_process';

const releaseTests = [
  'test:security-release',
  'test:release-version',
  'test:update-service',
  'test:window-radius',
  'test:architecture',
  'test:system-cleanup',
  'test:excel-to-pdf',
  'test:pdf-merge',
  'test:pdf-split',
  'test:pdf-to-image',
  'test:pdf-rotate',
  'test:pdf-encrypt',
  'test:pdf-decrypt',
  'test:pdf-compress',
  'test:pdf-enhance',
  'test:pdf-editor',
  'test:pdf-page-number',
  'test:pdf-crop',
  'test:font-metadata',
  'test:ai-doc',
  'test:ai-table',
  'test:ai-provider',
  'test:ai-translate',
  'test:ai-polish',
  'test:text-format',
  'test:text-stats',
  'test:teleprompter',
  'test:bg-removal',
  'test:password',
  'test:color-extractor',
  'test:color-space-compare',
  'test:image-batch',
  'test:image-native',
  'test:image-crop',
  'test:markdown-editor',
  'test:image-color-replace',
  'test:crypto-tool',
  'test:developer-toolbox',
  'test:developer-toolbox-contract',
  'test:icon-gen',
  'test:audio-convert',
  'test:bpm-detect',
  'test:audio-extract',
  'test:audio-clip',
  'test:video-convert',
  'test:video-frame',
  'test:video-gif',
  'test:image-stitch',
  'test:ppt-image-extract',
  'test:ppt-text-extract',
  'test:ppt-compress',
  'test:ppt-to-pdf',
  'test:ppt-to-image',
  'test:ppt-outline',
  'test:ppt-draft',
  'test:dependencies',
  'test:hardware-gpu-display',
  'test:task-runtime',
  'test:help',
  'test:cli-package',
  'test:cli-agent',
  'build'
];

const npmCli = process.env.npm_execpath;
if (!npmCli) throw new Error('test:release must be started through npm.');

for (const script of releaseTests) {
  console.log(`\n=== ${script} ===`);
  const result = spawnSync(process.execPath, [npmCli, 'run', script], {
    cwd: process.cwd(),
    env: process.env,
    stdio: 'inherit'
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

console.log(`\nRelease test suite passed: ${releaseTests.length} npm scripts.`);
