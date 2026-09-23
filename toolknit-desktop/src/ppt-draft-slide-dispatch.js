function speakerNote(note, theme, { cleanInline, textBox, paragraph, fitTextParagraphs }) {
  const source = cleanInline(note);
  if (!source) return '';
  const locale = /[a-z]/i.test(source) ? 'EN' : '';
  const label = locale ? 'SPEAKER NOTE' : '讲述备注';
  return `${textBox(9001, 'Speaker note label', 0.82, 6.36, 1.6, 0.2, [paragraph(label, { size: 7.6, bold: true, colorValue: theme.accentSoft })])}${textBox(9002, 'Speaker note text', 1.78, 6.35, 5.9, 0.26, fitTextParagraphs(source, { width: 5.9, height: 0.26, size: 9.2, minSize: 7.6, maxLines: 1, colorValue: theme.muted }))}`;
}

/** Dispatches a normalized slide to its semantic poster builder. */
export function buildPptDraftContentSlide({
  slide,
  outline,
  theme,
  index,
  total,
  ctx,
  normalizeSlideText,
  posterCopy,
  builders,
  textHelpers
}) {
  const text = normalizeSlideText(slide);
  const copy = posterCopy(outline);
  let content;
  if (text.role === 'agenda' || text.role === 'section') content = builders.section(slide, outline, theme, index, total, text, ctx);
  else if (text.role === 'closing') content = builders.closing(slide, outline, theme, index, total, text, ctx);
  else if (text.role === 'problem') content = builders.problem(slide, outline, theme, index, total, text, ctx);
  else if (text.role === 'recommendation') content = builders.localFirst(slide, outline, theme, index, total, text, ctx);
  // Explicit layout contracts take precedence over semantic keyword matches.
  else if (text.role === 'comparison' || text.layoutKind === 'comparison') content = builders.comparison(slide, outline, theme, index, total, text, ctx);
  else if (['workflow', 'roadmap', 'process'].includes(text.role) || ['process', 'timeline'].includes(text.layoutKind)) content = builders.process(slide, outline, theme, index, total, text, ctx);
  else if (text.layoutKind === 'matrix' || text.role === 'evidence' && /matrix|网格|工具/i.test(`${text.visual} ${text.layoutFocus}`)) content = builders.matrix(slide, outline, theme, index, total, text, ctx);
  else if (['toolknit', 'tech-product'].includes(copy.profile) && /(?:^|\s)(?:MIT)(?:\s|$)|开源|open\s*source/i.test(`${text.title} ${text.claim}`)) content = builders.openSource(slide, outline, theme, index, total, text, ctx);
  else if (['toolknit', 'tech-product'].includes(copy.profile) && /三端|桌面.*CLI|Agent\s*\/\s*MCP/i.test(`${text.title} ${text.claim}`)) content = builders.triad(slide, outline, theme, index, total, text, ctx);
  else content = builders.statement(slide, outline, theme, index, total, text, ctx);
  return content + speakerNote(text.note, theme, textHelpers);
}
