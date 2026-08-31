import { readResponseTextLimited } from './core/bounded-response.js';

const GITHUB_REPOSITORY = 'ZihangDong/toolknit-desktop';

export const UPDATE_RELEASES_PAGE = `https://github.com/${GITHUB_REPOSITORY}/releases/latest`;
export const UPDATE_RELEASE_API = `https://api.github.com/repos/${GITHUB_REPOSITORY}/releases/latest`;
export const UPDATE_CACHE_KEY = 'toolknit.update-check.v1';

const CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const DEFER_DURATION_MS = 24 * 60 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 8_000;
const MAX_RELEASE_TEXT_LENGTH = 80_000;
const MAX_UPDATE_API_BYTES = 512 * 1024;
const MAX_UPDATE_NOTES_BYTES = 128 * 1024;
const VERSION_PATTERN = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z.-]+)?$/;

function trimText(value, maxLength = MAX_RELEASE_TEXT_LENGTH) {
  return String(value || '').trim().slice(0, maxLength);
}

export function normalizeVersion(value) {
  const normalized = String(value || '').trim().replace(/^v/i, '');
  const match = VERSION_PATTERN.exec(normalized);
  if (!match) return null;
  return {
    raw: normalized,
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] ? match[4].split('.') : []
  };
}

function comparePrereleaseIdentifier(left, right) {
  const leftNumeric = /^\d+$/.test(left);
  const rightNumeric = /^\d+$/.test(right);
  if (leftNumeric && rightNumeric) return Number(left) - Number(right);
  if (leftNumeric) return -1;
  if (rightNumeric) return 1;
  return left.localeCompare(right);
}

export function compareVersions(leftValue, rightValue) {
  const left = normalizeVersion(leftValue);
  const right = normalizeVersion(rightValue);
  if (!left || !right) return 0;
  for (const key of ['major', 'minor', 'patch']) {
    if (left[key] !== right[key]) return left[key] > right[key] ? 1 : -1;
  }
  if (!left.prerelease.length || !right.prerelease.length) {
    if (left.prerelease.length === right.prerelease.length) return 0;
    return left.prerelease.length ? -1 : 1;
  }
  const length = Math.max(left.prerelease.length, right.prerelease.length);
  for (let index = 0; index < length; index += 1) {
    const leftIdentifier = left.prerelease[index];
    const rightIdentifier = right.prerelease[index];
    if (leftIdentifier === undefined) return -1;
    if (rightIdentifier === undefined) return 1;
    const comparison = comparePrereleaseIdentifier(leftIdentifier, rightIdentifier);
    if (comparison !== 0) return comparison > 0 ? 1 : -1;
  }
  return 0;
}

function stripMarkdown(value) {
  return trimText(value)
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/<[^>]*>/g, '')
    .replace(/[`*_~>#]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function summarizeReleaseNotes(markdown, limit = 3) {
  const lines = trimText(markdown).replace(/\r/g, '').split('\n');
  const sections = [];
  let active = null;
  let inCodeBlock = false;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (line.startsWith('```')) {
      inCodeBlock = !inCodeBlock;
      continue;
    }
    if (inCodeBlock || !line) continue;
    const heading = /^(?:#{2,6}\s+)(.+)$/.exec(line);
    if (heading) {
      active = { title: stripMarkdown(heading[1]), body: [] };
      if (active.title) sections.push(active);
      continue;
    }
    const item = /^(?:[-*+]\s+|\d+[.)]\s+)(.+)$/.exec(line);
    const body = stripMarkdown(item?.[1] || line);
    if (!body || /^#{1}\s+/.test(line)) continue;
    if (!active) {
      active = { title: '', body: [] };
      sections.push(active);
    }
    if (active.body.length < 2) active.body.push(body);
  }

  return sections
    .filter(section => section.title || section.body.length)
    .slice(0, Math.max(1, limit))
    .map(section => ({
      title: section.title || section.body[0] || '',
      body: section.title ? section.body.join(' ') : section.body.slice(1).join(' ')
    }));
}

export function summarizeReleaseIntroduction(markdown) {
  const lines = trimText(markdown).replace(/\r/g, '').split('\n');
  let inCodeBlock = false;
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (line.startsWith('```')) {
      inCodeBlock = !inCodeBlock;
      continue;
    }
    if (!line || inCodeBlock || /^#{1,6}\s+/.test(line) || /^>/.test(line) || /^(?:[-*+]\s+|\d+[.)]\s+)/.test(line)) continue;
    const summary = stripMarkdown(line);
    if (summary) return summary;
  }
  return '';
}

export function normalizeRelease(payload, notesMarkdown = '') {
  const version = normalizeVersion(payload?.tag_name)?.raw;
  if (!version) return null;
  const body = trimText(notesMarkdown || payload?.body);
  const htmlUrl = String(payload?.html_url || UPDATE_RELEASES_PAGE);
  if (!/^https:\/\/github\.com\/ZihangDong\/toolknit-desktop\/releases\//.test(htmlUrl)) return null;
  return {
    version,
    name: trimText(payload?.name || `ToolKnit Desktop v${version}`, 240),
    body,
    publishedAt: trimText(payload?.published_at, 64),
    htmlUrl,
    summary: summarizeReleaseIntroduction(body),
    notes: summarizeReleaseNotes(body),
    source: notesMarkdown ? 'release-file' : 'release-body'
  };
}

function rawNotesUrl(tagName) {
  return `https://raw.githubusercontent.com/${GITHUB_REPOSITORY}/${encodeURIComponent(tagName)}/docs/desktop-update.md`;
}

async function fetchWithTimeout(fetchImpl, url, options = {}) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetchImpl(url, { ...options, signal: controller.signal, credentials: 'omit' });
  } finally {
    clearTimeout(timeoutId);
  }
}

async function fetchLatestRelease(fetchImpl) {
  const response = await fetchWithTimeout(fetchImpl, UPDATE_RELEASE_API, {
    headers: {
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28'
    }
  });
  if (!response.ok) throw new Error(`update:http:${response.status}`);
  const payload = JSON.parse(await readResponseTextLimited(response, MAX_UPDATE_API_BYTES));
  const release = normalizeRelease(payload);
  if (!release) throw new Error('update:invalid-release');
  return { payload, release };
}

async function fetchReleaseNotes(fetchImpl, tagName) {
  const response = await fetchWithTimeout(fetchImpl, rawNotesUrl(tagName), {
    headers: { Accept: 'text/plain; charset=utf-8' }
  });
  if (!response.ok) return '';
  const text = await readResponseTextLimited(response, MAX_UPDATE_NOTES_BYTES);
  return trimText(text);
}

function readCache(storage) {
  try {
    const parsed = JSON.parse(storage?.getItem?.(UPDATE_CACHE_KEY) || 'null');
    if (!parsed || typeof parsed !== 'object') return null;
    const release = normalizeRelease({
      tag_name: parsed.release?.version,
      name: parsed.release?.name,
      body: parsed.release?.body,
      published_at: parsed.release?.publishedAt,
      html_url: parsed.release?.htmlUrl
    }, parsed.release?.source === 'release-file' ? parsed.release?.body : '');
    if (!release) return null;
    return {
      checkedAt: Number(parsed.checkedAt) || 0,
      deferredVersion: trimText(parsed.deferredVersion, 64),
      deferredUntil: Number(parsed.deferredUntil) || 0,
      release
    };
  } catch {
    return null;
  }
}

function writeCache(storage, cache) {
  try {
    storage?.setItem?.(UPDATE_CACHE_KEY, JSON.stringify(cache));
  } catch {
    // Storage can be unavailable or full. Update checks remain functional.
  }
}

export function createUpdateService({
  fetchImpl = globalThis.fetch?.bind(globalThis),
  storage = globalThis.localStorage,
  now = () => Date.now()
} = {}) {
  let inFlight = null;

  async function check({ force = false } = {}) {
    const cached = readCache(storage);
    const currentTime = now();
    if (!force && cached?.checkedAt && currentTime - cached.checkedAt < CACHE_TTL_MS) {
      return { release: cached.release, fromCache: true, deferredUntil: cached.deferredUntil, deferredVersion: cached.deferredVersion };
    }
    if (inFlight) return inFlight;
    if (typeof fetchImpl !== 'function') throw new Error('update:network-unavailable');
    inFlight = (async () => {
      const { payload, release: apiRelease } = await fetchLatestRelease(fetchImpl);
      let release = apiRelease;
      try {
        const notes = await fetchReleaseNotes(fetchImpl, payload.tag_name);
        if (notes) release = normalizeRelease(payload, notes) || apiRelease;
      } catch {
        // The Release body is authoritative enough for the update screen.
      }
      const nextCache = {
        checkedAt: currentTime,
        deferredVersion: cached?.deferredVersion || '',
        deferredUntil: cached?.deferredUntil || 0,
        release
      };
      writeCache(storage, nextCache);
      return { release, fromCache: false, deferredUntil: nextCache.deferredUntil, deferredVersion: nextCache.deferredVersion };
    })();
    try {
      return await inFlight;
    } finally {
      inFlight = null;
    }
  }

  function defer(version) {
    const cached = readCache(storage);
    if (!cached || !normalizeVersion(version)) return;
    const deferredUntil = now() + DEFER_DURATION_MS;
    writeCache(storage, { ...cached, deferredVersion: normalizeVersion(version).raw, deferredUntil });
  }

  function shouldPrompt(result, currentVersion) {
    const release = result?.release;
    if (!release || compareVersions(release.version, currentVersion) <= 0) return false;
    const currentTime = now();
    return !(result.deferredVersion === release.version && result.deferredUntil > currentTime);
  }

  return { check, defer, shouldPrompt };
}
