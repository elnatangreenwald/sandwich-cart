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

  // Bell partials: [frequency ratio, level, decay seconds].
  const BELL = [[1, 1, 1.4], [2, 0.55, 0.9], [3, 0.3, 0.6], [4.16, 0.28, 0.45], [5.43, 0.16, 0.3], [6.8, 0.08, 0.2]];
  const ALERT = [[1318.5, 0], [987.8, 0.2], [1318.5, 0.4], [1318.5, 1.25], [987.8, 1.45], [1318.5, 1.65]];
  let alertOut = null;

  function alertBus() {
    if (alertOut) return alertOut;
    const comp = audioCtx.createDynamicsCompressor();
    comp.threshold.value = -18;
    comp.knee.value = 6;
    comp.ratio.value = 10;
    comp.attack.value = 0.002;
    comp.release.value = 0.25;
    const master = audioCtx.createGain();
    master.gain.value = 1.4;
    comp.connect(master).connect(audioCtx.destination);
    alertOut = comp;
    return alertOut;
  }

  function strike(freq, at, out) {
    for (const [ratio, level, decay] of BELL) {
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.type = ratio === 1 ? 'triangle' : 'sine';
      osc.frequency.value = freq * ratio;
      gain.gain.setValueAtTime(0.0001, at);
      gain.gain.exponentialRampToValueAtTime(level * 0.6, at + 0.004);
      gain.gain.exponentialRampToValueAtTime(0.0001, at + decay);
      osc.connect(gain).connect(out);
      osc.start(at);
      osc.stop(at + decay + 0.05);
    }
  }

  function chime() {
    if (!soundOn || !audioCtx) return;
    if (audioCtx.state === 'suspended') audioCtx.resume();
    const out = alertBus();
    const now = audioCtx.currentTime + 0.02;
    for (const [freq, at] of ALERT) strike(freq, now + at, out);
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
    if (i.type === 'drink') return `🥤 ${esc(i.drink.name)}`;
    if (i.type === 'food') {
      const lines = (i.groups || []).map((g) => {
        if (!g.items.length) return '';
        const names = g.items.map((x) => `${esc(x.name)}${x.charged ? ` <bdi dir="ltr">+${x.charged}</bdi>` : ''}`).join(', ');
        return `<small>${esc(g.name)}: ${names}</small>`;
      }).join('');
      return `${i.product.emoji || '🍽️'} <b>${esc(i.product.name)}</b>${lines}`;
    }
    const head = [i.bread.name, i.filling ? i.filling.name : 'בלי מילוי'].map(esc).join(' · ');
    const spreads = i.spreads.length ? i.spreads.map((s) => esc(s.name)).join(', ') : 'בלי ממרחים';
    const veg = (i.vegetables || []).length ? `🥗 ${i.vegetables.map((v) => esc(v.name)).join(', ')}` : 'בלי ירקות';
    const extras = (i.extras || []).length ? `<small class="iextras">➕ ${i.extras.map((x) => esc(x.name)).join(', ')}</small>` : '';
    return `🥪 <b>${head}</b><small>${spreads}</small><small>${veg}</small>${extras}`;
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

  function discountHtml(o) {
    const d = o.discounts;
    if (!d || (!d.combo && !d.reward)) return '';
    return `<div class="odisc">
      ${d.reward ? `<span class="reward">🎁 מנה חינם (כרטיסייה) <bdi dir="ltr">−${money(d.reward)}</bdi></span>` : ''}
      ${d.combo ? `<span>🔥 קומבו <bdi dir="ltr">−${money(d.combo)}</bdi></span>` : ''}
    </div>`;
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
      ${discountHtml(o)}
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
      <div class="ddesc"><b>${esc(o.name)}</b> · ${money(o.total)}<br><small>${o.items.map((i) => `${i.qty}× ${i.type === 'drink' ? esc(i.drink.name) : esc(i.type === 'food' ? i.product.name : i.bread.name)}`).join(' | ')}</small></div>
      <span class="tag ${o.status}">${STATUS_LABEL[o.status]} ${timeOf(o.updatedAt)}</span>
      <button type="button" class="act minor" data-restore>↩ החזרה</button>
    </div>`).join('') || '<div class="empty">עוד אין הזמנות שהושלמו היום</div>';
  }

  // ---------- render: menu ----------
  function renderMenu() {
    if (!menu) return;
    const m = menu.menu;
    const group = (cat, title, items, withPrice, extraNote = '') => `<div class="mgroup glass" data-cat="${cat}"><h3>${title} <span class="mcount">${items.length}</span></h3>
      ${extraNote}
      <div class="mitems">
      ${items.map((x) => `<div class="mitem ${x.available ? '' : 'off'}" data-id="${esc(x.id)}">
        <button type="button" class="mimg" data-upload title="החלפת תמונה"><img src="${esc(x.img)}" alt="" /><span class="cam">📷</span></button>
        <input class="mname-input" value="${esc(x.name)}" maxlength="40" data-field="name" aria-label="שם" />
        ${withPrice ? `<input class="price-input" type="number" min="0" step="0.5" value="${x.price}" data-field="price" aria-label="מחיר" />` : ''}
        <label class="switch" title="זמין / אזל"><input type="checkbox" ${x.available ? 'checked' : ''} data-field="available" /><span></span></label>
        <button type="button" class="mdel" data-delete title="מחיקה">🗑</button>
      </div>`).join('')}
      <form class="madd" data-add="${cat}">
        <input name="name" placeholder="+ פריט חדש" maxlength="40" required />
        ${withPrice ? '<input name="price" class="price-input" type="number" min="0" step="0.5" placeholder="₪" required />' : ''}
        <button type="submit" class="act next">הוספה</button>
      </form>
    </div></div>`;
    const promos = m.promos || { comboDiscount: 0, loyaltyGoal: 0 };
    const productBlocks = (m.products || []).map((p) => p.groups.map((g) => {
      const note = g.extraPrice > 0
        ? `<div class="setting"><span class="s-ico">➕</span><div><b>מחיר תוספת</b><small>${g.max ? `עד ${g.max}` : 'בלי הגבלה'}</small></div><label class="s-input"><input class="price-input" type="number" min="0" step="0.5" value="${g.extraPrice}" data-group-extra="${esc(p.id)}__${esc(g.id)}" aria-label="מחיר תוספת" /> ₪</label></div>`
        : '';
      return group(`${p.id}__${g.id}`, `${p.emoji || ''} ${esc(p.name)} · ${esc(g.name)}`, g.items, Boolean(g.pricedBase), note);
    }).join('')).join('');
    const drinkBlocks = (m.drinkGroups || []).map((g) => {
      const block = group('drinks', `🥤 ${esc(g.name)}`, (m.drinks || []).filter((d) => d.group === g.id), true);
      return block.replace('data-add="drinks"', `data-add="drinks" data-group="${esc(g.id)}"`);
    }).join('');
    $('#menuEditor').innerHTML = `
      <div class="mgroup glass settings">
        ${ (m.products || []).filter((p) => p.price != null).map((p) => `<div class="setting"><span class="s-ico">${p.emoji || '💰'}</span><div><b>מחיר ${esc(p.name)}</b><small>מחיר בסיס, לפני תוספות</small></div><label class="s-input"><input class="price-input" type="number" min="0" step="0.5" value="${p.price}" data-product-price="${esc(p.id)}" aria-label="מחיר ${esc(p.name)}" /> ₪</label></div>`).join('') }
        <div class="setting">
          <span class="s-ico">🔥</span>
          <div><b>הנחת קומבו</b><small>הנחה על כל זוג מנה + שתייה · 0 = כבוי</small></div>
          <label class="s-input"><input class="price-input" type="number" min="0" step="0.5" value="${promos.comboDiscount}" data-promo="comboDiscount" aria-label="הנחת קומבו" /> ₪</label>
        </div>
        <div class="setting">
          <span class="s-ico">🎟️</span>
          <div><b>כרטיסיית ניקובים</b><small>כמה מנות עד מנה חינם · 0 = כבוי</small></div>
          <label class="s-input"><input class="price-input" type="number" min="0" max="50" step="1" value="${promos.loyaltyGoal}" data-promo="loyaltyGoal" aria-label="יעד כרטיסייה" /></label>
        </div>
        <a class="setting link" href="/sign.html" target="_blank" rel="noopener">
          <span class="s-ico">🖨️</span>
          <div><b>שלט QR להדפסה</b><small>שלט A4 ומדבקות קטנות לעגלה</small></div>
          <span class="s-go">פתיחה ←</span>
        </a>
        <div class="mhelp">לחיצה על תמונה מחליפה אותה · עריכת שם נשמרת ביציאה מהשדה · מתג כבוי = "אזל" אצל הלקוחות.</div>
      </div>
      ${productBlocks}
      ${drinkBlocks}`;
  }

  async function menuCall(path, opts, okMsg = 'נשמר ✓') {
    try {
      const data = await api(path, opts);
      menu.menu = data.menu || data;
      toast(okMsg);
      return data;
    } catch (e) {
      toast(e.message);
      return null;
    } finally {
      renderMenu();
    }
  }

  async function squareImage(file) {
    const bmp = await createImageBitmap(file);
    const size = 600;
    const side = Math.min(bmp.width, bmp.height);
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    canvas.getContext('2d').drawImage(bmp, (bmp.width - side) / 2, (bmp.height - side) / 2, side, side, 0, 0, size, size);
    const toBlob = (type, q) => new Promise((r) => canvas.toBlob(r, type, q));
    const webp = await toBlob('image/webp', 0.82);
    return webp && webp.type === 'image/webp' ? webp : toBlob('image/jpeg', 0.85);
  }

  let uploadTarget = null;

  async function uploadImage(file) {
    if (!file || !uploadTarget) return;
    const { cat, id } = uploadTarget;
    uploadTarget = null;
    const tile = document.querySelector(`.mgroup[data-cat="${cat}"] .mitem[data-id="${CSS.escape(id)}"]`);
    if (tile) tile.classList.add('uploading');
    try {
      const blob = await squareImage(file);
      const res = await fetch(`/api/admin/menu/${cat}/${encodeURIComponent(id)}/image`, {
        method: 'POST',
        headers: { 'Content-Type': blob.type, Authorization: `Bearer ${token}` },
        body: blob,
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'העלאה נכשלה');
      menu.menu = data;
      toast('התמונה עודכנה 📷');
    } catch (e) {
      toast(e.message === 'unauthorized' ? 'לא מורשה' : e.message || 'העלאה נכשלה');
    }
    renderMenu();
  }

  // ---------- render: summary ----------
  function renderSummary() {
    const all = [...orders.values()];
    const valid = all.filter((o) => o.status !== 'cancelled');
    const collected = all.filter((o) => o.status === 'picked_up').reduce((s, o) => s + o.total, 0);
    const expected = valid.reduce((s, o) => s + o.total, 0);
    const counts = {};
    const bump = (cat, name, qty) => {
      if (!counts[cat]) counts[cat] = {};
      counts[cat][name] = (counts[cat][name] || 0) + qty;
    };
    let sandwiches = 0;
    for (const o of valid) {
      for (const i of o.items) {
        if (i.type === 'drink') { bump('drinks', i.drink.name, i.qty); continue; }
        sandwiches += i.qty;
        if (i.type === 'food') {
          bump('products', i.product.name, i.qty);
          for (const g of i.groups || []) for (const it of g.items) bump(g.id, it.name, i.qty);
          continue;
        }
        bump('breads', i.bread.name, i.qty);
        bump('fillings', i.filling ? i.filling.name : 'בלי מילוי', i.qty);
        for (const s of i.spreads) bump('spreads', s.name, i.qty);
        for (const v of i.vegetables || []) bump('vegetables', v.name, i.qty);
        for (const x of i.extras || []) bump('extras', x.name, i.qty);
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
        <div class="stat glass"><b>${sandwiches}</b><span>מנות</span></div>
        <div class="stat glass"><b>${money(collected)}</b><span>נגבה (נאספו)</span></div>
        <div class="stat glass"><b>${money(expected)}</b><span>סה"כ צפוי</span></div>
        <div class="stat glass"><b>${all.length - valid.length}</b><span>בוטלו</span></div>
      </div>
      <div class="breakdowns">
        ${bd('🍽️ מנות', counts.products || {})}
        ${bd('🍞 לחמים', counts.breads || {})}
        ${bd('🍳 סוג', counts.fillings || {})}
        ${bd('🥫 ממרחים', counts.spreads || {})}
        ${bd('🥗 ירקות', counts.vegetables || {})}
        ${bd('🫙 רטבים', counts.sauces || {})}
        ${bd('➕ תוספות', counts.addons || {})}
        ${bd('🥤 שתייה', counts.drinks || {})}
      </div>`;
  }

  // ---------- render: reports ----------
  let reportDays = 7;
  let reportData = null;
  const dayLabel = (day) => new Date(`${day}T12:00:00`).toLocaleDateString('he-IL', { weekday: 'short', day: 'numeric', month: 'numeric' });

  async function loadReports() {
    $('#reports').innerHTML = '<div class="empty">טוען דוח…</div>';
    try {
      reportData = await api(`/api/admin/reports?days=${reportDays}`);
      renderReports();
    } catch (e) {
      $('#reports').innerHTML = `<div class="empty">${esc(e.message)}</div>`;
    }
  }

  function renderReports() {
    if (!reportData) return;
    const days = reportData.days;
    const total = (k) => days.reduce((n, d) => n + (d[k] || 0), 0);
    const revenue = total('revenue');
    const orderCount = total('orders');
    const merge = (cat) => {
      const out = {};
      for (const d of days) for (const [name, n] of Object.entries(d.items[cat] || {})) out[name] = (out[name] || 0) + n;
      return out;
    };
    const hours = {};
    for (const d of days) for (const [h, n] of Object.entries(d.hours || {})) hours[h] = (hours[h] || 0) + n;

    const maxRev = Math.max(1, ...days.map((d) => d.revenue));
    const revChart = days.map((d) => `<div class="rc-col" title="${dayLabel(d.day)}: ${money(d.revenue)} · ${d.orders} הזמנות">
      <span class="rc-val">${d.revenue ? d.revenue : ''}</span>
      <span class="rc-bar"><i style="height:${(d.revenue / maxRev) * 100}%"></i></span>
      <span class="rc-lbl">${dayLabel(d.day)}</span>
    </div>`).join('');

    const hourKeys = Object.keys(hours).sort();
    const maxHour = Math.max(1, ...Object.values(hours));
    const hourChart = hourKeys.length
      ? hourKeys.map((h) => `<div class="rc-col hour" title="${h}:00 · ${hours[h]} הזמנות"><span class="rc-val">${hours[h]}</span><span class="rc-bar"><i style="height:${(hours[h] / maxHour) * 100}%"></i></span><span class="rc-lbl">${h}:00</span></div>`).join('')
      : '<div class="empty">—</div>';

    const bd = (title, obj, limit = 8) => {
      const rows = Object.entries(obj).sort((a, b) => b[1] - a[1]).slice(0, limit);
      const max = Math.max(1, ...rows.map((r) => r[1]));
      return `<div class="bd glass"><h3>${title}</h3>${rows.map(([l, n], idx) => `<div class="bd-row"><span class="l">${idx === 0 ? '🏆 ' : ''}${esc(l)}</span><span class="bar"><i style="width:${(n / max) * 100}%"></i></span><span class="n">${n}</span></div>`).join('') || '<div class="empty">—</div>'}</div>`;
    };

    const busiest = hourKeys.length ? hourKeys.reduce((a, b) => (hours[b] > hours[a] ? b : a)) : null;
    const bestDay = days.length ? days.reduce((a, b) => (b.revenue > a.revenue ? b : a)) : null;
    $('#reports').innerHTML = `
      <div class="stats">
        <div class="stat glass"><b>${money(revenue)}</b><span>הכנסות</span></div>
        <div class="stat glass"><b>${orderCount}</b><span>הזמנות</span></div>
        <div class="stat glass"><b>${orderCount ? money(Math.round(revenue / orderCount)) : '—'}</b><span>ממוצע להזמנה</span></div>
        <div class="stat glass"><b>${total('sandwiches')}</b><span>סנדוויצ'ים</span></div>
        <div class="stat glass"><b>${money(total('discounts'))}</b><span>הנחות שניתנו</span></div>
      </div>
      <div class="insights">
        ${bestDay && bestDay.revenue ? `<span>📈 היום החזק: <b>${dayLabel(bestDay.day)}</b> (${money(bestDay.revenue)})</span>` : ''}
        ${busiest ? `<span>⏰ שעת השיא: <b>${busiest}:00</b></span>` : ''}
        <span>🎁 סנדוויצ'ים חינם מהכרטיסייה: <b>${total('rewards')}</b></span>
      </div>
      <div class="bd glass chart-card"><h3>💰 הכנסות לפי יום</h3><div class="rchart">${revChart}</div></div>
      <div class="bd glass chart-card"><h3>⏰ הזמנות לפי שעה</h3><div class="rchart">${hourChart}</div></div>
      <div class="breakdowns">
        ${bd('🍳 מילויים', merge('fillings'))}
        ${bd('🍞 לחמים', merge('breads'))}
        ${bd('➕ תוספות', merge('extras'))}
        ${bd('🥤 שתייה', merge('drinks'))}
        ${bd('🥫 ממרחים', merge('spreads'))}
        ${bd('🥗 ירקות', merge('vegetables'))}
      </div>`;
  }

  function exportCsv() {
    if (!reportData) return;
    const cats = [['breads', 'לחם'], ['fillings', 'מילוי'], ['spreads', 'ממרח'], ['vegetables', 'ירק'], ['extras', 'תוספת'], ['drinks', 'שתייה']];
    const products = [];
    for (const [cat, label] of cats) {
      const names = new Set(reportData.days.flatMap((d) => Object.keys(d.items[cat] || {})));
      for (const name of names) products.push([cat, `${label}: ${name}`, name]);
    }
    const cell = (v) => `"${String(v).replace(/"/g, '""')}"`;
    const header = ['תאריך', 'הזמנות', 'בוטלו', 'הכנסות', 'נגבה', 'הנחות', 'סנדוויצ\'ים', 'שתייה', ...products.map((p) => p[1])];
    const rows = reportData.days.map((d) => [
      d.day, d.orders, d.cancelled, d.revenue, d.collected, d.discounts, d.sandwiches, d.drinks,
      ...products.map(([cat, , name]) => (d.items[cat] || {})[name] || 0),
    ]);
    const csv = '\uFEFF' + [header, ...rows].map((r) => r.map(cell).join(',')).join('\r\n');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
    a.download = `sandwich-report-${reportData.days[0]?.day || ''}-${reportData.days.at(-1)?.day || ''}.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    toast('הקובץ ירד ✓');
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
    if (name === 'reports') loadReports();
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

    const fileInput = document.createElement('input');
    fileInput.type = 'file';
    fileInput.accept = 'image/*';
    fileInput.hidden = true;
    document.body.appendChild(fileInput);
    fileInput.addEventListener('change', () => { uploadImage(fileInput.files[0]); fileInput.value = ''; });

    const itemRef = (el) => {
      const tile = el.closest('.mitem');
      return tile && { cat: tile.closest('.mgroup').dataset.cat, id: tile.dataset.id, tile };
    };

    $('#menuEditor').addEventListener('change', (e) => {
      const t = e.target;
      if (t.dataset.productPrice) return menuCall('/api/admin/menu', { method: 'PUT', body: JSON.stringify({ products: [{ id: t.dataset.productPrice, price: Number(t.value) }] }) });
      if (t.dataset.groupExtra) {
        const [product, id] = t.dataset.groupExtra.split('__');
        return menuCall('/api/admin/menu', { method: 'PUT', body: JSON.stringify({ groups: [{ product, id, extraPrice: Number(t.value) }] }) });
      }
      if (t.dataset.promo) return menuCall('/api/admin/menu', { method: 'PUT', body: JSON.stringify({ promos: { [t.dataset.promo]: Number(t.value) } }) });
      const ref = t.dataset.field && itemRef(t);
      if (!ref) return;
      const value = t.dataset.field === 'available' ? t.checked : t.dataset.field === 'price' ? Number(t.value) : t.value;
      menuCall(`/api/admin/menu/${ref.cat}/${encodeURIComponent(ref.id)}`, { method: 'PATCH', body: JSON.stringify({ [t.dataset.field]: value }) });
    });

    $('#reportRange').addEventListener('click', (e) => {
      const b = e.target.closest('[data-days]');
      if (!b) return;
      reportDays = Number(b.dataset.days);
      for (const x of $('#reportRange').children) x.classList.toggle('on', x === b);
      loadReports();
    });
    $('#exportCsv').addEventListener('click', exportCsv);

    $('#menuEditor').addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && e.target.matches('.mname-input')) e.target.blur();
    });

    $('#menuEditor').addEventListener('click', async (e) => {
      const upload = e.target.closest('[data-upload]');
      if (upload) {
        const ref = itemRef(upload);
        uploadTarget = { cat: ref.cat, id: ref.id };
        fileInput.click();
        return;
      }
      const del = e.target.closest('[data-delete]');
      if (del) {
        const ref = itemRef(del);
        const name = ref.tile.querySelector('.mname-input').value;
        if (!confirm(`למחוק את "${name}" מהתפריט?`)) return;
        if (!reduceMotion) await ref.tile.animate([{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'scale(.85)' }], { duration: 220, fill: 'forwards' }).finished;
        menuCall(`/api/admin/menu/${ref.cat}/${encodeURIComponent(ref.id)}`, { method: 'DELETE' }, 'נמחק 🗑');
      }
    });

    $('#menuEditor').addEventListener('submit', async (e) => {
      e.preventDefault();
      const form = e.target.closest('[data-add]');
      if (!form) return;
      const body = { name: form.name.value };
      if (form.price) body.price = Number(form.price.value);
      if (form.dataset.group) body.group = form.dataset.group;
      const data = await menuCall(`/api/admin/menu/${form.dataset.add}`, { method: 'POST', body: JSON.stringify(body) }, 'נוסף! לחצו על התמונה כדי להוסיף תמונה 📷');
      if (data && data.item && !reduceMotion) {
        const tile = document.querySelector(`.mitem[data-id="${CSS.escape(data.item.id)}"]`);
        if (tile) tile.animate([{ opacity: 0, transform: 'scale(.8)' }, { opacity: 1, transform: 'none' }], { duration: 350, easing: 'cubic-bezier(.2,1.4,.4,1)' });
      }
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
