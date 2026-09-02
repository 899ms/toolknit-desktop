import { createHardwareRenderHelpers } from './core.js';

export function createCpuMemoryDefinition({ t, getLang }) {
  const { escapeHtml, hardwareOverviewBytes, hardwareOverviewSection, hardwareReadableText } = createHardwareRenderHelpers({ t, getLang });
  const text = key => t(`home.cpuMemoryPage.${key}`);
  const value = (input, fallback = text('unavailable')) => hardwareReadableText(input, fallback);

  function mhz(input) {
    const amount = Number(input);
    if (!Number.isFinite(amount) || amount <= 0) return text('unavailable');
    return `${new Intl.NumberFormat(getLang() === 'zh' ? 'zh-CN' : 'en-US', { maximumFractionDigits: 0 }).format(amount)} MHz`;
  }

  function percent(input) {
    const amount = Number(input);
    if (!Number.isFinite(amount) || amount < 0) return text('unavailable');
    return `${Math.max(0, Math.min(100, Math.round(amount)))}%`;
  }

  function memoryType(input) {
    const types = {
      20: 'DDR', 21: 'DDR2', 24: 'DDR3', 26: 'DDR4', 27: 'LPDDR', 28: 'LPDDR2',
      29: 'LPDDR3', 30: 'LPDDR4', 34: 'DDR5', 35: 'LPDDR5'
    };
    return types[Number(input)] || text('unavailable');
  }

  function ecc(input) {
    if ([5, 6].includes(Number(input))) return text('eccDetected');
    if (Number(input) === 3) return text('nonEcc');
    return text('unavailable');
  }

  function boolean(input, yesKey, noKey) {
    return input === true ? text(yesKey) : text(noKey);
  }

  function field(label, input) {
    return `<div class="hardware-overview-field"><span class="hardware-overview-key">${escapeHtml(label)}</span><span class="hardware-overview-value">${escapeHtml(value(input))}</span></div>`;
  }

  function aggregateFrequency(modules, key) {
    const values = Array.from(new Set(modules.map(module => Number(module?.[key])).filter(amount => Number.isFinite(amount) && amount > 0)));
    if (values.length === 1) return mhz(values[0]);
    if (values.length > 1) return values.map(mhz).join(' / ');
    return text('unavailable');
  }

  function moduleSlot(module) {
    const slot = value(module?.slot, '');
    const bank = value(module?.bank, '');
    if (slot && bank && slot.toLowerCase() !== bank.toLowerCase()) return `${slot} · ${bank}`;
    return slot || bank || text('unavailable');
  }

  function render(content, data) {
    const cpu = data?.cpu || {};
    const memory = data?.memory || {};
    const current = data?.current || {};
    const modules = Array.isArray(memory.modules) ? memory.modules : [];
    const totalMemory = Number(memory.total_bytes);
    const availableMemory = Number(current.memory_available_bytes ?? memory.available_bytes);
    const usedMemory = Number.isFinite(totalMemory) && totalMemory > 0 && Number.isFinite(availableMemory)
      ? Math.max(0, totalMemory - availableMemory)
      : NaN;
    const usedPercent = Number.isFinite(totalMemory) && totalMemory > 0 && Number.isFinite(usedMemory)
      ? Math.round((usedMemory / totalMemory) * 100)
      : NaN;
    const commitTotal = Number(current.committed_bytes);
    const commitLimit = Number(current.commit_limit_bytes);
    const commitText = Number.isFinite(commitTotal) && Number.isFinite(commitLimit) && commitLimit > 0
      ? `${hardwareOverviewBytes(commitTotal)} / ${hardwareOverviewBytes(commitLimit)}`
      : text('unavailable');
    const architecture = cpu.address_width ? `${cpu.address_width}-bit` : text('unavailable');
    const coresThreads = Number(cpu.cores) > 0 && Number(cpu.threads) > 0
      ? t('home.cpuMemoryPage.coresThreadsValue', { cores: cpu.cores, threads: cpu.threads })
      : text('unavailable');
    const memoryTypes = Array.from(new Set(modules.map(module => memoryType(module?.smbios_memory_type)).filter(item => item !== text('unavailable'))));
    const slotsText = Number(memory.slots_reported) > 0
      ? t('home.cpuMemoryPage.slotCount', { count: memory.slots_reported })
      : text('unavailable');
    const installedModulesText = modules.length
      ? t('home.cpuMemoryPage.moduleCount', { count: modules.length })
      : text('notDetected');

    const sections = [
      hardwareOverviewSection(text('processor'), [
        field(text('model'), cpu.name),
        field(text('manufacturer'), cpu.manufacturer),
        field(text('socket'), cpu.socket),
        field(text('architecture'), architecture),
        field(text('coresThreads'), coresThreads),
        field(text('maxFrequency'), mhz(cpu.max_clock_mhz)),
        field(text('currentFrequency'), mhz(cpu.current_clock_mhz)),
        field(text('l2Cache'), Number(cpu.l2_cache_kb) > 0 ? `${new Intl.NumberFormat(getLang() === 'zh' ? 'zh-CN' : 'en-US').format(cpu.l2_cache_kb)} KB` : text('unavailable')),
        field(text('l3Cache'), Number(cpu.l3_cache_kb) > 0 ? `${new Intl.NumberFormat(getLang() === 'zh' ? 'zh-CN' : 'en-US').format(cpu.l3_cache_kb)} KB` : text('unavailable'))
      ], text('localReadOnly')),
      hardwareOverviewSection(text('currentStatus'), [
        field(text('cpuUsage'), percent(current.cpu_usage_percent)),
        field(text('currentFrequency'), mhz(cpu.current_clock_mhz)),
        field(text('memoryTotal'), hardwareOverviewBytes(totalMemory)),
        field(text('memoryUsed'), Number.isFinite(usedMemory) ? `${hardwareOverviewBytes(usedMemory)} · ${t('home.cpuMemoryPage.percentUsed', { percent: Math.max(0, Math.min(100, usedPercent)) })}` : text('unavailable')),
        field(text('memoryAvailable'), hardwareOverviewBytes(availableMemory)),
        field(text('committedMemory'), commitText)
      ]),
      hardwareOverviewSection(text('memoryTopology'), [
        field(text('installedModules'), installedModulesText),
        field(text('reportedSlots'), slotsText),
        field(text('memoryType'), memoryTypes.length ? memoryTypes.join(' / ') : text('unavailable')),
        field(text('memoryFrequency'), aggregateFrequency(modules, 'configured_clock_mhz')),
        field(text('reportedFrequency'), aggregateFrequency(modules, 'speed_mhz')),
        field(text('ecc'), ecc(memory.error_correction_code))
      ])
    ];

    const rows = modules.length ? modules.map(module => {
      const brand = value(module?.manufacturer, text('brandUnavailable'));
      const model = value(module?.part_number, '');
      const frequency = `${mhz(module?.configured_clock_mhz)} / ${mhz(module?.speed_mhz)}`;
      return `<tr><td>${escapeHtml(moduleSlot(module))}</td><td><span class="cpu-memory-module-brand">${escapeHtml(brand)}</span>${model ? `<span class="cpu-memory-module-part">${escapeHtml(model)}</span>` : ''}</td><td>${escapeHtml(hardwareOverviewBytes(module?.capacity_bytes))}</td><td>${escapeHtml(memoryType(module?.smbios_memory_type))}</td><td>${escapeHtml(frequency)}</td></tr>`;
    }).join('') : `<tr><td colspan="5">${escapeHtml(text('notDetected'))}</td></tr>`;
    const moduleTable = `<section class="hardware-overview-section"><div class="hardware-overview-section-heading"><h2 class="hardware-overview-section-title">${escapeHtml(text('memoryModules'))}</h2></div><div class="cpu-memory-module-table-wrap"><table class="cpu-memory-module-table"><thead><tr><th>${escapeHtml(text('slot'))}</th><th>${escapeHtml(text('brandModel'))}</th><th>${escapeHtml(text('capacity'))}</th><th>${escapeHtml(text('type'))}</th><th>${escapeHtml(text('currentReported'))}</th></tr></thead><tbody>${rows}</tbody></table></div></section>`;
    const virtualizationOn = cpu.virtualization_firmware_enabled === true;
    const capabilitySection = hardwareOverviewSection(text('capabilities'), [
      field(text('virtualization'), boolean(virtualizationOn, 'enabled', 'disabled')),
      field(text('vmMonitor'), boolean(cpu.vm_monitor_extensions, 'supported', 'notSupported')),
      field(text('slat'), boolean(cpu.slat_extensions, 'supported', 'notSupported'))
    ]);
    const statusSection = `<section class="hardware-overview-section"><div class="hardware-overview-section-heading"><h2 class="hardware-overview-section-title">${escapeHtml(text('status'))}</h2></div><div class="cpu-memory-status-list"><div class="cpu-memory-status-item is-good"><span class="cpu-memory-status-icon">✓</span><span>${escapeHtml(text('statusReadOnly'))}</span></div><div class="cpu-memory-status-item ${virtualizationOn ? 'is-good' : 'is-neutral'}"><span class="cpu-memory-status-icon">${virtualizationOn ? '✓' : 'i'}</span><span>${escapeHtml(virtualizationOn ? text('statusVirtualizationOn') : text('statusVirtualizationOff'))}</span></div><div class="cpu-memory-status-item is-neutral"><span class="cpu-memory-status-icon">i</span><span>${escapeHtml(text('statusFrequencyInfo'))}</span></div></div></section>`;
    content.innerHTML = `${sections.join('')}${moduleTable}${capabilitySection}${statusSection}`;
  }

  return {
    toolId: 'hardware-cpu-memory',
    prefix: 'hardwareCpuMemory',
    command: 'get_cpu_memory_info',
    text,
    render,
    updatedAt(date) {
      const time = new Intl.DateTimeFormat(getLang() === 'zh' ? 'zh-CN' : 'en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(date);
      return t('home.cpuMemoryPage.updated', { time });
    },
    live: {
      command: 'get_cpu_memory_live_stats',
      intervalMs: 5000,
      merge(snapshot, live) {
        return { ...snapshot, current: { ...(snapshot.current || {}), ...live } };
      }
    }
  };
}
