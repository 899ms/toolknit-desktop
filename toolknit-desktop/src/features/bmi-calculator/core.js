export const BMI_INPUT_LIMITS = Object.freeze({
  age: Object.freeze({ min: 1, max: 120, default: 25 }),
  height: Object.freeze({ min: 50, max: 250, default: 170 }),
  weight: Object.freeze({ min: 10, max: 300, default: 65 }),
  waist: Object.freeze({ min: 30, max: 200, default: 80 }),
  neck: Object.freeze({ min: 20, max: 100, default: 38 }),
  hip: Object.freeze({ min: 30, max: 200, default: 90 })
});

function finiteNumber(value) {
  const number = typeof value === 'number' ? value : Number.parseFloat(value);
  return Number.isFinite(number) ? number : 0;
}

export function clampBmiInput(value, field) {
  if (value === null || value === undefined || (typeof value === 'string' && !value.trim())) return 0;
  const limits = BMI_INPUT_LIMITS[field];
  if (!limits) return finiteNumber(value);
  return Math.min(limits.max, Math.max(limits.min, finiteNumber(value)));
}

export function classifyBmi(bmi) {
  if (bmi < 18.5) return { level: 'low' };
  if (bmi < 24) return { level: 'normal' };
  if (bmi < 28) return { level: 'high' };
  return { level: 'veryhigh' };
}

export function classifyBodyFat(bodyFat, gender = 'male') {
  if (gender === 'male') {
    if (bodyFat < 10) return { level: 'low' };
    if (bodyFat < 20) return { level: 'normal' };
    if (bodyFat < 25) return { level: 'high' };
    return { level: 'veryhigh' };
  }
  if (bodyFat < 18) return { level: 'low' };
  if (bodyFat < 28) return { level: 'normal' };
  if (bodyFat < 35) return { level: 'high' };
  return { level: 'veryhigh' };
}

export function calculateBmi({
  age,
  height,
  weight,
  waist,
  neck,
  hip,
  gender = 'male',
  mode = 'simple'
} = {}) {
  const safeAge = clampBmiInput(age, 'age');
  const safeHeight = clampBmiInput(height, 'height');
  const safeWeight = clampBmiInput(weight, 'weight');
  if (!safeHeight || !safeWeight) return null;

  const isMale = gender === 'male';
  const heightM = safeHeight / 100;
  const bmi = safeWeight / (heightM * heightM);
  let bodyFat = 0;

  if (mode === 'advanced') {
    const safeWaist = clampBmiInput(waist, 'waist');
    const safeNeck = clampBmiInput(neck, 'neck');
    const safeHip = clampBmiInput(hip, 'hip');
    if (safeWaist && safeNeck && safeHeight) {
      if (isMale && safeWaist > safeNeck) {
        const logVal = Math.log10(safeWaist - safeNeck);
        bodyFat = 495 / (1.0324 - 0.19077 * logVal + 0.15456 * Math.log10(safeHeight)) - 450;
      } else if (!isMale && safeHip && safeWaist + safeHip > safeNeck) {
        const logVal = Math.log10(safeWaist + safeHip - safeNeck);
        bodyFat = 495 / (1.29579 - 0.35004 * logVal + 0.22100 * Math.log10(safeHeight)) - 450;
      }
    }
  }
  if (!bodyFat || !Number.isFinite(bodyFat) || bodyFat < 0) {
    bodyFat = 1.20 * bmi + 0.23 * (safeAge || 25) - 10.8 * (isMale ? 1 : 0) - 5.4;
  }
  bodyFat = Math.max(0, bodyFat);

  const bmr = isMale
    ? 10 * safeWeight + 6.25 * safeHeight - 5 * (safeAge || 25) + 5
    : 10 * safeWeight + 6.25 * safeHeight - 5 * (safeAge || 25) - 161;
  const idealWeight = heightM * heightM * 22;
  const weightDiff = safeWeight - idealWeight;
  const fatMass = safeWeight * bodyFat / 100;
  const leanMass = safeWeight - fatMass;

  return {
    bmi,
    bmiInfo: classifyBmi(bmi),
    bodyFat,
    bodyFatInfo: classifyBodyFat(bodyFat, gender),
    bmr,
    idealWeight,
    weightDiff,
    fatMass,
    leanMass,
    barPercent: Math.min(100, Math.max(0, (bodyFat / 40) * 100))
  };
}
