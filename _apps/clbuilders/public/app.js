// Payment waterfall page. Served only to signed-in visitors; all data comes from /api/data.
(() => {
  const $ = (id) => document.getElementById(id);
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
  const fmt = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0, minimumFractionDigits: 0 });
  const money = (n) => (n < 0 ? `(${fmt.format(-n)})` : fmt.format(n));

  // base: the sheet as last read (rows in sheet order). order: indexes into base.rows in the order shown.
  let base = null, order = [], saving = false, dirty = false, lastLoad = 0, flashIdx = null;

  function setStatus(kind, text) {
    const s = $('status');
    s.className = `status ${kind || ''}`;
    s.textContent = text;
    s.onclick = kind === 'error' ? () => flush() : null;
    s.style.cursor = kind === 'error' ? 'pointer' : '';
  }
  function banner(kind, text) {
    const b = $('banner');
    b.hidden = !text;
    b.className = `banner ${kind}`;
    b.textContent = text || '';
  }
  const isIdentity = (o) => o.every((v, i) => v === i);
  const timeNow = () => new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

  function summarize(start, amounts) {
    let bal = start, lowest = amounts.length ? Infinity : start, owed = 0, cashIn = 0;
    const running = amounts.map((a) => { if (a < 0) owed -= a; else cashIn += a; bal += a; lowest = Math.min(lowest, bal); return bal; });
    return { running, owed, cashIn, ending: bal, lowest, shortfall: lowest < 0 ? -lowest : 0, ok: lowest >= 0 };
  }

  function tile(label, value, note, cls = '', valueCls = '') {
    const t = el('div', `tile ${cls}`);
    t.append(el('div', 'l', label), el('div', `v ${valueCls}`, value));
    if (note) t.append(el('div', 'n', note));
    return t;
  }

  function render() {
    const { inputs } = base;
    const rows = order.map((i) => base.rows[i]);
    const s = summarize(inputs.startingBalance, rows.map((r) => r.amount));

    const tiles = $('tiles');
    tiles.replaceChildren(
      tile('Status', s.ok ? 'OK' : 'SHORT',
        s.ok ? 'The balance never goes negative in this order.' : `The balance goes negative at step ${s.running.findIndex((b) => b < 0) + 1}.`,
        `state ${s.ok ? 'ok' : 'short'}`),
      tile('Starting balance', money(inputs.startingBalance), 'Bank balance now'),
      tile('Incoming payment', money(inputs.incomingAmount), inputs.incomingDate ? `Expected ${inputs.incomingDate}` : 'No date set', '', 'pos'),
      tile('Total owed', money(s.owed), `${rows.filter((r) => r.amount < 0).length} payments`),
      tile('Ending balance', money(s.ending), 'After every row', '', s.ending < 0 ? 'neg' : ''),
      tile('Lowest balance', money(s.lowest), 'Lowest point in the order', '', s.lowest < 0 ? 'neg' : ''),
      tile('Shortfall', money(s.shortfall), 'Cash needed to cover', '', s.shortfall > 0 ? 'neg' : '')
    );

    const list = $('list');
    list.replaceChildren(...rows.map((r, pos) => {
      const li = el('li', 'item');
      const bal = s.running[pos];
      if (r.incoming || r.amount > 0) li.classList.add('in');
      else if (bal < 0) li.classList.add('short');
      if (order[pos] === flashIdx) li.classList.add('flash');

      const body = el('div', 'body');
      body.append(el('div', 'vendor', r.vendor || '(no vendor)'));
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
    $('updated').textContent = `Sheet read ${timeNow()}`;
  }

  function move(pos, dir) {
    const to = pos + dir;
    if (to < 0 || to >= order.length) return;
    [order[pos], order[to]] = [order[to], order[pos]];
    flashIdx = order[to];
    render();
    const li = $('list').children[to];
    if (li && li.scrollIntoView) li.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    flush();
  }

  function adopt(data) {
    base = data;
    order = data.rows.map((_, i) => i);
    lastLoad = Date.now();
    if (data.readOnly) banner('info', 'Test mode: the sheet is read-only, so moves are not saved.');
    else if (data.demo) banner('info', 'Demo data: nothing here is real and nothing is saved to Google.');
    else banner('', '');
    $('loading').hidden = true;
    $('content').hidden = false;
    render();
  }

  async function api(path, opts) {
    const res = await fetch(path, { credentials: 'same-origin', ...opts });
    if (res.status === 401) { location.href = '/'; throw new Error('signed out'); }
    let body = {};
    try { body = await res.json(); } catch {}
    return { status: res.status, body };
  }

  async function load() {
    setStatus('saving', 'Loading…');
    try {
      const { status, body } = await api('/api/data');
      if (status !== 200) throw new Error(body.error || 'Could not load the sheet.');
      adopt(body);
      setStatus('', 'Up to date');
    } catch (e) {
      if (e.message === 'signed out') return;
      setStatus('error', 'Not loaded');
      banner('err', e.message);
      $('loading').textContent = 'Could not load the sheet. Tap “Reload from sheet” to try again.';
    }
  }

  // Saves the current order. Moves made while a save is running are sent right after it finishes.
  async function flush() {
    if (saving) { dirty = true; return; }
    saving = true;
    try {
      do {
        dirty = false;
        if (isIdentity(order)) { setStatus('saved', `Saved ${timeNow()}`); break; }
        const sent = order.slice();
        setStatus('saving', 'Saving…');
        const { status, body } = await api('/api/order', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ version: base.version, order: sent }),
        });
        if (status === 409) {
          flashIdx = null;
          adopt(body.data);
          banner('err', 'The sheet was changed by someone else since this page loaded, so your last move was not saved. Showing the latest order from the sheet.');
          setStatus('error', 'Reloaded');
          dirty = false;
          break;
        }
        if (status !== 200) throw new Error(body.error || 'Save failed.');
        if (body.dryRun) { setStatus('dry', 'Test mode: not saved'); continue; }

        // Saved. The sheet's rows are now in `sent` order; re-express any newer local moves against it.
        const newPos = new Map(sent.map((oldIdx, k) => [oldIdx, k]));
        const pending = order.map((i) => newPos.get(i));
        base = body.data;
        lastLoad = Date.now();
        order = pending.length === base.rows.length ? pending : base.rows.map((_, i) => i);
        if (flashIdx != null) flashIdx = newPos.get(flashIdx) ?? null;
        render();
        setStatus('saved', `Saved ${timeNow()}`);
      } while (dirty);
    } catch (e) {
      if (e.message !== 'signed out') {
        setStatus('error', 'Not saved – tap to retry');
        banner('err', `${e.message} Your order is still on screen; tap the red “Not saved” label to try again.`);
      }
    } finally {
      saving = false;
    }
  }

  $('refresh').onclick = () => {
    if (saving) return;
    if (base && !isIdentity(order) && !base.readOnly && !confirm('You have a move that is not saved yet. Reload anyway?')) return;
    flashIdx = null;
    load();
  };
  // Back on the phone after a while: pick up edits made in the sheet, unless a move is waiting to save.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && !saving && base && isIdentity(order) && Date.now() - lastLoad > 60000) load();
  });
  window.addEventListener('beforeunload', (e) => { if (saving) { e.preventDefault(); e.returnValue = ''; } });

  load();
})();
