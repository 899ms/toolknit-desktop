import { readFileSync } from 'node:fs';

const LOCAL_IMPORT_PATTERN = /@import\s+url\((['"])(\.\.?\/[^'"]+)\1\)\s*;/g;

function expandStyleModule(moduleUrl, stack) {
  const key = moduleUrl.href;
  if (stack.has(key)) {
    throw new Error(`Circular global stylesheet import: ${key}`);
  }

  const nextStack = new Set(stack).add(key);
  const source = readFileSync(moduleUrl, 'utf8');
  return source.replace(LOCAL_IMPORT_PATTERN, (_statement, _quote, specifier) => (
    expandStyleModule(new URL(specifier, moduleUrl), nextStack)
  ));
}

export function readGlobalStyles(importMetaUrl) {
  return expandStyleModule(new URL('../src/styles/index.css', importMetaUrl), new Set());
}
