export async function buildAiTablePdf({
  data,
  chartPngBytes = [],
  fontRegularBytes
} = {}) {
  if (!data?.columns?.length || !Array.isArray(data.rows)) {
    throw new TypeError('AI Table PDF requires normalized table data.');
  }
  const pdfModule = await import('pdf-lib-plus-encrypt');
  const { PDFDocument, StandardFonts, rgb } = pdfModule.PDFDocument
    ? pdfModule
    : pdfModule.default;
  const pdfDocument = await PDFDocument.create();
  let font;
  if (fontRegularBytes?.byteLength) {
    const fontkit = (await import('@pdf-lib/fontkit')).default;
    pdfDocument.registerFontkit(fontkit);
    font = await pdfDocument.embedFont(fontRegularBytes);
  } else {
    font = await pdfDocument.embedFont(StandardFonts.Helvetica);
  }

  const pageWidth = 595.28;
  const pageHeight = 841.89;
  const margin = 40;
  const rowHeight = 22;
  const fontSize = 9;
  const cellPadding = 5;
  let page = pdfDocument.addPage([pageWidth, pageHeight]);
  let y = pageHeight - margin;

  function fitText(value, maxWidth, size) {
    let text = String(value ?? '');
    if (font.widthOfTextAtSize(text, size) <= maxWidth) return text;
    while (text.length > 1 && font.widthOfTextAtSize(`${text}…`, size) > maxWidth) {
      text = text.slice(0, -1);
    }
    return `${text}…`;
  }

  if (data.title) {
    const titleSize = 16;
    page.drawText(fitText(data.title, pageWidth - margin * 2, titleSize), {
      x: margin,
      y: y - titleSize,
      size: titleSize,
      font,
      color: rgb(0.1, 0.1, 0.1)
    });
    y -= titleSize + 12;
  }

  const columnWidth = (pageWidth - margin * 2) / data.columns.length;
  const drawHeader = () => {
    page.drawRectangle({
      x: margin,
      y: y - rowHeight,
      width: pageWidth - margin * 2,
      height: rowHeight,
      color: rgb(0.18, 0.18, 0.18)
    });
    data.columns.forEach((column, columnIndex) => {
      page.drawText(
        fitText(column.label || column.key, columnWidth - cellPadding * 2, fontSize),
        {
          x: margin + columnIndex * columnWidth + cellPadding,
          y: y - rowHeight + 7,
          size: fontSize,
          font,
          color: rgb(1, 1, 1)
        }
      );
    });
    y -= rowHeight;
  };
  drawHeader();

  data.rows.forEach((row, rowIndex) => {
    if (y - rowHeight < margin) {
      page = pdfDocument.addPage([pageWidth, pageHeight]);
      y = pageHeight - margin;
      drawHeader();
    }
    if (rowIndex % 2 === 1) {
      page.drawRectangle({
        x: margin,
        y: y - rowHeight,
        width: pageWidth - margin * 2,
        height: rowHeight,
        color: rgb(0.95, 0.95, 0.95)
      });
    }
    row.forEach((value, columnIndex) => {
      page.drawText(fitText(value, columnWidth - cellPadding * 2, fontSize), {
        x: margin + columnIndex * columnWidth + cellPadding,
        y: y - rowHeight + 7,
        size: fontSize,
        font,
        color: rgb(0.15, 0.15, 0.15)
      });
    });
    y -= rowHeight;
  });

  for (const bytes of chartPngBytes) {
    const image = await pdfDocument.embedPng(bytes);
    const imageWidth = pageWidth - margin * 2;
    const imageHeight = image.height * (imageWidth / image.width);
    if (y - imageHeight < margin) {
      page = pdfDocument.addPage([pageWidth, pageHeight]);
      y = pageHeight - margin;
    }
    page.drawImage(image, {
      x: margin,
      y: y - imageHeight,
      width: imageWidth,
      height: imageHeight
    });
    y -= imageHeight + 20;
  }

  return pdfDocument.save();
}
