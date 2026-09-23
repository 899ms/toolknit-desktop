import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { PDFDocument } from 'pdf-lib';
import { compressPdfFile } from '../cli/lib/pdf-runtime.mjs';
import { compressionFixtures } from './lib/pdf-compress-fixtures.mjs';

const root = path.resolve('tmp/pdf-compress-redesign/samples');
await mkdir(root, { recursive: true });
const fixtures = await compressionFixtures();
const input = path.join(root, 'image-source.pdf');
const tiny = path.join(root, 'tiny-source.pdf');
await writeFile(input, fixtures.image);
await writeFile(tiny, fixtures.tiny);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const originalHash = hash(fixtures.image);
const execute = promisify(execFile);
const beforeCaches = new Set((await readdir(tmpdir())).filter(name => name.startsWith('toolknit-pdf-compress-')));
const report = [];
const run = async (label, args, options) => {
  const output = path.join(root, `${label}-${Date.now()}.pdf`);
  const result = await compressPdfFile({ input_path: input, output_path: output, ...args }, options);
  report.push({ label, status: result.status, compression: result.compression });
  if (result.outputs.length) {
    assert.equal((await stat(result.outputs[0].path)).size, result.outputs[0].bytes);
    assert.ok(result.outputs[0].bytes < fixtures.image.length);
    if (args.target_bytes != null) assert.ok(result.outputs[0].bytes <= args.target_bytes);
    const pdf = await PDFDocument.load(await readFile(result.outputs[0].path));
    assert.equal(pdf.getPageCount(), 3);
    if (args.mode === 'raster') {
      assert.equal(pdf.getForm().getFields().length, 0);
      pdf.getPages().forEach((page, index) => {
        assert.equal(page.getWidth(), fixtures.expectedSizes[index][0]);
        assert.equal(page.getHeight(), fixtures.expectedSizes[index][1]);
      });
      assert.equal(result.compression.sourceRenders, 3, 'each source page is rendered once across all attempts');
    } else {
      assert.equal(pdf.getForm().getTextField('preserved-field').getText(), 'keep-me');
      assert.equal(pdf.getPages()[1].getRotation().angle, 90);
      assert.equal(pdf.getPages()[2].getCropBox().width, 580);
    }
  } else await assert.rejects(stat(output), { code: 'ENOENT' });
  return result;
};
try {
  const raster = await run('raster', { mode: 'raster', level: 'high' });
  assert.equal(raster.status, 'compressed');
  const target = await run('target', { mode: 'raster', target_bytes: 500 * 1024 });
  assert.equal(target.status, 'compressed');
  assert.ok(target.compression.attempts.length > 1);
  const missed = await run('unreachable', { mode: 'raster', target_bytes: 50 * 1024 });
  assert.equal(missed.status, 'target-not-reached');
  assert.ok(missed.compression.attempts.some(item => item.scale === 1 && item.quality === 0.4));
  const already = await run('already', { mode: 'raster', target_bytes: 50 * 1024 * 1024 });
  assert.equal(already.status, 'already-within-target');
  assert.equal(already.compression.attempts.length, 0);
  const noGain = await compressPdfFile({ input_path: tiny, output_path: path.join(root, 'no-gain.pdf'), mode: 'raster' });
  assert.equal(noGain.status, 'no-reduction');
  assert.equal(noGain.outputs.length, 0);
  const structural = await run('structure-target', { mode: 'structure', target_bytes: 50 * 1024 });
  assert.equal(structural.status, 'target-not-reached');
  await run('structure', { mode: 'structure', level: 'high' });
  const commandOutput = path.join(root, `command-${Date.now()}.pdf`);
  const command = await execute(process.execPath, ['cli/toolknit.mjs', 'pdf', 'compress', '--input', input,
    '--output', commandOutput, '--mode', 'raster', '--target-kb', '500', '--json'], { windowsHide: true });
  const commandResult = JSON.parse(command.stdout);
  assert.equal(commandResult.ok, true);
  assert.equal(commandResult.result.status, 'compressed');
  assert.ok((await stat(commandOutput)).size <= 512000);
  const guide = await execute(process.execPath, ['cli/toolknit.mjs', 'agent', 'guide'], { windowsHide: true });
  assert.ok(guide.stdout.includes('ToolKnit AI Agent'));
  const aborter = new AbortController();
  const cancelledPath = path.join(root, 'cancelled.pdf');
  const pending = compressPdfFile({ input_path: input, output_path: cancelledPath, mode: 'raster' }, { signal: aborter.signal });
  const timer = setTimeout(() => aborter.abort(), 80);
  await assert.rejects(pending, error => error.code === 'CANCELLED');
  clearTimeout(timer);
  await assert.rejects(stat(cancelledPath), { code: 'ENOENT' });
  assert.equal(hash(await readFile(input)), originalHash, 'original data is never changed');
  assert.deepEqual((await readdir(root)).filter(name => name.endsWith('.toolknit.tmp')), []);
  assert.deepEqual((await readdir(tmpdir())).filter(name => name.startsWith('toolknit-pdf-compress-') && !beforeCaches.has(name)), []);
  console.log('Real PDF raster/target/no-gain/already-compliant/geometry/cancellation and disk-cache checks passed.');
} finally { await writeFile(path.join(root, 'report.json'), JSON.stringify(report, null, 2)); }
