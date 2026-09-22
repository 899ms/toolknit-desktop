import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { PDFDocument } from 'pdf-lib';

const DEBUG_ENDPOINT = process.env.TOOLKNIT_CDP_ENDPOINT || 'http://127.0.0.1:9223';
const REPORT_PATH = path.resolve('tmp', 'pdf-to-image-ui-modes-report.json');

class CdpClient {
  constructor(socket) {
    this.socket = socket;
    this.nextId = 1;
    this.pending = new Map();
    socket.addEventListener('message', event => {
      const message = JSON.parse(String(event.data));
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message));
      else pending.resolve(message.result);
    });
  }

  static async connect() {
    const targets = await fetch(`${DEBUG_ENDPOINT}/json/list`).then(response => response.json());
    const target = targets.find(item => item.type === 'page');
    if (!target?.webSocketDebuggerUrl) throw new Error('ToolKnit Tauri WebView target was not found.');
    const socket = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      socket.addEventListener('open', resolve, { once: true });
      socket.addEventListener('error', () => reject(new Error('Cannot connect to the ToolKnit WebView.')), { once: true });
    });
    const client = new CdpClient(socket);
    await client.send('Runtime.enable');
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
      throw new Error(response.exceptionDetails.exception?.description || response.exceptionDetails.text);
    }
    return response.result?.value;
  }

  close() {
    this.socket.close();
  }
}

async function waitFor(client, expression, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await client.evaluate(expression)) return;
    await new Promise(resolve => setTimeout(resolve, 40));
  }
  throw new Error(`Timed out waiting for: ${expression}`);
}

function createSyntheticPdfBase64(pageCount) {
  return PDFDocument.create().then(async document => {
    for (let index = 1; index <= pageCount; index += 1) {
      const page = document.addPage([320, 240]);
      page.drawText(`Synthetic PDF UI QA page ${index}`, { x: 24, y: 200, size: 16 });
    }
    return Buffer.from(await document.save()).toString('base64');
  });
}

async function main() {
  const pageCount = 21;
  const client = await CdpClient.connect();
  const report = {
    endpoint: DEBUG_ENDPOINT,
    generatedAt: new Date().toISOString(),
    pageCount,
    states: [],
    status: 'running'
  };

  try {
    await client.send('Network.enable');
    await client.send('Network.setCacheDisabled', { cacheDisabled: true });
    await client.send('Page.enable');
    await client.send('Page.reload', { ignoreCache: true });
    await waitFor(client, `document.readyState === 'complete'`);
    await waitFor(client, `document.querySelectorAll('.tool-result-name').length > 0`);

    const pdfBase64 = await createSyntheticPdfBase64(pageCount);
    const clicked = await client.evaluate(`(() => {
      const tool = Array.from(document.querySelectorAll('.tool-result-name'))
        .find(node => node.textContent.trim() === 'PDF 转图像');
      if (!tool) return false;
      tool.click();
      return true;
    })()`);
    assert.equal(clicked, true, 'PDF To Image tool card must be available');
    await waitFor(client, `document.querySelector('#pdfToImageOverlay')?.classList.contains('visible')`);

    const injected = await client.evaluate(`(() => {
      const bytes = Uint8Array.from(atob(${JSON.stringify(pdfBase64)}), character => character.charCodeAt(0));
      const file = new File([bytes], 'qa-pdf-to-image-ui-modes.pdf', { type: 'application/pdf' });
      const input = document.querySelector('#pdfToImageFileInput');
      if (!input) return false;
      const transfer = new DataTransfer();
      transfer.items.add(file);
      input.files = transfer.files;
      input.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    })()`);
    assert.equal(injected, true, 'PDF To Image input must be available');
    await waitFor(client, `document.querySelector('#pdfToImageWorkspace')?.classList.contains('visible')
      && document.querySelectorAll('#pdfToImagePageStrip .pdf-editor-tile-select').length === ${pageCount}`);
    assert.equal(
      await client.evaluate(`document.querySelectorAll('#pdfToImagePageStrip .pdf-editor-tile.is-selected').length`),
      pageCount,
      'all pages must start selected'
    );

    await client.evaluate(`document.querySelector('#pdfToImageSelectAllBtn').click(); true`);
    await waitFor(client, `document.querySelectorAll('#pdfToImagePageStrip .pdf-editor-tile.is-selected').length === 0`);

    for (let count = 1; count <= pageCount; count += 1) {
      await client.evaluate(`document.querySelectorAll('#pdfToImagePageStrip .pdf-editor-tile-select')[${count - 1}].click(); true`);
      await waitFor(client, `document.querySelectorAll('#pdfToImagePageStrip .pdf-editor-tile.is-selected').length === ${count}`);
      await client.evaluate('new Promise(resolve => setTimeout(resolve, 240))');
      const state = await client.evaluate(`(() => {
        const read = selector => {
          const node = document.querySelector(selector);
          const style = getComputedStyle(node);
          const rect = node.getBoundingClientRect();
          const center = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
          return {
            available: node.classList.contains('is-available'),
            ariaHidden: node.getAttribute('aria-hidden'),
            disabled: node.disabled,
            visibility: style.visibility,
            opacity: style.opacity,
            pointerEvents: style.pointerEvents,
            width: rect.width,
            hitTargetInside: node.contains(center)
          };
        };
        return {
          count: ${count},
          long: read('#pdfToImageExportLongBtn'),
          grid: read('#pdfToImageExportGridBtn'),
          horizontal: read('#pdfToImageExportHorizontalBtn')
        };
      })()`);
      const gridAvailable = count === 4 || count === 9;
      const longAvailable = count >= 2 && count <= 5;
      for (const [name, value, expected] of [
        ['long', state.long, longAvailable],
        ['grid', state.grid, gridAvailable],
        ['horizontal', state.horizontal, longAvailable]
      ]) {
        assert.equal(value.available, expected, `${name} availability mismatch at ${count} pages`);
        assert.equal(value.ariaHidden, 'false', `${name} must remain visible at ${count} pages`);
        assert.equal(value.disabled, !expected, `${name} disabled mismatch at ${count} pages`);
        assert.equal(value.visibility, 'visible', `${name} visibility mismatch at ${count} pages`);
        assert.equal(Number(value.opacity), 1, `${name} opacity mismatch at ${count} pages`);
        assert.equal(value.pointerEvents, 'auto', `${name} pointer-events mismatch at ${count} pages`);
        assert.ok(value.width > 0, `${name} must occupy space at ${count} pages`);
        if (expected) assert.equal(value.hitTargetInside, true, `${name} must receive hit-test at ${count} pages`);
      }
      report.states.push(state);
    }

    await client.evaluate(`document.querySelector('#pdfToImageWorkspaceClose')?.click(); true`);
    await waitFor(client, `!document.querySelector('#pdfToImageWorkspace')?.classList.contains('visible')`);
    await client.evaluate(`document.querySelector('#pdfToImageBack')?.click(); true`);
    report.status = 'passed';
    await mkdir(path.dirname(REPORT_PATH), { recursive: true });
    await writeFile(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`);
    console.log(`PDF To Image UI mode QA passed: ${path.relative(process.cwd(), REPORT_PATH)}`);
  } catch (error) {
    report.status = 'failed';
    report.error = String(error?.message || error);
    await mkdir(path.dirname(REPORT_PATH), { recursive: true });
    await writeFile(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`);
    throw error;
  } finally {
    client.close();
  }
}

main().catch(error => {
  console.error(error?.stack || error);
  process.exitCode = 1;
});
