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
console.log('BMI calculator core regression checks passed');
