'use strict';
/*
 * Reader for Racelogic .vbo files: VBOX / VBOX Video loggers, plus the many apps that export the format
 * (RaceChrono, Harry's LapTimer, TrackAddict, ...). Plain text; produces the same file object as DRK.parse.
 * Layout notes are in FORMAT.md.
 */
const VBO = (() => {
  // Columns that are read into the GPS channels (or are housekeeping) rather than shown as-is.
  const SKIP = /^(sats|time|lat|long|velocity|heading|height|avi.*|solution_?type)$/i;
  const DAY = 86400000;

  // Unit/decimals for columns the [channel units] section doesn't cover, guessed from the column name.
  function guessUnit(name) {
    const n = name.toLowerCase();
    if (/rpm/.test(n)) return ['rpm', 0];
    if (/acc|_g$|g_?force/.test(n)) return ['g', 2];
    if (/temp|_t$|egt|iat|ect/.test(n)) return ['°C', 1];
    if (/throttle|pedal|tps|brake_?pos|%/.test(n)) return ['%', 1];
    if (/press|boost|map$/.test(n)) return ['bar', 2];
    if (/kmh|km\/h|speed|vel/.test(n)) return ['km/h', 1];
    if (/volt|batt/.test(n)) return ['V', 2];
    if (/gear/.test(n)) return ['gear', 0];
    if (/steer|yaw|angle|pitch|roll/.test(n)) return ['deg', 1];
    return ['', 2];
  }

  const UNIT_ALIASES = { kmh: 'km/h', 'km/h': 'km/h', mph: 'mph', g: 'g', deg: 'deg', degrees: 'deg', m: 'm',
    rpm: 'rpm', '%': '%', c: '°C', degc: '°C', '°c': '°C', bar: 'bar', v: 'V', volts: 'V', s: 's', ms: 'ms' };
  function normUnit(u) {
    const k = String(u || '').trim().toLowerCase();
    return UNIT_ALIASES[k] ?? String(u || '').trim();
  }
  const decimalsFor = u => ({ rpm: 0, 'km/h': 1, mph: 1, g: 2, deg: 1, '°C': 1, '%': 1, bar: 2, V: 2, m: 0, gear: 0 })[u] ?? 2;

  // "HHMMSS.SS" (UTC) -> ms since midnight
  function hmsToMs(x) {
    const hh = Math.floor(x / 10000), mm = Math.floor(x / 100) % 100, ss = x - hh * 10000 - mm * 100;
    return (hh * 3600 + mm * 60 + ss) * 1000;
  }

  // Intersection of segment p1-p2 with q1-q2 in a flat x/y frame; returns u along p1-p2, or -1.
  function crossU(p1x, p1y, p2x, p2y, q1x, q1y, q2x, q2y) {
    const rx = p2x - p1x, ry = p2y - p1y, sx = q2x - q1x, sy = q2y - q1y;
    const den = rx * sy - ry * sx;
    if (!den) return -1;
    const u = ((q1x - p1x) * sy - (q1y - p1y) * sx) / den;
    const w = ((q1x - p1x) * ry - (q1y - p1y) * rx) / den;
    return u >= 0 && u < 1 && w >= -0.1 && w <= 1.1 ? u : -1;   // a little slack on the line ends
  }

  function parse(buffer, fileName = '') {
    // Latin-1 so the "¬" in [laptiming] lines and any odd bytes survive.
    const text = new TextDecoder('latin1').decode(buffer);
    const lines = text.split(/\r?\n/);
    const sec = {};      // section name -> array of non-empty lines
    let cur = '_pre', dataStart = -1;
    for (let k = 0; k < lines.length; k++) {
      const ln = lines[k].trim();
      const m = ln.match(/^\[(.+)\]$/);
      if (m) {
        cur = m[1].trim().toLowerCase();
        sec[cur] = sec[cur] || [];
        if (cur === 'data') { dataStart = k + 1; break; }
        continue;
      }
      if (ln) (sec[cur] = sec[cur] || []).push(ln);
    }
    if (dataStart < 0 || !sec['column names']) throw new Error('This is not a Racelogic .vbo file.');

    const cols = sec['column names'].join(' ').split(/[\s,]+/).filter(Boolean);
    const ci = name => cols.findIndex(c => c.toLowerCase() === name);
    const iT = ci('time'), iLat = ci('lat'), iLon = ci('long'), iV = ci('velocity'),
      iH = ci('heading'), iAlt = ci('height'), iSat = ci('sats');
    if (iT < 0) throw new Error('This .vbo has no time column.');

    // [channel units] lists one unit per column for some writers, or only for the extra (non-GPS) columns for others.
    const unitsList = (sec['channel units'] || []).join(' ').split(/[\s,]+/).filter(Boolean);
    const extra = cols.map((c, k) => k).filter(k => !SKIP.test(cols[k]));
    const unitOf = new Map();
    if (unitsList.length === cols.length) cols.forEach((c, k) => unitOf.set(k, unitsList[k]));
    else if (unitsList.length === extra.length) extra.forEach((k, j) => unitOf.set(k, unitsList[j]));

    // ---- samples ----
    const T = [], vals = cols.map(() => []);
    let prevT = -Infinity, dayOff = 0;
    for (let k = dataStart; k < lines.length; k++) {
      const ln = lines[k].trim();
      if (!ln) continue;
      const tok = ln.split(/[\s,]+/);
      if (tok.length < cols.length) continue;
      let t = hmsToMs(parseFloat(tok[iT]));
      if (!isFinite(t)) continue;
      t += dayOff;
      if (t < prevT - DAY / 2) { dayOff += DAY; t += DAY; }   // crossed midnight UTC
      if (t <= prevT) continue;                               // duplicate / out-of-order row
      prevT = t;
      T.push(t);
      for (let c = 0; c < cols.length; c++) vals[c].push(parseFloat(tok[c]));
    }
    if (T.length < 2) throw new Error('No data rows were found in this .vbo file.');

    const t0 = T[0], tEnd = T[T.length - 1], durationMs = Math.max(1, tEnd - t0);
    const dts = [];
    for (let k = 1; k < Math.min(T.length, 2001); k++) dts.push(T[k] - T[k - 1]);
    dts.sort((a, b) => a - b);
    const rate = 1000 / Math.max(5, dts[dts.length >> 1]);   // median spacing; VBOX is usually 10 or 20 Hz

    const channels = [];
    function addChannel(name, unit, decimals, t, v, extraProps = {}) {
      const r = DRK.resample(t, v, t0, durationMs, rate);
      channels.push({
        id: channels.length, name, label: name, code: extraProps.code || '', unit, decimals, typ: extraProps.typ || 0,
        count: r.count, rate: r.rate, data: r.data, valid: r.valid, lo: 0, hi: 0,
      });
    }

    // ---- GPS ----
    // Lat/long are in minutes; VBO longitude is positive WEST, so it is negated for the usual east-positive degrees.
    const gT = [], lat = [], lon = [], spd = [], hdg = [], alt = [], nsv = [];
    for (let k = 0; k < T.length; k++) {
      const la = iLat >= 0 ? vals[iLat][k] / 60 : NaN, lo = iLon >= 0 ? -vals[iLon][k] / 60 : NaN;
      const sats = iSat >= 0 ? vals[iSat][k] & 63 : NaN;       // upper bits flag brake trigger / DGPS
      if (sats === 0 || (la === 0 && lo === 0)) continue;
      gT.push(T[k]); lat.push(la); lon.push(lo);
      spd.push(iV >= 0 ? vals[iV][k] : NaN); hdg.push(iH >= 0 ? vals[iH][k] : NaN);
      alt.push(iAlt >= 0 ? vals[iAlt][k] : NaN); nsv.push(sats);
    }
    const hasPos = gT.length > 1 && lat.some(isFinite) && lon.some(isFinite);
    if (gT.length > 1) {
      // Fill missing speed/heading from positions if the writer left those columns out.
      const kx = 111320 * Math.cos((lat.find(isFinite) || 0) * Math.PI / 180), ky = 110540;
      for (let k = 0; k < gT.length; k++) {
        if (isFinite(spd[k]) && isFinite(hdg[k]) || !hasPos) continue;
        const a = Math.max(0, k - 1), b = Math.min(gT.length - 1, k + 1), dt = (gT[b] - gT[a]) / 1000;
        const dx = (lon[b] - lon[a]) * kx, dy = (lat[b] - lat[a]) * ky;
        if (!isFinite(spd[k])) spd[k] = dt > 0 ? Math.hypot(dx, dy) / dt * 3.6 : NaN;
        if (!isFinite(hdg[k])) hdg[k] = Math.atan2(dx, dy) * 180 / Math.PI;
      }
      const unwrapped = hdg.map(h => (((h + 180) % 360) + 360) % 360 - 180);
      for (let k = 1; k < unwrapped.length; k++) unwrapped[k] -= Math.round((unwrapped[k] - unwrapped[k - 1]) / 360) * 360;

      addChannel('GPS Speed', 'km/h', 1, gT, spd, { typ: 3001, code: 'velocity' });
      addChannel('GPS Heading', 'deg', 1, gT, unwrapped, { typ: 3006, code: 'heading' });
      const hc = channels[channels.length - 1];
      for (let k = 0; k < hc.data.length; k++) if (!isNaN(hc.data[k])) hc.data[k] = (((hc.data[k] + 180) % 360) + 360) % 360 - 180;

      // Accelerations from GPS velocity, same convention as the .xrk reader:
      // longitudinal = dv/dt (+ accelerating), lateral = v·dψ/dt (+ turning right).
      const latG = [], lonG = [];
      for (let k = 0; k < gT.length; k++) {
        const a = Math.max(0, k - 1), b = Math.min(gT.length - 1, k + 1), dt = (gT[b] - gT[a]) / 1000;
        if (dt <= 0 || dt > 0.5) { latG.push(NaN); lonG.push(NaN); continue; }
        lonG.push((spd[b] - spd[a]) / 3.6 / dt / 9.81);
        latG.push(spd[k] / 3.6 * (unwrapped[b] - unwrapped[a]) * Math.PI / 180 / dt / 9.81);
      }
      const smooth = arr => arr.map((_, k) => {
        let s = 0, c = 0;
        for (let q = Math.max(0, k - 2); q <= Math.min(arr.length - 1, k + 2); q++) if (!isNaN(arr[q])) { s += arr[q]; c++; }
        return c ? s / c : NaN;
      });
      addChannel('GPS LatAcc', 'g', 2, gT, smooth(latG), { typ: 3003, code: 'GPS' });
      addChannel('GPS LonAcc', 'g', 2, gT, smooth(lonG), { typ: 3004, code: 'GPS' });
      if (hasPos) {
        addChannel('GPS Latitude', 'deg', 6, gT, lat, { typ: 3010, code: 'lat' });
        addChannel('GPS Longitude', 'deg', 6, gT, lon, { typ: 3011, code: 'long' });
      }
      if (iAlt >= 0) addChannel('GPS Altitude', 'm', 0, gT, alt, { code: 'height' });
      if (iSat >= 0) addChannel('GPS Nsat', '#', 0, gT, nsv, { code: 'sats' });
    }

    // ---- other columns (CAN, analog inputs, IMU, ...) ----
    for (const k of extra) {
      const v = vals[k];
      if (!v.some(isFinite)) continue;
      const given = unitOf.has(k) ? normUnit(unitOf.get(k)) : '';
      const [unit, dec] = given ? [given, decimalsFor(given)] : guessUnit(cols[k]);
      addChannel(cols[k].replace(/_/g, ' '), unit, dec, T, v, { code: cols[k] });
    }
    if (!channels.length) throw new Error('No channels were found in this .vbo file.');

    // ---- laps from the [laptiming] start/finish line ----
    const crossings = findCrossings(sec.laptiming || [], gT, lat, lon);
    let lapList = [];
    const mk = (a, b, kind) => lapList.push({ idx: lapList.length, startMs: a - t0, spanMs: b - a, timeMs: b - a,
      lapNo: lapList.length + 1, session: 1, kind });
    if (crossings.mode === 'circuit' && crossings.start.length) {
      const c = crossings.start;
      if (c[0] - t0 > 1000) mk(t0, c[0], 'out');
      for (let k = 0; k + 1 < c.length; k++) mk(c[k], c[k + 1], 'lap');
      if (tEnd - c[c.length - 1] > 1000) mk(c[c.length - 1], tEnd, 'in');
    } else if (crossings.mode === 'sprint') {
      // Point-to-point: each run goes from a start crossing to the next finish crossing.
      const ev = [...crossings.start.map(t => [t, 's']), ...crossings.finish.map(t => [t, 'f'])].sort((a, b) => a[0] - b[0]);
      let from = null;
      for (const [t, k] of ev) {
        if (k === 's') from = t;
        else if (from != null) { mk(from, t, 'lap'); from = null; }
      }
    }
    if (!lapList.length) lapList = [{ idx: 0, startMs: 0, spanMs: durationMs, timeMs: durationMs, lapNo: 1, session: 1, kind: 'lap' }];
    lapList.forEach((l, k) => { l.idx = k; });

    const timed = lapList.filter(l => l.kind === 'lap');
    const best = timed.length ? timed.reduce((a, b) => (b.timeMs < a.timeMs ? b : a)) : null;
    const first = lapList[0], last = lapList[lapList.length - 1];
    const span = last.startMs + last.spanMs - first.startMs;
    const whole = { idx: -1, startMs: first.startMs, spanMs: span, timeMs: span, lapNo: 0, session: 1, kind: 'session' };
    const sessions = [{ no: 1, laps: lapList, whole, best }];

    // "File created on 29/07/2019 @ 10:23:45" (day/month/year, local time of the writer)
    const dm = (sec._pre || []).join(' ').match(/(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s*@\s*(\d+):(\d+):(\d+))?/);
    const date = dm ? new Date(+dm[3], +dm[2] - 1, +dm[1], +(dm[4] || 0), +(dm[5] || 0), +(dm[6] || 0)) : null;

    // Converters and apps often note the session in [comments] as "Track: ...", "Vehicle: ...", "Driver: ...".
    const note = re => {
      for (const ln of sec.comments || []) { const m = ln.match(re); if (m) return m[1].trim(); }
      return '';
    };
    const meta = {
      track: note(/^(?:track|circuit|venue)\s*[:=]\s*(.+)$/i),
      vehicle: note(/^(?:vehicle|car)\s*[:=]\s*(.+)$/i),
      driver: note(/^(?:driver|racer)\s*[:=]\s*(.+)$/i),
      name: '',
    };

    const file = {
      fileName, format: 'vbo', date, durationMs, channels, laps: lapList, sessions, best, truncated: false, meta,
      masterRate: Math.min(50, Math.max(...channels.map(c => c.rate), 1)),
    };
    file.byName = new Map(channels.map(c => [c.name, c]));
    file.speedCh = channels.find(c => c.typ === 3001) || channels.find(c => c.unit === 'km/h' && c.valid);
    file.headingCh = channels.find(c => c.typ === 3006);
    file.latCh = channels.find(c => c.typ === 3010);
    file.lonCh = channels.find(c => c.typ === 3011);
    return file;
  }

  /*
   * [laptiming] lines look like "Start  +00068.12345 +03123.45678 +00068.13000 +03123.46000 ¬ Start / Finish":
   * two end points of the line, in minutes. Writers disagree on lat/long order and longitude sign, so every
   * reading is tried and the one whose line actually sits on the driven path wins.
   */
  function findCrossings(lt, T, lat, lon) {
    const none = { mode: 'none', start: [], finish: [] };
    if (!T.length) return none;
    const lines = {};
    for (const ln of lt) {
      const m = ln.match(/^(start|finish)\s+([-+\d.\s]+)/i);
      if (!m) continue;
      const n = m[2].trim().split(/\s+/).map(Number);
      if (n.length >= 4 && n.slice(0, 4).every(isFinite)) lines[m[1].toLowerCase()] = n.slice(0, 4);
    }
    if (!lines.start) return none;

    const lat0 = lat.find(isFinite), lon0 = lon.find(isFinite);
    const kx = 111320 * Math.cos(lat0 * Math.PI / 180), ky = 110540;
    const X = lon.map(v => (v - lon0) * kx), Y = lat.map(v => (v - lat0) * ky);
    const toXY = (la, lo) => [(lo - lon0) * kx, (la - lat0) * ky];

    function readLine(n) {
      let bestL = null, bestD = Infinity;
      for (const lonFirst of [true, false]) for (const sgn of [-1, 1]) {
        const [a, b, c, d] = n;
        const la1 = (lonFirst ? b : a) / 60, lo1 = sgn * (lonFirst ? a : b) / 60;
        const la2 = (lonFirst ? d : c) / 60, lo2 = sgn * (lonFirst ? c : d) / 60;
        const p = toXY(la1, lo1), q = toXY(la2, lo2), mx = (p[0] + q[0]) / 2, my = (p[1] + q[1]) / 2;
        let dmin = Infinity;
        for (let k = 0; k < X.length; k += 2) { const dd = Math.hypot(X[k] - mx, Y[k] - my); if (dd < dmin) dmin = dd; }
        if (dmin < bestD) { bestD = dmin; bestL = [p, q]; }
      }
      return bestD < 200 ? bestL : null;
    }

    function crossingsOf(L) {
      const out = [];
      if (!L) return out;
      const [[q1x, q1y], [q2x, q2y]] = L;
      for (let k = 1; k < T.length; k++) {
        if (T[k] - T[k - 1] > 2000) continue;   // don't bridge GPS dropouts
        const u = crossU(X[k - 1], Y[k - 1], X[k], Y[k], q1x, q1y, q2x, q2y);
        if (u < 0) continue;
        const t = T[k - 1] + u * (T[k] - T[k - 1]);
        if (out.length && t - out[out.length - 1] < 5000) continue;   // debounce wobble around the line
        out.push(t);
      }
      return out;
    }

    const start = crossingsOf(readLine(lines.start));
    if (lines.finish && lines.finish.join() !== lines.start.join()) {
      const finish = crossingsOf(readLine(lines.finish));
      if (finish.length) return { mode: 'sprint', start, finish };
    }
    return { mode: 'circuit', start, finish: [] };
  }

  return { parse };
})();
