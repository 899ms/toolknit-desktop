import { parseAiTableNumber } from '../../ai-table-core.js';
import { t } from '../../i18n.js';

const SERIES = Object.freeze([
  Object.freeze({ dark: '#1f1f1f', light: '#5f5f5f' }),
  Object.freeze({ dark: '#525252', light: '#9a9a9a' }),
  Object.freeze({ dark: '#7a7a7a', light: '#b8b8b8' }),
  Object.freeze({ dark: '#9c9c9c', light: '#d4d4d4' })
]);
const SLICES = Object.freeze([
  '#262626', '#454545', '#636363', '#828282',
  '#a0a0a0', '#bdbdbd', '#383838', '#d6d6d6'
]);

function fontFamily() {
  const rootStyle = getComputedStyle(document.documentElement);
  const latin = rootStyle.getPropertyValue('--tk-font-ui-en').trim() || "'ToolKnitBuiltinEn'";
  const chinese = rootStyle.getPropertyValue('--tk-font-ui-cn').trim() || "'ToolKnitBuiltinCn'";
  return `${latin}, ${chinese}, sans-serif`;
}

function formatNumber(value) {
  const number = typeof value === 'number' ? value : Number.parseFloat(value);
  if (Number.isNaN(number)) return '';
  if (Math.abs(number) >= 1000) return number.toLocaleString('en-US', { maximumFractionDigits: 1 });
  return Number.isInteger(number) ? String(number) : number.toFixed(1);
}

function hexToRgba(hex, alpha) {
  const value = hex.replace('#', '');
  const red = Number.parseInt(value.slice(0, 2), 16);
  const green = Number.parseInt(value.slice(2, 4), 16);
  const blue = Number.parseInt(value.slice(4, 6), 16);
  return `rgba(${red},${green},${blue},${alpha})`;
}

function verticalGradient(chart, from, to) {
  const area = chart.chartArea;
  if (!area) return from;
  const gradient = chart.ctx.createLinearGradient(0, area.top, 0, area.bottom);
  gradient.addColorStop(0, from);
  gradient.addColorStop(1, to);
  return gradient;
}

const backgroundPlugin = {
  id: 'aiTableWhiteBg',
  beforeDraw(chart) {
    const context = chart.ctx;
    context.save();
    context.globalCompositeOperation = 'destination-over';
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, chart.width, chart.height);
    context.restore();
  }
};

const valueLabelPlugin = {
  id: 'aiTableValueLabels',
  afterDatasetsDraw(chart) {
    if (!['bar', 'line'].includes(chart.config.type)) return;
    const context = chart.ctx;
    context.save();
    context.font = `600 11px ${fontFamily()}`;
    context.fillStyle = '#4d4d4d';
    context.textAlign = 'center';
    context.textBaseline = 'bottom';
    chart.data.datasets.forEach((dataset, datasetIndex) => {
      const meta = chart.getDatasetMeta(datasetIndex);
      if (meta.hidden || meta.data.length > 14) return;
      meta.data.forEach((element, index) => {
        const text = formatNumber(dataset.data[index]);
        if (text) context.fillText(text, element.x, element.y - 6);
      });
    });
    context.restore();
  }
};

const doughnutPlugin = {
  id: 'aiTableDoughnut',
  afterDatasetsDraw(chart) {
    if (chart.config.type !== 'doughnut') return;
    const context = chart.ctx;
    const meta = chart.getDatasetMeta(0);
    const dataset = chart.data.datasets[0];
    const total = dataset.data.reduce((sum, value) => sum + (Number.parseFloat(value) || 0), 0) || 1;
    context.save();
    context.textAlign = 'center';
    context.textBaseline = 'middle';
    meta.data.forEach((arc, index) => {
      const percentage = (Number.parseFloat(dataset.data[index]) || 0) / total;
      if (percentage < 0.05) return;
      const angle = (arc.startAngle + arc.endAngle) / 2;
      const radius = (arc.innerRadius + arc.outerRadius) / 2;
      context.font = `700 11px ${fontFamily()}`;
      context.fillStyle = index % SLICES.length < 4 ? '#ffffff' : '#1f1f1f';
      context.fillText(
        `${Math.round(percentage * 100)}%`,
        arc.x + Math.cos(angle) * radius,
        arc.y + Math.sin(angle) * radius
      );
    });
    const firstArc = meta.data[0];
    if (firstArc) {
      context.fillStyle = '#9a9a9a';
      context.font = `600 11px ${fontFamily()}`;
      context.fillText(t('home.aiTable.total'), firstArc.x, firstArc.y - 11);
      context.fillStyle = '#1f1f1f';
      context.font = `700 18px ${fontFamily()}`;
      context.fillText(formatNumber(total), firstArc.x, firstArc.y + 9);
    }
    context.restore();
  }
};

function createChartConfig(chartDefinition, data) {
  const labelColumn = chartDefinition.labelColumn || 0;
  const valueColumns = chartDefinition.valueColumns?.length ? chartDefinition.valueColumns : [1];
  const labels = data.rows.map(row => String(row[labelColumn] ?? ''));
  const family = fontFamily();
  const tickFont = { family, size: 11, weight: 400 };
  const legendFont = { family, size: 12, weight: 400 };

  if (chartDefinition.type === 'pie') {
    return {
      type: 'doughnut',
      data: {
        labels,
        datasets: [{
          data: data.rows.map(row => parseAiTableNumber(row[valueColumns[0]]) ?? 0),
          backgroundColor: labels.map((_, index) => SLICES[index % SLICES.length]),
          borderColor: '#ffffff',
          borderWidth: 3,
          hoverOffset: 6,
          spacing: 2
        }]
      },
      options: {
        responsive: false,
        animation: false,
        devicePixelRatio: 2,
        cutout: '60%',
        radius: '88%',
        layout: { padding: { top: 12, right: 12, bottom: 12, left: 12 } },
        plugins: {
          legend: {
            position: 'right',
            labels: {
              color: '#404040', font: legendFont, usePointStyle: true,
              pointStyle: 'circle', boxWidth: 8, padding: 14
            }
          },
          tooltip: { enabled: false }
        }
      },
      plugins: [backgroundPlugin, doughnutPlugin]
    };
  }

  const isLine = chartDefinition.type === 'line';
  const datasets = valueColumns.map((columnIndex, seriesIndex) => {
    const seriesData = data.rows.map(row => parseAiTableNumber(row[columnIndex]));
    const series = SERIES[seriesIndex % SERIES.length];
    if (isLine) {
      return {
        label: data.columns[columnIndex]?.label || '',
        data: seriesData,
        borderColor: series.dark,
        borderWidth: 2.5,
        tension: 0.4,
        fill: true,
        backgroundColor(context) {
          const area = context.chart.chartArea;
          if (!area) return 'rgba(0,0,0,0)';
          const gradient = context.chart.ctx.createLinearGradient(0, area.top, 0, area.bottom);
          gradient.addColorStop(0, hexToRgba(series.dark, 0.20));
          gradient.addColorStop(1, 'rgba(255,255,255,0)');
          return gradient;
        },
        pointRadius: seriesData.length > 14 ? 0 : 4,
        pointBackgroundColor: '#ffffff',
        pointBorderColor: series.dark,
        pointBorderWidth: 2,
        pointHoverRadius: 6
      };
    }
    return {
      label: data.columns[columnIndex]?.label || '',
      data: seriesData,
      backgroundColor: context => verticalGradient(context.chart, series.dark, series.light),
      borderRadius: 6,
      borderSkipped: false,
      maxBarThickness: 52,
      categoryPercentage: 0.68,
      barPercentage: 0.86
    };
  });

  return {
    type: isLine ? 'line' : 'bar',
    data: { labels, datasets },
    options: {
      responsive: false,
      animation: false,
      devicePixelRatio: 2,
      layout: { padding: { top: 26, right: 16, bottom: 6, left: 6 } },
      plugins: {
        legend: {
          display: datasets.length > 1,
          align: 'end',
          labels: {
            color: '#404040', font: legendFont, usePointStyle: true,
            pointStyle: 'circle', boxWidth: 8, padding: 16
          }
        },
        tooltip: { enabled: false }
      },
      scales: {
        x: {
          grid: { display: false },
          border: { display: false },
          ticks: {
            color: '#6b6b6b', font: tickFont, maxRotation: 0,
            autoSkip: true, padding: 6
          }
        },
        y: {
          beginAtZero: true,
          grid: { color: 'rgba(0,0,0,0.05)' },
          border: { display: false, dash: [3, 3] },
          ticks: {
            color: '#a0a0a0', font: tickFont, padding: 8,
            maxTicksLimit: 6, callback: value => formatNumber(value)
          }
        }
      }
    },
    plugins: [backgroundPlugin, valueLabelPlugin]
  };
}

export function createAiTableChartRenderer() {
  let revision = 0;
  let entries = [];
  let readyPromise = Promise.resolve([]);

  function reset() {
    revision += 1;
    for (const entry of entries) {
      try { entry.instance?.destroy(); } catch { /* Continue destroying remaining charts. */ }
    }
    entries = [];
    readyPromise = Promise.resolve([]);
    return revision;
  }

  async function render(canvas, chartDefinition, data, ownerRevision) {
    let Chart;
    try {
      Chart = (await import('chart.js/auto')).default;
    } catch (error) {
      throw new Error('Chart.js could not be loaded.', { cause: error });
    }
    if (ownerRevision !== revision) return false;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Chart canvas context is unavailable.');
    const instance = new Chart(context, createChartConfig(chartDefinition, data));
    if (ownerRevision !== revision) {
      instance.destroy();
      return false;
    }
    entries.push({ canvas, instance, chartDef: chartDefinition });
    return true;
  }

  function track(jobs) {
    readyPromise = Promise.all(jobs);
    return readyPromise;
  }

  return {
    dispose: reset,
    getEntries: () => [...entries],
    get revision() { return revision; },
    ready: () => readyPromise,
    render,
    reset,
    track
  };
}
