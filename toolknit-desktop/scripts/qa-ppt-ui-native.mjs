import assert from 'node:assert/strict';
import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PDFDocument } from 'pdf-lib';
import { buildPptDraftPptx } from '../src/ppt-draft-core.js';

const DEBUG_ENDPOINT = process.env.TOOLKNIT_CDP_ENDPOINT || 'http://127.0.0.1:9223';
const REPORT_PATH = path.resolve('tmp', 'ppt-ui-native-report.json');

class CdpClient {
  constructor(socket) {
    this.socket = socket;
    this.nextId = 1;
    this.pending = new Map();
    this.logs = [];
    socket.addEventListener('message', event => {
      const message = JSON.parse(String(event.data));
      if (message.method === 'Runtime.exceptionThrown') {
        this.logs.push({ type: 'exception', text: String(message.params?.exceptionDetails?.text || '') });
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
    assert.ok(target?.webSocketDebuggerUrl, 'ToolKnit WebView CDP target must exist');
    const socket = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      socket.addEventListener('open', resolve, { once: true });
      socket.addEventListener('error', () => reject(new Error('Cannot connect to ToolKnit WebView CDP')), { once: true });
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

  async invoke(command, args = {}) {
    const result = await this.evaluate(`(async () => {
      try {
        return { ok: true, value: await window.__TAURI_INTERNALS__.invoke(${JSON.stringify(command)}, ${JSON.stringify(args)}) };
      } catch (error) {
        return { ok: false, error: String(error) };
      }
    })()`);
    if (!result?.ok) throw new Error(result?.error || `${command} failed`);
    return result.value;
  }

  async waitFor(expression, timeoutMs = 60_000) {
    const deadline = Date.now() + timeoutMs;
    let lastError = null;
    while (Date.now() < deadline) {
      try {
        if (await this.evaluate(expression)) return true;
      } catch (error) {
        lastError = error;
      }
      await new Promise(resolve => setTimeout(resolve, 40));
    }
    throw new Error(`Timed out waiting for ${expression}${lastError ? `: ${lastError.message}` : ''}`);
  }

  clearLogs() {
    this.logs.length = 0;
  }

  close() {
    this.socket.close();
  }
}

function outlinePayload(slides = 4) {
  return {
    ready: true,
    title: 'PPT UI native QA',
    subtitle: 'Intermediate PDF lifecycle',
    audience: 'QA',
    purpose: 'Verify the desktop PPT-to-image workflow.',
    narrative: { central_takeaway: 'The native workflow opens the PDF page selector and cleans intermediate output.' },
    design: {},
    slides: Array.from({ length: slides }, (_, index) => ({
      page: index + 1,
      type: index === 0 ? 'title' : 'content',
      title: `UI QA slide ${index + 1}`,
      claim: `Native slide ${index + 1}`,
      body: ['The source remains unchanged.', 'The selector owns page interaction.'],
      visual_suggestion: 'Text-only QA slide',
      speaker_note: 'Synthetic fixture',
      transition: 'Continue'
    }))
  };
}

async function createFixture(filePath) {
  const draft = await buildPptDraftPptx(outlinePayload(), { theme: 'minimal-light' });
  await writeFile(filePath, draft.bytes);
}

async function listFiles(root, extension = '') {
  const result = [];
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true }).catch(() => [])) {
      const candidate = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(candidate);
      else if (!extension || entry.name.toLowerCase().endsWith(extension)) result.push(candidate);
    }
  }
  await visit(root);
  return result;
}

async function waitForNoFiles(root, extension = '', timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  let files = [];
  while (Date.now() < deadline) {
    files = await listFiles(root, extension);
    if (files.length === 0) return files;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  return files;
}

async function injectPptx(client, inputPath) {
  const bytes = await readFile(inputPath);
  const base64 = Buffer.from(bytes).toString('base64');
  const injected = await client.evaluate(`(() => {
    const bytes = Uint8Array.from(atob(${JSON.stringify(base64)}), character => character.charCodeAt(0));
    const file = new File([bytes], 'ppt-ui-native-qa.pptx', {
      type: 'application/vnd.openxmlformats-officedocument.presentationml.presentation'
    });
    Object.defineProperty(file, 'path', {
      value: ${JSON.stringify(inputPath)},
      configurable: true,
      enumerable: true
    });
    const input = document.querySelector('#pptToImageFileInput');
    if (!input) return false;
    const transfer = new DataTransfer();
    transfer.items.add(file);
    input.files = transfer.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`);
  assert.equal(injected, true, 'PPT-to-image file input must be available');
}

async function visibleOverlayIds(client) {
  return client.evaluate(`([...document.querySelectorAll('[id$="Overlay"], [id$="Workspace"]')]
    .filter(node => node.classList.contains('visible') && getComputedStyle(node).display !== 'none')
    .map(node => node.id))`);
}

async function snapshot(client) {
  return client.evaluate(`(() => {
    const read = selector => {
      const node = document.querySelector(selector);
      if (!node) return null;
      const style = getComputedStyle(node);
      const rect = node.getBoundingClientRect();
      return {
        visible: node.classList.contains('visible'),
        hidden: node.hidden,
        ariaHidden: node.getAttribute('aria-hidden'),
        inert: node.inert,
        disabled: Boolean(node.disabled),
        opacity: style.opacity,
        rect: { top: rect.top, left: rect.left, width: rect.width, height: rect.height },
        scrollHeight: node.scrollHeight,
        clientHeight: node.clientHeight,
        scrollWidth: node.scrollWidth,
        clientWidth: node.clientWidth
      };
    };
    return {
      pptOverlay: read('#pptToImageOverlay'),
      pptEmpty: read('#pptToImageEmpty'),
      pptResults: read('#pptToImageResults'),
      pptAction: read('#pptToImageOpenWorkspaceBtn'),
      pdfOverlay: read('#pdfToImageOverlay'),
      pdfWorkspace: read('#pdfToImageWorkspace'),
      pageCount: document.querySelectorAll('#pdfToImagePageStrip .pdf-page-workspace-page-select').length,
      active: document.activeElement?.id || document.activeElement?.tagName || '',
      overlays: [...document.querySelectorAll('[id$="Overlay"], [id$="Workspace"]')]
        .filter(node => node.classList.contains('visible')).map(node => node.id)
    };
  })()`);
}

async function main() {
  const root = await mkdtemp(path.join(tmpdir(), 'toolknit-ppt-ui-native-qa-'));
  const inputPath = path.join(root, 'ppt-ui-native-qa.pptx');
  const outputRoot = path.join(root, 'outputs');
  await mkdir(outputRoot, { recursive: true });
  await createFixture(inputPath);

  const client = await CdpClient.connect();
  const previousOutputRoot = await client.invoke('get_output_root');
  const report = {
    endpoint: DEBUG_ENDPOINT,
    generatedAt: new Date().toISOString(),
    upload: null,
    workspace: null,
    intermediatePdfBeforeClose: [],
    intermediatePdfAfterWorkspaceClose: [],
    intermediatePdfAfterToolClose: [],
    reopen: null,
    consoleLogs: [],
    status: 'running'
  };

  try {
    await client.invoke('set_output_root', { outputDir: outputRoot });
    client.clearLogs();
    await client.send('Emulation.setDeviceMetricsOverride', {
      width: 1366, height: 768, deviceScaleFactor: 1, mobile: false
    });
    await client.send('Page.reload', { ignoreCache: true });
    await client.waitFor(`document.readyState === 'complete'
      && document.querySelector('[data-tool="ppt-to-image"], [data-home-tool="ppt-to-image"]')`);
    // A WebView reload can deliver callbacks from the previous page after the
    // new document is ready. Only logs emitted by this QA scenario are useful.
    client.clearLogs();

    const clicked = await client.evaluate(`(() => {
      const card = document.querySelector('[data-tool="ppt-to-image"], [data-home-tool="ppt-to-image"]');
      if (!card) return false;
      card.click();
      return true;
    })()`);
    assert.equal(clicked, true, 'PPT-to-image home card must be available');
    await client.waitFor(`document.querySelector('#pptToImageOverlay')?.classList.contains('visible')`);
    await injectPptx(client, inputPath);
    await client.waitFor(`document.querySelector('#pptToImageResults')?.hidden === false
      && document.querySelector('#pptToImageOpenWorkspaceBtn')?.hidden === false
      && document.querySelector('#pptToImageOpenWorkspaceBtn')?.disabled === false`, 120_000);
    report.upload = await snapshot(client);
    assert.equal(report.upload.pptEmpty.hidden, true);
    assert.equal(report.upload.pptResults.hidden, false);
    assert.equal(report.upload.pptAction.disabled, false);

    await client.evaluate(`document.querySelector('#pptToImageOpenWorkspaceBtn').click(); true`);
    await client.waitFor(`document.querySelector('#pdfToImageOverlay')?.classList.contains('visible')
      && document.querySelector('#pdfToImageWorkspace')?.classList.contains('visible')`, 180_000);
    await client.waitFor(`document.querySelectorAll('#pdfToImagePageStrip .pdf-page-workspace-page-select').length === 4`, 120_000);
    report.workspace = await snapshot(client);
    assert.equal(report.workspace.pptOverlay.visible, false);
    assert.equal(report.workspace.pdfOverlay.visible, true);
    assert.equal(report.workspace.pdfWorkspace.visible, true);
    assert.equal(report.workspace.pageCount, 4);
    assert.ok(report.workspace.pdfWorkspace.rect.top <= 1, 'PDF page workspace must cover the top edge');

    report.intermediatePdfBeforeClose = await listFiles(outputRoot, '.pdf');
    assert.ok(report.intermediatePdfBeforeClose.length >= 1, 'PPT-to-image must produce a PDF for the selector session');
    for (const filePath of report.intermediatePdfBeforeClose) {
      assert.ok((await stat(filePath)).size > 1000, `intermediate PDF must be non-empty: ${filePath}`);
      const pdf = await PDFDocument.load(await readFile(filePath));
      assert.equal(pdf.getPageCount(), 4);
    }

    await client.evaluate(`document.querySelector('#pdfToImageWorkspaceClose').click(); true`);
    await client.waitFor(`!document.querySelector('#pdfToImageWorkspace')?.classList.contains('visible')`);
    report.intermediatePdfAfterWorkspaceClose = await waitForNoFiles(outputRoot, '.pdf');
    assert.deepEqual(report.intermediatePdfAfterWorkspaceClose, [], 'closing the PDF selector must remove the intermediate PDF');
    await client.evaluate(`document.querySelector('#pdfToImageBack')?.click(); true`);
    await client.waitFor(`!document.querySelector('#pdfToImageOverlay')?.classList.contains('visible')`);
    report.intermediatePdfAfterToolClose = await waitForNoFiles(outputRoot, '.pdf');
    assert.deepEqual(report.intermediatePdfAfterToolClose, [], 'closing the PDF tool must remove the intermediate PDF');

    // Reopen the same entry to catch stale PDF documents and stale native files.
    await client.evaluate(`(() => {
      const card = document.querySelector('[data-tool="ppt-to-image"], [data-home-tool="ppt-to-image"]');
      card?.click();
      return true;
    })()`);
    await client.waitFor(`document.querySelector('#pptToImageOverlay')?.classList.contains('visible')`);
    await injectPptx(client, inputPath);
    await client.waitFor(`document.querySelector('#pptToImageOpenWorkspaceBtn')?.hidden === false
      && document.querySelector('#pptToImageOpenWorkspaceBtn')?.disabled === false`, 120_000);
    report.reopen = await snapshot(client);
    assert.equal(report.reopen.pptEmpty.hidden, true);
    assert.equal(report.reopen.pptAction.disabled, false);
    await client.evaluate(`document.querySelector('#pptToImageBack')?.click(); true`);
    await client.waitFor(`!document.querySelector('#pptToImageOverlay')?.classList.contains('visible')`);

    const unexpectedLogs = client.logs.filter(log => !/event\.listen not allowed|app\.version not allowed|native .*registration .*failed/i.test(log.text));
    report.consoleLogs = client.logs;
    assert.deepEqual(unexpectedLogs, [], `PPT UI native QA emitted unexpected console logs: ${JSON.stringify(unexpectedLogs)}`);
    report.status = 'passed';
    console.log(`PPT native UI QA passed: ${path.relative(process.cwd(), REPORT_PATH)}`);
  } catch (error) {
    report.status = 'failed';
    report.error = String(error?.stack || error);
    report.consoleLogs = client.logs;
    throw error;
  } finally {
    try {
      await client.invoke('set_output_root', { outputDir: previousOutputRoot || null });
    } catch (error) {
      report.restoreOutputRootError = String(error?.message || error);
    }
    await mkdir(path.dirname(REPORT_PATH), { recursive: true });
    await writeFile(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`);
    await client.send('Emulation.clearDeviceMetricsOverride').catch(() => {});
    client.close();
    await rm(root, { recursive: true, force: true });
  }
}

main().catch(error => {
  console.error(error?.stack || error);
  process.exitCode = 1;
});
