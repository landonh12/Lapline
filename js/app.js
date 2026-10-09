'use strict';
const App = (() => {
  const LAP_COLORS = ['#3b82f6', '#f97316', '#22c55e', '#e11d48', '#a855f7', '#eab308', '#06b6d4', '#ec4899'];
  const CH_COLORS = ['#3b82f6', '#f97316', '#22c55e', '#e11d48', '#a855f7', '#eab308'];
  const DASHES = [[], [6, 3], [2, 3], [8, 3, 2, 3]];
  const $ = s => document.querySelector(s);

  const store = {
    get(k, d) { try { const v = localStorage.getItem('lapline.' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
    set(k, v) { try { localStorage.setItem('lapline.' + k, JSON.stringify(v)); } catch { /* storage unavailable */ } },
  };

  const S = {
    files: [],
    sel: [],                 // [{file, lap, color}] — first entry is the reference lap
    xMode: store.get('xMode', 'dist'),
    units: store.get('units', 'imperial'),
    tab: 'analysis',
    view: null,              // [x0, x1] visible range, null = full
    cursor: null,
    panes: store.get('panes', null),
    traces: [],
    full: [0, 1],
  };

  /* ---------- units ---------- */
  const IMPERIAL = {
    'km/h': ['mph', v => v * 0.621371], '°C': ['°F', v => v * 9 / 5 + 32], 'm': ['ft', v => v * 3.28084],
    'l': ['gal', v => v * 0.264172], 'Nm': ['lb·ft', v => v * 0.737562],
  };
  function unitOf(ch) { return S.units === 'imperial' && IMPERIAL[ch.unit] ? IMPERIAL[ch.unit][0] : ch.unit; }
  function cvt(ch) { return S.units === 'imperial' && IMPERIAL[ch.unit] ? IMPERIAL[ch.unit][1] : null; }
  function fmtVal(ch, v) { if (v == null || isNaN(v)) return '–'; const f = cvt(ch); return (f ? f(v) : v).toFixed(ch.decimals); }
  const speedFmt = v => S.units === 'imperial' ? (v * 0.621371).toFixed(0) + ' mph' : v.toFixed(0) + ' km/h';
  const distFmt = m => S.units === 'imperial' ? Math.round(m * 3.28084) + ' ft' : Math.round(m) + ' m';
  function xFmt(v) {
    if (S.xMode === 'time') return v >= 60 ? `${Math.floor(v / 60)}:${String(Math.floor(v % 60)).padStart(2, '0')}` : v.toFixed(v < 10 ? 1 : 0) + 's';
    const d = S.units === 'imperial' ? v * 3.28084 : v;
    return d >= 1000 ? (d / 1000).toFixed(d % 1000 ? 1 : 0) + 'k' : Math.round(d) + '';
  }

  function lapTime(ms) {
    if (ms == null) return '–';
    const m = Math.floor(ms / 60000), s = (ms % 60000) / 1000;
    return `${m}:${s.toFixed(3).padStart(6, '0')}`;
  }
  function lapName(s) {
    if (s.lap.kind === 'session') return `S${s.lap.session} full`;
    return `S${s.lap.session} L${s.lap.lapNo}` + (S.files.length > 1 ? ` · ${shortDate(s.file)}` : '');
  }
  function shortDate(f) { return f.date ? f.date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : f.fileName; }

  /* ---------- loading ---------- */
  const baseName = n => n.replace(/\.[^.]+$/, '').toLowerCase();
  const pendingGpk = new Map();   // .gpk opened before its .drk, keyed by base name

  async function openFiles(list) {
    // logs first, so a .gpk dropped together with its .drk finds it
    const files = [...list].sort((a, b) => /\.gpk$/i.test(a.name) - /\.gpk$/i.test(b.name));
    for (const f of files) {
      if (!/\.(drk|xrk|gpk|vbo)$/i.test(f.name)) { toast(`${f.name}: only AiM .drk, .xrk, .gpk and Racelogic .vbo files are supported`); continue; }
      try { loadBuffer(await f.arrayBuffer(), f.name); } catch (e) { toast(`${f.name}: ${e.message}`); console.error(e); }
    }
  }

  function loadGpk(buf, name) {
    const gpk = DRK.parseGpk(buf);
    const file = S.files.find(f => f.format === 'drk' && baseName(f.fileName) === baseName(name));
    if (!file) { pendingGpk.set(baseName(name), gpk); toast(`${name}: GPS track loaded; open the matching .drk to use it`, 'info'); return; }
    DRK.attachGps(file, gpk);
    renderAll();
  }

  function loadBuffer(buf, name) {
    if (/\.gpk$/i.test(name)) return loadGpk(buf, name);
    // .vbo (Racelogic) is text; .xrk (RaceStudio3) starts with a "<h" message; .drk (RaceStudio2) with "RD"
    const head = new Uint8Array(buf, 0, Math.min(2, buf.byteLength));
    const file = /\.vbo$/i.test(name) ? VBO.parse(buf, name)
      : head[0] === 0x3c && head[1] === 0x68 ? XRK.parse(buf, name) : DRK.parse(buf, name);
    if (S.files.some(f => f.fileName === name && f.durationMs === file.durationMs)) { toast(`${name} is already open`); return; }
    const gpk = pendingGpk.get(baseName(name));
    if (gpk && file.format === 'drk') { DRK.attachGps(file, gpk); pendingGpk.delete(baseName(name)); }
    S.files.push(file);
    if (file.truncated) toast(`${name}: file looks truncated, some data is missing`);
    const best = file.best || file.laps[0];
    if (S.sel.length && S.sel[0].file.meta.track !== file.meta.track) S.sel = [];
    addSel(file, best);
    S.view = null;
    if (!S.panes) S.panes = defaultPanes(file);
    renderAll();
  }

  function defaultPanes(f) {
    const find = pred => f.channels.find(c => c.valid && pred(c));
    const panes = [];
    const spd = f.speedCh; if (spd) panes.push({ chs: [spd.name] });
    panes.push({ chs: ['__delta'], short: true });
    const thr = find(c => /PEDAL|THROTTLE|TPS/i.test(c.name));
    const brk = find(c => /BRAKE/i.test(c.name));
    if (thr || brk) panes.push({ chs: [thr, brk].filter(Boolean).map(c => c.name) });
    const rpm = find(c => c.unit === 'rpm'); if (rpm) panes.push({ chs: [rpm.name] });
    const lat = find(c => c.typ === 3003) || find(c => /lat.*acc/i.test(c.name));
    const lon = find(c => c.typ === 3004) || find(c => /lon.*acc/i.test(c.name));
    if (lat || lon) panes.push({ chs: [lat, lon].filter(Boolean).map(c => c.name) });
    const st = find(c => /STEER/i.test(c.name)); if (st) panes.push({ chs: [st.name] });
    return panes;
  }

  /* ---------- selection ---------- */
  function nextColor() { return LAP_COLORS.find(c => !S.sel.some(s => s.color === c)) || LAP_COLORS[S.sel.length % LAP_COLORS.length]; }
  function addSel(file, lap) { S.sel.push({ file, lap, color: nextColor() }); }
  function toggleLap(file, lap, additive) {
    const i = S.sel.findIndex(s => s.file === file && s.lap === lap);
    if (!additive) {
      if (i >= 0 && S.sel.length === 1) return;
      S.sel = [{ file, lap, color: S.sel[i]?.color || LAP_COLORS[0] }];
    } else if (i >= 0) {
      if (S.sel.length > 1) S.sel.splice(i, 1);
    } else addSel(file, lap);
    S.view = null;
    renderAll();
  }
  function makeRef(i) { const [s] = S.sel.splice(i, 1); S.sel.unshift(s); S.view = null; renderAll(); }

  /* ---------- derived traces ---------- */
  function buildTraces() {
    S.traces = S.sel.map(s => ({ sel: s, d: DRK.lapData(s.file, s.lap) }));
    const ref = S.traces[0];
    if (!ref) return;
    for (const tr of S.traces) {
      const k = tr !== ref && tr.sel.lap.kind !== 'session' && ref.sel.lap.kind !== 'session' &&
        Math.abs(tr.d.len / ref.d.len - 1) < 0.06 ? ref.d.len / tr.d.len : 1;
      tr.ndist = k === 1 ? tr.d.dist : tr.d.dist.map(v => v * k);   // distance normalised to the reference lap
      tr.xs = S.xMode === 'time' ? tr.d.t : tr.ndist;
    }
    // time delta vs reference, sampled on the reference lap
    for (const tr of S.traces) {
      const n = ref.d.n, out = new Float32Array(n);
      if (tr === ref) { out.fill(0); tr.delta = out; continue; }
      for (let i = 0; i < n; i++) out[i] = Charts.valueAt(tr.ndist, tr.d.t, ref.d.dist[i]) - ref.d.t[i];
      tr.delta = out;
    }
    let hi = 0;
    for (const tr of S.traces) hi = Math.max(hi, tr.xs[tr.xs.length - 1]);
    S.full = [0, hi || 1];
  }

  // Match a channel by name across files from different loggers/formats: exact name, then the same
  // GPS-derived quantity (type id >= 3000), then a punctuation-insensitive name (RS2 truncates to 14 chars).
  const normName = s => s.toUpperCase().replace(/[^A-Z0-9]/g, '');
  function findChannel(file, name) {
    const exact = file.byName.get(name);
    if (exact) return exact;
    let tmpl = null;
    for (const f of S.files) if ((tmpl = f.byName.get(name))) break;
    if (tmpl && tmpl.typ >= 3000) { const c = file.channels.find(c => c.typ === tmpl.typ); if (c) return c; }
    const k = normName(name);
    return file.channels.find(c => {
      const m = normName(c.name);
      return m === k || (Math.min(m.length, k.length) >= 10 && (m.startsWith(k) || k.startsWith(m)));
    }) || null;
  }
  function chFor(tr, name) { return findChannel(tr.sel.file, name); }
  function seriesFor(tr, name) {
    if (name === '__delta') return tr.delta;
    const ch = chFor(tr, name);
    if (!ch) return null;
    const key = name + '|' + S.units;
    tr.conv = tr.conv || {};
    if (tr.conv[key]) return tr.conv[key];
    const raw = tr.d.series(ch), f = cvt(ch);
    return (tr.conv[key] = f ? raw.map(f) : raw);
  }
  const DELTA_CH = { name: '__delta', label: 'Time delta', unit: 's', decimals: 3 };
  function chMeta(name) { if (name === '__delta') return DELTA_CH; return S.sel[0] ? findChannel(S.sel[0].file, name) : null; }

  /* ---------- rendering ---------- */
  let raf = 0;
  function schedule() { if (!raf) raf = requestAnimationFrame(() => { raf = 0; drawAll(); }); }

  function renderAll() {
    const has = S.files.length > 0;
    $('#dropzone').hidden = has;
    $('#sideEmpty').hidden = has;
    for (const t of ['analysis', 'map', 'laps', 'channels']) $('#view-' + t).hidden = !has || S.tab !== t;
    document.querySelectorAll('#tabs button').forEach(b => b.classList.toggle('active', b.dataset.tab === S.tab));
    document.querySelectorAll('#xmode button').forEach(b => b.classList.toggle('active', b.dataset.v === S.xMode));
    document.querySelectorAll('#units button').forEach(b => b.classList.toggle('active', b.dataset.v === S.units));
    renderSidebar();
    if (!has) return;
    buildTraces();
    if (S.tab === 'analysis') { renderLegend($('#lapLegend')); renderPanes($('#panes'), S.panes); buildReadout(); schedule(); }
    if (S.tab === 'map') {
      renderLegend($('#mapLegend'));
      const spd = S.sel[0]?.file.speedCh;
      renderPanes($('#mapPanes'), [...(spd ? [{ chs: [spd.name] }] : []), { chs: ['__delta'], short: true }], false);
      renderSat();
      schedule();
    }
    if (S.tab === 'laps') renderLaps();
    if (S.tab === 'channels') renderChannels();
  }

  function renderSidebar() {
    const el = $('#fileList');
    el.innerHTML = '';
    if (S.files.length > 1) {
      const allCollapsed = S.files.every(f => f.collapsed);
      const bar = document.createElement('div');
      bar.className = 'side-bar';
      bar.innerHTML = `<span>${S.files.length} files</span><button class="link-btn">${allCollapsed ? 'Expand all' : 'Collapse all'}</button>`;
      bar.querySelector('button').onclick = () => { S.files.forEach(f => { f.collapsed = !allCollapsed; }); renderSidebar(); };
      el.appendChild(bar);
    }
    S.files.forEach((f, fi) => {
      const card = document.createElement('div');
      card.className = 'file-card' + (f.collapsed ? ' collapsed' : '');
      const date = f.date ? f.date.toLocaleDateString(undefined, { weekday: 'short', year: 'numeric', month: 'short', day: 'numeric' }) : '';
      card.innerHTML = `<div class="file-head" role="button" tabindex="0" aria-expanded="${!f.collapsed}" title="${f.collapsed ? 'Show' : 'Hide'} laps">
        <div class="track"><span class="chev" aria-hidden="true"></span>${esc(f.meta.track || 'Unknown track')}</div>
        <div class="sub">${esc(f.meta.vehicle)}${f.meta.driver ? ' · ' + esc(f.meta.driver) : ''}</div>
        <div class="sub">${esc(date)}${f.best ? ` · best <b class="mono">${lapTime(f.best.timeMs)}</b>` : ''}</div>
        ${f.latCh || f.format !== 'drk' ? '' : '<div class="sub" title="Open the .gpk with the same name from RaceStudio2\'s DATA folder for real GPS positions">No GPS track · add its .gpk</div>'}
        <button class="icon-btn close" title="Close file">×</button></div>`;
      card.querySelector('.close').onclick = e => { e.stopPropagation(); closeFile(fi); };
      const head = card.querySelector('.file-head');
      const toggle = () => { f.collapsed = !f.collapsed; renderSidebar(); };
      head.onclick = toggle;
      head.onkeydown = e => { if ((e.key === 'Enter' || e.key === ' ') && e.target === head) { e.preventDefault(); toggle(); } };
      if (f.collapsed) {
        // Keep this file's selections visible (and clickable) while its lap list is hidden.
        const picked = S.sel.map((s, si) => ({ s, si })).filter(({ s }) => s.file === f);
        if (picked.length) {
          const chips = document.createElement('div');
          chips.className = 'sel-chips';
          for (const { s, si } of picked) {
            const c = document.createElement('span');
            c.className = 'chip';
            c.title = 'Click to view · Ctrl/⌘-click to remove from the comparison';
            c.innerHTML = `<span class="dot" style="background:${s.color}"></span>${s.lap.kind === 'session' ? `S${s.lap.session} full` : `S${s.lap.session} L${s.lap.lapNo}`}
              <span class="mono muted">${lapTime(s.lap.timeMs)}</span>${si === 0 && S.sel.length > 1 ? '<span class="tag ref">REF</span>' : ''}`;
            c.onclick = e => toggleLap(f, s.lap, e.ctrlKey || e.metaKey || e.shiftKey);
            chips.appendChild(c);
          }
          card.appendChild(chips);
        }
        el.appendChild(card);
        return;
      }
      for (const s of f.sessions) {
        const selW = S.sel.find(x => x.file === f && x.lap === s.whole);
        const sh = document.createElement('div');
        sh.className = 'session-h' + (selW ? ' sel' : '');
        sh.title = 'Click to view the whole session (Ctrl/⌘-click to add)';
        sh.innerHTML = `<span>Session ${s.no}</span><span>· ${s.laps.length} laps</span>
          <span class="sw" style="${selW ? `background:${selW.color};border-color:${selW.color}` : ''}"></span>`;
        sh.onclick = e => toggleLap(f, s.whole, e.ctrlKey || e.metaKey || e.shiftKey);
        card.appendChild(sh);
        for (const l of s.laps) {
          const si = S.sel.findIndex(x => x.file === f && x.lap === l), sel = S.sel[si];
          const row = document.createElement('div');
          const isBest = f.best === l;
          row.className = 'lap-row' + (sel ? ' sel' : '') + (l.kind !== 'lap' ? ' dim' : '') + (isBest ? ' best' : '');
          const d = l.kind === 'lap' && f.best ? l.timeMs - f.best.timeMs : null;
          row.innerHTML = `<span class="sw" style="${sel ? `background:${sel.color};border-color:${sel.color}` : ''}"></span>
            <span class="no">L${l.lapNo}</span>
            <span><span class="time mono">${lapTime(l.timeMs)}</span>${l.kind === 'out' ? '<span class="tag">OUT</span>' : l.kind === 'in' ? '<span class="tag">IN</span>' : ''}${isBest ? '<span class="tag best">BEST</span>' : ''}${si === 0 && S.sel.length > 1 ? '<span class="tag ref">REF</span>' : ''}</span>
            <span class="delta mono">${d ? '+' + (d / 1000).toFixed(3) : ''}</span>`;
          row.title = 'Click to view · Ctrl/⌘-click or click the swatch to compare · Right-click a compared lap to make it the reference';
          row.onclick = e => toggleLap(f, l, e.ctrlKey || e.metaKey || e.shiftKey || e.target.classList.contains('sw'));
          row.oncontextmenu = e => { if (si > 0) { e.preventDefault(); makeRef(si); } };
          card.appendChild(row);
        }
      }
      el.appendChild(card);
    });
  }

  function closeFile(fi) {
    const f = S.files[fi];
    S.files.splice(fi, 1);
    S.sel = S.sel.filter(s => s.file !== f);
    if (!S.sel.length && S.files.length) addSel(S.files[0], S.files[0].best || S.files[0].laps[0]);
    S.view = null;
    renderAll();
  }

  function renderLegend(el) {
    el.innerHTML = S.sel.map((s, i) =>
      `<span class="item"><span class="dot" style="background:${s.color}"></span>${esc(lapName(s))} <span class="muted mono">${lapTime(s.lap.timeMs)}</span>${i === 0 && S.sel.length > 1 ? '<span class="tag ref">REF</span>' : ''}</span>`).join('');
  }

  /* ---------- chart panes ---------- */
  const paneEls = [];
  function renderPanes(host, panes, editable = true) {
    host.innerHTML = '';
    paneEls.length = 0;
    const ref = S.sel[0]?.file;
    panes.forEach((p, pi) => {
      const el = document.createElement('div');
      el.className = 'pane' + (p.short ? ' short' : '');
      const head = document.createElement('div');
      head.className = 'pane-h';
      const chips = p.chs.map((name, ci) => {
        const m = chMeta(name);
        const chip = document.createElement('span');
        chip.className = 'chip';
        chip.innerHTML = `<span class="key" style="border-color:${S.sel.length > 1 ? 'var(--muted)' : CH_COLORS[ci % CH_COLORS.length]};border-top-style:${ci ? 'dashed' : 'solid'}"></span>
          <span>${esc(m ? m.label : name)}</span><span class="vals"></span>${editable ? '<button title="Remove channel">×</button>' : ''}`;
        if (editable) chip.querySelector('button').onclick = () => { p.chs.splice(ci, 1); if (!p.chs.length) S.panes.splice(pi, 1); savePanes(); renderAll(); };
        head.appendChild(chip);
        return chip.querySelector('.vals');
      });
      if (editable) {
      const add = document.createElement('select');
      add.innerHTML = `<option value="">+ channel</option><option value="__delta">Time delta</option>` +
        (ref ? ref.channels.filter(c => c.valid).map(c => `<option value="${esc(c.name)}">${esc(c.label)} (${esc(unitOf(c))})</option>`).join('') : '');
      add.onchange = () => { if (add.value) { p.chs.push(add.value); savePanes(); renderAll(); } };
      head.appendChild(add);
      const x = document.createElement('button');
      x.className = 'icon-btn pane-x'; x.title = 'Remove chart'; x.textContent = '×';
      x.onclick = () => { S.panes.splice(pi, 1); savePanes(); renderAll(); };
      head.appendChild(x);
      }
      const cv = document.createElement('canvas');
      el.append(head, cv);
      host.appendChild(el);
      wireCanvas(cv);
      paneEls.push({ p, cv, chips });
    });
  }
  function savePanes() { store.set('panes', S.panes); }

  function viewRange() { return S.view || S.full; }

  function drawPanes() {
    const multi = S.traces.length > 1;
    const view = viewRange();
    for (const { p, cv, chips } of paneEls) {
      const axes = [], series = [];
      p.chs.forEach((name, ci) => {
        const list = [];
        S.traces.forEach((tr, li) => {
          const ys = seriesFor(tr, name);
          if (!ys) return;
          const xs = name === '__delta' ? S.traces[0].xs : tr.xs;
          if (name === '__delta' && li === 0 && multi) return;
          list.push({ xs, ys });
          series.push({ xs, ys, axis: Math.min(ci, 1), color: multi ? tr.sel.color : CH_COLORS[ci % CH_COLORS.length], dash: multi ? DASHES[ci % DASHES.length] : [] });
        });
        if (ci < 2) axes.push({ list, color: CH_COLORS[ci % CH_COLORS.length] });
        else if (axes[1]) axes[1].list.push(...list);
        // header values at cursor
        const m = chMeta(name);
        if (chips[ci]) {
          chips[ci].innerHTML = S.cursor == null ? '' : S.traces.map((tr, li) => {
            if (name === '__delta' && li === 0 && multi) return '';
            const ys = seriesFor(tr, name);
            const xs = name === '__delta' ? S.traces[0].xs : tr.xs;
            const v = ys ? Charts.valueAt(xs, ys, S.cursor) : NaN;
            const txt = isNaN(v) ? '–' : (name === '__delta' ? (v >= 0 ? '+' : '') + v.toFixed(3) : v.toFixed(m ? m.decimals : 2));
            return `<b style="color:${multi ? tr.sel.color : 'inherit'}">${txt}</b>`;
          }).filter(Boolean).join(' ') + ` ${esc(name === '__delta' ? 's' : m ? unitOf(m) : '')}`;
        }
      });
      if (!axes.length) axes.push({ list: [] });
      const geom = Charts.drawPane(cv, {
        view, cursor: S.cursor, sel: drag ? [drag.x0, drag.x1] : null,
        xFmt, xScale: S.xMode === 'dist' && S.units === 'imperial' ? 3.28084 : 1, axes, series, zeroLine: p.chs.includes('__delta'),
      });
      cv._geom = geom;
      if (p.chs.length === 1 && p.chs[0] === '__delta' && !multi) {
        const ctx = cv.getContext('2d');
        ctx.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--muted');
        ctx.font = '12px system-ui'; ctx.textAlign = 'center';
        ctx.fillText('Ctrl/⌘-click another lap in the sidebar to compare and see the time delta', cv.clientWidth / 2, cv.clientHeight / 2 - 6);
      }
    }
  }

  let drag = null;
  function pxToX(cv, clientX) {
    const g = cv._geom; if (!g) return null;
    const r = cv.getBoundingClientRect();
    const f = (clientX - r.left - g.padL) / g.pw;
    return g.x0 + Math.max(0, Math.min(1, f)) * (g.x1 - g.x0);
  }
  function wireCanvas(cv) {
    cv.addEventListener('mousemove', e => {
      const x = pxToX(cv, e.clientX); if (x == null) return;
      S.cursor = x;
      if (drag) drag.x1 = x;
      schedule();
    });
    cv.addEventListener('mousedown', e => { if (e.button !== 0) return; const x = pxToX(cv, e.clientX); drag = { cv, x0: x, x1: x }; });
    cv.addEventListener('dblclick', () => { S.view = null; schedule(); });
    cv.addEventListener('wheel', e => {
      e.preventDefault();
      const [a, b] = viewRange(), span = b - a;
      if (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
        const d = (e.shiftKey ? e.deltaY : e.deltaX) / 600 * span;
        setView(a + d, b + d);
      } else {
        const x = pxToX(cv, e.clientX), k = Math.exp(e.deltaY * 0.0015);
        setView(x - (x - a) * k, x + (b - x) * k);
      }
    }, { passive: false });
  }
  window.addEventListener('mouseup', () => {
    if (!drag) return;
    const [a, b] = [Math.min(drag.x0, drag.x1), Math.max(drag.x0, drag.x1)];
    const [v0, v1] = viewRange();
    drag = null;
    if (b - a > (v1 - v0) * 0.01) setView(a, b); else schedule();
  });
  function setView(a, b) {
    const [f0, f1] = S.full, minSpan = (f1 - f0) / 500;
    let span = Math.max(minSpan, b - a);
    if (span >= f1 - f0) { S.view = null; schedule(); return; }
    a = Math.max(f0, Math.min(a, f1 - span));
    S.view = [a, a + span];
    schedule();
  }

  /* ---------- map / G-G / readout ---------- */
  let mapGeom = null;
  function drawMapGG() {
    const ref = S.traces[0];
    if (!ref) return;
    const view = viewRange();
    const spd = ref.sel.file.speedCh;
    mapGeom = Charts.drawMap($('#mapCanvas'), {
      ref: { x: ref.d.x, y: ref.d.y, v: spd ? ref.d.series(spd) : null, xs: ref.xs },
      others: S.traces.slice(1).filter(t => t.sel.lap.kind !== 'session').map(t => ({ x: t.d.x, y: t.d.y, color: t.sel.color })),
      view, full: S.full, fmtV: speedFmt,
      cursors: S.cursor == null ? [] : S.traces.map(t => {
        if (!t.d.x) return {};
        return { x: Charts.valueAt(t.xs, t.d.x, S.cursor), y: Charts.valueAt(t.xs, t.d.y, S.cursor), color: t.sel.color };
      }),
    });
    Charts.drawGG($('#ggCanvas'), {
      view, cursor: S.cursor,
      sets: S.traces.map(t => {
        const f = t.sel.file;
        const lat = f.channels.find(c => c.typ === 3003) || f.channels.find(c => /lat.*acc/i.test(c.name));
        const lon = f.channels.find(c => c.typ === 3004) || f.channels.find(c => /lon.*acc/i.test(c.name));
        return { lat: t.d.series(lat), lon: t.d.series(lon), xs: t.xs, color: t.sel.color };
      }),
    });
  }

  let readoutCells = [];
  function buildReadout() {
    const ref = S.sel[0];
    if (!ref) return;
    const cols = S.traces.slice(0, 4);
    const chs = ref.file.channels.filter(c => c.valid);
    let html = '<table><thead><tr><th style="text-align:left">Channel</th>' +
      cols.map(t => `<th style="color:${t.sel.color}">${esc(t.sel.lap.kind === 'session' ? 'S' + t.sel.lap.session : 'L' + t.sel.lap.lapNo)}</th>`).join('') + '<th></th></tr></thead><tbody>';
    html += `<tr><td>Lap time</td>${cols.map(() => '<td class="v"></td>').join('')}<td class="u">s</td></tr>`;
    html += `<tr><td>Distance</td>${cols.map(() => '<td class="v"></td>').join('')}<td class="u">${S.units === 'imperial' ? 'ft' : 'm'}</td></tr>`;
    for (const c of chs) html += `<tr class="pick" data-ch="${esc(c.name)}" title="Click to add as a chart"><td>${esc(c.label)}</td>${cols.map(() => '<td class="v"></td>').join('')}<td class="u">${esc(unitOf(c))}</td></tr>`;
    html += '</tbody></table>';
    const el = $('#readout');
    el.innerHTML = html;
    el.querySelectorAll('tr.pick').forEach(tr => tr.onclick = () => { S.panes.push({ chs: [tr.dataset.ch] }); savePanes(); renderAll(); });
    const rows = [...el.querySelectorAll('tbody tr')];
    readoutCells = rows.map((r, i) => ({ ch: i < 2 ? i : chs[i - 2], cells: [...r.querySelectorAll('td.v')] }));
  }
  function updateReadout() {
    const cols = S.traces.slice(0, 4);
    const x = S.cursor;
    $('#cursorPos').textContent = x == null ? '' : S.xMode === 'time' ? xFmt(x) : distFmt(x);
    for (const { ch, cells } of readoutCells) {
      cols.forEach((t, k) => {
        let txt = '–';
        if (x != null) {
          if (ch === 0) { const v = Charts.valueAt(t.xs, t.d.t, x); txt = isNaN(v) ? '–' : v.toFixed(2); }
          else if (ch === 1) { const v = Charts.valueAt(t.xs, t.d.dist, x); txt = isNaN(v) ? '–' : (S.units === 'imperial' ? v * 3.28084 : v).toFixed(0); }
          else { const c = findChannel(t.sel.file, ch.name); txt = c ? fmtVal(c, Charts.valueAt(t.xs, t.d.series(c), x)) : '–'; }
        }
        if (cells[k].textContent !== txt) cells[k].textContent = txt;
      });
    }
  }

  function drawAll() {
    if (!S.files.length) return;
    if (S.tab === 'analysis') { drawPanes(); drawMapGG(); updateReadout(); }
    if (S.tab === 'map') { drawPanes(); updateSat(); }
  }

  /* ---------- satellite map tab ---------- */
  let sat = null;   // { map, layers, dots, selKey, viewKey }
  function ensureSat() {
    if (sat || typeof L === 'undefined') return sat;
    const map = L.map('satMap', { zoomSnap: 0.25, preferCanvas: true });
    L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
      maxNativeZoom: 19, maxZoom: 21,
      attribution: 'Imagery &copy; Esri, Maxar, Earthstar Geographics, and the GIS User Community',
    }).addTo(map);
    map.on('mousemove', e => {
      // scrub: snap to the nearest point of the reference lap's line
      const tr = S.traces[0];
      if (!tr || !tr.lat) return;
      let best = -1, bd = 900;
      for (let i = 0; i < tr.lat.length; i++) {
        if (isNaN(tr.lat[i])) continue;
        const p = map.latLngToContainerPoint([tr.lat[i], tr.lon[i]]);
        const dd = (p.x - e.containerPoint.x) ** 2 + (p.y - e.containerPoint.y) ** 2;
        if (dd < bd) { bd = dd; best = i; }
      }
      if (best >= 0) { S.cursor = tr.xs[best]; schedule(); }
    });
    sat = { map, layers: L.layerGroup().addTo(map), dots: [], selKey: '', viewKey: '' };
    new ResizeObserver(() => map.invalidateSize()).observe($('#satMap'));
    return sat;
  }

  function renderSat() {
    const note = $('#satNote');
    if (typeof L === 'undefined') {
      note.hidden = false;
      note.textContent = 'The satellite map needs an internet connection to load (the map library could not be fetched).';
      return;
    }
    const s = ensureSat();
    s.map.invalidateSize();
    s.layers.clearLayers();
    s.dots = [];
    const missing = [];
    for (const tr of S.traces) {
      const f = tr.sel.file;
      tr.lat = tr.lon = null;
      if (!f.latCh) { if (!missing.includes(f)) missing.push(f); continue; }
      tr.lat = tr.d.series(f.latCh); tr.lon = tr.d.series(f.lonCh);
      const pts = [];
      for (let i = 0; i < tr.lat.length; i++) if (!isNaN(tr.lat[i]) && !isNaN(tr.lon[i])) pts.push([tr.lat[i], tr.lon[i]]);
      L.polyline(pts, { color: tr.sel.color, weight: 3, opacity: 0.95, interactive: false }).addTo(s.layers);
      s.dots.push({ tr, m: L.circleMarker([0, 0], { radius: 6, color: '#fff', weight: 2, fillColor: tr.sel.color, fillOpacity: 1, interactive: false }) });
    }
    note.hidden = !missing.length;
    if (missing.length) {
      note.innerHTML = `No GPS positions for ${missing.map(f => `<b>${esc(f.fileName)}</b>`).join(', ')}. ` +
        (missing.some(f => f.format === 'drk')
          ? `Open the matching <code>.gpk</code> file too (same name, next to the .drk in RaceStudio2's DATA folder) to show ${missing.length > 1 ? 'them' : 'it'} here.`
          : 'This log has no latitude/longitude columns.');
    }
    const key = S.sel.map(x => x.file.fileName + '#' + x.lap.idx).join('|');
    if (key !== s.selKey) { s.selKey = key; s.viewKey = ''; }
  }

  function fitSat(view) {
    let b = null;
    for (const tr of S.traces) {
      if (!tr.lat) continue;
      for (let i = 0; i < tr.lat.length; i++) {
        if (isNaN(tr.lat[i]) || (view && (tr.xs[i] < view[0] || tr.xs[i] > view[1]))) continue;
        const ll = L.latLng(tr.lat[i], tr.lon[i]);
        b ? b.extend(ll) : (b = L.latLngBounds(ll, ll));
      }
    }
    if (b) sat.map.fitBounds(b, { padding: [30, 30], maxZoom: 20, animate: false });
  }

  function updateSat() {
    if (!sat) return;
    const vkey = S.view ? S.view.join() : 'full';
    if (vkey !== sat.viewKey) { sat.viewKey = vkey; fitSat(S.view); }   // zooming a chart zooms the map to that section
    for (const { tr, m } of sat.dots) {
      const a = S.cursor == null ? NaN : Charts.valueAt(tr.xs, tr.lat, S.cursor);
      const b = S.cursor == null ? NaN : Charts.valueAt(tr.xs, tr.lon, S.cursor);
      if (isNaN(a) || isNaN(b)) m.remove(); else m.setLatLng([a, b]).addTo(sat.layers);
    }
  }

  /* ---------- laps tab ---------- */
  function lapStats(file, lap) {
    if (lap._stats) return lap._stats;
    const d = DRK.lapData(file, lap);
    const find = pred => file.channels.find(c => c.valid && pred(c));
    const get = c => c ? d.series(c) : null;
    const max = a => { let m = -Infinity; if (a) for (const v of a) if (v > m) m = v; return isFinite(m) ? m : NaN; };
    const min = a => { let m = Infinity; if (a) for (const v of a) if (v < m) m = v; return isFinite(m) ? m : NaN; };
    const lat = get(find(c => c.typ === 3003)), lon = get(find(c => c.typ === 3004));
    const thrCh = find(c => /PEDAL|THROTTLE|TPS/i.test(c.name)), thr = get(thrCh);
    if (thrCh && file.pedalMax == null) { file.pedalMax = 0; for (const v of thrCh.data) if (v > file.pedalMax && v <= 100) file.pedalMax = v; }
    const s = {
      vmax: max(get(file.speedCh)),
      latG: lat ? Math.max(max(lat), -min(lat)) : NaN,
      brakeG: lon ? -min(lon) : NaN,
      rpm: max(get(find(c => c.unit === 'rpm'))),
      wot: thr ? thr.filter(v => v >= 0.95 * file.pedalMax).length / thr.length * 100 : NaN,
      water: max(get(find(c => /WATER/i.test(c.name)))),
      oil: max(get(find(c => /OIL_TEM/i.test(c.name)))),
      len: d.len,
    };
    return (lap._stats = s);
  }

  // Theoretical best: split the lap into equal-distance segments and sum the best of each.
  function theoretical(file, laps, nSeg = 12) {
    const timed = laps.filter(l => l.kind === 'lap');
    if (timed.length < 2) return null;
    const best = new Array(nSeg).fill(Infinity);
    for (const l of timed) {
      const d = DRK.lapData(file, l);
      let prev = 0;
      for (let k = 1; k <= nSeg; k++) {
        const t = k === nSeg ? d.t[d.n - 1] : Charts.valueAt(d.dist, d.t, d.len * k / nSeg);
        best[k - 1] = Math.min(best[k - 1], t - prev);
        prev = t;
      }
    }
    return best.reduce((a, b) => a + b, 0) * 1000;
  }

  function renderLaps() {
    const el = $('#lapsView');
    const cF = v => (S.units === 'imperial' ? v * 9 / 5 + 32 : v);
    let html = '';
    for (const f of S.files) {
      const all = f.laps.filter(l => l.kind === 'lap');
      const theo = theoretical(f, f.laps);
      const vmax = Math.max(...f.laps.map(l => lapStats(f, l).vmax).filter(isFinite));
      html += `<h2>${esc(f.meta.track)} · ${esc(f.meta.vehicle)} · ${esc(f.date ? f.date.toLocaleDateString() : '')}</h2>
      <div class="stats-row">
        <div class="stat"><div class="k">Best lap</div><div class="v mono">${lapTime(f.best?.timeMs)}</div><div class="s">${f.best ? `Session ${f.best.session}, lap ${f.best.lapNo}` : ''}</div></div>
        <div class="stat"><div class="k">Theoretical best</div><div class="v mono">${theo ? lapTime(Math.round(theo)) : '–'}</div><div class="s">best of 12 track segments</div></div>
        <div class="stat"><div class="k">Top speed</div><div class="v">${isFinite(vmax) ? speedFmt(vmax) : '–'}</div><div class="s">GPS</div></div>
        <div class="stat"><div class="k">Timed laps</div><div class="v">${all.length}</div><div class="s">${f.sessions.length} session${f.sessions.length > 1 ? 's' : ''} · ${Math.round(f.durationMs / 60000)} min on track</div></div>
      </div>`;
      const fast = f.best ? f.best.timeMs : 0, slow = fast * 1.06;   // bars cover best .. +6 %
      html += `<div class="tbl-wrap"><table class="data"><thead><tr><th class="l">Lap</th><th>Time</th><th>Δ best</th><th class="l bar-cell">pace</th><th>Top speed</th><th>Max lat G</th><th>Max brake G</th><th>Full throttle</th><th>Max RPM</th><th>Water</th><th>Oil</th></tr></thead><tbody>`;
      for (const l of f.laps) {
        const st = lapStats(f, l), isSel = S.sel.some(s => s.file === f && s.lap === l);
        const w = l.kind === 'lap' && fast ? 4 + 96 * Math.max(0, 1 - (l.timeMs - fast) / (slow - fast)) : 0;
        html += `<tr class="click ${l.kind !== 'lap' ? 'dim' : ''} ${f.best === l ? 'best' : ''} ${isSel ? 'sel' : ''}" data-f="${S.files.indexOf(f)}" data-l="${f.laps.indexOf(l)}">
          <td>S${l.session} · L${l.lapNo}${l.kind !== 'lap' ? ` <span class="tag">${l.kind.toUpperCase()}</span>` : ''}</td>
          <td class="mono">${lapTime(l.timeMs)}</td>
          <td class="mono">${l.kind === 'lap' && f.best ? '+' + ((l.timeMs - f.best.timeMs) / 1000).toFixed(3) : ''}</td>
          <td class="l bar-cell">${w ? `<div class="bar" style="width:${w.toFixed(0)}%"></div>` : ''}</td>
          <td>${isFinite(st.vmax) ? speedFmt(st.vmax) : '–'}</td>
          <td>${isFinite(st.latG) ? st.latG.toFixed(2) : '–'}</td>
          <td>${isFinite(st.brakeG) ? st.brakeG.toFixed(2) : '–'}</td>
          <td>${isFinite(st.wot) ? st.wot.toFixed(0) + '%' : '–'}</td>
          <td>${isFinite(st.rpm) ? Math.round(st.rpm) : '–'}</td>
          <td>${isFinite(st.water) ? cF(st.water).toFixed(0) + '°' : '–'}</td>
          <td>${isFinite(st.oil) ? cF(st.oil).toFixed(0) + '°' : '–'}</td></tr>`;
      }
      html += '</tbody></table></div>';
    }
    html += `<p class="muted small">Click a lap to open it in Analysis; Ctrl/⌘-click to add it to the comparison. Lap times are the logger's precise line-crossing times, the same ones RaceStudio2 shows.</p>
      <button class="btn" id="exportCsv">Export selected laps to CSV</button>`;
    el.innerHTML = html;
    el.querySelectorAll('tr.click').forEach(tr => tr.onclick = e => {
      const f = S.files[+tr.dataset.f], l = f.laps[+tr.dataset.l];
      const additive = e.ctrlKey || e.metaKey || e.shiftKey;
      toggleLap(f, l, additive);
      if (!additive) { S.tab = 'analysis'; renderAll(); }
    });
    $('#exportCsv').onclick = exportCsv;
  }

  /* ---------- channels tab ---------- */
  function renderChannels() {
    const f = S.sel[0]?.file || S.files[0];
    let html = `<h2>Channels · ${esc(f.fileName)}</h2><div class="tbl-wrap"><table class="data"><thead><tr>
      <th class="l">Channel</th><th class="l">Unit</th><th>Rate</th><th>Samples</th><th>Valid</th><th>Min</th><th>Mean</th><th>Max</th><th class="l">Raw id</th></tr></thead><tbody>`;
    for (const c of f.channels) {
      let lo = Infinity, hi = -Infinity, sum = 0, n = 0;
      for (const v of c.data) if (!isNaN(v)) { if (v < lo) lo = v; if (v > hi) hi = v; sum += v; n++; }
      const pct = c.count ? n / c.count * 100 : 0;
      html += `<tr class="${n ? '' : 'dim'}"><td>${esc(c.label)}</td><td class="l">${esc(unitOf(c))}</td><td>${c.rate.toFixed(c.rate < 1 ? 2 : 0)} Hz</td><td>${c.count.toLocaleString()}</td>
        <td class="${pct < 90 && n ? 'warn' : ''}">${pct.toFixed(pct > 99.5 || pct < 0.5 ? 0 : 1)}%</td>
        <td>${n ? fmtVal(c, lo) : '–'}</td><td>${n ? fmtVal(c, sum / n) : '–'}</td><td>${n ? fmtVal(c, hi) : '–'}</td>
        <td class="l muted mono small">${esc(c.code)} / ${c.typ}</td></tr>`;
    }
    html += `</tbody></table></div><p class="muted small">Channels with 0% valid data are configured on the logger but the ECU never sent values.</p>`;
    $('#channelsView').innerHTML = html;
  }

  /* ---------- export ---------- */
  function exportCsv() {
    const lines = [];
    for (const s of S.sel) {
      const d = DRK.lapData(s.file, s.lap);
      const chs = s.file.channels.filter(c => c.valid);
      if (!lines.length) lines.push(['Lap', 'Time (s)', `Distance (${S.units === 'imperial' ? 'ft' : 'm'})`, ...chs.map(c => `${c.label} (${unitOf(c)})`)].map(csvq).join(','));
      const cols = chs.map(c => { const a = d.series(c), f = cvt(c); return f ? a.map(f) : a; });
      for (let i = 0; i < d.n; i++) {
        lines.push([lapName(s), d.t[i].toFixed(3), (S.units === 'imperial' ? d.dist[i] * 3.28084 : d.dist[i]).toFixed(1),
          ...cols.map((a, k) => isNaN(a[i]) ? '' : a[i].toFixed(chs[k].decimals + 1))].map(csvq).join(','));
      }
    }
    const blob = new Blob([lines.join('\r\n')], { type: 'text/csv' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = (S.sel[0]?.file.fileName || 'laps').replace(/\.(drk|xrk|vbo)$/i, '') + '_laps.csv';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }
  const csvq = v => /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v);

  /* ---------- misc ---------- */
  function esc(s) { return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
  let toastTimer = 0;
  function toast(msg, kind) {
    const t = $('#toast'); t.textContent = msg; t.hidden = false; t.classList.toggle('info', kind === 'info');
    clearTimeout(toastTimer); toastTimer = setTimeout(() => (t.hidden = true), 6000);
  }

  function applyTheme(t) {
    if (t) document.documentElement.dataset.theme = t; else delete document.documentElement.dataset.theme;
  }

  function init() {
    const theme = store.get('theme', null) || (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark');
    applyTheme(theme);
    $('#themeBtn').onclick = () => {
      const t = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light';
      applyTheme(t); store.set('theme', t); schedule();
    };
    const pick = () => $('#fileInput').click();
    $('#openBtn').onclick = pick; $('#openBtn2').onclick = pick;
    $('#fileInput').onchange = e => { openFiles([...e.target.files]); e.target.value = ''; };
    document.querySelectorAll('#tabs button').forEach(b => b.onclick = () => { S.tab = b.dataset.tab; renderAll(); });
    document.querySelectorAll('#xmode button').forEach(b => b.onclick = () => { S.xMode = b.dataset.v; store.set('xMode', S.xMode); S.view = null; S.cursor = null; renderAll(); });
    document.querySelectorAll('#units button').forEach(b => b.onclick = () => { S.units = b.dataset.v; store.set('units', S.units); renderAll(); });
    $('#resetZoom').onclick = $('#resetZoom2').onclick = () => { S.view = null; schedule(); };
    $('#addPane').onclick = () => { const f = S.sel[0]?.file; S.panes.push({ chs: [f?.speedCh?.name || f?.channels[0].name] }); savePanes(); renderAll(); };

    let depth = 0;
    window.addEventListener('dragenter', e => { e.preventDefault(); depth++; $('#dragOverlay').hidden = false; });
    window.addEventListener('dragleave', () => { if (--depth <= 0) { depth = 0; $('#dragOverlay').hidden = true; } });
    window.addEventListener('dragover', e => e.preventDefault());
    window.addEventListener('drop', e => { e.preventDefault(); depth = 0; $('#dragOverlay').hidden = true; openFiles([...e.dataTransfer.files]); });

    const map = $('#mapCanvas');
    map.addEventListener('mousemove', e => {
      if (!mapGeom || !S.traces[0]) return;
      const r = map.getBoundingClientRect(), i = mapGeom.nearest(e.clientX - r.left, e.clientY - r.top);
      if (i >= 0) { S.cursor = S.traces[0].xs[i]; schedule(); }
    });
    // redraw whenever any canvas container changes size, not just the main column
    const ro = new ResizeObserver(schedule);
    ro.observe($('.main'));
    document.querySelectorAll('.canvas-box').forEach(el => ro.observe(el));
    ro.observe($('#panes'));
    ro.observe($('#mapPanes'));
    window.addEventListener('keydown', e => {
      if (e.target.tagName === 'SELECT' || S.cursor == null || !S.traces[0]) return;
      const step = (S.xMode === 'time' ? 0.1 : 5) * (e.shiftKey ? 10 : 1);
      if (e.key === 'ArrowRight') { S.cursor += step; schedule(); }
      if (e.key === 'ArrowLeft') { S.cursor -= step; schedule(); }
    });
    renderAll();
  }

  init();
  return { loadBuffer, state: S };
})();
