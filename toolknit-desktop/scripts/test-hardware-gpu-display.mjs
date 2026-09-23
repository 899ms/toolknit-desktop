import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';

const [rustSource, cliSource] = await Promise.all([
  Promise.all([
    readFile(new URL('../src-tauri/src/native_runtime.rs', import.meta.url), 'utf8'),
    readFile(new URL('../src-tauri/src/native_runtime/system.rs', import.meta.url), 'utf8')
  ]).then(parts => parts.join('\n')),
  readFile(new URL('../cli/lib/hardware-runtime.mjs', import.meta.url), 'utf8')
]);

const safeConnectionConversion = /connection_code\s*=\s*if\s*\(\$null\s+-ne\s+\$connection\s+-and\s+\$null\s+-ne\s+\$connection\.VideoOutputTechnology\)\s*\{\s*try\s*\{\s*\[Int64\]\$connection\.VideoOutputTechnology\s*\}\s*catch\s*\{\s*\[Int64\]-1\s*\}\s*\}\s*else\s*\{\s*\[Int64\]-1\s*\}/;

for (const [name, source] of [['desktop', rustSource], ['CLI', cliSource]]) {
  assert.match(source, safeConnectionConversion, `${name} GPU display collector must preserve UInt32 connection codes and degrade only the invalid field`);
  assert.doesNotMatch(source, /\[int\]\$connection\.VideoOutputTechnology/, `${name} GPU display collector must not narrow UInt32 connection codes to Int32`);
}

if (process.platform === 'win32') {
  const script = String.raw`
$values = @(0, 4, 5, 6, 10, 11, 2147483648)
$converted = @($values | ForEach-Object {
  $connection = [pscustomobject]@{ VideoOutputTechnology = [UInt32]$_ }
  try { [Int64]$connection.VideoOutputTechnology } catch { [Int64]-1 }
})
$converted | ConvertTo-Json -Compress
`;
  const result = spawnSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], {
    encoding: 'utf8',
    windowsHide: true
  });
  assert.equal(result.status, 0, result.stderr || 'PowerShell connection-code conversion failed');
  assert.deepEqual(JSON.parse(result.stdout.trim()), [0, 4, 5, 6, 10, 11, 2147483648]);
}

console.log('GPU display connection-code regression checks passed');
