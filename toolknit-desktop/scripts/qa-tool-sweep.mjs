import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { LAZY_TOOL_SPECS } from '../src/features/lazy-tools.js';

const DEBUG_ENDPOINT = process.env.TOOLKNIT_CDP_ENDPOINT || 'http://127.0.0.1:9223';
const REPORT_PATH = path.resolve('tmp', 'v3-overnight', 'tool-sweep', 'report.json');
const TOOL_SELECTOR = '.content-section:not([data-category="home"]) .audio-list-item';
const CLOSE_SELECTOR = [
  '[data-tool-close]',
  '[data-audio-extract-action="back"]',
  '[data-audio-convert-action="back"]',
  '[data-excel-action="back"]',
  '[data-tele-action="back"]',
  '[data-bgr-action="back"]',
  '.tool-page-v2-back',
  '[id$="Back"]',
  '[data-tool-window="close"]'
].join(', ');
const GATE_IDS = new Set(['aiKeyRequiredOverlay', 'dependencyGateOverlay', 'apiKeyOverlay']);
const NON_TOOL_VISIBLE_IDS = new Set(['screenPickerOverlay']);
const STRICT = process.env.TOOLKNIT_SWEEP_STRICT === '1';

class CdpClient {
  constructor(socket) {
    this.socket = socket;
    this.nextId = 1;
    this.pending = new Map();
    this.logs = [];
    socket.addEventListener('message', event => {
      const message = JSON.parse(String(event.data));
      if (message.method === 'Runtime.exceptionThrown') {
        this.logs.push({
          type: 'exception',
          text: String(message.params?.exceptionDetails?.text || 'runtime exception')
        });
      }
      if (message.method === 'Runtime.consoleAPICalled') {
        const type = String(message.params?.type || '');
        if (type === 'error' || type === 'warning') {
          this.logs.push({
            type,
            text: (message.params?.args || []).map(arg => arg.value ?? arg.description ?? '').join(' ')
          });
        }
      }
      if (message.method === 'Log.entryAdded') {
        const level = String(message.params?.entry?.level || '');
        if (level === 'error' || level === 'warning') {
          this.logs.push({ type: level, text: String(message.params?.entry?.text || '') });
        }
      }
      if (!message.id) return;
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message));
      else pending.resolve(message.result);
    });
  }

  static async connect() {
    const targets = await fetch(`${DEBUG_ENDPOINT}/json/list`).then(response => response.json());
    const target = targets.find(item => item.type === 'page' && /tauri\.localhost|localhost:1420/.test(item.url))
      || targets.find(item => item.type === 'page');
    assert.ok(target?.webSocketDebuggerUrl, 'CDP page target must exist');
    const socket = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      socket.addEventListener('open', resolve, { once: true });
      socket.addEventListener('error', () => reject(new Error('Cannot connect to WebView CDP')), { once: true });
    });
    const client = new CdpClient(socket);
    await client.send('Runtime.enable');
    await client.send('Log.enable');
    return client;
  }

  send(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  async evaluate(expression) {
    const response = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true
    });
    if (response.exceptionDetails) {
      throw new Error(response.exceptionDetails.exception?.description || response.exceptionDetails.text || 'CDP evaluation failed');
    }
    return response.result?.value;
  }

  async waitFor(expression, timeoutMs = 10_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await this.evaluate(expression)) return true;
      await new Promise(resolve => setTimeout(resolve, 30));
    }
    throw new Error(`Timed out waiting for ${expression}`);
  }

  close() {
    this.socket.close();
  }
}

const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

function isExpectedEnvironmentLog(log) {
  return /event\.listen not allowed|app\.version not allowed|Plugin not found|native .*registration .*failed|native .*drop .*failed/i.test(log.text);
}

async function snapshot(client, toolId, overlayId) {
  return client.evaluate(`(() => {
    const target = document.getElementById(${JSON.stringify(overlayId)});
    const active = document.activeElement;
    const rect = target?.getBoundingClientRect();
    return {
      toolId: ${JSON.stringify(toolId)},
      targetVisible: Boolean(target?.classList.contains('visible')),
      targetAriaHidden: target?.getAttribute('aria-hidden') ?? null,
      targetInert: target?.inert ?? null,
      targetRect: rect ? { width: rect.width, height: rect.height } : null,
      hasClose: Boolean(target?.querySelector(${JSON.stringify(CLOSE_SELECTOR)})),
      active: active?.id || active?.tagName || '',
      activeInsideTarget: Boolean(target && active && target.contains(active)),
      visibleOverlays: [...document.querySelectorAll('[id$="Overlay"], [id$="Workspace"]')]
        .filter(node => node.classList.contains('visible'))
        .map(node => node.id),
      gates: [...document.querySelectorAll('[id$="Overlay"]')]
        .filter(node => node.classList.contains('visible') && ${JSON.stringify([...GATE_IDS])}.includes(node.id))
        .map(node => node.id)
    };
  })()`);
}

async function closeTransientOverlays(client) {
  await client.evaluate(`(() => {
    const directIds = ['aiKeyRequiredCancel', 'dependencyGateCancel', 'apiKeyBack'];
    directIds.forEach(id => document.getElementById(id)?.click());
    const roots = [...document.querySelectorAll('[id$="Overlay"], [id$="Workspace"]')]
      .filter(node => node.classList.contains('visible') && !${JSON.stringify([...NON_TOOL_VISIBLE_IDS])}.includes(node.id));
    roots.reverse().forEach(root => root.querySelector(${JSON.stringify(CLOSE_SELECTOR)})?.click());
    return true;
  })()`);
  await sleep(120);
}

async function resetPage(client) {
  await closeTransientOverlays(client);
  const clean = await client.evaluate(`![...document.querySelectorAll('[id$="Overlay"], [id$="Workspace"]')]
    .some(node => node.classList.contains('visible') && !${JSON.stringify([...NON_TOOL_VISIBLE_IDS])}.includes(node.id))`);
  if (clean) return;
  await client.send('Page.reload', { ignoreCache: true });
  await client.waitFor(`document.readyState === 'complete' && document.querySelectorAll(${JSON.stringify(TOOL_SELECTOR)}).length === 65`, 15_000);
  await sleep(350);
}

async function main() {
  await mkdir(path.dirname(REPORT_PATH), { recursive: true });
  const client = await CdpClient.connect();
  const entries = Object.entries(LAZY_TOOL_SPECS);
  const report = {
    endpoint: DEBUG_ENDPOINT,
    generatedAt: new Date().toISOString(),
    strict: STRICT,
    toolCount: entries.length,
    environment: null,
    results: [],
    summary: null,
    status: 'running'
  };
  try {
    await client.send('Emulation.setDeviceMetricsOverride', {
      width: 1366, height: 768, deviceScaleFactor: 1, mobile: false
    });
    await client.waitFor(`document.readyState === 'complete' && document.querySelectorAll(${JSON.stringify(TOOL_SELECTOR)}).length === 65`, 15_000);
    report.environment = await client.evaluate(`({
      href: location.href,
      isTauri: Boolean(window.__TAURI_INTERNALS__),
      viewport: { width: innerWidth, height: innerHeight }
    })`);
    await resetPage(client);

    for (const [toolId, spec] of entries) {
      await resetPage(client);
      const logStart = client.logs.length;
      const started = Date.now();
      const result = { toolId, overlayId: spec.overlayId, status: 'failed', error: null, state: null, afterClose: null, logs: [] };
      try {
        const clicked = await client.evaluate(`(() => {
          const node = [...document.querySelectorAll(${JSON.stringify(TOOL_SELECTOR)})]
            .find(candidate => candidate.dataset.tool === ${JSON.stringify(toolId)});
          if (!node) return false;
          node.click();
          return true;
        })()`);
        assert.equal(clicked, true, `${toolId}: launcher must exist`);
        await client.waitFor(`document.getElementById(${JSON.stringify(spec.overlayId)})?.classList.contains('visible')
          || [...document.querySelectorAll('[id$="Overlay"]')].some(node => node.classList.contains('visible')
            && ${JSON.stringify([...GATE_IDS])}.includes(node.id))`, 12_000);
        result.state = await snapshot(client, toolId, spec.overlayId);
        if (result.state.targetVisible) {
          assert.equal(result.state.targetAriaHidden, 'false', `${toolId}: visible overlay must expose aria-hidden=false`);
          assert.equal(result.state.targetInert, false, `${toolId}: visible overlay must not be inert`);
          assert.ok((result.state.targetRect?.width || 0) > 0 && (result.state.targetRect?.height || 0) > 0, `${toolId}: visible overlay must have a box`);
          assert.equal(result.state.hasClose, true, `${toolId}: visible overlay must have a close/back control`);
          await client.evaluate(`document.getElementById(${JSON.stringify(spec.overlayId)})?.querySelector(${JSON.stringify(CLOSE_SELECTOR)})?.click()`);
          await client.waitFor(`!document.getElementById(${JSON.stringify(spec.overlayId)})?.classList.contains('visible')`, 10_000);
          await sleep(260);
          result.afterClose = await snapshot(client, toolId, spec.overlayId);
          assert.equal(result.afterClose.targetVisible, false, `${toolId}: overlay must close`);
          assert.equal(result.afterClose.activeInsideTarget, false, `${toolId}: focus must leave closed overlay`);
          result.status = 'opened-and-closed';
        } else if (result.state.gates.length) {
          result.status = 'dependency-gated';
          await closeTransientOverlays(client);
        } else {
          throw new Error(`${toolId}: no target overlay or known dependency gate became visible`);
        }
      } catch (error) {
        result.error = String(error?.message || error);
      }
      result.durationMs = Date.now() - started;
      result.logs = client.logs.slice(logStart);
      report.results.push(result);
      console.log(`${toolId}: ${result.status}${result.error ? ` (${result.error})` : ''}`);
    }

    const allLogs = report.results.flatMap(result => result.logs);
    const unexpectedLogs = allLogs.filter(log => !isExpectedEnvironmentLog(log));
    report.summary = {
      total: report.results.length,
      openedAndClosed: report.results.filter(result => result.status === 'opened-and-closed').length,
      dependencyGated: report.results.filter(result => result.status === 'dependency-gated').length,
      failed: report.results.filter(result => result.status === 'failed' || result.error).length,
      expectedEnvironmentLogs: allLogs.length - unexpectedLogs.length,
      unexpectedLogs: unexpectedLogs.length
    };
    if (STRICT) assert.equal(report.summary.unexpectedLogs, 0, 'tool sweep must not emit unexpected console errors/warnings');
    assert.equal(report.summary.failed, 0, 'tool sweep must open or gate every registered tool');
    report.status = 'passed';
    console.log(`Tool sweep passed: ${path.relative(process.cwd(), REPORT_PATH)}`);
  } catch (error) {
    report.status = 'failed';
    report.error = String(error?.stack || error);
    throw error;
  } finally {
    await writeFile(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`);
    await client.send('Emulation.clearDeviceMetricsOverride').catch(() => {});
    client.close();
  }
}

main().catch(error => {
  console.error(error?.stack || error);
  process.exitCode = 1;
});
