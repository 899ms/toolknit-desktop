/**
 * Pure color-conversion helpers extracted from the original color-space
 * comparison page. XYZ values are relative (Y = 1 for reference white), and
 * RGB channel values are encoded sRGB in the 0..255 range unless noted.
 *
 * Important compatibility note: the original page computes CIELAB/CIELCH
 * directly against a D65 white point. That behavior is intentionally retained
 * here. It is not the D50 Lab/LCH interpretation used by CSS Color 4.
 */

export const LAB_D65_WHITE_POINT = Object.freeze({
  x: 0.9504559270516716,
  y: 1,
  z: 1.0890577507598784
});

const LAB_EPSILON = 216 / 24389;
const LAB_KAPPA = 24389 / 27;
const OKLCH_NEUTRAL_EPSILON = 0.000004;
const LCH_NEUTRAL_EPSILON = 0.0015;
const GAMUT_EPSILON = 1e-7;

function freezeSliderConfig(config) {
  for (const entry of Object.values(config)) {
    entry.channels.forEach(Object.freeze);
    Object.freeze(entry.channels);
    Object.freeze(entry);
  }
  return Object.freeze(config);
}

export const COLOR_SPACE_SLIDER_CONFIG = freezeSliderConfig({
  oklch: { channels: [
    { key: 'L', min: 0, max: 1, step: 0.001, decimals: 3 },
    { key: 'C', min: 0, max: 0.4, step: 0.001, decimals: 3 },
    { key: 'H', min: 0, max: 360, step: 0.5, decimals: 1, unit: '°' }
  ] },
  oklab: { channels: [
    { key: 'L', min: 0, max: 1, step: 0.001, decimals: 3 },
    { key: 'a', min: -0.4, max: 0.4, step: 0.001, decimals: 3 },
    { key: 'b', min: -0.4, max: 0.4, step: 0.001, decimals: 3 }
  ] },
  lab: { channels: [
    { key: 'L', min: 0, max: 100, step: 0.1, decimals: 1 },
    { key: 'a', min: -128, max: 128, step: 0.1, decimals: 1 },
    { key: 'b', min: -128, max: 128, step: 0.1, decimals: 1 }
  ] },
  lch: { channels: [
    { key: 'L', min: 0, max: 100, step: 0.1, decimals: 1 },
    { key: 'C', min: 0, max: 200, step: 0.1, decimals: 1 },
    { key: 'H', min: 0, max: 360, step: 0.5, decimals: 1, unit: '°' }
  ] },
  rgb: { channels: [
    { key: 'r', min: 0, max: 255, step: 1, decimals: 0 },
    { key: 'g', min: 0, max: 255, step: 1, decimals: 0 },
    { key: 'b', min: 0, max: 255, step: 1, decimals: 0 }
  ] },
  hsl: { channels: [
    { key: 'h', min: 0, max: 360, step: 0.5, decimals: 1, unit: '°' },
    { key: 's', min: 0, max: 100, step: 0.5, decimals: 1, unit: '%' },
    { key: 'l', min: 0, max: 100, step: 0.5, decimals: 1, unit: '%' }
  ] },
  hsv: { channels: [
    { key: 'h', min: 0, max: 360, step: 0.5, decimals: 1, unit: '°' },
    { key: 's', min: 0, max: 100, step: 0.5, decimals: 1, unit: '%' },
    { key: 'v', min: 0, max: 100, step: 0.5, decimals: 1, unit: '%' }
  ] },
  cmyk: { channels: [
    { key: 'c', min: 0, max: 100, step: 0.5, decimals: 1, unit: '%' },
    { key: 'm', min: 0, max: 100, step: 0.5, decimals: 1, unit: '%' },
    { key: 'y', min: 0, max: 100, step: 0.5, decimals: 1, unit: '%' },
    { key: 'k', min: 0, max: 100, step: 0.5, decimals: 1, unit: '%' }
  ] }
});

// Compatibility alias for code copied from the source page.
export const SLIDER_CONFIG = COLOR_SPACE_SLIDER_CONFIG;

export function srgbToLinear(channel) {
  const sign = channel < 0 ? -1 : 1;
  const absolute = Math.abs(channel);
  return absolute <= 0.04045
    ? channel / 12.92
    : sign * (((absolute + 0.055) / 1.055) ** 2.4);
}

export function linearToSrgb(channel) {
  const sign = channel < 0 ? -1 : 1;
  const absolute = Math.abs(channel);
  return absolute <= 0.0031308
    ? channel * 12.92
    : sign * (1.055 * (absolute ** (1 / 2.4)) - 0.055);
}

export function clamp01(channel) {
  return Math.max(0, Math.min(1, channel));
}

export function linearRgbToXyz(r, g, b) {
  return {
    x: 0.4123907992659593 * r + 0.3575843393838780 * g + 0.1804807884018343 * b,
    y: 0.2126390058715103 * r + 0.7151686787677560 * g + 0.0721923153607337 * b,
    z: 0.0193308187155918 * r + 0.1191947797946260 * g + 0.9505321522496607 * b
  };
}

export function xyzToLinearRgb(x, y, z) {
  return {
    r: 3.2409699419045226 * x - 1.5373831775700940 * y - 0.4986107602930034 * z,
    g: -0.9692436362808796 * x + 1.8759675015077202 * y + 0.0415550574071756 * z,
    b: 0.0556300796969937 * x - 0.2039769588889765 * y + 1.0569715142428786 * z
  };
}

export function linearRgbToOklab(r, g, b) {
  const l = 0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b;
  const m = 0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b;
  const s = 0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b;
  const lRoot = Math.cbrt(l);
  const mRoot = Math.cbrt(m);
  const sRoot = Math.cbrt(s);
  return {
    L: 0.2104542553 * lRoot + 0.7936177850 * mRoot - 0.0040720468 * sRoot,
    a: 1.9779984951 * lRoot - 2.4285922050 * mRoot + 0.4505937099 * sRoot,
    b: 0.0259040371 * lRoot + 0.7827717662 * mRoot - 0.8086757660 * sRoot
  };
}

export function oklabToLinearRgb(L, a, b) {
  const lRoot = L + 0.3963377774 * a + 0.2158037573 * b;
  const mRoot = L - 0.1055613458 * a - 0.0638541728 * b;
  // The source page has 1.0916538131 here, which makes OKLab fail to round
  // trip. Use the standard inverse coefficient while retaining its UI ranges.
  const sRoot = L - 0.0894841775 * a - 1.2914855480 * b;
  const l = lRoot ** 3;
  const m = mRoot ** 3;
  const s = sRoot ** 3;
  return {
    r: 4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    g: -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    b: -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s
  };
}

export function xyzToOklab(x, y, z) {
  // CSS Color 4's 64-bit XYZ D65 -> OKLab matrices avoid compounding
  // round-trip error through an intermediate RGB representation.
  const l = 0.8190224379967030 * x + 0.3619062600528904 * y - 0.1288737815209879 * z;
  const m = 0.0329836539323885 * x + 0.9292868615863434 * y + 0.0361446663506424 * z;
  const s = 0.0481771893596242 * x + 0.2642395317527308 * y + 0.6335478284694309 * z;
  const lRoot = Math.cbrt(l);
  const mRoot = Math.cbrt(m);
  const sRoot = Math.cbrt(s);
  return {
    L: 0.2104542683093140 * lRoot + 0.7936177747023054 * mRoot - 0.0040720430116193 * sRoot,
    a: 1.9779985324311684 * lRoot - 2.4285922420485799 * mRoot + 0.4505937096174110 * sRoot,
    b: 0.0259040424655478 * lRoot + 0.7827717124575296 * mRoot - 0.8086757549230774 * sRoot
  };
}

export function oklabToXyz(L, a, b) {
  const lRoot = L + 0.3963377773761749 * a + 0.2158037573099136 * b;
  const mRoot = L - 0.1055613458156586 * a - 0.0638541728258133 * b;
  const sRoot = L - 0.0894841775298119 * a - 1.2914855480194092 * b;
  const l = lRoot ** 3;
  const m = mRoot ** 3;
  const s = sRoot ** 3;
  return {
    x: 1.2268798758459243 * l - 0.5578149944602171 * m + 0.2813910456659647 * s,
    y: -0.0405757452148008 * l + 1.1122868032803170 * m - 0.0717110580655164 * s,
    z: -0.0763729366746601 * l - 0.4214933324022432 * m + 1.5869240198367816 * s
  };
}

export function oklabToOklch(L, a, b) {
  const C = Math.sqrt(a * a + b * b);
  let H = Math.atan2(b, a) * 180 / Math.PI;
  if (H < 0) H += 360;
  if (C <= OKLCH_NEUTRAL_EPSILON) H = Number.NaN;
  return { L, C, H };
}

export function oklchToOklab(L, C, H) {
  if (!Number.isFinite(H)) return { L, a: 0, b: 0 };
  const radians = H * Math.PI / 180;
  return { L, a: C * Math.cos(radians), b: C * Math.sin(radians) };
}

/** Convert relative XYZ D65 to the source page's D65 CIELAB values. */
export function xyzToLabD65(x, y, z) {
  const f = (value) => value > LAB_EPSILON
    ? Math.cbrt(value)
    : (LAB_KAPPA * value + 16) / 116;
  const fx = f(x / LAB_D65_WHITE_POINT.x);
  const fy = f(y / LAB_D65_WHITE_POINT.y);
  const fz = f(z / LAB_D65_WHITE_POINT.z);
  return {
    L: 116 * fy - 16,
    a: 500 * (fx - fy),
    b: 200 * (fy - fz)
  };
}

/** Convert the source page's D65 CIELAB values to relative XYZ D65. */
export function labD65ToXyz(L, a, b) {
  const fy = (L + 16) / 116;
  const fx = a / 500 + fy;
  const fz = fy - b / 200;
  const inverse = (value) => {
    const cubed = value ** 3;
    return cubed > LAB_EPSILON
      ? cubed
      : (116 * value - 16) / LAB_KAPPA;
  };
  return {
    x: LAB_D65_WHITE_POINT.x * inverse(fx),
    y: LAB_D65_WHITE_POINT.y * inverse(fy),
    z: LAB_D65_WHITE_POINT.z * inverse(fz)
  };
}

/** Convert the source page's cartesian D65 Lab to cylindrical D65 LCH. */
export function labD65ToLch(L, a, b) {
  const C = Math.sqrt(a * a + b * b);
  let H = Math.atan2(b, a) * 180 / Math.PI;
  if (H < 0) H += 360;
  if (C <= LCH_NEUTRAL_EPSILON) H = Number.NaN;
  return { L, C, H };
}

/** Convert the source page's cylindrical D65 LCH to cartesian D65 Lab. */
export function lchD65ToLab(L, C, H) {
  if (!Number.isFinite(H)) return { L, a: 0, b: 0 };
  const radians = H * Math.PI / 180;
  return { L, a: C * Math.cos(radians), b: C * Math.sin(radians) };
}

// Source-compatible names; these aliases deliberately retain D65 semantics.
export const xyzToLab = xyzToLabD65;
export const labToXyz = labD65ToXyz;
export const labToLch = labD65ToLch;
export const lchToLab = lchD65ToLab;

export function rgbToHsl(r, g, b) {
  r /= 255;
  g /= 255;
  b /= 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  let h = 0;
  let s = 0;

  if (max - min > 1e-9) {
    const delta = max - min;
    s = l > 0.5 ? delta / (2 - max - min) : delta / (max + min);
    switch (max) {
      case r: h = (g - b) / delta + (g < b ? 6 : 0); break;
      case g: h = (b - r) / delta + 2; break;
      default: h = (r - g) / delta + 4;
    }
    h *= 60;
  }

  return { h, s: s * 100, l: l * 100 };
}

export function hslToRgb(h, s, l) {
  h = ((h % 360) + 360) % 360;
  h /= 360;
  s /= 100;
  l /= 100;
  let r;
  let g;
  let b;

  if (s === 0) {
    r = g = b = l;
  } else {
    const hueToRgb = (p, q, t) => {
      if (t < 0) t += 1;
      if (t > 1) t -= 1;
      if (t < 1 / 6) return p + (q - p) * 6 * t;
      if (t < 1 / 2) return q;
      if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
      return p;
    };
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    r = hueToRgb(p, q, h + 1 / 3);
    g = hueToRgb(p, q, h);
    b = hueToRgb(p, q, h - 1 / 3);
  }

  return { r: r * 255, g: g * 255, b: b * 255 };
}

export function rgbToHsv(r, g, b) {
  r /= 255;
  g /= 255;
  b /= 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const delta = max - min;
  let h = 0;
  const s = max === 0 ? 0 : delta / max;

  if (delta > 1e-9) {
    switch (max) {
      case r: h = (g - b) / delta + (g < b ? 6 : 0); break;
      case g: h = (b - r) / delta + 2; break;
      default: h = (r - g) / delta + 4;
    }
    h *= 60;
  }

  return { h, s: s * 100, v: max * 100 };
}

export function hsvToRgb(h, s, v) {
  h = ((h % 360) + 360) % 360;
  h /= 360;
  s /= 100;
  v /= 100;
  const index = Math.floor(h * 6);
  const fraction = h * 6 - index;
  const p = v * (1 - s);
  const q = v * (1 - fraction * s);
  const t = v * (1 - (1 - fraction) * s);
  let r;
  let g;
  let b;

  switch (index % 6) {
    case 0: r = v; g = t; b = p; break;
    case 1: r = q; g = v; b = p; break;
    case 2: r = p; g = v; b = t; break;
    case 3: r = p; g = q; b = v; break;
    case 4: r = t; g = p; b = v; break;
    default: r = v; g = p; b = q;
  }

  return { r: r * 255, g: g * 255, b: b * 255 };
}

export function rgbToCmyk(r, g, b) {
  r /= 255;
  g /= 255;
  b /= 255;
  const k = 1 - Math.max(r, g, b);
  if (k >= 1) return { c: 0, m: 0, y: 0, k: 100 };
  return {
    c: (1 - r - k) / (1 - k) * 100,
    m: (1 - g - k) / (1 - k) * 100,
    y: (1 - b - k) / (1 - k) * 100,
    k: k * 100
  };
}

export function cmykToRgb(c, m, y, k) {
  c /= 100;
  m /= 100;
  y /= 100;
  k /= 100;
  return {
    r: 255 * (1 - c) * (1 - k),
    g: 255 * (1 - m) * (1 - k),
    b: 255 * (1 - y) * (1 - k)
  };
}

export function rgbToOklab(r, g, b) {
  return linearRgbToOklab(
    srgbToLinear(r / 255),
    srgbToLinear(g / 255),
    srgbToLinear(b / 255)
  );
}

export function oklabToRgb(L, a, b) {
  const linearRgb = oklabToLinearRgb(L, a, b);
  return {
    r: clamp01(linearToSrgb(linearRgb.r)) * 255,
    g: clamp01(linearToSrgb(linearRgb.g)) * 255,
    b: clamp01(linearToSrgb(linearRgb.b)) * 255
  };
}

export function rgbToLabD65(r, g, b) {
  const xyz = rgbValuesToXyz({ r, g, b });
  return xyzToLabD65(xyz.x, xyz.y, xyz.z);
}

export function labD65ToRgb(L, a, b) {
  const xyz = labD65ToXyz(L, a, b);
  return xyzToDisplayRgb(xyz.x, xyz.y, xyz.z);
}

// Source-compatible names; these aliases deliberately retain D65 semantics.
export const rgbToLab = rgbToLabD65;
export const labToRgb = labD65ToRgb;

export function rgbToHex(r, g, b) {
  return `#${[r, g, b].map((value) => {
    const hex = Math.max(0, Math.min(255, Math.round(value))).toString(16);
    return hex.length === 1 ? `0${hex}` : hex;
  }).join('').toUpperCase()}`;
}

function channelsAreInUnitGamut(channels, epsilon) {
  return channels.every((channel) => channel >= -epsilon && channel <= 1 + epsilon);
}

export function xyzToLinearDisplayP3(x, y, z) {
  return {
    r: 2.4934969119414250 * x - 0.9313836179191239 * y - 0.40271078445071684 * z,
    g: -0.8294889695615747 * x + 1.7626640603183463 * y + 0.023624685841943577 * z,
    b: 0.03584583024378447 * x - 0.07617238926804182 * y + 0.9568845240076872 * z
  };
}

export function xyzToLinearAdobeRgb(x, y, z) {
  // Adobe RGB (1998), named a98-rgb in CSS Color 4. These coefficients are
  // derived from the published primaries instead of the older rounded matrix.
  return {
    r: 2.0415879038107461 * x - 0.5650069742788596 * y - 0.3447313507783295 * z,
    g: -0.9692436362808798 * x + 1.8759675015077206 * y + 0.04155505740717561 * z,
    b: 0.013444280632031024 * x - 0.11836239223101824 * y + 1.0151749943912054 * z
  };
}

export function xyzToLinearRec2020(x, y, z) {
  return {
    r: 1.7166511879712676 * x - 0.3556707837763924 * y - 0.2533662813736598 * z,
    g: -0.6666843518324890 * x + 1.6164812366349390 * y + 0.01576854581391113 * z,
    b: 0.017639857445310915 * x - 0.042770613257808655 * y + 0.9421031212354740 * z
  };
}

export function oklabInSrgbGamut(L, a, b) {
  const xyz = oklabToXyz(L, a, b);
  const linearRgb = xyzToLinearRgb(xyz.x, xyz.y, xyz.z);
  return channelsAreInUnitGamut([linearRgb.r, linearRgb.g, linearRgb.b], GAMUT_EPSILON);
}

export function oklabInDisplayP3(L, a, b) {
  const { x, y, z } = oklabToXyz(L, a, b);
  const linearRgb = xyzToLinearDisplayP3(x, y, z);
  return channelsAreInUnitGamut([linearRgb.r, linearRgb.g, linearRgb.b], GAMUT_EPSILON);
}

export function oklabInAdobeRgb(L, a, b) {
  const { x, y, z } = oklabToXyz(L, a, b);
  const linearRgb = xyzToLinearAdobeRgb(x, y, z);
  return channelsAreInUnitGamut([linearRgb.r, linearRgb.g, linearRgb.b], GAMUT_EPSILON);
}

export function oklabInRec2020(L, a, b) {
  const { x, y, z } = oklabToXyz(L, a, b);
  const linearRgb = xyzToLinearRec2020(x, y, z);
  return channelsAreInUnitGamut([linearRgb.r, linearRgb.g, linearRgb.b], GAMUT_EPSILON);
}

export function rgbValuesToXyz(values) {
  return linearRgbToXyz(
    srgbToLinear(values.r / 255),
    srgbToLinear(values.g / 255),
    srgbToLinear(values.b / 255)
  );
}

/** Convert relative XYZ D65 to clipped, displayable encoded sRGB (0..255). */
export function xyzToDisplayRgb(x, y, z) {
  const linearRgb = xyzToLinearRgb(x, y, z);
  return {
    r: clamp01(linearToSrgb(linearRgb.r)) * 255,
    g: clamp01(linearToSrgb(linearRgb.g)) * 255,
    b: clamp01(linearToSrgb(linearRgb.b)) * 255
  };
}

export function spaceToXyz(space, values) {
  switch (space) {
    case 'rgb': return rgbValuesToXyz(values);
    case 'hsl': return rgbValuesToXyz(hslToRgb(values.h, values.s, values.l));
    case 'hsv': return rgbValuesToXyz(hsvToRgb(values.h, values.s, values.v));
    case 'cmyk': return rgbValuesToXyz(cmykToRgb(values.c, values.m, values.y, values.k));
    case 'oklch': {
      const oklab = oklchToOklab(values.L, values.C, values.H);
      return oklabToXyz(oklab.L, oklab.a, oklab.b);
    }
    case 'oklab': return oklabToXyz(values.L, values.a, values.b);
    // These two branches intentionally use the source page's D65 Lab/LCH.
    case 'lab': return labD65ToXyz(values.L, values.a, values.b);
    case 'lch': {
      const lab = lchD65ToLab(values.L, values.C, values.H);
      return labD65ToXyz(lab.L, lab.a, lab.b);
    }
    default: throw new RangeError(`Unsupported color space: ${space}`);
  }
}

export function spaceToDisplayRgb(space, values) {
  const xyz = spaceToXyz(space, values);
  return xyzToDisplayRgb(xyz.x, xyz.y, xyz.z);
}

// Compatibility alias for code copied from the source page.
export const spaceToRgb = spaceToDisplayRgb;

export function xyzToAllSpaces(xyz, displayRgb = xyzToDisplayRgb(xyz.x, xyz.y, xyz.z)) {
  const oklab = xyzToOklab(xyz.x, xyz.y, xyz.z);
  const lab = xyzToLabD65(xyz.x, xyz.y, xyz.z);
  return {
    oklab,
    oklch: oklabToOklch(oklab.L, oklab.a, oklab.b),
    lab,
    lch: labD65ToLch(lab.L, lab.a, lab.b),
    hsl: rgbToHsl(displayRgb.r, displayRgb.g, displayRgb.b),
    hsv: rgbToHsv(displayRgb.r, displayRgb.g, displayRgb.b),
    cmyk: rgbToCmyk(displayRgb.r, displayRgb.g, displayRgb.b)
  };
}

export function rgbToAllSpaces(r, g, b) {
  const xyz = rgbValuesToXyz({ r, g, b });
  return xyzToAllSpaces(xyz, { r, g, b });
}

export function getSpaceValues(space, allSpaces, displayRgb) {
  if (space === 'rgb') {
    if (displayRgb) return displayRgb;
    if (allSpaces?.rgb) return allSpaces.rgb;
    throw new TypeError('displayRgb is required when requesting rgb values.');
  }
  if (!Object.hasOwn(allSpaces ?? {}, space)) {
    throw new RangeError(`Unsupported color space: ${space}`);
  }
  const values = allSpaces[space];
  if ((space === 'oklch' || space === 'lch') && !Number.isFinite(values.H)) {
    return { ...values, H: 0 };
  }
  return values;
}

export function fmtColorNumber(value, decimals) {
  const number = Math.abs(Number(value)) < 0.5 * (10 ** -decimals)
    ? 0
    : Number(value);
  return number.toFixed(decimals);
}

// Compatibility alias for code copied from the source page.
export const fmt = fmtColorNumber;

export function normalizeSliderValue(value, config) {
  if (!Number.isFinite(value)) return null;
  const clamped = Math.max(config.min, Math.min(config.max, value));
  const steps = Math.round((clamped - config.min) / config.step);
  const snapped = Math.max(
    config.min,
    Math.min(config.max, config.min + steps * config.step)
  );
  return Number(snapped.toFixed(config.decimals));
}

export function normalizeSpaceValues(space, values) {
  const config = COLOR_SPACE_SLIDER_CONFIG[space];
  if (!config) throw new RangeError(`Unsupported color space: ${space}`);
  const normalized = {};
  for (const channel of config.channels) {
    normalized[channel.key] = normalizeSliderValue(Number(values?.[channel.key]), channel)
      ?? channel.min;
  }
  return normalized;
}
