import { createHardwareRenderHelpers } from './core.js';

export function createMainboardDefinition({ t, getLang }) {
  const { escapeHtml, hardwareOverviewDate, hardwareOverviewSection, hardwareReadableText } = createHardwareRenderHelpers({ t, getLang });
  const text = key => t(`home.mainboardPage.${key}`);
  const value = input => hardwareReadableText(input, text('unavailable'));
  const field = (label, input) => `<div class="hardware-overview-field"><span class="hardware-overview-key">${escapeHtml(label)}</span><span class="hardware-overview-value">${escapeHtml(value(input))}</span></div>`;

  function chassis(types) {
    const codes = Array.isArray(types) ? types.map(Number) : [];
    if (codes.some(code => [3, 4, 5, 6, 7, 15, 16, 35, 36].includes(code))) return text('desktop');
    if (codes.some(code => [8, 9, 10, 11, 12, 14, 30, 31, 32].includes(code))) return text('laptop');
    if (codes.some(code => [17, 23, 28, 29].includes(code))) return text('server');
    if (codes.includes(28)) return text('workstation');
    return text('otherChassis');
  }

  function pciCategory(input) {
    const map = {
      display: 'pciDisplay', net: 'pciNetwork', hdc: 'pciStorage', scsiadapter: 'pciStorage',
      system: 'pciSystem', securitydevices: 'pciSecurity', media: 'pciAudio', usb: 'pciUsb'
    };
    return text(map[String(input || '').toLowerCase()] || 'pciOther');
  }

  function secureBoot(input) {
    if (input === 'enabled') return text('enabled');
    if (input === 'disabled') return text('disabled');
    return text('unavailable');
  }

  function tpmStatus(security) {
    if (!security?.tpm_present) return text('notDetected');
    return security.tpm_ready ? text('ready') : text('present');
  }

  function table(headers, rows) {
    return `<div class="hardware-device-table-wrap"><table class="hardware-device-table mainboard-pci-table"><thead><tr>${headers.map(header => `<th>${escapeHtml(header)}</th>`).join('')}</tr></thead><tbody>${rows}</tbody></table></div>`;
  }

  function render(content, data) {
    const board = data?.board || {};
    const firmware = data?.firmware || {};
    const security = data?.security || {};
    const deviceChassis = data?.chassis || {};
    const devices = Array.isArray(data?.pci_devices) ? data.pci_devices : [];
    const smbios = Number(firmware.smbios_major) > 0 ? `${firmware.smbios_major}.${Number(firmware.smbios_minor) || 0}` : text('unavailable');
    const boardSection = hardwareOverviewSection(text('mainboard'), [
      field(text('manufacturer'), board.manufacturer), field(text('model'), board.product),
      field(text('version'), board.version), field(text('chassis'), chassis(deviceChassis.types)),
      field(text('boardStatus'), board.status)
    ], text('localReadOnly'));
    const firmwareSection = hardwareOverviewSection(text('firmware'), [
      field(text('biosManufacturer'), firmware.manufacturer), field(text('biosVersion'), firmware.bios_version),
      field(text('biosRelease'), hardwareOverviewDate(firmware.release_at, text('unavailable'))),
      field(text('smbios'), smbios),
      field(text('bootMode'), firmware.boot_mode === 'uefi' ? text('uefi') : text('legacyOrUnavailable'))
    ]);
    const securitySection = hardwareOverviewSection(text('security'), [
      field(text('secureBoot'), secureBoot(security.secure_boot)), field(text('tpm'), tpmStatus(security)),
      field(text('tpmManufacturer'), security.tpm_present ? security.tpm_manufacturer : text('notDetected')),
      field(text('virtualization'), security.virtualization_enabled ? text('enabled') : text('disabled'))
    ]);
    const rows = devices.length ? devices.map(device => {
      const problem = Number(device?.problem_code);
      const status = problem > 0 ? `${value(device?.status)} (${problem})` : value(device?.status);
      return `<tr><td><span class="hardware-device-table-primary">${escapeHtml(value(device?.name))}</span><span class="hardware-device-table-secondary">${escapeHtml(value(device?.manufacturer))}</span></td><td>${escapeHtml(pciCategory(device?.pnp_class))}</td><td>${escapeHtml(value(device?.manufacturer))}</td><td>${escapeHtml(status)}</td><td>${escapeHtml(String(Math.max(1, Number(device?.count) || 1)))}</td></tr>`;
    }).join('') : `<tr><td colspan="5">${escapeHtml(text('notDetected'))}</td></tr>`;
    const pciSection = `<section class="hardware-overview-section"><div class="hardware-overview-section-heading"><h2 class="hardware-overview-section-title">${escapeHtml(text('pciDevices'))}</h2><span class="hardware-overview-section-note">${escapeHtml(t('home.mainboardPage.pciCount', { count: devices.length }))}</span></div>${table([text('device'), text('category'), text('deviceManufacturer'), text('status'), text('instances')], rows)}</section>`;
    const statusItems = [
      ['is-good', '✓', text('statusReadOnly')],
      [security.tpm_present && security.tpm_ready ? 'is-good' : 'is-neutral', security.tpm_present && security.tpm_ready ? '✓' : 'i', security.tpm_present && security.tpm_ready ? text('statusTpmReady') : text('statusTpmUnavailable')],
      [security.virtualization_enabled ? 'is-good' : 'is-neutral', security.virtualization_enabled ? '✓' : 'i', security.virtualization_enabled ? text('statusVirtualizationOn') : text('statusVirtualizationOff')]
    ];
    if (security.secure_boot === 'enabled' || security.secure_boot === 'disabled') {
      statusItems.splice(1, 0, [security.secure_boot === 'enabled' ? 'is-good' : 'is-attention', security.secure_boot === 'enabled' ? '✓' : '!', security.secure_boot === 'enabled' ? text('statusSecureBootOn') : text('statusSecureBootOff')]);
    }
    const status = `<section class="hardware-overview-section"><div class="hardware-overview-section-heading"><h2 class="hardware-overview-section-title">${escapeHtml(text('status'))}</h2></div><div class="cpu-memory-status-list">${statusItems.map(([kind, icon, label]) => `<div class="cpu-memory-status-item ${kind}"><span class="cpu-memory-status-icon">${icon}</span><span>${escapeHtml(label)}</span></div>`).join('')}</div></section>`;
    content.innerHTML = `${boardSection}${firmwareSection}${securitySection}${pciSection}${status}`;
  }

  return {
    toolId: 'hardware-mainboard', prefix: 'hardwareMainboard', command: 'get_mainboard_firmware_info', text, render,
    updatedAt(date) {
      const time = new Intl.DateTimeFormat(getLang() === 'zh' ? 'zh-CN' : 'en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(date);
      return t('home.mainboardPage.updated', { time });
    }
  };
}
