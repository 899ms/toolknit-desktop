import {
  COLOR_SPACE_SLIDER_CONFIG,
  fmtColorNumber,
  normalizeSliderValue,
} from './core.js';

function getSpaceConfig(space) {
  const config = COLOR_SPACE_SLIDER_CONFIG[space];
  if (!config) throw new RangeError(`Unsupported color space: ${space}`);
  return config;
}

/**
 * Keep converted channel values intact, even when they sit outside the range
 * covered by the visual slider. Invalid values fall back channel-by-channel.
 */
export function preserveColorSpaceValues(space, values, fallbackValues = {}) {
  const preserved = {};
  for (const channel of getSpaceConfig(space).channels) {
    const value = Number(values?.[channel.key]);
    const fallback = Number(fallbackValues?.[channel.key]);
    preserved[channel.key] = Number.isFinite(value)
      ? value
      : Number.isFinite(fallback)
        ? fallback
        : channel.min;
  }
  return preserved;
}

/**
 * Replace only the channel the user touched. Untouched converted channels are
 * deliberately not normalized so changing one control cannot silently alter
 * the represented color.
 */
export function replaceColorSpaceChannel(space, values, channelKey, rawValue, { normalize = true } = {}) {
  const config = getSpaceConfig(space);
  const channel = config.channels.find(entry => entry.key === channelKey);
  if (!channel) throw new RangeError(`Unsupported ${space} channel: ${channelKey}`);

  const numericValue = Number(rawValue);
  const value = normalize
    ? normalizeSliderValue(numericValue, channel)
    : Number.isFinite(numericValue)
      ? numericValue
      : null;
  if (value === null) return null;

  return {
    ...preserveColorSpaceValues(space, values),
    [channelKey]: value,
  };
}

export function parseColorNumberDraft(rawText) {
  const text = String(rawText ?? '').trim();
  if (text === '') return null;
  const value = Number(text);
  return Number.isFinite(value) ? value : null;
}

/**
 * Present the exact converted value while constraining only the visual slider
 * position to its editable track.
 */
export function getColorSliderPresentation(rawValue, config) {
  const numericValue = Number(rawValue);
  const value = Number.isFinite(numericValue) ? numericValue : config.min;
  const sliderValue = Math.max(config.min, Math.min(config.max, value));
  return {
    value,
    sliderValue,
    ratio: (sliderValue - config.min) / (config.max - config.min),
    isOutsideRange: value < config.min || value > config.max,
  };
}

/**
 * Step from the exact linked value instead of the slider handle position.
 * Values outside the visual track move toward the track without snapping to
 * an edge; movement farther outside remains blocked.
 */
export function stepColorValue(rawValue, direction, config, multiplier = 1) {
  const value = Number(rawValue);
  const sign = Math.sign(Number(direction));
  if (!Number.isFinite(value) || !sign) return null;

  const amount = Math.max(1, Math.abs(Number(multiplier) || 1));
  const next = value + sign * config.step * amount;
  if (value > config.max) return sign < 0 ? Math.max(config.max, next) : value;
  if (value < config.min) return sign > 0 ? Math.min(config.min, next) : value;
  return normalizeSliderValue(next, config);
}

/**
 * Bind an exact-value input without rewriting its draft on every keystroke.
 * Valid drafts update the color live; normalization and formatting happen only
 * when the user commits with change, blur, or Enter.
 */
export function bindColorNumberInput(input, {
  config,
  getCurrentValue,
  applyTransientValue,
  applyCommittedValue,
  stepValue,
}) {
  let editing = false;
  let dirty = false;
  let valueBeforeEditing = null;
  let suppressNextBlur = false;

  function beginEditing() {
    if (editing) return;
    editing = true;
    valueBeforeEditing = Number(getCurrentValue());
  }

  function writeFormatted(value) {
    input.value = fmtColorNumber(value, config.decimals);
  }

  function restoreValueBeforeEditing() {
    const current = Number(getCurrentValue());
    const value = Number.isFinite(valueBeforeEditing) ? valueBeforeEditing : current;
    editing = false;
    dirty = false;
    valueBeforeEditing = null;
    if (!Number.isFinite(value)) return false;
    // A linked value can legitimately sit outside the visual slider range.
    // Restoring an editing snapshot must therefore bypass slider normalization.
    applyTransientValue(value);
    writeFormatted(value);
    return true;
  }

  function finishEditing() {
    if (!editing) return false;

    if (!dirty) {
      editing = false;
      const current = Number(getCurrentValue());
      if (Number.isFinite(current)) writeFormatted(current);
      valueBeforeEditing = null;
      return false;
    }

    const draft = parseColorNumberDraft(input.value);
    if (draft === null) return restoreValueBeforeEditing();

    // Normalize only a valid value explicitly entered by the user. Never run
    // an exact model fallback through the slider's editable bounds.
    const value = normalizeSliderValue(draft, config);
    if (value === null) return restoreValueBeforeEditing();
    editing = false;
    dirty = false;
    valueBeforeEditing = null;
    applyCommittedValue(value);
    writeFormatted(value);
    return true;
  }

  input.addEventListener('focus', beginEditing);
  input.addEventListener('input', () => {
    beginEditing();
    dirty = true;
    const value = parseColorNumberDraft(input.value);
    if (value !== null) applyTransientValue(value);
  });
  input.addEventListener('change', finishEditing);
  input.addEventListener('blur', () => {
    if (suppressNextBlur) {
      suppressNextBlur = false;
      return;
    }
    finishEditing();
  });
  input.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
      event.preventDefault();
      finishEditing();
      stepValue(event.key === 'ArrowUp' ? 1 : -1);
    } else if (event.key === 'Enter') {
      event.preventDefault();
      finishEditing();
      suppressNextBlur = true;
      input.blur();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      restoreValueBeforeEditing();
      suppressNextBlur = true;
      input.blur();
    }
  });

  return {
    isEditing: () => editing,
    finishEditing,
    // Keep the original method name for callers that explicitly commit.
    commit: finishEditing,
  };
}
