import { createHardwareRenderHelpers } from './core.js';

export function createStorageDefinition({ t, getLang }) {
  const { escapeHtml, hardwareOverviewSection, hardwareReadableText } = createHardwareRenderHelpers({ t, getLang });
  const text = key => t(`home.storagePage.${key}`);
  const value = input => hardwareReadableText(input, text('unavailable'));

  function bytes(input) {
    const amount = Number(input);
    if (!Number.isFinite(amount) || amount <= 0) return text('unavailable');
    const gib = amount / (1024 ** 3);
    return `${new Intl.NumberFormat(getLang() === 'zh' ? 'zh-CN' : 'en-US', { maximumFractionDigits: gib >= 100 ? 0 : 1 }).format(gib)} GB`;
  }

  function number(input, suffix = '') {
    if (input === null || input === undefined || input === '') return text('unavailable');
    const amount = Number(input);
    if (!Number.isFinite(amount)) return text('unavailable');
    return `${new Intl.NumberFormat(getLang() === 'zh' ? 'zh-CN' : 'en-US', { maximumFractionDigits: 0 }).format(amount)}${suffix}`;
  }

  const field = (label, input) => `<div class="hardware-overview-field"><span class="hardware-overview-key">${escapeHtml(label)}</span><span class="hardware-overview-value">${escapeHtml(value(input))}</span></div>`;

  function health(input) {
    const normalized = String(input || '').toLowerCase();
    if (normalized === 'healthy' || normalized === 'ok') return text('healthy');
    if (normalized === 'warning' || normalized === 'degraded') return text('warning');
    if (normalized === 'unhealthy' || normalized === 'critical') return text('unhealthy');
    return text('unknownHealth');
  }

  function mediaType(input) {
    const normalized = String(input || '').toLowerCase();
    if (normalized === 'ssd') return text('ssd');
    if (normalized === 'hdd') return text('hdd');
    return text('unspecifiedMedia');
  }

  function usage(volume) {
    const total = Number(volume?.size_bytes);
    const free = Number(volume?.free_bytes);
    if (!Number.isFinite(total) || total <= 0 || !Number.isFinite(free) || free < 0) return { markup: text('unavailable'), low: false };
    const used = Math.max(0, total - free);
    const percent = Math.min(100, Math.max(0, Math.round((used / total) * 100)));
    const freeRatio = free / total;
    const kind = freeRatio < 0.1 ? 'is-warning' : freeRatio < 0.15 ? 'is-attention' : '';
    const label = t('home.storagePage.usedOf', { used: bytes(used), total: bytes(total), percent });
    return { low: freeRatio < 0.15, markup: `<div class="hardware-storage-usage ${kind}"><span class="hardware-storage-usage-copy">${escapeHtml(label)}</span><span class="hardware-storage-usage-track"><span class="hardware-storage-usage-fill" style="width:${Math.max(2, percent)}%"></span></span></div>` };
  }

  function table(headers, rows, className = '') {
    return `<div class="hardware-device-table-wrap"><table class="hardware-device-table ${escapeHtml(className)}"><thead><tr>${headers.map(header => `<th>${escapeHtml(header)}</th>`).join('')}</tr></thead><tbody>${rows}</tbody></table></div>`;
  }

  function render(content, data) {
    const disks = Array.isArray(data?.disks) ? data.disks : [];
    const volumes = Array.isArray(data?.volumes) ? data.volumes : [];
    const diskRows = disks.length ? disks.map(disk => `<tr><td><span class="hardware-device-table-primary">${escapeHtml(value(disk?.friendly_name))}</span><span class="hardware-device-table-secondary">${escapeHtml(t('home.storagePage.disk', { number: Number(disk?.number) || 0 }))}</span></td><td>${escapeHtml(mediaType(disk?.media_type))}<span class="hardware-device-table-secondary">${escapeHtml(value(disk?.bus_type))}</span></td><td>${escapeHtml(bytes(disk?.size_bytes))}</td><td>${escapeHtml(value(disk?.partition_style))}</td><td>${escapeHtml(health(disk?.health_status))}</td><td>${escapeHtml(value(disk?.firmware_version))}</td></tr>`).join('') : `<tr><td colspan="6">${escapeHtml(text('notDetected'))}</td></tr>`;
    const diskSection = `<section class="hardware-overview-section"><div class="hardware-overview-section-heading"><h2 class="hardware-overview-section-title">${escapeHtml(text('physicalDisks'))}</h2><span class="hardware-overview-section-note">${escapeHtml(t('home.storagePage.diskCount', { count: disks.length }))}</span></div>${table([text('model'), text('mediaType'), text('capacity'), text('partitionStyle'), text('health'), text('firmware')], diskRows)}</section>`;
    const reliability = disks.map(disk => {
      const counters = disk?.reliability || {};
      return hardwareOverviewSection(`${text('reliability')} · ${t('home.storagePage.disk', { number: Number(disk?.number) || 0 })}`, [
        field(text('temperature'), number(counters.temperature_c, ' °C')), field(text('wear'), number(counters.wear_percent, '%')),
        field(text('powerOnHours'), number(counters.power_on_hours, getLang() === 'zh' ? ' 小时' : ' h')),
        field(text('readErrors'), number(counters.read_errors_total)), field(text('writeErrors'), number(counters.write_errors_total)),
        field(text('operational'), value(disk?.operational_status))
      ], value(disk?.friendly_name));
    }).join('');
    const volumeStates = volumes.map(usage);
    const volumeRows = volumes.length ? volumes.map((volume, index) => `<tr><td><span class="hardware-device-table-primary">${escapeHtml(`${value(volume?.drive_letter)}:`)}</span><span class="hardware-device-table-secondary">${escapeHtml(text('fixedDisk'))}</span></td><td>${escapeHtml(value(volume?.file_system))}</td><td>${escapeHtml(bytes(volume?.size_bytes))}</td><td>${escapeHtml(bytes(volume?.free_bytes))}</td><td>${volumeStates[index].markup}</td></tr>`).join('') : `<tr><td colspan="5">${escapeHtml(text('notDetected'))}</td></tr>`;
    const volumeSection = `<section class="hardware-overview-section"><div class="hardware-overview-section-heading"><h2 class="hardware-overview-section-title">${escapeHtml(text('volumes'))}</h2><span class="hardware-overview-section-note">${escapeHtml(t('home.storagePage.volumeCount', { count: volumes.length }))}</span></div>${table([text('drive'), text('fileSystem'), text('total'), text('remaining'), text('usage')], volumeRows, 'hardware-storage-volume-table')}</section>`;
    const hasIssue = disks.some(disk => /^(warning|degraded|unhealthy|critical)$/i.test(String(disk?.health_status || '')) || disk?.is_offline);
    const lowVolumeCount = volumeStates.filter(state => state.low).length;
    const allHealthy = disks.length > 0 && !hasIssue && disks.every(disk => /^(healthy|ok)$/i.test(String(disk?.health_status || '')));
    const statusItems = [
      ['is-good', '✓', text('statusReadOnly')],
      [hasIssue ? 'is-attention' : allHealthy ? 'is-good' : 'is-neutral', hasIssue ? '!' : allHealthy ? '✓' : 'i', hasIssue ? text('statusAttention') : allHealthy ? text('statusHealthy') : text('notDetected')],
      ['is-neutral', 'i', text('statusReliability')]
    ];
    if (lowVolumeCount) statusItems.push(['is-attention', '!', t('home.storagePage.statusSpace', { count: lowVolumeCount })]);
    const status = `<section class="hardware-overview-section"><div class="hardware-overview-section-heading"><h2 class="hardware-overview-section-title">${escapeHtml(text('status'))}</h2></div><div class="cpu-memory-status-list">${statusItems.map(([kind, icon, label]) => `<div class="cpu-memory-status-item ${kind}"><span class="cpu-memory-status-icon">${icon}</span><span>${escapeHtml(label)}</span></div>`).join('')}</div></section>`;
    content.innerHTML = `${diskSection}${reliability}${volumeSection}${status}`;
  }

  return {
    toolId: 'hardware-storage', prefix: 'hardwareStorage', command: 'get_storage_health_info', text, render,
    updatedAt(date) {
      const time = new Intl.DateTimeFormat(getLang() === 'zh' ? 'zh-CN' : 'en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(date);
      return t('home.storagePage.updated', { time });
    }
  };
}
