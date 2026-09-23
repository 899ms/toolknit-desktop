import assert from 'node:assert/strict';
import { BMI_INPUT_LIMITS, calculateBmi, classifyBmi, classifyBodyFat } from '../src/features/bmi-calculator/core.js';

assert.equal(classifyBmi(17).level, 'low');
assert.equal(classifyBmi(22).level, 'normal');
assert.equal(classifyBmi(26).level, 'high');
assert.equal(classifyBmi(30).level, 'veryhigh');
assert.equal(classifyBodyFat(15, 'male').level, 'normal');
assert.equal(classifyBodyFat(25, 'female').level, 'normal');
const result = calculateBmi({ age: 25, height: 170, weight: 65, gender: 'male', mode: 'simple' });
assert.ok(result);
assert.equal(result.bmi.toFixed(1), '22.5');
assert.ok(result.bodyFat > 0);
assert.ok(result.bmr > 0);
assert.equal(result.idealWeight.toFixed(1), '63.6');
assert.equal(calculateBmi({ height: '', weight: 65 }), null);
assert.equal(BMI_INPUT_LIMITS.height.default, 170);

const female = { age: 25, height: 170, weight: 65, gender: 'female', mode: 'advanced', waist: 80, neck: 34, hip: 95 };
const advanced = calculateBmi(female);
const expected = 495 / (1.29579 - 0.35004 * Math.log10(80 + 95 - 34) + 0.221 * Math.log10(170)) - 450;
assert.ok(Math.abs(advanced.bodyFat - expected) < 1e-10);
for (const [field, direction] of [['waist', 1], ['neck', -1], ['hip', 1]]) {
  const changed = calculateBmi({ ...female, [field]: female[field] + 5 });
  assert.ok((changed.bodyFat - advanced.bodyFat) * direction > 0, `${field} changes advanced body fat`);
  assert.notEqual(changed.fatMass, advanced.fatMass);
  assert.notEqual(changed.leanMass, advanced.leanMass);
  for (const key of ['bmi', 'bmr', 'idealWeight']) assert.equal(changed[key], advanced[key], `${key} does not use circumference`);
  assert.ok(Math.abs(changed.fatMass + changed.leanMass - female.weight) < 1e-10);
}
const screenshot = calculateBmi({ ...female, waist: 35, neck: 40, hip: 32 });
assert.equal(screenshot.bodyFatError, 'invalid_measurements');
for (const key of ['bodyFat', 'bodyFatInfo', 'fatMass', 'leanMass', 'barPercent']) assert.equal(screenshot[key], null);
assert.equal(screenshot.bmi, advanced.bmi);
assert.equal(calculateBmi({ ...female, mode: 'simple', waist: 35, neck: 40, hip: 32 }).bodyFat.toFixed(1), '27.3');
for (const field of ['waist', 'neck', 'hip']) {
  assert.equal(calculateBmi({ ...female, [field]: '' }).bodyFatError, 'missing_measurements');
  assert.equal(calculateBmi({ ...female, [field]: undefined }).bodyFatError, 'missing_measurements');
  for (const value of [0, -1, 999, NaN, Infinity, '80oops']) {
    assert.equal(calculateBmi({ ...female, [field]: value }).bodyFatError, 'invalid_measurements');
  }
}
const male = { ...female, gender: 'male', waist: 80, neck: 38, hip: '' };
assert.ok(Number.isFinite(calculateBmi(male).bodyFat), 'male formula does not require hips');
assert.equal(calculateBmi({ ...male, hip: 200 }).bodyFat, calculateBmi(male).bodyFat);
assert.equal(calculateBmi({ ...male, waist: 35, neck: 40 }).bodyFatError, 'invalid_measurements');
console.log('BMI calculator core regression checks passed');
