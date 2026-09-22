import { readdir, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);
const packageRoot = path.dirname(require.resolve('pdfjs-dist/package.json'));

function contentType(fileName) {
  if (fileName.endsWith('.wasm')) return 'application/wasm';
  if (fileName.endsWith('.js')) return 'text/javascript; charset=utf-8';
  if (fileName.endsWith('.ttf')) return 'font/ttf';
  return 'application/octet-stream';
}

/** Ship version-matched PDF.js resources in both Vite dev and packaged builds. */
export function pdfjsAssets() {
  let resources;
  const load = () => resources ||= (async () => {
    const entries = [];
    for (const directory of ['cmaps', 'standard_fonts', 'wasm']) {
      for (const file of await readdir(path.join(packageRoot, directory), { withFileTypes: true })) {
        if (file.isFile()) entries.push([
          `assets/pdfjs/${directory}/${file.name}`,
          await readFile(path.join(packageRoot, directory, file.name))
        ]);
      }
    }
    return new Map(entries);
  })();

  return {
    name: 'toolknit-pdfjs-assets',
    async configureServer(server) {
      const files = await load();
      server.middlewares.use((request, response, next) => {
        const source = files.get((request.url || '').split('?')[0].replace(/^\//, ''));
        if (!source) return next();
        response.setHeader('Content-Type', contentType(request.url || ''));
        response.setHeader('Content-Length', source.length);
        response.end(source);
      });
    },
    async generateBundle() {
      for (const [fileName, source] of await load()) this.emitFile({ type: 'asset', fileName, source });
    }
  };
}
