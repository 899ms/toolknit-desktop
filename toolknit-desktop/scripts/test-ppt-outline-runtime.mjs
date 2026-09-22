import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { generatePptOutline } from '../cli/lib/ppt-outline-runtime.mjs';

const projectRoot = path.resolve(import.meta.dirname, '..');
const cliPath = path.join(projectRoot, 'cli', 'toolknit.mjs');

function outlinePayload(slides = 4) {
  return {
    ready: true,
    title: 'ToolKnit PPT 大纲测试',
    subtitle: '结构化大纲输出',
    deck_type: 'product-launch',
    audience: '测试用户',
    purpose: '验证 CLI 和 MCP 可复用契约',
    fact_bank: {
      known_facts: ['ToolKnit 支持 PPT 大纲生成'],
      evidence: ['本地测试用例'],
      assumptions: ['演示内容面向测试用户'],
      missing_facts: ['真实发布版本号待确认'],
      no_invention: ['不要编造测试结果']
    },
    narrative: {
      communication_job: 'By the end, 测试用户 should trust the outline contract because outputs are validated.',
      arc: 'Context -> proof -> action',
      central_takeaway: 'PPT outline has stable JSON and Markdown outputs.'
    },
    design: {
      style: '极简',
      visual_system: '清晰标题与少量要点',
      color_hint: '黑白灰',
      font_hint: '无衬线'
    },
    slides: Array.from({ length: slides }, (_, index) => ({
      page: index + 1,
      role: index === 0 ? 'cover' : (index + 1 === slides ? 'closing' : 'content'),
      type: index === 0 ? 'title' : (index + 1 === slides ? 'closing' : 'content'),
      title: `第 ${index + 1} 页测试标题`,
      claim: `第 ${index + 1} 页主张`,
      body: [`要点 ${index + 1}-1`, `要点 ${index + 1}-2`],
      visual_suggestion: '使用产品截图或简单示意',
      layout_intent: {
        kind: index === 0 ? 'title' : (index + 1 === slides ? 'closing' : 'text-focus'),
        density: 'medium',
        text_blocks: 2,
        media_slots: 1,
        chart: 'none',
        visual_focus: '测试焦点'
      },
      speaker_note: '保持简洁讲述',
      transition: '自然进入下一页',
      data_needed: index === 1 ? ['补充真实截图'] : []
    })),
    quality_check: {
      missing_info: ['真实发布时间待确认'],
      risks: ['不要编造未经验证的指标'],
      next_steps: ['进入 PPTX 草稿生成'],
      self_check: {
        score: 91,
        passed: true,
        issues: ['真实发布时间待确认'],
        strengths: ['页面角色清楚', '质量自检可用']
      }
    }
  };
}

function mockFetchFor(slides) {
  return async (url, init) => {
    assert.match(String(url), /chat\/completions/);
    assert.match(String(init?.headers?.Authorization || ''), /^Bearer /);
    const body = JSON.parse(String(init.body || '{}'));
    assert.equal(body.model, 'toolknit-test-model');
    assert.equal(body.messages.at(-1).role, 'user');
    return new Response(JSON.stringify({
      choices: [{ message: { content: JSON.stringify(outlinePayload(slides)) } }]
    }), { status: 200, headers: { 'content-type': 'application/json' } });
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

const fixtureDirectory = await mkdtemp(path.join(os.tmpdir(), 'toolknit-ppt-outline-'));
const outputDirectory = path.join(fixtureDirectory, 'out');
const dryRun = await generatePptOutline({
  prompt: '生成一份 4 页 ToolKnit 功能发布 PPT 大纲。',
  output_dir: outputDirectory,
  slide_count: 4,
  dry_run: true
});
assert.equal(dryRun.tool, 'ppt.outline');
assert.equal(dryRun.dry_run, true);
assert.equal(dryRun.plan.requires_ai_provider, true);
assert.equal(dryRun.plan.schema_version, 2);
assert.equal(dryRun.plan.deck_type, 'auto');

const exported = await generatePptOutline({
  prompt: '生成一份 4 页 ToolKnit 功能发布 PPT 大纲。',
  output_dir: outputDirectory,
  slide_count: 4,
  audience: '开源用户',
  output_name: 'outline-demo'
}, {
  env: {
    TOOLKNIT_AI_API_KEY: 'toolknit-local-test-key',
    TOOLKNIT_AI_API_URL: 'http://127.0.0.1/v1/chat/completions',
    TOOLKNIT_AI_MODEL: 'toolknit-test-model'
  },
  fetchImpl: mockFetchFor(4),
  retryDelayMs: 0
});
assert.equal(exported.tool, 'ppt.outline');
assert.equal(exported.dry_run, false);
assert.equal(exported.outline.slides.length, 4);
assert.equal(exported.outline.version, 2);
assert.equal(exported.outline.deck_type, 'product-launch');
assert.equal(exported.outline.fact_bank.known_facts[0], 'ToolKnit 支持 PPT 大纲生成');
assert.equal(exported.outline.slides[0].role, 'cover');
assert.equal(exported.outputs.length, 3);
assert.ok(await stat(path.join(exported.output_dir, 'outline.md')).then(file => file.size > 100));
assert.ok(await stat(path.join(exported.output_dir, 'outline.json')).then(file => file.size > 100));
assert.ok(await stat(path.join(exported.output_dir, 'manifest.json')).then(file => file.size > 100));
const manifest = JSON.parse(await readFile(path.join(exported.output_dir, 'manifest.json'), 'utf8'));
assert.equal(manifest.slide_count, 4);
assert.equal(manifest.deck_type, 'product-launch');
assert.equal(manifest.quality_score, 100);
assert.equal(manifest.outputs.length, 3);

const cancelledOutputName = 'cancelled-outline';
const cancellation = new AbortController();
await assert.rejects(
  generatePptOutline({
    prompt: '生成一份取消时不应写入的大纲。',
    output_dir: outputDirectory,
    slide_count: 4,
    output_name: cancelledOutputName
  }, {
    env: {
      TOOLKNIT_AI_API_KEY: 'toolknit-local-test-key',
      TOOLKNIT_AI_API_URL: 'http://127.0.0.1/v1/chat/completions',
      TOOLKNIT_AI_MODEL: 'toolknit-test-model'
    },
    fetchImpl: mockFetchFor(4),
    retryDelayMs: 0,
    signal: cancellation.signal,
    reportProgress: value => {
      if (value === 62) cancellation.abort('Cancelled before local PPT outline export.');
    }
  }),
  error => error?.code === 'CANCELLED'
);
await assert.rejects(stat(path.join(outputDirectory, cancelledOutputName)), error => error?.code === 'ENOENT');

await assert.rejects(
  () => readdir(path.join(fixtureDirectory, 'missing-output')),
  /ENOENT/
);

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
  await writeFile(promptPath, '生成三页 ToolKnit Agent 演示 PPT 大纲。');
  const cli = await runCli([
    'ppt', 'outline',
    '--prompt-file', promptPath,
    '--output-dir', cliOutputDirectory,
    '--slide-count', '3',
    '--deck-type', 'product-launch',
    '--audience', 'IDE Agent 用户',
    '--json'
  ], {
    TOOLKNIT_AI_API_KEY: 'toolknit-local-test-key',
    TOOLKNIT_AI_API_URL: `http://127.0.0.1:${providerAddress.port}/v1/chat/completions`,
    TOOLKNIT_AI_MODEL: 'toolknit-test-model'
  });
  assert.equal(cli.code, 0, cli.stderr);
  const cliJson = JSON.parse(cli.stdout);
  assert.equal(cliJson.ok, true);
  assert.equal(cliJson.result.tool, 'ppt.outline');
  assert.equal(cliJson.result.outline.slides.length, 3);
  assert.equal(cliJson.result.outline.deck_type, 'product-launch');
  assert.match(providerAuthorization, /toolknit-local-test-key/);
  assert.equal(requestCount, 1);

  const cliDryRun = await runCli([
    'ppt', 'outline',
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

console.log('PPT outline runtime regression checks passed');
