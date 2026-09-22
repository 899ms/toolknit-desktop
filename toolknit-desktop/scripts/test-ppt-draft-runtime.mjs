import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { analyzePptxText } from '../src/ppt-text-extract-core.js';
import { generatePptDraft } from '../cli/lib/ppt-draft-runtime.mjs';

const projectRoot = path.resolve(import.meta.dirname, '..');
const cliPath = path.join(projectRoot, 'cli', 'toolknit.mjs');

function outlinePayload(slides = 4) {
  return {
    ready: true,
    title: 'ToolKnit PPT 草稿运行时测试',
    subtitle: '结构到 PPTX',
    audience: '测试用户',
    purpose: '验证 CLI 和 MCP 可复用契约',
    narrative: {
      communication_job: 'By the end, users should trust the PPTX draft contract.',
      arc: 'Context -> proof -> action',
      central_takeaway: 'PPT draft creates editable slides.'
    },
    design: {
      style: '极简',
      visual_system: '清晰标题与少量要点',
      color_hint: '黑白灰',
      font_hint: 'Microsoft YaHei'
    },
    slides: Array.from({ length: slides }, (_, index) => ({
      page: index + 1,
      type: index === 0 ? 'title' : (index + 1 === slides ? 'closing' : 'content'),
      title: `第 ${index + 1} 页测试标题`,
      claim: `第 ${index + 1} 页主张`,
      body: [`要点 ${index + 1}-1`, `要点 ${index + 1}-2`],
      visual_suggestion: '使用产品截图或简单示意',
      speaker_note: '保持简洁讲述',
      transition: '自然进入下一页',
      data_needed: []
    })),
    quality_check: {
      missing_info: [],
      risks: ['不要编造未经验证的指标'],
      next_steps: ['人工微调视觉']
    }
  };
}

function runCli(args, environment = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliPath, ...args], {
      cwd: projectRoot,
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, ...environment }
    });
    const stdout = [];
    const stderr = [];
    child.stdout.on('data', chunk => stdout.push(chunk));
    child.stderr.on('data', chunk => stderr.push(chunk));
    child.once('error', reject);
    child.once('close', code => resolve({
      code,
      stdout: Buffer.concat(stdout).toString('utf8').trim(),
      stderr: Buffer.concat(stderr).toString('utf8').trim()
    }));
  });
}

const fixtureDirectory = await mkdtemp(path.join(os.tmpdir(), 'toolknit-ppt-draft-'));
const outputDirectory = path.join(fixtureDirectory, 'out');

const dryRun = await generatePptDraft({
  prompt: '生成一份 4 页 ToolKnit 功能发布 PPT 草稿。',
  output_dir: outputDirectory,
  slide_count: 4,
  theme: 'minimal-light',
  dry_run: true
});
assert.equal(dryRun.tool, 'ppt.draft');
assert.equal(dryRun.dry_run, true);
assert.equal(dryRun.plan.requires_ai_provider, true);
assert.equal(dryRun.plan.theme, 'minimal-light');

await assert.rejects(
  generatePptDraft({ output_dir: outputDirectory, dry_run: true }),
  error => error?.code === 'INVALID_ARGUMENT' && /exactly one/i.test(error.message)
);
await assert.rejects(
  generatePptDraft({
    prompt: '不要静默选择输入来源。',
    outline: outlinePayload(3),
    output_dir: outputDirectory,
    dry_run: true
  }),
  error => error?.code === 'INVALID_ARGUMENT' && /exactly one/i.test(error.message)
);

const outlinePath = path.join(fixtureDirectory, 'outline.json');
await writeFile(outlinePath, `${JSON.stringify(outlinePayload(4), null, 2)}\n`, 'utf8');
const themedOutlinePath = path.join(fixtureDirectory, 'outline-themed.json');
await writeFile(themedOutlinePath, `${JSON.stringify({
  ...outlinePayload(4),
  request: {
    prompt: '导入已有浅色大纲生成 PPTX 草稿。',
    slide_count: 4,
    deck_type: 'product-launch',
    theme: 'minimal-light',
    style: '浅色白色空间留白'
  }
}, null, 2)}\n`, 'utf8');
const fromOutline = await generatePptDraft({
  outline_path: outlinePath,
  output_dir: outputDirectory,
  theme: 'tech-blue',
  output_name: 'outline-to-pptx'
});
assert.equal(fromOutline.tool, 'ppt.draft');
assert.equal(fromOutline.dry_run, false);
assert.equal(fromOutline.theme, 'tech-blue');
assert.equal(fromOutline.output_file, 'outline-to-pptx.pptx');
assert.ok(await stat(fromOutline.output_path).then(file => file.size > 8000));
assert.ok(await stat(path.join(fromOutline.output_dir, 'manifest.json')).then(file => file.size > 100));
const extracted = await analyzePptxText(await readFile(fromOutline.output_path), { sourceName: 'draft.pptx' });
assert.equal(extracted.slide_count, 4);
assert.equal(extracted.slides[0].title.replace(/\r?\n/g, ''), 'ToolKnit PPT 草稿运行时测试');

const cancelledOutputName = 'cancelled-draft';
const cancellation = new AbortController();
await assert.rejects(
  generatePptDraft({
    outline_path: outlinePath,
    output_dir: outputDirectory,
    output_name: cancelledOutputName
  }, {
    signal: cancellation.signal,
    reportProgress: value => {
      if (value === 58) cancellation.abort('Cancelled before local PPT draft build.');
    }
  }),
  error => error?.code === 'CANCELLED'
);
await assert.rejects(stat(path.join(outputDirectory, cancelledOutputName)), error => error?.code === 'ENOENT');

const fromThemedOutline = await generatePptDraft({
  outline_path: themedOutlinePath,
  output_dir: outputDirectory,
  output_name: 'outline-theme-inherited'
});
assert.equal(fromThemedOutline.theme, 'minimal-light');

let providerAuthorization = '';
let requestCount = 0;
const providerServer = createServer((request, response) => {
  providerAuthorization = String(request.headers.authorization || '');
  const chunks = [];
  request.on('data', chunk => chunks.push(chunk));
  request.on('end', () => {
    requestCount += 1;
    const payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    assert.equal(payload.model, 'toolknit-test-model');
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(outlinePayload(3)) } }] }));
  });
});

try {
  await new Promise(resolve => providerServer.listen(0, '127.0.0.1', resolve));
  const providerAddress = providerServer.address();
  const cliOutputDirectory = path.join(fixtureDirectory, 'cli-out');
  const promptPath = path.join(fixtureDirectory, 'brief.txt');
  await writeFile(promptPath, '生成三页 ToolKnit Agent 演示 PPTX 草稿。');
  const cli = await runCli([
    'ppt', 'draft',
    '--prompt-file', promptPath,
    '--output-dir', cliOutputDirectory,
    '--slide-count', '3',
    '--theme', 'minimal-dark',
    '--output-name', 'cli-draft',
    '--json'
  ], {
    TOOLKNIT_AI_API_KEY: 'toolknit-local-test-key',
    TOOLKNIT_AI_API_URL: `http://127.0.0.1:${providerAddress.port}/v1/chat/completions`,
    TOOLKNIT_AI_MODEL: 'toolknit-test-model'
  });
  assert.equal(cli.code, 0, cli.stderr);
  const cliJson = JSON.parse(cli.stdout);
  assert.equal(cliJson.ok, true);
  assert.equal(cliJson.result.tool, 'ppt.draft');
  assert.equal(cliJson.result.outline.slides.length, 3);
  assert.equal(path.basename(cliJson.result.output_path), 'cli-draft.pptx');
  assert.match(providerAuthorization, /toolknit-local-test-key/);
  assert.equal(requestCount, 1);

  const cliOutline = await runCli([
    'ppt', 'draft',
    '--outline-file', outlinePath,
    '--output-dir', cliOutputDirectory,
    '--theme', 'minimal-light',
    '--json'
  ], { TOOLKNIT_AI_API_KEY: '' });
  assert.equal(cliOutline.code, 0, cliOutline.stderr);
  assert.equal(JSON.parse(cliOutline.stdout).result.dry_run, false);

  const cliDryRun = await runCli([
    'ppt', 'draft',
    '--prompt', '只做 dry run',
    '--output-dir', cliOutputDirectory,
    '--slide-count', '3',
    '--dry-run',
    '--json'
  ], { TOOLKNIT_AI_API_KEY: '' });
  assert.equal(cliDryRun.code, 0, cliDryRun.stderr);
  assert.equal(JSON.parse(cliDryRun.stdout).result.dry_run, true);
} finally {
  await new Promise(resolve => providerServer.close(() => resolve()));
}

console.log('PPT draft runtime regression checks passed');
