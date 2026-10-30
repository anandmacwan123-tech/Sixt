/* Floor gradients (the six reference palettes), gradient textures, colour derivation, persistence. */
(function () {
  'use strict';

  const STORAGE_KEY = 'atrium.floors.v2';
  const EXPOSURE = 1.0;
  const ALBEDO_MAX = 0.76;
  const LUT_W = 256;
  const NF = 8; // rows reserved in the gradient texture (matches the shaders)

  // Each gradient is [top, middle, bottom] as laid out in the reference strips.
  const GRADIENTS = [
    { name: 'Jade', stops: ['#00eac7', '#01d98e', '#01472b'] },
    { name: 'Azure', stops: ['#08bffa', '#3a99f6', '#010721'] },
    { name: 'Orchid', stops: ['#f92d78', '#af91d6', '#0a1710'] },
    { name: 'Mauve', stops: ['#b63d28', '#b8a1a9', '#281630'] },
    { name: 'Ember', stops: ['#ff821b', '#ff7033', '#791900'] },
    { name: 'Cinder', stops: ['#e7511c', '#383639', '#191919'] },
  ];

  const DEFAULTS = { intensity: 1.0, reflect: 0.55, haze: 0.32, slitGlow: 1.0, sweep: true };

  // ---- colour helpers
  function hexToRgb(hex) {
    const h = hex.replace('#', '');
    const n = parseInt(h.length === 3 ? h.split('').map((c) => c + c).join('') : h, 16);
    return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
  }
  function rgbToHex(rgb) {
    return '#' + rgb.map((v) => Math.round(Math.min(1, Math.max(0, v)) * 255).toString(16).padStart(2, '0')).join('');
  }
  function rgbToHsv([r, g, b]) {
    const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
    let h = 0;
    if (d > 1e-6) {
      if (max === r) h = ((g - b) / d) % 6;
      else if (max === g) h = (b - r) / d + 2;
      else h = (r - g) / d + 4;
      h *= 60;
      if (h < 0) h += 360;
    }
    return [h, max <= 0 ? 0 : d / max, max];
  }
  function hsvToRgb(h, s, v) {
    h = ((h % 360) + 360) % 360;
    const c = v * s, x = c * (1 - Math.abs(((h / 60) % 2) - 1)), m = v - c;
    let r = 0, g = 0, b = 0;
    if (h < 60) [r, g, b] = [c, x, 0];
    else if (h < 120) [r, g, b] = [x, c, 0];
    else if (h < 180) [r, g, b] = [0, c, x];
    else if (h < 240) [r, g, b] = [0, x, c];
    else if (h < 300) [r, g, b] = [x, 0, c];
    else [r, g, b] = [c, 0, x];
    return [r + m, g + m, b + m];
  }
  const toLinear = (c) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
  const toSrgb = (c) => (c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055);
  const srgbToLinear = (rgb) => rgb.map(toLinear);
  const clamp01 = (v) => Math.min(1, Math.max(0, v));

  // OKLab (gradients are interpolated perceptually, as in DepthVideo's colourways)
  function linearToOklab([r, g, b]) {
    const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
    const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
    const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
    return [0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
      1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
      0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s];
  }
  function oklabToLinear([L, a, b]) {
    const l = Math.pow(L + 0.3963377774 * a + 0.2158037573 * b, 3);
    const m = Math.pow(L - 0.1055613458 * a - 0.0638541728 * b, 3);
    const s = Math.pow(L - 0.0894841775 * a - 1.291485548 * b, 3);
    return [4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
      -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
      -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s].map(clamp01);
  }
  const mixLab = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);
  const smooth = (a, b, x) => { const t = clamp01((x - a) / (b - a)); return t * t * (3 - 2 * t); };

  // Stop layout measured from the reference strips.
  // A (light -> dark): top colour held to 28 %, middle reached at 68 %, dark at the very end.
  // B (dark -> light): dark held to 50 %, middle at 84 %, top colour at the end.
  function stripA(t, lab) {
    if (t <= 0.68) return mixLab(lab[0], lab[1], smooth(0.28, 0.68, t));
    return mixLab(lab[1], lab[2], (t - 0.68) / 0.32);
  }
  function stripB(t, lab) {
    if (t <= 0.84) return mixLab(lab[2], lab[1], smooth(0.5, 0.84, t));
    return mixLab(lab[1], lab[0], smooth(0.84, 1.0, t));
  }
  const labStops = (stops) => stops.map((h) => linearToOklab(srgbToLinear(hexToRgb(h))));
  // sRGB colour (0..1) of strip A at t
  const gradA = (stops, t) => oklabToLinear(stripA(t, labStops(stops))).map(toSrgb);

  // Inverse of the tone curve used in the final pass (ACES fit on the max channel).
  function acesFit(x) { return (x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14); }
  function acesInv(y) {
    let lo = 0, hi = 64;
    for (let i = 0; i < 48; i++) { const mid = 0.5 * (lo + hi); if (acesFit(mid) < y) lo = mid; else hi = mid; }
    return 0.5 * (lo + hi);
  }
  // HDR radiance that displays as the given sRGB colour.
  function displayToHdr(rgb) {
    const lin = srgbToLinear(rgb);
    const m = Math.max(lin[0], lin[1], lin[2], 1e-4);
    const k = acesInv(Math.min(m, 0.985)) / EXPOSURE / m;
    return lin.map((v) => v * k);
  }
  function normalizeMax(rgb, target) {
    const m = Math.max(rgb[0], rgb[1], rgb[2], 1e-4);
    return rgb.map((v) => (v / m) * target);
  }

  // Lights and paint of a floor, all taken from its gradient.
  function deriveColors(stops) {
    const top = gradA(stops, 0.0), bot = gradA(stops, 0.66);
    const mt = Math.max(...top.map(toLinear)), mb = Math.max(...bot.map(toLinear), 1e-3);
    const panelTop = displayToHdr(top);
    const panelBot = displayToHdr(srgbToLinear(bot).map((c) => toSrgb(c * Math.max(1, 0.92 * mt / mb))));
    const mid = gradA(stops, 0.45);
    const [h, s, v] = rgbToHsv(mid);
    const led = normalizeMax(srgbToLinear(hsvToRgb(h - 6, Math.min(1, s * 1.05), Math.max(v, 0.6))), 1);
    const midV = rgbToHsv(hexToRgb(stops[1]))[2];
    const albedo = normalizeMax(srgbToLinear(hsvToRgb(h + 6, s, 1)), ALBEDO_MAX * (0.6 + 0.4 * Math.min(1, midV / 0.85)));
    return { panelTop, panelBot, led, albedo };
  }

  // Gradient texture: two rows per floor (strip A, strip B), sRGB bytes.
  function buildLut(floors) {
    const data = new Uint8Array(LUT_W * NF * 2 * 4);
    for (let f = 0; f < NF; f++) {
      const lab = labStops(floors[Math.min(f, floors.length - 1)].stops);
      for (let r = 0; r < 2; r++) {
        const row = (f * 2 + r) * LUT_W * 4;
        for (let i = 0; i < LUT_W; i++) {
          const t = i / (LUT_W - 1);
          const c = oklabToLinear(r === 0 ? stripA(t, lab) : stripB(t, lab)).map(toSrgb);
          data[row + i * 4] = Math.round(c[0] * 255);
          data[row + i * 4 + 1] = Math.round(c[1] * 255);
          data[row + i * 4 + 2] = Math.round(c[2] * 255);
          data[row + i * 4 + 3] = 255;
        }
      }
    }
    return { data, width: LUT_W, height: NF * 2 };
  }

  function makeFloor(i, saved) {
    const g = GRADIENTS[i % GRADIENTS.length];
    const f = Object.assign({ name: g.name, stops: g.stops.slice() }, DEFAULTS, saved || {});
    f.name = g.name;
    if (!Array.isArray(f.stops) || f.stops.length !== 3) f.stops = g.stops.slice();
    return Object.assign(f, deriveColors(f.stops));
  }

  function load() {
    let saved = [];
    try {
      const raw = window.localStorage.getItem(STORAGE_KEY);
      if (raw) saved = JSON.parse(raw) || [];
    } catch (e) { saved = []; }
    return GRADIENTS.map((_, i) => makeFloor(i, saved[i]));
  }

  function save(floors) {
    try {
      const data = floors.map((f) => ({ stops: f.stops, intensity: f.intensity, reflect: f.reflect, haze: f.haze, slitGlow: f.slitGlow, sweep: f.sweep }));
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
    } catch (e) { /* storage unavailable: settings last for this visit only */ }
  }

  function reset(floors, i) {
    floors[i] = makeFloor(i, null);
    return floors[i];
  }

  function setStops(floor, stops) {
    floor.stops = stops.slice();
    Object.assign(floor, deriveColors(floor.stops));
  }

  // CSS gradient for swatches (strip A, top to bottom)
  function cssGradient(stops) {
    const lab = labStops(stops);
    const parts = [0, 0.28, 0.48, 0.68, 0.84, 1].map((t) => rgbToHex(oklabToLinear(stripA(t, lab)).map(toSrgb)) + ' ' + Math.round(t * 100) + '%');
    return 'linear-gradient(180deg, ' + parts.join(', ') + ')';
  }

  window.AtriumFloors = { GRADIENTS, DEFAULTS, EXPOSURE, load, save, reset, setStops, deriveColors, buildLut, cssGradient, hexToRgb, rgbToHex };
})();
