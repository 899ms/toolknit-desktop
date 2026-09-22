import assert from 'node:assert/strict';
import { createColorWheels } from '../src/features/color-space-compare/wheel.js';
import {
  COLOR_SPACE_SLIDER_CONFIG,
  fmtColorNumber,
  getSpaceValues,
  spaceToXyz,
  xyzToAllSpaces,
  xyzToDisplayRgb,
} from '../src/features/color-space-compare/core.js';
import {
  bindColorNumberInput,
  getColorSliderPresentation,
  preserveColorSpaceValues,
  replaceColorSpaceChannel,
  stepColorValue,
} from '../src/features/color-space-compare/controls.js';

function approx(actual, expected, epsilon, message) {
  assert.ok(Math.abs(actual - expected) <= epsilon, `${message}: expected ${expected}, got ${actual}`);
}

function getConvertedValues(sourceSpace, sourceValues, targetSpace) {
  const xyz = spaceToXyz(sourceSpace, sourceValues);
  const displayRgb = xyzToDisplayRgb(xyz.x, xyz.y, xyz.z);
  return getSpaceValues(targetSpace, xyzToAllSpaces(xyz, displayRgb), displayRgb);
}

// Converted values are allowed to exceed another space's visual slider range.
// Editing one channel in that target space must retain every untouched value.
const convertedOklch = preserveColorSpaceValues(
  'oklch',
  getConvertedValues('oklab', { L: 0.5, a: 0.4, b: 0.4 }, 'oklch')
);
approx(convertedOklch.C, Math.hypot(0.4, 0.4), 1e-12, 'OKLab to OKLCH chroma');
assert.ok(
  convertedOklch.C > COLOR_SPACE_SLIDER_CONFIG.oklch.channels[1].max,
  'The true linked OKLCH chroma must remain above the editable slider range.'
);
const oklchChromaPresentation = getColorSliderPresentation(
  convertedOklch.C,
  COLOR_SPACE_SLIDER_CONFIG.oklch.channels[1]
);
approx(oklchChromaPresentation.value, convertedOklch.C, 1e-15, 'Displayed OKLCH C');
assert.equal(oklchChromaPresentation.sliderValue, 0.4, 'Only the OKLCH C handle is clamped.');
assert.equal(oklchChromaPresentation.ratio, 1);
assert.equal(oklchChromaPresentation.isOutsideRange, true);
const editedOklch = replaceColorSpaceChannel('oklch', convertedOklch, 'L', 0.6);
approx(editedOklch.C, convertedOklch.C, 1e-15, 'Editing OKLCH L must retain linked C');
assert.deepEqual(
  spaceToXyz('oklch', editedOklch),
  spaceToXyz('oklch', { ...convertedOklch, L: 0.6 }),
  'Continuing to edit OKLCH must not jump to a slider-clamped color.'
);

const convertedLab = preserveColorSpaceValues(
  'lab',
  getConvertedValues('lch', { L: 50, C: 200, H: 0 }, 'lab')
);
approx(convertedLab.a, 200, 1e-9, 'LCh D65 to Lab a');
assert.ok(
  convertedLab.a > COLOR_SPACE_SLIDER_CONFIG.lab.channels[1].max,
  'The true linked Lab a value must remain above the editable slider range.'
);
const labAPresentation = getColorSliderPresentation(
  convertedLab.a,
  COLOR_SPACE_SLIDER_CONFIG.lab.channels[1]
);
approx(labAPresentation.value, convertedLab.a, 1e-15, 'Displayed Lab a');
assert.equal(labAPresentation.sliderValue, 128, 'Only the Lab a handle is clamped.');
assert.equal(labAPresentation.ratio, 1);
assert.equal(labAPresentation.isOutsideRange, true);
approx(
  stepColorValue(convertedLab.a, -1, COLOR_SPACE_SLIDER_CONFIG.lab.channels[1]),
  199.9,
  1e-12,
  'Stepping down from out-of-range Lab a must not jump to the slider edge'
);
approx(
  stepColorValue(convertedOklch.C, -1, COLOR_SPACE_SLIDER_CONFIG.oklch.channels[1]),
  convertedOklch.C - 0.001,
  1e-12,
  'Stepping down from out-of-range OKLCH C must preserve the exact model value'
);
const steppedOklch = replaceColorSpaceChannel(
  'oklch',
  convertedOklch,
  'C',
  stepColorValue(convertedOklch.C, -1, COLOR_SPACE_SLIDER_CONFIG.oklch.channels[1]),
  { normalize: false }
);
approx(
  steppedOklch.C,
  convertedOklch.C - 0.001,
  1e-12,
  'The stepped exact value must not be normalized through the visual track'
);
approx(
  stepColorValue(convertedOklch.C, 1, COLOR_SPACE_SLIDER_CONFIG.oklch.channels[1]),
  convertedOklch.C,
  1e-15,
  'Stepping farther outside the editable range must be ignored'
);
const editedLab = replaceColorSpaceChannel('lab', convertedLab, 'L', 60);
approx(editedLab.a, convertedLab.a, 1e-15, 'Editing Lab L must retain linked a');
assert.deepEqual(
  spaceToXyz('lab', editedLab),
  spaceToXyz('lab', { ...convertedLab, L: 60 }),
  'Continuing to edit Lab must not jump to a slider-clamped color.'
);

class FakeInput {
  constructor(value = '') {
    this.value = value;
    this.listeners = new Map();
  }

  addEventListener(type, handler) {
    const handlers = this.listeners.get(type) ?? [];
    handlers.push(handler);
    this.listeners.set(type, handlers);
  }

  emit(type, event = {}) {
    const normalizedEvent = {
      key: '',
      preventDefault() {},
      stopPropagation() {},
      ...event,
    };
    for (const handler of this.listeners.get(type) ?? []) handler(normalizedEvent);
  }

  focus() {
    this.emit('focus');
  }

  blur() {
    this.emit('change');
    this.emit('blur');
  }
}

function createInputHarness(initialValue, config, initialText = String(initialValue)) {
  const input = new FakeInput(initialText);
  let modelValue = Number(initialValue);
  const transientValues = [];
  const committedValues = [];
  const controller = bindColorNumberInput(input, {
    config,
    getCurrentValue: () => modelValue,
    applyTransientValue: value => {
      modelValue = value;
      transientValues.push(value);
    },
    applyCommittedValue: value => {
      modelValue = value;
      committedValues.push(value);
    },
    stepValue: () => {},
  });
  return { input, controller, transientValues, committedValues, getValue: () => modelValue };
}

function typeDraft(harness, draft, expectedValue) {
  harness.input.value = draft;
  harness.input.emit('input');
  assert.equal(harness.input.value, draft, `Input draft ${JSON.stringify(draft)} must not be rewritten.`);
  if (expectedValue !== undefined) assert.equal(harness.getValue(), expectedValue);
}

const labAConfig = COLOR_SPACE_SLIDER_CONFIG.lab.channels[1];

const multiDigit = createInputHarness(0, labAConfig);
multiDigit.input.focus();
typeDraft(multiDigit, '1', 1);
assert.equal(multiDigit.controller.isEditing(), true);
typeDraft(multiDigit, '12', 12);
assert.equal(multiDigit.committedValues.length, 0, 'Typing digits must not commit or format early.');
multiDigit.input.emit('change');
assert.equal(multiDigit.input.value, '12.0');
assert.equal(multiDigit.committedValues.at(-1), 12);

const negative = createInputHarness(0, labAConfig);
negative.input.focus();
typeDraft(negative, '-', 0);
typeDraft(negative, '-2', -2);
typeDraft(negative, '-20.5', -20.5);
negative.input.emit('keydown', { key: 'Enter' });
assert.equal(negative.input.value, '-20.5');
assert.equal(negative.committedValues.at(-1), -20.5);

const decimal = createInputHarness(0, COLOR_SPACE_SLIDER_CONFIG.oklab.channels[0]);
decimal.input.focus();
typeDraft(decimal, '0', 0);
typeDraft(decimal, '0.', 0);
typeDraft(decimal, '0.4', 0.4);
decimal.input.emit('blur');
assert.equal(decimal.input.value, '0.400');
assert.equal(decimal.committedValues.at(-1), 0.4);

// Merely focusing and leaving a linked out-of-range value must not clamp it.
const linkedValue = createInputHarness(convertedOklch.C, COLOR_SPACE_SLIDER_CONFIG.oklch.channels[1]);
linkedValue.input.focus();
linkedValue.input.emit('blur');
approx(linkedValue.getValue(), convertedOklch.C, 1e-15, 'Untouched linked value');
assert.equal(linkedValue.committedValues.length, 0);

// Empty and invalid drafts restore the precise model snapshot from focus time.
// The formatted DOM text is intentionally rounded to prove it is not used as
// the restoration source.
const exactLinkedChroma = convertedOklch.C;
const linkedChromaConfig = COLOR_SPACE_SLIDER_CONFIG.oklch.channels[1];
const emptyLinkedValue = createInputHarness(exactLinkedChroma, linkedChromaConfig, '0.566');
emptyLinkedValue.input.focus();
typeDraft(emptyLinkedValue, '');
emptyLinkedValue.input.blur();
approx(emptyLinkedValue.getValue(), exactLinkedChroma, 1e-15, 'Empty linked draft restoration');
assert.equal(emptyLinkedValue.input.value, '0.566');
assert.equal(emptyLinkedValue.committedValues.length, 0);

const invalidLinkedValue = createInputHarness(exactLinkedChroma, linkedChromaConfig, '0.566');
invalidLinkedValue.input.focus();
typeDraft(invalidLinkedValue, '0.3', 0.3);
typeDraft(invalidLinkedValue, '-', 0.3);
invalidLinkedValue.input.blur();
approx(invalidLinkedValue.getValue(), exactLinkedChroma, 1e-15, 'Invalid linked draft restoration');
assert.equal(invalidLinkedValue.input.value, '0.566');
assert.equal(invalidLinkedValue.committedValues.length, 0);

const escapedLinkedValue = createInputHarness(exactLinkedChroma, linkedChromaConfig, '0.566');
escapedLinkedValue.input.focus();
typeDraft(escapedLinkedValue, '0.2', 0.2);
escapedLinkedValue.input.emit('keydown', { key: 'Escape' });
approx(escapedLinkedValue.getValue(), exactLinkedChroma, 1e-15, 'Escape linked draft restoration');
assert.equal(escapedLinkedValue.input.value, '0.566');
assert.equal(escapedLinkedValue.committedValues.length, 0);

// A valid user draft is still normalized only when committed.
const clampedCommit = createInputHarness(0.4, COLOR_SPACE_SLIDER_CONFIG.oklab.channels[0], '0.400');
clampedCommit.input.focus();
typeDraft(clampedCommit, '1.5', 1.5);
clampedCommit.input.emit('blur');
assert.equal(clampedCommit.getValue(), 1);
assert.equal(clampedCommit.input.value, '1.000');
assert.deepEqual(clampedCommit.committedValues, [1]);

function createSliderTakeoverHarness(initialValues) {
  const configs = Object.fromEntries(
    COLOR_SPACE_SLIDER_CONFIG.hsl.channels.map(config => [config.key, config])
  );
  let model = preserveColorSpaceValues('hsl', initialValues);
  const inputs = {
    h: new FakeInput(fmtColorNumber(model.h, configs.h.decimals)),
    s: new FakeInput(fmtColorNumber(model.s, configs.s.decimals)),
  };
  const controllers = {};
  const aria = {};
  let dragValues = null;

  function syncPresentation() {
    for (const key of ['h', 's']) {
      const presentation = getColorSliderPresentation(model[key], configs[key]);
      if (!controllers[key]?.isEditing()) {
        inputs[key].value = fmtColorNumber(presentation.value, configs[key].decimals);
      }
      aria[key] = {
        valueNow: presentation.sliderValue,
        valueText: `${fmtColorNumber(presentation.value, configs[key].decimals)}${configs[key].unit}`,
      };
    }
  }

  function applyInputValue(key, value, normalize) {
    model = replaceColorSpaceChannel('hsl', model, key, value, { normalize });
    syncPresentation();
  }

  for (const key of ['h', 's']) {
    controllers[key] = bindColorNumberInput(inputs[key], {
      config: configs[key],
      getCurrentValue: () => model[key],
      applyTransientValue: value => applyInputValue(key, value, false),
      applyCommittedValue: value => applyInputValue(key, value, true),
      stepValue: () => {},
    });
  }
  syncPresentation();

  return {
    inputs,
    controllers,
    aria,
    getModel: () => ({ ...model }),
    pointerDownSlider(key, value) {
      // Mirrors color-space-compare-ui.js: every active editor is finished
      // before the drag base values are captured and the slider takes over.
      for (const controller of Object.values(controllers)) controller.finishEditing();
      dragValues = { ...model };
      model = replaceColorSpaceChannel('hsl', dragValues, key, value);
      syncPresentation();
    },
    pointerUpSlider() {
      dragValues = null;
    },
  };
}

function assertSliderTakeover({ dirty, sliderKey }) {
  const harness = createSliderTakeoverHarness({ h: 30, s: 40, l: 50 });
  harness.inputs.h.focus();
  if (dirty) typeDraft({
    input: harness.inputs.h,
    getValue: () => harness.getModel().h,
  }, '12', 12);

  const sliderValue = sliderKey === 'h' ? 270 : 75;
  harness.pointerDownSlider(sliderKey, sliderValue);
  harness.pointerUpSlider();
  harness.inputs.h.blur();

  const model = harness.getModel();
  assert.equal(model[sliderKey], sliderValue, `${sliderKey} slider result must survive pointerup and blur.`);
  assert.equal(model.h, sliderKey === 'h' ? 270 : dirty ? 12 : 30);
  assert.equal(
    harness.inputs.h.value,
    fmtColorNumber(model.h, COLOR_SPACE_SLIDER_CONFIG.hsl.channels[0].decimals),
    'The formerly focused input must match the final model.'
  );
  assert.equal(harness.aria[sliderKey].valueNow, sliderValue);
  assert.equal(
    harness.aria[sliderKey].valueText,
    `${fmtColorNumber(sliderValue, COLOR_SPACE_SLIDER_CONFIG.hsl.channels[sliderKey === 'h' ? 0 : 1].decimals)}${COLOR_SPACE_SLIDER_CONFIG.hsl.channels[sliderKey === 'h' ? 0 : 1].unit}`
  );
}

assertSliderTakeover({ dirty: true, sliderKey: 'h' });
assertSliderTakeover({ dirty: false, sliderKey: 'h' });
assertSliderTakeover({ dirty: true, sliderKey: 's' });
assertSliderTakeover({ dirty: false, sliderKey: 's' });

// Exercise the actual wheel handlers alongside the numeric editor. This caught
// PR #67's stale draft replay; geometry-only tests cannot detect it.
class WheelElement extends FakeInput {
  constructor() {
    super();
    this.children = [];
    this.dataset = {};
    this.style = {};
    this.attributes = new Map();
    this.captures = new Set();
    this.classList = { toggle() {} };
  }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = children; }
  setAttribute(key, value) { this.attributes.set(key, value); }
  removeEventListener(type, handler) {
    this.listeners.set(type, (this.listeners.get(type) || []).filter(fn => fn !== handler));
  }
  getBoundingClientRect() { return { left: 0, top: 0, width: 100, height: 100 }; }
  setPointerCapture(id) { this.captures.add(id); }
  releasePointerCapture(id) { this.captures.delete(id); }
}

const savedGlobals = Object.fromEntries(['document', 'requestAnimationFrame', 'cancelAnimationFrame']
  .map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
try {
  const elements = [];
  const frames = new Map();
  let frameId = 0;
  globalThis.document = { createElement() { const el = new WheelElement(); elements.push(el); return el; } };
  globalThis.requestAnimationFrame = fn => { frames.set(++frameId, fn); return frameId; };
  globalThis.cancelAnimationFrame = id => frames.delete(id);
  const input = new FakeInput('30');
  let model = { h: 30, s: 40, v: 50 };
  let updates = 0;
  const editor = bindColorNumberInput(input, {
    config: COLOR_SPACE_SLIDER_CONFIG.hsv.channels[0],
    getCurrentValue: () => model.h,
    applyTransientValue: h => { model.h = h; },
    applyCommittedValue: h => { model.h = h; },
    stepValue() {},
  });
  const wheels = createColorWheels(new WheelElement(), {
    getValues: () => ({ ...model }),
    applyValues: (_, values) => { model = values; updates += 1; },
    getDisplayRgb: () => ({ r: 0, g: 0, b: 0 }),
    beforeInteraction: () => editor.finishEditing(),
  });
  const hit = elements.find(el => el.dataset.role === 'wheel-hit');
  const pointer = (type, x, y, id = 1) => hit.emit(type, {
    type, pointerId: id, pointerType: 'mouse', button: 0, clientX: x, clientY: y,
  });
  wheels.open();
  input.focus();
  input.value = '12';
  input.emit('input');
  pointer('pointerdown', 50, 95);
  pointer('pointerup', 50, 95);
  input.blur();
  assert.equal(model.h, 270, 'Blurring a numeric draft must not overwrite a wheel selection.');
  assert.equal(editor.isEditing(), false);

  pointer('pointerdown', 95, 50);
  const beforeMoves = updates;
  for (let i = 0; i < 100; i += 1) pointer('pointermove', 50, 5);
  assert.equal(updates, beforeMoves, 'High frequency moves must wait for one frame.');
  assert.equal(frames.size, 1);
  pointer('pointerup', 50, 5);
  assert.equal(model.h, 90, 'Pointer up must flush the last pending pick.');
  assert.equal(updates, beforeMoves + 1);
  assert.equal(frames.size, 0);
  assert.equal(hit.captures.size, 0);

  model.h = 359;
  hit.emit('keydown', { key: 'ArrowRight' });
  assert.equal(model.h, 4, 'Keyboard hue wraps around the ring.');
  pointer('pointerdown', 50, 95);
  pointer('pointermove', 5, 50);
  pointer('pointercancel', 5, 50);
  assert.equal(frames.size, 0);
  assert.equal(model.h, 270, 'Cancellation must discard pending moves.');
  assert.equal(hit.captures.size, 0);

  pointer('pointerdown', 95, 50);
  pointer('pointermove', 50, 5);
  wheels.close();
  assert.equal(frames.size, 0);
  assert.equal(hit.captures.size, 0);
  const afterClose = updates;
  pointer('pointerdown', 50, 95);
  assert.equal(updates, afterClose, 'Hidden wheels must ignore input.');
  wheels.open();
  pointer('pointerdown', 50, 95);
  assert.equal(updates, afterClose + 1, 'Reopening must retain a single working listener.');
  wheels.destroy();
  wheels.destroy();
  assert.ok(elements.every(el => [...el.listeners.values()].every(list => list.length === 0)));
} finally {
  for (const [key, descriptor] of Object.entries(savedGlobals)) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else delete globalThis[key];
  }
}

console.log('Color space compare runtime regression checks passed');
