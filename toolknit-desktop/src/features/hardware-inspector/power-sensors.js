import { createHardwareRenderHelpers } from './core.js';

export function createPowerSensorsDefinition({ t, getLang }) {
  const { escapeHtml, hardwareOverviewSection, hardwareReadableText } = createHardwareRenderHelpers({ t, getLang });
  const text = key => t(`home.powerSensorsPage.${key}`);
  const value = input => hardwareReadableText(input, text('unavailable'));

  function number(input, options = {}) {
    const amount = Number(input);
    if (!Number.isFinite(amount)) return text('unavailable');
    return new Intl.NumberFormat(getLang() === 'zh' ? 'zh-CN' : 'en-US', options).format(amount);
  }

  function percent(input) {
    const amount = Number(input);
    if (!Number.isFinite(amount) || amount < 0) return text('unavailable');
    return `${number(Math.round(amount))}%`;
  }

  function temperature(input) {
    const amount = Number(input);
    if (!Number.isFinite(amount) || amount < -50 || amount > 150) return text('unavailable');
    return `${number(amount, { maximumFractionDigits: 1 })} °C`;
  }

  function capacity(input) {
    const amount = Number(input);
    if (!Number.isFinite(amount) || amount <= 0) return text('unavailable');
    return t('home.powerSensorsPage.mwh', { value: number(amount) });
  }

  function runtime(input) {
    const minutes = Number(input);
    if (!Number.isFinite(minutes) || minutes <= 0) return text('unavailable');
    return t('home.powerSensorsPage.minutes', { count: number(minutes) });
  }

  function rpm(input) {
    const amount = Number(input);
    if (!Number.isFinite(amount) || amount <= 0) return text('unavailable');
    return t('home.powerSensorsPage.rpm', { value: number(amount) });
  }

  function boolean(input) {
    if (input === true) return text('yes');
    if (input === false) return text('no');
    return text('unavailable');
  }

  function field(label, input) {
    return `<div class="hardware-overview-field"><span class="hardware-overview-key">${escapeHtml(label)}</span><span class="hardware-overview-value">${escapeHtml(value(input))}</span></div>`;
  }

  function batteryStatus(input) {
    const statuses = {
      other: 'other', unknown: 'unknown', fully_charged: 'fullyCharged', low: 'low', critical: 'critical',
      charging: 'charging', charging_high: 'chargingHigh', charging_low: 'chargingLow',
      charging_critical: 'chargingCritical', undefined: 'undefined', partially_charged: 'partiallyCharged'
    };
    return text(statuses[String(input || '').toLowerCase()] || 'unknown');
  }

  function table(headers, rows, className = '') {
    return `<div class="hardware-device-table-wrap"><table class="hardware-device-table hardware-sensor-table ${escapeHtml(className)}"><thead><tr>${headers.map(header => `<th>${escapeHtml(header)}</th>`).join('')}</tr></thead><tbody>${rows}</tbody></table></div>`;
  }

  function render(content, data) {
    const powerPlan = data?.power_plan || {};
    const batteries = Array.isArray(data?.batteries) ? data.batteries : [];
    const thermalZones = Array.isArray(data?.thermal_zones) ? data.thermal_zones : [];
    const fans = Array.isArray(data?.fans) ? data.fans : [];
    const planSection = hardwareOverviewSection(text('powerPlan'), [
      field(text('planName'), powerPlan.name),
      field(text('planCaption'), powerPlan.caption),
      field(text('planState'), powerPlan.active ? text('activePlan') : text('unavailable'))
    ], text('localReadOnly'));

    const batteryRows = batteries.length ? batteries.map((battery, index) => `<tr><td><span class="hardware-device-table-primary">${escapeHtml(value(battery?.name))}</span><span class="hardware-device-table-secondary">${escapeHtml(t('home.powerSensorsPage.batteryIndex', { number: index + 1 }))}</span></td><td>${escapeHtml(percent(battery?.charge_percent))}</td><td>${escapeHtml(batteryStatus(battery?.status))}</td><td>${escapeHtml(runtime(battery?.estimated_run_time_min))}</td><td>${escapeHtml(capacity(battery?.design_capacity_mwh))}</td><td>${escapeHtml(capacity(battery?.full_charge_capacity_mwh))}</td><td>${escapeHtml(percent(battery?.health_percent))}</td></tr>`).join('') : `<tr><td colspan="7">${escapeHtml(text('notDetected'))}</td></tr>`;
    const batterySection = `<section class="hardware-overview-section"><div class="hardware-overview-section-heading"><h2 class="hardware-overview-section-title">${escapeHtml(text('battery'))}</h2><span class="hardware-overview-section-note">${escapeHtml(t('home.powerSensorsPage.batteryCount', { count: batteries.length }))}</span></div>${table([text('batteryName'), text('charge'), text('batteryStatus'), text('runtime'), text('designCapacity'), text('fullCapacity'), text('batteryHealth')], batteryRows, 'hardware-battery-table')}</section>`;

    const thermalRows = thermalZones.length ? thermalZones.map((zone, index) => `<tr><td><span class="hardware-device-table-primary">${escapeHtml(t('home.powerSensorsPage.zoneIndex', { number: index + 1 }))}</span><span class="hardware-device-table-secondary">${escapeHtml(value(zone?.name))}</span></td><td>${escapeHtml(zone?.source === 'acpi' ? text('acpiSource') : value(zone?.source))}</td><td>${escapeHtml(temperature(zone?.current_c))}</td><td>${escapeHtml(temperature(zone?.critical_c))}</td><td>${escapeHtml(temperature(zone?.passive_c))}</td></tr>`).join('') : `<tr><td colspan="5">${escapeHtml(text('notDetected'))}</td></tr>`;
    const thermalSection = `<section class="hardware-overview-section"><div class="hardware-overview-section-heading"><h2 class="hardware-overview-section-title">${escapeHtml(text('thermalZones'))}</h2><span class="hardware-overview-section-note">${escapeHtml(t('home.powerSensorsPage.zoneCount', { count: thermalZones.length }))}</span></div>${table([text('zone'), text('source'), text('currentTemperature'), text('criticalTemperature'), text('passiveTemperature')], thermalRows)}</section>`;

    const fanRows = fans.length ? fans.map(fan => `<tr><td><span class="hardware-device-table-primary">${escapeHtml(value(fan?.name))}</span></td><td>${escapeHtml(value(fan?.status))}</td><td>${escapeHtml(rpm(fan?.desired_speed_rpm))}</td><td>${escapeHtml(boolean(fan?.active_cooling))}</td></tr>`).join('') : `<tr><td colspan="4">${escapeHtml(text('notDetected'))}</td></tr>`;
    const fanSection = `<section class="hardware-overview-section"><div class="hardware-overview-section-heading"><h2 class="hardware-overview-section-title">${escapeHtml(text('fans'))}</h2><span class="hardware-overview-section-note">${escapeHtml(t('home.powerSensorsPage.fanCount', { count: fans.length }))}</span></div>${table([text('fan'), text('fanStatus'), text('desiredSpeed'), text('activeCooling')], fanRows)}</section>`;

    const healthValues = batteries.map(battery => Number(battery?.health_percent)).filter(amount => Number.isFinite(amount));
    const hasWeakBattery = healthValues.some(amount => amount > 0 && amount < 70);
    const statusItems = [['is-good', '✓', text('statusReadOnly')]];
    if (batteries.length) {
      statusItems.push([
        hasWeakBattery ? 'is-attention' : healthValues.length ? 'is-good' : 'is-neutral',
        hasWeakBattery ? '!' : healthValues.length ? '✓' : 'i',
        hasWeakBattery ? text('statusBatteryAttention') : healthValues.length ? text('statusBatteryHealthy') : text('statusBatteryUnknown')
      ]);
    } else {
      statusItems.push(['is-neutral', 'i', text('statusNoBattery')]);
    }
    statusItems.push(['is-neutral', 'i', text('statusThermal')]);
    if (!fans.length) statusItems.push(['is-neutral', 'i', text('statusNoFans')]);
    const statusSection = `<section class="hardware-overview-section"><div class="hardware-overview-section-heading"><h2 class="hardware-overview-section-title">${escapeHtml(text('status'))}</h2></div><div class="cpu-memory-status-list">${statusItems.map(([kind, icon, label]) => `<div class="cpu-memory-status-item ${kind}"><span class="cpu-memory-status-icon">${icon}</span><span>${escapeHtml(label)}</span></div>`).join('')}</div></section>`;
    content.innerHTML = `${planSection}${batterySection}${thermalSection}${fanSection}${statusSection}`;
  }

  return {
    toolId: 'hardware-power-sensors',
    prefix: 'hardwarePowerSensors',
    command: 'get_power_sensors_info',
    text,
    render,
    updatedAt(date) {
      const time = new Intl.DateTimeFormat(getLang() === 'zh' ? 'zh-CN' : 'en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(date);
      return t('home.powerSensorsPage.updated', { time });
    }
  };
}
