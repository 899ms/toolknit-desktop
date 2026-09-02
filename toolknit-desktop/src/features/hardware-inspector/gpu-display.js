import { createHardwareRenderHelpers } from './core.js';

export function createGpuDisplayDefinition({ t, getLang }) {
  const { escapeHtml, hardwareOverviewBytes, hardwareOverviewSection, hardwareReadableText } = createHardwareRenderHelpers({ t, getLang });
  const text = key => t(`home.gpuDisplayPage.${key}`);
  const value = (input, fallback = text('unavailable')) => hardwareReadableText(input, fallback);

  function isVirtual(adapter) {
    return (Number(adapter?.flags) & 2) === 2 || /(virtual|remote|basic display|parsec|spacedesk|gameviewer|miracast)/i.test(String(adapter?.name || adapter?.description || ''));
  }

  function vendor(adapter) {
    const id = Number(adapter?.vendor_id);
    if (id === 0x10de) return 'NVIDIA';
    if (id === 0x1002 || id === 0x1022) return 'AMD';
    if (id === 0x8086) return 'Intel';
    const name = String(adapter?.name || adapter?.description || '');
    if (/nvidia/i.test(name)) return 'NVIDIA';
    if (/amd|radeon/i.test(name)) return 'AMD';
    if (/intel/i.test(name)) return 'Intel';
    return text('unknownVendor');
  }

  function identity(input) {
    return String(input || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  }

  function uniqueGpus(gpus) {
    const seen = new Set();
    return gpus.filter(gpu => {
      const key = [identity(gpu?.name || gpu?.video_processor), identity(gpu?.driver_version), identity(gpu?.driver_date)].filter(Boolean).join(':');
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  function uniqueDxgi(adapters) {
    const seen = new Set();
    return adapters.filter(adapter => {
      const key = [identity(adapter?.description), Number(adapter?.vendor_id), Number(adapter?.device_id), Number(adapter?.dedicated_video_memory)].join(':');
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  function matchingDxgi(gpu, adapters) {
    const gpuIdentity = identity(gpu?.name || gpu?.video_processor);
    return adapters.find(adapter => {
      const adapterIdentity = identity(adapter?.description);
      return gpuIdentity && adapterIdentity && (adapterIdentity.includes(gpuIdentity) || gpuIdentity.includes(adapterIdentity));
    }) || adapters.find(adapter => !isVirtual(adapter)) || null;
  }

  function connection(input) {
    const connections = {
      0: 'connectionVga', 4: 'connectionDvi', 5: 'connectionHdmi', 10: 'connectionDisplayPort',
      11: 'connectionDisplayPort', 6: 'connectionInternal', 0x80000000: 'connectionInternal'
    };
    return text(connections[Number(input)] || 'connectionOther');
  }

  function diagonal(monitor) {
    const width = Number(monitor?.width_cm);
    const height = Number(monitor?.height_cm);
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return text('unavailable');
    const inches = Math.sqrt(width ** 2 + height ** 2) / 2.54;
    return `${new Intl.NumberFormat(getLang() === 'zh' ? 'zh-CN' : 'en-US', { maximumFractionDigits: 1 }).format(inches)} in (${width} × ${height} cm)`;
  }

  function displayKey(input) {
    return String(input || '').toUpperCase().match(/(?:DISPLAY|MONITOR)[\\#]([^\\#]+)/)?.[1] || '';
  }

  function displayConfig(monitor, configurations) {
    const key = monitor?.display_key || displayKey(monitor?.display_id || monitor?.instance);
    if (!key) return null;
    return configurations.find(configuration => {
      const configurationKey = configuration?.monitor_key || displayKey(configuration?.monitor_device_id);
      return configurationKey && configurationKey === key;
    }) || null;
  }

  function resolution(configuration) {
    const width = Number(configuration?.width);
    const height = Number(configuration?.height);
    const refresh = Number(configuration?.refresh_hz);
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return text('unavailable');
    return `${width} × ${height}${Number.isFinite(refresh) && refresh > 1 ? ` · ${refresh} Hz` : ''}`;
  }

  function field(label, input) {
    return `<div class="hardware-overview-field"><span class="hardware-overview-key">${escapeHtml(label)}</span><span class="hardware-overview-value">${escapeHtml(value(input))}</span></div>`;
  }

  function table(headers, rows) {
    return `<div class="hardware-device-table-wrap"><table class="hardware-device-table"><thead><tr>${headers.map(header => `<th>${escapeHtml(header)}</th>`).join('')}</tr></thead><tbody>${rows}</tbody></table></div>`;
  }

  function render(content, data) {
    const gpus = Array.isArray(data?.gpus) ? data.gpus : [];
    const monitors = Array.isArray(data?.monitors) ? data.monitors : [];
    const dxgiAdapters = Array.isArray(data?.dxgi_adapters) ? data.dxgi_adapters : [];
    const configurations = Array.isArray(data?.display_configurations) ? data.display_configurations : [];
    const physicalGpus = uniqueGpus(gpus.filter(gpu => !isVirtual(gpu)));
    const virtualGpus = gpus.filter(isVirtual);
    const primaryGpu = physicalGpus[0] || dxgiAdapters.find(adapter => !isVirtual(adapter)) || null;
    const primaryDxgi = primaryGpu ? matchingDxgi(primaryGpu, dxgiAdapters) : null;
    const primaryName = primaryGpu?.name || primaryDxgi?.description || text('notDetected');
    const primaryEngine = primaryGpu?.video_processor || primaryName;

    const primarySection = hardwareOverviewSection(text('primaryGpu'), [
      field(text('model'), primaryName),
      field(text('gpuEngine'), primaryEngine),
      field(text('vendor'), vendor(primaryDxgi || primaryGpu)),
      field(text('dedicatedMemory'), hardwareOverviewBytes(primaryDxgi?.dedicated_video_memory)),
      field(text('sharedMemory'), hardwareOverviewBytes(primaryDxgi?.shared_system_memory)),
      field(text('driverVersion'), primaryGpu?.driver_version),
      field(text('driverDate'), primaryGpu?.driver_date)
    ], text('localReadOnly'));

    const physicalAdapters = physicalGpus.length
      ? physicalGpus.map(gpu => ({ gpu, dxgi: matchingDxgi(gpu, dxgiAdapters) }))
      : uniqueDxgi(dxgiAdapters.filter(adapter => !isVirtual(adapter))).map(dxgi => ({ gpu: null, dxgi }));
    const adapterRows = physicalAdapters.length ? physicalAdapters.map(({ gpu, dxgi }) => {
      const name = gpu?.name || dxgi?.description;
      return `<tr><td><span class="hardware-device-table-primary">${escapeHtml(value(name))}</span><span class="hardware-device-table-secondary">${escapeHtml(vendor(dxgi || gpu))}</span></td><td>${escapeHtml(hardwareOverviewBytes(dxgi?.dedicated_video_memory))}</td><td>${escapeHtml(hardwareOverviewBytes(dxgi?.shared_system_memory))}</td><td>${escapeHtml(value(gpu?.driver_version))}</td></tr>`;
    }).join('') : `<tr><td colspan="4">${escapeHtml(text('notDetected'))}</td></tr>`;
    const adapterSection = `<section class="hardware-overview-section"><div class="hardware-overview-section-heading"><h2 class="hardware-overview-section-title">${escapeHtml(text('adapters'))}</h2><span class="hardware-overview-section-note">${escapeHtml(t('home.gpuDisplayPage.adapterCount', { count: physicalAdapters.length }))}</span></div>${table([text('adapter'), text('videoMemory'), text('sharedMemory'), text('driver')], adapterRows)}</section>`;

    const displayRows = monitors.length ? monitors.map(monitor => {
      const configuration = displayConfig(monitor, configurations);
      const brand = value(monitor?.manufacturer, text('unknownVendor'));
      const model = value(monitor?.model, text('unknownDisplay'));
      return `<tr><td><span class="hardware-device-table-primary">${escapeHtml(model)}</span><span class="hardware-device-table-secondary">${escapeHtml(brand)}</span></td><td>${escapeHtml(diagonal(monitor))}</td><td>${escapeHtml(connection(monitor?.connection_code))}</td><td>${escapeHtml(resolution(configuration))}</td></tr>`;
    }).join('') : `<tr><td colspan="4">${escapeHtml(text('notDetected'))}</td></tr>`;
    const displaySection = `<section class="hardware-overview-section"><div class="hardware-overview-section-heading"><h2 class="hardware-overview-section-title">${escapeHtml(text('displays'))}</h2><span class="hardware-overview-section-note">${escapeHtml(t('home.gpuDisplayPage.displayCount', { count: monitors.length }))}</span></div>${table([text('manufacturerModel'), text('diagonal'), text('connection'), text('resolutionRefresh')], displayRows)}</section>`;
    const virtualSection = virtualGpus.length ? `<section class="hardware-overview-section"><div class="hardware-overview-section-heading"><h2 class="hardware-overview-section-title">${escapeHtml(text('virtualAdapters'))}</h2></div>${table([text('virtualAdapter'), text('driverVersion'), text('driverDate')], virtualGpus.map(gpu => `<tr><td>${escapeHtml(value(gpu?.name))}</td><td>${escapeHtml(value(gpu?.driver_version))}</td><td>${escapeHtml(value(gpu?.driver_date))}</td></tr>`).join(''))}</section>` : '';
    const statusSection = `<section class="hardware-overview-section"><div class="hardware-overview-section-heading"><h2 class="hardware-overview-section-title">${escapeHtml(text('status'))}</h2></div><div class="cpu-memory-status-list"><div class="cpu-memory-status-item is-good"><span class="cpu-memory-status-icon">✓</span><span>${escapeHtml(text('statusReadOnly'))}</span></div><div class="cpu-memory-status-item is-good"><span class="cpu-memory-status-icon">✓</span><span>${escapeHtml(text('statusDxgi'))}</span></div>${virtualGpus.length ? `<div class="cpu-memory-status-item is-neutral"><span class="cpu-memory-status-icon">i</span><span>${escapeHtml(text('statusVirtual'))}</span></div>` : ''}</div></section>`;
    content.innerHTML = `${primarySection}${adapterSection}${displaySection}${virtualSection}${statusSection}`;
  }

  return {
    toolId: 'hardware-gpu-display',
    prefix: 'hardwareGpuDisplay',
    command: 'get_gpu_display_info',
    text,
    render,
    updatedAt(date) {
      const time = new Intl.DateTimeFormat(getLang() === 'zh' ? 'zh-CN' : 'en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(date);
      return t('home.gpuDisplayPage.updated', { time });
    }
  };
}
