import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const [html, main, styles, specs, shell, encrypt, decrypt, featureCss] = await Promise.all([
  readFile(new URL('../index.html', import.meta.url), 'utf8'),
  readFile(new URL('../src/main.js', import.meta.url), 'utf8'),
  readFile(new URL('../src/styles/legacy.css', import.meta.url), 'utf8'),
  readFile(new URL('../src/features/lazy-tools.js', import.meta.url), 'utf8'),
  readFile(new URL('../src/features/pdf-security/shell.js', import.meta.url), 'utf8'),
  readFile(new URL('../src/features/pdf-security/encrypt-tool.js', import.meta.url), 'utf8'),
  readFile(new URL('../src/features/pdf-security/decrypt-tool.js', import.meta.url), 'utf8'),
  readFile(new URL('../src/features/pdf-security/pdf-security.css', import.meta.url), 'utf8')
]);

for (const id of [
  'pdfEncryptOverlay', 'pdfEncryptBack', 'pdfEncryptDropZone', 'pdfEncryptFiles',
  'pdfEncryptCta', 'pdfEncryptInput', 'pdfEncryptProcessBtn',
  'pdfEncryptPasswordDialog', 'pdfEncryptPasswordInput', 'pdfEncryptConfirmInput',
  'pdfEncryptPasswordConfirm', 'pdfEncryptProcessMask', 'pdfEncryptSuccessOverlay',
  'pdfDecryptOverlay', 'pdfDecryptBack', 'pdfDecryptDropZone', 'pdfDecryptFiles',
  'pdfDecryptCta', 'pdfDecryptInput', 'pdfDecryptProcessBtn',
  'pdfDecryptPasswordDialog', 'pdfDecryptPasswordInput', 'pdfDecryptPasswordConfirm',
  'pdfDecryptProcessMask', 'pdfDecryptSuccessOverlay'
]) {
  assert.match(html, new RegExp(`id=["']${id}["']`), `missing PDF security DOM contract: ${id}`);
}

assert.match(specs, /'pdf-encrypt':\s*Object\.freeze\(\{[\s\S]*?import\('\.\/pdf-security\/encrypt-tool\.js'\)/);
assert.match(specs, /'pdf-decrypt':\s*Object\.freeze\(\{[\s\S]*?import\('\.\/pdf-security\/decrypt-tool\.js'\)/);
assert.doesNotMatch(main, /openPdfEncryptOverlay|selectedPdfEncryptFiles|handleEncryptConfirm/);
assert.doesNotMatch(main, /openPdfDecryptOverlay|selectedPdfDecryptFiles|handleDecryptConfirm/);
assert.doesNotMatch(styles, /\.pdf-encrypt-password-dialog|\.pdf-encrypt-v2|\.pdf-decrypt-v2/);

assert.match(shell, /createLifecycleScope/);
assert.match(shell, /owner\.use\(unlisten\)/);
assert.match(shell, /if \(!isOpenSession\(owner\)\) \{\s*unlisten\(\)/);
assert.match(shell, /filesElement\.replaceChildren\(\)/);
assert.match(shell, /name\.textContent = fileName\(selectedFile\)/);
assert.match(shell, /event\.defaultPrevented\(\)|event\.preventDefault\(\)/);
assert.match(shell, /\n    open,/);
assert.match(shell, /\n    close,/);
assert.match(shell, /\n    dispose,/);
assert.doesNotMatch(shell, /\.addEventListener\(|\.innerHTML\s*=/);

assert.match(encrypt, /assertPdfEncryptSelection/);
assert.match(encrypt, /invoke\('encrypt_pdf'/);
assert.match(encrypt, /encryptPdf\(\{/);
assert.match(encrypt, /import\.meta\.env\.DEV[\s\S]{0,150}pdf-security-demo/);
assert.match(encrypt, /operation\.isCurrent\(\)/);
assert.match(encrypt, /import ['"]\.\/pdf-security\.css['"]/);
assert.doesNotMatch(encrypt, /\.addEventListener\(|\.innerHTML\s*=/);

assert.match(decrypt, /assertPdfDecryptSelection/);
assert.match(decrypt, /invoke\('decrypt_pdf'/);
assert.match(decrypt, /pdf-decrypt:desktop-only/);
assert.match(decrypt, /import\.meta\.env\.DEV[\s\S]{0,150}pdf-security-demo/);
assert.match(decrypt, /operation\.isCurrent\(\)/);
assert.match(decrypt, /if \(reopenPassword && shell\.isOpenSession\(owner\)\) shell\.showPassword\(\)/);
assert.match(decrypt, /import ['"]\.\/pdf-security\.css['"]/);
assert.doesNotMatch(decrypt, /\.addEventListener\(|\.innerHTML\s*=/);

assert.match(featureCss, /\.pdf-encrypt-v2/);
assert.match(featureCss, /\.pdf-decrypt-v2/);
assert.match(featureCss, /\.pdf-encrypt-password-dialog/);

for (const [name, source] of [
  ['shell', shell],
  ['encrypt', encrypt],
  ['decrypt', decrypt]
]) {
  assert.ok(source.split(/\r?\n/).length <= 800, `PDF security ${name} module exceeds the oversized-module limit`);
}

console.log('PDF encrypt/decrypt lazy loading, lifecycle, password and output contracts passed');
