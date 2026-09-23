import assert from 'node:assert/strict';
import {
  createBackgroundFrameLimiter,
  isConstrainedAnimationDevice
} from '../src/shared/animation-policy.js';

const capableWindow = { matchMedia: () => ({ matches: false }) };
const capableNavigator = { hardwareConcurrency: 8, deviceMemory: 16, connection: { saveData: false } };
assert.equal(isConstrainedAnimationDevice({ windowRef: capableWindow, navigatorRef: capableNavigator }), false);
const capable = createBackgroundFrameLimiter({ windowRef: capableWindow, navigatorRef: capableNavigator });
assert.equal(capable.interval, 0);
assert.equal(capable.shouldRender(0), true);
assert.equal(capable.shouldRender(1), true);

const constrainedNavigator = { hardwareConcurrency: 2, deviceMemory: 2, connection: { saveData: false } };
assert.equal(isConstrainedAnimationDevice({ windowRef: capableWindow, navigatorRef: constrainedNavigator }), true);
const constrained = createBackgroundFrameLimiter({
  windowRef: capableWindow,
  navigatorRef: constrainedNavigator,
  lowPowerFps: 30
});
assert.equal(constrained.interval, 1000 / 30);
assert.equal(constrained.shouldRender(0), true);
assert.equal(constrained.shouldRender(10), false);
assert.equal(constrained.shouldRender(34), true);
constrained.reset();
assert.equal(constrained.shouldRender(35), true);

console.log('Animation policy contracts passed');
