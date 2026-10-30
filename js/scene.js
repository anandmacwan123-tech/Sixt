/*
 * CPU copy of the scene's distance field, for picking: placing objects on the floor, walls and
 * ceiling, and selecting or dragging them. Kept in step with the GLSL in js/shaders.js.
 */
(function () {
  'use strict';

  const FLOOR_H = 4.4, CEIL_H = 3.685, Z_FRONT = 1.2, Z_END = 17.65, SIDE_XMAX = 4.6;
  const WALL_P = 2.41, WALL_Z0 = 8.32, WALL_C = [5.9651, 1.8939], WALL_R = 2.7736, FILLET = 0.8;
  const PANEL_Z = 17.05, PANEL_T = 0.08, PANEL_HW = 3.40, PANEL_Y0 = 0.17, PANEL_Y1 = 3.55, PANEL_R = 0.24;
  const PANEL_YC = 0.5 * (PANEL_Y0 + PANEL_Y1), PANEL_HH = 0.5 * (PANEL_Y1 - PANEL_Y0);
  const ROOM_Z0 = Z_FRONT - 2.0;

  // Shapes: unit width and height (the height is then scaled by the object's stretch).
  const SHAPES = [
    { id: 'sphere', h: 1.0 },
    { id: 'block', h: 1.0 },
    { id: 'cylinder', h: 1.0 },
    { id: 'pill', h: 1.4 },
    { id: 'ring', h: 0.24 },
    { id: 'cone', h: 1.0 },
  ];
  const MAX_PER_FLOOR = 12;

  const len2 = (x, y) => Math.sqrt(x * x + y * y);
  const len3 = (x, y, z) => Math.sqrt(x * x + y * y + z * z);
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  function smin(a, b, k) { const h = Math.max(k - Math.abs(a - b), 0) / k; return Math.min(a, b) - h * h * k * 0.25; }
  function smax(a, b, k) { return -smin(-a, -b, k); }
  function sdRoundRect(px, py, bx, by, r) {
    const qx = Math.abs(px) - bx + r, qy = Math.abs(py) - by + r;
    return len2(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
  }
  function sdBox(x, y, z, bx, by, bz) {
    const qx = Math.abs(x) - bx, qy = Math.abs(y) - by, qz = Math.abs(z) - bz;
    return len3(Math.max(qx, 0), Math.max(qy, 0), Math.max(qz, 0)) + Math.min(Math.max(qx, Math.max(qy, qz)), 0);
  }

  // ---------------------------------------------------------------- room
  function sdPanel(x, u) {
    const disk = len2(x - WALL_C[0], u - WALL_C[1]) - WALL_R;
    return smax(disk, Math.max(-u, u - WALL_P), 0.35);
  }
  function cellAir(x, y, z) {
    const ax = Math.abs(x);
    const k = Math.ceil((z - WALL_Z0) / WALL_P);
    const u = z - (WALL_Z0 + (k - 1) * WALL_P);
    const wall = Math.min(sdPanel(ax, u), sdPanel(ax, u + WALL_P));
    let d = smax(-y, y - CEIL_H, FILLET);
    d = smax(d, -wall, FILLET);
    d = smax(d, z - Z_END, FILLET);
    d = Math.max(d, ROOM_Z0 - z);
    return Math.max(d, ax - SIDE_XMAX);
  }
  function panelSDF(x, y, z) {
    const r = sdRoundRect(x, y - PANEL_YC, PANEL_HW, PANEL_HH, PANEL_R);
    return Math.max(r, Math.abs(z - (PANEL_Z + 0.5 * PANEL_T)) - 0.5 * PANEL_T);
  }
  // returns distance; out.panel = true when the end panel is the nearest surface
  function roomMap(x, y, z, numFloors, out) {
    const n = Math.floor(y / FLOOR_H);
    const ly = y - n * FLOOR_H;
    let air = z - Z_FRONT, dp = 1e3;
    if (n >= 0 && n < numFloors) {
      air = Math.min(air, cellAir(x, ly, z));
      dp = panelSDF(x, ly, z);
    }
    if (out) out.panel = dp < -air;
    return Math.min(-air, dp);
  }

  // ---------------------------------------------------------------- objects
  function sdCappedCone(px, py, pz, h, r1, r2) {
    const qx = len2(px, pz), qy = py;
    const k1x = r2, k1y = h, k2x = r2 - r1, k2y = 2 * h;
    const cax = qx - Math.min(qx, qy < 0 ? r1 : r2), cay = Math.abs(qy) - h;
    const t = clamp(((k1x - qx) * k2x + (k1y - qy) * k2y) / (k2x * k2x + k2y * k2y), 0, 1);
    const cbx = qx - k1x + k2x * t, cby = qy - k1y + k2y * t;
    const s = cbx < 0 && cay < 0 ? -1 : 1;
    return s * Math.sqrt(Math.min(cax * cax + cay * cay, cbx * cbx + cby * cby));
  }
  function sdObj(k, x, y, z, w, hh) {
    if (k === 0) {
      const rx = 0.5 * w, ry = hh;
      const k0 = len3(x / rx, y / ry, z / rx), k1 = len3(x / (rx * rx), y / (ry * ry), z / (rx * rx));
      return k0 * (k0 - 1) / k1;
    }
    if (k === 1) { const rr = Math.min(0.06 * w, 0.5 * hh); return sdBox(x, y, z, 0.5 * w - rr, hh - rr, 0.5 * w - rr) - rr; }
    if (k === 2 || k === 4) {
      const rr = k === 2 ? Math.min(0.05 * w, 0.5 * hh) : Math.min(0.11 * w, hh);
      const dx = k === 2 ? len2(x, z) - 0.42 * w + rr : Math.abs(len2(x, z) - 0.4 * w) - 0.12 * w + rr;
      const dy = Math.abs(y) - hh + rr;
      return Math.min(Math.max(dx, dy), 0) + len2(Math.max(dx, 0), Math.max(dy, 0)) - rr;
    }
    if (k === 3) { const r = Math.min(0.3 * w, hh); const yy = y - clamp(y, r - hh, hh - r); return len3(x, yy, z) - r; }
    const rr = Math.min(0.035 * w, 0.5 * hh);
    return sdCappedCone(x, y, z, hh - rr, 0.45 * w - rr, 0.02 * w) - rr;
  }

  // vector maths
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const norm = (a) => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };

  // Orientation of an object standing on a surface with normal n, turned by spin (radians)
  // around it: columns x, y (= n), z. On walls the local z points up, so things hang level.
  function frame(n, spin) {
    const ref = Math.abs(n[1]) > 0.9 ? [0, 0, 1] : [0, 1, 0];
    const d = dot(ref, n);
    const z = norm([ref[0] - n[0] * d, ref[1] - n[1] * d, ref[2] - n[2] * d]);
    const x = cross(n, z);
    const c = Math.cos(spin), s = Math.sin(spin);
    return [
      [x[0] * c - z[0] * s, x[1] * c - z[1] * s, x[2] * c - z[2] * s],
      n,
      [x[0] * s + z[0] * c, x[1] * s + z[1] * c, x[2] * s + z[2] * c],
    ];
  }
  function quatFromFrame(m) {
    const [X, Y, Z] = m;   // columns
    const m00 = X[0], m11 = Y[1], m22 = Z[2];
    const tr = m00 + m11 + m22;
    let q;
    if (tr > 0) {
      const s = Math.sqrt(tr + 1) * 2;
      q = [(Y[2] - Z[1]) / s, (Z[0] - X[2]) / s, (X[1] - Y[0]) / s, 0.25 * s];
    } else if (m00 > m11 && m00 > m22) {
      const s = Math.sqrt(1 + m00 - m11 - m22) * 2;
      q = [0.25 * s, (Y[0] + X[1]) / s, (Z[0] + X[2]) / s, (Y[2] - Z[1]) / s];
    } else if (m11 > m22) {
      const s = Math.sqrt(1 + m11 - m00 - m22) * 2;
      q = [(Y[0] + X[1]) / s, 0.25 * s, (Z[1] + Y[2]) / s, (Z[0] - X[2]) / s];
    } else {
      const s = Math.sqrt(1 + m22 - m00 - m11) * 2;
      q = [(Z[0] + X[2]) / s, (Z[1] + Y[2]) / s, 0.25 * s, (X[1] - Y[0]) / s];
    }
    const l = Math.hypot(q[0], q[1], q[2], q[3]);
    return q.map((v) => v / l);
  }

  // World-space description of an object on floor f, as uploaded to the shader:
  // centre, width, quaternion, shape, roughness, half height, bounding radius.
  function resolve(o, f) {
    const shape = SHAPES[o.shape] || SHAPES[0];
    const hh = 0.5 * shape.h * o.size * o.stretch;
    const n = norm(o.n);
    const m = frame(n, o.spin);
    const c = [o.p[0] + n[0] * hh, o.p[1] + f * FLOOR_H + n[1] * hh, o.p[2] + n[2] * hh];
    const rough = 0.02 + 0.98 * clamp(o.rough, 0, 1);
    return { c, w: o.size, q: quatFromFrame(m), m, shape: o.shape, rough, hh, bound: Math.hypot(0.71 * o.size, hh) + 0.02 };
  }

  function objDist(r, x, y, z) {
    const dx = x - r.c[0], dy = y - r.c[1], dz = z - r.c[2];
    // into local space: transpose of the frame
    const lx = dx * r.m[0][0] + dy * r.m[0][1] + dz * r.m[0][2];
    const ly = dx * r.m[1][0] + dy * r.m[1][1] + dz * r.m[1][2];
    const lz = dx * r.m[2][0] + dy * r.m[2][1] + dz * r.m[2][2];
    return sdObj(r.shape, lx, ly, lz, r.w, r.hh);
  }

  // Scene distance with objects; hit.obj = index of the nearest object (or -1).
  function sceneMap(x, y, z, ctx, hit) {
    let d = roomMap(x, y, z, ctx.numFloors, hit);
    hit.obj = -1;
    for (let i = 0; i < ctx.objs.length; i++) {
      if (i === ctx.skip) continue;
      const di = objDist(ctx.objs[i], x, y, z);
      if (di < d) { d = di; hit.obj = i; }
    }
    return d;
  }

  // Sphere-trace a ray. ctx = { numFloors, objs: resolved objects, skip: index to ignore }.
  // Returns { p, n, obj, panel } or null.
  function raycast(ro, rd, ctx) {
    let t = 0;
    const hit = {};
    for (let i = 0; i < 220; i++) {
      const x = ro[0] + rd[0] * t, y = ro[1] + rd[1] * t, z = ro[2] + rd[2] * t;
      const d = sceneMap(x, y, z, ctx, hit);
      if (d < 0.0005 + 0.0004 * t) {
        const p = [x, y, z];
        const e = 0.002, h = {};
        const n = norm([
          sceneMap(x + e, y, z, ctx, h) - sceneMap(x - e, y, z, ctx, h),
          sceneMap(x, y + e, z, ctx, h) - sceneMap(x, y - e, z, ctx, h),
          sceneMap(x, y, z + e, ctx, h) - sceneMap(x, y, z - e, ctx, h),
        ]);
        sceneMap(x, y, z, ctx, hit);
        return { p, n, t, obj: hit.obj, panel: hit.obj < 0 && !!hit.panel };
      }
      t += d;
      if (t > 80) break;
    }
    return null;
  }

  window.AtriumScene = { FLOOR_H, Z_FRONT, SHAPES, MAX_PER_FLOOR, resolve, raycast, frame };
})();
