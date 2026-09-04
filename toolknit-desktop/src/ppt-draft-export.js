import JSZip from 'jszip';
import {
  buildContentTypes,
  buildPresentationRels,
  buildPresentationXml,
  buildSlideXml,
  docPropsApp,
  docPropsCore,
  normalizeSlideShapeIds,
  rootRels,
  simpleThemeXml,
  slideLayoutXml,
  slideMasterXml
} from './ppt-draft-package.js';
import { buildPptDraftContentSlide } from './ppt-draft-slide-dispatch.js';

/** Packages a normalized outline while keeping layout logic out of the exporter. */
export async function buildPptDraftPptx(outlineValue, options = {}, dependencies = {}) {
  const {
    PPT_DRAFT_LIMITS,
    normalizePptDraftOutline,
    resolvePptDraftThemeTokens,
    createSlideAssetContext,
    buildPosterCover,
    normalizeSlideText,
    posterCopy,
    buildPosterSection,
    buildPosterClosing,
    buildPosterProblem,
    buildPosterLocalFirst,
    buildPosterComparison,
    buildPosterProcess,
    buildPosterMatrix,
    buildPosterOpenSource,
    buildPosterTriad,
    buildPosterStatement,
    cleanInline,
    textBox,
    paragraph,
    fitTextParagraphs,
    fail
  } = dependencies;
  const outline = normalizePptDraftOutline(outlineValue, options.request || {});
  const theme = resolvePptDraftThemeTokens(options.theme || outline.request?.theme, outline);
  const slides = outline.slides || [];
  if (slides.length < PPT_DRAFT_LIMITS.minSlides || slides.length > PPT_DRAFT_LIMITS.maxSlides) {
    const message = `outline must contain ${PPT_DRAFT_LIMITS.minSlides}-${PPT_DRAFT_LIMITS.maxSlides} slides.`;
    if (typeof fail === 'function') fail('invalid_outline', message);
    throw new Error(`ppt-draft:invalid_outline:${message}`);
  }
  const zip = new JSZip();
  const assetRegistry = new Map();
  zip.file('[Content_Types].xml', buildContentTypes(slides.length));
  zip.file('_rels/.rels', rootRels());
  zip.file('docProps/core.xml', docPropsCore(outline.title));
  zip.file('docProps/app.xml', docPropsApp(slides.length));
  zip.file('ppt/presentation.xml', buildPresentationXml(slides.length));
  zip.file('ppt/_rels/presentation.xml.rels', buildPresentationRels(slides.length));
  zip.file('ppt/slideMasters/slideMaster1.xml', slideMasterXml(theme));
  zip.file('ppt/slideMasters/_rels/slideMaster1.xml.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme" Target="../theme/theme1.xml"/></Relationships>`);
  zip.file('ppt/slideLayouts/slideLayout1.xml', slideLayoutXml());
  zip.file('ppt/slideLayouts/_rels/slideLayout1.xml.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="../slideMasters/slideMaster1.xml"/></Relationships>`);
  zip.file('ppt/theme/theme1.xml', simpleThemeXml(theme));
  const placeholderManifest = [];
  const slideBuilders = {
    section: buildPosterSection,
    closing: buildPosterClosing,
    problem: buildPosterProblem,
    localFirst: buildPosterLocalFirst,
    comparison: buildPosterComparison,
    process: buildPosterProcess,
    matrix: buildPosterMatrix,
    openSource: buildPosterOpenSource,
    triad: buildPosterTriad,
    statement: buildPosterStatement
  };
  const textHelpers = { cleanInline, textBox, paragraph, fitTextParagraphs };
  slides.forEach((slide, index) => {
    const ctx = createSlideAssetContext(assetRegistry, index + 1);
    const content = index === 0
      ? buildPosterCover(outline, theme, ctx)
      : buildPptDraftContentSlide({
        slide,
        outline,
        theme,
        index,
        total: slides.length,
        ctx,
        normalizeSlideText,
        posterCopy,
        builders: slideBuilders,
        textHelpers
      });
    zip.file(`ppt/slides/slide${index + 1}.xml`, buildSlideXml(normalizeSlideShapeIds(content), theme));
    zip.file(`ppt/slides/_rels/slide${index + 1}.xml.rels`, ctx.relationships());
    placeholderManifest.push(...ctx.placeholderManifest());
  });
  for (const asset of assetRegistry.values()) zip.file(asset.path, asset.data);
  const bytes = await zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE', compressionOptions: { level: 6 } });
  return {
    bytes,
    outline: { ...outline, image_placeholders: placeholderManifest },
    theme: theme.id,
    slide_count: slides.length,
    image_placeholders: placeholderManifest,
    size_bytes: bytes.byteLength
  };
}
