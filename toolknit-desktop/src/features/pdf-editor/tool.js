// Compatibility entry while the editor UI is migrated into feature-owned
// document, preview, component and export modules. The lazy registry owns the
// import boundary so PDF Editor code is absent from the initial application.
export { initPdfEditorTool } from '../../pdf-editor-ui.js';
