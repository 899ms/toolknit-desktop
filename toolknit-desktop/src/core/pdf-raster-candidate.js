import { PDFDocument } from 'pdf-lib';
import { PDF_COMPRESSION_POLICY, pdfCompressionError } from './pdf-compression.js';

/** Platform adapters decode/resize cached source JPEGs. The complete PDF writer
 * and geometry validation are shared by desktop workers and CLI workers. */
export async function buildPdfRasterCandidate({ pages, settings, encodePage, check = () => {}, onPage = () => {} }) {
  const document = await PDFDocument.create();
  let encodedBytes = 0;
  let preview = null;
  for (let index = 0; index < pages.length; index++) {
    check();
    const source = pages[index];
    const scale = Math.min(settings.scale, source.sourceScale);
    const jpeg = await encodePage(index, {
      width: Math.max(1, Math.floor(source.width * scale)),
      height: Math.max(1, Math.floor(source.height * scale)),
      quality: settings.quality
    });
    check();
    if (!(jpeg instanceof Uint8Array) || !jpeg.length) throw pdfCompressionError('output-invalid');
    encodedBytes += jpeg.byteLength;
    if (encodedBytes > PDF_COMPRESSION_POLICY.maxCandidateBytes) throw pdfCompressionError('output-too-large');
    if (index === 0) preview = jpeg;
    const image = await document.embedJpg(jpeg);
    const page = document.addPage([source.width, source.height]);
    page.drawImage(image, { x: 0, y: 0, width: source.width, height: source.height });
    onPage(index + 1, pages.length);
  }
  check();
  const bytes = await document.save({ useObjectStreams: true, addDefaultPage: false });
  check();
  if (!bytes.length || bytes.length > PDF_COMPRESSION_POLICY.maxCandidateBytes) throw pdfCompressionError('output-too-large');
  const validation = await PDFDocument.load(bytes, { updateMetadata: false });
  const outputPages = validation.getPages();
  if (outputPages.length !== pages.length || outputPages.some((page, index) =>
    Math.abs(page.getWidth() - pages[index].width) > 0.05 || Math.abs(page.getHeight() - pages[index].height) > 0.05)) {
    throw pdfCompressionError('output-invalid');
  }
  check();
  return { bytes, size: bytes.byteLength, preview, settings: { ...settings } };
}
