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
