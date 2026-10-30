/* Floor colourways (from DepthVideo), gradient textures, colour derivation, persistence. */
(function () {
  'use strict';

  const STORAGE_KEY = 'atrium.floors.v4';
  const EXPOSURE = 1.0;
  const ALBEDO_MAX = 0.76;
  const LUT_W = 256;
  const NF = 8; // floors, and rows pairs in the gradient texture (matches the shaders)

  // DepthVideo's colourways (src/lib/colormaps.ts), dark -> light. Sampled maps are 65 evenly
  // spaced sRGB stops interpolated in sRGB; designed ones are anchors interpolated in OKLab.
  const GRADIENTS = [
    { id: 'gray', name: 'Mono', stops: '0000000404040808080c0c0c1010101414141818181c1c1c2020202424242828282c2c2c3030303434343838383c3c3c4040404444444848484c4c4c5050505454545858585c5c5c6060606464646868686c6c6c7070707474747878787c7c7c8080808484848888888c8c8c9090909494949898989c9c9ca0a0a0a4a4a4a8a8a8acacacb0b0b0b4b4b4b8b8b8bcbcbcc0c0c0c4c4c4c8c8c8ccccccd0d0d0d4d4d4d8d8d8dcdcdce0e0e0e4e4e4e8e8e8ecececf0f0f0f4f4f4f8f8f8fcfcfcffffff' },
    { id: 'bone', name: 'Silver', stops: '00000004030507070a0a0a0f0e0e1312111815151d1818221c1c27201f2c2323312626362a2a3a2e2d3f31314434344938384e3c3b533f3f5842425d4646614a49664d4d6b505070545574575a775b5f7b5e637e626882666d856972896c778c707b907380937785977a8a9a7e8f9e8194a18598a5889da88ca2ac8fa7af93acb396b0b69ab5ba9dbabda1bfc1a4c4c4a9c8c8aecbcbb4cfcfb9d2d2bfd6d6c4d9d9caddddcfe0e0d5e4e4dae7e7e0ebebe5eeeeeaf2f2f0f5f5f5f9f9fbfcfcffffff' },
    { id: 'inferno', name: 'Inferno', stops: '00000402010a04031207051b0b072410092d150b371b0c41210c4a280b532f0a5b3609613d0965440a684a0c6b510e6c57106e5d126e64156e6a176e71196e771c6d7d1e6d84206b8a226a9025689727669d2964a32c61a92e5eb0315bb63458bc3754c13a50c73e4ccc4248d24644d74b3fdb503be05536e45a31e8602deb6628ef6c23f1731df47918f68013f8870ef98e09fb9606fb9d07fca50afcac11fcb418fbbc21fac42af9cb35f7d340f5db4cf3e35af2ea69f1f179f3f68af8fb9afcffa4' },
    { id: 'magma', name: 'Magma', stops: '00000402010903031206051a0a08220e0b2b130d34180f3d1d114722115029115a2f116336106b3d0f71440f764a107951127c57157e5d177f641a806a1c81701f817621817c2382832681892881902a81962c809c2e7fa3307eaa337db0357bb73779bd3977c43c75ca3e72d0416fd6456cdc4869e24d66e75263eb5760ef5d5ef2645cf56b5cf7725cf9795dfa815ffc8961fc9065fd9869fe9f6dfea772feae77feb67cfebd82fec488fecc8ffed395fdda9cfde2a3fde9aafcf0b2fcf7b9fcfdbf' },
    { id: 'sunset', name: 'Sunset', anchors: ['#0b0b2b', '#3d1a6e', '#a52a6b', '#ec5f4a', '#f9a64a', '#ffe9b0'] },
    { id: 'gold', name: 'Gold', anchors: ['#0a0603', '#3d1f0a', '#8a4b13', '#d4922c', '#fff1c1'] },
    { id: 'viridis', name: 'Viridis', stops: '44015446075a470d6047136548186a481d6f482374482878472d7b46327e453781443b844240864045883e49893d4e8a3b528b39568c375b8d355f8d33638d31678e2f6b8e2e6f8e2c728e2a768e297a8e277e8e26828e25858e23898e228d8d21918c1f948c1f988b1e9c891fa08820a38622a78525ab8228ae802db27d32b67a38b9773fbc7346c06f4ec36b56c6675ec96267cc5c70cf577ad15184d44b8ed64598d83ea2da37addc30b8de29c2df23cde11dd8e219e2e418ece51bf6e620fde725' },
    { id: 'mako', name: 'Mako', stops: '0b040510060a140910180d161c101c20132224162828192e2b1c352e1e3b31214234254837284f392b563b2e5d3d31643e356b403872403c79413f8041438740488d3f4c923d51953b56983a5b9b385f9c37649e36699f366da03572a13576a2357ba3347fa43484a53488a6348da73491a83496a9349aaa359fab36a3ab37a8ac39acac3cb1ad3fb5ad42b9ad46bead4bc2ad50c6ad57cbad60ceac6ad2ad76d5ae82d8b08edbb399ddb6a4e0bbaee3c0b7e6c5c0e9ccc8ecd2d0efd9d8f2e0def5e5' },
    { id: 'ice', name: 'Ice', anchors: ['#00040d', '#06264d', '#1f6fa8', '#62b6e0', '#e6f7ff'] },
    { id: 'aurora', name: 'Aurora', anchors: ['#020617', '#0b3b5c', '#0e7c7b', '#3ddc97', '#e2ffa8'] },
    { id: 'turbo', name: 'Turbo', stops: '30123b351e58392a733d358b4040a2424bb54456c74661d6466be34776ee4680f6458afc4294ff3d9efe37a8fa2fb2f428bceb22c5e21ccdd819d5cd18ddc219e3b91fe9af27eea432f2983ff68a4ef97d5dfc6f6dfe627dff568bff4b99fe42a4fc3caffa37b9f635c3f134cdec34d7e535dfdf37e7d739eecf3af4c73af8be39fbb637fdac34fea130fe962bfd8a26fb7e21f8721cf46617f05b12eb500ee5470bdf3f08d83706d02f05c82803be2102b41b01a916019e1001920b018507027a0403' },
    { id: 'plasma', name: 'Plasma', stops: '0d088719068c2206902a059331059738049a3f049c46039f4c02a15302a35901a56001a66600a76c00a87201a87801a87e03a88405a78a09a58f0da49511a19a169fa01a9ca51f99aa2395ae2892b32c8eb7318abc3587c03a83c43e7fc8437bcc4778cf4c74d35171d6556dda5a6add5e66e06363e3685fe66c5ce97158eb7655ee7b51f0804ef3854bf58b47f79044f89540fa9b3dfba139fca636fdac33fdb22ffeb82cfebe2afdc527fdcb26fcd225fad824f8df25f6e626f4ed27f1f426f0f921' },
    { id: 'neon', name: 'Neon', anchors: ['#05000f', '#2d0a5c', '#7b2ff7', '#f72585', '#ffd6f1'] },
    { id: 'spectral', name: 'Spectral', stops: '5e4fa25758a65061aa496aaf4273b33b7cb73585bb378ebb3f97b747a0b350a9af58b2ac60bba869c3a574c7a57ecca589d0a494d4a49fd8a4aadca4b3e0a2bce4a0c6e89fcfec9dd8ef9be1f399e8f69becf7a1f0f9a7f4faadf8fcb4fcfebafffebefffab6fff5aefff0a6feeb9dfee695fee18dfeda86fed27ffeca79fdc372fdbb6cfdb365fcaa5ffba05bfa9656f88c51f7814cf57748f46d43ef6645ea5e47e55749e1504bdc484cd7414ed0384ec72e4cbe254ab61b48ad1246a408449e0142' },
    { id: 'twilight', name: 'Twilight', stops: '30143733113d3811453e115045135c4c1669511b77562284592a8f5c34995d3da15e47a75e51ad5f5ab15f64b5606db86276ba647ebc6887be6c8fbf7297c1799fc281a6c38aaec595b5c7a0bcc9acc2ccb8c9d0c4ced4ced3d9d7d7ddded9e1e2d9e2e1d8dddfd4d6dccecbd8c7bed5bfb1d1b6a3cfad96cca389ca9a7dc89073c5866ac27c63bf725dbb6958b75f55b25652ac4d51a64550a03d50983550902e508727507e2250741e4f691a4d5f174a5415464a134241123d3a113a3412382f1436' },
  ];
  const BY_ID = Object.fromEntries(GRADIENTS.map((g) => [g.id, g]));
  // default colourway of each floor, ground floor first
  const FLOOR_MAPS = ['aurora', 'ice', 'mako', 'magma', 'plasma', 'neon', 'sunset', 'gold'];

  const DEFAULTS = { intensity: 1.0, reflect: 0.45, haze: 0.4, slitGlow: 1.0, sweep: true };

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
  const labOf = (hex) => linearToOklab(srgbToLinear(hexToRgb(hex)));

  // Sampler for a floor's gradient: t = 0 dark ... 1 light, returns sRGB 0..1 (as DepthVideo).
  function sampler(floor) {
    const g = floor.map === 'custom' ? { anchors: floor.custom } : (BY_ID[floor.map] || BY_ID.gray);
    if (g.anchors) {
      const lab = g.anchors.map(labOf);
      return (t) => {
        const x = Math.min(1, Math.max(0, t)) * (lab.length - 1);
        const k = Math.min(lab.length - 2, Math.floor(x));
        return oklabToLinear(mixLab(lab[k], lab[k + 1], x - k)).map(toSrgb);
      };
    }
    const n = g.stops.length / 6;
    const rgb = Array.from({ length: n }, (_, k) => hexToRgb(g.stops.slice(k * 6, k * 6 + 6)));
    return (t) => {
      const x = Math.min(1, Math.max(0, t)) * (n - 1);
      const k = Math.min(n - 2, Math.floor(x));
      const f = x - k;
      return rgb[k].map((v, c) => v + (rgb[k + 1][c] - v) * f);
    };
  }
  // strip A runs light -> dark, strip B dark -> light
  const gradA = (floor, t) => sampler(floor)(1 - t);

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
  function deriveColors(floor) {
    const top = gradA(floor, 0.0), bot = gradA(floor, 0.45);
    const mt = Math.max(...top.map(toLinear)), mb = Math.max(...bot.map(toLinear), 1e-3);
    const panelTop = displayToHdr(top);
    const panelBot = displayToHdr(srgbToLinear(bot).map((c) => toSrgb(Math.min(1, c * Math.max(1, 0.92 * mt / mb)))));
    const mid = gradA(floor, 0.35);
    const [h, s, v] = rgbToHsv(mid);
    const led = normalizeMax(srgbToLinear(hsvToRgb(h - 6, Math.min(1, s * 1.05), Math.max(v, 0.6))), 1);
    const midV = rgbToHsv(gradA(floor, 0.5))[2];
    const albedo = normalizeMax(srgbToLinear(hsvToRgb(h + 6, s, 1)), ALBEDO_MAX * (0.6 + 0.4 * Math.min(1, midV / 0.7)));
    return { panelTop, panelBot, led, albedo };
  }

  // Gradient texture: two rows per floor (strip A, strip B), sRGB bytes.
  function buildLut(floors) {
    const data = new Uint8Array(LUT_W * NF * 2 * 4);
    for (let f = 0; f < NF; f++) {
      const sample = sampler(floors[Math.min(f, floors.length - 1)]);
      for (let r = 0; r < 2; r++) {
        const row = (f * 2 + r) * LUT_W * 4;
        for (let i = 0; i < LUT_W; i++) {
          const t = i / (LUT_W - 1);
          const c = sample(r === 0 ? 1 - t : t);
          data.set([Math.round(c[0] * 255), Math.round(c[1] * 255), Math.round(c[2] * 255), 255], row + i * 4);
        }
      }
    }
    return { data, width: LUT_W, height: NF * 2 };
  }

  // three representative colours (light, middle, dark) shown in the stop pickers
  function stopsOf(floor) {
    const sample = sampler(floor);
    return [1, 0.5, 0].map((t) => rgbToHex(sample(t)));
  }

  function makeFloor(i, saved) {
    const f = Object.assign({ map: FLOOR_MAPS[i % FLOOR_MAPS.length], custom: null }, DEFAULTS, saved || {});
    if (f.map !== 'custom' && !BY_ID[f.map]) f.map = FLOOR_MAPS[i % FLOOR_MAPS.length];
    if (f.map === 'custom' && (!Array.isArray(f.custom) || f.custom.length < 2)) f.map = FLOOR_MAPS[i % FLOOR_MAPS.length];
    f.objects = cleanObjects(saved && saved.objects);
    return Object.assign(f, deriveColors(f));
  }

  // placed objects: { shape, p: base point (floor space), n: surface normal, spin, size, stretch, rough }
  function cleanObjects(list) {
    if (!Array.isArray(list)) return [];
    const num = (v, d) => (typeof v === 'number' && isFinite(v) ? v : d);
    const vec = (v) => Array.isArray(v) && v.length === 3 && v.every((x) => typeof x === 'number' && isFinite(x));
    return list.filter((o) => o && vec(o.p) && vec(o.n)).slice(0, 12).map((o) => ({
      shape: Math.min(5, Math.max(0, Math.round(num(o.shape, 0)))),
      p: o.p.slice(), n: o.n.slice(),
      spin: num(o.spin, 0), size: num(o.size, 0.6), stretch: num(o.stretch, 1), rough: num(o.rough, 0.35),
    }));
  }

  function load() {
    let saved = [];
    try {
      const raw = window.localStorage.getItem(STORAGE_KEY);
      if (raw) saved = JSON.parse(raw) || [];
    } catch (e) { saved = []; }
    return FLOOR_MAPS.map((_, i) => makeFloor(i, saved[i]));
  }

  function save(floors) {
    try {
      const data = floors.map((f) => ({ map: f.map, custom: f.custom, intensity: f.intensity, reflect: f.reflect, haze: f.haze, slitGlow: f.slitGlow, sweep: f.sweep, objects: f.objects }));
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
    } catch (e) { /* storage unavailable: settings last for this visit only */ }
  }

  // back to the floor's default look; its objects stay
  function reset(floors, i) {
    const objects = floors[i].objects;
    floors[i] = makeFloor(i, null);
    floors[i].objects = objects;
    return floors[i];
  }

  // pick a colourway by id
  function setMap(floor, id) {
    floor.map = id;
    floor.custom = null;
    Object.assign(floor, deriveColors(floor));
  }
  // custom gradient from the three pickers (given light, middle, dark), like DepthVideo's custom
  function setCustom(floor, lightMidDark) {
    floor.map = 'custom';
    floor.custom = lightMidDark.slice().reverse();
    Object.assign(floor, deriveColors(floor));
  }

  // CSS gradient for swatches: light at the top
  function cssGradient(floor) {
    const sample = sampler(floor);
    const parts = [0, 0.2, 0.4, 0.6, 0.8, 1].map((t) => rgbToHex(sample(1 - t)) + ' ' + Math.round(t * 100) + '%');
    return 'linear-gradient(180deg, ' + parts.join(', ') + ')';
  }

  window.AtriumFloors = { GRADIENTS, DEFAULTS, EXPOSURE, load, save, reset, setMap, setCustom, stopsOf, deriveColors, buildLut, cssGradient, hexToRgb, rgbToHex };
})();
