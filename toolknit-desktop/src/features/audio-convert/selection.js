export async function readNativeAudioFiles(paths, invoke, isCurrent = () => true) {
  const files = [];
  for (const path of Array.isArray(paths) ? paths : [paths]) {
    if (!isCurrent()) return null;
    if (typeof path !== 'string' || !path) continue;
    const size = Number(await invoke('get_file_size', { path }));
    if (!isCurrent()) return null;
    files.push({ name: path.split(/[\\/]/).pop() || path, path, size });
  }
  return files;
}
