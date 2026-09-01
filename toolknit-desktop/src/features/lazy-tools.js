export const LAZY_TOOL_SPECS = Object.freeze({
  'excel-to-pdf': Object.freeze({
    overlayId: 'excelToPdfOverlay',
    load: () => import('../excel-to-pdf-ui.js'),
    init: 'initExcelToPdfTool'
  }),
  'pdf-rotate': Object.freeze({
    overlayId: 'pdfRotateOverlay',
    load: () => import('./pdf-rotate/tool.js'),
    init: 'initPdfRotateTool'
  }),
  'pdf-split': Object.freeze({
    overlayId: 'pdfSplitOverlay',
    load: () => import('./pdf-split/tool.js'),
    init: 'initPdfSplitTool'
  }),
  'pdf-merge': Object.freeze({
    overlayId: 'pdfMergeOverlay',
    load: () => import('./pdf-merge/tool.js'),
    init: 'initPdfMergeTool'
  }),
  'pdf-to-image': Object.freeze({
    overlayId: 'pdfToImageOverlay',
    load: () => import('./pdf-to-image/tool.js'),
    init: 'initPdfToImageTool'
  }),
  'pdf-page-number': Object.freeze({
    overlayId: 'pdfPageNumberOverlay',
    load: () => import('./pdf-page-number/tool.js'),
    init: 'initPdfPageNumberTool'
  }),
  'pdf-crop': Object.freeze({
    overlayId: 'pdfCropOverlay',
    load: () => import('./pdf-crop/tool.js'),
    init: 'initPdfCropTool'
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
  'password-gen': Object.freeze({
    overlayId: 'passwordGenOverlay',
    load: () => import('./password-generator/tool.js'),
    init: 'initPasswordGeneratorTool'
  }),
  'timestamp-calc': Object.freeze({
    overlayId: 'tsCalcOverlay',
    load: () => import('./timestamp-calculator/tool.js'),
    init: 'initTimestampCalculatorTool'
  }),
  'bmi-calc': Object.freeze({
    overlayId: 'bmiCalcOverlay',
    load: () => import('./bmi-calculator/tool.js'),
    init: 'initBmiCalculatorTool'
  }),
  'mortgage-calc': Object.freeze({
    overlayId: 'mortgageCalcOverlay',
    load: () => import('./mortgage-calculator/tool.js'),
    init: 'initMortgageCalculatorTool'
  }),
  'interest-calc': Object.freeze({
    overlayId: 'interestCalcOverlay',
    load: () => import('./interest-calculator/tool.js'),
    init: 'initInterestCalculatorTool'
  }),
  'typing-test': Object.freeze({
    overlayId: 'typingTestOverlay',
    load: () => import('./typing-test/tool.js'),
    init: 'initTypingTestTool'
  }),
  'text-stats': Object.freeze({
    overlayId: 'textStatsOverlay',
    load: () => import('./text-stats/tool.js'),
    init: 'initTextStatsTool'
  }),
  'text-format': Object.freeze({
    overlayId: 'textFormatOverlay',
    load: () => import('./text-format/tool.js'),
    init: 'initTextFormatTool'
  }),
  'ai-polish': Object.freeze({
    overlayId: 'aiPolishOverlay',
    load: () => import('./ai-polish/tool.js'),
    init: 'initAiPolishTool'
  }),
  'ai-translate': Object.freeze({
    overlayId: 'aiTranslateOverlay',
    load: () => import('./ai-translate/tool.js'),
    init: 'initAiTranslateTool'
  }),
  'ai-doc': Object.freeze({
    overlayId: 'aiDocOverlay',
    load: () => import('./ai-document/tool.js'),
    init: 'initAiDocumentTool'
  }),
  'ai-table': Object.freeze({
    overlayId: 'aiTableOverlay',
    load: () => import('./ai-table/tool.js'),
    init: 'initAiTableTool'
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
