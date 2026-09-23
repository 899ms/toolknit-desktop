import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, unlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { listSourceFiles } from './lib/source-inventory.mjs';

const root = mkdtempSync(join(tmpdir(), 'toolknit-source-audit-'));
const git = args => execFileSync('git', args, { cwd: root, windowsHide: true, stdio: 'pipe' });
try {
  git(['init', '--quiet']);
  writeFileSync(join(root, '.gitignore'), '*.log\n');
  writeFileSync(join(root, 'existing.js'), 'export const existing = true;');
  writeFileSync(join(root, 'deleted.txt'), 'old font license');
  git(['add', '.']);
  unlinkSync(join(root, 'deleted.txt'));
  writeFileSync(join(root, 'new source.js'), 'export const added = true;');
  writeFileSync(join(root, 'ignored.log'), 'generated output');
  assert.deepEqual(listSourceFiles(root).sort(), ['.gitignore', 'existing.js', 'new source.js']);
  assert.equal(git(['status', '--porcelain']).toString().includes('?? "new source.js"'), true,
    'inventory must not stage or mutate new source files');
} finally {
  rmSync(root, { recursive: true, force: true });
}
console.log('Source inventory passed: tracked, newly added, deleted, ignored and spaced paths.');
