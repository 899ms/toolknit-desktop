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
  let bodyFat = null;
  let bodyFatError = null;

  if (mode === 'advanced') {
    const measurements = isMale ? { waist, neck } : { waist, neck, hip };
    if (Object.values(measurements).some(value => value == null || String(value).trim() === '')) {
      bodyFatError = 'missing_measurements';
    } else if (Object.entries(measurements).some(([field, value]) => {
      const number = Number(value);
      return !Number.isFinite(number) || number < BMI_INPUT_LIMITS[field].min || number > BMI_INPUT_LIMITS[field].max;
    })) {
      bodyFatError = 'invalid_measurements';
    } else {
      const circumference = Number(waist) - Number(neck) + (isMale ? 0 : Number(hip));
      const density = circumference > 0 ? (isMale
        ? 1.0324 - 0.19077 * Math.log10(circumference) + 0.15456 * Math.log10(safeHeight)
        : 1.29579 - 0.35004 * Math.log10(circumference) + 0.22100 * Math.log10(safeHeight)) : NaN;
      const estimate = density > 0 ? 495 / density - 450 : NaN;
      if (Number.isFinite(estimate) && estimate >= 0 && estimate < 100) bodyFat = estimate;
      else bodyFatError = 'invalid_measurements';
    }
  } else {
    bodyFat = Math.max(0, 1.20 * bmi + 0.23 * (safeAge || 25) - 10.8 * (isMale ? 1 : 0) - 5.4);
  }

  const bmr = isMale
    ? 10 * safeWeight + 6.25 * safeHeight - 5 * (safeAge || 25) + 5
    : 10 * safeWeight + 6.25 * safeHeight - 5 * (safeAge || 25) - 161;
  const idealWeight = heightM * heightM * 22;
  const weightDiff = safeWeight - idealWeight;
  const fatMass = bodyFat === null ? null : safeWeight * bodyFat / 100;
  const leanMass = fatMass === null ? null : safeWeight - fatMass;

  return {
    bmi,
    bmiInfo: classifyBmi(bmi),
    bodyFat,
    bodyFatInfo: bodyFat === null ? null : classifyBodyFat(bodyFat, gender),
    bodyFatError,
    bmr,
    idealWeight,
    weightDiff,
    fatMass,
    leanMass,
    barPercent: bodyFat === null ? null : Math.min(100, Math.max(0, (bodyFat / 40) * 100))
  };
}
