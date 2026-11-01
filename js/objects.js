/*
 * Interior objects: insert blank shapes, place them on the floor, walls or ceiling (or on
 * other objects), select, drag, and edit roughness, size, height and turn.
 */
(function () {
  'use strict';

  const Scene = window.AtriumScene;
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const DEFAULT = { size: 0.6, stretch: 1, rough: 0.35, spin: 0 };

  function create(h) {
    // h: { canvas, renderer, floors, floor(), camPos(), busy(), changed(moved) }
    const { canvas, renderer, floors } = h;
    const st = { mode: 'idle', sel: -1, ghost: null, drag: null, touch: false };
    const $ = (id) => document.getElementById(id);
    const bar = $('objbar'), tray = $('tray');
    const ui = { rough: $('objRough'), size: $('objSize'), stretch: $('objStretch'), spin: $('objSpin') };

    const list = () => floors[h.floor()].objects;

    // ---------------------------------------------------------------- renderer sync
    function sync() {
      const per = floors.map((fl, f) => fl.objects.map((o) => Scene.resolve(o, f)));
      let sel = null;
      const f = h.floor();
      if (st.ghost && st.ghost.ok) {
        per[f].push(Scene.resolve(st.ghost.obj, f));
        sel = { floor: f, index: per[f].length - 1 };
      } else if (st.sel >= 0) {
        sel = { floor: f, index: st.sel };
      }
      renderer.setObjects(per, sel);
    }

    // ---------------------------------------------------------------- picking
    function pick(e, skip) {
      const r = canvas.getBoundingClientRect();
      const W = canvas.width, H = canvas.height;
      const x = (e.clientX - r.left) * W / r.width, y = (r.bottom - e.clientY) * H / r.height;
      const cam = renderer.camera(W, H);
      const d = [(x - cam.cx) / cam.focal, (y - cam.cy) / cam.focal, 1];
      const l = Math.hypot(d[0], d[1], d[2]);
      const f = h.floor();
      const objs = floors[f].objects.map((o) => Scene.resolve(o, f));
      return Scene.raycast(h.camPos(), [d[0] / l, d[1] / l, d[2] / l], { numFloors: floors.length, objs, skip: skip === undefined ? -1 : skip });
    }
    // where an object would stand for a hit (null: not a place for objects)
    function standOn(hit) {
      if (!hit || hit.panel || hit.p[2] < Scene.Z_FRONT + 0.05) return null;
      let n = hit.n.slice();
      if (n[1] > 0.92) n = [0, 1, 0];
      else if (n[1] < -0.92) n = [0, -1, 0];
      else if (Math.abs(n[1]) < 0.3) { const l = Math.hypot(n[0], n[2]) || 1; n = [n[0] / l, 0, n[2] / l]; }
      return { p: [hit.p[0], hit.p[1] - h.floor() * Scene.FLOOR_H, hit.p[2]], n };
    }

    // ---------------------------------------------------------------- selection & edit bar
    function select(i) {
      st.sel = i;
      const o = i >= 0 ? list()[i] : null;
      document.body.classList.toggle('show-obj', !!o);
      if (o) {
        ui.rough.value = o.rough;
        ui.size.value = o.size;
        ui.stretch.value = Math.log(o.stretch) / Math.log(4);
        ui.spin.value = ((o.spin * 180 / Math.PI) % 360 + 360) % 360;
        Object.values(ui).forEach(fill);
      }
      sync();
    }
    function fill(el) { el.style.setProperty('--pct', ((el.value - el.min) / (el.max - el.min)) * 100 + '%'); }

    function edit(fn) {
      const o = list()[st.sel];
      if (!o) return;
      fn(o);
      sync();
      h.changed(true);
    }
    ui.rough.addEventListener('input', () => { fill(ui.rough); edit((o) => { o.rough = parseFloat(ui.rough.value); }); });
    ui.size.addEventListener('input', () => { fill(ui.size); edit((o) => { o.size = parseFloat(ui.size.value); }); });
    ui.stretch.addEventListener('input', () => { fill(ui.stretch); edit((o) => { o.stretch = Math.pow(4, parseFloat(ui.stretch.value)); }); });
    ui.spin.addEventListener('input', () => { fill(ui.spin); edit((o) => { o.spin = parseFloat(ui.spin.value) * Math.PI / 180; }); });

    function remove() {
      if (st.sel < 0) return;
      list().splice(st.sel, 1);
      select(-1);
      h.changed(true);
      refreshShapes();
    }
    $('objDelete').addEventListener('click', remove);
    $('objCopy').addEventListener('click', () => {
      const o = list()[st.sel];
      if (o) beginPlace(o.shape, o);
    });

    // ---------------------------------------------------------------- insert palette
    const insertBtn = $('objBtn');
    const shapeButtons = [...document.querySelectorAll('#shapes [data-shape]')];
    function openShapes(on) {
      tray.classList.toggle('open-shapes', on);
      insertBtn.setAttribute('aria-expanded', on ? 'true' : 'false');
    }
    function refreshShapes() {
      const full = list().length >= Scene.MAX_PER_FLOOR;
      shapeButtons.forEach((b) => { b.disabled = full; });
    }
    insertBtn.addEventListener('click', () => { refreshShapes(); openShapes(!tray.classList.contains('open-shapes')); });
    shapeButtons.forEach((b) => b.addEventListener('click', () => {
      openShapes(false);
      beginPlace(parseInt(b.dataset.shape, 10), null);
    }));

    // ---------------------------------------------------------------- placing
    function beginPlace(shape, from) {
      if (list().length >= Scene.MAX_PER_FLOOR) return;
      const src = from || DEFAULT;
      st.ghost = { ok: false, obj: { shape, p: [0, 0, 8], n: [0, 1, 0], spin: src.spin, size: src.size, stretch: src.stretch, rough: src.rough } };
      st.mode = 'place';
      select(-1);
      canvas.style.cursor = 'crosshair';
      document.body.classList.add('placing');
    }
    function moveGhost(e) {
      const s = standOn(pick(e));
      st.ghost.ok = !!s;
      if (s) { st.ghost.obj.p = s.p; st.ghost.obj.n = s.n; }
      sync();
      h.changed(false);
    }
    function endPlace(commit) {
      const g = st.ghost;
      st.ghost = null;
      st.mode = 'idle';
      canvas.style.cursor = '';
      document.body.classList.remove('placing');
      if (commit && g && g.ok) {
        list().push(g.obj);
        select(list().length - 1);
        h.changed(true);
      } else {
        sync();
        h.changed(false);
      }
      refreshShapes();
    }

    // ---------------------------------------------------------------- pointer
    canvas.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || h.busy()) return;
      st.touch = e.pointerType === 'touch';
      if (st.mode === 'place') {
        moveGhost(e);
        if (st.ghost.ok) endPlace(true);
        return;
      }
      const hit = pick(e);
      if (hit && hit.obj >= 0) {
        select(hit.obj);
        st.mode = 'drag';
        st.drag = { id: e.pointerId, x: e.clientX, y: e.clientY, moved: false };
        canvas.setPointerCapture(e.pointerId);
        canvas.style.cursor = 'grabbing';
      } else {
        st.touch = false;
        if (st.sel >= 0) select(-1);
      }
    });
    canvas.addEventListener('pointermove', (e) => {
      if (h.busy()) return;
      if (st.mode === 'place') { if (e.pointerType !== 'touch') moveGhost(e); return; }
      if (st.mode === 'drag' && st.drag && e.pointerId === st.drag.id) {
        if (!st.drag.moved && Math.hypot(e.clientX - st.drag.x, e.clientY - st.drag.y) < 4) return;
        st.drag.moved = true;
        const s = standOn(pick(e, st.sel));
        if (s) edit((o) => { o.p = s.p; o.n = s.n; });
        return;
      }
      if (e.pointerType !== 'touch') {
        const hit = pick(e);
        canvas.style.cursor = hit && hit.obj >= 0 ? 'grab' : '';
      }
    });
    function endDrag(e) {
      if (st.mode !== 'drag' || !st.drag || e.pointerId !== st.drag.id) return;
      st.mode = 'idle';
      st.drag = null;
      canvas.style.cursor = 'grab';
    }
    canvas.addEventListener('pointerup', endDrag);
    canvas.addEventListener('pointercancel', endDrag);
    canvas.addEventListener('contextmenu', (e) => { if (st.mode === 'place') { e.preventDefault(); endPlace(false); } });

    window.addEventListener('keydown', (e) => {
      const t = e.target;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) return;
      if (e.key === 'Escape') {
        if (st.mode === 'place') endPlace(false);
        else if (st.sel >= 0) select(-1);
        openShapes(false);
      } else if ((e.key === 'Delete' || e.key === 'Backspace') && st.sel >= 0 && st.mode === 'idle') {
        e.preventDefault();
        remove();
      }
    });

    sync();
    refreshShapes();

    return {
      sync,
      // leaving the floor: drop the selection and any placement
      floorChanged() {
        if (st.mode === 'place') endPlace(false);
        st.mode = 'idle';
        st.drag = null;
        select(-1);
        openShapes(false);
        refreshShapes();
      },
      // a touch that went to an object (so it is not a floor swipe)
      takeTouch() { const t = st.touch; st.touch = false; return t; },
      state: st,
      place: beginPlace,
      select,
    };
  }

  window.AtriumObjects = { create };
})();
