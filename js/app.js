// app.js — UI, camera logic and teaching explanations
'use strict';

(() => {
  const $ = id => document.getElementById(id);
  const { SHUTTERS, SHUTTER_LABELS, APERTURES, ISOS, SENSORS, WB_PRESETS } = CAM;
  const GROUPS = SCENE.GROUPS;

  // ------------------------------------------------------------------ state
  const DEFAULTS = {
    lighting: 'sunny', mode: 'M', autoISO: false,
    si: SHUTTER_LABELS.indexOf('1/500'), ai: APERTURES.indexOf(8), ii: 0, ec: 0,
    wb: 'auto', wbK: 5400, tint: 0,
    focal: 35, focus: 3, sensor: 'ff', support: 'handheld',
    carSpeed: 40, spin: true, zebra: true,
    af: [560, 563], focusName: 'Colour chart',
  };
  let S = clone(DEFAULTS);
  // Interface level: 'simple' (exposure triangle only) or 'advanced' (every setting). Kept outside S
  // so Reset and snapshots don't change it.
  let UI = 'simple';
  try { UI = localStorage.getItem('camsim-ui') === 'advanced' ? 'advanced' : 'simple'; } catch (e) { /* storage blocked */ }
  S.seed = 1; S.last = 'welcome';
  function clone(o) { return JSON.parse(JSON.stringify(o, (k, v) => v === Infinity ? 'Inf' : v), (k, v) => v === 'Inf' ? Infinity : v); }

  // ------------------------------------------------------------------ renderer
  let R;
  try { R = new Renderer($('view')); }
  catch (e) { const m = $('frameMsg'); m.hidden = false; m.textContent = '⚠ ' + e.message + ' Try a recent Chrome, Edge, Firefox or Safari.'; return; }

  const albCv = document.createElement('canvas'), emiCv = document.createElement('canvas');
  const albCtx = albCv.getContext('2d'), emiCtx = emiCv.getContext('2d');
  const PICK = 4; // pick-map downsampling
  let picks = [], pickData = [], bboxes = [], visible = [];
  let geo = { Z: 1, Sc: 1 };
  let needRebuild = true, rafId = 0, lastDev = null, lastHist = null, D = null;

  function sizeFor() {
    const fr = $('frame');
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    let W = Math.min(1350, Math.max(480, Math.round(fr.clientWidth * dpr)));
    W -= W % 6;
    return [W, W * 2 / 3];
  }
  // Fit the 3:2 photo into the space left by the readouts (one-screen layout).
  function fitFrame() {
    const st = $('stage'), fr = $('frame');
    if (getComputedStyle(st).flexGrow === '0') { fr.style.width = fr.style.height = ''; return; } // stacked layout
    const w = Math.floor(Math.min(st.clientWidth, st.clientHeight * 1.5));
    fr.style.width = w + 'px'; fr.style.height = Math.floor(w / 1.5) + 'px';
  }
  function ensureSize() {
    fitFrame();
    const [W, H] = sizeFor();
    if (W === R.W && H === R.H) return;
    R.resize(W, H, GROUPS.length);
    albCv.width = emiCv.width = W; albCv.height = emiCv.height = H;
    picks = GROUPS.map(() => { const c = document.createElement('canvas'); c.width = Math.floor(W / PICK); c.height = Math.floor(H / PICK); return c; });
    needRebuild = true;
  }

  // Draw every depth group (vector drawing → canvas → HDR texture).
  function rebuildLayers() {
    const L = SCENE.LIGHTING[S.lighting], sen = SENSORS[S.sensor], W = R.W, H = R.H;
    const Z = 1.5 * S.focal / sen.width;           // zoom relative to the 24 mm full-frame base view
    const Sc = Z * W / SCENE.W;                      // screen px per base px
    geo = { Z, Sc };
    const amb = CAM.lightTint(L.ambK);
    const lamp = CAM.lightTint(L.lampK);
    const led = CAM.lightTint(5000);
    const emit = kind => kind === 'sky' ? amb.map(v => v * L.sky) : kind === 'sun' ? amb.map(v => v * L.sun)
      : kind === 'car' ? led.map(v => v * L.lamp * 8) : lamp.map(v => v * L.lamp);
    GROUPS.forEach((g, i) => {
      R.beginGroup(i);
      const pc = picks[i], px = pc.getContext('2d', { willReadFrequently: true });
      px.clearRect(0, 0, pc.width, pc.height);
      g.subs.forEach(sub => {
        for (const c of [albCtx, emiCtx]) {
          c.setTransform(1, 0, 0, 1, 0, 0); c.clearRect(0, 0, W, H);
          c.setTransform(Sc, 0, 0, Sc, W / 2 - 750 * Sc, H / 2 - 500 * Sc);
          c.save();
        }
        // Emission is drawn additively onto opaque black: 8-bit sRGB values keep far more
        // precision in faint glows than alpha does (no banding once multiplied by lamp power).
        emiCtx.save(); emiCtx.setTransform(1, 0, 0, 1, 0, 0); emiCtx.fillStyle = '#000'; emiCtx.fillRect(0, 0, W, H); emiCtx.restore();
        if (sub.kind !== 'sky') emiCtx.globalCompositeOperation = 'lighter';
        sub.draw(albCtx, emiCtx, L);
        albCtx.restore(); emiCtx.restore();
        R.addToGroup(i, albCv, emiCv, amb, emit(sub.kind));
        px.drawImage(albCv, 0, 0, pc.width, pc.height);
      });
      R.endGroup(i);
      pickData[i] = px.getImageData(0, 0, pc.width, pc.height).data;
      if (g.depth === Infinity || g.depth === 'ground') { bboxes[i] = null; visible[i] = true; }
      else if (L.lights) { bboxes[i] = null; visible[i] = true; }   // glows extend beyond the shapes
      else {
        const b = alphaBox(pickData[i], pc.width, pc.height);
        visible[i] = !!b || !!g.motion;
        bboxes[i] = b ? b.map(v => v * PICK) : [0, 0, W, H];
      }
    });
  }
  function alphaBox(d, w, h) {
    let x0 = w, y0 = h, x1 = -1, y1 = -1;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      if (d[(y * w + x) * 4 + 3] > 1) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
    }
    return x1 < 0 ? null : [x0 - 1, y0 - 1, x1 + 2, y1 + 2];
  }

  // ------------------------------------------------------------------ camera logic
  function derive() {
    const L = SCENE.LIGHTING[S.lighting], sen = SENSORS[S.sensor];
    const ec = S.ec / 3;
    let N = APERTURES[S.ai], t = SHUTTERS[S.si], iso = ISOS[S.ii];
    let wanted = null;
    if (S.mode === 'A') {
      wanted = N * N / Math.pow(2, L.ev - ec + Math.log2(iso / 100));
      S.si = CAM.nearestIndex(SHUTTERS, wanted);
    } else if (S.mode === 'S') {
      wanted = Math.sqrt(t * Math.pow(2, L.ev - ec + Math.log2(iso / 100)));
      S.ai = CAM.nearestIndex(APERTURES, wanted);
    } else if (S.autoISO) {
      wanted = 100 * Math.pow(2, ec - L.ev + Math.log2(N * N / t));
      S.ii = CAM.nearestIndex(ISOS, wanted);
    }
    N = APERTURES[S.ai]; t = SHUTTERS[S.si]; iso = ISOS[S.ii];
    const delta = CAM.exposureDelta(L.ev, N, t, iso);
    const target = (S.mode !== 'M' || S.autoISO) ? ec : 0;
    const autoLimited = (S.mode !== 'M' || S.autoISO) && Math.abs(delta - ec) > 0.4;

    const W = R.W, pxPerMm = W / sen.width, f = S.focal;
    const sFocus = isFinite(S.focus) ? S.focus : 1e5;
    const coc0 = 0.03 / sen.crop;                          // acceptable CoC (mm)
    const dof = CAM.dofLimits(f, N, sFocus, coc0);
    const blurR = d => 0.5 * CAM.cocMM(f, N, sFocus, d) * pxPerMm;
    const carV = S.carSpeed / 3.6 * f / SCENE.CAR.d * pxPerMm; // px per second on the sensor image
    const pinTip = S.spin ? 4 * Math.PI * SCENE.PIN.R * geo.Sc : 0;
    let shake = 0;
    if (S.support !== 'tripod') {
      let th = 0.02 * (t < 0.5 ? t : 0.5 + (t - 0.5) * 0.5);   // rad of hand wobble
      if (S.support === 'is') th /= 12;                      // ≈ 3.5 stops of stabilisation
      shake = Math.min(0.2 * W, f * th * pxPerMm);
    }
    const safeT = 1 / (f * sen.crop) * (S.support === 'is' ? 8 : 1);
    let wbK = S.wb === 'auto' ? L.awbK : (S.wb === 'custom' ? S.wbK : WB_PRESETS[S.wb].k);
    S.wbK = wbK;
    const gain = iso / 100;
    const noisePct = Math.sqrt(0.18 * Math.pow(2, delta) * gain * NOISE.shot + Math.pow(gain * NOISE.read, 2)) / (0.18 * Math.pow(2, delta)) * 100;
    return { L, sen, N, t, iso, ec, delta, target, wanted, autoLimited, W, pxPerMm, f, sFocus, coc0, dof, blurR, carV, pinTip, shake, safeT, wbK, gain, noisePct };
  }
  const NOISE = { shot: 5e-5, read: 2e-4 };

  function opticalParams(D) {
    const W = R.W, H = R.H, Sc = geo.Sc, maxR = 0.09 * W;
    const diff = 0.0007 * D.N * D.pxPerMm;
    const groups = GROUPS.map((g, i) => {
      const ground = g.depth === 'ground';
      const radius = ground ? 0 : Math.min(maxR, Math.hypot(D.blurR(g.depth === Infinity ? 1e7 : g.depth), diff));
      let motion = null;
      if (g.motion === 'linear') motion = { type: 'linear', active: D.carV > 0, v: D.carV, box: SCENE.CAR.box.map(x => (x - 750) * Sc + W / 2) };
      if (g.motion === 'rotate') motion = { type: 'rot', active: S.spin, w: S.spin ? 4 * Math.PI : 0, c: [(SCENE.PIN.x - 750) * Sc + W / 2, (SCENE.PIN.y - 500) * Sc + H / 2], R: SCENE.PIN.R * Sc };
      return { index: i, ground, radius, bbox: bboxes[i], motion };
    }).filter(g => visible[g.index]);
    const ang = (S.seed * 2.399) % (Math.PI * 2);
    return {
      groups,
      lens: { f: D.f, N: D.N, sMM: D.sFocus * 1000, pxPerMm: D.pxPerMm, S: Sc, maxR, diff, blades: Math.min(1, Math.max(0, Math.log2(D.N / 1.4) / 1.5)) },
      t: D.t, shake: [Math.cos(ang) * D.shake, Math.sin(ang) * D.shake], seed: S.seed,
    };
  }

  // ------------------------------------------------------------------ render loop
  function schedule(rebuild) {
    if (rebuild) needRebuild = true;
    if (!rafId) rafId = requestAnimationFrame(frame);
  }
  function frame() {
    rafId = 0;
    ensureSize();
    if (needRebuild) { rebuildLayers(); needRebuild = false; }
    D = derive();
    const op = opticalParams(D);
    R.composeOptical(op);
    lastDev = {
      exposure: Math.pow(2, D.delta), wb: CAM.wbGains(D.wbK, S.tint),
      gain: D.gain, shot: NOISE.shot, read: NOISE.read, seed: S.seed, bloom: 0.035,
    };
    R.develop({ ...lastDev, zebra: false });
    lastHist = histogram(R.readPixels());
    drawHistogram(lastHist);
    if (S.zebra && lastHist.clipHi > 0.0005) R.develop({ ...lastDev, zebra: true, time: performance.now() / 1000 });
    syncUI();
    updateReadouts();
  }
  setInterval(() => {
    if (S.zebra && lastDev && lastHist && lastHist.clipHi > 0.0005 && !rafId)
      R.develop({ ...lastDev, zebra: true, time: performance.now() / 1000 });
  }, 120);

  // ------------------------------------------------------------------ histogram
  function histogram(px) {
    const r = new Uint32Array(256), g = new Uint32Array(256), b = new Uint32Array(256), l = new Uint32Array(256);
    let n = 0, hi = 0, lo = 0;
    const W = R.W, H = R.H;
    for (let y = 0; y < H; y += 2) for (let x = 0; x < W; x += 2) {
      const i = (y * W + x) * 4, R_ = px[i], G = px[i + 1], B = px[i + 2];
      r[R_]++; g[G]++; b[B]++;
      l[Math.round(0.2126 * R_ + 0.7152 * G + 0.0722 * B)]++;
      if (R_ >= 254 || G >= 254 || B >= 254) hi++;
      if (R_ <= 2 && G <= 2 && B <= 2) lo++;
      n++;
    }
    return { r, g, b, l, n, clipHi: hi / n, clipLo: lo / n };
  }
  // size a canvas' pixel buffer to its on-screen size (sharp at any layout / zoom)
  function fitCanvas(c) {
    const k = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.max(10, Math.round(c.clientWidth * k)), h = Math.max(10, Math.round(c.clientHeight * k));
    if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
    return k;
  }
  function drawHistogram(h) {
    const c = $('hist'), k = fitCanvas(c), x = c.getContext('2d'), W = c.width, H = c.height;
    x.clearRect(0, 0, W, H);
    x.fillStyle = '#0b0c10'; x.fillRect(0, 0, W, H);
    x.strokeStyle = '#222'; x.lineWidth = 1;
    for (let i = 1; i < 5; i++) { x.beginPath(); x.moveTo(i * W / 5, 0); x.lineTo(i * W / 5, H); x.stroke(); }
    let max = 1;
    const lumOnly = UI === 'simple';
    for (let i = 2; i < 254; i++) max = lumOnly ? Math.max(max, h.l[i]) : Math.max(max, h.r[i], h.g[i], h.b[i]);
    const top = 16 * k;
    const plot = (arr, col) => {
      x.fillStyle = col; x.beginPath(); x.moveTo(0, H);
      for (let i = 0; i < 256; i++) x.lineTo(i / 255 * W, H - Math.min(1, arr[i] / max) * (H - top));
      x.lineTo(W, H); x.closePath(); x.fill();
    };
    if (lumOnly) {
      const g = x.createLinearGradient(0, 0, W, 0);
      g.addColorStop(0, '#3a3f4a'); g.addColorStop(1, '#f2f2f2');
      plot(h.l, g);
    } else {
      x.globalCompositeOperation = 'lighter';
      plot(h.r, 'rgba(255,60,60,0.55)'); plot(h.g, 'rgba(60,255,90,0.5)'); plot(h.b, 'rgba(70,120,255,0.6)');
      x.globalCompositeOperation = 'source-over';
    }
    if (h.clipHi > 0.002) { x.fillStyle = 'rgba(255,70,70,0.9)'; x.fillRect(W - 4 * k, 0, 4 * k, H); }
    if (h.clipLo > 0.02) { x.fillStyle = 'rgba(80,140,255,0.9)'; x.fillRect(0, 0, 4 * k, H); }
    x.fillStyle = '#9aa1ad'; x.font = `${10 * k}px system-ui`;
    x.fillText(lumOnly ? 'dark' : 'shadows', 7 * k, 12 * k); x.textAlign = 'right';
    x.fillText(lumOnly ? 'bright' : 'highlights', W - 7 * k, 12 * k); x.textAlign = 'left';
    $('histInfo').textContent = `${(h.clipHi * 100).toFixed(1)}% white · ${(h.clipLo * 100).toFixed(1)}% black`;
    $('histInfo').title = 'Share of pixels clipped to pure white / pure black';
  }

  // ------------------------------------------------------------------ depth-of-field map
  function drawDofMap(D) {
    const c = $('dofmap'), k = fitCanvas(c), x = c.getContext('2d'), W = c.width, H = c.height;
    x.clearRect(0, 0, W, H); x.fillStyle = '#0b0c10'; x.fillRect(0, 0, W, H);
    const L0 = 12 * k, L1 = W - 34 * k, INF = W - 14 * k, AX = H - 16 * k;
    const xd = d => !isFinite(d) || d > 400 ? INF : L0 + (L1 - L0) * Math.log(d / 0.5) / Math.log(800);
    // DoF zone
    const n = Math.max(0.5, D.dof.near), f = D.dof.far;
    x.fillStyle = 'rgba(81,207,102,0.18)';
    x.fillRect(xd(n), 2 * k, xd(f) - xd(n), AX - 2 * k);
    x.fillStyle = 'rgba(81,207,102,0.9)'; x.fillRect(xd(n), AX - 2 * k, xd(f) - xd(n), 3 * k);
    // blur curve (log scale)
    const cy = r => AX - 2 * k - Math.log2(1 + r) / Math.log2(41) * (AX - 46 * k);
    x.strokeStyle = 'rgba(255,122,89,0.9)'; x.lineWidth = 1.5 * k; x.beginPath();
    for (let px = L0; px <= L1; px += 2) {
      const d = 0.5 * Math.pow(800, (px - L0) / (L1 - L0));
      const y = cy(Math.min(D.blurR(d) * 2 / D.pxPerMm / D.coc0, 40));
      px === L0 ? x.moveTo(px, y) : x.lineTo(px, y);
    }
    x.lineTo(INF, cy(Math.min(D.blurR(1e7) * 2 / D.pxPerMm / D.coc0, 40)));
    x.stroke();
    // axis
    x.strokeStyle = '#555'; x.lineWidth = 1; x.beginPath(); x.moveTo(L0, AX); x.lineTo(W, AX); x.stroke();
    x.fillStyle = '#9aa1ad'; x.font = `${9.5 * k}px system-ui`; x.textAlign = 'center';
    [0.5, 1, 2, 5, 10, 20, 50, 100].forEach(d => { x.fillRect(xd(d), AX, 1, 3 * k); x.fillText(String(d), xd(d), AX + 12 * k); });
    x.fillText('∞', INF, AX + 12 * k);
    x.textAlign = 'right'; x.fillText('m', W - 2 * k, AX + 12 * k); x.textAlign = 'left';
    // focus plane
    const fx = xd(isFinite(S.focus) ? S.focus : Infinity);
    x.strokeStyle = '#e4e7ec'; x.lineWidth = 1.5 * k; x.setLineDash([4 * k, 3 * k]);
    x.beginPath(); x.moveTo(fx, 2 * k); x.lineTo(fx, AX); x.stroke(); x.setLineDash([]); x.lineWidth = 1;
    // objects
    x.font = `${10 * k}px system-ui`;
    SCENE.MARKERS.forEach((m, i) => {
      const mx = xd(m.d), r = D.blurR(m.d === Infinity ? 1e7 : m.d);
      const ratio = r * 2 / D.pxPerMm / D.coc0;
      const col = ratio <= 1 ? '#51cf66' : ratio < 4 ? '#ffb020' : '#ff5c5c';
      const y = 10 * k + (i % 3) * 12 * k;
      x.strokeStyle = 'rgba(255,255,255,0.13)'; x.beginPath(); x.moveTo(mx, y + 3 * k); x.lineTo(mx, AX); x.stroke();
      x.fillStyle = col; x.beginPath(); x.arc(mx, y, 3.5 * k, 0, Math.PI * 2); x.fill();
      x.fillStyle = '#e6e8ec';
      const label = `${m.label}${r >= 1 ? ' ' + r.toFixed(0) + 'px' : ''}`;
      const right = mx + 6 * k + x.measureText(label).width > W;
      x.textAlign = right ? 'right' : 'left';
      x.fillText(label, mx + (right ? -6 * k : 6 * k), y + 3.5 * k);
      x.textAlign = 'left';
    });
    $('dofInfo').textContent = `sharp ${fmtD(D.dof.near)} → ${fmtD(D.dof.far)}`;
  }

  // ------------------------------------------------------------------ formatting helpers
  const fmtD = d => !isFinite(d) || d > 5000 ? '∞' : d < 10 ? d.toFixed(d < 1 ? 2 : 1) + ' m' : Math.round(d) + ' m';
  const fmtT = t => t >= 0.3 ? `${+t.toFixed(1)} s` : `1/${Math.round(1 / t)} s`;
  const fmtN = N => `f/${N}`;
  const stops = v => (v > 0 ? '+' : v < 0 ? '−' : '±') + Math.abs(v).toFixed(1);
  const shutterLab = () => SHUTTER_LABELS[S.si].replace('"', ' s');

  // ------------------------------------------------------------------ readouts & teaching text
  function updateReadouts() {
    const L = D.L;
    $('lcdMode').textContent = S.mode + (S.autoISO && S.mode === 'M' ? ' +AutoISO' : '');
    $('lcdShutter').textContent = SHUTTER_LABELS[S.si];
    $('lcdAperture').textContent = fmtN(D.N);
    $('lcdIso').textContent = D.iso;
    $('lcdWb').textContent = (S.wb === 'auto' ? 'AWB ' : '') + D.wbK + 'K';
    $('lcdLens').textContent = `${S.focal} mm`;
    const needle = $('meterNeedle');
    const v = Math.max(-3.2, Math.min(3.2, D.delta));
    needle.style.left = `${(v + 3) / 6 * 100}%`;
    needle.classList.toggle('over', Math.abs(D.delta) > 0.4);
    needle.classList.toggle('out', Math.abs(D.delta) > 3);
    drawDofMap(D);
    drawIris(D.N);
    $('lesson').innerHTML = lessonHTML();
    $('warnings').innerHTML = warnings().map(([cls, txt]) => `<li class="${cls}">${txt}</li>`).join('');
    equivalents();
    placeAF();
    if (UI === 'simple') updateEffects();
  }

  function carState() {
    const px = D.carV * D.t, pct = px / D.W * 100;
    if (S.carSpeed === 0) return ['ok', 'The car is parked (speed 0).'];
    if (px < 1.5) return ['ok', `Car moves ${px.toFixed(1)} px during the exposure → <b>frozen</b>.`];
    if (px < 8) return ['warn', `Car moves ${px.toFixed(0)} px → <b>slightly blurred</b>.`];
    if (pct < 60) return ['warn', `Car moves ${px.toFixed(0)} px (${pct.toFixed(0)}% of frame width) → <b>motion blur</b>.`];
    return ['warn', `Car travels further than the frame → only a ghost or light trail remains.`];
  }

  function lessonHTML() {
    const L = D.L, N = D.N, t = D.t, iso = D.iso, f = S.focal, sen = D.sen;
    const ev = (CAM.settingsEV100(N, t, iso)).toFixed(1);
    switch (S.last) {
      case 'shutter': {
        const [, car] = carState();
        const pin = D.pinTip * t;
        return `<p><b class="s">Shutter ${shutterLab()}</b>: the sensor collects light for ${fmtT(t)}. Doubling the time = <b>+1 stop</b> (twice the light).</p>
          <p>${car} ${S.spin ? `The pinwheel tips sweep ${pin < 1 ? 'under 1 px (sharp)' : Math.min(pin, 9999).toFixed(0) + ' px'}.` : ''}</p>
          <p>${S.support === 'tripod' ? 'On a tripod, the camera itself doesn\'t move, so only moving things blur.' : `Handheld rule of thumb: use <b>${fmtT(D.safeT)}</b> or faster at ${f} mm${sen.crop > 1 ? ' on this crop sensor' : ''}${S.support === 'is' ? ' with stabilisation' : ''}.`}</p>`;
      }
      case 'aperture': {
        return `<p><b class="a">Aperture ${fmtN(N)}</b>: the opening is ${(f / N).toFixed(1)} mm wide (focal length ÷ f-number). Each full stop (f/2.8 → 4 → 5.6) <b>halves</b> the light.</p>
          <p>Sharp zone at this setting: <b>${fmtD(D.dof.near)} → ${fmtD(D.dof.far)}</b>.</p>
          <p>${N <= 2.8 ? 'Wide aperture → <b>shallow depth of field</b>: the background melts away and point lights turn into round bokeh discs.'
            : N >= 11 ? 'Narrow aperture → <b>deep depth of field</b>: nearly everything is sharp. Beyond f/11–16, diffraction slightly softens the whole image, and bokeh takes on the shape of the 7 aperture blades.'
              : 'Middle apertures give moderate depth of field and are usually the sharpest setting of a lens.'}</p>`;
      }
      case 'iso': {
        const lvl = D.noisePct < 3 ? 'invisible' : D.noisePct < 8 ? 'fine grain' : D.noisePct < 18 ? 'clearly visible' : 'very strong';
        return `<p><b class="i">ISO ${iso}</b> amplifies the sensor signal ×${D.gain}. It does <b>not</b> collect more light. The randomness in the light, and the sensor's own electronic noise, get amplified too.</p>
          <p>Noise right now: about <b>${D.noisePct.toFixed(1)}%</b> at mid-grey (${lvl}). Dark areas get noisier still.</p>
          <p>Good practice: first open the aperture or slow the shutter as far as the photo allows, then raise ISO.</p>`;
      }
      case 'wb': {
        const amb = L.ambK, k = D.wbK;
        const lampTxt = L.lights ? ` Lamps are ≈ <b>${L.lampK} K</b>.` : '';
        const verdict = k < amb - 400 ? 'WB is set <b>lower</b> than the light, so the camera adds blue: the photo looks <b>cool/blue</b>.'
          : k > amb + 400 ? 'WB is set <b>higher</b> than the light, so the camera adds orange: the photo looks <b>warm/orange</b>.'
            : 'WB matches the light: the grey patches at the bottom of the chart look neutral.';
        return `<p>Light on this scene ≈ <b>${amb} K</b>.${lampTxt} Camera WB: <b>${k} K${S.tint ? `, tint ${S.tint > 0 ? '+' : ''}${S.tint}` : ''}</b>.</p><p>${verdict}</p>
          ${L.lights ? '<p>Mixed light: one WB can\'t make both the lamps and the ambient light neutral. Pick the one that matters for your photo.</p>' : ''}`;
      }
      case 'focal': case 'sensor': {
        const hfov = 2 * Math.atan(sen.width / (2 * f)) * 180 / Math.PI;
        return `<p><b>${f} mm</b> on ${sen.name.split(' (')[0]} gives a ${hfov.toFixed(0)}° horizontal view${sen.crop > 1 ? `, the same as ${Math.round(f * sen.crop)} mm on full frame (crop factor ×${sen.crop})` : ''}.</p>
          <p>${f * sen.crop < 35 ? 'Wide angle: shows a lot, gives deep depth of field and is easy to hand-hold.'
            : f * sen.crop >= 85 ? 'Telephoto: magnifies, so the background looks closer and bigger. Depth of field is shallower, and camera shake is magnified too, so you need a faster shutter.'
              : 'Normal view, similar to human vision.'}</p>
          <p>Safe handheld shutter here: about ${fmtT(1 / (f * sen.crop))}.</p>`;
      }
      case 'focus':
        return `<p>Focused at <b>${fmtD(S.focus)}</b>${S.focusName ? ` (${S.focusName})` : ''}. At ${fmtN(N)}, everything from <b>${fmtD(D.dof.near)}</b> to <b>${fmtD(D.dof.far)}</b> looks acceptably sharp.</p>
          <p>Hyperfocal distance: <b>${fmtD(D.dof.hyperfocal)}</b>. Focus there and everything from ${fmtD(D.dof.hyperfocal / 2)} to ∞ is sharp (landscape trick).</p>
          <p>Depth of field gets shallower with a wider aperture, a longer lens, or a closer subject.</p>`;
      case 'mode':
        return {
          M: '<p><b>Manual (M)</b>: you set shutter, aperture and ISO. The meter only <i>suggests</i>. Use it when the light is constant or tricky (night, backlight).</p><p>Turn on Auto ISO to have the camera pick ISO while you control motion and depth of field.</p>',
          A: '<p><b>Aperture priority (A/Av)</b>: you choose the aperture (depth of field) and the camera chooses the shutter speed for correct exposure. It\'s the most popular mode.</p><p>Watch the shutter speed: in low light it may become too slow to hand-hold.</p>',
          S: '<p><b>Shutter priority (S/Tv)</b>: you choose the shutter speed (freeze or blur motion) and the camera chooses the aperture.</p><p>If the needed aperture is beyond the lens range, the meter needle blinks: change ISO.</p>',
        }[S.mode];
      case 'ec':
        return `<p><b>Exposure compensation ${stops(D.ec)} EV</b> asks the auto mode to make the image brighter (+) or darker (−) than the meter's suggestion.</p><p>Use + for bright scenes (snow, white walls) that the meter makes too grey, and − to protect highlights or keep a night scene dark.</p>`;
      case 'support':
        return S.support === 'tripod' ? '<p><b>Tripod</b>: the camera is perfectly still, so any shutter speed is possible. Only moving subjects blur: try light trails at night.</p>'
          : S.support === 'is' ? '<p><b>Image stabilisation</b> moves a lens element or the sensor to cancel hand shake, gaining ~3–4 stops. It does <b>not</b> freeze moving subjects!</p>'
            : `<p><b>Handheld</b>: your hands wobble a little, so at slow shutter speeds the <i>whole</i> image smears. Rule of thumb: shutter faster than 1/(focal length × crop) = <b>${fmtT(D.safeT)}</b>.</p>`;
      case 'car': case 'spin': {
        const [, car] = carState();
        return `<p>${car}</p><p>Motion blur = speed × exposure time. A faster subject, a longer lens or a closer subject all need a faster shutter to freeze.</p>`;
      }
      case 'restore':
        return '<p>Snapshot settings restored. Compare the photos in the strip below.</p>';
      case 'scene':
        return `<p><b>${L.icon} ${L.name}</b>: ${L.desc}</p><p>Light meter reads <b>EV ${L.ev}</b>. Your settings give EV ${ev} (at ISO 100). The difference, <b>${stops(D.delta)} stops</b>, is how bright the photo will be.</p>`;
      default:
        if (UI === 'simple') return `<p><b>The exposure triangle.</b> Three settings control how bright the photo is: <b class="s">shutter speed</b>, <b class="a">aperture</b> and <b class="i">ISO</b>.</p>
          <p>Each one also has a <b>side effect</b>: the shutter blurs motion, the aperture blurs the background, and ISO adds noise. Move one slider at a time and watch the photo and the <b>Side effects</b> bars.</p>
          <p>Change the light (sun, night…) under <b>⚙ Scene &amp; light</b>.</p>`;
        return `<p>Welcome! This is a virtual camera. Move any slider and the photo, histogram and depth-of-field map update instantly.</p>
          <p>Start with the <b class="s">shutter</b>, <b class="a">aperture</b> and <b class="i">ISO</b>: together they set the brightness, and each one also changes the <i>look</i> of the photo. Click ❓ for exercises.</p>`;
    }
  }

  function warnings() {
    const w = [], d = D.delta, h = lastHist;
    if (Math.abs(d) <= 0.34) w.push(['ok', `Exposure ≈ correct (${stops(d)} stops vs meter).`]);
    else if (d > 0) w.push([d > 1 ? 'bad' : 'warn', `Over-exposed by <b>${stops(d)} stops</b>: ${Math.pow(2, d).toFixed(1)}× too much light.`]);
    else w.push([d < -1 ? 'bad' : 'warn', `Under-exposed by <b>${stops(d)} stops</b>: only ${(Math.pow(2, d) * 100).toFixed(0)}% of the needed light.`]);
    if (h && h.clipHi > 0.01) w.push(['bad', `${(h.clipHi * 100).toFixed(1)}% of the image is blown to white: that detail is lost.`]);
    if (D.autoLimited) w.push(['bad', `The camera can't reach the target exposure in ${S.mode === 'M' ? 'Auto ISO' : S.mode + ' mode'}: a setting hit its limit. Change another setting${D.L.ev >= 14 ? ' (in bright sun, an ND filter is the usual fix)' : ''}.`]);
    if (S.support !== 'tripod' && D.shake > 1.2) w.push([D.shake > 5 ? 'bad' : 'warn', `Camera shake ≈ ${D.shake.toFixed(0)} px of blur. Use ${fmtT(D.safeT)} or faster, IS, or a tripod.`]);
    if (D.noisePct > 8) w.push([D.noisePct > 18 ? 'bad' : 'warn', `ISO ${D.iso}: noise ≈ ${D.noisePct.toFixed(0)}% at mid-grey.`]);
    const [cls, car] = carState();
    w.push([cls === 'ok' ? 'ok' : '', car]);
    const chartR = D.blurR(3);
    if (chartR * 2 / D.pxPerMm > D.coc0 * 2.5) w.push(['warn', `The colour chart (3 m) is out of focus. Click it in the photo to focus.`]);
    if (Math.abs(D.wbK - D.L.ambK) > 1200 && S.wb !== 'auto') w.push(['warn', `WB ${D.wbK} K vs light ${D.L.ambK} K → strong colour cast.`]);
    if (D.N >= 16) w.push(['', `At ${fmtN(D.N)}, diffraction softens fine detail a little.`]);
    return w;
  }

  function equivalents() {
    const evs = Math.log2(D.N * D.N / D.t); // same ISO
    const out = [];
    [1.4, 2, 2.8, 4, 5.6, 8, 11, 16, 22].forEach(N => {
      const t = N * N / Math.pow(2, evs);
      const si = CAM.nearestIndex(SHUTTERS, t);
      if (Math.abs(Math.log2(SHUTTERS[si] / t)) > 0.2) return;
      out.push({ N, si, cur: N === D.N });
    });
    $('equiv').innerHTML = `Same brightness, different look (ISO ${D.iso}):<div class="btns">${out.map(o =>
      `<button data-n="${o.N}" data-si="${o.si}" class="${o.cur ? 'cur' : ''}">f/${o.N} · ${SHUTTER_LABELS[o.si]}</button>`).join('')}</div>`;
  }
  $('equiv').addEventListener('click', e => {
    const b = e.target.closest('button'); if (!b) return;
    const ai = APERTURES.indexOf(+b.dataset.n), si = +b.dataset.si;
    if (S.mode === 'A') S.ai = ai;
    else if (S.mode === 'S') S.si = si;
    else { S.ai = ai; S.si = si; }
    S.last = 'aperture'; schedule();
  });

  function drawIris(N) {
    const c = $('iris'), x = c.getContext('2d'), W = c.width, C = W / 2;
    x.clearRect(0, 0, W, W);
    x.fillStyle = '#2b2f38'; x.beginPath(); x.arc(C, C, C - 1, 0, Math.PI * 2); x.fill();
    const r = (C - 5) * 1.4 / N, blades = Math.min(1, Math.max(0, Math.log2(N / 1.4) / 1.5)), seg = Math.PI * 2 / 7;
    x.fillStyle = '#cfe6ff'; x.beginPath();
    for (let i = 0; i <= 140; i++) {
      const th = i / 140 * Math.PI * 2, a = ((th % seg) + seg) % seg - seg / 2;
      const k = 1 + (Math.cos(seg / 2) / Math.cos(a) - 1) * blades;
      const px = C + Math.cos(th) * r * k, py = C + Math.sin(th) * r * k;
      i ? x.lineTo(px, py) : x.moveTo(px, py);
    }
    x.fill();
  }

  function placeAF() {
    const el = $('afPoint');
    if (!S.af) { el.hidden = true; return; }
    const x = ((S.af[0] - 750) * geo.Sc + R.W / 2) / R.W, y = ((S.af[1] - 500) * geo.Sc + R.H / 2) / R.H;
    if (x < 0 || x > 1 || y < 0 || y > 1) { el.hidden = true; return; }
    el.hidden = false; el.style.left = x * 100 + '%'; el.style.top = y * 100 + '%';
  }

  // ------------------------------------------------------------------ UI wiring
  const focalToV = f => Math.round(Math.log(f / 24) / Math.log(200 / 24) * 1000);
  const vToFocal = v => Math.round(24 * Math.pow(200 / 24, v / 1000));
  const focusToV = d => !isFinite(d) ? 1000 : Math.round(Math.min(985, Math.max(0, Math.log(d / 0.5) / Math.log(400) * 985)));
  const vToFocus = v => v >= 993 ? Infinity : 0.5 * Math.pow(400, v / 985);

  function buildUI() {
    $('shutter').max = SHUTTERS.length - 1;
    $('aperture').max = APERTURES.length - 1;
    $('iso').max = ISOS.length - 1;
    const lc = $('lightingChips');
    for (const k in SCENE.LIGHTING) {
      const b = document.createElement('button'); b.type = 'button'; b.dataset.k = k;
      b.textContent = `${SCENE.LIGHTING[k].icon} ${SCENE.LIGHTING[k].name}`;
      lc.appendChild(b);
    }
    lc.addEventListener('click', e => { const b = e.target.closest('button'); if (!b) return; S.lighting = b.dataset.k; S.last = 'scene'; schedule(true); });
    const fc = $('focalChips');
    [24, 35, 50, 85, 135, 200].forEach(f => { const b = document.createElement('button'); b.dataset.f = f; b.textContent = f + ' mm'; fc.appendChild(b); });
    fc.addEventListener('click', e => { const b = e.target.closest('button'); if (!b) return; S.focal = +b.dataset.f; S.last = 'focal'; schedule(true); });
    const ws = $('wbPreset');
    for (const k in WB_PRESETS) { const o = document.createElement('option'); o.value = k; o.textContent = WB_PRESETS[k].name + (WB_PRESETS[k].k ? ` — ${WB_PRESETS[k].k} K` : ''); ws.appendChild(o); }
    const ss = $('sensor');
    for (const k in SENSORS) { const o = document.createElement('option'); o.value = k; o.textContent = SENSORS[k].name; ss.appendChild(o); }

    const on = (id, ev, fn) => $(id).addEventListener(ev, fn);
    on('shutter', 'input', e => { S.si = +e.target.value; S.last = 'shutter'; schedule(); });
    on('aperture', 'input', e => { S.ai = +e.target.value; S.last = 'aperture'; schedule(); });
    on('iso', 'input', e => { S.ii = +e.target.value; S.last = 'iso'; schedule(); });
    on('ec', 'input', e => { S.ec = +e.target.value; S.last = 'ec'; schedule(); });
    on('autoIso', 'change', e => { S.autoISO = e.target.checked; S.last = 'mode'; schedule(); });
    on('wbPreset', 'change', e => { S.wb = e.target.value; S.last = 'wb'; schedule(); });
    on('wbK', 'input', e => { S.wb = 'custom'; S.wbK = +e.target.value; S.last = 'wb'; schedule(); });
    on('tint', 'input', e => { S.tint = +e.target.value; S.last = 'wb'; schedule(); });
    on('focal', 'input', e => { S.focal = vToFocal(+e.target.value); S.last = 'focal'; schedule(true); });
    on('focus', 'input', e => { S.focus = vToFocus(+e.target.value); S.af = null; S.focusName = ''; S.last = 'focus'; schedule(); });
    on('sensor', 'change', e => { S.sensor = e.target.value; S.last = 'sensor'; schedule(true); });
    on('carSpeed', 'input', e => { S.carSpeed = +e.target.value; S.last = 'car'; schedule(); });
    on('spin', 'change', e => { S.spin = e.target.checked; S.last = 'spin'; schedule(); });
    on('zebra', 'change', e => { S.zebra = e.target.checked; schedule(); });
    $('modeSeg').addEventListener('click', e => { const b = e.target.closest('button'); if (!b) return; S.mode = b.dataset.mode; S.last = 'mode'; schedule(); });
    $('supportSeg').addEventListener('click', e => { const b = e.target.closest('button'); if (!b) return; S.support = b.dataset.support; S.last = 'support'; schedule(); });
    on('btnShoot', 'click', shoot);
    on('btnHelp', 'click', () => $('help').showModal());
    on('btnSettings', 'click', () => $('settings').showModal());
    $('settings').addEventListener('click', e => { if (e.target === $('settings')) $('settings').close(); }); // click outside closes
    on('btnReset', 'click', () => { const seed = S.seed; S = clone(DEFAULTS); S.seed = seed; S.last = 'welcome'; setUI(UI); });
    $('uiSeg').addEventListener('click', e => { const b = e.target.closest('button'); if (b) setUI(b.dataset.ui, true); });
    on('view', 'click', focusAt);
    window.addEventListener('keydown', e => {
      if (e.code === 'Space' && !$('help').open && !$('settings').open && !$('viewer').open && !(e.target instanceof HTMLSelectElement)) { e.preventDefault(); shoot(); }
    });
    let rt = 0;
    window.addEventListener('resize', () => { clearTimeout(rt); rt = setTimeout(() => schedule(), 150); });
  }

  function syncUI() {
    const L = SCENE.LIGHTING[S.lighting];
    $('shutter').value = S.si; $('aperture').value = S.ai; $('iso').value = S.ii; $('ec').value = S.ec;
    $('shutter').disabled = S.mode === 'A';
    $('aperture').disabled = S.mode === 'S';
    $('iso').disabled = S.mode === 'M' && S.autoISO;
    $('ec').disabled = S.mode === 'M' && !S.autoISO;
    $('ecCtl').style.opacity = $('ec').disabled ? 0.5 : 1;
    const tag = '<span class="auto-tag">AUTO</span>';
    $('shutterOut').innerHTML = SHUTTER_LABELS[S.si].replace('"', ' s') + (S.mode === 'A' ? tag : '');
    $('apertureOut').innerHTML = fmtN(APERTURES[S.ai]) + (S.mode === 'S' ? tag : '');
    $('isoOut').innerHTML = ISOS[S.ii] + (S.mode === 'M' && S.autoISO ? tag : '');
    $('ecOut').textContent = (S.ec > 0 ? '+' : S.ec < 0 ? '−' : '±') + fmtThirds(Math.abs(S.ec));
    $('autoIso').checked = S.autoISO;
    $('autoIso').disabled = S.mode !== 'M';
    $('wbPreset').value = S.wb;
    $('wbK').value = S.wbK; $('wbKOut').textContent = S.wbK + ' K';
    $('tint').value = S.tint; $('tintOut').textContent = (S.tint > 0 ? 'M +' : S.tint < 0 ? 'G ' : '') + S.tint;
    $('focal').value = focalToV(S.focal); $('focalOut').textContent = S.focal + ' mm' + (SENSORS[S.sensor].crop > 1 ? ` (≈${Math.round(S.focal * SENSORS[S.sensor].crop)} FF)` : '');
    $('focus').value = focusToV(S.focus); $('focusOut').textContent = fmtD(S.focus);
    $('sensor').value = S.sensor;
    $('carSpeed').value = S.carSpeed; $('carSpeedOut').textContent = S.carSpeed + ' km/h';
    $('spin').checked = S.spin; $('zebra').checked = S.zebra;
    document.querySelectorAll('#lightingChips button').forEach(b => b.classList.toggle('on', b.dataset.k === S.lighting));
    document.querySelectorAll('#focalChips button').forEach(b => b.classList.toggle('on', +b.dataset.f === S.focal));
    document.querySelectorAll('#modeSeg button').forEach(b => b.classList.toggle('on', b.dataset.mode === S.mode));
    document.querySelectorAll('#supportSeg button').forEach(b => b.classList.toggle('on', b.dataset.support === S.support));
    $('lightingDesc').textContent = `${L.desc}`;
    $('modeDesc').textContent = { M: 'You set everything. The meter shows how far you are from "correct".', A: 'You set the aperture; the camera picks the shutter speed.', S: 'You set the shutter speed; the camera picks the aperture.' }[S.mode];
  }
  function fmtThirds(n) {
    const whole = Math.floor(n / 3), rem = n % 3;
    return (whole || !rem ? whole : '') + (rem ? (whole ? ' ' : '') + rem + '/3' : '');
  }

  // click-to-focus: find the nearest object under the cursor
  function focusAt(ev) {
    const rect = $('view').getBoundingClientRect();
    const cx = (ev.clientX - rect.left) / rect.width * R.W, cy = (ev.clientY - rect.top) / rect.height * R.H;
    const pw = picks[0].width, ph = picks[0].height;
    const px = Math.min(pw - 1, Math.max(0, Math.floor(cx / PICK))), py = Math.min(ph - 1, Math.max(0, Math.floor(cy / PICK)));
    let d = null, name = '';
    for (let i = GROUPS.length - 1; i >= 0; i--) {
      const g = GROUPS[i];
      if (g.depth === Infinity || g.depth === 'ground') continue;
      if (pickData[i][(py * pw + px) * 4 + 3] > 90) { d = g.depth; name = g.label; break; }
    }
    if (d === null) {
      const yb = 500 + (cy - R.H / 2) / geo.Sc;
      d = SCENE.groundDepthAtY(yb);
      name = isFinite(d) ? 'lawn / road' : 'sky & mountains';
    }
    S.focus = d; S.focusName = name; S.last = 'focus';
    S.af = [(cx - R.W / 2) / geo.Sc + 750, (cy - R.H / 2) / geo.Sc + 500];
    const el = $('afPoint'); el.classList.remove('locked'); void el.offsetWidth;
    setTimeout(() => el.classList.add('locked'), 180);
    schedule();
  }

  // ------------------------------------------------------------------ taking photos
  let audio = null;
  function click(at, vol) {
    const ctx = audio, len = 0.03, buf = ctx.createBuffer(1, ctx.sampleRate * len, ctx.sampleRate), ch = buf.getChannelData(0);
    for (let i = 0; i < ch.length; i++) ch[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / ch.length, 3);
    const src = ctx.createBufferSource(), g = ctx.createGain();
    src.buffer = buf; g.gain.value = vol; src.connect(g).connect(ctx.destination); src.start(at);
  }
  function shoot() {
    try {
      audio = audio || new (window.AudioContext || window.webkitAudioContext)();
      const now = audio.currentTime + 0.01, t = SHUTTERS[S.si];
      click(now, 0.6); click(now + Math.max(0.04, Math.min(t, 3)), 0.45);
    } catch (e) { /* sound is optional */ }
    const t = SHUTTERS[S.si];
    const fl = $('flash'); fl.classList.add('on');
    setTimeout(() => fl.classList.remove('on'), Math.max(70, Math.min(t, 3) * 1000));
    S.seed = (S.seed % 9973) + 1;
    if (rafId) { cancelAnimationFrame(rafId); rafId = 0; }
    frame();
    // capture without zebra stripes
    R.develop({ ...lastDev, zebra: false });
    addSnapshot();
    if (S.zebra && lastHist.clipHi > 0.0005) R.develop({ ...lastDev, zebra: true, time: performance.now() / 1000 });
  }
  let shots = [];
  function addSnapshot() {
    const view = $('view');
    const tc = document.createElement('canvas'); tc.width = 300; tc.height = 200;
    tc.getContext('2d').drawImage(view, 0, 0, tc.width, tc.height);
    const L = D.L;
    shots.unshift({
      thumb: tc.toDataURL('image/jpeg', 0.85),
      full: view.toDataURL('image/jpeg', 0.93),          // full resolution, for zooming in the viewer
      state: clone(S),
      short: `${SHUTTER_LABELS[S.si]} · ${fmtN(D.N)} · ${D.iso}`,
      cap: `<b>${SHUTTER_LABELS[S.si]}</b> · <b>${fmtN(D.N)}</b> · <b>ISO ${D.iso}</b><br>${S.focal} mm · focus ${fmtD(S.focus)} · WB ${D.wbK}K<br>${L.icon} ${L.name} · ${stops(D.delta)} EV · ${S.support === 'tripod' ? 'tripod' : 'handheld'}`,
    });
    if (shots.length > 24) shots.pop();
    renderStrip();
  }
  function renderStrip() {
    const st = $('strip');
    st.innerHTML = shots.length ? '' : '<p class="hint">Press 📸 <b>Take photo</b> (or <kbd>Space</kbd>) to save shots with different settings, then click one to look closer.</p>';
    shots.forEach((s, i) => {
      const d = document.createElement('div'); d.className = 'shot';
      d.title = s.cap.replace(/<br>/g, '\n').replace(/<[^>]+>/g, '') + '\n(click to open, zoom and draw)';
      d.innerHTML = `<img src="${s.thumb}" alt="snapshot"><div class="cap">${s.short}</div><button class="del" title="Delete">×</button>`;
      d.addEventListener('click', e => {
        if (e.target.classList.contains('del')) { shots.splice(i, 1); renderStrip(); return; }
        openViewer(i);
      });
      st.appendChild(d);
    });
  }
  function restoreShot(i) {
    const s = shots[i]; if (!s) return;
    const seed = S.seed; S = clone(s.state); S.seed = seed; S.last = 'restore';
    // a shot taken with advanced settings can't be shown faithfully in Simple mode
    const adv = S.mode !== 'M' || S.autoISO || S.ec || S.wb !== 'auto' || S.tint;
    if (UI === 'simple' && adv) setUI('advanced'); else schedule(true);
  }

  // ------------------------------------------------------------------ snapshot viewer (zoom · pan · draw)
  const VW = { i: 0, img: null, k: 1, ox: 0, oy: 0, fitK: 1, tool: 'pan', color: '#ff3b3b', strokes: [], cur: null, drag: null };
  const vwC = $('vwCanvas'), vwX = vwC.getContext('2d');
  const vwDpr = () => Math.min(window.devicePixelRatio || 1, 3);

  function openViewer(i) {
    if (!shots[i]) return;
    VW.i = i; VW.strokes = []; VW.cur = null;
    const img = new Image();
    img.onload = () => { VW.img = img; vwResize(); vwFit(); };
    img.src = shots[i].full;
    $('vwInfo').innerHTML = shots[i].cap.replace(/<br>/g, ' &nbsp;·&nbsp; ');
    $('vwCount').textContent = `${i + 1} / ${shots.length}`;
    $('vwPrev').disabled = i <= 0; $('vwNext').disabled = i >= shots.length - 1;
    if (!$('viewer').open) $('viewer').showModal();
    vwSetTool(VW.tool);
  }
  function vwResize() {
    const d = vwDpr(), w = Math.round(vwC.clientWidth * d), h = Math.round(vwC.clientHeight * d);
    if (vwC.width !== w || vwC.height !== h) { vwC.width = w; vwC.height = h; }
  }
  function vwFit() {
    if (!VW.img) return;
    const W = vwC.width, H = vwC.height, iw = VW.img.width, ih = VW.img.height;
    VW.fitK = Math.min(W / iw, H / ih) * 0.97;
    VW.k = VW.fitK; VW.ox = (W - iw * VW.k) / 2; VW.oy = (H - ih * VW.k) / 2;
    vwDraw();
  }
  function vwZoomAt(f, sx, sy) {
    if (!VW.img) return;
    if (sx === undefined) { sx = vwC.width / 2; sy = vwC.height / 2; }
    const k = Math.min(32, Math.max(VW.fitK * 0.5, VW.k * f));
    const ix = (sx - VW.ox) / VW.k, iy = (sy - VW.oy) / VW.k;
    VW.k = k; VW.ox = sx - ix * k; VW.oy = sy - iy * k;
    vwDraw();
  }
  function vwDraw() {
    const x = vwX, W = vwC.width, H = vwC.height;
    x.setTransform(1, 0, 0, 1, 0, 0);
    x.fillStyle = '#08090c'; x.fillRect(0, 0, W, H);
    if (!VW.img) return;
    x.setTransform(VW.k, 0, 0, VW.k, VW.ox, VW.oy);
    x.imageSmoothingEnabled = VW.k < 2.5;     // show real pixels (noise!) when zoomed in
    x.drawImage(VW.img, 0, 0);
    x.lineCap = 'round'; x.lineJoin = 'round';
    for (const s of VW.cur ? [...VW.strokes, VW.cur] : VW.strokes) {
      x.strokeStyle = s.c; x.lineWidth = s.w;
      x.beginPath();
      s.p.forEach(([px, py], j) => j ? x.lineTo(px, py) : x.moveTo(px, py));
      if (s.p.length === 1) x.lineTo(s.p[0][0] + 0.01, s.p[0][1]);
      x.stroke();
    }
    $('vwZoom').textContent = Math.round(VW.k / VW.fitK * 100) + '%';
  }
  function vwSetTool(t) {
    VW.tool = t;
    document.querySelectorAll('#vwTool button').forEach(b => b.classList.toggle('on', b.dataset.tool === t));
    vwC.classList.toggle('draw', t === 'draw');
  }
  function vwPoint(e) {
    const r = vwC.getBoundingClientRect(), d = vwC.width / r.width;
    return [(e.clientX - r.left) * d, (e.clientY - r.top) * d];
  }

  vwC.addEventListener('pointerdown', e => {
    vwC.setPointerCapture(e.pointerId);
    const [sx, sy] = vwPoint(e);
    // left button draws in Draw mode; anything else (or Move mode) pans
    if (VW.tool === 'draw' && e.button === 0) {
      const size = +$('vwSize').value * vwDpr();
      VW.cur = { c: VW.color, w: size / VW.k, p: [[(sx - VW.ox) / VW.k, (sy - VW.oy) / VW.k]] };
    } else {
      VW.drag = { sx, sy, ox: VW.ox, oy: VW.oy };
      vwC.classList.add('grabbing');
    }
    vwDraw();
  });
  vwC.addEventListener('pointermove', e => {
    const [sx, sy] = vwPoint(e);
    if (VW.cur) { VW.cur.p.push([(sx - VW.ox) / VW.k, (sy - VW.oy) / VW.k]); vwDraw(); }
    else if (VW.drag) { VW.ox = VW.drag.ox + sx - VW.drag.sx; VW.oy = VW.drag.oy + sy - VW.drag.sy; vwDraw(); }
  });
  const vwEnd = () => {
    if (VW.cur) { VW.strokes.push(VW.cur); VW.cur = null; }
    VW.drag = null; vwC.classList.remove('grabbing'); vwDraw();
  };
  vwC.addEventListener('pointerup', vwEnd);
  vwC.addEventListener('pointercancel', vwEnd);
  vwC.addEventListener('wheel', e => {
    e.preventDefault();
    const [sx, sy] = vwPoint(e);
    vwZoomAt(Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0015)), sx, sy);   // ctrl+wheel = trackpad pinch
  }, { passive: false });
  vwC.addEventListener('dblclick', vwFit);
  vwC.addEventListener('contextmenu', e => e.preventDefault());

  $('vwTool').addEventListener('click', e => { const b = e.target.closest('button'); if (b) vwSetTool(b.dataset.tool); });
  $('vwColors').addEventListener('click', e => {
    const b = e.target.closest('button'); if (!b) return;
    VW.color = b.dataset.c; vwSetTool('draw');
    document.querySelectorAll('#vwColors button').forEach(x => x.classList.toggle('on', x === b));
  });
  document.querySelector('#vwColors button').classList.add('on');
  $('vwSize').addEventListener('input', () => vwSetTool('draw'));
  $('vwUndo').addEventListener('click', () => { VW.strokes.pop(); vwDraw(); });
  $('vwClear').addEventListener('click', () => { VW.strokes = []; vwDraw(); });
  $('vwIn').addEventListener('click', () => vwZoomAt(1.5));
  $('vwOut').addEventListener('click', () => vwZoomAt(1 / 1.5));
  $('vwFit').addEventListener('click', vwFit);
  $('vw1').addEventListener('click', () => vwZoomAt(1 / VW.k));
  $('vwPrev').addEventListener('click', () => openViewer(VW.i - 1));
  $('vwNext').addEventListener('click', () => openViewer(VW.i + 1));
  $('vwRestore').addEventListener('click', () => { const i = VW.i; $('viewer').close(); restoreShot(i); });
  $('vwClose').addEventListener('click', () => $('viewer').close());
  // closing (✕, Esc) erases all drawings
  $('viewer').addEventListener('close', () => { VW.strokes = []; VW.cur = null; VW.img = null; });
  $('viewer').addEventListener('keydown', e => {
    if (e.target instanceof HTMLInputElement) return;
    const k = e.key;
    if (k === '+' || k === '=') vwZoomAt(1.5);
    else if (k === '-' || k === '_') vwZoomAt(1 / 1.5);
    else if (k === '0') vwFit();
    else if (k === 'b' || k === 'B') vwSetTool('draw');
    else if (k === 'h' || k === 'H' || k === 'v' || k === 'V') vwSetTool('pan');
    else if (k === 'ArrowLeft') openViewer(VW.i - 1);
    else if (k === 'ArrowRight') openViewer(VW.i + 1);
    else if ((e.metaKey || e.ctrlKey) && (k === 'z' || k === 'Z')) { VW.strokes.pop(); vwDraw(); }
    else return;
    e.preventDefault();
  });
  window.addEventListener('resize', () => {
    if (!$('viewer').open || !VW.img) return;
    const cx = vwC.width / 2, cy = vwC.height / 2, rel = VW.k / VW.fitK;
    const ix = (cx - VW.ox) / VW.k, iy = (cy - VW.oy) / VW.k;
    vwResize();
    const W = vwC.width, H = vwC.height;
    VW.fitK = Math.min(W / VW.img.width, H / VW.img.height) * 0.97;
    VW.k = VW.fitK * rel; VW.ox = W / 2 - ix * VW.k; VW.oy = H / 2 - iy * VW.k;
    vwDraw();
  });

  // ------------------------------------------------------------------ Simple / Advanced
  function setUI(ui, user) {
    UI = ui === 'advanced' ? 'advanced' : 'simple';
    document.body.classList.toggle('simple', UI === 'simple');
    document.body.classList.toggle('advanced', UI === 'advanced');
    document.querySelectorAll('#uiSeg button').forEach(b => b.classList.toggle('on', b.dataset.ui === UI));
    if (UI === 'simple') {
      // Simple = pure manual exposure: only shutter, aperture and ISO change the photo.
      S.mode = 'M'; S.autoISO = false; S.ec = 0; S.wb = 'auto'; S.tint = 0;
      if (user) S.last = 'welcome';
    }
    try { localStorage.setItem('camsim-ui', UI); } catch (e) { /* storage blocked */ }
    schedule(true);
  }

  // Side-effect gauges (Simple mode): one bar per consequence of the exposure triangle.
  function updateEffects() {
    const bar = (id, v) => { $(id).style.width = Math.max(0, Math.min(1, v)) * 100 + '%'; };
    const lvl = (v, words) => words[Math.min(words.length - 1, Math.floor(Math.max(0, Math.min(0.999, v)) * words.length))];
    // brightness: needle-like segment from the centre
    const d = Math.max(-3, Math.min(3, D.delta)), el = $('fxBright');
    const c = 50, p = 50 + d / 3 * 50;
    el.style.left = Math.min(c, p) + '%'; el.style.width = Math.max(1.2, Math.abs(p - c)) + '%';
    el.style.background = Math.abs(D.delta) <= 0.34 ? 'var(--ok)' : Math.abs(D.delta) <= 1 ? 'var(--warn)' : 'var(--bad)';
    $('fxBrightTxt').textContent = Math.abs(D.delta) <= 0.34 ? 'correct ✓' : `${D.delta > 0 ? 'too bright' : 'too dark'} (${stops(D.delta)} stops)`;
    // motion blur: the car (and the pinwheel), plus camera shake when handheld
    const carPx = S.carSpeed > 0 ? D.carV * D.t : 0, pinPx = D.pinTip * D.t;
    const motion = Math.max(carPx, pinPx * 0.5, S.support !== 'tripod' ? D.shake : 0);
    const mv = Math.log2(1 + motion) / Math.log2(1 + 600);
    bar('fxMotion', mv);
    $('fxMotionTxt').textContent = motion < 1.5 ? 'frozen' : lvl(mv, ['slight', 'slight', 'blurred', 'streaked']) +
      (S.support !== 'tripod' && D.shake > 1.5 && D.shake >= carPx * 0.5 ? ' + shake' : '');
    // background blur: how soft the far background is with the current aperture / focus
    const bg = D.blurR(120);
    const bv = Math.log2(1 + bg) / Math.log2(1 + 45);
    bar('fxDof', bv);
    $('fxDofTxt').textContent = bg < 0.8 ? 'all sharp' : lvl(bv, ['slightly soft', 'soft', 'blurred', 'very blurry']);
    // noise
    const nv = Math.log2(Math.max(1, D.noisePct / 1.5)) / Math.log2(30);
    bar('fxNoise', nv);
    $('fxNoiseTxt').textContent = D.noisePct < 3 ? 'clean' : D.noisePct < 8 ? 'fine grain' : D.noisePct < 18 ? 'noisy' : 'very noisy';
  }

  // ------------------------------------------------------------------ URL hash: share a setup
  // e.g. index.html#lighting=night&shutter=8"&aperture=8&iso=100&support=tripod&focal=85
  function applyHash() {
    const h = new URLSearchParams(location.hash.slice(1));
    if (![...h.keys()].length) return;
    const num = k => parseFloat(h.get(k));
    if (h.has('lighting') && SCENE.LIGHTING[h.get('lighting')]) S.lighting = h.get('lighting');
    if (h.has('mode')) S.mode = h.get('mode').toUpperCase();
    if (h.has('shutter')) {
      const v = h.get('shutter'), i = SHUTTER_LABELS.indexOf(v);
      const [n, d] = v.replace(/[^0-9./]/g, '').split('/').map(parseFloat);
      const t = d ? n / d : n;
      if (i >= 0) S.si = i; else if (t > 0) S.si = CAM.nearestIndex(SHUTTERS, t);
    }
    if (h.has('aperture')) S.ai = CAM.nearestIndex(APERTURES, num('aperture'));
    if (h.has('iso')) S.ii = CAM.nearestIndex(ISOS, num('iso'));
    if (h.has('ec')) S.ec = Math.round(num('ec') * 3);
    if (h.has('wb')) { const v = h.get('wb'); if (WB_PRESETS[v]) S.wb = v; else { S.wb = 'custom'; S.wbK = num('wb'); } }
    if (h.has('focal')) S.focal = Math.min(200, Math.max(24, num('focal')));
    if (h.has('focus')) { S.focus = h.get('focus') === 'inf' ? Infinity : num('focus'); S.af = null; S.focusName = ''; }
    if (h.has('sensor') && SENSORS[h.get('sensor')]) S.sensor = h.get('sensor');
    if (h.has('support')) S.support = h.get('support');
    if (h.has('car')) S.carSpeed = num('car');
    if (h.has('autoiso')) S.autoISO = h.get('autoiso') === '1';
    if (h.has('zebra')) S.zebra = h.get('zebra') === '1';
    if (h.has('ui')) UI = h.get('ui') === 'advanced' ? 'advanced' : 'simple';
    if (h.get('open') === 'settings') setTimeout(() => $('settings').showModal(), 0);
    if (h.get('open') === 'viewer') setTimeout(() => { shoot(); openViewer(0); }, 400);
    if (h.has('last')) S.last = h.get('last');
    if (h.has('debug')) setTimeout(() => {               // copy the frame to an <img> (for automated screenshots)
      R.develop({ ...lastDev, zebra: false });
      const img = new Image(); img.src = $('view').toDataURL();
      img.style.cssText = 'position:absolute;inset:0;width:100%;height:100%';
      $('frame').appendChild(img);
    }, 300);
  }

  // ------------------------------------------------------------------ go
  buildUI();
  applyHash();
  setUI(UI);
})();
