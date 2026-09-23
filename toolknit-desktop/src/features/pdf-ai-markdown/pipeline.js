import { assertActive, conversionError, normalizePageAnalysis, normalizeSummary, parseJsonResponse, splitSummarySources } from './core.js';
import { buildPageVisionMessages, buildSummaryMessages } from './ai-messages.js';

const FATAL_CODES = new Set(['invalid_config', 'invalid_request', 'native_transport_unavailable', 'provider_changed']);
export function isFatalProviderError(error) {
  return FATAL_CODES.has(error?.code) || (error?.code === 'http_error' && [400, 401, 402, 403, 404, 413, 415, 422, 429].includes(error.status));
}

export async function analyzePdfPages({ totalPages, renderPage, requestAi, signal, previousPages = [], language = 'zh-CN', onProgress = () => {} }) {
  const pages = previousPages.slice();
  let summary = {};
  let summaryFailed = false;
  let consecutiveFailures = 0;
  const progress = (phase, page) => {
    assertActive(signal);
    onProgress({ phase, page, total: totalPages, pages: pages.slice(), current: pages.filter(item => item && !item.failed).length });
  };
  for (let pageNumber = 1; pageNumber <= totalPages; pageNumber += 1) {
    assertActive(signal);
    if (pages[pageNumber - 1] && !pages[pageNumber - 1].failed) continue;
    progress('renderingPage', pageNumber);
    try {
      const imageDataUrl = await renderPage(pageNumber, signal);
      assertActive(signal);
      progress('analyzingPage', pageNumber);
      const response = await requestAi(buildPageVisionMessages({ pageNumber, totalPages, imageDataUrl, language }), signal, 16384, { timeoutMs: 180000 });
      assertActive(signal);
      pages[pageNumber - 1] = normalizePageAnalysis(parseJsonResponse(response), pageNumber);
      consecutiveFailures = 0;
    } catch (error) {
      assertActive(signal);
      pages[pageNumber - 1] = { pageNumber, failed: true, blocks: [], warnings: [], errorCode: error.code || 'processError' };
      progress('analyzingPage', pageNumber);
      consecutiveFailures += 1;
      if (isFatalProviderError(error) || consecutiveFailures >= 3) throw error;
    }
    progress('analyzingPage', pageNumber);
  }
  if (pages.every(page => page.failed)) throw conversionError('all-pages-failed');
  try {
    let batches = splitSummarySources(pages.filter(page => !page.failed).map(page => ({ pageNumber: page.pageNumber, text: JSON.stringify(page) })));
    // Every source fragment participates; successive levels stay within the provider's message budget.
    while (batches.length) {
      const summaries = [];
      for (const [index, sources] of batches.entries()) {
        progress('summarizing', index + 1);
        const response = await requestAi(buildSummaryMessages({ sources, language }), signal, 4096, { timeoutMs: 180000 });
        assertActive(signal);
        summaries.push(normalizeSummary(parseJsonResponse(response)));
      }
      if (summaries.length === 1) { summary = summaries[0]; break; }
      const next = splitSummarySources(summaries.map((item, index) => ({ pageNumber: index + 1, text: JSON.stringify(item) })));
      if (next.length >= batches.length) throw conversionError('summary-too-large');
      batches = next;
    }
  } catch (error) {
    assertActive(signal);
    summaryFailed = true;
  }
  assertActive(signal);
  return { pages, summary, summaryFailed };
}
