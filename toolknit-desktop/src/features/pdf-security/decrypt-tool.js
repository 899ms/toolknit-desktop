import { t } from '../../i18n.js';
import { tauriCorePromise } from '../../platform/tauri-runtime.js';
import {
  PDF_DECRYPT_LIMITS,
  assertPdfDecryptPassword,
  assertPdfDecryptSelection,
  getPdfDecryptErrorCode
} from '../../pdf-decrypt-core.js';
import { createPdfSecurityShell } from './shell.js';
import './pdf-security.css';

function errorInfo(error) {
  const code = getPdfDecryptErrorCode(error);
  const messages = {
    'invalid-password': 'home.pdfDecrypt.wrongPassword',
    'input-too-large': 'home.pdfDecrypt.fileTooLarge',
    'too-many-pages': 'home.pdfDecrypt.tooManyPages',
    'invalid-pdf': 'home.pdfDecrypt.invalidPdf',
    'desktop-only': 'home.pdfDecrypt.desktopOnly',
    'qpdf-unavailable': 'home.pdfDecrypt.decryptFailed',
    'decryption-failed': 'home.pdfDecrypt.decryptFailed'
  };
  return { code, message: t(messages[code] || 'home.pdfDecrypt.decryptFailed') };
}

export function initPdfDecryptTool({
  overlay,
  isTauri = false,
  getOutputDir,
  displayFilesystemPath,
  notify,
  refreshIcons,
  initStandardToolPlasma,
  disposeStandardToolPlasma
} = {}) {
  if (typeof getOutputDir !== 'function') throw new Error('pdf-decrypt:missing-output-directory');
  let activeOperation = null;
  let disposed = false;
  let operationSequence = 0;
  const shell = createPdfSecurityShell({
    kind: 'decrypt',
    overlay,
    isTauri,
    displayFilesystemPath,
    notify,
    refreshIcons,
    initStandardToolPlasma,
    disposeStandardToolPlasma,
    isBusy: () => Boolean(activeOperation),
    allowBrowserDrop: true
  });
  const isDemo = import.meta.env.DEV
    && new URLSearchParams(window.location.search).get('pdf-security-demo') === 'decrypt';

  function beginOperation(owner) {
    if (activeOperation) return null;
    const operation = {
      id: ++operationSequence,
      owner,
      silent: false,
      isCurrent: () => activeOperation === operation && shell.isOpenSession(owner)
    };
    activeOperation = operation;
    return operation;
  }

  function assertCurrent(operation) {
    if (!operation?.isCurrent()) throw new Error('pdf-decrypt:cancelled');
  }

  async function fileSize(file) {
    if (isTauri && file?.path) {
      const { invoke } = await tauriCorePromise;
      return Number(await invoke('get_file_size', { path: file.path }));
    }
    return Number(file?.size || 0);
  }

  async function confirm(owner) {
    if (activeOperation || !shell.isOpenSession(owner)) return;
    let password = shell.getPassword();
    let reopenPassword = false;
    try {
      assertPdfDecryptPassword(password);
    } catch (_) {
      window.alert(t('home.pdfDecrypt.passwordUnsupported'));
      return;
    }
    const operation = beginOperation(owner);
    if (!operation) return;
    shell.hidePassword();
    shell.setProcessing(true, 10, t('home.pdfDecrypt.decrypting'));
    try {
      const file = shell.getFile();
      if (!file) throw new Error('pdf-decrypt:invalid-pdf');
      assertPdfDecryptSelection([file], await fileSize(file), PDF_DECRYPT_LIMITS);
      assertCurrent(operation);
      if (!isTauri) throw new Error('pdf-decrypt:desktop-only');
      if (!file.path) throw new Error('pdf-decrypt:invalid-pdf');
      shell.setProgress(40, t('home.pdfDecrypt.decrypting'));
      const { invoke } = await tauriCorePromise;
      const savedPath = await invoke('decrypt_pdf', {
        inputPath: file.path,
        password,
        outputDir: await getOutputDir('PDF_Decrypt')
      });
      assertCurrent(operation);
      shell.setProgress(100, t('home.pdfDecrypt.decrypting'));
      shell.showSuccess(savedPath, 1);
    } catch (error) {
      if (!operation.silent && operation.isCurrent() && !/pdf-decrypt:cancelled/.test(String(error?.message || error))) {
        const info = errorInfo(error);
        reopenPassword = info.code === 'invalid-password';
        if (info.code !== 'invalid-password' && info.code !== 'desktop-only') {
          console.error('[PDF Decrypt] Error:', error);
        }
        window.alert(t('common.errorOccurred', { error: info.message }));
      }
    } finally {
      password = '\0'.repeat(password.length);
      password = '';
      if (activeOperation === operation) {
        activeOperation = null;
        shell.setProcessing(false);
      }
    }
    if (reopenPassword && shell.isOpenSession(owner)) shell.showPassword();
  }

  async function loadDemo(owner) {
    if (!isDemo || shell.getFile()) return;
    const bytes = new TextEncoder().encode('%PDF-1.4\n% ToolKnit PDF decrypt fixture\n%%EOF');
    if (!shell.isOpenSession(owner)) return;
    shell.setFileList([{
      name: 'toolknit-pdf-decrypt-demo.pdf',
      size: bytes.length,
      arrayBuffer: async () => bytes.slice().buffer
    }], owner);
  }

  shell.setActions({ confirm, afterOpen: loadDemo });

  async function close() {
    return shell.close();
  }

  async function dispose() {
    if (disposed) return;
    disposed = true;
    if (activeOperation) activeOperation.silent = true;
    activeOperation = null;
    await shell.dispose();
  }

  return { open: shell.open, close, dispose };
}
