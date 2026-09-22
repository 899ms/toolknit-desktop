import { PDF_COMPRESSION_POLICY, pdfCompressionError } from '../../core/pdf-compression.js';

function transaction(database, mode, action) {
  return new Promise((resolve, reject) => {
    const tx = database.transaction('pages', mode);
    const request = action(tx.objectStore('pages'));
    const timer = setTimeout(() => { try { tx.abort(); } catch {} reject(pdfCompressionError('cache-unavailable')); }, 10000);
    tx.oncomplete = () => { clearTimeout(timer); resolve(request.result); };
    tx.onerror = tx.onabort = () => { clearTimeout(timer); reject(pdfCompressionError('cache-unavailable')); };
  });
}

export async function openPdfPageDatabase(name) {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(name, 1);
    let settled = false;
    const fail = () => { settled = true; clearTimeout(timer); reject(pdfCompressionError('cache-unavailable')); };
    const timer = setTimeout(fail, 5000);
    request.onupgradeneeded = () => request.result.createObjectStore('pages');
    request.onsuccess = () => {
      clearTimeout(timer);
      if (settled) { request.result.close(); indexedDB.deleteDatabase(name); return; }
      settled = true;
      resolve(request.result);
    };
    request.onerror = request.onblocked = fail;
  });
}

export async function createPdfPageCache() {
  const name = `toolknit-pdf-compress-${Date.now()}-${crypto.randomUUID()}`;
  let database = null;
  try { database = await openPdfPageDatabase(name); } catch {}
  const memory = [];
  let size = 0;
  return {
    async put(index, blob) {
      size += blob.size;
      const limit = database ? PDF_COMPRESSION_POLICY.maxCacheBytes : PDF_COMPRESSION_POLICY.maxMemoryCacheBytes;
      if (size > limit) throw pdfCompressionError('cache-limit');
      if (database) await transaction(database, 'readwrite', store => store.put(blob, index));
      else memory[index] = blob;
    },
    get: index => database ? transaction(database, 'readonly', store => store.get(index)) : Promise.resolve(memory[index]),
    descriptor: () => database ? { database: name } : { blobs: memory },
    get bytes() { return size; },
    async dispose() {
      memory.length = 0;
      if (!database) return;
      database.close();
      database = null;
      await new Promise((resolve, reject) => {
        const request = indexedDB.deleteDatabase(name);
        const timer = setTimeout(() => reject(pdfCompressionError('cache-unavailable')), 10000);
        request.onsuccess = request.onblocked = () => { clearTimeout(timer); resolve(); };
        request.onerror = () => { clearTimeout(timer); reject(pdfCompressionError('cache-unavailable')); };
      });
    }
  };
}

export async function readPdfPageCache(descriptor) {
  const database = descriptor.database ? await openPdfPageDatabase(descriptor.database) : null;
  return {
    get: index => database ? transaction(database, 'readonly', store => store.get(index)) : Promise.resolve(descriptor.blobs[index]),
    dispose: () => database?.close()
  };
}
