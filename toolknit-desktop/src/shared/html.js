/**
 * Escape untrusted values before inserting them into HTML text or attributes.
 * This dependency-free helper is shared by the app shell and feature modules.
 */
export function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, character => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  }[character]));
}

export function escapeAttr(value) {
  return escapeHtml(value);
}
