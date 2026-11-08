(() => {
  const $ = (sel, el = document) => el.querySelector(sel);
  const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const money = (n) => `${n} ₪`;
  const timeOf = (ts) => new Date(ts).toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Jerusalem' });
  const todayKey = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jerusalem' }).format(new Date());
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const vibrate = (p) => { if (navigator.vibrate) navigator.vibrate(p); };

  const store = {
    get(key, fallback) {
      try { const v = JSON.parse(localStorage.getItem(key)); return v ?? fallback; } catch { return fallback; }
    },
    set(key, value) { localStorage.setItem(key, JSON.stringify(value)); },
  };

  const ETA_OPTIONS = [5, 10, 15, 20, 30, 45];
  const STATUS = {
    new: { label: 'ההזמנה התקבלה', sub: 'העגלה קיבלה את ההזמנה שלך ותתחיל להכין בקרוב', emoji: '📨', step: 0, mood: 'sent' },
    preparing: { label: 'מכינים לך עכשיו', sub: 'הסנדוויץ\' שלך על הקרש 🔪', emoji: '👨‍🍳', step: 1, mood: 'cooking' },
    ready: { label: 'מוכן לאיסוף!', sub: 'ההזמנה מחכה לך בעגלה', emoji: '🎉', step: 2, mood: 'party' },
    picked_up: { label: 'בתיאבון!', sub: 'תודה שהזמנת, נתראה בפעם הבאה', emoji: '😋', step: 3, mood: 'done' },
    cancelled: { label: 'ההזמנה בוטלה', sub: 'לשאלות אפשר לפנות לעגלה', emoji: '😕', step: -1, mood: 'sad' },
  };
  const STEPS = [['התקבלה', '📨'], ['בהכנה', '🔥'], ['מוכן', '🎉'], ['נאסף', '😋']];

  let MENU = null;
  const builder = { bread: null, spreads: [], vegetables: [], filling: null, qty: 1 };
  const withVeg = (i) => (i.type === 'drink' ? i : { ...i, vegetables: i.vegetables || [] });
  let cart = store.get('sc_cart', []).map(withVeg);
  let favorites = store.get('sc_favorites', []).map(withVeg);
  let eta = null;

  // ---------- menu helpers ----------
  const find = (cat, id) => MENU.menu[cat].find((x) => x.id === id);
  const available = (cat, id) => { const x = find(cat, id); return Boolean(x && x.available); };
  const sandwichKey = (s) => `s:${s.bread}|${[...s.spreads].sort().join(',')}|${[...(s.vegetables || [])].sort().join(',')}|${s.filling || ''}`;

  function sandwichAvailable(s) {
    return available('breads', s.bread)
      && s.spreads.every((id) => available('spreads', id))
      && (s.vegetables || []).every((id) => available('vegetables', id))
      && (!s.filling || available('fillings', s.filling));
  }

  function sandwichText(s) {
    const bread = find('breads', s.bread)?.name || '';
    const filling = s.filling ? find('fillings', s.filling)?.name : '';
    const spreads = s.spreads.map((id) => find('spreads', id)?.name).filter(Boolean);
    const vegetables = (s.vegetables || []).map((id) => find('vegetables', id)?.name).filter(Boolean);
    const sub = [spreads.length && `ממרחים: ${spreads.join(', ')}`, vegetables.length && `ירקות: ${vegetables.join(', ')}`].filter(Boolean);
    return {
      title: [bread, filling].filter(Boolean).join(' · '),
      sub: sub.length ? sub.join(' · ') : 'בלי תוספות',
    };
  }

  const itemPrice = (item) => (item.type === 'sandwich' ? MENU.menu.prices.sandwich : find('drinks', item.drink)?.price || 0);
  const cartCount = () => cart.reduce((n, i) => n + i.qty, 0);
  const cartTotal = () => cart.reduce((n, i) => n + itemPrice(i) * i.qty, 0);
  const saveCart = () => store.set('sc_cart', cart);

  // ---------- motion helpers ----------
  function replay(el, cls) {
    if (!el || reduceMotion) return;
    el.classList.remove(cls);
    void el.offsetWidth;
    el.classList.add(cls);
    el.addEventListener('animationend', () => el.classList.remove(cls), { once: true });
  }

  function countTo(el, to, format = (n) => n) {
    const from = Number(el.dataset.val || 0);
    el.dataset.val = to;
    if (reduceMotion || from === to) { el.textContent = format(to); return; }
    const start = performance.now();
    const dur = 450;
    const step = (now) => {
      const t = Math.min(1, (now - start) / dur);
      const eased = 1 - (1 - t) ** 3;
      el.textContent = format(Math.round(from + (to - from) * eased));
      if (t < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }

  function flyToCart(sources) {
    if (reduceMotion) return Promise.resolve();
    const bar = $('#openCart').getBoundingClientRect();
    const target = bar.width
      ? { x: bar.left + 40, y: bar.top + bar.height / 2 }
      : { x: innerWidth / 2, y: innerHeight - 50 };
    return Promise.all(sources.filter(Boolean).map((src, i) => {
      const r = src.getBoundingClientRect();
      if (!r.width) return null;
      const img = document.createElement('img');
      img.src = src.currentSrc || src.src;
      img.className = 'flyer';
      Object.assign(img.style, { left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px` });
      document.body.appendChild(img);
      const dx = target.x - (r.left + r.width / 2);
      const dy = target.y - (r.top + r.height / 2);
      return img.animate([
        { transform: 'translate(0,0) scale(1) rotate(0deg)', opacity: 1 },
        { transform: `translate(${dx * 0.45}px, ${dy * 0.45 - 140}px) scale(0.75) rotate(-25deg)`, opacity: 1, offset: 0.45 },
        { transform: `translate(${dx}px, ${dy}px) scale(0.15) rotate(20deg)`, opacity: 0.3 },
      ], { duration: 780, delay: i * 70, easing: 'cubic-bezier(.45,0,.4,1)', fill: 'backwards' }).finished.then(() => img.remove());
    }));
  }

  let toastTimer;
  function notify(icon, title, sub = '', ms = 2600) {
    const t = $('#toast');
    $('.t-icon', t).textContent = icon;
    $('.t-title', t).textContent = title;
    $('.t-sub', t).textContent = sub;
    t.classList.toggle('has-sub', Boolean(sub));
    t.classList.remove('show');
    void t.offsetWidth;
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('show'), ms);
  }

  function confetti(amount = 80) {
    if (reduceMotion) return;
    const colors = ['#ff6b4a', '#ffb43b', '#1fb57a', '#ff4d8d', '#7c5cff', '#38bdf8'];
    for (let i = 0; i < amount; i++) {
      const c = document.createElement('i');
      c.className = 'confetti';
      c.style.left = `${Math.random() * 100}vw`;
      c.style.background = colors[i % colors.length];
      c.style.width = `${6 + Math.random() * 6}px`;
      c.style.animationDuration = `${1.8 + Math.random() * 1.8}s`;
      c.style.animationDelay = `${Math.random() * 0.5}s`;
      c.style.setProperty('--drift', `${(Math.random() - 0.5) * 160}px`);
      document.body.appendChild(c);
      setTimeout(() => c.remove(), 4500);
    }
  }

  // ---------- builder ----------
  function optionButton(cat, item, i) {
    return `<button type="button" class="opt" style="--i:${i}" data-cat="${cat}" data-id="${esc(item.id)}" aria-pressed="false" ${item.available ? '' : 'disabled'}>
      <span class="opt-img"><img src="${esc(item.img)}" alt="" loading="lazy" /></span>
      <span class="opt-name">${esc(item.name)}</span>
      <span class="check">✓</span>
      ${item.available ? '' : '<span class="sold-out">אזל</span>'}
    </button>`;
  }

  function renderBuilderOptions() {
    const m = MENU.menu;
    $('#sandwichPrice').textContent = money(m.prices.sandwich);
    $('#breads').innerHTML = m.breads.map((b, i) => optionButton('breads', b, i)).join('');
    $('#spreads').innerHTML = m.spreads.map((s, i) => optionButton('spreads', s, i)).join('');
    $('#vegetables').innerHTML = m.vegetables.map((v, i) => optionButton('vegetables', v, i)).join('');
    $('#step3').classList.toggle('hidden', !m.vegetables.length);
    $('#fillings').innerHTML = m.fillings.map((f, i) => optionButton('fillings', f, i)).join('');
    if (builder.bread && !available('breads', builder.bread)) builder.bread = null;
    builder.spreads = builder.spreads.filter((id) => available('spreads', id));
    builder.vegetables = builder.vegetables.filter((id) => available('vegetables', id));
    if (builder.filling && !available('fillings', builder.filling)) builder.filling = null;
    syncBuilder();
  }

  function isSelected(cat, id) {
    if (cat === 'breads') return builder.bread === id;
    if (cat === 'spreads') return builder.spreads.includes(id);
    if (cat === 'vegetables') return builder.vegetables.includes(id);
    return builder.filling === id;
  }

  function syncBuilder() {
    for (const btn of $$('.builder .opt')) btn.setAttribute('aria-pressed', String(isSelected(btn.dataset.cat, btn.dataset.id)));
    const stepDone = { 1: Boolean(builder.bread), 2: builder.spreads.length > 0, 3: builder.vegetables.length > 0, 4: Boolean(builder.filling) };
    for (const el of $$('.step-num')) {
      const done = stepDone[el.dataset.step];
      if (done && !el.classList.contains('done')) replay(el, 'pop');
      el.classList.toggle('done', done);
    }
    $('#qty').textContent = builder.qty;
    const ready = Boolean(builder.bread);
    $('#addSandwich').disabled = !ready;
    $('#saveFav').disabled = !ready;
    $('#addSandwich').textContent = ready ? `הוספה לסל · ${money(MENU.menu.prices.sandwich * builder.qty)}` : 'הוספה לסל';
    renderTray();
  }

  function trayItems() {
    const items = [];
    if (builder.bread) items.push({ key: `b:${builder.bread}`, ...find('breads', builder.bread) });
    for (const id of builder.spreads) items.push({ key: `s:${id}`, ...find('spreads', id) });
    for (const id of builder.vegetables) items.push({ key: `v:${id}`, ...find('vegetables', id) });
    if (builder.filling) items.push({ key: `f:${builder.filling}`, ...find('fillings', builder.filling) });
    return items;
  }

  function renderTray() {
    const tray = $('#tray');
    const items = trayItems();
    const keys = new Set(items.map((i) => i.key));
    for (const el of $$('.ing:not(.leaving)', tray)) {
      if (keys.has(el.dataset.key)) continue;
      if (reduceMotion) { el.remove(); continue; }
      el.classList.add('leaving');
      el.addEventListener('animationend', () => el.remove(), { once: true });
    }
    const live = () => $$('.ing:not(.leaving)', tray);
    items.forEach((it, idx) => {
      if (live().some((el) => el.dataset.key === it.key)) return;
      const el = document.createElement('span');
      el.className = 'ing';
      el.dataset.key = it.key;
      el.innerHTML = `<img src="${esc(it.img)}" alt="" /><span>${esc(it.name)}</span>`;
      const next = items.slice(idx + 1).map((n) => live().find((e) => e.dataset.key === n.key)).find(Boolean);
      tray.insertBefore(el, next || null);
    });
    $('#trayEmpty').classList.toggle('gone', items.length > 0);
  }

  function onOptionClick(e) {
    const btn = e.target.closest('.opt');
    if (!btn || btn.disabled) return;
    const { cat, id } = btn.dataset;
    const firstBread = cat === 'breads' && !builder.bread;
    if (cat === 'breads') builder.bread = id;
    if (cat === 'fillings') builder.filling = builder.filling === id ? null : id;
    if (cat === 'spreads' || cat === 'vegetables') {
      builder[cat] = builder[cat].includes(id) ? builder[cat].filter((x) => x !== id) : [...builder[cat], id];
    }
    vibrate(8);
    syncBuilder();
    if (isSelected(cat, id)) replay(btn, 'just');
    if (firstBread && !reduceMotion) {
      const step2 = $('#step2').getBoundingClientRect();
      if (step2.bottom > innerHeight - 90) $('#step2').scrollIntoView({ behavior: 'smooth', block: 'center' });
      replay($('#step2'), 'nudge');
    }
  }

  function addSandwichToCart(s, qty) {
    const item = { type: 'sandwich', bread: s.bread, spreads: [...s.spreads], vegetables: [...(s.vegetables || [])], filling: s.filling || null };
    const key = sandwichKey(item);
    const existing = cart.find((i) => i.type === 'sandwich' && sandwichKey(i) === key);
    if (existing) existing.qty = Math.min(20, existing.qty + qty);
    else cart.push({ ...item, qty });
    saveCart();
  }

  async function afterAdd(sources) {
    const wasHidden = $('#cartBar').classList.contains('hidden');
    if (wasHidden) renderCartBar(false);
    await flyToCart(sources);
    renderCartBar(true);
  }

  // ---------- favorites ----------
  function renderFavorites() {
    const section = $('#favoritesSection');
    if (!favorites.length) { section.classList.add('hidden'); return; }
    section.classList.remove('hidden');
    $('#favorites').innerHTML = favorites.map((f, idx) => {
      const ok = sandwichAvailable(f);
      const t = sandwichText(f);
      const imgs = [find('breads', f.bread), f.filling && find('fillings', f.filling), ...f.spreads.slice(0, 2).map((id) => find('spreads', id)), ...f.vegetables.slice(0, 2).map((id) => find('vegetables', id))]
        .filter(Boolean).slice(0, 5).map((x) => `<img src="${esc(x.img)}" alt="" />`).join('');
      return `<div class="fav glass" style="--i:${idx}">
        <button type="button" class="fav-del" data-del="${idx}" aria-label="מחיקה">✕</button>
        <div class="fav-imgs">${imgs}</div>
        <div class="fav-label"><b>${esc(t.title)}</b><br><small>${esc(t.sub)}</small></div>
        <button type="button" class="btn primary" data-fav="${idx}" ${ok ? '' : 'disabled'}>${ok ? `+ לסל · ${money(MENU.menu.prices.sandwich)}` : 'חסר משהו כרגע'}</button>
      </div>`;
    }).join('');
  }

  async function onFavoritesClick(e) {
    const del = e.target.closest('[data-del]');
    if (del) {
      const card = del.closest('.fav');
      if (!reduceMotion) await card.animate([{ transform: 'scale(1)', opacity: 1 }, { transform: 'scale(.6)', opacity: 0 }], { duration: 220, easing: 'ease-in' }).finished;
      favorites.splice(Number(del.dataset.del), 1);
      store.set('sc_favorites', favorites);
      renderFavorites();
      return;
    }
    const add = e.target.closest('[data-fav]');
    if (add && !add.disabled) {
      addSandwichToCart(favorites[Number(add.dataset.fav)], 1);
      replay(add, 'bump');
      vibrate(15);
      notify('⭐', 'הקבוע שלך בסל');
      afterAdd($$('.fav-imgs img', add.closest('.fav')));
    }
  }

  function saveFavorite() {
    if (!builder.bread) return;
    const fav = { bread: builder.bread, spreads: [...builder.spreads], vegetables: [...builder.vegetables], filling: builder.filling };
    if (favorites.some((f) => sandwichKey(f) === sandwichKey(fav))) { notify('⭐', 'כבר שמור אצלך'); return; }
    favorites.unshift(fav);
    favorites = favorites.slice(0, 8);
    store.set('sc_favorites', favorites);
    renderFavorites();
    replay($('#favoritesSection'), 'nudge');
    notify('⭐', 'נשמר כסנדוויץ\' קבוע', 'בפעם הבאה מזמינים בלחיצה אחת');
  }

  // ---------- drinks ----------
  function renderDrinks(changedId) {
    $('#drinks').innerHTML = MENU.menu.drinks.map((d, i) => {
      const inCart = cart.find((x) => x.type === 'drink' && x.drink === d.id);
      const control = !d.available
        ? '<button type="button" class="btn ghost add-drink" disabled>אזל</button>'
        : inCart
          ? `<div class="stepper small"><button type="button" data-drink-minus="${esc(d.id)}">−</button><span>${inCart.qty}</span><button type="button" data-drink-plus="${esc(d.id)}">+</button></div>`
          : `<button type="button" class="btn ghost add-drink" data-drink-plus="${esc(d.id)}">+ הוספה</button>`;
      return `<div class="drink glass ${d.available ? '' : 'disabled'} ${inCart ? 'in-cart' : ''}" style="--i:${i}" data-drink="${esc(d.id)}">
        ${inCart ? `<span class="drink-badge">${inCart.qty}</span>` : ''}
        <span class="drink-img"><img src="${esc(d.img)}" alt="${esc(d.name)}" loading="lazy" /></span>
        <div class="drink-row"><span class="drink-name">${esc(d.name)}</span><span class="drink-price">${money(d.price)}</span></div>
        ${control}
      </div>`;
    }).join('');
    if (changedId) replay($(`.drink[data-drink="${CSS.escape(changedId)}"]`), 'bump');
  }

  function changeDrink(id, delta) {
    const idx = cart.findIndex((i) => i.type === 'drink' && i.drink === id);
    if (idx === -1 && delta > 0) cart.push({ type: 'drink', drink: id, qty: 1 });
    else if (idx !== -1) {
      cart[idx].qty = Math.min(20, cart[idx].qty + delta);
      if (cart[idx].qty <= 0) cart.splice(idx, 1);
    }
    saveCart();
    const src = delta > 0 ? $(`.drink[data-drink="${CSS.escape(id)}"] img`) : null;
    renderDrinks(id);
    vibrate(10);
    if (src) afterAdd([src]);
    else renderCartBar(true);
  }

  // ---------- cart ----------
  function renderCartBar(animate) {
    const bar = $('#cartBar');
    if (!cart.length) { bar.classList.add('hidden'); return; }
    bar.classList.remove('hidden');
    countTo($('#cartCount'), cartCount());
    countTo($('#cartBarTotal'), cartTotal(), money);
    if (animate) { replay($('#openCart'), 'bump'); replay($('.cart-ico'), 'wiggle'); }
  }

  function renderCartList() {
    $('#cartList').innerHTML = cart.map((item, idx) => {
      let img; let title; let sub;
      if (item.type === 'sandwich') {
        const t = sandwichText(item);
        img = find('breads', item.bread)?.img;
        title = t.title; sub = t.sub;
      } else {
        const d = find('drinks', item.drink);
        img = d?.img; title = d?.name || ''; sub = 'שתייה';
      }
      return `<li class="cart-line" style="--i:${idx}" data-line="${idx}">
        <img src="${esc(img || '')}" alt="" />
        <div class="desc"><b>${esc(title)}</b><small>${esc(sub)}</small></div>
        <div class="stepper small"><button type="button" data-line-minus="${idx}">−</button><span>${item.qty}</span><button type="button" data-line-plus="${idx}">+</button></div>
        <span class="line-price">${money(itemPrice(item) * item.qty)}</span>
      </li>`;
    }).join('');
    countTo($('#submitTotal'), cartTotal(), money);
    $('#submitOrder').disabled = !cart.length;
  }

  async function onCartListClick(e) {
    const btn = e.target.closest('[data-line-minus],[data-line-plus]');
    if (!btn) return;
    const plus = btn.hasAttribute('data-line-plus');
    const idx = Number(plus ? btn.dataset.linePlus : btn.dataset.lineMinus);
    const line = btn.closest('.cart-line');
    if (!plus && cart[idx].qty === 1 && !reduceMotion) {
      line.style.height = `${line.offsetHeight}px`;
      await line.animate([
        { transform: 'translateX(0)', opacity: 1, height: `${line.offsetHeight}px` },
        { transform: 'translateX(-60px)', opacity: 0, height: `${line.offsetHeight}px`, offset: 0.6 },
        { transform: 'translateX(-60px)', opacity: 0, height: '0px', paddingTop: '0px', paddingBottom: '0px', marginTop: '-10px' },
      ], { duration: 380, easing: 'ease-in' }).finished;
    }
    cart[idx].qty = Math.min(20, cart[idx].qty + (plus ? 1 : -1));
    if (cart[idx].qty <= 0) cart.splice(idx, 1);
    saveCart();
    renderCartList();
    const updated = $(`.cart-line[data-line="${idx}"] .line-price`);
    if (updated && cart[idx]) replay(updated, 'bump');
    renderCartBar(false);
    renderDrinks();
    vibrate(8);
    if (!cart.length) closeSheet();
  }

  function openSheet() {
    renderCartList();
    renderEta();
    $('#formError').classList.add('hidden');
    const sheet = $('#sheet');
    sheet.classList.remove('hidden', 'closing');
    sheet.classList.add('entering');
    setTimeout(() => sheet.classList.remove('entering'), 900);
    document.body.style.overflow = 'hidden';
  }

  async function closeSheet() {
    const sheet = $('#sheet');
    if (sheet.classList.contains('hidden')) return;
    if (!reduceMotion) {
      sheet.classList.add('closing');
      await wait(280);
    }
    sheet.classList.add('hidden');
    sheet.classList.remove('closing');
    document.body.style.overflow = '';
  }

  // ---------- ETA ----------
  function renderEta() {
    $('#etaChips').innerHTML = ETA_OPTIONS.map((m) => `<button type="button" class="chip" data-eta="${m}" aria-pressed="${eta === m && !$('#fEtaCustom').value}">${m} דק'</button>`).join('');
    const hint = $('#etaHint');
    const text = eta === null ? '' : eta === 0 ? '🏃 אני כבר כאן!' : `⏰ נגיע בערך ב-${timeOf(Date.now() + eta * 60000)}`;
    if (hint.textContent !== text) { hint.textContent = text; replay(hint, 'pop'); }
  }

  // ---------- push notifications ----------
  const pushSupported = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
  const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const isStandalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
  const pushState = {};

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
    navigator.serviceWorker.addEventListener('message', (ev) => {
      if (ev.data && ev.data.type === 'order-push') refreshOrders();
    });
  }

  function b64ToBytes(base64) {
    const pad = '='.repeat((4 - (base64.length % 4)) % 4);
    const raw = atob((base64 + pad).replace(/-/g, '+').replace(/_/g, '/'));
    return Uint8Array.from(raw, (c) => c.charCodeAt(0));
  }

  async function subscribePush(orderId) {
    if (!pushSupported || Notification.permission !== 'granted') return false;
    try {
      const reg = await navigator.serviceWorker.ready;
      const { key } = await (await fetch('/api/push/key')).json();
      let sub = await reg.pushManager.getSubscription();
      if (sub && localStorage.getItem('sc_push_key') !== key) { await sub.unsubscribe(); sub = null; }
      if (!sub) {
        sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToBytes(key) });
        localStorage.setItem('sc_push_key', key);
      }
      const res = await fetch(`/api/orders/${encodeURIComponent(orderId)}/push`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ subscription: sub.toJSON() }),
      });
      pushState[orderId] = res.ok;
      return res.ok;
    } catch {
      return false;
    }
  }

  function askPermission() {
    if (!pushSupported || Notification.permission !== 'default') return Promise.resolve(pushSupported ? Notification.permission : 'unsupported');
    return Notification.requestPermission();
  }

  function pushCardHtml(orderId, status) {
    if (['picked_up', 'cancelled'].includes(status)) return '';
    if (pushState[orderId]) return '<div class="push-card on"><span class="bell ring">🔔</span><span>נשלח לך התראה לטלפון ברגע שההזמנה מוכנה</span></div>';
    if (pushSupported && Notification.permission === 'default') {
      return `<button type="button" class="push-card ask" data-enable-push><span class="bell">🔔</span><span><b>רוצים התראה כשמוכן?</b><small>גם כשהאתר סגור</small></span><span class="go">הפעלה</span></button>`;
    }
    if (pushSupported && Notification.permission === 'denied') {
      return '<div class="push-card muted"><span class="bell">🔕</span><span>ההתראות חסומות בדפדפן. נעדכן אותך כאן במסך</span></div>';
    }
    if (isIOS && !isStandalone) {
      return '<div class="push-card muted"><span class="bell">📲</span><span>באייפון: לחצו על <b>שיתוף</b> ואז <b>"הוספה למסך הבית"</b>, ופתחו משם כדי לקבל התראות</span></div>';
    }
    return '';
  }

  // ---------- submit ----------
  async function submitOrder(e) {
    e.preventDefault();
    const err = $('#formError');
    const btn = $('#submitOrder');
    const showErr = (msg) => {
      err.textContent = msg;
      err.classList.remove('hidden');
      replay(err, 'shake');
      vibrate([30, 40, 30]);
    };
    err.classList.add('hidden');

    const name = $('#fName').value.trim();
    const phone = $('#fPhone').value.replace(/\D/g, '');
    if (!name) { replay($('#fName'), 'shake'); return showErr('נא למלא שם'); }
    if (!/^0\d{8,9}$/.test(phone)) { replay($('#fPhone'), 'shake'); return showErr('נא למלא מספר טלפון תקין'); }
    if (eta === null) { replay($('.eta-block'), 'shake'); return showErr('נא לבחור בעוד כמה דקות תגיעו'); }

    // Must be requested synchronously inside the tap, before any await.
    const permission = askPermission();

    btn.disabled = true;
    btn.classList.add('loading');
    let data;
    try {
      const [res] = await Promise.all([
        fetch('/api/orders', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name, phone, notes: $('#fNotes').value, etaMinutes: eta,
            items: cart.map((i) => (i.type === 'sandwich'
              ? { type: 'sandwich', bread: i.bread, spreads: i.spreads, vegetables: i.vegetables || [], filling: i.filling, qty: i.qty }
              : { type: 'drink', drink: i.drink, qty: i.qty })),
          }),
        }),
        wait(reduceMotion ? 0 : 700),
      ]);
      data = await res.json().catch(() => ({}));
      if (!res.ok) {
        btn.classList.remove('loading');
        btn.disabled = false;
        if (data.menuChanged) await refreshMenuAfterChange();
        return showErr(data.error || 'משהו השתבש, נסו שוב');
      }
    } catch {
      btn.classList.remove('loading');
      btn.disabled = false;
      return showErr('אין חיבור לשרת, נסו שוב');
    }

    btn.classList.remove('loading');
    btn.classList.add('success');
    vibrate([20, 60, 40]);
    store.set('sc_profile', { name, phone });
    const mine = myOrders();
    mine.ids.push(data.id);
    store.set('sc_orders', mine);
    cart = [];
    saveCart();
    $('#fNotes').value = '';
    eta = null;
    $('#fEtaCustom').value = '';

    permission.then((p) => (p === 'granted' ? subscribePush(data.id) : false)).then(() => {
      if (currentOrderId === data.id) updatePushCard();
    });

    await wait(reduceMotion ? 0 : 900);
    await closeSheet();
    btn.classList.remove('success');
    btn.disabled = false;
    renderAll();
    orderCache[data.id] = data;
    watchOrder(data.id);
    window.scrollTo({ top: 0, behavior: reduceMotion ? 'auto' : 'smooth' });
    await wait(reduceMotion ? 0 : 250);
    renderTimer();
    renderMyOrdersBtn();
    confetti();
    notify('📨', `הזמנה #${data.number} נשלחה!`, 'הטיימר למעלה יראה לך מתי מוכן', 4000);
  }

  async function refreshMenuAfterChange() {
    await loadMenu();
    const before = cart.length;
    cart = cart.filter((i) => (i.type === 'sandwich' ? sandwichAvailable(i) : available('drinks', i.drink)));
    saveCart();
    renderBuilderOptions();
    renderAll();
    renderCartList();
    if (cart.length !== before) notify('😕', 'חלק מהפריטים אזלו', 'הם הוסרו מהסל');
  }

  // ---------- order status ----------
  function myOrders() {
    const saved = store.get('sc_orders', null);
    return saved && saved.day === todayKey() ? saved : { day: todayKey(), ids: [] };
  }

  const orderCache = {};
  let currentOrderId = null;
  let shownOrderId = null;
  let shownStatus = null;
  const streams = {};
  const TERMINAL = ['picked_up', 'cancelled'];

  function watchOrder(id) {
    if (streams[id]) return;
    const es = new EventSource(`/api/orders/${encodeURIComponent(id)}/stream`);
    streams[id] = es;
    es.addEventListener('order', (ev) => applyOrderUpdate(JSON.parse(ev.data)));
    es.onerror = async () => {
      const res = await fetch(`/api/orders/${encodeURIComponent(id)}`).catch(() => null);
      if (res && res.status === 404) {
        unwatchOrder(id);
        delete orderCache[id];
        const mine = myOrders();
        mine.ids = mine.ids.filter((x) => x !== id);
        store.set('sc_orders', mine);
        if (currentOrderId === id) hideStatus();
        renderMyOrdersBtn();
        renderTimer();
      }
    };
  }

  function unwatchOrder(id) {
    if (!streams[id]) return;
    streams[id].close();
    delete streams[id];
  }

  function showStatus(id, initial) {
    currentOrderId = id;
    if (initial) orderCache[id] = initial;
    const view = $('#statusView');
    if (view.classList.contains('hidden')) {
      view.classList.remove('hidden', 'closing');
      document.body.style.overflow = 'hidden';
    }
    renderStatus();
    watchOrder(id);
    if (pushSupported && Notification.permission === 'granted' && !pushState[id]) subscribePush(id).then(updatePushCard);
  }

  function applyOrderUpdate(o) {
    const prev = orderCache[o.id];
    orderCache[o.id] = o;
    if (prev && prev.status !== o.status) {
      const st = STATUS[o.status];
      if (o.status === 'ready') {
        vibrate([200, 100, 200, 100, 400]);
        confetti(120);
        notify('🎉', 'ההזמנה שלך מוכנה!', 'אפשר לבוא לאסוף', 4500);
      } else if (st) {
        vibrate(60);
        notify(st.emoji, st.label, '', 3000);
      }
    }
    if (o.id === currentOrderId) renderStatus();
    else if (TERMINAL.includes(o.status)) unwatchOrder(o.id);
    renderMyOrdersBtn();
    renderTimer();
  }

  async function refreshOrders() {
    const ids = new Set([...Object.keys(streams), currentOrderId].filter(Boolean));
    await Promise.all([...ids].map(async (id) => {
      const res = await fetch(`/api/orders/${encodeURIComponent(id)}`).catch(() => null);
      if (res && res.ok) applyOrderUpdate(await res.json());
    }));
  }

  async function hideStatus() {
    const closing = orderCache[currentOrderId];
    if (closing && TERMINAL.includes(closing.status)) unwatchOrder(closing.id);
    currentOrderId = null;
    shownOrderId = null;
    const view = $('#statusView');
    if (!reduceMotion && !view.classList.contains('hidden')) {
      view.classList.add('closing');
      await wait(260);
    }
    view.classList.add('hidden');
    view.classList.remove('closing');
    document.body.style.overflow = '';
  }

  function itemLine(i) {
    if (i.type === 'drink') return `<span class="q">${i.qty}×</span> 🥤 ${esc(i.drink.name)}`;
    const parts = [i.bread.name, i.filling && i.filling.name].filter(Boolean).join(' · ');
    const extras = [...i.spreads, ...(i.vegetables || [])].map((s) => s.name);
    const small = extras.length ? ` <small>(${esc(extras.join(', '))})</small>` : '';
    return `<span class="q">${i.qty}×</span> 🥪 ${esc(parts)}${small}`;
  }

  function buildStatusSkeleton(o) {
    $('#statusBody').innerHTML = `
      <div class="st-hero">
        <div class="st-emoji-wrap"><span class="st-glow"></span><span class="st-emoji" id="stEmoji"></span></div>
        <div class="order-num">מספר הזמנה<b>#${o.number}</b></div>
        <div class="st-text" id="stText"></div>
        <div class="st-sub" id="stSub"></div>
        <div class="live"><i></i>מתעדכן בזמן אמת</div>
      </div>
      <div class="progress" id="stProgress">
        <div class="fill"></div>
        ${STEPS.map(([label, icon], i) => `<div class="p-step" data-i="${i}"><span class="p-dot"><span class="p-icon">${icon}</span><span class="p-check">✓</span></span>${label}</div>`).join('')}
      </div>
      <div id="stEta" class="eta-ring">
        <svg viewBox="0 0 54 54"><circle class="track" cx="27" cy="27" r="22" fill="none" stroke-width="6"/><circle class="val" cx="27" cy="27" r="22" fill="none" stroke-width="6"/></svg>
        <div class="txt"><b></b><span></span></div>
      </div>
      <div id="stPush"></div>
      <ul class="status-items">${o.items.map((i, idx) => `<li style="--i:${idx}">${itemLine(i)}</li>`).join('')}</ul>
      <div class="status-total"><span>לתשלום באיסוף</span><span>${money(o.total)}</span></div>`;
  }

  async function swapEmoji(el, emoji, animate) {
    if (!animate || reduceMotion) { el.textContent = emoji; return; }
    await el.animate([{ transform: 'scale(1) rotate(0)', opacity: 1 }, { transform: 'scale(0) rotate(-90deg)', opacity: 0 }], { duration: 220, easing: 'ease-in' }).finished;
    el.textContent = emoji;
    el.animate([
      { transform: 'scale(0) rotate(90deg)', opacity: 0 },
      { transform: 'scale(1.35) rotate(-8deg)', opacity: 1, offset: 0.6 },
      { transform: 'scale(1) rotate(0)', opacity: 1 },
    ], { duration: 520, easing: 'cubic-bezier(.2,1.4,.4,1)' });
  }

  function renderStatus() {
    const o = orderCache[currentOrderId];
    const mine = myOrders();
    $('#statusTabs').innerHTML = mine.ids.length > 1
      ? mine.ids.map((id) => `<button type="button" class="chip" data-order="${esc(id)}" aria-pressed="${id === currentOrderId}">#${orderCache[id]?.number ?? '…'}</button>`).join('')
      : '';
    if (!o) { $('#statusBody').innerHTML = '<div class="st-loading"><span></span></div>'; shownOrderId = null; return; }

    const fresh = shownOrderId !== o.id;
    if (fresh) { buildStatusSkeleton(o); shownOrderId = o.id; shownStatus = null; }
    const changed = shownStatus !== o.status;
    const st = STATUS[o.status] || STATUS.new;

    if (changed) {
      const panel = $('.status-panel');
      panel.dataset.mood = st.mood;
      swapEmoji($('#stEmoji'), st.emoji, !fresh);
      for (const [sel, text] of [['#stText', st.label], ['#stSub', st.sub]]) {
        const el = $(sel);
        el.textContent = text;
        if (!fresh) replay(el, 'fade-up');
      }
      const cancelled = o.status === 'cancelled';
      $('#stProgress').classList.toggle('hidden', cancelled);
      $$('.p-step').forEach((stepEl, i) => {
        const wasDone = stepEl.classList.contains('done');
        stepEl.classList.toggle('done', i <= st.step);
        stepEl.classList.toggle('past', i < st.step);
        stepEl.classList.toggle('current', i === st.step);
        if (!fresh && i <= st.step && !wasDone) replay($('.p-dot', stepEl), 'pop');
      });
      const fill = $('#stProgress .fill');
      const pct = Math.max(0, st.step) / (STEPS.length - 1);
      if (fresh && !reduceMotion) {
        fill.style.width = '0';
        requestAnimationFrame(() => requestAnimationFrame(() => { fill.style.width = `calc((100% - 64px) * ${pct})`; }));
      } else {
        fill.style.width = `calc((100% - 64px) * ${pct})`;
      }
      if (!fresh && o.status === 'ready') replay(panel, 'celebrate');
      shownStatus = o.status;
      updatePushCard();
    }
    updateEta(o);
  }

  function updateEta(o) {
    const box = $('#stEta');
    if (!box) return;
    const hide = ['picked_up', 'cancelled'].includes(o.status);
    box.classList.toggle('hidden', hide);
    if (hide) return;
    const now = Date.now();
    const ready = o.status === 'ready';
    const { deadline, extensions } = ready ? { deadline: o.arriveAt, extensions: 0 } : orderDeadline(o, now);
    const frac = extensions
      ? 1 - (deadline - now) / (EXTEND_BY + EXTEND_AT)
      : (now - o.createdAt) / Math.max(1, o.arriveAt - o.createdAt);
    const left = Math.ceil((deadline - now) / 60000);
    const C = 2 * Math.PI * 22;
    const ring = $('.val', box);
    ring.style.strokeDasharray = C;
    ring.style.strokeDashoffset = C * (1 - Math.min(1, Math.max(0, frac)));
    $('.txt b', box).textContent = ready
      ? (left > 0 ? `מחכה לך · עוד ${left} דק'` : 'מחכה לך בעגלה 🏃')
      : extensions ? 'עוד 2 דקות מוכן ⏳' : `מגיעים בעוד ${left} דק'`;
    $('.txt span', box).textContent = `שעת איסוף משוערת ${timeOf(deadline)}`;
  }

  // While the order isn't ready, every time the countdown hits 20s it gets 2 more minutes.
  const EXTEND_AT = 20000;
  const EXTEND_BY = 120000;
  function orderDeadline(o, now) {
    if (o.arriveAt - now > EXTEND_AT) return { deadline: o.arriveAt, extensions: 0 };
    const extensions = Math.floor((now - o.arriveAt + EXTEND_AT) / EXTEND_BY) + 1;
    return { deadline: o.arriveAt + extensions * EXTEND_BY, extensions };
  }

  function updatePushCard() {
    const box = $('#stPush');
    const o = orderCache[currentOrderId];
    if (!box || !o) return;
    const html = pushCardHtml(o.id, o.status);
    if (box.innerHTML !== html) {
      box.innerHTML = html;
      if (html) replay(box.firstElementChild, 'fade-up');
    }
  }

  // ---------- home-screen order timer ----------
  let timerId = null;
  let timerStatus = null;
  let timerHideT = null;
  let timerExt = null;
  const RING = 2 * Math.PI * 52;
  const TIMER_STATUS = { new: 'התקבלה 📨', preparing: 'בהכנה 🔥', ready: '🎉' };
  const pad2 = (n) => String(n).padStart(2, '0');

  function pickTimerOrder() {
    const active = myOrders().ids.map((id) => orderCache[id]).filter((o) => o && !TERMINAL.includes(o.status));
    active.sort((a, b) => (b.status === 'ready') - (a.status === 'ready') || a.arriveAt - b.arriveAt);
    return { o: active[0], more: active.length - 1 };
  }

  async function hideTimer() {
    const el = $('#orderTimer');
    if (el.classList.contains('hidden')) return;
    if (!reduceMotion) {
      el.classList.add('leaving');
      await wait(350);
    }
    if (timerId) return;
    el.classList.add('hidden');
    el.classList.remove('leaving');
    $('.hero').classList.remove('has-timer');
  }

  function renderTimer() {
    const el = $('#orderTimer');
    const { o, more } = pickTimerOrder();
    if (!o) {
      if (!timerId) return;
      const last = orderCache[timerId];
      timerId = null;
      timerStatus = null;
      if (last && last.status === 'picked_up' && !el.classList.contains('hidden')) {
        el.dataset.state = 'done';
        $('.ot-status', el).textContent = '';
        $('.ot-time', el).textContent = 'בתיאבון!';
        $('.ot-label', el).textContent = 'תודה 💛';
        replay(el, 'timer-bump');
        clearTimeout(timerHideT);
        timerHideT = setTimeout(hideTimer, 3500);
      } else {
        hideTimer();
      }
      return;
    }
    clearTimeout(timerHideT);
    const appearing = el.classList.contains('hidden') || el.classList.contains('leaving');
    const changed = timerId !== o.id || timerStatus !== o.status;
    if (timerId !== o.id) timerExt = null;
    timerId = o.id;
    timerStatus = o.status;
    el.dataset.state = o.status;
    $('.ot-num', el).textContent = `#${o.number}`;
    $('.ot-status', el).textContent = TIMER_STATUS[o.status] || '';
    const moreEl = $('.ot-more', el);
    moreEl.textContent = more > 0 ? `+${more}` : '';
    moreEl.classList.toggle('hidden', more <= 0);
    if (appearing) {
      el.classList.remove('hidden', 'leaving');
      $('.hero').classList.add('has-timer');
      $('.ot-sweep', el).style.animationDelay = `-${Date.now() % 60000}ms`;
      replay(el, 'timer-in');
    } else if (changed) {
      replay(el, o.status === 'ready' ? 'timer-ready' : 'timer-bump');
    }
    tickTimer();
  }

  function tickTimer() {
    const el = $('#orderTimer');
    const o = orderCache[timerId];
    if (!o || el.classList.contains('hidden')) return;
    let big;
    let label;
    let frac = 1;
    let extensions = 0;
    if (o.status === 'ready') {
      big = 'מוכן!';
      label = 'לאיסוף 🛍️';
    } else {
      const now = Date.now();
      const d = orderDeadline(o, now);
      extensions = d.extensions;
      const left = Math.max(0, Math.ceil((d.deadline - now) / 1000));
      frac = extensions
        ? 1 - (d.deadline - now) / (EXTEND_BY + EXTEND_AT)
        : (now - o.createdAt) / Math.max(1, o.arriveAt - o.createdAt);
      frac = Math.min(1, Math.max(0, frac));
      const h = Math.floor(left / 3600);
      const m = Math.floor((left % 3600) / 60);
      big = h ? `${h}:${pad2(m)}:${pad2(left % 60)}` : `${pad2(m)}:${pad2(left % 60)}`;
      label = extensions ? 'עוד 2 דקות מוכן' : 'עד האיסוף';
    }
    if (timerExt !== null && extensions > timerExt) {
      replay(el, 'timer-extend');
      replay($('.ot-plus', el), 'show');
      vibrate([30, 50, 30]);
      if (document.visibilityState === 'visible') notify('⏳', 'עוד 2 דקות מוכן', 'מסיימים להכין לך');
    }
    timerExt = extensions;
    el.classList.toggle('extended', extensions > 0);
    $('.ot-time', el).textContent = big;
    $('.ot-label', el).textContent = label;
    el.classList.toggle('long', big.length > 5);
    const ring = $('.ot-val', el);
    ring.style.strokeDasharray = RING;
    ring.style.strokeDashoffset = RING * (1 - frac);
    el.setAttribute('aria-label', `הזמנה ${o.number}: ${big} ${label}. לחיצה לפרטים`);
  }

  function renderMyOrdersBtn() {
    const ids = myOrders().ids;
    const btn = $('#myOrdersBtn');
    const wasHidden = btn.classList.contains('hidden');
    btn.classList.toggle('hidden', ids.length === 0);
    const active = ids.some((id) => orderCache[id] && !['picked_up', 'cancelled'].includes(orderCache[id].status));
    btn.classList.toggle('active', active);
    if (wasHidden && ids.length) replay(btn, 'pop');
  }

  // ---------- init ----------
  async function loadMenu() {
    const res = await fetch('/api/menu');
    MENU = await res.json();
    document.title = MENU.shopName;
    $('#shopName').textContent = MENU.shopName;
  }

  async function refreshMenu() {
    if (!MENU || !$('#sheet').classList.contains('hidden')) return;
    try {
      const next = await (await fetch('/api/menu')).json();
      if (JSON.stringify(next) === JSON.stringify(MENU)) return;
      MENU = next;
      renderBuilderOptions();
      renderAll();
    } catch { /* offline, try again later */ }
  }

  function renderAll() {
    syncBuilder();
    renderFavorites();
    renderDrinks();
    renderCartBar(false);
    renderMyOrdersBtn();
  }

  function setupReveal() {
    const els = $$('.reveal');
    if (reduceMotion || !('IntersectionObserver' in window)) { els.forEach((el) => el.classList.add('in')); return; }
    const io = new IntersectionObserver((entries) => {
      for (const en of entries) {
        if (en.isIntersecting) { en.target.classList.add('in'); io.unobserve(en.target); }
      }
    }, { threshold: 0.08 });
    els.forEach((el) => io.observe(el));
  }

  function bindEvents() {
    for (const id of ['#breads', '#spreads', '#vegetables', '#fillings']) $(id).addEventListener('click', onOptionClick);
    $('#qtyMinus').addEventListener('click', () => { builder.qty = Math.max(1, builder.qty - 1); syncBuilder(); replay($('#qty'), 'pop'); });
    $('#qtyPlus').addEventListener('click', () => { builder.qty = Math.min(20, builder.qty + 1); syncBuilder(); replay($('#qty'), 'pop'); });
    $('#addSandwich').addEventListener('click', () => {
      if (!builder.bread) return;
      const sources = $$('#tray .ing:not(.leaving) img');
      addSandwichToCart(builder, builder.qty);
      vibrate(20);
      notify('🥪', builder.qty > 1 ? `${builder.qty} סנדוויצ'ים נוספו לסל` : 'הסנדוויץ\' נוסף לסל');
      afterAdd(sources);
      Object.assign(builder, { bread: null, spreads: [], vegetables: [], filling: null, qty: 1 });
      syncBuilder();
    });
    $('#saveFav').addEventListener('click', saveFavorite);
    $('#favorites').addEventListener('click', onFavoritesClick);
    $('#drinks').addEventListener('click', (e) => {
      const plus = e.target.closest('[data-drink-plus]');
      const minus = e.target.closest('[data-drink-minus]');
      if (plus) changeDrink(plus.dataset.drinkPlus, 1);
      if (minus) changeDrink(minus.dataset.drinkMinus, -1);
    });

    $('#openCart').addEventListener('click', openSheet);
    $('#sheet').addEventListener('click', (e) => { if (e.target.closest('[data-close]')) closeSheet(); });
    $('#cartList').addEventListener('click', onCartListClick);
    $('#etaChips').addEventListener('click', (e) => {
      const chip = e.target.closest('[data-eta]');
      if (!chip) return;
      eta = Number(chip.dataset.eta);
      $('#fEtaCustom').value = '';
      vibrate(8);
      renderEta();
    });
    $('#fEtaCustom').addEventListener('input', (e) => {
      const v = Number.parseInt(e.target.value, 10);
      eta = Number.isFinite(v) && v >= 0 && v <= 240 ? v : null;
      renderEta();
    });
    $('#orderForm').addEventListener('submit', submitOrder);

    $('#myOrdersBtn').addEventListener('click', () => {
      const ids = myOrders().ids;
      if (ids.length) showStatus(ids[ids.length - 1]);
    });
    $('#statusTabs').addEventListener('click', (e) => {
      const chip = e.target.closest('[data-order]');
      if (chip) showStatus(chip.dataset.order);
    });
    $('#statusBody').addEventListener('click', async (e) => {
      if (!e.target.closest('[data-enable-push]')) return;
      const p = await askPermission();
      if (p === 'granted' && currentOrderId) {
        await subscribePush(currentOrderId);
        notify('🔔', 'ההתראות הופעלו', 'נעדכן אותך כשההזמנה מוכנה');
      }
      updatePushCard();
    });
    $('#newOrderBtn').addEventListener('click', hideStatus);

    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') { refreshOrders(); refreshMenu(); }
    });
    $('#orderTimer').addEventListener('click', () => { if (timerId) showStatus(timerId); });
    setInterval(refreshMenu, 60000);
    setInterval(() => { const o = orderCache[currentOrderId]; if (o) updateEta(o); }, 15000);
    setInterval(tickTimer, 1000);
  }

  async function init() {
    const profile = store.get('sc_profile', null);
    if (profile) {
      $('#fName').value = profile.name || '';
      $('#fPhone').value = profile.phone || '';
    }
    bindEvents();
    setupReveal();
    for (;;) {
      try {
        await loadMenu();
        break;
      } catch {
        notify('📡', 'אין חיבור לשרת', 'מנסים שוב...');
        await wait(3000);
      }
    }
    cart = cart.filter((i) => (i.type === 'sandwich' ? find('breads', i.bread) : find('drinks', i.drink)));
    saveCart();
    renderBuilderOptions();
    document.body.classList.add('ready');
    renderAll();

    const mine = myOrders();
    const linked = new URLSearchParams(location.search).get('order');
    if (linked && !mine.ids.includes(linked)) mine.ids.push(linked);
    if (linked) history.replaceState(null, '', '/');
    await Promise.all(mine.ids.map(async (id) => {
      const res = await fetch(`/api/orders/${encodeURIComponent(id)}`).catch(() => null);
      if (res && res.ok) orderCache[id] = await res.json();
    }));
    mine.ids = mine.ids.filter((id) => orderCache[id]);
    store.set('sc_orders', mine);
    renderMyOrdersBtn();
    mine.ids.filter((id) => !TERMINAL.includes(orderCache[id].status)).forEach(watchOrder);
    renderTimer();
    if (linked && orderCache[linked]) showStatus(linked);
  }

  init();
})();
