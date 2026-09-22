/** Local assets must match the installed PDF.js worker, including offline CJK fonts. */
export function pdfjsDocumentOptions(options = {}, baseUrl = globalThis.document?.baseURI) {
  return {
    wasmUrl: new URL('assets/pdfjs/wasm/', baseUrl).href,
    cMapUrl: new URL('assets/pdfjs/cmaps/', baseUrl).href,
    cMapPacked: true,
    standardFontDataUrl: new URL('assets/pdfjs/standard_fonts/', baseUrl).href,
    useWasm: true,
    ...options
  };
}

export function destroyPdfDocument(document) {
  // PDF.js 6 owns destruction on the loading task. Keep older test/adapters compatible.
  return document?.loadingTask?.destroy?.() ?? document?.destroy?.();
}
