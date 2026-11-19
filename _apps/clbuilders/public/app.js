// Payment waterfall scenario planner. Served only to signed-in visitors; data comes from /api/data.
// Reordering happens here only. The Google Sheet is never changed.
(() => {
  const $ = (id) => document.getElementById(id);
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
  const SVG = 'http://www.w3.org/2000/svg';
  const sv = (tag, attrs = {}, text) => { const e = document.createElementNS(SVG, tag); for (const k in attrs) e.setAttribute(k, attrs[k]); if (text != null) e.textContent = text; return e; };
  const fmt = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0, minimumFractionDigits: 0 });
  const money = (n) => (n < 0 ? `(${fmt.format(-n)})` : fmt.format(n));
  const short = (n) => {
    const a = Math.abs(n);
    const s = a >= 1e6 ? `$${+(a / 1e6).toFixed(1)}M` : a >= 1e3 ? `$${Math.round(a / 1e3)}k` : `$${Math.round(a)}`;
    return n < 0 ? `(${s})` : s;
  };
  const store = {
    get(k) { try { return JSON.parse(sessionStorage.getItem(k)); } catch { return null; } },
    set(k, v) { try { v == null ? sessionStorage.removeItem(k) : sessionStorage.setItem(k, JSON.stringify(v)); } catch {} },
  };

  // base: the sheet as read (rows in sheet order). order: indexes into base.rows in the order being tried.
  let base = null, order = [], lastLoad = 0, flashIdx = null, hoverStep = null;
  const isIdentity = (o) => o.every((v, i) => v === i);
  const sameDollars = (p, q) => Math.round(p) === Math.round(q); // amounts carry cents; compare whole dollars
  const timeNow = () => new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const keyFor = (b) => `clb_order:${b.version}`;

  function summarize(start, amounts) {
    let bal = start, lowest = amounts.length ? Infinity : start, lowAt = 0, owed = 0, cashIn = 0;
    const running = amounts.map((a, i) => {
      if (a < 0) owed -= a; else cashIn += a;
      bal += a;
      if (bal < lowest) { lowest = bal; lowAt = i; }
      return bal;
    });
    const firstNeg = running.findIndex((b) => b < 0);
    return { running, owed, cashIn, ending: bal, lowest, lowAt, firstNeg, shortfall: lowest < 0 ? -lowest : 0, ok: lowest >= 0 };
  }

  function setStatus(kind, text) {
    const s = $('status');
    s.className = `status ${kind || ''}`;
    s.textContent = text;
  }
  function errorBanner(text) {
    const b = $('banner');
    if (text) { b.className = 'banner err'; b.textContent = text; }
  }

  function tile(label, value, note, cls = '', valueCls = '') {
    const t = el('div', `tile ${cls}`);
    t.append(el('div', 'l', label), el('div', `v ${valueCls}`, value));
    if (note) t.append(note instanceof Node ? note : el('div', 'n', note));
    return t;
  }
  // "Sheet order: ($236,583)" under a figure, green when this order is better, red when worse.
  function vsSheet(now, sheet, higherIsBetter) {
    const n = el('div', 'n');
    if (sameDollars(now, sheet)) { n.textContent = 'Same as sheet order'; return n; }
    const better = higherIsBetter ? now > sheet : now < sheet;
    n.append('Sheet order ', el('span', `was ${better ? 'better' : 'worse'}`, money(sheet)));
    return n;
  }

  function render() {
    const { inputs } = base;
    const rows = order.map((i) => base.rows[i]);
    const s = summarize(inputs.startingBalance, rows.map((r) => r.amount));
    const ref = summarize(inputs.startingBalance, base.rows.map((r) => r.amount));
    const changed = !isIdentity(order);

    setStatus(changed ? 'changed' : '', changed ? 'Trying a new order' : 'Sheet order');
    $('reset').disabled = !changed;

    $('tiles').replaceChildren(
      tile('Status', s.ok ? 'OK' : 'SHORT',
        s.ok ? 'The balance never goes below $0 in this order.' : `The balance goes below $0 at step ${s.firstNeg + 1}.`,
        `state ${s.ok ? 'ok' : 'short'}`),
      tile('Starting balance', money(inputs.startingBalance), 'Bank balance now'),
      tile('Incoming payment', money(inputs.incomingAmount), inputs.incomingDate ? `Expected ${inputs.incomingDate}` : 'No date set', '', 'pos'),
      tile('Total owed', money(s.owed), `${rows.filter((r) => r.amount < 0).length} payments`),
      tile('Ending balance', money(s.ending), 'Same in any order', '', s.ending < 0 ? 'neg' : ''),
      tile('Lowest balance', money(s.lowest), changed ? vsSheet(s.lowest, ref.lowest, true) : `At step ${s.lowAt + 1}`, '', s.lowest < 0 ? 'neg' : ''),
      tile('Shortfall', money(s.shortfall), changed ? vsSheet(s.shortfall, ref.shortfall, false) : 'Cash needed to cover', '', s.shortfall > 0 ? 'neg' : '')
    );

    $('list').replaceChildren(...rows.map((r, pos) => {
      const li = el('li', 'item');
      const bal = s.running[pos];
      if (r.incoming || r.amount > 0) li.classList.add('in');
      else if (bal < 0) li.classList.add('short');
      if (order[pos] === flashIdx) li.classList.add('flash');
      if (hoverStep === pos + 1) li.classList.add('hot');

      const body = el('div', 'body');
      const v = el('div', 'vendor', r.vendor || '(no vendor)');
      if (order[pos] !== pos) v.append(el('span', 'moved', `was #${order[pos] + 1}`));
      body.append(v);
      const proj = [r.project, r.incoming && r.date ? `expected ${r.date}` : r.date].filter(Boolean).join(' · ');
      if (proj) body.append(el('div', 'proj', proj));
      const nums = el('div', 'nums');
      nums.append(el('span', r.amount < 0 ? '' : 'pos', money(r.amount)));
      const b = el('span', 'bal', 'Balance after ');
      b.append(el('b', '', money(bal)));
      nums.append(b);
      body.append(nums);

      const moves = el('div', 'moves');
      const up = el('button', 'mv', '▲'), down = el('button', 'mv', '▼');
      up.type = down.type = 'button';
      up.setAttribute('aria-label', `Move ${r.vendor} up`);
      down.setAttribute('aria-label', `Move ${r.vendor} down`);
      up.disabled = pos === 0;
      down.disabled = pos === rows.length - 1;
      up.onclick = () => move(pos, -1);
      down.onclick = () => move(pos, 1);
      moves.append(up, down);

      li.append(el('div', 'step', String(pos + 1)), body, moves);
      return li;
    }));

    drawChart(rows, s, ref, changed);
  }

  // ---------- chart ----------
  function niceTicks(lo, hi, count) {
    const span = hi - lo || 1;
    const raw = span / count, mag = 10 ** Math.floor(Math.log10(raw));
    const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw);
    const ticks = [];
    for (let v = Math.floor(lo / step) * step; v <= hi + step * 1e-9; v += step) ticks.push(Math.round(v));
    return ticks;
  }

  function drawChart(rows, s, ref, changed) {
    const box = $('chart');
    const W = Math.max(280, Math.round(box.clientWidth || 600));
    const H = W < 500 ? 220 : 300;
    const pad = { l: 58, r: 14, t: 26, b: 26 };
    const n = rows.length;
    const start = base.inputs.startingBalance;
    const mine = [start, ...s.running], sheet = [start, ...ref.running];
    const all = changed ? mine.concat(sheet) : mine;
    let lo = Math.min(0, ...all), hi = Math.max(0, ...all);
    const ticks = niceTicks(lo, hi, W < 500 ? 4 : 5);
    lo = Math.min(lo, ticks[0]); hi = Math.max(hi, ticks[ticks.length - 1]);
    const x = (i) => pad.l + (n ? (i / n) * (W - pad.l - pad.r) : 0);
    const y = (v) => pad.t + ((hi - v) / (hi - lo || 1)) * (H - pad.t - pad.b);

    const svg = sv('svg', { viewBox: `0 0 ${W} ${H}`, width: W, height: H });

    // Below-$0 zone, then gridlines and value labels.
    if (lo < 0) svg.append(sv('rect', { x: pad.l, y: y(0), width: W - pad.l - pad.r, height: y(lo) - y(0), fill: 'var(--neg-bg)' }));
    for (const t of ticks) {
      svg.append(sv('line', { x1: pad.l, x2: W - pad.r, y1: y(t), y2: y(t), stroke: t === 0 ? 'var(--ink-faint)' : 'var(--grid)', 'stroke-width': 1 }));
      svg.append(sv('text', { x: pad.l - 8, y: y(t) + 4, 'text-anchor': 'end' }, short(t)));
    }
    // Step labels along the bottom.
    const every = Math.max(1, Math.ceil(n / (W < 500 ? 6 : 10)));
    for (let i = 0; i <= n; i++) {
      if (i !== 0 && i % every !== 0 && i !== n) continue;
      if (i !== n && n - i < every && i !== 0) continue; // keep the last label from crowding the one before
      svg.append(sv('text', { x: x(i), y: H - 8, 'text-anchor': i === 0 ? 'start' : i === n ? 'end' : 'middle' }, i === 0 ? 'Start' : String(i)));
    }

    // Where the client payment lands in this order.
    const inc = rows.findIndex((r) => r.incoming);
    if (inc >= 0) {
      const ix = x(inc + 1);
      svg.append(sv('line', { x1: ix, x2: ix, y1: pad.t - 4, y2: H - pad.b, stroke: 'var(--ink-faint)', 'stroke-dasharray': '2 3', 'stroke-width': 1 }));
      const right = ix < W * 0.6;
      svg.append(sv('text', { x: ix + (right ? 5 : -5), y: pad.t - 10, 'text-anchor': right ? 'start' : 'end' }, 'Client payment in'));
    }

    const path = (vals) => vals.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join('');
    if (changed) svg.append(sv('path', { d: path(sheet), fill: 'none', stroke: 'var(--ref)', 'stroke-width': 2, 'stroke-dasharray': '5 4', 'stroke-linejoin': 'round' }));
    svg.append(sv('path', { d: path(mine), fill: 'none', stroke: 'var(--blue)', 'stroke-width': 2, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }));

    // Label the lowest point (the number that decides whether the order works).
    const li = s.lowAt + 1, lx = x(li), ly = y(mine[li]);
    svg.append(sv('circle', { cx: lx, cy: ly, r: 4.5, fill: 'var(--blue)', stroke: '#fff', 'stroke-width': 2 }));
    const lowRight = lx < W * 0.6, below = ly < H - pad.b - 22;
    svg.append(sv('text', { class: 'lbl', x: lx + (lowRight ? 8 : -8), y: below ? ly + 16 : ly - 10, 'text-anchor': lowRight ? 'start' : 'end' }, `Lowest ${money(mine[li])}`));

    // Hover/tap layer: crosshair, dots on both lines, tooltip.
    const hover = sv('g', { visibility: 'hidden' });
    const cross = sv('line', { y1: pad.t, y2: H - pad.b, stroke: 'var(--ink-dim)', 'stroke-width': 1 });
    const dotRef = sv('circle', { r: 4, fill: 'var(--ref)', stroke: '#fff', 'stroke-width': 2 });
    const dotMine = sv('circle', { r: 4.5, fill: 'var(--blue)', stroke: '#fff', 'stroke-width': 2 });
    hover.append(cross);
    if (changed) hover.append(dotRef);
    hover.append(dotMine);
    svg.append(hover);
    const hit = sv('rect', { x: pad.l - 10, y: 0, width: W - pad.l - pad.r + 20, height: H, fill: 'transparent' });
    svg.append(hit);

    const tip = $('tip');
    const show = (evt) => {
      const r = svg.getBoundingClientRect();
      const px = ((evt.clientX - r.left) / r.width) * W;
      const i = Math.max(0, Math.min(n, Math.round(((px - pad.l) / (W - pad.l - pad.r)) * n)));
      hover.setAttribute('visibility', 'visible');
      cross.setAttribute('x1', x(i)); cross.setAttribute('x2', x(i));
      dotMine.setAttribute('cx', x(i)); dotMine.setAttribute('cy', y(mine[i]));
      dotRef.setAttribute('cx', x(i)); dotRef.setAttribute('cy', y(sheet[i]));
      const title = i === 0 ? 'Start' : `Step ${i} · ${rows[i - 1].vendor}`;
      const lines = [[changed ? 'This order' : 'Balance', money(mine[i])]];
      if (i > 0) lines.unshift([rows[i - 1].amount < 0 ? 'Payment' : 'Money in', money(rows[i - 1].amount)]);
      if (changed) lines.push(['Sheet order', money(sheet[i])]);
      tip.replaceChildren(el('div', 't', title), ...lines.map(([k, v]) => { const d = el('div', 'r'); d.append(el('span', '', k), el('span', '', v)); return d; }));
      tip.style.display = 'block';
      const scale = r.width / W, tx = x(i) * scale, tw = tip.offsetWidth;
      tip.style.left = `${Math.max(0, Math.min(r.width - tw, tx - tw / 2))}px`;
      // Above the higher dot; below the lower one if there's no room above.
      const vals = changed ? [mine[i], sheet[i]] : [mine[i]];
      const above = y(Math.max(...vals)) * scale - tip.offsetHeight - 12;
      tip.style.top = `${above >= 0 ? above : y(Math.min(...vals)) * scale + 12}px`;
      if (hoverStep !== i) { hoverStep = i; markHot(); }
    };
    const hide = () => { hover.setAttribute('visibility', 'hidden'); tip.style.display = 'none'; if (hoverStep !== null) { hoverStep = null; markHot(); } };
    hit.addEventListener('pointermove', show);
    hit.addEventListener('pointerdown', show);
    hit.addEventListener('pointerleave', hide);

    box.querySelector('svg')?.remove();
    box.prepend(svg);

    $('legend-ref').hidden = !changed;
    const note = $('chart-note');
    if (!changed) note.textContent = 'Move a payment to compare a new order with the sheet’s (dashed line).';
    else if (sameDollars(s.lowest, ref.lowest)) note.textContent = 'This order reaches the same low point as the sheet order.';
    else {
      const d = s.lowest - ref.lowest;
      note.textContent = `This order’s lowest balance is ${money(Math.abs(d)).replace(/[()]/g, '')} ${d > 0 ? 'higher' : 'lower'} than the sheet order’s.`;
    }
  }

  // Outline the list row the chart is pointing at.
  function markHot() {
    [...$('list').children].forEach((li, k) => li.classList.toggle('hot', hoverStep === k + 1));
  }

  function move(pos, dir) {
    const to = pos + dir;
    if (to < 0 || to >= order.length) return;
    [order[pos], order[to]] = [order[to], order[pos]];
    flashIdx = order[to];
    store.set(keyFor(base), isIdentity(order) ? null : order);
    render();
    const li = $('list').children[to];
    if (li && li.scrollIntoView) li.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }

  function adopt(data) {
    base = data;
    order = data.rows.map((_, i) => i);
    // Keep the scenario across a reload, but only while the sheet is exactly as it was.
    const saved = store.get(keyFor(data));
    if (Array.isArray(saved) && saved.length === order.length && [...saved].sort((a, b) => a - b).every((v, i) => v === i)) order = saved;
    lastLoad = Date.now();
    flashIdx = null;
    if (data.demo) $('banner').innerHTML = '<b>Demo data.</b> Sample rows, not the real sheet.';
    $('loading').hidden = true;
    $('content').hidden = false;
    $('updated').textContent = `Sheet read ${timeNow()}`;
    render();
  }

  async function load() {
    setStatus('', 'Loading…');
    try {
      const res = await fetch('/api/data', { credentials: 'same-origin' });
      if (res.status === 401) { location.href = '/'; return; }
      let body = {};
      try { body = await res.json(); } catch {}
      if (!res.ok) throw new Error(body.error || 'Could not load the sheet.');
      adopt(body);
    } catch (e) {
      setStatus('error', 'Not loaded');
      errorBanner(e.message);
      $('loading').textContent = 'Could not load the sheet. Tap “Reload from sheet” to try again.';
    }
  }

  $('reset').onclick = () => { order = base.rows.map((_, i) => i); flashIdx = null; store.set(keyFor(base), null); render(); };
  $('refresh').onclick = () => load();
  // Back on the phone after a while: pick up edits made in the sheet (a scenario survives if the sheet didn't change).
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && base && Date.now() - lastLoad > 60000) load();
  });
  let rt, lastW = 0;
  new ResizeObserver(() => {
    const w = $('chart').clientWidth;
    if (w === lastW) return; // the chart's own height change shouldn't trigger a redraw
    lastW = w;
    clearTimeout(rt);
    rt = setTimeout(() => base && render(), 80);
  }).observe($('chart'));

  load();
})();
