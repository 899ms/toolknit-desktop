import { createHardwareRenderHelpers } from './core.js';

export function createNetworkDevicesDefinition({ t, getLang }) {
  const { escapeHtml, hardwareReadableText } = createHardwareRenderHelpers({ t, getLang });
  const text = key => t(`home.networkDevicesPage.${key}`);
  const value = input => hardwareReadableText(input, text('unavailable'));
  const active = adapter => String(adapter?.status || '').toLowerCase() === 'up';

  function connection(input) {
    const normalized = String(input || '').toLowerCase();
    if (normalized === 'up') return text('active');
    if (normalized === 'disconnected') return text('disconnected');
    if (normalized === 'disabled') return text('disabled');
    if (normalized === 'not present') return text('notPresent');
    return text('otherStatus');
  }

  function table(headers, rows, className = '') {
    return `<div class="hardware-device-table-wrap"><table class="hardware-device-table hardware-network-table ${escapeHtml(className)}"><thead><tr>${headers.map(header => `<th>${escapeHtml(header)}</th>`).join('')}</tr></thead><tbody>${rows}</tbody></table></div>`;
  }

  function adapterSection(title, adapters) {
    const rows = adapters.length ? adapters.map(adapter => `<tr><td><span class="hardware-device-table-primary">${escapeHtml(value(adapter?.name))}</span><span class="hardware-device-table-secondary">${escapeHtml(adapter?.physical ? text('physical') : text('virtual'))}</span></td><td>${escapeHtml(value(adapter?.description))}</td><td>${escapeHtml(connection(adapter?.status))}</td><td>${escapeHtml(active(adapter) ? value(adapter?.link_speed) : text('notConnected'))}</td></tr>`).join('') : `<tr><td colspan="4">${escapeHtml(text('notDetected'))}</td></tr>`;
    return `<section class="hardware-overview-section"><div class="hardware-overview-section-heading"><h2 class="hardware-overview-section-title">${escapeHtml(title)}</h2><span class="hardware-overview-section-note">${escapeHtml(t('home.networkDevicesPage.adapterCount', { count: adapters.length }))}</span></div>${table([text('adapter'), text('description'), text('connection'), text('linkSpeed')], rows)}</section>`;
  }

  function peripheralSection(title, devices) {
    const rows = devices.length ? devices.map(device => `<tr><td><span class="hardware-device-table-primary">${escapeHtml(value(device?.name))}</span></td><td>${escapeHtml(value(device?.manufacturer))}</td><td>${escapeHtml(value(device?.status))}</td><td>${escapeHtml(String(Math.max(1, Number(device?.count) || 1)))}</td></tr>`).join('') : `<tr><td colspan="4">${escapeHtml(text('notDetected'))}</td></tr>`;
    return `<section class="hardware-overview-section"><div class="hardware-overview-section-heading"><h2 class="hardware-overview-section-title">${escapeHtml(title)}</h2><span class="hardware-overview-section-note">${escapeHtml(t('home.networkDevicesPage.deviceCount', { count: devices.length }))}</span></div>${table([text('device'), text('manufacturer'), text('deviceStatus'), text('instances')], rows)}</section>`;
  }

  function render(content, data) {
    const adapters = Array.isArray(data?.network_adapters) ? data.network_adapters : [];
    const bluetooth = Array.isArray(data?.bluetooth_devices) ? data.bluetooth_devices : [];
    const audio = Array.isArray(data?.audio_devices) ? data.audio_devices : [];
    const usb = Array.isArray(data?.usb_devices) ? data.usb_devices : [];
    const cameras = Array.isArray(data?.cameras) ? data.cameras : [];
    const connectedCount = adapters.filter(active).length;
    const sections = [
      adapterSection(text('physicalNetwork'), adapters.filter(adapter => adapter?.physical === true)),
      adapterSection(text('virtualNetwork'), adapters.filter(adapter => adapter?.physical !== true)),
      peripheralSection(text('bluetooth'), bluetooth), peripheralSection(text('audio'), audio),
      peripheralSection(text('usb'), usb), peripheralSection(text('camera'), cameras)
    ];
    const statusItems = [
      ['is-good', '✓', text('statusReadOnly')],
      [connectedCount ? 'is-good' : 'is-neutral', connectedCount ? '✓' : 'i', connectedCount ? t('home.networkDevicesPage.statusNetworkActive', { count: connectedCount }) : text('statusNetworkInactive')],
      ['is-neutral', 'i', text('statusDevices')]
    ];
    const status = `<section class="hardware-overview-section"><div class="hardware-overview-section-heading"><h2 class="hardware-overview-section-title">${escapeHtml(text('status'))}</h2></div><div class="cpu-memory-status-list">${statusItems.map(([kind, icon, label]) => `<div class="cpu-memory-status-item ${kind}"><span class="cpu-memory-status-icon">${icon}</span><span>${escapeHtml(label)}</span></div>`).join('')}</div></section>`;
    content.innerHTML = `${sections.join('')}${status}`;
  }

  return {
    toolId: 'hardware-network-devices',
    prefix: 'hardwareNetworkDevices',
    command: 'get_network_devices_info',
    text,
    render,
    updatedAt(date) {
      const time = new Intl.DateTimeFormat(getLang() === 'zh' ? 'zh-CN' : 'en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(date);
      return t('home.networkDevicesPage.updated', { time });
    }
  };
}
