export const LAZY_TOOL_SPECS = Object.freeze({
  'excel-to-pdf': Object.freeze({
    overlayId: 'excelToPdfOverlay',
    load: () => import('../excel-to-pdf-ui.js'),
    init: 'initExcelToPdfTool'
  }),
  teleprompter: Object.freeze({
    overlayId: 'teleprompterOverlay',
    load: () => import('../teleprompter-ui.js'),
    init: 'initTeleprompterTool'
  }),
  'bg-removal': Object.freeze({
    overlayId: 'bgRemovalOverlay',
    load: () => import('../bg-removal-ui.js'),
    init: 'initBgRemovalTool'
  }),
  'markdown-editor': Object.freeze({
    overlayId: 'markdownEditorOverlay',
    load: () => import('../markdown-editor-ui.js'),
    init: 'initMarkdownEditorTool'
  }),
  'image-color-replace': Object.freeze({
    overlayId: 'imageColorReplaceOverlay',
    load: () => import('../image-color-replace-ui.js'),
    init: 'initImageColorReplaceTool'
  }),
  'color-space-compare': Object.freeze({
    overlayId: 'colorSpaceCompareOverlay',
    load: () => import('../color-space-compare-ui.js'),
    init: 'initColorSpaceCompareTool'
  }),
  'hash-crypto': Object.freeze({
    overlayId: 'cryptoToolOverlay',
    load: () => import('../crypto-tool-ui.js'),
    init: 'initCryptoTool'
  }),
  'json-tools': Object.freeze({
    instanceKey: 'developer-toolbox',
    overlayId: 'developerToolboxOverlay',
    load: () => import('./developer-toolbox/tool.js'),
    init: 'initDeveloperToolbox'
  }),
  base64: Object.freeze({
    instanceKey: 'developer-toolbox',
    overlayId: 'developerToolboxOverlay',
    load: () => import('./developer-toolbox/tool.js'),
    init: 'initDeveloperToolbox'
  }),
  'url-codec': Object.freeze({
    instanceKey: 'developer-toolbox',
    overlayId: 'developerToolboxOverlay',
    load: () => import('./developer-toolbox/tool.js'),
    init: 'initDeveloperToolbox'
  }),
  uuid: Object.freeze({
    instanceKey: 'developer-toolbox',
    overlayId: 'developerToolboxOverlay',
    load: () => import('./developer-toolbox/tool.js'),
    init: 'initDeveloperToolbox'
  }),
  jwt: Object.freeze({
    instanceKey: 'developer-toolbox',
    overlayId: 'developerToolboxOverlay',
    load: () => import('./developer-toolbox/tool.js'),
    init: 'initDeveloperToolbox'
  })
});
