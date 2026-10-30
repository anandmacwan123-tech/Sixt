/* Application: elevator navigation, per-floor controls and the render loop. */
(function () {
  'use strict';

  const Renderer = window.AtriumRenderer;
  const Floors = window.AtriumFloors;
  const params = new URLSearchParams(window.location.search);

  const FLOOR_H = 5.2;
  const EYE_H = 1.6;
  const PULSE_PERIOD = 3.2;
  const DOLLY = 3.2;

  // Test/debug options (used for headless captures): ?frames=N&scale=1&floor=0&debug=0&time=2.5
  const TEST_FRAMES = params.has('frames') ? parseInt(params.get('frames'), 10) : 0;
  const FIXED_TIME = params.has('time') ? parseFloat(params.get('time')) : null;
  const DEBUG = parseInt(params.get('debug') || '0', 10);
  const FORCED_SCALE = params.has('scale') ? parseFloat(params.get('scale')) : null;
  const FORCED_QUALITY = params.has('quality') ? (params.get('quality') === 'low' ? 0 : 1) : null;

  const $ = (id) => document.getElementById(id);
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const easeInOut = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
  const pad = (n) => String(n + 1).padStart(2, '0');

  const floors = Floors.load();
  // optional overrides for captures
  ['intensity', 'reflect', 'haze', 'slitGlow'].forEach((k) => {
    if (params.has(k)) floors.forEach((f) => { f[k] = parseFloat(params.get(k)); });
  });

  let current = clamp(parseInt(params.get('floor') || '0', 10) || 0, 0, floors.length - 1);
  const lift = { pos: current, from: current, to: current, t0: 0, dur: 0, moving: false };
  if (params.has('liftPos')) {
    // capture a frame mid-journey from floor 'floor' to 'floor'+1 (or -1)
    lift.pos = clamp(parseFloat(params.get('liftPos')), 0, floors.length - 1);
    lift.from = Math.floor(lift.pos); lift.to = Math.ceil(lift.pos); lift.moving = true;
    lift.dur = 1e12; lift.t0 = performance.now() - (lift.pos - lift.from) * 1e12;
  }

  // ------------------------------------------------------------------ renderer
  const canvas = $('scene');
  let renderer;
  try {
    renderer = new Renderer(canvas, {
      preserve: TEST_FRAMES > 0,
      probeRays: parseInt(params.get('probeRays') || '8', 10),
      probeUpdatesPerFrame: parseInt(params.get('probeUpdates') || '1', 10),
      fogSteps: parseInt(params.get('fogSteps') || '12', 10),
      quality: FORCED_QUALITY === null ? 1 : FORCED_QUALITY,
    });
  } catch (err) {
    showError(err);
    return;
  }
  renderer.setFloors(floors);

  function showError(err) {
    console.error(err);
    $('loader').classList.add('done');
    $('error').hidden = false;
    $('errorText').textContent = String(err && err.message ? err.message : err);
    window.__error = String(err && err.message ? err.message : err);
  }

  // ------------------------------------------------------------------ sizing / dynamic resolution
  const res = { scale: FORCED_SCALE || 0, lastChange: 0, ema: 16.7, bad: 1.0, goodSince: 0, slowSince: 0 };

  function resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.max(1, Math.round(canvas.clientWidth * dpr));
    const h = Math.max(1, Math.round(canvas.clientHeight * dpr));
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
    if (!res.scale) res.scale = clamp(Math.sqrt(0.85e6 / (w * h)), 0.3, 1);
    // keep the vanishing point in the part of the screen the dock doesn't cover (phones)
    const dock = document.querySelector('.dock');
    const cover = dock ? Math.max(0, window.innerHeight - dock.getBoundingClientRect().top) : 0;
    document.documentElement.style.setProperty('--dock-h', Math.round(cover) + 'px');
    const useInset = cover > 0.15 * window.innerHeight && (!TEST_FRAMES || params.has('ui'));
    renderer.setViewInset(useInset ? Math.min(cover, 0.35 * window.innerHeight) * dpr : 0);
    renderer.resize(w, h, res.scale);
  }

  function adaptResolution(dt, now) {
    if (FORCED_SCALE || TEST_FRAMES) return;
    res.ema += (dt - res.ema) * 0.06;
    if (now - res.lastChange < 1500) return;
    const maxScale = clamp(Math.sqrt(2.2e6 / (canvas.width * canvas.height)), 0.3, 1);
    // still too slow at the lowest resolution: switch to the analytic reflection path
    if (FORCED_QUALITY === null && renderer.quality > 0 && res.scale <= 0.42 && res.ema > 30) {
      if (!res.slowSince) res.slowSince = now;
      if (now - res.slowSince > 2000) {
        renderer.setQuality(0);
        res.scale = Math.min(1, res.scale * 1.5);
        res.bad = 1.0; res.lastChange = now; res.slowSince = 0;
        renderer.resize(canvas.width, canvas.height, res.scale);
        return;
      }
    } else {
      res.slowSince = 0;
    }
    if (res.ema > 26 && res.scale > 0.32) {
      res.bad = res.scale;
      res.scale = Math.max(0.3, res.scale * 0.86);
      res.lastChange = now; res.goodSince = now;
      renderer.resize(canvas.width, canvas.height, res.scale);
    } else if (res.ema < 17.8) {
      if (!res.goodSince) res.goodSince = now;
      const next = Math.min(maxScale, res.scale * 1.08);
      if (now - res.goodSince > 3000 && next < res.bad * 0.97 && next > res.scale + 0.01) {
        res.scale = next;
        res.lastChange = now; res.goodSince = now;
        renderer.resize(canvas.width, canvas.height, res.scale);
      }
    } else {
      res.goodSince = now;
    }
  }

  window.addEventListener('resize', () => { resize(); });

  // ------------------------------------------------------------------ UI
  const ui = {
    intensity: $('intensity'), reflect: $('reflect'), haze: $('haze'), color: $('color'),
    intensityOut: $('intensityOut'), reflectOut: $('reflectOut'), hazeOut: $('hazeOut'), colorOut: $('colorOut'),
    swatches: $('swatches'), floorList: $('floorList'),
  };
  let paramsChanged = false;
  let saveTimer = 0;

  // floor buttons (top floor first)
  const floorButtons = [];
  for (let i = floors.length - 1; i >= 0; i--) {
    const li = document.createElement('li');
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = pad(i);
    b.setAttribute('aria-label', 'Floor ' + (i + 1) + ', ' + floors[i].name);
    b.addEventListener('click', () => goTo(i));
    li.appendChild(b);
    ui.floorList.appendChild(li);
    floorButtons[i] = b;
  }
  // preset swatches
  const swatchButtons = Floors.THEMES.map((t) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'swatch';
    b.style.background = t.color;
    b.title = t.name;
    b.setAttribute('aria-label', t.name);
    b.addEventListener('click', () => applyColor(t.color));
    ui.swatches.appendChild(b);
    return b;
  });

  function setRangeFill(el) {
    const pct = ((el.value - el.min) / (el.max - el.min)) * 100;
    el.style.setProperty('--pct', pct + '%');
  }

  function syncUI() {
    const f = floors[lift.to];
    ui.intensity.value = f.intensity;
    ui.reflect.value = f.reflect;
    ui.haze.value = f.haze;
    ui.color.value = f.color;
    [ui.intensity, ui.reflect, ui.haze].forEach(setRangeFill);
    ui.intensityOut.textContent = Math.round(f.intensity * 100) + '%';
    ui.reflectOut.textContent = Math.round(f.reflect * 100) + '%';
    ui.hazeOut.textContent = Math.round(f.haze * 100) + '%';
    ui.colorOut.textContent = f.color.toUpperCase();
    $('dockFloor').textContent = pad(lift.to) + ' · ' + f.name;
    $('brandFloor').textContent = 'Floor ' + pad(lift.to);
    $('ftNum').textContent = pad(lift.to);
    $('ftName').textContent = f.name;
    document.documentElement.style.setProperty('--accent', f.color);
    floorButtons.forEach((b, i) => {
      b.setAttribute('aria-current', i === lift.to ? 'true' : 'false');
      b.style.setProperty('--dot', floors[i].color);
    });
    swatchButtons.forEach((b, i) => b.setAttribute('aria-pressed', Floors.THEMES[i].color === f.color.toLowerCase() ? 'true' : 'false'));
    $('upBtn').disabled = lift.to >= floors.length - 1;
    $('downBtn').disabled = lift.to <= 0;
  }

  function changed(colorChanged) {
    renderer.setFloors(floors);
    if (colorChanged) renderer.invalidateProbes(lift.to, false);
    paramsChanged = true;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => Floors.save(floors), 400);
  }

  function bindRange(el, key, out, fmt) {
    el.addEventListener('input', () => {
      floors[lift.to][key] = parseFloat(el.value);
      out.textContent = fmt(parseFloat(el.value));
      setRangeFill(el);
      changed(false);
    });
  }
  bindRange(ui.intensity, 'intensity', ui.intensityOut, (v) => Math.round(v * 100) + '%');
  bindRange(ui.reflect, 'reflect', ui.reflectOut, (v) => Math.round(v * 100) + '%');
  bindRange(ui.haze, 'haze', ui.hazeOut, (v) => Math.round(v * 100) + '%');

  function applyColor(hex) {
    Floors.setColor(floors[lift.to], hex);
    syncUI();
    changed(true);
  }
  ui.color.addEventListener('input', () => applyColor(ui.color.value));

  $('resetBtn').addEventListener('click', () => {
    Floors.reset(floors, lift.to);
    syncUI();
    changed(true);
  });

  // ------------------------------------------------------------------ elevator
  let titleTimer = 0;
  function goTo(target) {
    target = clamp(target, 0, floors.length - 1);
    if (target === lift.to) return;
    lift.from = lift.pos;
    lift.to = target;
    lift.t0 = performance.now();
    lift.dur = 1300 + 380 * Math.min(Math.abs(lift.to - lift.from), 4);
    lift.moving = true;
    syncUI();
    $('floorTitle').classList.add('show');
    clearTimeout(titleTimer);
    $('hint').classList.add('fade');
  }
  $('upBtn').addEventListener('click', () => goTo(lift.to + 1));
  $('downBtn').addEventListener('click', () => goTo(lift.to - 1));

  window.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowUp' || e.key === 'PageUp') { e.preventDefault(); goTo(lift.to + 1); }
    else if (e.key === 'ArrowDown' || e.key === 'PageDown') { e.preventDefault(); goTo(lift.to - 1); }
    else if ((e.key === 'h' || e.key === 'H') && e.target === document.body) document.body.classList.toggle('ui-hidden');
  }, true);

  // vertical swipe on touch screens
  let touchY = null;
  canvas.addEventListener('touchstart', (e) => { touchY = e.touches[0].clientY; }, { passive: true });
  canvas.addEventListener('touchend', (e) => {
    if (touchY === null) return;
    const dy = e.changedTouches[0].clientY - touchY;
    touchY = null;
    if (Math.abs(dy) > 50) goTo(lift.to + (dy < 0 ? 1 : -1));
  }, { passive: true });

  function updateLift(now) {
    if (!lift.moving) return;
    const t = clamp((now - lift.t0) / lift.dur, 0, 1);
    lift.pos = lift.from + (lift.to - lift.from) * easeInOut(t);
    if (t >= 1) {
      lift.pos = lift.to;
      lift.moving = false;
      current = lift.to;
      titleTimer = setTimeout(() => $('floorTitle').classList.remove('show'), 900);
    }
  }

  function pulse(t) {
    const x = 0.5 + 0.5 * Math.sin((2 * Math.PI * t) / PULSE_PERIOD - Math.PI / 2);
    return 0.05 + 0.95 * Math.pow(x, 1.6);
  }

  // ------------------------------------------------------------------ loop
  let started = false;
  let fade = 0;
  let dolly = 0;
  let last = performance.now();
  let frameCount = 0;
  const startTime = performance.now();

  function visibleFloors() {
    const a = clamp(Math.floor(lift.pos + 1e-4), 0, floors.length - 1);
    const b = clamp(Math.ceil(lift.pos - 1e-4), 0, floors.length - 1);
    // the destination first so its GI converges first
    return lift.to === b ? (a === b ? [b] : [b, a]) : (a === b ? [a] : [a, b]);
  }

  function frame(now) {
    if (window.__error) return;
    const dt = Math.min(now - last, 100);
    last = now;
    try {
      if (!started) {
        if (!renderer.isReady()) { requestAnimationFrame(frame); return; }
        started = true;
        resize();
        $('loaderNote').textContent = 'Simulating light bounces…';
      }
      updateLift(now);
      const time = FIXED_TIME !== null ? FIXED_TIME : (now - startTime) / 1000;
      const vis = visibleFloors();

      if (TEST_FRAMES && fade === 0) {
        // headless capture: converge GI fully before accumulating frames
        while (!renderer.probesConverged(lift.to)) renderer.updateProbes(time, [lift.to]);
        $('loader').classList.add('done');
        $('loader').style.transition = 'none';
        fade = 1;
      }
      // initial GI: spend a few extra probe updates per frame before showing the room
      const progress = renderer.probeProgress(lift.to);
      if (fade === 0 && progress < 0.55) {
        renderer.updateProbes(time, [lift.to]);
        renderer.updateProbes(time, [lift.to]);
        $('loaderBar').style.width = Math.round(10 + 90 * progress / 0.55) + '%';
      } else if (fade === 0) {
        $('loader').classList.add('done');
        fade = 0.0001;
      }
      if (fade > 0) fade = Math.min(1, fade + dt / 900);

      // the camera eases back out of the room while travelling, so the trip reads as a building
      // section; driven by the remaining distance so re-targeting mid-trip stays smooth
      const s = clamp(Math.abs(lift.to - lift.pos) / 0.45, 0, 1);
      const dollyTarget = lift.moving ? DOLLY * s * s * (3 - 2 * s) : 0;
      dolly = TEST_FRAMES ? dollyTarget : dolly + (dollyTarget - dolly) * (1 - Math.exp(-dt / 220));
      const camPos = [0, EYE_H + lift.pos * FLOOR_H, -dolly];
      const f = floors[lift.to];
      renderer.render({
        time,
        camPos,
        visibleFloors: vis,
        pulse: pulse(time),
        paramsChanged,
        debug: DEBUG,
        exposure: Floors.EXPOSURE,
        bloomStrength: 0.045 + 0.11 * f.haze,
        vignette: 0.22,
        fade: easeInOut(fade),
        minAlpha: 0.04,
      });
      paramsChanged = false;
      if (fade >= 1) adaptResolution(dt, now);
      frameCount++;
      if (TEST_FRAMES && frameCount >= TEST_FRAMES) { window.__done = true; return; }
    } catch (err) {
      showError(err);
      return;
    }
    requestAnimationFrame(frame);
  }

  document.addEventListener('visibilitychange', () => { last = performance.now(); });
  syncUI();
  {
    const dock = document.querySelector('.dock');
    document.documentElement.style.setProperty('--dock-h', Math.round(window.innerHeight - dock.getBoundingClientRect().top) + 'px');
  }
  requestAnimationFrame(frame);

  window.__atrium = { floors, renderer, goTo, lift };
})();
