import { createHardwareRenderHelpers } from './core.js';

export function createHardwareOverviewDefinition({ t, getLang }) {
  const helpers = createHardwareRenderHelpers({ t, getLang });
  const { escapeHtml, hardwareOverviewBytes, hardwareOverviewDate, hardwareOverviewSection, hardwareReadableText } = helpers;
  const text = key => t(`home.hardwareOverviewPage.${key}`);

  function value(input) {
    if (input === null || input === undefined || input === '' || input === 0) return text('unavailable');
    return hardwareReadableText(input, text('unavailable'));
  }

  function field(label, input) {
    return `<div class="hardware-overview-field"><span class="hardware-overview-key">${escapeHtml(label)}</span><span class="hardware-overview-value">${escapeHtml(value(input))}</span></div>`;
  }

  function uptime(input) {
    const bootAt = Number(input);
    if (!Number.isFinite(bootAt) || bootAt <= 0 || bootAt > Date.now()) return text('unavailable');
    let remaining = Math.floor((Date.now() - bootAt) / 1000);
    const days = Math.floor(remaining / 86400);
    remaining %= 86400;
    const hours = Math.floor(remaining / 3600);
    const minutes = Math.floor((remaining % 3600) / 60);
    return getLang() === 'zh' ? `${days} 天 ${hours} 小时 ${minutes} 分钟` : `${days}d ${hours}h ${minutes}m`;
  }

  function deviceType(input) {
    const map = { desktop: 'desktop', laptop: 'laptop', workstation: 'workstation', server: 'server' };
    return text(map[String(input || '').toLowerCase()] || 'otherDevice');
  }

  function statusValue(input, positiveKey, fallbackKey) {
    const normalized = String(input || '').toLowerCase();
    if (normalized === 'enabled') return text(positiveKey);
    if (normalized === 'disabled') return text(fallbackKey);
    return text('unavailable');
  }

  function primaryGpu(gpus) {
    const names = Array.isArray(gpus) ? gpus.map(gpu => hardwareReadableText(gpu?.name, '')).filter(Boolean) : [];
    return names.find(name => !/(virtual|remote|basic display|parsec|spacedesk)/i.test(name)) || names[0] || '';
  }

  function render(content, data) {
    const device = data?.device || {};
    const system = data?.system || {};
    const core = data?.core || {};
    const firmware = data?.firmware || {};
    const totalMemory = Number(core.memory_total_bytes);
    const availableMemory = Number(core.memory_available_bytes);
    const usedMemory = Number.isFinite(totalMemory) && totalMemory > 0 && Number.isFinite(availableMemory)
      ? Math.max(0, Math.min(100, Math.round((1 - availableMemory / totalMemory) * 100)))
      : null;
    const memoryText = Number.isFinite(usedMemory)
      ? `${hardwareOverviewBytes(totalMemory)} · ${usedMemory}% ${getLang() === 'zh' ? '已用' : 'used'}`
      : hardwareOverviewBytes(totalMemory);
    const disks = Array.isArray(core.disks) ? core.disks : [];
    const volumes = Array.isArray(core.volumes) ? core.volumes : [];
    const diskTotal = disks.reduce((sum, disk) => sum + Math.max(0, Number(disk?.size_bytes) || 0), 0);
    const volumeFree = volumes.reduce((sum, volume) => sum + Math.max(0, Number(volume?.free_bytes) || 0), 0);
    const storageText = diskTotal > 0
      ? `${hardwareOverviewBytes(diskTotal)} · ${hardwareOverviewBytes(volumeFree)} ${getLang() === 'zh' ? '可用' : 'free'}`
      : text('unavailable');
    const cpuSummary = [
      value(core.cpu_name),
      core.cpu_cores ? `${core.cpu_cores}${getLang() === 'zh' ? ' 核' : ' cores'}` : '',
      core.cpu_threads ? `${core.cpu_threads}${getLang() === 'zh' ? ' 线程' : ' threads'}` : ''
    ].filter(item => item && item !== text('unavailable')).join(' · ') || text('unavailable');
    const tpmText = firmware.tpm_present ? (firmware.tpm_ready ? text('ready') : text('present')) : text('notDetected');
    const sections = [
      hardwareOverviewSection(text('device'), [
        field(text('manufacturer'), device.manufacturer), field(text('model'), device.model),
        field(text('deviceType'), deviceType(device.device_type)), field(text('architecture'), system.architecture)
      ], text('localReadOnly')),
      hardwareOverviewSection(text('system'), [
        field(text('windows'), system.caption),
        field(text('version'), [system.version, system.build ? `Build ${system.build}` : ''].filter(Boolean).join(' · ')),
        field(text('installed'), hardwareOverviewDate(system.install_at, text('unavailable'))),
        field(text('uptime'), uptime(system.boot_at))
      ]),
      hardwareOverviewSection(text('coreHardware'), [
        field(text('cpu'), cpuSummary), field(text('memory'), memoryText),
        field(text('graphics'), primaryGpu(core.gpus)), field(text('storage'), storageText)
      ]),
      hardwareOverviewSection(text('firmwareSecurity'), [
        field(text('mainboard'), firmware.mainboard),
        field(text('bios'), [firmware.bios_version, hardwareOverviewDate(firmware.bios_release_at, text('unavailable'))].filter(item => item && item !== text('unavailable')).join(' · ')),
        field(text('bootMode'), firmware.boot_mode === 'uefi' ? text('uefi') : text('legacyOrUnavailable')),
        field(text('secureBoot'), statusValue(firmware.secure_boot, 'enabled', 'disabled')),
        field(text('tpm'), tpmText),
        field(text('virtualization'), firmware.virtualization_enabled ? text('enabled') : text('disabled'))
      ])
    ];

    const statusItems = [
      ['is-good', '✓', text('statusReadOnly')],
      [firmware.tpm_present && firmware.tpm_ready ? 'is-good' : 'is-neutral', firmware.tpm_present && firmware.tpm_ready ? '✓' : 'i', firmware.tpm_present && firmware.tpm_ready ? text('statusTpmReady') : text('statusTpmUnavailable')]
    ];
    if (firmware.secure_boot === 'enabled' || firmware.secure_boot === 'disabled') {
      statusItems.splice(1, 0, [firmware.secure_boot === 'enabled' ? 'is-good' : 'is-attention', firmware.secure_boot === 'enabled' ? '✓' : '!', firmware.secure_boot === 'enabled' ? text('statusSecureBootOn') : text('statusSecureBootOff')]);
    }
    if (data?.battery?.status === 'not_detected') statusItems.push(['is-neutral', 'i', text('statusNoBattery')]);
    const status = `<section class="hardware-overview-section"><div class="hardware-overview-section-heading"><h2 class="hardware-overview-section-title">${escapeHtml(text('status'))}</h2></div><div class="hardware-overview-status-list">${statusItems.map(([kind, icon, label]) => `<div class="hardware-overview-status-item ${kind}"><span class="hardware-overview-status-icon">${icon}</span><span>${escapeHtml(label)}</span></div>`).join('')}</div></section>`;
    content.innerHTML = `${sections.join('')}${status}`;
  }

  return {
    toolId: 'hardware-overview',
    prefix: 'hardwareOverview',
    command: 'get_hardware_overview',
    text,
    render,
    updatedAt(date) {
      const time = new Intl.DateTimeFormat(getLang() === 'zh' ? 'zh-CN' : 'en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(date);
      return t('home.hardwareOverviewPage.updated', { time });
    }
  };
}
