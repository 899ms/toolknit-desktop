export const LAZY_TOOL_SPECS = Object.freeze({
  'excel-to-pdf': Object.freeze({
    overlayId: 'excelToPdfOverlay',
    load: () => import('./excel-to-pdf/tool.js'),
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
  'pdf-encrypt': Object.freeze({
    overlayId: 'pdfEncryptOverlay',
    load: () => import('./pdf-security/encrypt-tool.js'),
    init: 'initPdfEncryptTool'
  }),
  'pdf-decrypt': Object.freeze({
    overlayId: 'pdfDecryptOverlay',
    load: () => import('./pdf-security/decrypt-tool.js'),
    init: 'initPdfDecryptTool'
  }),
  'pdf-enhance': Object.freeze({
    overlayId: 'pdfEnhanceOverlay',
    load: () => import('./pdf-enhance/tool.js'),
    init: 'initPdfEnhanceTool'
  }),
  'pdf-compress': Object.freeze({
    overlayId: 'pdfCompressOverlay',
    load: () => import('./pdf-compress/tool.js'),
    init: 'initPdfCompressTool'
  }),
  'pdf-editor': Object.freeze({
    overlayId: 'pdfEditorOverlay',
    load: () => import('./pdf-editor/tool.js'),
    init: 'initPdfEditorTool'
  }),
  'ppt-text': Object.freeze({
    overlayId: 'pptTextOverlay',
    load: () => import('./ppt-workflows/tool.js'),
    init: 'initPptTextTool'
  }),
  'ppt-compress': Object.freeze({
    overlayId: 'pptCompressOverlay',
    load: () => import('./ppt-workflows/tool.js'),
    init: 'initPptCompressTool'
  }),
  'ppt-outline': Object.freeze({
    overlayId: 'pptOutlineOverlay',
    load: () => import('./ppt-workflows/tool.js'),
    init: 'initPptOutlineTool'
  }),
  'ppt-to-pdf': Object.freeze({
    overlayId: 'pptToPdfOverlay',
    load: () => import('./ppt-render/tool.js'),
    init: 'initPptToPdfTool'
  }),
  'ppt-to-image': Object.freeze({
    overlayId: 'pptToImageOverlay',
    load: () => import('./ppt-render/tool.js'),
    init: 'initPptToImageTool'
  }),
  'ppt-images': Object.freeze({
    overlayId: 'pptImagesOverlay',
    load: () => import('./ppt-images/tool.js'),
    init: 'initPptImagesTool'
  }),
  'ppt-draft': Object.freeze({
    overlayId: 'pptDraftOverlay',
    load: () => import('./ppt-draft/tool.js'),
    init: 'initPptDraftTool'
  }),
  teleprompter: Object.freeze({
    overlayId: 'teleprompterOverlay',
    load: () => import('../teleprompter-ui.js'),
    init: 'initTeleprompterTool'
  }),
  'audio-extract': Object.freeze({
    overlayId: 'audioExtractFeatureOverlay',
    load: () => import('./audio-extract/tool.js'),
    init: 'initAudioExtractTool'
  }),
  convert: Object.freeze({
    overlayId: 'audioConvertFeatureOverlay',
    load: () => import('./audio-convert/tool.js'),
    init: 'initAudioConvertTool'
  }),
  'audio-clip': Object.freeze({
    overlayId: 'audioClipOverlay',
    load: () => import('./audio-tools/tool.js'),
    init: 'initAudioClipTool'
  }),
  'bpm-detect': Object.freeze({
    overlayId: 'bpmDetectOverlay',
    load: () => import('./audio-tools/tool.js'),
    init: 'initBpmDetectTool'
  }),
  'large-file-cleanup': Object.freeze({
    overlayId: 'largeFileCleanupOverlay',
    load: () => import('./cleanup-tools/tool.js'),
    init: 'initLargeFileCleanupTool'
  }),
  'c-drive-cleanup': Object.freeze({
    overlayId: 'cDriveCleanupOverlay',
    load: () => import('./cleanup-tools/tool.js'),
    init: 'initCDriveCleanupTool'
  }),
  'video-convert': Object.freeze({
    overlayId: 'videoConvertOverlay',
    load: () => import('./video-tools/tool.js'),
    init: 'initVideoConvertTool'
  }),
  'video-frame': Object.freeze({
    overlayId: 'videoFrameOverlay',
    load: () => import('./video-tools/tool.js'),
    init: 'initVideoFrameTool'
  }),
  'video-gif': Object.freeze({
    overlayId: 'videoGifOverlay',
    load: () => import('./video-tools/tool.js'),
    init: 'initVideoGifTool'
  }),
  'bg-removal': Object.freeze({
    overlayId: 'bgRemovalOverlay',
    load: () => import('./bg-removal/tool.js'),
    init: 'initBgRemovalTool'
  }),
  'markdown-editor': Object.freeze({
    overlayId: 'markdownEditorOverlay',
    load: () => import('./markdown-editor/tool.js'),
    init: 'initMarkdownEditorTool'
  }),
  'image-color-replace': Object.freeze({
    overlayId: 'imageColorReplaceOverlay',
    load: () => import('./image-color-replace/tool.js'),
    init: 'initImageColorReplaceTool'
  }),
  'image-convert': Object.freeze({
    overlayId: 'imageConvertOverlay',
    load: () => import('./image-batch/tool.js'),
    init: 'initImageConvertTool'
  }),
  'image-compress': Object.freeze({
    overlayId: 'imageCompressOverlay',
    load: () => import('./image-batch/tool.js'),
    init: 'initImageCompressTool'
  }),
  'image-crop': Object.freeze({
    overlayId: 'imageCropOverlay',
    load: () => import('./image-crop/tool.js'),
    init: 'initImageCropTool'
  }),
  'image-stitch': Object.freeze({
    overlayId: 'imageStitchOverlay',
    load: () => import('./image-stitch/tool.js'),
    init: 'initImageStitchTool'
  }),
  'icon-gen': Object.freeze({
    overlayId: 'iconGenOverlay',
    load: () => import('./icon-generator/tool.js'),
    init: 'initIconGeneratorTool'
  }),
  'hardware-overview': Object.freeze({
    overlayId: 'hardwareOverviewOverlay',
    load: () => import('./hardware-inspector/tool.js'),
    init: 'initHardwareOverviewTool'
  }),
  'hardware-cpu-memory': Object.freeze({
    overlayId: 'hardwareCpuMemoryOverlay',
    load: () => import('./hardware-inspector/tool.js'),
    init: 'initHardwareCpuMemoryTool'
  }),
  'hardware-gpu-display': Object.freeze({
    overlayId: 'hardwareGpuDisplayOverlay',
    load: () => import('./hardware-inspector/tool.js'),
    init: 'initHardwareGpuDisplayTool'
  }),
  'hardware-mainboard': Object.freeze({
    overlayId: 'hardwareMainboardOverlay',
    load: () => import('./hardware-inspector/tool.js'),
    init: 'initHardwareMainboardTool'
  }),
  'hardware-storage': Object.freeze({
    overlayId: 'hardwareStorageOverlay',
    load: () => import('./hardware-inspector/tool.js'),
    init: 'initHardwareStorageTool'
  }),
  'hardware-network-devices': Object.freeze({
    overlayId: 'hardwareNetworkDevicesOverlay',
    load: () => import('./hardware-inspector/tool.js'),
    init: 'initHardwareNetworkDevicesTool'
  }),
  'hardware-power-sensors': Object.freeze({
    overlayId: 'hardwarePowerSensorsOverlay',
    load: () => import('./hardware-inspector/tool.js'),
    init: 'initHardwarePowerSensorsTool'
  }),
  'color-space-compare': Object.freeze({
    overlayId: 'colorSpaceCompareOverlay',
    load: () => import('./color-space-compare/tool.js'),
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
