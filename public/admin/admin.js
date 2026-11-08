(() => {
  const $ = (sel, el = document) => el.querySelector(sel);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const money = (n) => `${n} ₪`;
  const timeOf = (ts) => new Date(ts).toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Jerusalem' });

  const ACTIVE = ['new', 'preparing', 'ready'];
  const NEXT = {
    new: { to: 'preparing', label: 'התחלת הכנה ▶' },
    preparing: { to: 'ready', label: 'מוכן ✓' },
    ready: { to: 'picked_up', label: 'נאסף ושולם 💰' },
  };
  const PREV = { preparing: 'new', ready: 'preparing' };
  const STATUS_LABEL = { new: 'חדשה', preparing: 'בהכנה', ready: 'מוכנה', picked_up: 'נאספה', cancelled: 'בוטלה' };

  let token = localStorage.getItem('sc_admin_token');
  let soundOn = localStorage.getItem('sc_admin_sound') !== 'off';
  let orders = new Map();
  let menu = null;
  let tab = 'board';
  let es = null;
  let audioCtx = null;
  let wakeLock = null;
  const fresh = new Set();

  // ---------- utils ----------
  let toastTimer;
  function toast(msg) {
    const t = $('#toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('show'), 2500);
  }

  async function api(path, opts = {}) {
    const res = await fetch(path, {
      ...opts,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, ...(opts.headers || {}) },
    });
    if (res.status === 401) { logout(); throw new Error('unauthorized'); }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'שגיאה');
    return data;
  }

  function chime() {
    if (!soundOn || !audioCtx) return;
    const now = audioCtx.currentTime;
    [[880, 0], [1175, 0.16], [1568, 0.32]].forEach(([freq, at]) => {
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.type = 'sine';
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.0001, now + at);
      gain.gain.exponentialRampToValueAtTime(0.5, now + at + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + at + 0.45);
      osc.connect(gain).connect(audioCtx.destination);
      osc.start(now + at);
      osc.stop(now + at + 0.5);
    });
  }

  async function keepAwake() {
    try {
      if ('wakeLock' in navigator && document.visibilityState === 'visible') wakeLock = await navigator.wakeLock.request('screen');
    } catch { /* not supported or denied */ }
  }

  // ---------- views ----------
  function show(view) {
    for (const id of ['loginView', 'startView', 'app']) $(`#${id}`).classList.toggle('hidden', id !== view);
  }

  function logout() {
    token = null;
    localStorage.removeItem('sc_admin_token');
    if (es) { es.close(); es = null; }
    show('loginView');
  }

  // ---------- data ----------
  async function loadOrders({ notify } = { notify: false }) {
    const data = await api('/api/admin/orders');
    const before = new Set(orders.keys());
    orders = new Map(data.orders.map((o) => [o.id, o]));
    if (notify) {
      const added = data.orders.filter((o) => !before.has(o.id) && o.status === 'new');
      if (added.length) {
        added.forEach((o) => { fresh.add(o.id); setTimeout(() => fresh.delete(o.id), 4000); });
        chime();
      }
    }
    render();
  }

  function connect() {
    if (es) es.close();
    es = new EventSource(`/api/admin/stream?token=${encodeURIComponent(token)}`);
    let first = true;
    es.addEventListener('hello', () => {
      $('#conn').classList.add('on');
      loadOrders({ notify: !first }).catch(() => {});
      first = false;
    });
    es.addEventListener('order', (ev) => {
      const o = JSON.parse(ev.data);
      const isNew = !orders.has(o.id);
      orders.set(o.id, o);
      if (isNew && o.status === 'new') {
        fresh.add(o.id);
        chime();
        toast(`הזמנה חדשה #${o.number} · ${o.name}`);
        setTimeout(() => { fresh.delete(o.id); }, 4000);
      }
      render();
    });
    es.addEventListener('menu', (ev) => { menu.menu = JSON.parse(ev.data); if (tab === 'menu') renderMenu(); });
    es.addEventListener('reset', () => { orders.clear(); render(); toast('יום חדש התחיל 🌅'); });
    es.onerror = () => {
      $('#conn').classList.remove('on');
      fetch('/api/admin/orders', { headers: { Authorization: `Bearer ${token}` } })
        .then((r) => { if (r.status === 401) logout(); })
        .catch(() => {});
    };
  }

  async function setStatus(id, status) {
    const o = orders.get(id);
    const prev = o.status;
    o.status = status;
    render();
    try {
      orders.set(id, await api(`/api/admin/orders/${id}`, { method: 'PATCH', body: JSON.stringify({ status }) }));
    } catch (e) {
      o.status = prev;
      toast(e.message);
    }
    render();
  }

  async function toggleItem(id, idx) {
    const o = orders.get(id);
    const item = o.items[idx];
    item.done = !item.done;
    render();
    try {
      orders.set(id, await api(`/api/admin/orders/${id}/items/${idx}`, { method: 'PATCH', body: JSON.stringify({ done: item.done }) }));
    } catch (e) {
      item.done = !item.done;
      toast(e.message);
    }
    render();
  }

  // ---------- render: board ----------
  function itemHtml(i) {
    if (i.type === 'drink') return `${esc(i.drink.name)}`;
    const head = [i.bread.name, i.filling ? i.filling.name : 'בלי מילוי'].map(esc).join(' · ');
    const spreads = i.spreads.length ? i.spreads.map((s) => esc(s.name)).join(', ') : 'בלי ממרחים';
    return `🥪 <b>${head}</b><small>${spreads}</small>`;
  }

  function etaInfo(o) {
    const now = Date.now();
    const minsLeft = Math.ceil((o.arriveAt - now) / 60000);
    const span = Math.max(1, o.arriveAt - o.createdAt);
    const pct = Math.min(100, Math.max(0, ((now - o.createdAt) / span) * 100));
    let urgency = 'ok';
    let text;
    if (o.status === 'ready') {
      text = minsLeft > 0 ? `מוכן · הלקוח מגיע בעוד ${minsLeft} דק'` : 'מוכן · ממתין לאיסוף';
    } else if (minsLeft > 10) {
      text = `מגיע בעוד ${minsLeft} דק'`;
    } else if (minsLeft > 3) {
      urgency = 'warn'; text = `מגיע בעוד ${minsLeft} דק'`;
    } else if (minsLeft > 0) {
      urgency = 'bad'; text = `מגיע בעוד ${minsLeft} דק'!`;
    } else {
      urgency = 'bad'; text = minsLeft === 0 ? 'הלקוח אמור להגיע עכשיו!' : `הלקוח אמור להיות כאן (לפני ${-minsLeft} דק')`;
    }
    return { urgency, text, pct, late: minsLeft <= 0 && o.status !== 'ready' };
  }

  function cardHtml(o) {
    const eta = etaInfo(o);
    const next = NEXT[o.status];
    const doneCount = o.items.filter((i) => i.done).length;
    return `<article class="ocard u-${eta.urgency} ${fresh.has(o.id) ? 'fresh' : ''}" data-id="${o.id}">
      <div class="ohead">
        <span class="onum">#${o.number}</span>
        <span class="oname">${esc(o.name)}</span>
        ${o.push ? '<span class="push-on" title="הלקוח יקבל התראה לטלפון">🔔</span>' : ''}
        <a class="ophone" href="tel:${esc(o.phone)}">📞 ${esc(o.phone)}</a>
      </div>
      <div class="eta">
        <div class="eta-text"><b class="${eta.late ? 'late' : ''}">${eta.text}</b><small>הוזמן ${timeOf(o.createdAt)} · איסוף ${timeOf(o.arriveAt)}</small></div>
        <div class="eta-bar"><i style="width:${eta.pct}%"></i></div>
      </div>
      <ul class="oitems">
        ${o.items.map((i, idx) => `<li class="oitem ${i.done ? 'done' : ''}">
          <button type="button" class="tick" data-tick="${idx}" aria-label="סימון">✓</button>
          <span class="iqty">${i.qty}×</span>
          <div class="idesc">${itemHtml(i)}</div>
        </li>`).join('')}
      </ul>
      ${o.notes ? `<div class="onotes">📝 ${esc(o.notes)}</div>` : ''}
      <div class="ofoot">
        <span class="ototal">${money(o.total)} <small style="font-weight:500;font-size:13px">· ${doneCount}/${o.items.length} פריטים</small></span>
        <button type="button" class="act minor" data-cancel title="ביטול">✕</button>
        ${PREV[o.status] ? `<button type="button" class="act minor" data-back title="שלב אחורה">↩</button>` : ''}
        <button type="button" class="act next" data-next="${next.to}">${next.label}</button>
      </div>
    </article>`;
  }

  const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

  function setCount(el, value) {
    if (el.textContent === String(value)) return;
    el.textContent = value;
    if (reduceMotion) return;
    el.animate([{ transform: 'scale(1)' }, { transform: 'scale(1.45)' }, { transform: 'scale(1)' }], { duration: 400, easing: 'cubic-bezier(.2,1.4,.4,1)' });
  }

  function renderBoard() {
    const before = new Map();
    for (const el of document.querySelectorAll('.ocard')) before.set(el.dataset.id, el.getBoundingClientRect());

    const active = [...orders.values()].filter((o) => ACTIVE.includes(o.status)).sort((a, b) => a.arriveAt - b.arriveAt);
    for (const st of ACTIVE) {
      const list = active.filter((o) => o.status === st);
      setCount($(`#cnt-${st}`), list.length);
      $(`#list-${st}`).innerHTML = list.map(cardHtml).join('') || '<div class="empty">אין כרגע</div>';
    }

    if (reduceMotion) return;
    for (const el of document.querySelectorAll('.ocard')) {
      const prev = before.get(el.dataset.id);
      if (!prev) {
        if (before.size || fresh.has(el.dataset.id)) {
          el.animate([{ opacity: 0, transform: 'translateY(-18px) scale(.96)' }, { opacity: 1, transform: 'none' }], { duration: 420, easing: 'cubic-bezier(.2,.9,.3,1)' });
        }
        continue;
      }
      const now = el.getBoundingClientRect();
      const dx = prev.left - now.left;
      const dy = prev.top - now.top;
      if (Math.abs(dx) < 1 && Math.abs(dy) < 1) continue;
      const moved = Math.abs(dx) > 40;
      el.animate([
        { transform: `translate(${dx}px, ${dy}px)${moved ? ' scale(.96) rotate(-1.5deg)' : ''}`, boxShadow: moved ? '0 20px 40px rgba(60,20,80,.3)' : 'none' },
        { transform: 'none', boxShadow: '0 4px 14px rgba(60,20,80,.12)' },
      ], { duration: moved ? 560 : 320, easing: 'cubic-bezier(.2,.9,.3,1)' });
    }
  }

  async function animateOut(card) {
    if (reduceMotion || !card) return;
    await card.animate([
      { opacity: 1, transform: 'none' },
      { opacity: 0, transform: 'translateX(-40px) scale(.9)' },
    ], { duration: 280, easing: 'ease-in', fill: 'forwards' }).finished;
  }

  function renderDone() {
    const done = [...orders.values()].filter((o) => !ACTIVE.includes(o.status)).sort((a, b) => b.updatedAt - a.updatedAt);
    $('#doneList').innerHTML = done.map((o) => `<div class="drow" data-id="${o.id}">
      <span class="onum">#${o.number}</span>
      <div class="ddesc"><b>${esc(o.name)}</b> · ${money(o.total)}<br><small>${o.items.map((i) => `${i.qty}× ${i.type === 'drink' ? esc(i.drink.name) : esc(i.bread.name) + (i.filling ? ' · ' + esc(i.filling.name) : '')}`).join(' | ')}</small></div>
      <span class="tag ${o.status}">${STATUS_LABEL[o.status]} ${timeOf(o.updatedAt)}</span>
      <button type="button" class="act minor" data-restore>↩ החזרה</button>
    </div>`).join('') || '<div class="empty">עוד אין הזמנות שהושלמו היום</div>';
  }

  // ---------- render: menu ----------
  function renderMenu() {
    if (!menu) return;
    const m = menu.menu;
    const group = (cat, title, withPrice) => `<div class="mgroup glass"><h3>${title}</h3><div class="mitems">
      ${m[cat].map((x) => `<div class="mitem ${x.available ? '' : 'off'}">
        <img src="${esc(x.img)}" alt="" />
        <span class="mname">${esc(x.name)}</span>
        ${withPrice ? `<input class="price-input" type="number" min="0" step="0.5" value="${x.price}" data-price-cat="${cat}" data-id="${esc(x.id)}" aria-label="מחיר" />` : ''}
        <label class="switch" title="זמין"><input type="checkbox" ${x.available ? 'checked' : ''} data-avail-cat="${cat}" data-id="${esc(x.id)}" /><span></span></label>
      </div>`).join('')}
    </div></div>`;
    $('#menuEditor').innerHTML = `
      <div class="mgroup glass"><h3>💰 מחיר סנדוויץ' <input class="price-input" type="number" min="0" step="0.5" value="${m.prices.sandwich}" id="sandwichPrice" aria-label="מחיר סנדוויץ'" /> ₪</h3>
        <div style="color:var(--ink-soft)">כולל לחם, ממרחים ומילוי. כיבוי מתג = הפריט מסומן "אזל" אצל הלקוחות.</div></div>
      ${group('breads', '🍞 לחמים')}
      ${group('spreads', '🥫 ממרחים')}
      ${group('fillings', '🍳 מילויים')}
      ${group('drinks', '🥤 שתייה', true)}`;
  }

  async function saveMenu(patch) {
    try {
      menu.menu = await api('/api/admin/menu', { method: 'PUT', body: JSON.stringify(patch) });
      toast('נשמר ✓');
    } catch (e) {
      toast(e.message);
    }
    renderMenu();
  }

  // ---------- render: summary ----------
  function renderSummary() {
    const all = [...orders.values()];
    const valid = all.filter((o) => o.status !== 'cancelled');
    const collected = all.filter((o) => o.status === 'picked_up').reduce((s, o) => s + o.total, 0);
    const expected = valid.reduce((s, o) => s + o.total, 0);
    const counts = { breads: {}, spreads: {}, fillings: {}, drinks: {} };
    let sandwiches = 0;
    for (const o of valid) {
      for (const i of o.items) {
        if (i.type === 'drink') { counts.drinks[i.drink.name] = (counts.drinks[i.drink.name] || 0) + i.qty; continue; }
        sandwiches += i.qty;
        counts.breads[i.bread.name] = (counts.breads[i.bread.name] || 0) + i.qty;
        const f = i.filling ? i.filling.name : 'בלי מילוי';
        counts.fillings[f] = (counts.fillings[f] || 0) + i.qty;
        for (const s of i.spreads) counts.spreads[s.name] = (counts.spreads[s.name] || 0) + i.qty;
      }
    }
    const bd = (title, obj) => {
      const rows = Object.entries(obj).sort((a, b) => b[1] - a[1]);
      const max = Math.max(1, ...rows.map((r) => r[1]));
      return `<div class="bd glass"><h3>${title}</h3>${rows.map(([l, n]) => `<div class="bd-row"><span class="l">${esc(l)}</span><span class="bar"><i style="width:${(n / max) * 100}%"></i></span><span class="n">${n}</span></div>`).join('') || '<div class="empty">—</div>'}</div>`;
    };
    $('#summary').innerHTML = `
      <div class="stats">
        <div class="stat glass"><b>${valid.length}</b><span>הזמנות היום</span></div>
        <div class="stat glass"><b>${sandwiches}</b><span>סנדוויצ'ים</span></div>
        <div class="stat glass"><b>${money(collected)}</b><span>נגבה (נאספו)</span></div>
        <div class="stat glass"><b>${money(expected)}</b><span>סה"כ צפוי</span></div>
        <div class="stat glass"><b>${all.length - valid.length}</b><span>בוטלו</span></div>
      </div>
      <div class="breakdowns">
        ${bd('🍞 לחמים', counts.breads)}
        ${bd('🍳 מילויים', counts.fillings)}
        ${bd('🥫 ממרחים', counts.spreads)}
        ${bd('🥤 שתייה', counts.drinks)}
      </div>`;
  }

  function render() {
    const all = [...orders.values()];
    const activeCount = all.filter((o) => ACTIVE.includes(o.status)).length;
    const newCount = all.filter((o) => o.status === 'new').length;
    setCount($('#activeCount'), activeCount);
    setCount($('#doneCount'), all.length - activeCount);
    document.title = newCount ? `(${newCount}) הזמנות חדשות` : 'ניהול הזמנות';
    if (tab === 'board') renderBoard();
    if (tab === 'done') renderDone();
    if (tab === 'summary') renderSummary();
  }

  function setTab(name) {
    tab = name;
    for (const b of document.querySelectorAll('.tab')) b.classList.toggle('active', b.dataset.tab === name);
    for (const p of document.querySelectorAll('.tab-panel')) p.classList.toggle('hidden', p.id !== `tab-${name}`);
    if (name === 'menu') renderMenu();
    render();
  }

  // ---------- events ----------
  function bindEvents() {
    $('#loginForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const err = $('#loginError');
      err.classList.add('hidden');
      try {
        const res = await fetch('/api/admin/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ password: $('#password').value }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'שגיאה');
        token = data.token;
        localStorage.setItem('sc_admin_token', token);
        $('#password').value = '';
        start();
      } catch (ex) {
        err.textContent = ex.message;
        err.classList.remove('hidden');
      }
    });

    $('#startBtn').addEventListener('click', start);

    $('#tabs').addEventListener('click', (e) => {
      const b = e.target.closest('[data-tab]');
      if (b) setTab(b.dataset.tab);
    });

    $('#soundBtn').addEventListener('click', () => {
      soundOn = !soundOn;
      localStorage.setItem('sc_admin_sound', soundOn ? 'on' : 'off');
      $('#soundBtn').classList.toggle('off', !soundOn);
      $('#soundBtn').textContent = soundOn ? '🔔' : '🔕';
      if (soundOn) chime();
    });

    $('#logoutBtn').addEventListener('click', () => { if (confirm('לצאת מממשק הניהול?')) logout(); });

    $('#tab-board').addEventListener('click', (e) => {
      const card = e.target.closest('.ocard');
      if (!card) return;
      const id = card.dataset.id;
      const o = orders.get(id);
      const tick = e.target.closest('[data-tick]');
      if (tick) return toggleItem(id, Number(tick.dataset.tick));
      const next = e.target.closest('[data-next]');
      if (next) {
        if (next.dataset.next === 'picked_up') return animateOut(card).then(() => setStatus(id, 'picked_up'));
        return setStatus(id, next.dataset.next);
      }
      if (e.target.closest('[data-back]')) return setStatus(id, PREV[o.status]);
      if (e.target.closest('[data-cancel]') && confirm(`לבטל את הזמנה #${o.number} של ${o.name}?`)) {
        animateOut(card).then(() => setStatus(id, 'cancelled'));
      }
    });

    $('#doneList').addEventListener('click', (e) => {
      const row = e.target.closest('[data-restore]') && e.target.closest('.drow');
      if (row) setStatus(row.dataset.id, 'ready');
    });

    $('#menuEditor').addEventListener('change', (e) => {
      const t = e.target;
      if (t.id === 'sandwichPrice') return saveMenu({ prices: { sandwich: Number(t.value) } });
      if (t.dataset.availCat) return saveMenu({ [t.dataset.availCat]: [{ id: t.dataset.id, available: t.checked }] });
      if (t.dataset.priceCat) return saveMenu({ [t.dataset.priceCat]: [{ id: t.dataset.id, price: Number(t.value) }] });
    });

    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && token && !$('#app').classList.contains('hidden')) {
        keepAwake();
        loadOrders({ notify: true }).catch(() => {});
      }
    });
  }

  async function start() {
    try {
      audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
      await audioCtx.resume();
    } catch { /* audio unavailable */ }
    keepAwake();
    show('app');
    $('#soundBtn').classList.toggle('off', !soundOn);
    $('#soundBtn').textContent = soundOn ? '🔔' : '🔕';
    try {
      menu = await (await fetch('/api/menu')).json();
      $('#shopName').textContent = menu.shopName;
      await loadOrders();
    } catch { /* handled by api() */ }
    if (token) connect();
  }

  function tickClock() {
    $('#clock').textContent = new Date().toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Jerusalem' });
  }

  bindEvents();
  tickClock();
  setInterval(tickClock, 10000);
  setInterval(() => { if (tab === 'board') renderBoard(); }, 20000);
  show(token ? 'startView' : 'loginView');
})();
