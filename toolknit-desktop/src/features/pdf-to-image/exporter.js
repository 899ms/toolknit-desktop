import { PDF_TO_IMAGE_LIMITS } from '../../pdf-to-image-core.js';
import { createLifecycleScope } from '../../app/tool-lifecycle.js';
import { tauriEventPromise } from '../../platform/tauri-runtime.js';

function canvasToBlob(canvas, mimeType, quality) {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      blob => blob ? resolve(blob) : reject(new Error('Image encoding failed')),
      mimeType,
      quality == null ? undefined : quality
    );
  });
}

function releaseCanvas(canvas) {
  if (!canvas) return;
  canvas.width = 0;
  canvas.height = 0;
  canvas.remove();
}

export function createPdfToImageExporter({
  isTauri = false,
  getDocument,
  getCurrentFile,
  getOutputDir,
  getInvoke,
  assertOperation,
  isOperationCurrent,
  setLocalizedProgress
} = {}) {
  const lifecycle = createLifecycleScope();
  const objectUrls = new Map();

  function revokeObjectUrl(url) {
    const timer = objectUrls.get(url);
    if (timer) window.clearTimeout(timer);
    objectUrls.delete(url);
    URL.revokeObjectURL(url);
  }

  lifecycle.use(() => {
    for (const url of objectUrls.keys()) revokeObjectUrl(url);
  });

  function downloadBlob(blob, fileName) {
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = fileName;
    anchor.click();
    const timer = window.setTimeout(() => revokeObjectUrl(url), 1500);
    objectUrls.set(url, timer);
  }

  async function collectPageMetrics(operation, selectedPages) {
    const pdfDocument = getDocument();
    const metrics = [];
    for (let index = 0; index < selectedPages.length; index += 1) {
      assertOperation(operation);
      const pageState = selectedPages[index];
      const page = await pdfDocument.getPage(pageState.pageNumber);
      assertOperation(operation);
      try {
        const viewport = page.getViewport({ scale: 1 });
        metrics.push({
          pageNumber: pageState.pageNumber,
          width: viewport.width,
          height: viewport.height
        });
      } finally {
        try { page.cleanup(); } catch (_) {}
      }
      setLocalizedProgress(
        3 + Math.round(((index + 1) / selectedPages.length) * 7),
        'preparing'
      );
    }
    return metrics;
  }

  async function renderPageCanvas(operation, pagePlan) {
    assertOperation(operation);
    const page = await getDocument().getPage(pagePlan.pageNumber);
    assertOperation(operation);
    let canvas = null;
    try {
      const viewport = page.getViewport({ scale: pagePlan.renderScale });
      const targetWidth = Number(pagePlan.width);
      const targetHeight = Number(pagePlan.height);
      if (!Number.isSafeInteger(targetWidth) || targetWidth < 1
        || !Number.isSafeInteger(targetHeight) || targetHeight < 1) {
        throw new Error('Invalid planned PDF page dimensions');
      }
      canvas = document.createElement('canvas');
      canvas.width = targetWidth;
      canvas.height = targetHeight;
      const context = canvas.getContext('2d', { alpha: false });
      if (!context) throw new Error('Cannot create export canvas');
      context.fillStyle = '#ffffff';
      context.fillRect(0, 0, canvas.width, canvas.height);
      const renderTask = page.render({
        canvasContext: context,
        viewport,
        transform: [targetWidth / viewport.width, 0, 0, targetHeight / viewport.height, 0, 0],
        background: '#ffffff'
      });
      operation.renderTask = renderTask;
      await renderTask.promise;
      operation.renderTask = null;
      assertOperation(operation);
      return canvas;
    } catch (error) {
      operation.renderTask = null;
      if (canvas) releaseCanvas(canvas);
      throw error;
    } finally {
      try { page.cleanup(); } catch (_) {}
    }
  }

  async function exportWithTauri(operation, plan, mode) {
    const invoke = await getInvoke();
    assertOperation(operation);
    let progressUnlisten = null;
    try {
      const session = await invoke('create_pdf_to_image_session');
      operation.sessionId = session.sessionId;
      assertOperation(operation);
      for (let index = 0; index < plan.pagePlans.length; index += 1) {
        assertOperation(operation);
        const pagePlan = plan.pagePlans[index];
        setLocalizedProgress(
          10 + Math.round((index / plan.pagePlans.length) * 68),
          'renderingPage',
          { current: index + 1, total: plan.pagePlans.length }
        );
        const canvas = await renderPageCanvas(operation, pagePlan);
        let blob;
        try {
          blob = await canvasToBlob(canvas, 'image/png');
        } finally {
          releaseCanvas(canvas);
        }
        assertOperation(operation);
        const bytes = new Uint8Array(await blob.arrayBuffer());
        assertOperation(operation);
        await invoke('write_pdf_to_image_page_json', {
          sessionId: operation.sessionId,
          fileName: 'page_' + String(pagePlan.pageNumber).padStart(5, '0') + '.png',
          bytes: Array.from(bytes)
        });
        assertOperation(operation);
        setLocalizedProgress(
          10 + Math.round(((index + 1) / plan.pagePlans.length) * 68),
          'renderingPage',
          { current: index + 1, total: plan.pagePlans.length }
        );
      }

      assertOperation(operation);
      const { listen } = await tauriEventPromise;
      assertOperation(operation);
      const jobId = operation.jobId;
      progressUnlisten = await listen('pdf-to-image-progress', event => {
        const payload = event.payload || {};
        if (payload.jobId !== jobId || !isOperationCurrent(operation)) return;
        const nativePercent = Math.max(0, Math.min(100, Number(payload.percent) || 0));
        const progressKey = payload.phase === 'compose'
          ? 'buildingLongImage'
          : payload.phase === 'publish'
            ? 'writingOutput'
            : mode === 'long'
              ? 'exportingLongImages'
              : 'exportingImages';
        const progressParams = payload.phase === 'compose'
          ? {
            current: Math.min(Number(payload.current || 0) + 1, Number(payload.total || 1)),
            total: Number(payload.total || 1)
          }
          : {};
        setLocalizedProgress(78 + Math.round(nativePercent * 0.22), progressKey, progressParams);
      });
      assertOperation(operation);
      const currentFile = getCurrentFile();
      const outputDir = await getOutputDir(currentFile?.outputCategory || 'PDF_To_Image');
      assertOperation(operation);
      operation.nativeExportStarted = true;
      const result = await invoke('export_pdf_to_images', {
        request: {
          sessionId: operation.sessionId,
          pages: plan.pages,
          pageCount: plan.pageCount,
          outputDir,
          outputName: plan.sourceName,
          format: plan.format,
          mode: mode === 'long-horizontal' ? 'long-horizontal' : mode === 'grid' ? 'grid' : mode === 'long' ? 'long' : 'images',
          pagesPerLongImage: PDF_TO_IMAGE_LIMITS.maxPagesPerLongImage,
          jpegQuality: plan.formatConfig.quality == null
            ? 94
            : Math.round(plan.formatConfig.quality * 100),
          backgroundRgba: '#FFFFFFFF',
          jobId
        }
      });
      assertOperation(operation);
      operation.sessionId = '';
      return result;
    } finally {
      operation.nativeExportStarted = false;
      if (progressUnlisten) {
        try { progressUnlisten(); } catch (_) {}
      }
      if (operation.sessionId) {
        try {
          await invoke('discard_pdf_to_image_session', { sessionId: operation.sessionId });
        } catch (_) {}
        operation.sessionId = '';
      }
    }
  }

  async function exportInBrowser(operation, plan, mode) {
    const outputs = [];
    if (mode === 'images') {
      for (let index = 0; index < plan.outputs.length; index += 1) {
        assertOperation(operation);
        const output = plan.outputs[index];
        const pagePlan = output.items[0];
        setLocalizedProgress(
          10 + Math.round((index / plan.outputs.length) * 85),
          'renderingPage',
          { current: index + 1, total: plan.outputs.length }
        );
        const canvas = await renderPageCanvas(operation, pagePlan);
        let blob;
        try {
          blob = await canvasToBlob(
            canvas,
            plan.formatConfig.mimeType,
            plan.formatConfig.quality
          );
        } finally {
          releaseCanvas(canvas);
        }
        assertOperation(operation);
        downloadBlob(blob, output.fileName);
        outputs.push({
          outputPath: output.fileName,
          width: output.width,
          height: output.height,
          pageNumbers: output.pageNumbers
        });
      }
    } else {
      for (let groupIndex = 0; groupIndex < plan.outputs.length; groupIndex += 1) {
        assertOperation(operation);
        const output = plan.outputs[groupIndex];
        const longCanvas = document.createElement('canvas');
        longCanvas.width = output.width;
        longCanvas.height = output.height;
        const context = longCanvas.getContext('2d', { alpha: false });
        if (!context) {
          releaseCanvas(longCanvas);
          throw new Error('Cannot create long image canvas');
        }
        context.fillStyle = '#ffffff';
        context.fillRect(0, 0, output.width, output.height);
        try {
          for (let itemIndex = 0; itemIndex < output.items.length; itemIndex += 1) {
            assertOperation(operation);
            const item = output.items[itemIndex];
            const pageCanvas = await renderPageCanvas(operation, item);
            context.drawImage(pageCanvas, item.x, item.y);
            releaseCanvas(pageCanvas);
          }
          setLocalizedProgress(
            10 + Math.round(((groupIndex + 1) / plan.outputs.length) * 80),
            'buildingLongImage',
            { current: groupIndex + 1, total: plan.outputs.length }
          );
          const blob = await canvasToBlob(
            longCanvas,
            plan.formatConfig.mimeType,
            plan.formatConfig.quality
          );
          assertOperation(operation);
          downloadBlob(blob, output.fileName);
          outputs.push({
            outputPath: output.fileName,
            width: output.width,
            height: output.height,
            pageNumbers: output.pageNumbers
          });
        } finally {
          releaseCanvas(longCanvas);
        }
      }
    }
    return {
      outputDir: '~/Downloads',
      outputs,
      outputCount: outputs.length,
      pageCount: plan.pages.length,
      format: plan.format.toUpperCase(),
      exportMode: mode === 'long' ? 'long' : 'pages'
    };
  }

  return {
    collectPageMetrics,
    dispose: () => lifecycle.dispose(),
    run(operation, plan, mode) {
      return isTauri
        ? exportWithTauri(operation, plan, mode)
        : exportInBrowser(operation, plan, mode);
    }
  };
}
