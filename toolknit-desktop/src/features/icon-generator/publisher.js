const ARCHIVE_CHUNK_BYTES = 5_000_000;

export async function discardIconArchiveOperation(operation, tauriCore) {
  const sessionId = operation?.archiveSessionId;
  if (sessionId === null || sessionId === undefined) return false;
  operation.archiveSessionId = null;
  try {
    const { invoke } = await tauriCore;
    await invoke('discard_icon_archive_write', { sessionId });
    return true;
  } catch {
    return false;
  }
}

export async function publishIconArchive({
  blob,
  operation,
  assertActive = () => {},
  isTauri = false,
  tauriCore,
  getOutputDir,
  documentRef = globalThis.document,
  urlApi = globalThis.URL,
  now = () => Date.now()
} = {}) {
  if (!(blob instanceof Blob)) throw new TypeError('Icon archive publication requires a Blob');
  if (!isTauri) {
    if (!documentRef?.body || !urlApi?.createObjectURL) {
      throw new TypeError('Browser icon archive publication requires document and URL APIs');
    }
    assertActive();
    const url = urlApi.createObjectURL(blob);
    try {
      const anchor = documentRef.createElement('a');
      anchor.href = url;
      anchor.download = 'icons.zip';
      anchor.hidden = true;
      documentRef.body.append(anchor);
      anchor.click();
      anchor.remove();
    } finally {
      urlApi.revokeObjectURL(url);
    }
    return { savedPath: '' };
  }
  if (!tauriCore || typeof getOutputDir !== 'function') {
    throw new TypeError('Native icon archive publication requires Tauri and an output directory provider');
  }

  try {
    const { invoke } = await tauriCore;
    const directory = await getOutputDir('Icons');
    assertActive();
    operation.archiveSessionId = await invoke('begin_icon_archive_write', {
      directory,
      fileName: `icons_${now()}.zip`
    });
    assertActive();
    const bytes = new Uint8Array(await blob.arrayBuffer());
    for (let offset = 0; offset < bytes.byteLength; offset += ARCHIVE_CHUNK_BYTES) {
      assertActive();
      await invoke('append_icon_archive_chunk', {
        sessionId: operation.archiveSessionId,
        bytes: Array.from(bytes.subarray(offset, Math.min(offset + ARCHIVE_CHUNK_BYTES, bytes.byteLength)))
      });
    }
    assertActive();
    const savedPath = await invoke('finalize_icon_archive_write', { sessionId: operation.archiveSessionId });
    operation.archiveSessionId = null;
    assertActive();
    return { savedPath };
  } catch (error) {
    await discardIconArchiveOperation(operation, tauriCore);
    throw error;
  }
}
