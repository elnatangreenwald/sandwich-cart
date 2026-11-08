(() => {
  const $ = (sel, el = document) => el.querySelector(sel);
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const money = (n) => `${n} ₪`;
  const timeOf = (ts) => new Date(ts).toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Jerusalem' });
  const todayKey = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jerusalem' }).format(new Date());

  const store = {
    get(key, fallback) {
      try { const v = JSON.parse(localStorage.getItem(key)); return v ?? fallback; } catch { return fallback; }
    },
    set(key, value) { localStorage.setItem(key, JSON.stringify(value)); },
  };

  const ETA_OPTIONS = [5, 10, 15, 20, 30, 45];
  const STATUS = {
    new: { label: 'ההזמנה התקבלה', emoji: '📝', step: 0 },
    preparing: { label: 'מכינים לך עכשיו', emoji: '👨‍🍳', step: 1 },
    ready: { label: 'ההזמנה מוכנה לאיסוף!', emoji: '🎉', step: 2 },
    picked_up: { label: 'בתיאבון!', emoji: '😋', step: 3 },
    cancelled: { label: 'ההזמנה בוטלה', emoji: '😕', step: -1 },
  };
  const STEPS = [['התקבלה', '📝'], ['בהכנה', '👨‍🍳'], ['מוכנה', '🎉'], ['נאספה', '✅']];

  let MENU = null;
  const builder = { bread: null, spreads: [], filling: null, qty: 1 };
  let cart = store.get('sc_cart', []);
  let favorites = store.get('sc_favorites', []);
  let eta = null;

  // ---------- menu helpers ----------
  const find = (cat, id) => MENU.menu[cat].find((x) => x.id === id);
  const available = (cat, id) => { const x = find(cat, id); return Boolean(x && x.available); };
  const sandwichKey = (s) => `s:${s.bread}|${[...s.spreads].sort().join(',')}|${s.filling || ''}`;

  function sandwichAvailable(s) {
    return available('breads', s.bread) && s.spreads.every((id) => available('spreads', id)) && (!s.filling || available('fillings', s.filling));
  }

  function sandwichText(s) {
    const bread = find('breads', s.bread)?.name || '';
    const filling = s.filling ? find('fillings', s.filling)?.name : '';
    const spreads = s.spreads.map((id) => find('spreads', id)?.name).filter(Boolean);
    return {
      title: [bread, filling].filter(Boolean).join(' · '),
      sub: spreads.length ? `ממרחים: ${spreads.join(', ')}` : 'בלי ממרחים',
    };
  }

  function itemPrice(item) {
    return item.type === 'sandwich' ? MENU.menu.prices.sandwich : find('drinks', item.drink)?.price || 0;
  }
  const cartCount = () => cart.reduce((n, i) => n + i.qty, 0);
  const cartTotal = () => cart.reduce((n, i) => n + itemPrice(i) * i.qty, 0);
  const saveCart = () => store.set('sc_cart', cart);

  // ---------- toast & fun ----------
  let toastTimer;
  function toast(msg) {
    const t = $('#toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('show'), 2200);
  }

  function confetti() {
    const colors = ['#ff6b4a', '#ffb43b', '#1fb57a', '#ff4d8d', '#7c5cff', '#38bdf8'];
    for (let i = 0; i < 70; i++) {
      const c = document.createElement('i');
      c.className = 'confetti';
      c.style.left = `${Math.random() * 100}vw`;
      c.style.background = colors[i % colors.length];
      c.style.animationDuration = `${1.8 + Math.random() * 1.6}s`;
      c.style.animationDelay = `${Math.random() * 0.4}s`;
      document.body.appendChild(c);
      setTimeout(() => c.remove(), 4000);
    }
  }

  function bump(el) {
    el.classList.remove('bump');
    void el.offsetWidth;
    el.classList.add('bump');
  }

  // ---------- builder ----------
  function optionButton(cat, item, selected) {
    return `<button type="button" class="opt" data-cat="${cat}" data-id="${esc(item.id)}" aria-pressed="${selected}" ${item.available ? '' : 'disabled'}>
      <img src="${esc(item.img)}" alt="" loading="lazy" />
      <span class="opt-name">${esc(item.name)}</span>
      <span class="check">✓</span>
      ${item.available ? '' : '<span class="sold-out">אזל</span>'}
    </button>`;
  }

  function renderBuilder() {
    const m = MENU.menu;
    $('#sandwichPrice').textContent = money(m.prices.sandwich);
    $('#breads').innerHTML = m.breads.map((b) => optionButton('breads', b, builder.bread === b.id)).join('');
    $('#spreads').innerHTML = m.spreads.map((s) => optionButton('spreads', s, builder.spreads.includes(s.id))).join('');
    $('#fillings').innerHTML = m.fillings.map((f) => optionButton('fillings', f, builder.filling === f.id)).join('');
    $('#qty').textContent = builder.qty;

    const ready = Boolean(builder.bread);
    $('#addSandwich').disabled = !ready;
    $('#saveFav').disabled = !ready;
    $('#addSandwich').textContent = ready ? `הוספה לסל · ${money(m.prices.sandwich * builder.qty)}` : 'הוספה לסל';
    if (ready) {
      const t = sandwichText(builder);
      $('#builderSummary').innerHTML = `🥪 <b>&nbsp;${esc(t.title)}</b>&nbsp;·&nbsp;${esc(t.sub)}`;
    } else {
      $('#builderSummary').textContent = 'בחרו לחם כדי להתחיל 👆';
    }
  }

  function onOptionClick(e) {
    const btn = e.target.closest('.opt');
    if (!btn || btn.disabled) return;
    const { cat, id } = btn.dataset;
    if (cat === 'breads') builder.bread = id;
    if (cat === 'fillings') builder.filling = builder.filling === id ? null : id;
    if (cat === 'spreads') {
      builder.spreads = builder.spreads.includes(id) ? builder.spreads.filter((x) => x !== id) : [...builder.spreads, id];
    }
    if (navigator.vibrate) navigator.vibrate(8);
    renderBuilder();
  }

  function addSandwichToCart(s, qty) {
    const item = { type: 'sandwich', bread: s.bread, spreads: [...s.spreads], filling: s.filling || null };
    const key = sandwichKey(item);
    const existing = cart.find((i) => i.type === 'sandwich' && sandwichKey(i) === key);
    if (existing) existing.qty = Math.min(20, existing.qty + qty);
    else cart.push({ ...item, qty });
    saveCart();
    renderCartBar();
  }

  // ---------- favorites ----------
  function renderFavorites() {
    const section = $('#favoritesSection');
    if (!favorites.length) { section.classList.add('hidden'); return; }
    section.classList.remove('hidden');
    $('#favorites').innerHTML = favorites.map((f, idx) => {
      const ok = sandwichAvailable(f);
      const t = sandwichText(f);
      const imgs = [find('breads', f.bread), f.filling && find('fillings', f.filling), ...f.spreads.slice(0, 2).map((id) => find('spreads', id))]
        .filter(Boolean).map((x) => `<img src="${esc(x.img)}" alt="" />`).join('');
      return `<div class="fav glass">
        <button type="button" class="fav-del" data-del="${idx}" aria-label="מחיקה">✕</button>
        <div class="fav-imgs">${imgs}</div>
        <div class="fav-label"><b>${esc(t.title)}</b><br><small>${esc(t.sub)}</small></div>
        <button type="button" class="btn primary" data-fav="${idx}" ${ok ? '' : 'disabled'}>${ok ? `+ לסל · ${money(MENU.menu.prices.sandwich)}` : 'חסר משהו כרגע'}</button>
      </div>`;
    }).join('');
  }

  function onFavoritesClick(e) {
    const del = e.target.closest('[data-del]');
    if (del) {
      favorites.splice(Number(del.dataset.del), 1);
      store.set('sc_favorites', favorites);
      renderFavorites();
      return;
    }
    const add = e.target.closest('[data-fav]');
    if (add && !add.disabled) {
      addSandwichToCart(favorites[Number(add.dataset.fav)], 1);
      bump(add);
      toast('הקבוע שלך בסל ⭐');
    }
  }

  function saveFavorite() {
    if (!builder.bread) return;
    const fav = { bread: builder.bread, spreads: [...builder.spreads], filling: builder.filling };
    if (favorites.some((f) => sandwichKey(f) === sandwichKey(fav))) { toast('הסנדוויץ\' הזה כבר שמור אצלך ⭐'); return; }
    favorites.unshift(fav);
    favorites = favorites.slice(0, 8);
    store.set('sc_favorites', favorites);
    renderFavorites();
    toast('נשמר כסנדוויץ\' קבוע ⭐');
  }

  // ---------- drinks ----------
  function renderDrinks() {
    $('#drinks').innerHTML = MENU.menu.drinks.map((d) => {
      const inCart = cart.find((i) => i.type === 'drink' && i.drink === d.id);
      const control = !d.available
        ? '<button type="button" class="btn ghost add-drink" disabled>אזל</button>'
        : inCart
          ? `<div class="stepper small"><button type="button" data-drink-minus="${esc(d.id)}">−</button><span>${inCart.qty}</span><button type="button" data-drink-plus="${esc(d.id)}">+</button></div>`
          : `<button type="button" class="btn ghost add-drink" data-drink-plus="${esc(d.id)}">+ הוספה</button>`;
      return `<div class="drink glass ${d.available ? '' : 'disabled'}">
        <img src="${esc(d.img)}" alt="${esc(d.name)}" loading="lazy" />
        <div class="drink-row"><span class="drink-name">${esc(d.name)}</span><span class="drink-price">${money(d.price)}</span></div>
        ${control}
      </div>`;
    }).join('');
  }

  function changeDrink(id, delta) {
    const idx = cart.findIndex((i) => i.type === 'drink' && i.drink === id);
    if (idx === -1 && delta > 0) cart.push({ type: 'drink', drink: id, qty: 1 });
    else if (idx !== -1) {
      cart[idx].qty = Math.min(20, cart[idx].qty + delta);
      if (cart[idx].qty <= 0) cart.splice(idx, 1);
    }
    saveCart();
    renderDrinks();
    renderCartBar();
  }

  // ---------- cart ----------
  function renderCartBar() {
    const bar = $('#cartBar');
    if (!cart.length) { bar.classList.add('hidden'); return; }
    bar.classList.remove('hidden');
    $('#cartBarInfo').textContent = `${cartCount()} פריטים · ${money(cartTotal())}`;
    bump($('#openCart'));
  }

  function renderCartList() {
    $('#cartList').innerHTML = cart.map((item, idx) => {
      let img, title, sub;
      if (item.type === 'sandwich') {
        const t = sandwichText(item);
        img = find('breads', item.bread)?.img;
        title = t.title; sub = t.sub;
      } else {
        const d = find('drinks', item.drink);
        img = d?.img; title = d?.name || ''; sub = 'שתייה';
      }
      return `<li class="cart-line">
        <img src="${esc(img || '')}" alt="" />
        <div class="desc"><b>${esc(title)}</b><small>${esc(sub)}</small></div>
        <div class="stepper small"><button type="button" data-line-minus="${idx}">−</button><span>${item.qty}</span><button type="button" data-line-plus="${idx}">+</button></div>
        <span class="line-price">${money(itemPrice(item) * item.qty)}</span>
      </li>`;
    }).join('') || '<li class="cart-line">הסל ריק</li>';
    $('#submitTotal').textContent = money(cartTotal());
    $('#submitOrder').disabled = !cart.length;
  }

  function onCartListClick(e) {
    const minus = e.target.closest('[data-line-minus]');
    const plus = e.target.closest('[data-line-plus]');
    if (!minus && !plus) return;
    const idx = Number((minus || plus).dataset.lineMinus ?? (minus || plus).dataset.linePlus);
    cart[idx].qty = Math.min(20, cart[idx].qty + (plus ? 1 : -1));
    if (cart[idx].qty <= 0) cart.splice(idx, 1);
    saveCart();
    renderCartList();
    renderCartBar();
    renderDrinks();
    if (!cart.length) closeSheet();
  }

  function openSheet() {
    renderCartList();
    renderEta();
    $('#formError').classList.add('hidden');
    $('#sheet').classList.remove('hidden');
    document.body.style.overflow = 'hidden';
  }
  function closeSheet() {
    $('#sheet').classList.add('hidden');
    document.body.style.overflow = '';
  }

  // ---------- ETA ----------
  function renderEta() {
    $('#etaChips').innerHTML = ETA_OPTIONS.map((m) => `<button type="button" class="chip" data-eta="${m}" aria-pressed="${eta === m && !$('#fEtaCustom').value}">${m} דק'</button>`).join('');
    $('#etaHint').textContent = eta === null ? '' : eta === 0 ? '🏃 אני כבר כאן!' : `⏰ נגיע בערך ב-${timeOf(Date.now() + eta * 60000)}`;
  }

  // ---------- submit ----------
  async function submitOrder(e) {
    e.preventDefault();
    const err = $('#formError');
    const showErr = (msg) => { err.textContent = msg; err.classList.remove('hidden'); };
    err.classList.add('hidden');

    const name = $('#fName').value.trim();
    const phone = $('#fPhone').value.replace(/\D/g, '');
    if (!name) return showErr('נא למלא שם');
    if (!/^0\d{8,9}$/.test(phone)) return showErr('נא למלא מספר טלפון תקין');
    if (eta === null) return showErr('נא לבחור בעוד כמה דקות תגיעו');

    const btn = $('#submitOrder');
    btn.disabled = true;
    btn.firstElementChild.textContent = 'שולחים...';
    try {
      const res = await fetch('/api/orders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name, phone, notes: $('#fNotes').value, etaMinutes: eta,
          items: cart.map((i) => (i.type === 'sandwich'
            ? { type: 'sandwich', bread: i.bread, spreads: i.spreads, filling: i.filling, qty: i.qty }
            : { type: 'drink', drink: i.drink, qty: i.qty })),
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        if (data.menuChanged) await refreshMenuAfterChange();
        return showErr(data.error || 'משהו השתבש, נסו שוב');
      }
      store.set('sc_profile', { name, phone });
      const mine = myOrders();
      mine.ids.push(data.id);
      store.set('sc_orders', mine);
      cart = [];
      saveCart();
      $('#fNotes').value = '';
      eta = null;
      $('#fEtaCustom').value = '';
      closeSheet();
      renderAll();
      confetti();
      showStatus(data.id, data);
    } catch {
      showErr('אין חיבור לשרת, נסו שוב');
    } finally {
      btn.disabled = !cart.length;
      btn.firstElementChild.textContent = 'שליחת הזמנה';
    }
  }

  async function refreshMenuAfterChange() {
    await loadMenu();
    const before = cart.length;
    cart = cart.filter((i) => (i.type === 'sandwich' ? sandwichAvailable(i) : available('drinks', i.drink)));
    saveCart();
    renderAll();
    renderCartList();
    if (cart.length !== before) toast('חלק מהפריטים אזלו והוסרו מהסל');
  }

  // ---------- order status ----------
  function myOrders() {
    const saved = store.get('sc_orders', null);
    return saved && saved.day === todayKey() ? saved : { day: todayKey(), ids: [] };
  }

  const orderCache = {};
  let currentOrderId = null;
  let stream = null;

  function showStatus(id, initial) {
    currentOrderId = id;
    if (initial) orderCache[id] = initial;
    $('#statusView').classList.remove('hidden');
    document.body.style.overflow = 'hidden';
    renderStatus();
    if (stream) stream.close();
    stream = new EventSource(`/api/orders/${encodeURIComponent(id)}/stream`);
    stream.addEventListener('order', (ev) => {
      const o = JSON.parse(ev.data);
      const prev = orderCache[o.id];
      orderCache[o.id] = o;
      if (prev && prev.status !== o.status && o.status === 'ready') {
        if (navigator.vibrate) navigator.vibrate([200, 100, 200, 100, 300]);
        confetti();
        toast('ההזמנה שלך מוכנה! 🎉');
      }
      if (o.id === currentOrderId) renderStatus();
    });
    stream.onerror = async () => {
      const res = await fetch(`/api/orders/${encodeURIComponent(id)}`).catch(() => null);
      if (res && res.status === 404) {
        stream.close();
        const mine = myOrders();
        mine.ids = mine.ids.filter((x) => x !== id);
        store.set('sc_orders', mine);
        hideStatus();
        renderMyOrdersBtn();
      }
    };
  }

  function hideStatus() {
    if (stream) { stream.close(); stream = null; }
    currentOrderId = null;
    $('#statusView').classList.add('hidden');
    document.body.style.overflow = '';
  }

  function itemLine(i) {
    if (i.type === 'drink') return `${i.qty}× ${esc(i.drink.name)}`;
    const parts = [i.bread.name, i.filling && i.filling.name].filter(Boolean).join(' · ');
    const spreads = i.spreads.length ? ` <small>(${esc(i.spreads.map((s) => s.name).join(', '))})</small>` : '';
    return `${i.qty}× 🥪 ${esc(parts)}${spreads}`;
  }

  function renderStatus() {
    const o = orderCache[currentOrderId];
    const mine = myOrders();
    $('#statusTabs').innerHTML = mine.ids.length > 1
      ? mine.ids.map((id) => `<button type="button" class="chip" data-order="${esc(id)}" aria-pressed="${id === currentOrderId}">#${orderCache[id]?.number ?? '…'}</button>`).join('')
      : '';
    if (!o) { $('#statusBody').innerHTML = '<p>טוען...</p>'; return; }

    const st = STATUS[o.status] || STATUS.new;
    let body = `
      <div class="status-emoji ${o.status === 'ready' ? 'dance' : ''}">${st.emoji}</div>
      <div class="order-num">מספר הזמנה<b>#${o.number}</b></div>
      <div class="status-text">${st.label}</div>`;

    if (o.status === 'cancelled') {
      body += '<div class="cancelled-box">ההזמנה בוטלה. לשאלות אפשר לפנות לעגלה.</div>';
    } else {
      const pct = (st.step / (STEPS.length - 1)) * 100;
      body += `<div class="progress"><div class="fill" style="width:calc((100% - 32px) * ${pct / 100})"></div>
        ${STEPS.map(([label, icon], i) => `<div class="p-step ${i <= st.step ? 'done' : ''} ${i === st.step ? 'current' : ''}"><span class="p-dot">${i < st.step ? '✓' : icon}</span>${label}</div>`).join('')}
      </div>`;
      if (o.status !== 'picked_up') body += etaRing(o);
    }

    body += `<ul class="status-items">${o.items.map((i) => `<li>${itemLine(i)}</li>`).join('')}</ul>
      <div class="status-total"><span>לתשלום באיסוף</span><span>${money(o.total)}</span></div>`;
    $('#statusBody').innerHTML = body;
  }

  function etaRing(o) {
    const now = Date.now();
    const span = Math.max(1, o.arriveAt - o.createdAt);
    const frac = Math.min(1, Math.max(0, (now - o.createdAt) / span));
    const left = Math.ceil((o.arriveAt - now) / 60000);
    const C = 2 * Math.PI * 22;
    const title = left > 0 ? `מגיעים בעוד ${left} דק'` : 'הגיע הזמן לבוא לאסוף 🏃';
    return `<div class="eta-ring">
      <svg viewBox="0 0 54 54"><circle class="track" cx="27" cy="27" r="22" fill="none" stroke-width="6"/><circle class="val" cx="27" cy="27" r="22" fill="none" stroke-width="6" stroke-dasharray="${C}" stroke-dashoffset="${C * (1 - frac)}"/></svg>
      <div class="txt"><b>${title}</b><span>שעת איסוף משוערת ${timeOf(o.arriveAt)}</span></div>
    </div>`;
  }

  function renderMyOrdersBtn() {
    $('#myOrdersBtn').classList.toggle('hidden', myOrders().ids.length === 0);
  }

  // ---------- init ----------
  async function loadMenu() {
    const res = await fetch('/api/menu');
    MENU = await res.json();
    document.title = MENU.shopName;
    $('#shopName').textContent = MENU.shopName;
  }

  function renderAll() {
    renderBuilder();
    renderFavorites();
    renderDrinks();
    renderCartBar();
    renderMyOrdersBtn();
  }

  function bindEvents() {
    for (const id of ['#breads', '#spreads', '#fillings']) $(id).addEventListener('click', onOptionClick);
    $('#qtyMinus').addEventListener('click', () => { builder.qty = Math.max(1, builder.qty - 1); renderBuilder(); });
    $('#qtyPlus').addEventListener('click', () => { builder.qty = Math.min(20, builder.qty + 1); renderBuilder(); });
    $('#addSandwich').addEventListener('click', () => {
      if (!builder.bread) return;
      addSandwichToCart(builder, builder.qty);
      toast(builder.qty > 1 ? `${builder.qty} סנדוויצ'ים נוספו לסל 🥪` : 'הסנדוויץ\' נוסף לסל 🥪');
      Object.assign(builder, { bread: null, spreads: [], filling: null, qty: 1 });
      renderBuilder();
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
    $('#newOrderBtn').addEventListener('click', hideStatus);

    setInterval(() => { if (currentOrderId) renderStatus(); }, 15000);
  }

  async function init() {
    const profile = store.get('sc_profile', null);
    if (profile) {
      $('#fName').value = profile.name || '';
      $('#fPhone').value = profile.phone || '';
    }
    bindEvents();
    for (;;) {
      try {
        await loadMenu();
        break;
      } catch {
        toast('אין חיבור לשרת, מנסים שוב...');
        await new Promise((r) => setTimeout(r, 3000));
      }
    }
    cart = cart.filter((i) => (i.type === 'sandwich' ? find('breads', i.bread) : find('drinks', i.drink)));
    saveCart();
    renderAll();

    const mine = myOrders();
    store.set('sc_orders', mine);
    await Promise.all(mine.ids.map(async (id) => {
      const res = await fetch(`/api/orders/${encodeURIComponent(id)}`).catch(() => null);
      if (res && res.ok) orderCache[id] = await res.json();
    }));
    const active = mine.ids.filter((id) => orderCache[id] && !['picked_up', 'cancelled'].includes(orderCache[id].status));
    mine.ids = mine.ids.filter((id) => orderCache[id]);
    store.set('sc_orders', mine);
    renderMyOrdersBtn();
    if (active.length) showStatus(active[active.length - 1]);
  }

  init();
})();
