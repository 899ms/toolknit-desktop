import assert from 'node:assert/strict';
import { bindHorizontalWheel } from '../src/shared/horizontal-wheel.js';

const listeners = new Map();
const frames = new Map();
let sequence = 0;
let enabled = true;
const stage = {
  scrollLeft: 0, scrollWidth: 1400, clientWidth: 400,
  addEventListener: (type, listener, options) => {
    assert.equal(options.passive, false);
    listeners.set(type, listener);
  },
  removeEventListener: type => listeners.delete(type)
};
const dispose = bindHorizontalWheel(stage, {
  enabled: () => enabled,
  requestFrame: callback => { frames.set(++sequence, callback); return sequence; },
  cancelFrame: id => frames.delete(id)
});
const flush = () => { const pending = [...frames.values()]; frames.clear(); pending.forEach(callback => callback()); };
function wheel(values = {}) {
  const event = { deltaY: 100, deltaX: 0, deltaMode: 0, prevented: false,
    preventDefault() { this.prevented = true; }, ...values };
  listeners.get('wheel')?.(event);
  return event;
}

assert.equal(wheel().prevented, true);
wheel();
assert.equal(frames.size, 1, 'coalesce multiple wheel events into one frame');
assert.equal(stage.scrollLeft, 0);
flush();
assert.equal(stage.scrollLeft, 200);
wheel({ deltaY: 2, deltaMode: 1 }); flush();
assert.equal(stage.scrollLeft, 232);
wheel({ deltaY: 1, deltaMode: 2 }); flush();
assert.equal(stage.scrollLeft, 632);
wheel({ deltaY: 2, deltaX: -50 }); flush();
assert.equal(stage.scrollLeft, 582, 'trackpad horizontal input keeps its direction');
assert.equal(wheel({ ctrlKey: true }).prevented, false, 'do not hijack zoom');
assert.equal(wheel({ target: { closest: () => ({}) } }).prevented, false, 'do not hijack form controls');
enabled = false;
assert.equal(wheel().prevented, false);
enabled = true;
wheel({ deltaY: 5000 }); flush();
assert.equal(stage.scrollLeft, 1000);
wheel({ deltaY: -5000 }); flush();
assert.equal(stage.scrollLeft, 0);
stage.scrollWidth = stage.clientWidth;
assert.equal(wheel().prevented, false, 'preserve native scrolling without horizontal overflow');
stage.scrollWidth = 1400;
wheel();
dispose(); dispose();
assert.equal(listeners.size, 0);
assert.equal(frames.size, 0, 'cancel pending writes on close');
flush();
assert.equal(stage.scrollLeft, 0);
console.log('Horizontal wheel input, bounds, RAF and cleanup checks passed');
