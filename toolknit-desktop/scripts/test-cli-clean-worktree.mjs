import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const projectRoot = path.resolve(import.meta.dirname, '..');
const npmCli = process.env.npm_execpath;
if (!npmCli) throw new Error('test:cli-clean-worktree must be started through npm.');

function run(command, args, options = {}) {
  return execFileSync(command, args, {
    cwd: options.cwd,
    encoding: 'utf8',
    stdio: options.stdio ?? 'pipe',
    maxBuffer: 20 * 1024 * 1024,
    windowsHide: true
  });
}

function runNode(entry, args, cwd) {
  const child = spawn(process.execPath, [entry, ...args], {
    cwd,
    shell: false,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe']
  });
  return new Promise((resolve, reject) => {
    const stdout = [];
    const stderr = [];
    child.stdout.on('data', chunk => stdout.push(chunk));
    child.stderr.on('data', chunk => stderr.push(chunk));
    child.once('error', reject);
    child.once('close', code => resolve({
      code,
      stdout: Buffer.concat(stdout).toString('utf8'),
      stderr: Buffer.concat(stderr).toString('utf8')
    }));
  });
}

function runMcp(entry, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [entry, 'mcp', 'serve'], {
      cwd,
      shell: false,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe']
    });
    let buffer = '';
    const responses = new Map();
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      try { child.kill(); } catch {}
      if (error) reject(error); else resolve(value);
    };
    const timeout = setTimeout(() => finish(new Error('Timed out waiting for the clean-worktree MCP server.')), 15000);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      buffer += chunk;
      let newline;
      while ((newline = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line) continue;
        let message;
        try { message = JSON.parse(line); } catch (error) {
          finish(new Error(`MCP emitted invalid JSON: ${error.message}`));
          return;
        }
        if (message.id !== undefined) responses.set(message.id, message);
        if (responses.has(2)) finish(null, responses);
      }
    });
    const stderr = [];
    child.stderr.on('data', chunk => stderr.push(chunk));
    child.once('error', finish);
    child.stdin.end([
      JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26' } }),
      JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
      JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} })
    ].join('\n') + '\n');
  });
}

const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'toolknit-v3-cli-'));
const worktreePath = path.join(tempRoot, 'worktree');
const consumerPath = path.join(tempRoot, 'consumer');
let worktreeAdded = false;
try {
  const gitRoot = run('git', ['rev-parse', '--show-toplevel'], { cwd: projectRoot }).trim();
  run('git', ['worktree', 'add', '--detach', worktreePath, 'HEAD'], { cwd: gitRoot, stdio: 'inherit' });
  worktreeAdded = true;
  const worktreeProject = path.join(worktreePath, path.basename(projectRoot));
  const cleanStatus = run('git', ['status', '--porcelain', '--untracked-files=all'], { cwd: worktreeProject }).trim();
  assert.equal(cleanStatus, '', `fresh Git worktree must be clean, got:\n${cleanStatus}`);

  run(process.execPath, [npmCli, 'run', 'stage:cli-resources'], { cwd: worktreeProject, stdio: 'inherit' });
  const stagedStatus = run('git', ['status', '--porcelain', '--untracked-files=all'], { cwd: worktreeProject }).trim();
  assert.equal(stagedStatus, '', `staged CLI resources must remain ignored:\n${stagedStatus}`);

  const packOutput = run(process.execPath, [npmCli, 'pack', '--ignore-scripts', '--json'], { cwd: path.join(worktreeProject, 'cli') });
  const pack = JSON.parse(packOutput)[0];
  const tarball = path.join(worktreeProject, 'cli', pack.filename);
  assert.equal(pack.version, JSON.parse(await readFile(path.join(worktreeProject, 'cli', 'package.json'), 'utf8')).version);

  await rm(consumerPath, { recursive: true, force: true });
  await mkdir(consumerPath, { recursive: true });
  await writeFile(path.join(consumerPath, 'package.json'), JSON.stringify({ private: true, name: 'toolknit-clean-worktree-consumer' }));
  run(process.execPath, [npmCli, 'install', '--ignore-scripts', '--no-audit', '--no-fund', '--package-lock=false', tarball], { cwd: consumerPath, stdio: 'inherit' });

  const entry = path.join(consumerPath, 'node_modules', '@toolknit', 'cli', 'toolknit.mjs');
  const version = await runNode(entry, ['--version'], consumerPath);
  assert.equal(version.code, 0, version.stderr);
  assert.equal(version.stderr.trim(), '');
  assert.equal(version.stdout.trim(), pack.version);
  const help = await runNode(entry, ['help', 'pdf', 'merge'], consumerPath);
  assert.equal(help.code, 0, help.stderr);
  assert.match(help.stdout, /toolknit pdf merge/);
  assert.equal(help.stderr.trim(), '');

  const mcp = await runMcp(entry, consumerPath);
  const initialize = mcp.get(1);
  const tools = mcp.get(2);
  assert.equal(initialize?.result?.serverInfo?.version, pack.version);
  assert.equal(initialize?.result?.capabilities?.tools?.listChanged, false);
  assert.ok(Array.isArray(tools?.result?.tools));
  assert.ok(tools.result.tools.length >= 46, `expected at least 46 MCP tools, got ${tools.result.tools.length}`);

  console.log(`Clean-worktree CLI package passed: ${pack.filename}; installed version ${pack.version}; ${tools.result.tools.length} MCP tools listed.`);
} finally {
  if (worktreeAdded) {
    try { run('git', ['worktree', 'remove', '--force', worktreePath], { cwd: projectRoot }); } catch {}
  }
  await rm(tempRoot, { recursive: true, force: true });
}
