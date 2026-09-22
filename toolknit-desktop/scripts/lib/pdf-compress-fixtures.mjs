import { PDFDocument, StandardFonts, degrees, rgb } from 'pdf-lib';
import { createCanvas } from '@napi-rs/canvas';
import fontkit from '@pdf-lib/fontkit';
import { readFile } from 'node:fs/promises';

export async function compressionFixtures() {
  const canvas = createCanvas(1400, 1800);
  const context = canvas.getContext('2d');
  const pixels = context.createImageData(canvas.width, canvas.height);
  let seed = 123456789;
  for (let index = 0; index < pixels.data.length; index += 4) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    pixels.data[index] = seed & 255;
    pixels.data[index + 1] = (seed >>> 8) & 255;
    pixels.data[index + 2] = (seed >>> 16) & 255;
    pixels.data[index + 3] = 255;
  }
  context.putImageData(pixels, 0, 0);
  const source = await PDFDocument.create();
  source.registerFontkit(fontkit);
  const image = await source.embedPng(canvas.toBuffer('image/png'));
  const sizes = [[612, 792], [500, 700], [700, 400]];
  const pages = sizes.map(([width, height]) => {
    const page = source.addPage([width, height]);
    page.drawImage(image, { x: 0, y: 0, width, height });
    return page;
  });
  pages[1].setRotation(degrees(90));
  pages[2].setCropBox(10, 20, 580, 340);
  pages[2].setRotation(degrees(270));
  const chinese = await source.embedFont(await readFile(new URL('../../public/assets/fonts/NotoSansSC-Regular.ttf', import.meta.url)), { subset: false });
  pages[0].drawRectangle({ x: 30, y: 610, width: 552, height: 150, color: rgb(1, 1, 1) });
  pages[0].drawText('PDF 压缩清晰度测试：中文、English 和数字 123456。', { x: 40, y: 660, size: 12, font: chinese });
  const field = source.getForm().createTextField('preserved-field');
  field.setText('keep-me');
  field.addToPage(pages[0], { x: 40, y: 700, width: 200, height: 25 });
  source.getForm().updateFieldAppearances(await source.embedFont(StandardFonts.Helvetica));
  const tiny = await PDFDocument.create();
  tiny.addPage([612, 792]).drawText('Small searchable document');
  return { image: new Uint8Array(await source.save()), tiny: new Uint8Array(await tiny.save()),
    expectedSizes: [[612, 792], [700, 500], [340, 580]] };
}
