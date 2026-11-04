// renderer.js — WebGL2 HDR pipeline
//
//  per depth group:  canvas(albedo, emission) ──prep──▶ HDR layer (linear light, mipmapped)
//                    ──depth-of-field gather──▶ [motion blur] ──"over" blend──▶ accumulation
//  then:             accumulation ──camera shake──▶ sensor: exposure · noise · clipping · WB ──▶ sRGB
'use strict';

class Renderer {
  constructor(canvas) {
    this.canvas = canvas;
    const gl = canvas.getContext('webgl2', { preserveDrawingBuffer: true, antialias: false, alpha: false, premultipliedAlpha: false });
    if (!gl) throw new Error('WebGL2 is not available in this browser.');
    if (!gl.getExtension('EXT_color_buffer_float')) throw new Error('This GPU/browser lacks EXT_color_buffer_float (float render targets).');
    this.gl = gl;
    this.vao = gl.createVertexArray();
    this.progs = {};
    const fs = Renderer.SHADERS;
    for (const name in fs) if (name !== 'common') this.progs[name] = this._program(Renderer.VS, fs.common + fs[name]);
    this.srcAlb = this._tex8();
    this.srcEmi = this._tex8();
    this.groups = [];
    this.W = this.H = 0;
  }

  // ---------------------------------------------------------------- GL helpers
  _shader(type, src) {
    const gl = this.gl, s = gl.createShader(type);
    gl.shaderSource(s, src); gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
      const log = gl.getShaderInfoLog(s);
      console.error(src.split('\n').map((l, i) => (i + 1) + ': ' + l).join('\n'));
      throw new Error('Shader compile error: ' + log);
    }
    return s;
  }
  _program(vs, fs) {
    const gl = this.gl, p = gl.createProgram();
    gl.attachShader(p, this._shader(gl.VERTEX_SHADER, vs));
    gl.attachShader(p, this._shader(gl.FRAGMENT_SHADER, fs));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error('Link error: ' + gl.getProgramInfoLog(p));
    const u = {};
    const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
    for (let i = 0; i < n; i++) { const info = gl.getActiveUniform(p, i); u[info.name] = gl.getUniformLocation(p, info.name); }
    return { p, u };
  }
  _tex8() {
    const gl = this.gl, t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return t;
  }
  _target(mips) {
    const gl = this.gl, t = gl.createTexture();
    const levels = mips ? Math.floor(Math.log2(Math.max(this.W, this.H))) + 1 : 1;
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texStorage2D(gl.TEXTURE_2D, levels, gl.RGBA16F, this.W, this.H);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, mips ? gl.LINEAR_MIPMAP_LINEAR : gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    const fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t, 0);
    const st = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
    if (st !== gl.FRAMEBUFFER_COMPLETE) throw new Error('Framebuffer incomplete: 0x' + st.toString(16));
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return { tex: t, fbo };
  }
  _free(o) { if (!o) return; this.gl.deleteTexture(o.tex); this.gl.deleteFramebuffer(o.fbo); }

  _use(name) { const pr = this.progs[name]; this.gl.useProgram(pr.p); return pr.u; }
  _bindTex(u, unit, tex) {
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE0 + unit); gl.bindTexture(gl.TEXTURE_2D, tex); gl.uniform1i(u, unit);
  }
  _draw(target, blend, scissor) {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, target ? target.fbo : null);
    gl.viewport(0, 0, this.W, this.H);
    if (blend) { gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA); } else gl.disable(gl.BLEND);
    if (scissor) { gl.enable(gl.SCISSOR_TEST); gl.scissor(scissor[0], scissor[1], scissor[2], scissor[3]); }
    else gl.disable(gl.SCISSOR_TEST);
    gl.bindVertexArray(this.vao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.disable(gl.SCISSOR_TEST);
  }
  _clear(target) {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, target.fbo);
    gl.disable(gl.SCISSOR_TEST);
    gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
  }

  // ---------------------------------------------------------------- public API
  resize(W, H, groupCount) {
    if (W === this.W && H === this.H && this.groups.length === groupCount) return;
    this.canvas.width = W; this.canvas.height = H;
    this.W = W; this.H = H;
    [this.accum, this.tmpA, this.tmpB].forEach(o => this._free(o));
    this.groups.forEach(o => this._free(o));
    this.accum = this._target(true);
    this.tmpA = this._target(false);
    this.tmpB = this._target(true);
    this.groups = [];
    for (let i = 0; i < groupCount; i++) this.groups.push(this._target(true));
  }

  // Convert one depth group's canvases into a linear-light HDR texture.
  // subs: [{ alb: canvas, emi: canvas, amb: [r,g,b], emit: [r,g,b] }]   (drawn back → front)
  beginGroup(i) { this._clear(this.groups[i]); }
  addToGroup(i, albCanvas, emiCanvas, amb, emit) {
    const gl = this.gl;
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.bindTexture(gl.TEXTURE_2D, this.srcAlb);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, albCanvas);
    gl.bindTexture(gl.TEXTURE_2D, this.srcEmi);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, emiCanvas);
    const u = this._use('prep');
    this._bindTex(u.uAlb, 0, this.srcAlb);
    this._bindTex(u.uEmi, 1, this.srcEmi);
    gl.uniform2f(u.uRes, this.W, this.H);
    gl.uniform3fv(u.uAmb, amb);
    gl.uniform3fv(u.uEmit, emit);
    this._draw(this.groups[i], true);
  }
  endGroup(i) {
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.groups[i].tex);
    gl.generateMipmap(gl.TEXTURE_2D);
  }

  // Build the optical image (everything up to the sensor) into this.optical.
  composeOptical(p) {
    const gl = this.gl, W = this.W, H = this.H;
    this._clear(this.accum);
    p.groups.forEach(g => {
      const i = g.index;
      const box = g.bbox; // canvas pixels [x0,y0,x1,y1] or null
      const pad = (g.radius || 0) + 3;
      const sc = box ? this._sc(box[0] - pad, box[1] - pad, box[2] + pad, box[3] + pad) : null;
      const moving = g.motion && g.motion.active;
      // depth-of-field pass
      let u = this._use('dof');
      this._bindTex(u.uTex, 0, this.groups[i].tex);
      gl.uniform2f(u.uRes, W, H);
      gl.uniform1f(u.uRadius, g.ground ? 0 : g.radius);
      gl.uniform1i(u.uGround, g.ground ? 1 : 0);
      gl.uniform4f(u.uLens, p.lens.f, p.lens.N, p.lens.sMM, p.lens.pxPerMm);
      gl.uniform4f(u.uGeo, p.lens.S, SCENE.HZ, SCENE.F * SCENE.CH * 1000, p.lens.maxR);
      gl.uniform1f(u.uBlades, p.lens.blades);
      gl.uniform1f(u.uDiff, p.lens.diff);
      if (moving) { this._clear(this.tmpA); this._draw(this.tmpA, false, sc); }
      else this._draw(this.accum, true, sc);
      if (!moving) return;
      // motion-blur pass
      const m = g.motion;
      if (m.type === 'linear') {
        u = this._use('linmo');
        this._bindTex(u.uTex, 0, this.tmpA.tex);
        gl.uniform2f(u.uRes, W, H);
        gl.uniform1f(u.uV, m.v);
        gl.uniform1f(u.uT, p.t);
        gl.uniform2f(u.uBox, m.box[0] - pad, m.box[1] + pad);
        gl.uniform1f(u.uSeed, p.seed);
        this._draw(this.accum, true, box ? this._sc(0, box[1] - pad, W, box[3] + pad) : null);
      } else {
        u = this._use('rotmo');
        this._bindTex(u.uTex, 0, this.tmpA.tex);
        gl.uniform2f(u.uRes, W, H);
        gl.uniform2f(u.uC, m.c[0], m.c[1]);
        gl.uniform1f(u.uW, m.w);
        gl.uniform1f(u.uT, p.t);
        gl.uniform1f(u.uR, m.R + pad);
        gl.uniform1f(u.uSeed, p.seed);
        this._draw(this.accum, true, sc);
      }
    });
    // camera shake: smear the whole optical image along a wobbly path
    const L = Math.hypot(p.shake[0], p.shake[1]);
    if (L > 0.35) {
      const u = this._use('shake');
      this._bindTex(u.uTex, 0, this.accum.tex);
      gl.uniform2f(u.uRes, W, H);
      gl.uniform2f(u.uShake, p.shake[0], p.shake[1]);
      gl.uniform1f(u.uSeed, p.seed);
      this._draw(this.tmpB, false);
      this.optical = this.tmpB;
    } else this.optical = this.accum;
    gl.bindTexture(gl.TEXTURE_2D, this.optical.tex);
    gl.generateMipmap(gl.TEXTURE_2D);              // used by the lens-glare (bloom) pass
  }

  // Sensor + image processing → screen.
  develop(p) {
    const gl = this.gl;
    const u = this._use('final');
    this._bindTex(u.uTex, 0, this.optical.tex);
    gl.uniform2f(u.uRes, this.W, this.H);
    gl.uniform1f(u.uExp, p.exposure);
    gl.uniform3fv(u.uWB, p.wb);
    gl.uniform3f(u.uNoise, p.gain, p.shot, p.read);
    gl.uniform1f(u.uSeed, p.seed);
    gl.uniform1i(u.uZebra, p.zebra ? 1 : 0);
    gl.uniform1f(u.uTime, p.time || 0);
    gl.uniform1f(u.uBloom, p.bloom || 0);
    this._draw(null, false);
  }

  readPixels() {
    const gl = this.gl;
    if (!this._px || this._px.length !== this.W * this.H * 4) this._px = new Uint8Array(this.W * this.H * 4);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.readPixels(0, 0, this.W, this.H, gl.RGBA, gl.UNSIGNED_BYTE, this._px);
    return this._px;
  }

  // scissor rectangle from canvas-space box (FBO row 0 == canvas top row, so no flip)
  _sc(x0, y0, x1, y1) {
    x0 = Math.max(0, Math.floor(x0)); y0 = Math.max(0, Math.floor(y0));
    x1 = Math.min(this.W, Math.ceil(x1)); y1 = Math.min(this.H, Math.ceil(y1));
    return [x0, y0, Math.max(0, x1 - x0), Math.max(0, y1 - y0)];
  }
}

Renderer.VS = `#version 300 es
void main(){
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

Renderer.SHADERS = {
  common: `#version 300 es
precision highp float;
precision highp int;
out vec4 o;
uniform vec2 uRes;
vec3 toLin(vec3 c){ return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(0.04045, c)); }
vec3 toSRGB(vec3 c){ return mix(c * 12.92, 1.055 * pow(c, vec3(1.0/2.4)) - 0.055, step(0.0031308, c)); }
uvec3 pcg3d(uvec3 v){
  v = v * 1664525u + 1013904223u;
  v.x += v.y*v.z; v.y += v.z*v.x; v.z += v.x*v.y;
  v ^= v >> 16u;
  v.x += v.y*v.z; v.y += v.z*v.x; v.z += v.x*v.y;
  return v;
}
vec3 rand3(vec2 fc, float seed, uint k){
  return vec3(pcg3d(uvec3(uvec2(fc), uint(seed) * 4u + k))) / 4294967295.0;
}
`,

  // canvas (sRGB, premultiplied) → linear HDR radiance, premultiplied
  prep: `
uniform sampler2D uAlb, uEmi;
uniform vec3 uAmb, uEmit;
void main(){
  vec2 uv = gl_FragCoord.xy / uRes;
  vec4 a = texture(uAlb, uv), e = texture(uEmi, uv);
  vec3 al = a.a > 0.0 ? toLin(a.rgb / a.a) * a.a : vec3(0.0);
  vec3 el = e.a > 0.0 ? toLin(e.rgb / e.a) * e.a : vec3(0.0);
  o = vec4(al * uAmb + el * uEmit, a.a);
}`,

  // Depth of field: gather over the lens' circle of confusion, shaped by the iris blades.
  dof: `
uniform sampler2D uTex;
uniform float uRadius, uBlades, uDiff;
uniform int uGround;
uniform vec4 uLens; // f(mm), N, focus(mm), px per mm on sensor
uniform vec4 uGeo;  // screen px per base px, horizon y, camH*F*1000, max radius
float cocRadius(float dmm){
  float f = uLens.x, N = uLens.y, s = uLens.z;
  float c = (f * f / (N * max(s - f, 1.0))) * abs(dmm - s) / dmm;
  return 0.5 * c * uLens.w;
}
void main(){
  vec2 fc = gl_FragCoord.xy;
  float r = uRadius;
  if (uGround == 1) {
    float yb = 500.0 + (fc.y - uRes.y * 0.5) / uGeo.x;
    float dmm = yb > uGeo.y + 0.5 ? uGeo.z / (yb - uGeo.y) : 1e9;
    r = cocRadius(dmm);
    r = sqrt(r * r + uDiff * uDiff);
  }
  r = min(r, uGeo.w);
  if (r < 0.55) { o = textureLod(uTex, fc / uRes, 0.0); return; }
  const int T = 96;
  float lod = max(0.0, log2(r * 0.36));
  float rot = rand3(fc, 7.0, 0u).x * 6.2831853;
  float seg = 6.2831853 / 7.0;
  vec4 sum = vec4(0.0);
  for (int i = 0; i < T; i++) {
    float fi = float(i) + 0.5;
    float rr = sqrt(fi / float(T));
    float th = fi * 2.39996323 + rot;
    float a = mod(th, seg) - seg * 0.5;
    float k = mix(1.0, cos(seg * 0.5) / cos(a), uBlades);
    vec2 off = vec2(cos(th), sin(th)) * rr * k * r;
    sum += textureLod(uTex, (fc + off) / uRes, lod);
  }
  o = sum / float(T);
}`,

  // Linear motion blur: exact time-integral of an object moving horizontally at uV px/s
  // during an exposure of uT seconds (the object occupies uBox at the middle of the exposure).
  linmo: `
uniform sampler2D uTex;
uniform float uV, uT, uSeed;
uniform vec2 uBox;
void main(){
  vec2 fc = gl_FragCoord.xy;
  if (abs(uV) * uT < 0.3) { o = texture(uTex, fc / uRes); return; }
  float h = uT * 0.5;
  float t0 = (fc.x - uBox.y) / uV, t1 = (fc.x - uBox.x) / uV;
  float lo = max(min(t0, t1), -h), hi = min(max(t0, t1), h);
  if (hi <= lo) { o = vec4(0.0); return; }
  const int N = 128;
  float j = rand3(fc, uSeed, 1u).x;
  vec4 sum = vec4(0.0);
  for (int i = 0; i < N; i++) {
    float tau = lo + (float(i) + j) / float(N) * (hi - lo);
    sum += texture(uTex, vec2(fc.x - uV * tau, fc.y) / uRes);
  }
  o = sum / float(N) * ((hi - lo) / uT);
}`,

  // Rotational motion blur (pinwheel).
  rotmo: `
uniform sampler2D uTex;
uniform vec2 uC;
uniform float uW, uT, uR, uSeed;
void main(){
  vec2 fc = gl_FragCoord.xy;
  vec2 d = fc - uC;
  float L = length(d);
  float span = min(abs(uW) * uT, 6.2831853);
  if (L > uR || span * L < 0.3) { o = texture(uTex, fc / uRes); return; }
  const int N = 96;
  float j = rand3(fc, uSeed, 2u).x;
  vec4 sum = vec4(0.0);
  for (int i = 0; i < N; i++) {
    float a = (-0.5 + (float(i) + j) / float(N)) * span * sign(uW);
    float c = cos(a), s = sin(a);
    sum += texture(uTex, (uC + mat2(c, s, -s, c) * d) / uRes);
  }
  o = sum / float(N);
}`,

  // Handheld camera shake: average the image along a wobbly path.
  shake: `
uniform sampler2D uTex;
uniform vec2 uShake;
uniform float uSeed;
void main(){
  vec2 fc = gl_FragCoord.xy;
  vec2 dir = uShake, perp = vec2(-uShake.y, uShake.x);
  const int N = 64;
  float j = rand3(fc, uSeed, 3u).x;
  vec4 sum = vec4(0.0);
  for (int i = 0; i < N; i++) {
    float u = (float(i) + j) / float(N);
    vec2 off = dir * (u - 0.5 + 0.12 * sin(u * 17.0)) + perp * 0.28 * sin(u * 9.4 + 1.3);
    sum += texture(uTex, (fc + off) / uRes);
  }
  o = sum / float(N);
}`,

  // The sensor and the camera's processing.
  final: `
uniform sampler2D uTex;
uniform float uExp, uSeed, uTime, uBloom;
uniform vec3 uWB;
vec3 tent(vec2 uv, float lod){
  vec2 t = exp2(lod) / uRes;
  vec3 s = textureLod(uTex, uv, lod).rgb * 4.0;
  s += (textureLod(uTex, uv + vec2(t.x, 0.0), lod).rgb + textureLod(uTex, uv - vec2(t.x, 0.0), lod).rgb
      + textureLod(uTex, uv + vec2(0.0, t.y), lod).rgb + textureLod(uTex, uv - vec2(0.0, t.y), lod).rgb) * 2.0;
  s += textureLod(uTex, uv + t, lod).rgb + textureLod(uTex, uv - t, lod).rgb
     + textureLod(uTex, uv + vec2(t.x, -t.y), lod).rgb + textureLod(uTex, uv + vec2(-t.x, t.y), lod).rgb;
  return s / 16.0;
}
uniform vec3 uNoise; // ISO gain, shot-noise factor, read-noise
uniform int uZebra;
void main(){
  vec2 fc = gl_FragCoord.xy;
  vec2 uv = vec2(fc.x / uRes.x, 1.0 - fc.y / uRes.y);
  vec3 hdr = textureLod(uTex, uv, 0.0).rgb;
  // lens glare: a few % of the light scatters inside the lens → glow around bright lights
  vec3 glare = tent(uv, 2.0) * 0.25 + tent(uv, 4.0) * 0.4 + tent(uv, 6.0) * 0.35;
  hdr = mix(hdr, glare, uBloom);
  vec3 raw = max(hdr, 0.0) * uExp;                        // light × exposure × ISO gain
  // sensor noise: photon (shot) noise + read noise, amplified by ISO gain
  vec3 u1 = rand3(fc, uSeed, 4u), u2 = rand3(fc, uSeed, 5u);
  vec3 g = sqrt(-2.0 * log(max(u1, 1e-7))) * cos(6.2831853 * u2);
  vec3 gn = 0.66 * vec3(g.x * 0.75) + 0.75 * g;
  vec3 sigma = sqrt(raw * uNoise.x * uNoise.y + uNoise.x * uNoise.x * uNoise.z * uNoise.z);
  raw += sigma * gn;
  vec3 cl = step(vec3(0.999), raw);
  bool clipped = cl.r + cl.g + cl.b >= 2.0;               // blown in 2+ channels
  raw = clamp(raw, 0.0, 1.0);                             // sensor saturates: blown highlights
  vec3 c = clamp(raw * uWB, 0.0, 1.0);                    // white balance gains
  c = toSRGB(c);
  if (uZebra == 1 && clipped) {
    float z = step(1.0, mod((fc.x - fc.y) / 5.0 + uTime * 6.0, 2.0));
    c = mix(c, vec3(z, 0.0, z * 0.2) + vec3(0.0, 0.0, 0.0), 0.85);
  }
  o = vec4(c, 1.0);
}`,
};
