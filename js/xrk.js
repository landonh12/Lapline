'use strict';
/*
 * Reader for AiM RaceStudio3 .xrk files (MXS, Solo 2 DL, EVO5 ...).
 * Produces the same file object as DRK.parse so the rest of the app is format-agnostic.
 * Layout notes are in FORMAT.md.
 */
const XRK = (() => {
  // unit code (CHS +0x0C, low 7 bits) -> [unit, display decimals]
  const UNITS = {
    1: ['%', 1], 3: ['g', 2], 4: ['deg', 1], 5: ['deg/s', 1], 8: ['m', 0], 11: ['#', 0],
    14: ['bar', 2], 15: ['rpm', 0], 16: ['km/h', 1], 17: ['°C', 1], 18: ['ms', 0], 19: ['Nm', 0],
    21: ['V', 2], 22: ['l', 1], 31: ['gear', 0],
  };

  function half(h) {
    const s = h & 0x8000 ? -1 : 1, e = (h >> 10) & 0x1f, f = h & 0x3ff;
    if (e === 0) return s * f * 2 ** -24;
    if (e === 31) return f ? NaN : s * Infinity;
    return s * (1 + f / 1024) * 2 ** (e - 15);
  }

  function cstr(u8, off, len) {
    let s = '';
    for (let i = 0; i < len; i++) { const c = u8[off + i]; if (!c) break; s += String.fromCharCode(c); }
    return s.trim();
  }

  function ecefToLla(x, y, z) {
    const a = 6378137, f = 1 / 298.257223563, e2 = f * (2 - f), b = a * (1 - f), ep2 = (a * a - b * b) / (b * b);
    const p = Math.hypot(x, y), th = Math.atan2(z * a, p * b);
    const lat = Math.atan2(z + ep2 * b * Math.sin(th) ** 3, p - e2 * a * Math.cos(th) ** 3);
    const lon = Math.atan2(y, x);
    const N = a / Math.sqrt(1 - e2 * Math.sin(lat) ** 2);
    return [lat, lon, p / Math.cos(lat) - N];
  }

  function parse(buffer, fileName = '') {
    const u8 = new Uint8Array(buffer), dv = new DataView(buffer), n = u8.length;
    const tagAt = o => String.fromCharCode(u8[o], u8[o + 1], u8[o + 2], u8[o + 3]);
    // message: "<h" TAG(4) u32 len u8 ver ">" payload "<" TAG(4) u16 sum ">"
    function msgAt(i) {
      if (i + 12 > n || u8[i] !== 0x3c || u8[i + 1] !== 0x68 || u8[i + 11] !== 0x3e) return null;
      const tag = tagAt(i + 2), len = dv.getUint32(i + 6, true), e = i + 12 + len;
      if (e + 8 > n || u8[e] !== 0x3c || tagAt(e + 1) !== tag || u8[e + 7] !== 0x3e) return null;
      return { tag, body: i + 12, len, next: e + 8 };
    }
    if (!msgAt(0)) throw new Error('This is not an AiM .xrk file.');

    const chs = new Map(), groups = new Map(), laps = [], gps = [], meta = {};
    const samples = new Map();   // channel idx -> { t: [], v: [] }
    const push = (ch, t, v) => { let s = samples.get(ch); if (!s) samples.set(ch, s = { t: [], v: [] }); s.t.push(t); s.v.push(v); };
    const readVal = (c, o) => c.size === 2 ? half(dv.getUint16(o, true))
      : c.fmt === 3 ? dv.getInt32(o, true) : dv.getFloat32(o, true);

    function handle(m) {
      const b = m.body;
      switch (m.tag) {
        case 'CNF\0': for (let j = b; j < b + m.len;) { const s = msgAt(j); if (!s) break; handle(s); j = s.next; } break;
        case 'CHS\0': {
          const idx = dv.getUint16(b, true);
          chs.set(idx, {
            idx, short: cstr(u8, b + 0x18, 8), name: cstr(u8, b + 0x20, 0x20), unit: u8[b + 0x0c] & 0x7f,
            fmt: u8[b + 0x14], period: dv.getUint32(b + 0x40, true), size: dv.getUint32(b + 0x48, true),
          });
          break;
        }
        case 'GRP\0': {
          const g = dv.getUint16(b, true), cnt = dv.getUint16(b + 2, true), list = [];
          for (let k = 0; k < cnt; k++) list.push(dv.getUint16(b + 4 + 2 * k, true));
          groups.set(g, list);
          break;
        }
        case 'LAP\0':
          laps.push({ no: dv.getUint16(b + 2, true), time: dv.getUint32(b + 4, true), flag: u8[b + 13], end: dv.getUint32(b + 16, true) });
          break;
        case 'GPS\0': if (m.len >= 56) gps.push(b); break;
        case 'RCR\0': case 'VEH\0': case 'TRK ': case 'TMD\0': case 'TMT\0':
          meta[m.tag.trim().replace('\0', '')] = cstr(u8, b, m.len);
          break;
      }
    }

    let i = 0;
    while (i < n) {
      const m = msgAt(i);
      if (m) { handle(m); i = m.next; continue; }
      if (u8[i] === 0x28 && i + 8 < n) {
        const k = u8[i + 1];
        if (k === 0x53) {                                   // (S tc ch value )
          const c = chs.get(dv.getUint16(i + 6, true));
          if (c && (c.size === 2 || c.size === 4)) { push(c.idx, dv.getUint32(i + 2, true), readVal(c, i + 8)); }
          if (c) { i += 9 + c.size; continue; }
        } else if (k === 0x4d) {                            // (M tc ch count values... )
          const tc = dv.getUint32(i + 2, true), c = chs.get(dv.getUint16(i + 6, true)), cnt = dv.getUint16(i + 8, true);
          if (c) {
            if (c.size === 2 || c.size === 4) for (let j = 0; j < cnt; j++) push(c.idx, tc + j * c.period / 1000, readVal(c, i + 10 + j * c.size));
            i += 11 + cnt * c.size; continue;
          }
        } else if (k === 0x47) {                            // (G tc group values... )
          const tc = dv.getUint32(i + 2, true), list = groups.get(dv.getUint16(i + 6, true));
          if (list) {
            let o = i + 8;
            let ok = true;
            for (const idx of list) {
              const c = chs.get(idx);
              if (!c) { ok = false; break; }
              if (c.size === 2 || c.size === 4) push(idx, tc, readVal(c, o));
              o += c.size;
            }
            if (ok) { i = o + 1; continue; }
          }
        }
      }
      i++;
    }
    if (!chs.size) throw new Error('No channels were found in this file.');

    // Timeline: t = 0 at the start of the first lap (or the first sample).
    laps.sort((a, b) => a.no - b.no);
    let t0 = laps.length ? laps[0].end - laps[0].time : Infinity;
    for (const s of samples.values()) if (s.t[0] < t0) t0 = s.t[0];
    let tEnd = laps.length ? laps[laps.length - 1].end : 0;
    for (const s of samples.values()) tEnd = Math.max(tEnd, s.t[s.t.length - 1]);
    const durationMs = Math.max(1, tEnd - t0);

    const channels = [];
    // Resample onto a uniform grid at the channel's nominal rate so lapData can treat sample k as t = k / rate.
    function addChannel(name, unit, decimals, rateHz, t, v, extra = {}) {
      for (let k = 1; k < t.length; k++) {
        if (t[k] < t[k - 1]) {
          const ord = t.map((_, q) => q).sort((a, b) => t[a] - t[b]);
          t = ord.map(q => t[q]); v = ord.map(q => v[q]);
          break;
        }
      }
      const { data, rate, count, valid } = DRK.resample(t, v, t0, durationMs, rateHz);
      channels.push({
        id: channels.length, name, label: name, code: extra.code || '', unit, decimals, typ: extra.typ || 0,
        count, rate, data, valid, lo: 0, hi: 0,
      });
    }

    for (const c of [...chs.values()].sort((a, b) => a.idx - b.idx)) {
      const s = samples.get(c.idx);
      if (c.period === 0 || c.unit === 18 || c.unit === 26 || /^(MClk|StrtRec)$/.test(c.short)) continue;
      let [unit, dec] = UNITS[c.unit] || ['', 2];
      let v = s ? s.v : [];
      if (unit === 'V' && v.length && v.reduce((a, b) => a + b, 0) / v.length > 100) v = v.map(x => x / 1000);  // logged in mV
      let typ = 0;
      if (c.short === 'LatA') typ = 3003;
      if (c.short === 'InlA') typ = 3004;
      addChannel(c.name, unit, dec, 1e6 / (c.period || 100000), s ? s.t : [], v, { code: `${c.short} / u${c.unit}`, typ });
    }

    // GPS: u32 logger time + u-blox NAV-SOL (iTOW, fTOW, week, fix, flags, ECEF pos/vel cm, accuracies, numSV)
    if (gps.length) {
      const T = [], lat = [], lon = [], alt = [], spd = [], hdg = [], nsv = [], pacc = [];
      for (const b of gps) {
        const fix = u8[b + 14];
        if (fix < 2) continue;
        const X = dv.getInt32(b + 16, true) / 100, Y = dv.getInt32(b + 20, true) / 100, Z = dv.getInt32(b + 24, true) / 100;
        if (!X && !Y && !Z) continue;
        const vx = dv.getInt32(b + 32, true) / 100, vy = dv.getInt32(b + 36, true) / 100, vz = dv.getInt32(b + 40, true) / 100;
        const [la, lo, h] = ecefToLla(X, Y, Z);
        const ve = -Math.sin(lo) * vx + Math.cos(lo) * vy;
        const vn = -Math.sin(la) * Math.cos(lo) * vx - Math.sin(la) * Math.sin(lo) * vy + Math.cos(la) * vz;
        T.push(dv.getUint32(b, true)); lat.push(la * 180 / Math.PI); lon.push(lo * 180 / Math.PI); alt.push(h);
        spd.push(Math.hypot(ve, vn) * 3.6); hdg.push(Math.atan2(ve, vn) * 180 / Math.PI);
        nsv.push(u8[b + 51]); pacc.push(dv.getUint32(b + 28, true) / 100);
      }
      if (T.length > 1) {
        const rate = 1000 / Math.max(20, (T[T.length - 1] - T[0]) / (T.length - 1));
        // heading must not be interpolated across ±180: unwrap, then fold back after resampling
        const unwrapped = hdg.slice();
        for (let k = 1; k < unwrapped.length; k++) {
          let d = unwrapped[k] - unwrapped[k - 1];
          unwrapped[k] -= Math.round(d / 360) * 360;
        }
        addChannel('GPS Speed', 'km/h', 1, rate, T, spd, { typ: 3001, code: 'GPS' });
        addChannel('GPS Heading', 'deg', 1, rate, T, unwrapped, { typ: 3006, code: 'GPS' });
        const hc = channels[channels.length - 1];
        for (let k = 0; k < hc.data.length; k++) if (!isNaN(hc.data[k])) hc.data[k] = (((hc.data[k] + 180) % 360) + 360) % 360 - 180;
        addChannel('GPS Latitude', 'deg', 6, rate, T, lat, { typ: 3010, code: 'GPS' });
        addChannel('GPS Longitude', 'deg', 6, rate, T, lon, { typ: 3011, code: 'GPS' });
        addChannel('GPS Altitude', 'm', 0, rate, T, alt, { code: 'GPS' });
        addChannel('GPS Nsat', '#', 0, rate, T, nsv, { code: 'GPS' });
        addChannel('GPS PosAccuracy', 'm', 2, rate, T, pacc, { code: 'GPS' });
      }
    }

    let lapList = laps.map((l, k) => ({
      idx: k, startMs: l.end - l.time - t0, spanMs: l.time, timeMs: l.time, lapNo: l.no, session: 1,
      kind: l.flag === 1 ? 'out' : l.flag === 3 ? 'in' : 'lap',
    }));
    if (!lapList.length) lapList = [{ idx: 0, startMs: 0, spanMs: durationMs, timeMs: durationMs, lapNo: 1, session: 1, kind: 'lap' }];
    const timed = lapList.filter(l => l.kind === 'lap');
    const best = timed.length ? timed.reduce((a, b) => (b.timeMs < a.timeMs ? b : a)) : null;
    const whole = { idx: -1, startMs: lapList[0].startMs, spanMs: 0, timeMs: 0, lapNo: 0, session: 1, kind: 'session' };
    const last = lapList[lapList.length - 1];
    whole.spanMs = whole.timeMs = last.startMs + last.spanMs - whole.startMs;
    const sessions = [{ no: 1, laps: lapList, whole, best }];

    const dm = (meta.TMD || '').match(/(\d+)\/(\d+)\/(\d+)/), tm = (meta.TMT || '').match(/(\d+):(\d+):(\d+)/);
    const date = dm ? new Date(+dm[3], +dm[1] - 1, +dm[2], tm ? +tm[1] : 0, tm ? +tm[2] : 0, tm ? +tm[3] : 0) : null;

    const file = {
      fileName, format: 'xrk', date, durationMs, channels, laps: lapList, sessions, best, truncated: false,
      meta: { vehicle: meta.VEH || '', track: meta.TRK || '', driver: meta.RCR || '', name: '' },
      masterRate: Math.min(50, Math.max(...channels.map(c => c.rate), 1)),
    };
    file.byName = new Map(channels.map(c => [c.name, c]));
    file.speedCh = channels.find(c => c.typ === 3001) || channels.find(c => c.unit === 'km/h' && c.valid);
    file.headingCh = channels.find(c => c.typ === 3006);
    file.latCh = channels.find(c => c.typ === 3010);
    file.lonCh = channels.find(c => c.typ === 3011);
    return file;
  }

  return { parse };
})();
