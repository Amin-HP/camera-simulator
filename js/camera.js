// camera.js — exposure math, value tables and optics helpers (no DOM, no WebGL)
'use strict';

const CAM = (() => {
  // ---- Standard 1/3-stop value tables (nominal values as printed on cameras) ----
  const SHUTTER_LABELS = [
    '30"', '25"', '20"', '15"', '13"', '10"', '8"', '6"', '5"', '4"', '3.2"', '2.5"', '2"', '1.6"', '1.3"', '1"',
    '0.8"', '0.6"', '0.5"', '0.4"', '0.3"', '1/4', '1/5', '1/6', '1/8', '1/10', '1/13', '1/15', '1/20', '1/25',
    '1/30', '1/40', '1/50', '1/60', '1/80', '1/100', '1/125', '1/160', '1/200', '1/250', '1/320', '1/400',
    '1/500', '1/640', '1/800', '1/1000', '1/1250', '1/1600', '1/2000', '1/2500', '1/3200', '1/4000', '1/5000',
    '1/6400', '1/8000'
  ];
  const SHUTTERS = SHUTTER_LABELS.map(l => {
    if (l.endsWith('"')) return parseFloat(l);
    const [a, b] = l.split('/');
    return parseFloat(a) / parseFloat(b);
  });

  const APERTURES = [1.4, 1.6, 1.8, 2, 2.2, 2.5, 2.8, 3.2, 3.5, 4, 4.5, 5, 5.6, 6.3, 7.1, 8, 9, 10, 11, 13, 14, 16, 18, 20, 22];
  const ISOS = [100, 125, 160, 200, 250, 320, 400, 500, 640, 800, 1000, 1250, 1600, 2000, 2500, 3200, 4000, 5000,
    6400, 8000, 10000, 12800, 16000, 20000, 25600, 32000, 40000, 51200];

  const SENSORS = {
    ff:   { name: 'Full frame (36×24 mm)', width: 36,   crop: 1.0 },
    apsc: { name: 'APS-C (23.5×15.6 mm)',  width: 23.5, crop: 1.53 },
    m43:  { name: 'Micro 4/3 (17.3×13 mm)', width: 17.3, crop: 2.0 },
  };

  const WB_PRESETS = {
    auto:        { name: 'Auto (AWB)',   k: null },
    daylight:    { name: 'Daylight ☀',   k: 5200 },
    cloudy:      { name: 'Cloudy ☁',     k: 6000 },
    shade:       { name: 'Shade',        k: 7000 },
    tungsten:    { name: 'Tungsten 💡',  k: 3200 },
    fluorescent: { name: 'Fluorescent',  k: 4000 },
    flash:       { name: 'Flash ⚡',      k: 5500 },
    custom:      { name: 'Custom (K)',   k: null },
  };

  const log2 = Math.log2;

  // Exposure value of the camera settings, normalised to ISO 100.
  // Higher EV = less light reaches the final image.
  function settingsEV100(N, t, iso) {
    return log2((N * N) / t) - log2(iso / 100);
  }

  // How many stops brighter (+) or darker (−) than the meter's "correct" exposure.
  function exposureDelta(sceneEV, N, t, iso) {
    return sceneEV - settingsEV100(N, t, iso);
  }

  function nearestIndex(list, value) {
    let best = 0, bestErr = Infinity;
    for (let i = 0; i < list.length; i++) {
      const e = Math.abs(log2(list[i]) - log2(value));
      if (e < bestErr) { bestErr = e; best = i; }
    }
    return best;
  }

  function shutterLabel(t) {
    const i = nearestIndex(SHUTTERS, t);
    return SHUTTER_LABELS[i].replace('"', ' s');
  }

  // ---- Optics ----
  // Circle-of-confusion *diameter* on the sensor (mm) for an object at distance d (m)
  // when a lens of focal length f (mm) at f-number N is focused at s (m).
  function cocMM(f, N, s, d) {
    const S = s * 1000, D = Math.min(d, 1e7) * 1000;
    if (S <= f) return 0;
    return (f * f / (N * (S - f))) * Math.abs(D - S) / D;
  }

  // Depth-of-field limits (m) using acceptable CoC c (mm).
  function dofLimits(f, N, s, c) {
    const H = (f * f) / (N * c) + f; // hyperfocal, mm
    const S = s * 1000;
    const near = S * (H - f) / (H + S - 2 * f);
    const far = S < H ? S * (H - f) / (H - S) : Infinity;
    return { near: near / 1000, far: far / 1000, hyperfocal: H / 1000 };
  }

  // ---- Colour temperature ----
  function srgbToLin(c) { return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); }

  // Approximate black-body colour (Tanner Helland fit) → linear RGB.
  function kelvinRGB(K) {
    const t = K / 100;
    let r, g, b;
    if (t <= 66) {
      r = 255;
      g = 99.4708025861 * Math.log(t) - 161.1195681661;
      b = t <= 19 ? 0 : 138.5177312231 * Math.log(t - 10) - 305.0447927307;
    } else {
      r = 329.698727446 * Math.pow(t - 60, -0.1332047592);
      g = 288.1221695283 * Math.pow(t - 60, -0.0755148492);
      b = 255;
    }
    const cl = v => Math.min(255, Math.max(1, v)) / 255;
    return [srgbToLin(cl(r)), srgbToLin(cl(g)), srgbToLin(cl(b))];
  }

  const REF = kelvinRGB(6500);

  // Colour of a light source relative to a neutral (6500 K) white, normalised to luminance 1.
  function lightTint(K) {
    const c = kelvinRGB(K);
    const v = [c[0] / REF[0], c[1] / REF[1], c[2] / REF[2]];
    const lum = 0.2126 * v[0] + 0.7152 * v[1] + 0.0722 * v[2];
    return v.map(x => x / lum);
  }

  // Camera white-balance channel gains: cancel a light of temperature K (green = 1).
  function wbGains(K, tint) {
    const l = lightTint(K);
    const g = [1 / l[0], 1 / l[1], 1 / l[2]];
    const n = g[1];
    const out = g.map(x => x / n);
    out[1] *= Math.pow(2, -(tint || 0) / 25); // + tint = magenta, − tint = green
    return out;
  }

  // Approximate apparent colour (sRGB hex) of a light at temperature K, for UI swatches.
  function kelvinCSS(K) {
    const t = K / 100;
    let r, g, b;
    if (t <= 66) { r = 255; g = 99.47 * Math.log(t) - 161.12; b = t <= 19 ? 0 : 138.52 * Math.log(t - 10) - 305.04; }
    else { r = 329.7 * Math.pow(t - 60, -0.1332); g = 288.12 * Math.pow(t - 60, -0.0755); b = 255; }
    const c = v => Math.round(Math.min(255, Math.max(0, v)));
    return `rgb(${c(r)},${c(g)},${c(b)})`;
  }

  return {
    SHUTTERS, SHUTTER_LABELS, APERTURES, ISOS, SENSORS, WB_PRESETS,
    settingsEV100, exposureDelta, nearestIndex, shutterLabel,
    cocMM, dofLimits, lightTint, wbGains, kelvinCSS,
  };
})();
