/** Home search/category/favourite coordination with a small DOM surface. */
export function createHomeController({ root = document, onOpenTool } = {}) {
  const filter = query => {
    const normalized = String(query || '').trim().toLocaleLowerCase();
    root.querySelectorAll('[data-tool]').forEach(card => {
      const haystack = `${card.textContent || ''} ${card.getAttribute('data-tool') || ''}`.toLocaleLowerCase();
      card.hidden = Boolean(normalized) && !haystack.includes(normalized);
    });
  };
  const open = toolId => onOpenTool?.(toolId);
  return Object.freeze({ filter, open });
}
