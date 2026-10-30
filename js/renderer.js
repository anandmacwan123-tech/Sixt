/* Renderer: owns the WebGL2 context, render targets and the per-frame pass sequence. */
(function () {
  'use strict';

  const { Program, Target } = window.AtriumGL;
  const S = window.AtriumShaders;

  const NF = 8;
  const NUM_SLITS = 12;
  const PROBE_W = 78, PROBE_H = 192;
  const BLOOM_LEVELS = 6;

  // Reference photograph framing (2000 x 1449, focal 1875 px, vanishing point at 996, 747).
  const REF = { w: 2000, h: 1449, f: 1875, cx: 996, cyFromBottom: 1449 - 747 };

  function halton(i, b) {
    let f = 1, r = 0;
    while (i > 0) { f /= b; r += f * (i % b); i = Math.floor(i / b); }
    return r;
  }

  class Renderer {
    constructor(canvas, opts) {
      this.canvas = canvas;
      this.opts = Object.assign({ probeRays: 8, probeUpdatesPerFrame: 1, fogSteps: 12 }, opts || {});
      const gl = canvas.getContext('webgl2', {
        antialias: false, depth: false, stencil: false, alpha: false,
        premultipliedAlpha: false, preserveDrawingBuffer: !!this.opts.preserve, powerPreference: 'high-performance',
      });
      if (!gl) throw new Error('WebGL2 is not available in this browser.');
      this.gl = gl;
      if (!gl.getExtension('EXT_color_buffer_float') && !gl.getExtension('EXT_color_buffer_half_float')) {
        throw new Error('This GPU/browser cannot render to floating point textures (EXT_color_buffer_float).');
      }
      this.parallel = gl.getExtension('KHR_parallel_shader_compile');

      // fullscreen triangle
      this.vao = gl.createVertexArray();
      gl.bindVertexArray(this.vao);
      const vb = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, vb);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
      gl.enableVertexAttribArray(0);
      gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

      const vs = S.fullscreenVS;
      this.programs = {
        main: new Program(gl, vs, S.main, 'main'),
        probe: new Program(gl, vs, S.probe, 'probe'),
        taa: new Program(gl, vs, S.taa, 'taa'),
        combine: new Program(gl, vs, S.combine, 'combine'),
        bloomDown: new Program(gl, vs, S.bloomDown, 'bloomDown'),
        bloomUp: new Program(gl, vs, S.bloomUp, 'bloomUp'),
        final: new Program(gl, vs, S.final, 'final'),
      };

      // per-floor probe volumes (ping-pong)
      this.probes = [];
      for (let f = 0; f < NF; f++) {
        const pair = [new Target(gl, PROBE_W, PROBE_H, 1, { linear: true }), new Target(gl, PROBE_W, PROBE_H, 1, { linear: true })];
        pair[0].clear(0, 0, 0, 0);
        pair[1].clear(0, 0, 0, 0);
        this.probes.push({ pair, cur: 0, updates: 0, target: 72 });
      }
      this.probeFrame = 0;

      this.frameIndex = 0;
      this.accum = 0;
      this.histIdx = 0;
      this.histValid = false;
      this.internal = { w: 0, h: 0 };
      this.scale = this.opts.scale || 0.75;
      this.prevCam = null;
      this.floorData = {
        albedo: new Float32Array(NF * 3), panelTop: new Float32Array(NF * 3), panelBot: new Float32Array(NF * 3),
        led: new Float32Array(NF * 3), params: new Float32Array(NF * 4),
      };
      this.numFloors = NF;
      this.quality = this.opts.quality === undefined ? 1 : this.opts.quality;
      this.insetBottom = 0;
    }

    // Lower part of the output covered by UI (output pixels): the vanishing point is centred above it.
    setViewInset(px) { this.insetBottom = px; }

    setQuality(q) {
      if (q === this.quality) return;
      this.quality = q;
      this.accum = 0;
    }

    // True once all programs are compiled and linked.
    isReady() {
      return Object.values(this.programs).every((p) => p.ready(this.parallel));
    }

    setFloors(list) {
      const d = this.floorData;
      this.numFloors = Math.min(list.length, NF);
      for (let i = 0; i < NF; i++) {
        const fl = list[Math.min(i, list.length - 1)];
        d.albedo.set(fl.albedo, i * 3);
        d.panelTop.set(fl.panelTop, i * 3);
        d.panelBot.set(fl.panelBot, i * 3);
        d.led.set(fl.led, i * 3);
        d.params.set([fl.intensity, fl.reflect, fl.haze, fl.slitGlow], i * 4);
      }
    }

    // Colours of a floor changed: keep its current GI as the starting point and re-converge.
    invalidateProbes(f, full) {
      const p = this.probes[f];
      if (!p) return;
      p.updates = full ? 0 : Math.min(p.updates, 6);
    }

    resetAccumulation() { this.accum = 0; }

    // Size of the internal (ray traced) buffers.
    resize(outW, outH, scale) {
      const gl = this.gl;
      this.outW = outW;
      this.outH = outH;
      if (scale) this.scale = scale;
      const iw = Math.max(64, Math.round(outW * this.scale));
      const ih = Math.max(64, Math.round(outH * this.scale));
      if (iw === this.internal.w && ih === this.internal.h) return;
      this.disposeInternal();
      this.internal = { w: iw, h: ih };
      this.mainT = new Target(gl, iw, ih, 2, { linear: false });
      this.hist = [new Target(gl, iw, ih, 2, { linear: true }), new Target(gl, iw, ih, 2, { linear: true })];
      this.hdr = new Target(gl, iw, ih, 1, { linear: true });
      this.bloomDown = [];
      this.bloomUp = [];
      let w = iw, h = ih;
      for (let i = 0; i < BLOOM_LEVELS; i++) {
        w = Math.max(1, w >> 1); h = Math.max(1, h >> 1);
        this.bloomDown.push(new Target(gl, w, h, 1, { linear: true }));
        if (i < BLOOM_LEVELS - 1) this.bloomUp.push(new Target(gl, w, h, 1, { linear: true }));
      }
      this.histValid = false;
      this.accum = 0;
    }

    disposeInternal() {
      if (!this.mainT) return;
      this.mainT.dispose();
      this.hist.forEach((t) => t.dispose());
      this.hdr.dispose();
      this.bloomDown.forEach((t) => t.dispose());
      this.bloomUp.forEach((t) => t.dispose());
    }

    camera(w, h) {
      const sc = Math.min(w / REF.w, h / REF.h), sv = Math.max(w / REF.w, h / REF.h);
      let s = Math.sqrt(sc * sv);
      // keep the horizontal field of view within reason on very wide screens
      s = Math.max(s, w / (2 * Math.tan(37 * Math.PI / 180) * REF.f));
      const inset = this.outH ? this.insetBottom * (h / this.outH) : 0;
      return {
        focal: REF.f * s,
        cx: w / 2 + (REF.cx - REF.w / 2) * s,
        cy: h / 2 + (REF.cyFromBottom - REF.h / 2) * s + inset * 0.5,
      };
    }

    bindCommon(p, time, frame) {
      const d = this.floorData;
      p.f3v('uAlbedo', d.albedo).f3v('uPanelTop', d.panelTop).f3v('uPanelBot', d.panelBot).f3v('uLedCol', d.led)
        .f4v('uFloorP', d.params).i1('uNumFloors', this.numFloors).f1('uTime', time).i1('uFrame', frame)
        .i1('uNumSlits', NUM_SLITS).i1('uFogSteps', this.quality > 0 ? this.opts.fogSteps : 6)
        .i1('uQuality', this.quality);
    }

    draw() { this.gl.drawArrays(this.gl.TRIANGLES, 0, 3); }

    updateProbes(time, priority) {
      const budget = this.opts.probeUpdatesPerFrame;
      let done = 0;
      const order = priority.concat([...Array(this.numFloors).keys()].filter((f) => priority.indexOf(f) < 0));
      for (const f of order) {
        if (done >= budget) break;
        const st = this.probes[f];
        if (!st || st.updates >= st.target) continue;
        const src = st.pair[st.cur], dst = st.pair[1 - st.cur];
        const p = this.programs.probe.use();
        this.bindCommon(p, time, this.probeFrame++);
        p.tex('uProbePrev', 0, src.tex).i1('uProbeFloor', f)
          .f1('uProbeAlpha', Math.max(1 / (st.updates + 1), 0.06)).i1('uProbeRays', this.opts.probeRays);
        dst.bind();
        this.draw();
        st.cur = 1 - st.cur;
        st.updates++;
        done++;
      }
      return done;
    }

    probesConverged(f) { const s = this.probes[f]; return s && s.updates >= s.target; }
    probeProgress(f) { const s = this.probes[f]; return s ? Math.min(1, s.updates / s.target) : 1; }

    render(st) {
      const gl = this.gl;
      const iw = this.internal.w, ih = this.internal.h;
      const cam = this.camera(iw, ih);
      const time = st.time;

      // ---- GI probes
      const prio = st.visibleFloors.slice();
      this.updateProbes(time, prio);

      // ---- temporal state
      const moved = this.prevCam && (Math.abs(this.prevCam[1] - st.camPos[1]) > 1e-5 || Math.abs(this.prevCam[2] - st.camPos[2]) > 1e-5);
      if (moved) this.accum = 0;
      if (st.paramsChanged) this.accum = Math.min(this.accum, 3);
      const n = this.frameIndex % 16;
      const jx = halton(n + 1, 2) - 0.5, jy = halton(n + 1, 3) - 0.5;

      // ---- main ray traced pass
      const pa = st.visibleFloors[0], pb = st.visibleFloors.length > 1 ? st.visibleFloors[1] : st.visibleFloors[0];
      let p = this.programs.main.use();
      this.bindCommon(p, time, this.frameIndex);
      p.f3('uCamPos', st.camPos[0], st.camPos[1], st.camPos[2]).f2('uRes', iw, ih).f1('uFocal', cam.focal)
        .f2('uPrincipal', cam.cx, cam.cy).f2('uJitter', jx, jy).i1('uDebug', st.debug || 0)
        .tex('uProbe0', 0, this.probes[pa].pair[this.probes[pa].cur].tex).i1('uProbeFloor0', pa)
        .tex('uProbe1', 1, this.probes[pb].pair[this.probes[pb].cur].tex).i1('uProbeFloor1', pb);
      this.mainT.bind();
      this.draw();

      // ---- temporal accumulation
      const prev = this.hist[this.histIdx], next = this.hist[1 - this.histIdx];
      let alpha, gamma;
      if (moved) { alpha = 0.32; gamma = 1.0; }
      else { alpha = Math.max(1 / (this.accum + 1), st.minAlpha || 0.04); gamma = this.accum < 8 ? 1.25 : 2.0; }
      p = this.programs.taa.use();
      p.tex('uCur0', 0, this.mainT.textures[0]).tex('uCur1', 1, this.mainT.textures[1])
        .tex('uHist0', 2, prev.textures[0]).tex('uHist1', 3, prev.textures[1])
        .f3('uCamPos', st.camPos[0], st.camPos[1], st.camPos[2])
        .f3('uPrevCamPos', ...(this.prevCam || st.camPos))
        .f1('uFocal', cam.focal).f2('uPrincipal', cam.cx, cam.cy).f2('uRes', iw, ih)
        .f1('uAlpha', alpha).f1('uHistValid', this.histValid ? 1 : 0).f1('uClampGamma', gamma);
      next.bind();
      this.draw();
      this.histIdx = 1 - this.histIdx;
      this.histValid = true;

      // ---- combine static + slit light
      p = this.programs.combine.use();
      p.f4v('uFloorP', this.floorData.params).f1('uPulse', st.pulse)
        .tex('uHist0', 0, next.textures[0]).tex('uHist1', 1, next.textures[1]);
      this.hdr.bind();
      this.draw();

      // ---- bloom
      let src = this.hdr;
      p = this.programs.bloomDown.use();
      for (let i = 0; i < BLOOM_LEVELS; i++) {
        const dst = this.bloomDown[i];
        p.tex('uSrc', 0, src.tex).f2('uSrcTexel', 1 / src.w, 1 / src.h).f2('uDstRes', dst.w, dst.h).i1('uFirst', i === 0 ? 1 : 0);
        dst.bind();
        this.draw();
        src = dst;
      }
      p = this.programs.bloomUp.use();
      src = this.bloomDown[BLOOM_LEVELS - 1];
      for (let i = BLOOM_LEVELS - 2; i >= 0; i--) {
        const dst = this.bloomUp[i];
        // add the upsampled lower level onto this level's downsample
        gl.bindFramebuffer(gl.FRAMEBUFFER, dst.fbo);
        gl.viewport(0, 0, dst.w, dst.h);
        // copy level i first
        p.tex('uSrc', 0, this.bloomDown[i].tex).f2('uSrcTexel', 0, 0).f2('uDstRes', dst.w, dst.h).f1('uRadius', 0.0);
        this.draw();
        gl.enable(gl.BLEND);
        gl.blendFunc(gl.ONE, gl.ONE);
        p.tex('uSrc', 0, src.tex).f2('uSrcTexel', 1 / src.w, 1 / src.h).f2('uDstRes', dst.w, dst.h).f1('uRadius', 1.0);
        this.draw();
        gl.disable(gl.BLEND);
        src = dst;
      }

      // ---- final
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, this.outW, this.outH);
      p = this.programs.final.use();
      p.tex('uHdr', 0, this.hdr.tex).tex('uBloom', 1, this.bloomUp[0].tex)
        .f2('uOutRes', this.outW, this.outH).f1('uExposure', st.exposure)
        .f1('uBloomStrength', st.bloomStrength).f1('uVignette', st.vignette).f1('uFade', st.fade);
      this.draw();

      this.prevCam = st.camPos.slice();
      this.frameIndex++;
      this.accum++;
    }
  }

  Renderer.NF = NF;
  Renderer.REF = REF;
  window.AtriumRenderer = Renderer;
})();
