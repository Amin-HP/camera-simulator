// scene.js — procedural, depth-layered scene.
// Everything is drawn in "base" coordinates: a 1500×1000 frame that corresponds to a
// 24 mm lens on full frame. The camera is 1.0 m above flat ground, horizon at y = 430.
// Each group sits at a real distance (metres) so the renderer can compute physically
// based depth-of-field and motion blur.
'use strict';

const SCENE = (() => {
  const W = 1500, H = 1000, HZ = 430, F = 1000, CH = 1.0;
  const gy = d => HZ + F * CH / d;            // y of the ground at distance d
  const sx = (x, d) => 750 + x * F / d;       // x of a point x metres right of the axis
  const sy = (h, d) => HZ - (h - CH) * F / d; // y of a point h metres above ground
  const k = d => F / d;                       // pixels per metre at distance d

  function rng(seed) {
    return function () {
      seed |= 0; seed = seed + 0x6D2B79F5 | 0;
      let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
      t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
  }
  const rgb = (c, a = 1) => `rgba(${c[0] | 0},${c[1] | 0},${c[2] | 0},${a})`;
  const mix = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);

  function glow(ctx, x, y, r, c, a) {
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, rgb(c, a));
    g.addColorStop(0.35, rgb(c, a * 0.35));
    g.addColorStop(1, rgb(c, 0));
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
  }
  function disc(ctx, x, y, r, style) {
    ctx.fillStyle = style; ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
  }
  function poly(ctx, pts, style) {
    ctx.fillStyle = style; ctx.beginPath();
    pts.forEach((p, i) => i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1]));
    ctx.closePath(); ctx.fill();
  }

  // ------------------------------------------------------------------ lighting presets
  // ev      : scene brightness the light meter reads (EV at ISO 100)
  // ambK    : colour temperature of the ambient light falling on the scene
  // awbK    : where the camera's Auto White Balance lands
  // sky/sun/lamp : brightness of emissive things, relative to a correctly exposed white
  const LIGHTING = {
    sunny: {
      name: 'Sunny day', icon: '☀️', ev: 15, ambK: 5500, awbK: 5400, sky: 1, sun: 60, lamp: 0, lampK: 2800, lights: false,
      skyTop: [55, 115, 210], skyHz: [175, 208, 238], cloud: 'sunny', mtnFar: [150, 170, 200], mtnNear: [100, 120, 150], snow: true,
      sunPos: [1190, 120],
      desc: 'Bright midday sun, about EV 15 ("Sunny 16" rule: f/16, 1/100 s, ISO 100). Light is neutral ≈ 5500 K.'
    },
    overcast: {
      name: 'Overcast', icon: '☁️', ev: 12, ambK: 6800, awbK: 6500, sky: 1, sun: 0, lamp: 0, lampK: 2800, lights: false,
      skyTop: [165, 170, 178], skyHz: [222, 224, 228], cloud: 'overcast', mtnFar: [168, 172, 178], mtnNear: [128, 133, 140], snow: true,
      desc: 'Cloudy sky: 3 stops darker than sun (EV 12) and slightly blue light (≈ 6800 K). Soft, flat light.'
    },
    golden: {
      name: 'Golden hour', icon: '🌅', ev: 12, ambK: 3400, awbK: 4300, sky: 1, sun: 35, lamp: 0, lampK: 2800, lights: false,
      skyTop: [70, 100, 165], skyMid: [225, 160, 125], skyHz: [255, 195, 120], cloud: 'golden', mtnFar: [175, 140, 150], mtnNear: [120, 95, 110], snow: true,
      sunPos: [1075, 318],
      desc: 'Sun near the horizon: warm, orange light (≈ 3400 K). AWB keeps some warmth on purpose.'
    },
    bluehour: {
      name: 'Blue hour', icon: '🌆', ev: 7, ambK: 9500, awbK: 7000, sky: 1, sun: 0, lamp: 15, lampK: 2800, lights: true,
      skyTop: [18, 32, 88], skyHz: [95, 115, 178], stars: 0.35, mtnFar: [70, 82, 112], mtnNear: [48, 58, 82],
      desc: 'Just after sunset (EV 7). Blue skylight (≈ 9500 K) mixed with warm tungsten lamps (≈ 2800 K): a classic white-balance puzzle.'
    },
    night: {
      name: 'Night', icon: '🌙', ev: 3, ambK: 4200, awbK: 3800, sky: 1, sun: 0, lamp: 45, lampK: 2700, lights: true,
      skyTop: [5, 8, 22], skyHz: [22, 30, 58], stars: 1, moon: true, mtnFar: [40, 48, 66], mtnNear: [28, 34, 48],
      desc: 'Night (EV 3): 12 stops less light than sunshine. You need long shutter, wide aperture or high ISO, and a tripod.'
    },
  };

  // ------------------------------------------------------------------ draw functions
  function drawSky(a, e, P) {
    a.fillStyle = '#000'; a.fillRect(-2000, -2000, 5500, 5000);
    const g = e.createLinearGradient(0, -100, 0, HZ + 10);
    g.addColorStop(0, rgb(P.skyTop));
    if (P.skyMid) g.addColorStop(0.65, rgb(P.skyMid));
    g.addColorStop(1, rgb(P.skyHz));
    e.fillStyle = g; e.fillRect(-2000, -2000, 5500, HZ + 2080);

    const r = rng(11);
    if (P.cloud === 'sunny' || P.cloud === 'golden') {
      const base = P.cloud === 'golden' ? [245, 190, 160] : [236, 238, 242];
      const shade = P.cloud === 'golden' ? [200, 120, 130] : [196, 206, 222];
      [[260, 150, 1.1], [700, 80, 0.8], [880, 250, 1.3], [420, 300, 0.7], [1350, 300, 0.9], [-50, 260, 1]].forEach(([cx, cy, s]) => {
        for (let i = 0; i < 9; i++) {
          const ox = (r() - 0.5) * 180 * s, oy = (r() - 0.5) * 30 * s, rr = (25 + r() * 35) * s;
          disc(e, cx + ox, cy + oy + 6, rr, rgb(shade, 0.9));
          disc(e, cx + ox, cy + oy, rr * 0.92, rgb(base, 0.95));
        }
      });
    }
    if (P.cloud === 'overcast') {
      for (let i = 0; i < 60; i++) {
        const x = r() * 1900 - 200, y = r() * 380 - 40, rr = 60 + r() * 140;
        e.fillStyle = `rgba(150,154,162,${0.12 + r() * 0.15})`;
        e.beginPath(); e.ellipse(x, y, rr * 1.8, rr * 0.5, 0, 0, Math.PI * 2); e.fill();
      }
    }
    if (P.stars) {
      for (let i = 0; i < 380; i++) {
        const x = r() * 1900 - 200, y = r() * 520 - 120, b = r();
        e.fillStyle = `rgba(255,250,240,${(0.25 + b * 0.75) * P.stars})`;
        e.beginPath(); e.arc(x, y, 0.6 + b * 1.4, 0, Math.PI * 2); e.fill();
      }
    }
    if (P.moon) {
      glow(e, 1190, 140, 70, [200, 210, 255], 0.08);
      disc(e, 1190, 140, 24, 'rgb(250,248,235)');
    }
  }

  function drawSun(a, e, P) {
    if (!P.sun) return;
    const [x, y] = P.sunPos;
    const g = e.createRadialGradient(x, y, 0, x, y, 260);
    g.addColorStop(0, 'rgba(255,245,225,0.25)');
    g.addColorStop(0.1, 'rgba(255,240,215,0.05)');
    g.addColorStop(0.4, 'rgba(255,235,200,0.006)');
    g.addColorStop(1, 'rgba(255,235,200,0)');
    e.fillStyle = g; e.beginPath(); e.arc(x, y, 260, 0, Math.PI * 2); e.fill();
    disc(e, x, y, 24, 'rgb(255,250,240)');
  }

  function ridge(seed, x0, x1, base, amp, rough) {
    const r = rng(seed);
    let pts = [[x0, base - r() * amp], [x1, base - r() * amp]];
    let scale = amp;
    for (let it = 0; it < 8; it++) {
      const np = [];
      for (let i = 0; i < pts.length - 1; i++) {
        const [ax, ay] = pts[i], [bx, by] = pts[i + 1];
        np.push(pts[i]);
        let my = (ay + by) / 2 + (r() - 0.5) * scale;
        my = Math.min(base, Math.max(base - amp * 1.2, my));
        np.push([(ax + bx) / 2, my]);
      }
      np.push(pts[pts.length - 1]);
      pts = np; scale *= rough;
    }
    return pts;
  }
  function drawMountains(a, e, P) {
    const layers = [
      { seed: 3, base: HZ + 2, amp: 150, col: P.mtnFar, snow: P.snow ? 322 : null },
      { seed: 9, base: HZ + 2, amp: 85, col: P.mtnNear, snow: null },
    ];
    layers.forEach(L => {
      const pts = ridge(L.seed, -400, 1900, L.base, L.amp, 0.55);
      a.beginPath(); a.moveTo(-400, HZ + 40);
      pts.forEach(p => a.lineTo(p[0], p[1]));
      a.lineTo(1900, HZ + 40); a.closePath();
      a.fillStyle = rgb(L.col); a.fill();
      if (L.snow) {
        a.save(); a.clip();
        a.fillStyle = 'rgba(240,244,250,0.92)'; a.fillRect(-400, 0, 2300, L.snow - 0);
        a.restore();
      }
    });
  }

  function drawGround(a, e, P) {
    const top = HZ - 1;
    // base lawn gradient: hazy far → saturated near
    const g = a.createLinearGradient(0, top, 0, H);
    g.addColorStop(0, 'rgb(130,150,115)');
    g.addColorStop(0.12, 'rgb(95,135,70)');
    g.addColorStop(1, 'rgb(58,108,40)');
    a.fillStyle = g; a.fillRect(-2000, top, 5500, 3000);

    // mowing stripes every metre
    for (let d = 1.0, i = 0; d < 11.8; d += 1.0, i++) {
      if (i % 2) continue;
      a.fillStyle = 'rgba(190,230,140,0.10)';
      a.fillRect(-2000, gy(Math.min(d + 1, 11.8)), 5500, gy(d) - gy(Math.min(d + 1, 11.8)));
    }
    // near sidewalk + curb
    a.fillStyle = 'rgb(178,172,160)'; a.fillRect(-2000, gy(12.5), 5500, gy(11.8) - gy(12.5));
    a.fillStyle = 'rgb(120,115,108)'; a.fillRect(-2000, gy(12.5) - 0.8, 5500, 1.6);
    // road
    a.fillStyle = 'rgb(68,70,74)'; a.fillRect(-2000, gy(16), 5500, gy(12.5) - gy(16));
    // lane dashes
    a.fillStyle = 'rgb(235,230,210)';
    for (let x = -80; x < 80; x += 6) {
      const x0 = sx(x, 14.25), x1 = sx(x + 3, 14.25);
      a.fillRect(x0, gy(14.25) - 0.8, x1 - x0, 1.6);
    }
    // far sidewalk
    a.fillStyle = 'rgb(160,156,148)'; a.fillRect(-2000, gy(16.8), 5500, gy(16) - gy(16.8));

    // grass texture: small blades, more visible nearby (great for seeing depth of field)
    const r = rng(42);
    a.lineCap = 'round';
    for (let i = 0; i < 2600; i++) {
      const d = 1.0 + 10.6 * Math.pow(r(), 1.5);
      const xm = (r() - 0.5) * (d * 1.7 + 2);
      const x = sx(xm, d), y = gy(d), s = k(d);
      const L = (0.035 + r() * 0.05) * s;
      const shade = r();
      a.strokeStyle = shade < 0.5 ? `rgba(40,85,25,0.75)` : `rgba(140,190,90,0.6)`;
      a.lineWidth = Math.max(0.6, 0.007 * s);
      a.beginPath(); a.moveTo(x, y); a.lineTo(x + (r() - 0.5) * L * 0.6, y - L); a.stroke();
    }
    // tiny flowers
    for (let i = 0; i < 260; i++) {
      const d = 1.4 + 10 * Math.pow(r(), 1.3);
      const xm = (r() - 0.5) * (d * 1.6 + 2);
      const c = r() < 0.6 ? 'rgb(245,245,240)' : (r() < 0.5 ? 'rgb(250,215,60)' : 'rgb(190,120,220)');
      disc(a, sx(xm, d), gy(d) - 0.02 * k(d), Math.max(0.6, 0.018 * k(d)), c);
    }
    // far grass beyond the road
    a.fillStyle = 'rgba(110,140,90,0.5)'; a.fillRect(-2000, top, 5500, gy(16.8) - top);

    if (P.lights) {
      // pool of lamp light on the lawn under the lantern
      e.save();
      e.translate(sx(2.2, 7), gy(7));
      e.scale(1, 0.18);
      const pg = e.createRadialGradient(0, 0, 0, 0, 0, 380);
      pg.addColorStop(0, 'rgba(255,240,220,0.16)');
      pg.addColorStop(1, 'rgba(255,240,220,0)');
      e.fillStyle = pg; e.beginPath(); e.arc(0, 0, 380, 0, Math.PI * 2); e.fill();
      e.restore();
    }
  }

  function drawCity(a, e, P) {
    const d = 120, base = gy(d) + 0.5;
    const r = rng(7);
    let x = -150;
    while (x < 760) {
      const w = 25 + r() * 40, h = 40 + r() * 110;
      const tone = 70 + r() * 70;
      const col = [tone * 0.9, tone * 0.95, tone * 1.08];
      a.fillStyle = rgb(col); a.fillRect(x, base - h, w, h);
      a.fillStyle = rgb(col.map(v => v * 0.75)); a.fillRect(x + w - 4, base - h, 4, h);
      for (let wy = base - h + 6; wy < base - 8; wy += 10) {
        for (let wx = x + 4; wx < x + w - 8; wx += 8) {
          a.fillStyle = 'rgb(70,82,100)'; a.fillRect(wx, wy, 4, 5);
          if (P.lights && r() < 0.5) {
            e.fillStyle = r() < 0.8 ? 'rgba(255,205,140,0.22)' : 'rgba(210,225,255,0.2)';
            e.fillRect(wx, wy, 4, 5);
          }
        }
      }
      x += w + (r() < 0.3 ? 6 + r() * 20 : 0);
    }
    // tree line
    for (let i = 0; i < 70; i++) {
      const tx = 680 + r() * 1100, th = 45 + r() * 50, tw = 22 + r() * 22;
      const c = [40 + r() * 20, 70 + r() * 30, 40 + r() * 15];
      a.fillStyle = 'rgb(60,45,35)'; a.fillRect(tx - 1.5, base - th * 0.35, 3, th * 0.35);
      a.fillStyle = rgb(c);
      a.beginPath(); a.ellipse(tx, base - th * 0.6, tw / 2, th * 0.45, 0, 0, Math.PI * 2); a.fill();
    }
  }

  function drawFairyLights(a, e, P) {
    const d = 25, base = gy(d);
    const poles = [-30, -16, -6, 4, 14, 28].map(xm => sx(xm, d));
    const top = sy(3.4, d);
    const cols = [[255, 215, 150], [255, 110, 70], [110, 255, 140], [100, 160, 255], [255, 225, 80]];
    poles.forEach(px => { a.fillStyle = 'rgb(55,50,45)'; a.fillRect(px - 2, top - 4, 4, base - top + 4); });
    let n = 0;
    for (let i = 0; i < poles.length - 1; i++) {
      const x0 = poles[i], x1 = poles[i + 1], sag = 24;
      a.strokeStyle = 'rgba(40,40,40,0.9)'; a.lineWidth = 1;
      a.beginPath();
      for (let t = 0; t <= 1.0001; t += 0.02) {
        const x = x0 + (x1 - x0) * t, y = top + 4 * sag * t * (1 - t);
        t ? a.lineTo(x, y) : a.moveTo(x, y);
      }
      a.stroke();
      const count = Math.round((x1 - x0) / 22);
      for (let j = 1; j < count; j++) {
        const t = j / count, x = x0 + (x1 - x0) * t, y = top + 4 * sag * t * (1 - t) + 4;
        const c = cols[n++ % cols.length];
        disc(a, x, y, 3, 'rgb(205,205,192)');
        if (P.lights) {
          glow(e, x, y, 8, c, 0.08);
          disc(e, x, y, 2.6, rgb(c, 0.8));
        }
      }
    }
  }

  // car: moving group
  const CAR = { d: 14, cx: 740 };
  function drawCar(a, e, P) {
    const s = k(CAR.d), g0 = gy(CAR.d), cx = CAR.cx;
    const p = (xm, hm) => [cx + xm * s, g0 - hm * s];
    // shadow
    a.fillStyle = 'rgba(0,0,0,0.35)';
    a.beginPath(); a.ellipse(cx, g0 - 1, 2.3 * s, 0.09 * s, 0, 0, Math.PI * 2); a.fill();
    // body
    const body = [[-2.2, 0.3], [-2.26, 0.56], [-2.15, 0.86], [-1.3, 0.93], [-0.92, 1.4], [0.5, 1.42], [1.15, 0.99],
      [2.08, 0.86], [2.25, 0.62], [2.2, 0.3]].map(q => p(...q));
    poly(a, body, 'rgb(185,30,38)');
    // highlight band
    poly(a, [p(-2.15, 0.86), p(-1.3, 0.93), p(1.15, 0.99), p(2.08, 0.86), p(2.1, 0.8), p(-2.17, 0.8)], 'rgba(255,170,170,0.35)');
    // windows
    poly(a, [p(-1.17, 0.96), p(-0.86, 1.34), p(0.46, 1.36), p(1.0, 0.98)], 'rgb(32,42,58)');
    poly(a, [p(-0.25, 0.96), p(-0.2, 1.35), p(-0.1, 1.35), p(-0.13, 0.96)], 'rgb(185,30,38)');
    poly(a, [p(-0.75, 1.3), p(-0.55, 1.33), p(-0.85, 1.0), p(-1.0, 1.0)], 'rgba(200,220,255,0.35)');
    // doors / trim
    a.strokeStyle = 'rgba(80,10,15,0.8)'; a.lineWidth = 1;
    a.beginPath(); a.moveTo(...p(-0.2, 0.35)); a.lineTo(...p(-0.2, 0.95)); a.moveTo(...p(1.0, 0.4)); a.lineTo(...p(1.05, 0.97)); a.stroke();
    poly(a, [p(-2.2, 0.3), p(2.2, 0.3), p(2.21, 0.4), p(-2.21, 0.4)], 'rgb(40,40,42)');
    // wheels
    [-1.38, 1.38].forEach(wx => {
      disc(a, ...p(wx, 0.33), 0.39 * s, 'rgb(25,20,22)');
      disc(a, ...p(wx, 0.32), 0.32 * s, 'rgb(18,18,18)');
      disc(a, ...p(wx, 0.32), 0.2 * s, 'rgb(175,178,185)');
      disc(a, ...p(wx, 0.32), 0.07 * s, 'rgb(90,90,95)');
    });
    // lamps
    poly(a, [p(2.06, 0.68), p(2.24, 0.68), p(2.22, 0.8), p(2.04, 0.82)], 'rgb(240,240,225)');
    poly(a, [p(-2.25, 0.66), p(-2.12, 0.66), p(-2.12, 0.82), p(-2.2, 0.84)], 'rgb(190,20,25)');
  }
  // headlights & tail-lights: their own (very bright) light source → light trails
  function drawCarLights(a, e, P) {
    if (!P.lights) return;
    const s = k(CAR.d), g0 = gy(CAR.d), cx = CAR.cx;
    const p = (xm, hm) => [cx + xm * s, g0 - hm * s];
    const [hx, hy] = p(2.18, 0.74), [tx, ty] = p(-2.2, 0.75);
    e.save(); e.translate(...p(4.0, 0.0)); e.scale(1, 0.08);
    const bg = e.createRadialGradient(0, 0, 0, 0, 0, 1.9 * s);
    bg.addColorStop(0, 'rgba(255,250,235,0.05)'); bg.addColorStop(1, 'rgba(255,250,235,0)');
    e.fillStyle = bg; e.beginPath(); e.arc(0, 0, 1.9 * s, 0, Math.PI * 2); e.fill(); e.restore();
    glow(e, hx, hy, 0.3 * s, [255, 250, 235], 0.06);
    disc(e, hx, hy, 0.07 * s, 'rgb(255,252,240)');
    glow(e, tx, ty, 0.2 * s, [255, 6, 3], 0.06);
    disc(e, tx, ty, 0.06 * s, 'rgb(190,5,2)');
  }
  CAR.box = [CAR.cx - 2.9 * k(CAR.d), CAR.cx + 6.0 * k(CAR.d)]; // includes lights & beam

  function drawLantern(a, e, P) {
    const d = 7, s = k(d), x = sx(2.2, d), g0 = gy(d);
    const top = sy(1.6, d);
    a.fillStyle = 'rgb(35,40,42)';
    a.fillRect(x - 0.1 * s, g0 - 0.22 * s, 0.2 * s, 0.22 * s);       // plinth
    a.fillRect(x - 0.045 * s, top, 0.09 * s, g0 - top);                // post
    // lantern
    const lw = 0.2 * s, lh = 0.26 * s, ly = top - lh;
    a.fillRect(x - lw / 2 - 3, top - 4, lw + 6, 6);
    a.fillStyle = 'rgb(228,222,195)'; a.fillRect(x - lw / 2, ly, lw, lh);
    a.strokeStyle = 'rgb(35,40,42)'; a.lineWidth = 3;
    a.strokeRect(x - lw / 2, ly, lw, lh);
    a.beginPath(); a.moveTo(x, ly); a.lineTo(x, ly + lh); a.stroke();
    poly(a, [[x - lw / 2 - 8, ly + 1], [x + lw / 2 + 8, ly + 1], [x, ly - 0.14 * s]], 'rgb(35,40,42)');
    disc(a, x, ly - 0.15 * s, 4, 'rgb(35,40,42)');
    if (P.lights) {
      const cy = ly + lh / 2;
      glow(e, x, cy, 0.45 * s, [255, 230, 185], 0.16);
      e.fillStyle = 'rgb(255,236,200)'; e.fillRect(x - lw / 2 + 2, ly + 2, lw - 4, lh - 4);
    }
  }

  const CHECKER = [
    [115, 82, 68], [194, 150, 130], [98, 122, 157], [87, 108, 67], [133, 128, 177], [103, 189, 170],
    [214, 126, 44], [80, 91, 166], [193, 90, 99], [94, 60, 108], [157, 188, 64], [224, 163, 46],
    [56, 61, 150], [70, 148, 73], [175, 54, 60], [231, 199, 31], [187, 86, 149], [8, 133, 161],
    [243, 243, 242], [200, 200, 200], [160, 160, 160], [122, 122, 121], [85, 85, 85], [52, 52, 52],
  ];
  const PIN = { d: 3, x: 0, y: 0, R: 0 };
  PIN.x = sx(0.63, 3); PIN.y = sy(0.85, 3); PIN.R = 0.2 * k(3);

  function drawSubject(a, e, P) {
    const d = 3, s = k(d), g0 = gy(d);
    const cx = 560, cw = 0.6 * s, ch = 0.42 * s, cy = sy(0.6, d);
    const x0 = cx - cw / 2, y0 = cy - ch / 2;
    // easel
    a.lineCap = 'round';
    a.strokeStyle = 'rgb(105,70,40)'; a.lineWidth = 0.022 * s;
    a.beginPath(); a.moveTo(cx, y0 - 30); a.lineTo(cx + 4, g0 - 70); a.stroke();
    a.strokeStyle = 'rgb(150,102,58)'; a.lineWidth = 0.026 * s;
    a.beginPath(); a.moveTo(cx - 40, y0 - 25); a.lineTo(cx - 95, g0); a.moveTo(cx + 40, y0 - 25); a.lineTo(cx + 95, g0); a.stroke();
    // shadow on lawn
    a.fillStyle = 'rgba(0,0,0,0.25)';
    a.beginPath(); a.ellipse(cx, g0, 120, 10, 0, 0, Math.PI * 2); a.fill();
    // chart
    a.fillStyle = 'rgb(22,22,22)'; a.fillRect(x0, y0, cw, ch);
    const pad = 7, gap = 4, pw = (cw - 2 * pad - 5 * gap) / 6, ph = (ch - 2 * pad - 3 * gap) / 4;
    CHECKER.forEach((c, i) => {
      const col = i % 6, row = (i / 6) | 0;
      a.fillStyle = rgb(c);
      a.fillRect(x0 + pad + col * (pw + gap), y0 + pad + row * (ph + gap), pw, ph);
    });
    // ledge
    a.fillStyle = 'rgb(140,95,55)'; a.fillRect(cx - cw / 2 - 12, y0 + ch, cw + 24, 9);
    // focus target: fine lines on a small card on top of the chart
    a.fillStyle = 'rgb(240,240,236)'; a.fillRect(cx - 35, y0 - 34, 70, 30);
    a.fillStyle = 'rgb(20,20,20)';
    for (let i = 0; i < 9; i++) a.fillRect(cx - 30 + i * 7, y0 - 30, 3, 22);
    // pinwheel stick
    a.fillStyle = 'rgb(236,236,236)';
    a.fillRect(PIN.x - 3, PIN.y, 6, g0 - PIN.y);
    a.fillStyle = 'rgb(220,60,60)';
    for (let y = PIN.y + 10; y < g0; y += 24) a.fillRect(PIN.x - 3, y, 6, 8);
    a.fillStyle = 'rgba(0,0,0,0.25)';
    a.beginPath(); a.ellipse(PIN.x, g0, 20, 4, 0, 0, Math.PI * 2); a.fill();
  }

  function drawPinwheel(a, e, P) {
    const R = PIN.R;
    const cols = [[230, 50, 55], [250, 200, 40], [40, 120, 230], [60, 180, 80]];
    a.save(); a.translate(PIN.x, PIN.y);
    cols.forEach((c, i) => {
      a.save(); a.rotate(i * Math.PI / 2);
      poly(a, [[0, 0], [0, -R], [R * 0.75, -R * 0.75]], rgb(c));
      poly(a, [[0, 0], [0, -R], [R * 0.28, -R * 0.55]], rgb(c.map(v => v * 0.65)));
      a.restore();
    });
    disc(a, 0, 0, 7, 'rgb(245,245,245)');
    disc(a, 0, 0, 2.5, 'rgb(120,120,120)');
    a.restore();
  }

  function drawForeground(a, e, P) {
    const r = rng(99);
    a.lineCap = 'round';
    const clusters = [[250, 580], [960, 1290]];
    clusters.forEach(([xa, xb]) => {
      for (let i = 0; i < 45; i++) {
        const x = xa + r() * (xb - xa), h = 180 + r() * 260, w = 6 + r() * 10, lean = (r() - 0.5) * 140;
        a.fillStyle = `rgb(${45 + r() * 40 | 0},${110 + r() * 60 | 0},${35 + r() * 25 | 0})`;
        a.beginPath(); a.moveTo(x - w / 2, H + 20);
        a.quadraticCurveTo(x + lean * 0.3, H - h * 0.6, x + lean, H - h);
        a.quadraticCurveTo(x + lean * 0.3 + w * 0.3, H - h * 0.6, x + w / 2, H + 20);
        a.fill();
      }
    });
    const flowers = [[330, 690, 34, 'daisy'], [455, 640, 38, 'daisy'], [520, 730, 30, 'daisy'], [270, 770, 32, 'daisy'],
      [1030, 700, 34, 'cosmos'], [1150, 650, 38, 'cosmos'], [1235, 745, 30, 'cosmos']];
    flowers.forEach(([x, y, R, kind]) => {
      a.strokeStyle = 'rgb(60,120,45)'; a.lineWidth = 7;
      a.beginPath(); a.moveTo(x, y); a.quadraticCurveTo(x + 20, y + 150, x - 10, H + 20); a.stroke();
      const petal = kind === 'daisy' ? 'rgb(236,236,232)' : 'rgb(235,90,150)';
      const n = kind === 'daisy' ? 14 : 8;
      for (let i = 0; i < n; i++) {
        const t = i / n * Math.PI * 2 + r() * 0.1;
        a.save(); a.translate(x, y); a.rotate(t);
        a.fillStyle = petal;
        a.beginPath(); a.ellipse(R * 0.55, 0, R * 0.5, kind === 'daisy' ? R * 0.14 : R * 0.3, 0, 0, Math.PI * 2); a.fill();
        a.restore();
      }
      disc(a, x, y, R * 0.28, kind === 'daisy' ? 'rgb(245,195,30)' : 'rgb(250,210,60)');
    });
  }

  // ------------------------------------------------------------------ groups (back → front)
  // depth: metres (Infinity for sky), or 'ground' for per-pixel analytic depth.
  const GROUPS = [
    { id: 'far', label: 'Mountains / sky', depth: Infinity, subs: [
      { kind: 'sky', draw: drawSky }, { kind: 'sun', draw: drawSun }, { kind: 'lamp', draw: drawMountains }] },
    { id: 'ground', label: 'Lawn & road', depth: 'ground', subs: [{ kind: 'lamp', draw: drawGround }] },
    { id: 'city', label: 'City & trees', depth: 120, subs: [{ kind: 'lamp', draw: drawCity }] },
    { id: 'lights', label: 'Fairy lights', depth: 25, subs: [{ kind: 'lamp', draw: drawFairyLights }] },
    { id: 'car', label: 'Car', depth: CAR.d, motion: 'linear', subs: [{ kind: 'lamp', draw: drawCar }, { kind: 'car', draw: drawCarLights }] },
    { id: 'lantern', label: 'Lantern', depth: 7, subs: [{ kind: 'lamp', draw: drawLantern }] },
    { id: 'subject', label: 'Colour chart', depth: 3, subs: [{ kind: 'lamp', draw: drawSubject }] },
    { id: 'pinwheel', label: 'Pinwheel', depth: PIN.d, motion: 'rotate', subs: [{ kind: 'lamp', draw: drawPinwheel }] },
    { id: 'fg', label: 'Flowers (foreground)', depth: 1.2, subs: [{ kind: 'lamp', draw: drawForeground }] },
  ];

  // Objects shown on the depth-of-field map.
  const MARKERS = [
    { label: 'Flowers', d: 1.2 }, { label: 'Chart', d: 3 }, { label: 'Lantern', d: 7 },
    { label: 'Car', d: CAR.d }, { label: 'Lights', d: 25 }, { label: 'City', d: 120 }, { label: 'Mountains', d: Infinity },
  ];

  function groundDepthAtY(yb) { return yb > HZ + 0.5 ? F * CH / (yb - HZ) : Infinity; }

  return { W, H, HZ, F, CH, LIGHTING, GROUPS, MARKERS, CAR, PIN, groundDepthAtY, k };
})();
