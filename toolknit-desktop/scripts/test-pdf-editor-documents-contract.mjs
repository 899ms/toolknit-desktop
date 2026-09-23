import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const [uiSource, toolSource, documentsSource, fileSessionSource] = await Promise.all([
  readFile(new URL('../src/features/pdf-editor/controller.js', import.meta.url), 'utf8'),
  readFile(new URL('../src/features/pdf-editor/tool.js', import.meta.url), 'utf8'),
  readFile(new URL('../src/features/pdf-editor/documents.js', import.meta.url), 'utf8'),
  readFile(new URL('../src/features/pdf-editor/file-session.js', import.meta.url), 'utf8')
]);

assert.match(toolSource, /import \{ createIcons, icons \} from 'lucide'/, 'PDF editor must own its lazy icon renderer');
assert.match(toolSource, /refreshIcons\(\);/, 'PDF editor must render icons immediately after lazy mount');
assert.match(toolSource, /createPdfEditorTool\(\{ \.\.\.context, refreshIcons \}\)/, 'PDF editor must pass icon refresh to its controller');
assert.match(documentsSource, /export function createPdfEditorDocumentStore/);
assert.match(documentsSource, /const pending = new Map\(\)/);
assert.match(documentsSource, /const loadingTasks = new Set\(\)/);
assert.match(documentsSource, /requestGeneration !== generation/);
assert.match(documentsSource, /await (?:loadingTask|task)\.destroy\(\)/);
assert.match(documentsSource, /await destroyPdfDocument\(pdfDocument\)/);
assert.match(documentsSource, /async function destroyAll\(\)/);
assert.match(uiSource, /await documents\.destroyAll\(\)/);
assert.match(fileSessionSource, /documents\.set\(source\.id, stagedDocument\)/);
assert.match(uiSource, /getDocuments: \(\) => documents/);
assert.match(uiSource, /return \{\s+open\(\) \{[\s\S]*?openOverlay\(\);[\s\S]*?\},\s+close\(\) \{[\s\S]*?closeOverlay\(\);/);
assert.doesNotMatch(uiSource, /let pdfDocs = new Map\(\)/);
assert.doesNotMatch(uiSource, /pdfjsLib\.getDocument\(\{ data: bytes\.slice\(\)/);

console.log('PDF editor document ownership contract passed');
