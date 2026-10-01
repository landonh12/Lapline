'use strict';
/* Canvas drawing: time/distance chart panes, track map and G-G diagram. */
const Charts = (() => {
  function css(name) { return getComputedStyle(document.documentElement).getPropertyValue(name).trim(); }

  function setup(canvas) {
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth, h = canvas.clientHeight;
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
    }
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    return { ctx, w, h };
  }

  // First index with xs[i] >= x (xs ascending).
  function lowerBound(xs, x) {
    let lo = 0, hi = xs.length;
    while (lo < hi) { const m = (lo + hi) >> 1; if (xs[m] < x) lo = m + 1; else hi = m; }
    return lo;
  }

  function valueAt(xs, ys, x) {
    if (!xs || !ys || !xs.length) return NaN;
    const i = lowerBound(xs, x);
    if (i <= 0) return xs[0] - x > 1e-6 ? NaN : ys[0];
    if (i >= xs.length) return NaN;
    const x0 = xs[i - 1], x1 = xs[i], a = ys[i - 1], b = ys[i];
    if (isNaN(a)) return b; if (isNaN(b)) return a;
    return x1 === x0 ? a : a + (b - a) * (x - x0) / (x1 - x0);
  }

  function niceStep(range, target) {
    const raw = range / Math.max(1, target), p = Math.pow(10, Math.floor(Math.log10(raw))), f = raw / p;
    return (f < 1.5 ? 1 : f < 3 ? 2 : f < 7 ? 5 : 10) * p;
  }

  function rangeOf(list, x0, x1) {
    let lo = Infinity, hi = -Infinity;
    for (const { xs, ys } of list) {
      const a = Math.max(0, lowerBound(xs, x0) - 1), b = Math.min(xs.length, lowerBound(xs, x1) + 1);
      for (let i = a; i < b; i++) { const v = ys[i]; if (v < lo) lo = v; if (v > hi) hi = v; }
    }
    if (!isFinite(lo)) return [0, 1];
    if (hi - lo < 1e-9) { const p = Math.abs(hi) * 0.1 || 1; return [lo - p, hi + p]; }
    const pad = (hi - lo) * 0.08;
    return [lo - pad, hi + pad];
  }

  function fmtNum(v, step) {
    const d = step >= 1 ? 0 : Math.min(4, Math.ceil(-Math.log10(step)));
    return v.toFixed(d);
  }

  function drawLine(ctx, xs, ys, i0, i1, X, Y, plotW) {
    ctx.beginPath();
    let pen = false;
    if (i1 - i0 < plotW * 3) {
      for (let i = i0; i < i1; i++) {
        const v = ys[i];
        if (isNaN(v)) { pen = false; continue; }
        const px = X(xs[i]), py = Y(v);
        if (pen) ctx.lineTo(px, py); else { ctx.moveTo(px, py); pen = true; }
      }
    } else {
      // min/max decimation per pixel column keeps peaks visible on long ranges
      let col = null, mn = 0, mx = 0, first = 0, last = 0;
      const flush = () => {
        if (col === null) return;
        if (pen) ctx.lineTo(col, Y(first)); else { ctx.moveTo(col, Y(first)); pen = true; }
        ctx.lineTo(col, Y(mn)); ctx.lineTo(col, Y(mx)); ctx.lineTo(col, Y(last));
      };
      for (let i = i0; i < i1; i++) {
        const v = ys[i];
        if (isNaN(v)) continue;
        const c = Math.round(X(xs[i]));
        if (c !== col) { flush(); col = c; mn = mx = first = last = v; }
        else { if (v < mn) mn = v; if (v > mx) mx = v; last = v; }
      }
      flush();
    }
    ctx.stroke();
  }

  /*
   * opts: { view:[x0,x1], cursor, sel:[a,b]|null, xFmt(v)->str, xUnitStep,
   *         axes:[{label,color,decimals,list:[{xs,ys}]}], series:[{xs,ys,color,dash,axis,width}], zeroLine }
   */
  function drawPane(canvas, o) {
    const { ctx, w, h } = setup(canvas);
    const padL = 48, padR = o.axes.length > 1 ? 48 : 12, padT = 8, padB = 20;
    const pw = Math.max(10, w - padL - padR), ph = Math.max(10, h - padT - padB);
    const [x0, x1] = o.view;
    const X = x => padL + (x - x0) / (x1 - x0 || 1) * pw;
    const grid = css('--grid'), muted = css('--muted'), text = css('--text');
    ctx.font = '10.5px Inter, Segoe UI, system-ui, sans-serif';

    // x grid
    const k = o.xScale || 1;   // ticks are chosen in display units (e.g. feet), positions stay in metres
    const xs = niceStep((x1 - x0) * k, Math.max(2, pw / 110));
    ctx.strokeStyle = grid; ctx.lineWidth = 1; ctx.fillStyle = muted; ctx.textAlign = 'center'; ctx.textBaseline = 'top';
    for (let dv = Math.ceil(x0 * k / xs) * xs; dv <= x1 * k; dv += xs) {
      const v = dv / k, px = Math.round(X(v)) + 0.5;
      ctx.beginPath(); ctx.moveTo(px, padT); ctx.lineTo(px, padT + ph); ctx.stroke();
      ctx.fillText(o.xFmt(v), px, padT + ph + 4);
    }

    // y axes, each channel gets its own scale
    const scales = o.axes.map((ax, k) => {
      const [lo, hi] = ax.range || rangeOf(ax.list, x0, x1);
      const Y = v => padT + ph - (v - lo) / (hi - lo) * ph;
      const step = niceStep(hi - lo, Math.max(2, ph / 34));
      ctx.textBaseline = 'middle';
      ctx.textAlign = k === 0 ? 'right' : 'left';
      ctx.fillStyle = o.axes.length > 1 ? ax.color : muted;
      for (let v = Math.ceil(lo / step) * step; v <= hi; v += step) {
        const py = Math.round(Y(v)) + 0.5;
        if (k === 0) { ctx.strokeStyle = grid; ctx.beginPath(); ctx.moveTo(padL, py); ctx.lineTo(padL + pw, py); ctx.stroke(); }
        ctx.fillText(fmtNum(v, step), k === 0 ? padL - 6 : padL + pw + 6, py);
      }
      return Y;
    });

    if (o.zeroLine) {
      const py = Math.round(scales[0](0)) + 0.5;
      ctx.strokeStyle = muted; ctx.globalAlpha = 0.6; ctx.beginPath(); ctx.moveTo(padL, py); ctx.lineTo(padL + pw, py); ctx.stroke(); ctx.globalAlpha = 1;
    }

    ctx.save();
    ctx.beginPath(); ctx.rect(padL, padT - 2, pw, ph + 4); ctx.clip();
    ctx.lineJoin = 'round';
    for (const s of o.series) {
      const i0 = Math.max(0, lowerBound(s.xs, x0) - 1), i1 = Math.min(s.xs.length, lowerBound(s.xs, x1) + 1);
      ctx.strokeStyle = s.color; ctx.lineWidth = s.width || 1.5; ctx.setLineDash(s.dash || []);
      drawLine(ctx, s.xs, s.ys, i0, i1, X, scales[s.axis || 0], pw);
    }
    ctx.setLineDash([]);

    if (o.sel) {
      const a = X(Math.min(o.sel[0], o.sel[1])), b = X(Math.max(o.sel[0], o.sel[1]));
      ctx.fillStyle = css('--accent'); ctx.globalAlpha = 0.15; ctx.fillRect(a, padT, b - a, ph); ctx.globalAlpha = 1;
    }
    if (o.cursor != null && o.cursor >= x0 && o.cursor <= x1) {
      const px = Math.round(X(o.cursor)) + 0.5;
      ctx.strokeStyle = text; ctx.globalAlpha = 0.55; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(px, padT); ctx.lineTo(px, padT + ph); ctx.stroke(); ctx.globalAlpha = 1;
      for (const s of o.series) {
        const v = valueAt(s.xs, s.ys, o.cursor);
        if (isNaN(v)) continue;
        ctx.fillStyle = s.color; ctx.beginPath(); ctx.arc(px, scales[s.axis || 0](v), 3, 0, Math.PI * 2); ctx.fill();
      }
    }
    ctx.restore();
    return { padL, pw, x0, x1 };
  }

  function speedColor(t) {
    // slow = blue, fast = red
    const hue = 240 - 240 * Math.max(0, Math.min(1, t));
    return `hsl(${hue}, 85%, 55%)`;
  }

  /*
   * o: { ref:{x,y,v,xs}, others:[{x,y,color}], view:[x0,x1], full:[x0,x1], cursors:[{x,y,color}] }
   * returns a transform for hit-testing
   */
  function drawMap(canvas, o) {
    const { ctx, w, h } = setup(canvas);
    const { x, y } = o.ref;
    if (!x) {
      ctx.fillStyle = css('--muted'); ctx.textAlign = 'center'; ctx.font = '12px system-ui';
      ctx.fillText('No GPS heading channel in this file', w / 2, h / 2);
      return null;
    }
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (let i = 0; i < x.length; i++) {
      if (x[i] < minX) minX = x[i]; if (x[i] > maxX) maxX = x[i];
      if (y[i] < minY) minY = y[i]; if (y[i] > maxY) maxY = y[i];
    }
    const pad = 18, sc = Math.min((w - 2 * pad) / (maxX - minX || 1), (h - 2 * pad) / (maxY - minY || 1));
    const ox = (w - (maxX - minX) * sc) / 2, oy = (h - (maxY - minY) * sc) / 2;
    const P = (px, py) => [ox + (px - minX) * sc, h - (oy + (py - minY) * sc)];

    const zoomed = o.view[0] > o.full[0] + 1e-6 || o.view[1] < o.full[1] - 1e-6;
    ctx.lineCap = 'round'; ctx.lineJoin = 'round';

    // base outline
    ctx.strokeStyle = css('--line'); ctx.lineWidth = 9;
    ctx.beginPath();
    for (let i = 0; i < x.length; i++) { const [a, b] = P(x[i], y[i]); i ? ctx.lineTo(a, b) : ctx.moveTo(a, b); }
    ctx.stroke();

    for (const ot of o.others) {
      if (!ot.x) continue;
      ctx.strokeStyle = ot.color; ctx.lineWidth = 1.2; ctx.globalAlpha = 0.8; ctx.beginPath();
      for (let i = 0; i < ot.x.length; i++) { const [a, b] = P(ot.x[i], ot.y[i]); i ? ctx.lineTo(a, b) : ctx.moveTo(a, b); }
      ctx.stroke(); ctx.globalAlpha = 1;
    }

    // reference lap colored by speed
    const v = o.ref.v, xs = o.ref.xs;
    let vmin = Infinity, vmax = -Infinity;
    if (v) for (const s of v) { if (s < vmin) vmin = s; if (s > vmax) vmax = s; }
    ctx.lineWidth = 4;
    for (let i = 1; i < x.length; i++) {
      const inView = xs[i] >= o.view[0] && xs[i - 1] <= o.view[1];
      ctx.globalAlpha = zoomed && !inView ? 0.18 : 1;
      ctx.strokeStyle = v ? speedColor((v[i] - vmin) / (vmax - vmin || 1)) : css('--accent');
      const [a, b] = P(x[i - 1], y[i - 1]), [c, d] = P(x[i], y[i]);
      ctx.beginPath(); ctx.moveTo(a, b); ctx.lineTo(c, d); ctx.stroke();
    }
    ctx.globalAlpha = 1;

    // start/finish
    const [sx, sy] = P(x[0], y[0]);
    ctx.fillStyle = css('--text'); ctx.strokeStyle = css('--panel'); ctx.lineWidth = 2;
    ctx.beginPath(); ctx.rect(sx - 4, sy - 4, 8, 8); ctx.fill(); ctx.stroke();

    for (const c of o.cursors) {
      if (c.x == null || isNaN(c.x)) continue;
      const [a, b] = P(c.x, c.y);
      ctx.fillStyle = c.color; ctx.strokeStyle = '#fff'; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(a, b, 6, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    }

    // speed legend
    if (v && isFinite(vmin)) {
      const lw = 90, lx = w - lw - 12, ly = h - 16;
      const g = ctx.createLinearGradient(lx, 0, lx + lw, 0);
      for (let k = 0; k <= 4; k++) g.addColorStop(k / 4, speedColor(k / 4));
      ctx.fillStyle = g; ctx.fillRect(lx, ly, lw, 5);
      ctx.fillStyle = css('--muted'); ctx.font = '10px system-ui'; ctx.textBaseline = 'bottom';
      ctx.textAlign = 'left'; ctx.fillText(o.fmtV(vmin), lx, ly - 2);
      ctx.textAlign = 'right'; ctx.fillText(o.fmtV(vmax), lx + lw, ly - 2);
    }

    return {
      nearest(mx, my) {
        let best = -1, bd = Infinity;
        for (let i = 0; i < x.length; i++) {
          const [a, b] = P(x[i], y[i]); const dd = (a - mx) ** 2 + (b - my) ** 2;
          if (dd < bd) { bd = dd; best = i; }
        }
        return bd < 900 ? best : -1;
      },
    };
  }

  /* o: { sets:[{lat,lon,xs,color}], view, cursor } */
  function drawGG(canvas, o) {
    const { ctx, w, h } = setup(canvas);
    const muted = css('--muted'), grid = css('--grid');
    if (!o.sets.length || !o.sets[0].lat) {
      ctx.fillStyle = muted; ctx.textAlign = 'center'; ctx.font = '12px system-ui';
      ctx.fillText('No acceleration channels', w / 2, h / 2);
      return;
    }
    let m = 0.5;
    for (const s of o.sets) {
      const i0 = lowerBound(s.xs, o.view[0]), i1 = lowerBound(s.xs, o.view[1]);
      for (let i = i0; i < i1; i++) {
        const a = Math.abs(s.lat[i]), b = Math.abs(s.lon[i]);
        if (a > m && a < 4) m = a; if (b > m && b < 4) m = b;
      }
    }
    m = Math.ceil(m * 2) / 2;
    const r = Math.min(w, h) / 2 - 22, cx = w / 2, cy = h / 2 + 4;
    ctx.strokeStyle = grid; ctx.fillStyle = muted; ctx.font = '10px system-ui'; ctx.lineWidth = 1;
    ctx.textAlign = 'left'; ctx.textBaseline = 'bottom';
    for (let g = 0.5; g <= m + 1e-9; g += 0.5) {
      const rr = r * g / m;
      ctx.beginPath(); ctx.arc(cx, cy, rr, 0, Math.PI * 2); ctx.stroke();
      ctx.fillText(g.toFixed(1) + 'g', cx + rr * 0.707 + 2, cy - rr * 0.707);
    }
    ctx.beginPath(); ctx.moveTo(cx - r, cy); ctx.lineTo(cx + r, cy); ctx.moveTo(cx, cy - r); ctx.lineTo(cx, cy + r); ctx.stroke();
    ctx.textAlign = 'center';
    ctx.fillText('accel', cx, cy - r - 4); ctx.textBaseline = 'top'; ctx.fillText('brake', cx, cy + r + 4);

    for (const s of o.sets) {
      const i0 = lowerBound(s.xs, o.view[0]), i1 = lowerBound(s.xs, o.view[1]);
      ctx.fillStyle = s.color; ctx.globalAlpha = 0.35;
      for (let i = i0; i < i1; i++) {
        const a = s.lat[i], b = s.lon[i];
        if (isNaN(a) || isNaN(b)) continue;
        ctx.fillRect(cx + a / m * r - 1, cy - b / m * r - 1, 2.2, 2.2);
      }
      ctx.globalAlpha = 1;
      if (o.cursor != null) {
        const a = valueAt(s.xs, s.lat, o.cursor), b = valueAt(s.xs, s.lon, o.cursor);
        if (!isNaN(a) && !isNaN(b)) {
          ctx.strokeStyle = '#fff'; ctx.lineWidth = 2;
          ctx.beginPath(); ctx.arc(cx + a / m * r, cy - b / m * r, 5.5, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
        }
      }
    }
  }

  return { drawPane, drawMap, drawGG, valueAt, lowerBound, setup };
})();
