'use strict';
/*
 * Reader for AiM RaceStudio2 .drk files (RDX v2 container, e.g. Solo / Solo DL / MXL).
 * Format reverse-engineered from real files; see FORMAT.md for the layout.
 */
const DRK = (() => {
  const SENTINEL = -12290;            // 0xCFFE marks "no data" in a sample slot
  const BODY = { PPX: 0x400, IIX: 0x80, MMX: 0x400, GGX: 0x100, RRX: 0x1000 };

  const UNIT_BY_CLASS = {
    '01': '°C', '02': 'km/h', '04': 'g', '06': 'deg', '07': '%', '08': '#',
    '09': 'm', '10': 'V', '15': 'Nm', '16': 'l',
  };
  const PRETTY = {
    'Internal Batte': 'Internal Battery', 'External Batte': 'External Battery',
    'Longitudinal_a': 'Longitudinal Acc', 'Lateral_acc': 'Lateral Acc', 'Vertical_acc': 'Vertical Acc',
    'ENGINE_OIL_TEM': 'ENGINE_OIL_TEMP', 'GEARBOX_OILT': 'GEARBOX_OIL_TEMP',
  };

  function unitFor(code) {
    const cls = code.slice(0, 2), sub = code.slice(2, 4);
    if (cls === '03') return sub === '04' ? 'psi' : 'bar';
    if (cls === '11') return sub === '04' ? 'rpm' : 'deg/s';
    return UNIT_BY_CLASS[cls] || '';
  }

  // Raw int16 -> engineering units. Keyed by the sensor type id stored at +0x40 of the
  // channel descriptor; calibrated against RaceStudio2 CSV exports.
  function converter(ch) {
    switch (ch.typ) {
      case 341: return r => r / 1000;                       // battery, mV
      case 120: return r => r;                              // RPM
      case 121: case 3001: return r => r / 10;              // speeds, 0.1 km/h
      case 150: return r => r / 10;                         // pedal / engine load, 0.1 %
      case 122: return r => r / 10;                         // water temp, 0.1 °C
      case 315: return r => r / 100;                        // fuel, 0.01 l
      case 336: return r => r / 100;                        // GPS position accuracy, cm
      case 3003: case 3004: return r => (r - 16000) / 1570.8; // GPS lat/lon acceleration
      case 3005: return r => (r - 15708) * 0.0057296;       // GPS slope, 1e-4 rad -> deg
      case 3006: return r => r * (180 / Math.PI / 5000) - 180; // GPS heading, compass deg
      case 3007: return r => (r - 15708) * 0.022918;        // GPS gyro (yaw rate), deg/s
    }
    // Internal accelerometers: zero point is stored per-device in the descriptor.
    if (ch.code.startsWith('04') && ch.typ < 1000 && ch.zero) {
      const s = ch.k2 < 0 ? -1 : 1, z = ch.zero;
      return r => s * (r - z) / 440;
    }
    return r => r;
  }

  function cstr(u8, off, len) {
    let s = '';
    for (let i = 0; i < len; i++) { const c = u8[off + i]; if (!c) break; s += String.fromCharCode(c); }
    return s.trim();
  }

  // The coarse lap boundaries (+0x00 / +0x04) are where the logger noticed each line crossing;
  // the precise lap times say where the crossings really were. Shift every crossing so timed laps
  // span exactly their precise time. The shifts stay within a few tenths, so centre them on zero.
  function alignCrossings(laps) {
    if (laps.length < 2) return;
    const shift = [0];                            // shift[j] applies to the crossing that ends laps[j]
    for (let j = 1; j < laps.length - 1; j++) {
      const l = laps[j];
      shift.push(shift[j - 1] + (l.kind === 'lap' ? l.timeMs - l.spanMs : 0));
    }
    const mean = shift.reduce((a, b) => a + b, 0) / shift.length;
    const ends = laps.map((l, j) => j < laps.length - 1 ? laps[j + 1].startMs + shift[j] - mean : l.startMs + l.spanMs);
    for (let j = 0; j < laps.length; j++) {
      const start = j ? ends[j - 1] : laps[0].startMs;
      laps[j].startMs = start;
      laps[j].spanMs = ends[j] - start;
    }
  }

  function parse(buffer, fileName = '') {
    const u8 = new Uint8Array(buffer), dv = new DataView(buffer);
    const tag = o => String.fromCharCode(u8[o], u8[o + 1], u8[o + 2]);
    if (u8.length < 0x200 || u8[0] !== 0x52 || u8[1] !== 0x44) throw new Error('This is not an AiM .drk file.');
    if (tag(0) !== 'RDX' || u8[3] !== 2) {
      throw new Error('This .drk uses an older AiM format (pre-GPS loggers) that is not supported yet.');
    }

    const blocks = { PPX: [], IIX: [], MMX: [], GGX: [], RRX: [] };
    let o = 0x420;                      // fixed file header (RDX)
    while (o + 0x20 <= u8.length && u8[o + 3] === 2) {
      let t = tag(o);
      // Some RaceStudio2 versions tag the info blocks "RDX"; they always come first, in this order.
      if (!(t in BODY)) t = !blocks.PPX.length ? 'PPX' : !blocks.IIX.length ? 'IIX' : null;
      if (!t) break;
      blocks[t].push(o + 0x20);
      o += 0x20 + BODY[t];
    }
    if (!blocks.MMX.length) throw new Error('No channels were found in this file.');
    const dataStart = o;

    const durationMs = dv.getUint32(0x78, true);
    let head = '';
    for (let i = 0x24; i < 0x74; i++) head += u8[i] >= 0x20 && u8[i] < 0x7f ? String.fromCharCode(u8[i]) : ' ';
    const dm = head.match(/(\d\d)-(\d\d)-(\d\d) (\d\d):(\d\d):(\d\d)/);
    const date = dm ? new Date(2000 + +dm[3], +dm[2] - 1, +dm[1], +dm[4], +dm[5], +dm[6]) : null;

    const p = blocks.PPX[0];
    const meta = p ? {
      vehicle: cstr(u8, p, 0x28), track: cstr(u8, p + 0x28, 0x28),
      driver: cstr(u8, p + 0x50, 0x28), name: cstr(u8, p + 0x78, 0x50),
    } : { vehicle: '', track: '', driver: '', name: '' };

    const channels = [];
    let pos = dataStart, truncated = false;
    blocks.MMX.forEach((b, i) => {
      const name = cstr(u8, b, 0x14);
      const code = cstr(u8, b + 0x15, 5);
      const ch = {
        id: i, name, label: PRETTY[name] || name, code,
        unit: unitFor(code), decimals: Math.min(3, +code.slice(4, 5) || 0),
        typ: dv.getUint16(b + 0x40, true),
        count: dv.getUint32(b + 0x48, true),
        lo: dv.getFloat32(b + 0x4c, true), hi: dv.getFloat32(b + 0x50, true),
        zero: dv.getFloat32(b + 0x5c, true), k2: dv.getFloat32(b + 0x60, true),
      };
      ch.rate = durationMs ? ch.count / (durationMs / 1000) : 10;
      const conv = converter(ch);
      const data = new Float32Array(ch.count);
      const avail = Math.max(0, Math.min(ch.count, Math.floor((u8.length - pos) / 2)));
      if (avail < ch.count) truncated = true;
      let valid = 0;
      for (let k = 0; k < ch.count; k++) {
        if (k >= avail) { data[k] = NaN; continue; }
        const r = dv.getInt16(pos + 2 * k, true);
        if (r === SENTINEL) data[k] = NaN; else { data[k] = conv(r); valid++; }
      }
      pos += ch.count * 2;
      ch.data = data;
      ch.valid = valid;
      channels.push(ch);
    });

    let laps = blocks.GGX.map((b, i) => {
      const k = u8[b + 0x26];
      const span = dv.getUint32(b + 4, true);         // logger's real-time detection, coarse
      const precise = dv.getUint32(b + 0x76, true);   // interpolated line crossing; what RaceStudio2 shows
      return {
        idx: i, startMs: dv.getUint32(b, true), spanMs: span,
        timeMs: precise > 0 && Math.abs(precise - span) < Math.max(5000, span * 0.5) ? precise : span,
        lapNo: dv.getUint32(b + 0x10, true), session: u8[b + 0x53] || 1,
        kind: k === 0x08 ? 'out' : k === 0x02 ? 'in' : 'lap',
      };
    }).filter(l => l.spanMs > 0);
    if (!laps.length) laps = [{ idx: 0, startMs: 0, spanMs: durationMs, timeMs: durationMs, lapNo: 1, session: 1, kind: 'lap' }];

    const sessions = [];
    for (const l of laps) {
      let s = sessions.find(x => x.no === l.session);
      if (!s) sessions.push(s = { no: l.session, laps: [] });
      s.laps.push(l);
    }
    for (const s of sessions) {
      alignCrossings(s.laps);
      const first = s.laps[0], last = s.laps[s.laps.length - 1];
      const span = last.startMs + last.spanMs - first.startMs;
      s.whole = { idx: -s.no, startMs: first.startMs, spanMs: span, timeMs: span,
        lapNo: 0, session: s.no, kind: 'session' };
      const timed = s.laps.filter(l => l.kind === 'lap');
      s.best = timed.length ? timed.reduce((a, b) => (b.timeMs < a.timeMs ? b : a)) : null;
    }
    const timed = laps.filter(l => l.kind === 'lap');
    const best = timed.length ? timed.reduce((a, b) => (b.timeMs < a.timeMs ? b : a)) : null;

    const file = {
      fileName, meta, date, durationMs, channels, laps, sessions, best, truncated,
      masterRate: Math.min(50, Math.max(...channels.map(c => c.rate), 1)),
    };
    file.byName = new Map(channels.map(c => [c.name, c]));
    file.speedCh = channels.find(c => c.typ === 3001) || channels.find(c => c.unit === 'km/h' && c.valid);
    file.headingCh = channels.find(c => c.typ === 3006);
    return file;
  }

  // Resample one lap onto a uniform timeline and derive distance + a dead-reckoned track.
  function lapData(file, lap) {
    if (lap._d) return lap._d;
    const rate = file.masterRate, dt = 1 / rate;
    const T = lap.spanMs / 1000;
    const n = Math.max(2, Math.ceil(T * rate - 1e-6) + 1);   // last sample lands exactly on the lap end
    const t0 = lap.startMs / 1000;
    const t = new Float32Array(n);
    for (let i = 0; i < n; i++) t[i] = Math.min(i * dt, T);
    const cache = new Map();

    function series(ch, circular = false) {
      if (!ch) return null;
      if (cache.has(ch.id)) return cache.get(ch.id);
      const out = new Float32Array(n), d = ch.data, r = ch.rate, N = d.length;
      for (let i = 0; i < n; i++) {
        const f = (t0 + t[i]) * r;
        let k = Math.floor(f);
        if (k >= N - 1) { out[i] = d[N - 1]; continue; }
        if (k < 0) k = 0;
        const a = d[k], b = d[k + 1], w = f - k;
        if (isNaN(a)) out[i] = b;
        else if (isNaN(b)) out[i] = a;
        else if (circular && Math.abs(b - a) > 180) {
          let v = a + ((b - a) - Math.sign(b - a) * 360) * w;
          if (v > 180) v -= 360; else if (v < -180) v += 360;
          out[i] = v;
        } else out[i] = a + (b - a) * w;
      }
      cache.set(ch.id, out);
      return out;
    }

    const v = series(file.speedCh);
    const dist = new Float32Array(n);
    for (let i = 1; i < n; i++) {
      const a = v ? v[i - 1] || 0 : 0, b = v ? v[i] || 0 : 0;
      dist[i] = dist[i - 1] + (a + b) / 2 / 3.6 * (t[i] - t[i - 1]);
    }
    const len = dist[n - 1];

    let x = null, y = null;
    const la = series(file.latCh), lo = series(file.lonCh);
    if (la && lo) {
      // Real GPS positions (.xrk). Like the dead-reckoned path, start each lap at (0, 0), x east / y north,
      // so laps from .drk and .xrk files of the same track overlay.
      let k0 = 0;
      while (k0 < n - 1 && (isNaN(la[k0]) || isNaN(lo[k0]))) k0++;
      const lat0 = la[k0], lon0 = lo[k0], kx = 111320 * Math.cos(lat0 * Math.PI / 180), ky = 110540;
      x = new Float32Array(n); y = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        x[i] = isNaN(lo[i]) ? (i ? x[i - 1] : 0) : (lo[i] - lon0) * kx;
        y[i] = isNaN(la[i]) ? (i ? y[i - 1] : 0) : (la[i] - lat0) * ky;
      }
    } else if (v && file.headingCh) {
      const h = series(file.headingCh, true);
      x = new Float32Array(n); y = new Float32Array(n);
      for (let i = 1; i < n; i++) {
        const rad = (h[i] || 0) * Math.PI / 180, ms = (v[i] || 0) / 3.6;
        const h_ = t[i] - t[i - 1];
        x[i] = x[i - 1] + ms * Math.sin(rad) * h_;
        y[i] = y[i - 1] + ms * Math.cos(rad) * h_;
      }
      // A clean lap should end where it started; spread the small integration drift.
      const gap = Math.hypot(x[n - 1], y[n - 1]);
      if (lap.kind === 'lap' && gap < 0.03 * len) {
        const ex = x[n - 1], ey = y[n - 1];
        for (let i = 0; i < n; i++) { const w = dist[i] / (len || 1); x[i] -= ex * w; y[i] -= ey * w; }
      }
    }
    return (lap._d = { n, t, dt, dist, len, x, y, series });
  }

  // Resample irregular (t ms, value) points onto a uniform grid starting at t0, so sample k is at t0 + k / rate.
  // Gaps longer than a few samples become NaN rather than being bridged.
  function resample(t, v, t0, durationMs, rateHz) {
    const rate = Math.min(50, Math.max(1, rateHz));
    const count = Math.floor(durationMs / 1000 * rate) + 1;
    const data = new Float32Array(count).fill(NaN);
    const maxGap = Math.max(3000 / rate, 500);
    let j = 0, valid = 0;
    for (let k = 0; k < count && t.length; k++) {
      const tm = t0 + k * 1000 / rate;
      while (j < t.length - 1 && t[j + 1] <= tm) j++;
      if (tm < t[0] - maxGap || tm > t[t.length - 1] + maxGap) continue;
      let val;
      if (tm <= t[0]) val = v[0];
      else if (j >= t.length - 1) val = v[t.length - 1];
      else if (t[j + 1] - t[j] > maxGap) continue;
      else val = v[j] + (v[j + 1] - v[j]) * (tm - t[j]) / (t[j + 1] - t[j] || 1);
      if (isFinite(val)) { data[k] = val; valid++; }
    }
    return { data, rate, count, valid };
  }

  /*
   * RaceStudio2 .gpk (saved next to each .drk): "PROV" header with the ECEF reference point (3 doubles at 0x1E),
   * then 144-byte "PSOL" records from 0x60: u32 time on the .drk timeline (ms), u16 GPS week, u32 iTOW, u8 fix,
   * u8 flags, then doubles: east, north, up (m from the reference), ?, v east, v north, ...
   */
  function parseGpk(buffer) {
    const u8 = new Uint8Array(buffer), dv = new DataView(buffer);
    const isTag = (o, s) => o + 4 <= u8.length && String.fromCharCode(u8[o], u8[o + 1], u8[o + 2], u8[o + 3]) === s;
    if (!isTag(0, 'PROV') || !isTag(0x10, 'PROV')) throw new Error('This is not a RaceStudio2 .gpk file.');
    const X = dv.getFloat64(0x1e, true), Y = dv.getFloat64(0x26, true), Z = dv.getFloat64(0x2e, true);
    const a = 6378137, f = 1 / 298.257223563, e2 = f * (2 - f), b = a * (1 - f), ep2 = (a * a - b * b) / (b * b);
    const p = Math.hypot(X, Y), th = Math.atan2(Z * a, p * b);
    const lat0 = Math.atan2(Z + ep2 * b * Math.sin(th) ** 3, p - e2 * a * Math.cos(th) ** 3), lon0 = Math.atan2(Y, X);
    const N = a / Math.sqrt(1 - e2 * Math.sin(lat0) ** 2);           // prime vertical radius
    const M = a * (1 - e2) / (1 - e2 * Math.sin(lat0) ** 2) ** 1.5;  // meridian radius
    const t = [], lat = [], lon = [];
    for (let o = 0x60; o + 0x90 <= u8.length && isTag(o, 'PSOL'); o += 0x90) {
      if (u8[o + 14] < 2) continue;                                  // no 2D/3D fix
      const e = dv.getFloat64(o + 0x10, true), n = dv.getFloat64(o + 0x18, true);
      if (!isFinite(e) || !isFinite(n) || (e === 0 && n === 0)) continue;
      t.push(dv.getUint32(o + 4, true));
      lat.push((lat0 + n / M) * 180 / Math.PI);
      lon.push((lon0 + e / (N * Math.cos(lat0))) * 180 / Math.PI);
    }
    if (t.length < 2) throw new Error('No GPS positions were found in this .gpk file.');
    return { t, lat, lon };
  }

  // Give a .drk real GPS positions from its .gpk; maps then use them instead of dead reckoning.
  function attachGps(file, gpk) {
    const rate = 1000 / Math.max(20, (gpk.t[gpk.t.length - 1] - gpk.t[0]) / (gpk.t.length - 1));
    for (const [name, vals, typ] of [['GPS Latitude', gpk.lat, 3010], ['GPS Longitude', gpk.lon, 3011]]) {
      const r = resample(gpk.t, vals, 0, file.durationMs, rate);
      const ch = { id: file.channels.length, name, label: name, code: 'gpk', unit: 'deg', decimals: 6, typ,
        count: r.count, rate: r.rate, data: r.data, valid: r.valid, lo: 0, hi: 0 };
      file.channels = file.channels.filter(c => c.name !== name).concat(ch);
    }
    file.channels.forEach((c, i) => (c.id = i));
    file.byName = new Map(file.channels.map(c => [c.name, c]));
    file.latCh = file.byName.get('GPS Latitude');
    file.lonCh = file.byName.get('GPS Longitude');
    file.hasGpk = true;
    for (const l of [...file.laps, ...file.sessions.map(s => s.whole)]) { delete l._d; delete l._stats; }
  }

  return { parse, lapData, resample, parseGpk, attachGps };
})();
