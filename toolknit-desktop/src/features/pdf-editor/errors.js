export class PdfEditorCancelledError extends Error {
  constructor() {
    super('PDF editor operation cancelled');
    this.name = 'PdfEditorCancelledError';
  }
}
