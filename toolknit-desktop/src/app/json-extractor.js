// Tolerant JSON extraction for AI responses. Kept independent from DOM state
// so document and table features can reuse it without loading application.js.
export function extractJson(str) {
  if (!str || typeof str !== 'string') return null;

  try {
    JSON.parse(str.trim());
    return str.trim();
  } catch {}

  const codeBlockRegex = /```(?:json|javascript|js)?\s*\n([\s\S]*?)\n```/g;
  let match;
  while ((match = codeBlockRegex.exec(str)) !== null) {
    const trimmed = cleanJsonString(match[1].trim());
    try { JSON.parse(trimmed); return trimmed; } catch {}
    const start = trimmed.indexOf('{');
    if (start !== -1) {
      const result = extractBalancedJson(trimmed, start);
      if (result) {
        try { JSON.parse(result); return result; } catch {}
      }
    }
  }

  const cleaned = cleanJsonString(str
    .replace(/```(?:json|javascript|js)?\s*/g, '')
    .replace(/```\s*/g, '')
    .trim());
  try { JSON.parse(cleaned); return cleaned; } catch {}

  const start = cleaned.indexOf('{');
  if (start === -1) return null;
  const balanced = extractBalancedJson(cleaned, start);
  if (balanced) {
    try { JSON.parse(balanced); return balanced; } catch {}
  }

  const lastClose = cleaned.lastIndexOf('}');
  if (lastClose > start) {
    const candidate = cleaned.substring(start, lastClose + 1);
    try { JSON.parse(candidate); return candidate; } catch {}
  }

  const repaired = repairTruncatedJson(cleaned);
  if (repaired) {
    try { JSON.parse(repaired); return repaired; } catch {}
  }
  return balanced;
}

function repairTruncatedJson(str) {
  const start = str.indexOf('{');
  if (start === -1) return null;
  const candidates = [];
  const stack = [];
  let inString = false;
  let escape = false;
  for (let i = start; i < str.length; i += 1) {
    const ch = str[i];
    if (escape) { escape = false; continue; }
    if (ch === '\\') { if (inString) escape = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === '{' || ch === '[') stack.push(ch);
    else if (ch === '}' || ch === ']') {
      stack.pop();
      candidates.push({ pos: i, stack: stack.slice() });
    }
  }
  for (let i = candidates.length - 1; i >= 0; i -= 1) {
    const { pos, stack: remaining } = candidates[i];
    let closing = '';
    for (let j = remaining.length - 1; j >= 0; j -= 1) {
      closing += remaining[j] === '{' ? '}' : ']';
    }
    const candidate = str.substring(start, pos + 1) + closing;
    try {
      JSON.parse(candidate);
      console.warn('[AI] Repaired truncated JSON response:', candidate.length);
      return candidate;
    } catch {}
  }
  return null;
}

function cleanJsonString(str) {
  return str.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFEFF\uFFFD]/g, '');
}

function extractBalancedJson(str, start) {
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < str.length; i += 1) {
    const ch = str[i];
    if (escape) { escape = false; continue; }
    if (ch === '\\' && inString) { escape = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return str.substring(start, i + 1);
    }
  }
  return null;
}
