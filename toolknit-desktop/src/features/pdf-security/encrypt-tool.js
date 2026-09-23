import { t } from '../../i18n.js';
import { tauriCorePromise } from '../../platform/tauri-runtime.js';
import {
  PDF_ENCRYPT_LIMITS,
  assertPdfEncryptLegacyPassword,
  assertPdfEncryptPassword,
  assertPdfEncryptSelection,
  createPdfEncryptFileName,
  encryptPdf
} from '../../pdf-encrypt-core.js';
import { createPdfSecurityShell } from './shell.js';
import './pdf-security.css';

function formatError(error) {
  const message = String(error?.message || error || '');
  const code = message.match(/pdf-encrypt:([a-z-]+)/i)?.[1]?.toLowerCase();
  const messages = {
    'password-too-short': 'home.pdfEncrypt.passwordTooShort',
    'password-too-long': 'home.pdfEncrypt.passwordTooLong',
    'password-unsupported': 'home.pdfEncrypt.passwordUnsupported',
    'legacy-password-too-long': 'home.pdfEncrypt.browserPasswordTooLong',
    'legacy-password-unsupported': 'home.pdfEncrypt.browserPasswordUnsupported',
    'input-too-large': 'home.pdfEncrypt.fileTooLarge',
    'too-many-pages': 'home.pdfEncrypt.tooManyPages',
    'password-protected': 'home.pdfEncrypt.passwordProtected',
    'invalid-pdf': 'home.pdfEncrypt.invalidPdf',
    'qpdf-unavailable': 'home.pdfEncrypt.engineUnavailable',
    'invalid-permissions': 'home.pdfEncrypt.invalidPermissions',
    'output-path': 'home.pdfEncrypt.outputPathError',
    'encryption-failed': 'home.pdfEncrypt.encryptFailed'
  };
  if (code) return t(messages[code] || 'home.pdfEncrypt.encryptFailed');
  if (/at least 8 characters/.test(message)) return t('home.pdfEncrypt.passwordTooShort');
  if (/encrypted/i.test(message)) return t('home.pdfEncrypt.passwordProtected');
  if (/encryption limit/.test(message) && /MB/.test(message)) return t('home.pdfEncrypt.fileTooLarge');
  if (/encryption limit/.test(message) && /page/.test(message)) return t('home.pdfEncrypt.tooManyPages');
  return t('home.pdfEncrypt.encryptFailed');
}

async function browserFileBytes(file) {
  return new Uint8Array(await file.arrayBuffer());
}

function downloadPdf(bytes, name, owner) {
  const url = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = name;
  anchor.style.display = 'none';
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  owner.timeout(() => URL.revokeObjectURL(url), 1600);
  owner.use(() => URL.revokeObjectURL(url));
  return `~/Downloads/${name}`;
}

export function initPdfEncryptTool({
  overlay,
  isTauri = false,
  getOutputDir,
  displayFilesystemPath,
  notify,
  refreshIcons,
  initStandardToolPlasma,
  disposeStandardToolPlasma
} = {}) {
  if (typeof getOutputDir !== 'function') throw new Error('pdf-encrypt:missing-output-directory');
  let activeOperation = null;
  let disposed = false;
  let operationSequence = 0;
  const shell = createPdfSecurityShell({
    kind: 'encrypt',
    overlay,
    isTauri,
    displayFilesystemPath,
    notify,
    refreshIcons,
    initStandardToolPlasma,
    disposeStandardToolPlasma,
    isBusy: () => Boolean(activeOperation)
  });
  const isDemo = import.meta.env.DEV
    && new URLSearchParams(window.location.search).get('pdf-security-demo') === 'encrypt';

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
    if (!operation?.isCurrent()) throw new Error('pdf-encrypt:cancelled');
  }

  async function fileSize(file) {
    if (isTauri && file?.path) {
      const { invoke } = await tauriCorePromise;
      return Number(await invoke('get_file_size', { path: file.path }));
    }
    return Number(file?.size || 0);
  }

  function permissions() {
    const printing = shell.getPermission('pdfEncryptPermPrinting');
    const highQuality = shell.getPermission('pdfEncryptPermHighQualityPrint');
    return {
      printing: printing ? (highQuality ? 'highResolution' : 'lowResolution') : false,
      modifying: shell.getPermission('pdfEncryptPermModifying'),
      copying: shell.getPermission('pdfEncryptPermCopying'),
      annotating: shell.getPermission('pdfEncryptPermAnnotating'),
      fillingForms: shell.getPermission('pdfEncryptPermFilling'),
      contentAccessibility: shell.getPermission('pdfEncryptPermAccessibility'),
      documentAssembly: shell.getPermission('pdfEncryptPermAssembly')
    };
  }

  async function confirm(owner) {
    if (activeOperation || !shell.isOpenSession(owner)) return;
    let password = shell.getPassword();
    let confirmation = shell.getConfirmPassword();
    if (!password) {
      window.alert(t('home.pdfEncrypt.passwordEmpty'));
      return;
    }
    if (password !== confirmation) {
      window.alert(t('home.pdfEncrypt.passwordMismatch'));
      return;
    }
    try {
      if (isTauri) assertPdfEncryptPassword(password);
      else assertPdfEncryptLegacyPassword(password);
    } catch (error) {
      window.alert(formatError(error));
      return;
    }

    const operation = beginOperation(owner);
    if (!operation) return;
    shell.hidePassword();
    shell.setProcessing(true, 10, t('home.pdfEncrypt.encrypting'));
    try {
      const file = shell.getFile();
      if (!file) throw new Error('pdf-encrypt:invalid-pdf');
      assertPdfEncryptSelection([file], await fileSize(file), PDF_ENCRYPT_LIMITS);
      assertCurrent(operation);
      let savedPath;
      if (isTauri) {
        if (!file.path) throw new Error('pdf-encrypt:invalid-pdf');
        const { invoke } = await tauriCorePromise;
        shell.setProgress(35, t('home.pdfEncrypt.encrypting'));
        savedPath = await invoke('encrypt_pdf', {
          inputPath: file.path,
          password,
          permissions: permissions(),
          outputDir: await getOutputDir('PDF_Encrypt')
        });
      } else {
        const bytes = await browserFileBytes(file);
        if (!bytes.length) throw new Error('pdf-encrypt:invalid-pdf');
        const encrypted = await encryptPdf({
          fileData: bytes,
          password,
          permissions: permissions(),
          onProgress: ({ percent }) => {
            assertCurrent(operation);
            shell.setProgress(percent, t('home.pdfEncrypt.encrypting'));
          }
        });
        assertCurrent(operation);
        savedPath = downloadPdf(encrypted, createPdfEncryptFileName(file.name), owner);
      }
      assertCurrent(operation);
      shell.setProgress(95, t('home.pdfEncrypt.encrypting'));
      shell.showSuccess(savedPath, 1);
    } catch (error) {
      if (!operation.silent && operation.isCurrent() && !/pdf-encrypt:cancelled/.test(String(error?.message || error))) {
        console.error('[PDF Encrypt] Error:', error);
        window.alert(t('common.errorOccurred', { error: formatError(error) }));
      }
    } finally {
      password = '\0'.repeat(password.length);
      confirmation = '\0'.repeat(confirmation.length);
      password = '';
      confirmation = '';
      if (activeOperation === operation) {
        activeOperation = null;
        shell.setProcessing(false);
      }
    }
  }

  async function loadDemo(owner) {
    if (!isDemo || shell.getFile()) return;
    const { PDFDocument } = await import('pdf-lib');
    const pdf = await PDFDocument.create();
    pdf.addPage([420, 595]);
    const bytes = await pdf.save();
    if (!shell.isOpenSession(owner)) return;
    shell.setFileList([{
      name: 'toolknit-pdf-encrypt-demo.pdf',
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
