/* Small WebGL2 helpers: programs with cached uniform locations, float render targets. */
(function () {
  'use strict';

  function compile(gl, type, src, label) {
    const sh = gl.createShader(type);
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
      const log = gl.getShaderInfoLog(sh) || '';
      const lines = src.split('\n');
      const m = /ERROR: \d+:(\d+)/.exec(log);
      let ctx = '';
      if (m) {
        const ln = parseInt(m[1], 10);
        ctx = lines.slice(Math.max(0, ln - 4), ln + 2).map((l, i) => (ln - 3 + i) + ': ' + l).join('\n');
      }
      throw new Error('Shader compile failed (' + label + '):\n' + log + '\n' + ctx);
    }
    return sh;
  }

  class Program {
    constructor(gl, vsSrc, fsSrc, label) {
      this.gl = gl;
      this.label = label;
      const p = gl.createProgram();
      this.vs = compile(gl, gl.VERTEX_SHADER, vsSrc, label + ' (vs)');
      this.fs = compile(gl, gl.FRAGMENT_SHADER, fsSrc, label + ' (fs)');
      gl.attachShader(p, this.vs);
      gl.attachShader(p, this.fs);
      gl.bindAttribLocation(p, 0, 'aPos');
      gl.linkProgram(p);
      this.program = p;
      this.uniforms = new Map();
      this.units = new Map();
    }
    // KHR_parallel_shader_compile friendly status check
    ready(ext) {
      const gl = this.gl;
      if (ext && !gl.getProgramParameter(this.program, ext.COMPLETION_STATUS_KHR)) return false;
      if (!gl.getProgramParameter(this.program, gl.LINK_STATUS)) {
        const fsOk = gl.getShaderParameter(this.fs, gl.COMPILE_STATUS);
        const vsOk = gl.getShaderParameter(this.vs, gl.COMPILE_STATUS);
        throw new Error('Program "' + this.label + '" failed: ' + gl.getProgramInfoLog(this.program) +
          (!fsOk ? '\n' + gl.getShaderInfoLog(this.fs) : '') + (!vsOk ? '\n' + gl.getShaderInfoLog(this.vs) : ''));
      }
      return true;
    }
    use() { this.gl.useProgram(this.program); return this; }
    loc(name) {
      let l = this.uniforms.get(name);
      if (l === undefined) {
        l = this.gl.getUniformLocation(this.program, name);
        this.uniforms.set(name, l);
      }
      return l;
    }
    f1(n, v) { const l = this.loc(n); if (l) this.gl.uniform1f(l, v); return this; }
    i1(n, v) { const l = this.loc(n); if (l) this.gl.uniform1i(l, v); return this; }
    f2(n, a, b) { const l = this.loc(n); if (l) this.gl.uniform2f(l, a, b); return this; }
    f3(n, a, b, c) { const l = this.loc(n); if (l) this.gl.uniform3f(l, a, b, c); return this; }
    f3v(n, arr) { const l = this.loc(n); if (l) this.gl.uniform3fv(l, arr); return this; }
    f4v(n, arr) { const l = this.loc(n); if (l) this.gl.uniform4fv(l, arr); return this; }
    tex(n, unit, texture) {
      const gl = this.gl;
      gl.activeTexture(gl.TEXTURE0 + unit);
      gl.bindTexture(gl.TEXTURE_2D, texture);
      const l = this.loc(n);
      if (l) gl.uniform1i(l, unit);
      return this;
    }
  }

  function makeTexture(gl, w, h, opts) {
    opts = opts || {};
    const t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, w, h, 0, gl.RGBA, gl.HALF_FLOAT, null);
    const filter = opts.linear ? gl.LINEAR : gl.NEAREST;
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return t;
  }

  class Target {
    // A framebuffer with one or more RGBA16F colour attachments.
    constructor(gl, w, h, count, opts) {
      this.gl = gl;
      this.w = w;
      this.h = h;
      this.textures = [];
      this.fbo = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
      const bufs = [];
      for (let i = 0; i < count; i++) {
        const t = makeTexture(gl, w, h, opts);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0 + i, gl.TEXTURE_2D, t, 0);
        this.textures.push(t);
        bufs.push(gl.COLOR_ATTACHMENT0 + i);
      }
      gl.drawBuffers(bufs);
      const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
      if (status !== gl.FRAMEBUFFER_COMPLETE) throw new Error('Framebuffer incomplete: 0x' + status.toString(16));
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    }
    get tex() { return this.textures[0]; }
    bind() {
      const gl = this.gl;
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
      gl.viewport(0, 0, this.w, this.h);
    }
    clear(r, g, b, a) {
      const gl = this.gl;
      this.bind();
      for (let i = 0; i < this.textures.length; i++) gl.clearBufferfv(gl.COLOR, i, [r, g, b, a]);
    }
    dispose() {
      const gl = this.gl;
      this.textures.forEach((t) => gl.deleteTexture(t));
      gl.deleteFramebuffer(this.fbo);
    }
  }

  window.AtriumGL = { Program, Target, makeTexture };
})();
