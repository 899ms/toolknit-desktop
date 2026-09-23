import { execFileSync } from 'node:child_process';
import { lstatSync } from 'node:fs';
import { resolve } from 'node:path';

/** Audit the files that will actually be built, including new local sources. */
export function listSourceFiles(repositoryRoot) {
  const candidates = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], {
    cwd: repositoryRoot, windowsHide: true, maxBuffer: 16 * 1024 * 1024
  }).toString('utf8').split('\0').filter(Boolean);
  return [...new Set(candidates)].filter(file => {
    try { return lstatSync(resolve(repositoryRoot, file)).isFile(); }
    catch (error) {
      if (error.code === 'ENOENT') return false;
      throw error;
    }
  });
}
