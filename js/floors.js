/* Floor themes, colour derivation and persistence. */
(function () {
  'use strict';

  const STORAGE_KEY = 'atrium.floors.v1';
  const EXPOSURE = 1.0;
  const ALBEDO_MAX = 0.76;

  const THEMES = [
    { name: 'Emerald', color: '#02eabe' },
    { name: 'Lagoon', color: '#00c4f0' },
    { name: 'Cobalt', color: '#2f6bff' },
    { name: 'Violet', color: '#8b5cff' },
    { name: 'Orchid', color: '#e040fb' },
    { name: 'Coral', color: '#ff4f7b' },
    { name: 'Ember', color: '#ff7a1a' },
    { name: 'Citrine', color: '#f2d60a' },
  ];

  const DEFAULTS = { intensity: 1.0, reflect: 0.62, haze: 0.22, slitGlow: 1.0 };

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
  const srgbToLinear = (rgb) => rgb.map(toLinear);

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

  // Derive every light/material colour of a floor from the single picked room colour.
  function deriveColors(hex) {
    const [h, s0, v0] = rgbToHsv(hexToRgb(hex));
    const s = s0, v = Math.max(v0, 0.45);
    const panelTop = displayToHdr(hsvToRgb(h + 4.2, s, Math.min(1, v * 1.008)));
    const panelBot = displayToHdr(hsvToRgb(h - 5.4, s, v * 0.996));
    const led = normalizeMax(srgbToLinear(hsvToRgb(h - 9, Math.min(1, s * 1.02), 1)), 1);
    const albedo = normalizeMax(srgbToLinear(hsvToRgb(h + 10, s, 1)), ALBEDO_MAX * (0.6 + 0.4 * Math.min(1, v0 / 0.9)));
    return { panelTop, panelBot, led, albedo };
  }

  function makeFloor(i, saved) {
    const theme = THEMES[i % THEMES.length];
    const f = Object.assign({ name: theme.name, color: theme.color }, DEFAULTS, saved || {});
    f.name = theme.name;
    return Object.assign(f, deriveColors(f.color));
  }

  function load() {
    let saved = [];
    try {
      const raw = window.localStorage.getItem(STORAGE_KEY);
      if (raw) saved = JSON.parse(raw) || [];
    } catch (e) { saved = []; }
    return THEMES.map((_, i) => makeFloor(i, saved[i]));
  }

  function save(floors) {
    try {
      const data = floors.map((f) => ({ color: f.color, intensity: f.intensity, reflect: f.reflect, haze: f.haze, slitGlow: f.slitGlow }));
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
    } catch (e) { /* storage unavailable: settings last for this visit only */ }
  }

  function reset(floors, i) {
    floors[i] = makeFloor(i, null);
    return floors[i];
  }

  function setColor(floor, hex) {
    floor.color = hex;
    Object.assign(floor, deriveColors(hex));
  }

  window.AtriumFloors = { THEMES, DEFAULTS, EXPOSURE, load, save, reset, setColor, deriveColors, hexToRgb, rgbToHex };
})();
