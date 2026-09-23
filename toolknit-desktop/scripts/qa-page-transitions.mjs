import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const DEBUG_ENDPOINT = process.env.TOOLKNIT_CDP_ENDPOINT || 'http://127.0.0.1:9223';
const reportPath = path.resolve('tmp', 'page-transition-qa-report.json');
const evidenceDir = path.resolve('tmp', 'v3-overnight', 'page-transitions');

class CdpClient {
  constructor(socket) {
    this.socket = socket;
    this.nextId = 1;
    this.pending = new Map();
    this.consoleErrors = [];
    socket.addEventListener('message', event => {
      const message = JSON.parse(String(event.data));
      if (message.method === 'Runtime.exceptionThrown') {
        this.consoleErrors.push(String(message.params?.exceptionDetails?.text || 'runtime exception'));
      }
      if (message.method === 'Log.entryAdded' && ['error', 'warning'].includes(message.params?.entry?.level)) {
        this.consoleErrors.push(String(message.params.entry.text || message.params.entry.level));
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
    assert.ok(target?.webSocketDebuggerUrl, 'Tauri WebView CDP target must exist');
    const socket = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      socket.addEventListener('open', resolve, { once: true });
      socket.addEventListener('error', () => reject(new Error('Cannot connect to Tauri WebView CDP')), { once: true });
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
      expression, awaitPromise: true, returnByValue: true, userGesture: true
    });
    if (response.exceptionDetails) {
      throw new Error(response.exceptionDetails.exception?.description || response.exceptionDetails.text);
    }
    return response.result?.value;
  }

  async waitFor(expression, timeoutMs = 15_000) {
    const deadline = Date.now() + timeoutMs;
    let lastError = null;
    while (Date.now() < deadline) {
      try {
        if (await this.evaluate(expression)) return true;
      } catch (error) {
        lastError = error;
      }
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    throw new Error(`Timed out waiting for ${expression}${lastError ? `: ${lastError.message}` : ''}`);
  }

  close() { this.socket.close(); }
}

const visibleOverlayExpression = `([...document.querySelectorAll('[id$="Overlay"], [id$="Workspace"]')]
  .filter(node => node.classList.contains('visible') && getComputedStyle(node).display !== 'none')
  .map(node => node.id))`;

function veilExpression() {
  return `(() => {
    const node = document.querySelector('[data-tk-page-transition-veil]');
    if (!node) return null;
    const style = getComputedStyle(node);
    return {
      active: node.classList.contains('is-active'),
      opacity: Number(style.opacity),
      backgroundColor: style.backgroundColor,
      visibility: style.visibility,
      pointerEvents: style.pointerEvents,
      animations: document.getAnimations
        ? document.getAnimations().filter(animation => animation.effect?.target === node).length
        : 0
    };
  })()`;
}

async function sampleTransition(client, samples, count = 18, intervalMs = 20) {
  for (let index = 0; index < count; index += 1) {
    await new Promise(resolve => setTimeout(resolve, intervalMs));
    samples.push(await client.evaluate(veilExpression()));
  }
}

async function settle(client, initialDelay = 0, timeoutMs = 5_000) {
  if (initialDelay > 0) await new Promise(resolve => setTimeout(resolve, initialDelay));
  const deadline = Date.now() + timeoutMs;
  let stableSamples = 0;
  let state = null;
  while (Date.now() < deadline) {
    state = await client.evaluate(`({
      veil: ${veilExpression()},
      overlays: ${visibleOverlayExpression},
      active: document.activeElement?.id || document.activeElement?.tagName || ''
    })`);
    const veil = state.veil;
    const settled = !veil || (
      veil.active === false
      && veil.visibility === 'hidden'
      && veil.pointerEvents === 'none'
      && veil.opacity === 0
      && veil.animations === 0
    );
    stableSamples = settled ? stableSamples + 1 : 0;
    if (stableSamples >= 2) return state;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  const veil = state?.veil;
  if (veil) {
    assert.equal(veil.active, false, 'transition veil must be inactive after settling');
    assert.equal(veil.visibility, 'hidden', 'transition veil must be hidden after settling');
    assert.equal(veil.pointerEvents, 'none', 'transition veil must not capture input after settling');
    assert.equal(veil.opacity, 0, 'transition veil must be transparent after settling');
  }
  throw new Error(`Timed out waiting for transition veil to settle: ${JSON.stringify(veil)}`);
}

async function click(client, selector) {
  return client.evaluate(`(() => {
    const node = document.querySelector(${JSON.stringify(selector)});
    if (!node) return false;
    node.click();
    return true;
  })()`);
}

async function closeTool(client, overlaySelector) {
  const clicked = await client.evaluate(`(() => {
    const root = document.querySelector(${JSON.stringify(overlaySelector)});
    const back = root?.querySelector('.tool-page-v2-back, [data-tool-close], [id$="Back"]');
    if (!back) return false;
    back.click();
    return true;
  })()`);
  assert.equal(clicked, true, `tool back button must exist for ${overlaySelector}`);
  await client.waitFor(`!document.querySelector(${JSON.stringify(overlaySelector)})?.classList.contains('visible')`);
  await settle(client);
}

async function main() {
  await mkdir(evidenceDir, { recursive: true });
  const client = await CdpClient.connect();
  const report = {
    endpoint: DEBUG_ENDPOINT,
    generatedAt: new Date().toISOString(),
    normalCycles: 0,
    rapidCycles: 0,
    settingsHelpCycles: 0,
    reducedMotion: null,
    lowHeight: null,
    samples: [],
    consoleErrors: [],
    status: 'running'
  };
  try {
    await client.waitFor(`document.readyState === 'complete' && document.querySelectorAll('[data-home-tool]').length > 0`);
    await client.evaluate(`(() => {
      for (const id of ['helpOverlay', 'legalOverlay', 'feedbackOverlay', 'settingsOverlay']) {
        const node = document.getElementById(id);
        if (node?.classList.contains('visible')) node.querySelector('[id$="Back"], button')?.click();
      }
      return true;
    })()`);
    await settle(client, 500);

    const editorCard = '[data-home-tool="pdf-editor"]';
    const splitCard = '[data-home-tool="pdf-split"]';
    assert.equal(await click(client, editorCard), true, 'PDF editor home card must exist');
    const openSamples = [];
    await sampleTransition(client, openSamples);
    await client.waitFor(`document.querySelector('#pdfEditorOverlay')?.classList.contains('visible')`);
    const opened = await settle(client);
    assert.ok(openSamples.some(sample => sample && sample.active && sample.opacity >= 0.99
      && sample.backgroundColor === 'rgb(0, 0, 0)'), 'tool entry must expose a fully black intermediate veil state');
    report.samples.push({ kind: 'tool-open', samples: openSamples, final: opened });
    await closeTool(client, '#pdfEditorOverlay');
    report.normalCycles += 1;

    for (let cycle = 0; cycle < 9; cycle += 1) {
      assert.equal(await click(client, editorCard), true);
      await client.waitFor(`document.querySelector('#pdfEditorOverlay')?.classList.contains('visible')`);
      await settle(client, 260);
      await closeTool(client, '#pdfEditorOverlay');
      report.normalCycles += 1;
    }

    for (let cycle = 0; cycle < 30; cycle += 1) {
      const finalEditor = await client.evaluate(`(() => {
        document.querySelector(${JSON.stringify(editorCard)})?.click();
        document.querySelector(${JSON.stringify(splitCard)})?.click();
        document.querySelector(${JSON.stringify(editorCard)})?.click();
        return true;
      })()`);
      assert.equal(finalEditor, true);
      await client.waitFor(`document.querySelector('#pdfEditorOverlay')?.classList.contains('visible')`, 20_000);
      const overlays = await client.evaluate(visibleOverlayExpression);
      assert.deepEqual(overlays, ['pdfEditorOverlay'], `latest rapid navigation must win at cycle ${cycle + 1}`);
      await settle(client, 300);
      await closeTool(client, '#pdfEditorOverlay');
      report.rapidCycles += 1;
    }

    for (let cycle = 0; cycle < 10; cycle += 1) {
      assert.equal(await click(client, '#homeV2Settings'), true, 'home settings button must exist');
      await client.waitFor(`document.querySelector('#settingsOverlay')?.classList.contains('visible')`);
      await settle(client, 300);
      assert.equal(await click(client, '#helpLink'), true, 'settings help link must exist');
      await client.waitFor(`document.querySelector('#helpOverlay')?.classList.contains('visible')`);
      const helpState = await settle(client, 300);
      assert.deepEqual(helpState.overlays, ['helpOverlay'], 'help must own the foreground overlay');
      assert.equal(await click(client, '#helpBackBtn'), true);
      await client.waitFor(`!document.querySelector('#helpOverlay')?.classList.contains('visible')`);
      await settle(client, 260);
      assert.equal(await click(client, '#settingsBack'), true);
      await client.waitFor(`!document.querySelector('#settingsOverlay')?.classList.contains('visible')`);
      const final = await settle(client, 300);
      assert.deepEqual(final.overlays, [], 'settings/help return must restore home');
      report.settingsHelpCycles += 1;
    }

    await client.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
    assert.equal(await click(client, '#homeV2Settings'), true);
    await client.waitFor(`document.querySelector('#settingsOverlay')?.classList.contains('visible')`);
    const reducedState = await client.evaluate(`({
      veil: ${veilExpression()},
      reduced: matchMedia('(prefers-reduced-motion: reduce)').matches,
      active: document.activeElement?.id || ''
    })`);
    assert.equal(reducedState.reduced, true);
    assert.ok(!reducedState.veil || (!reducedState.veil.active && reducedState.veil.opacity === 0), 'reduced motion must skip the visual veil');
    assert.equal(reducedState.active, 'settingsBack', 'reduced-motion entry must still place focus');
    report.reducedMotion = reducedState;
    await click(client, '#settingsBack');
    await client.waitFor(`!document.querySelector('#settingsOverlay')?.classList.contains('visible')`);
    await settle(client, 100);
    await client.send('Emulation.setEmulatedMedia', { features: [] });

    await client.send('Emulation.setDeviceMetricsOverride', {
      width: 1024, height: 480, deviceScaleFactor: 1, mobile: false
    });
    assert.equal(await click(client, '#homeV2Settings'), true);
    await client.waitFor(`document.querySelector('#settingsOverlay')?.classList.contains('visible')`);
    const lowHeightState = await client.evaluate(`(() => {
      const node = document.querySelector('#settingsOverlay');
      // V3 keeps the outer settings shell clipped; the layout region owns
      // scrolling so the topbar and footer remain stable in short windows.
      const content = node?.querySelector('.settings-v2-layout')
        || node?.querySelector('.settings-content');
      return {
        viewport: { width: innerWidth, height: innerHeight },
        overlayHeight: node?.getBoundingClientRect().height || 0,
        contentScrollHeight: content?.scrollHeight || 0,
        contentClientHeight: content?.clientHeight || 0,
        contentScrollable: Boolean(content && content.scrollHeight > content.clientHeight)
      };
    })()`);
    assert.equal(lowHeightState.viewport.height, 480);
    assert.ok(lowHeightState.overlayHeight <= 480, 'settings overlay must fit the compact viewport');
    assert.equal(lowHeightState.contentScrollable, true, 'settings content must own low-height scrolling');
    report.lowHeight = lowHeightState;
    await click(client, '#settingsBack');
    await client.waitFor(`!document.querySelector('#settingsOverlay')?.classList.contains('visible')`);
    await settle(client, 250);
    await client.send('Emulation.clearDeviceMetricsOverride');

    const activeScreenshot = await client.send('Page.captureScreenshot', { format: 'png' });
    await writeFile(path.join(evidenceDir, 'page-transition-final.png'), Buffer.from(activeScreenshot.data, 'base64'));
    report.consoleErrors = [...client.consoleErrors];
    assert.deepEqual(report.consoleErrors, [], 'page transition matrix must not add runtime errors or warnings');
    report.status = 'passed';
    console.log(`Page transition QA passed: ${path.relative(process.cwd(), reportPath)}`);
  } catch (error) {
    report.status = 'failed';
    report.error = String(error?.stack || error);
    report.consoleErrors = [...client.consoleErrors];
    throw error;
  } finally {
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
    await client.send('Emulation.clearDeviceMetricsOverride').catch(() => {});
    await client.send('Emulation.setEmulatedMedia', { features: [] }).catch(() => {});
    client.close();
  }
}

main().catch(error => {
  console.error(error?.stack || error);
  process.exitCode = 1;
});
