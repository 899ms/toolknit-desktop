export function escapeHardwareHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[character]);
}

export function createHardwareRenderHelpers({ t, getLang, escapeHtml = escapeHardwareHtml }) {
  const unavailable = () => t('home.hardwareOverviewPage.unavailable');

  function hardwareReadableText(value, fallback) {
    const fallbackText = fallback === undefined ? unavailable() : fallback;
    if (value === null || value === undefined) return fallbackText;
    const text = String(value).replace(/\0/g, '').replace(/[\u200B-\u200D\uFEFF]/g, '').trim();
    if (!text) return fallbackText;
    const compact = text.replace(/\s+/g, ' ');
    const normalized = compact.replace(/[·•]/g, ' ').trim();
    const placeholders = /^(unknown|undefined|not specified|unspecified|to be filled by o\.e\.m\.|system product name|system manufacturer|default string|default|none|null|n\/a|not applicable|generic pnp monitor)$/i;
    if (placeholders.test(normalized) || compact.includes('\uFFFD')) return fallbackText;
    if (/^(?:\?|\s){2,}$/.test(compact) || /(?:\?){3,}/.test(compact)) return fallbackText;
    return compact;
  }

  function hardwareOverviewBytes(value, fallback = unavailable()) {
    const bytes = Number(value);
    if (!Number.isFinite(bytes) || bytes <= 0) return fallback;
    const gib = bytes / (1024 ** 3);
    const locale = getLang() === 'zh' ? 'zh-CN' : 'en-US';
    return `${new Intl.NumberFormat(locale, { maximumFractionDigits: gib >= 100 ? 0 : 1 }).format(gib)} GB`;
  }

  function hardwareOverviewDate(value, fallback = unavailable()) {
    const timestamp = Number(value);
    if (!Number.isFinite(timestamp) || timestamp <= 0) return fallback;
    return new Intl.DateTimeFormat(getLang() === 'zh' ? 'zh-CN' : 'en-US', {
      year: 'numeric', month: '2-digit', day: '2-digit'
    }).format(new Date(timestamp));
  }

  function hardwareOverviewSection(title, fields, note = '') {
    return `<section class="hardware-overview-section">
      <div class="hardware-overview-section-heading">
        <h2 class="hardware-overview-section-title">${escapeHtml(title)}</h2>
        ${note ? `<span class="hardware-overview-section-note">${escapeHtml(note)}</span>` : ''}
      </div>
      <div class="hardware-overview-grid">${fields.join('')}</div>
    </section>`;
  }

  return {
    escapeHtml,
    hardwareOverviewBytes,
    hardwareOverviewDate,
    hardwareOverviewSection,
    hardwareReadableText
  };
}
