(() => {
  const $ = (sel, el = document) => el.querySelector(sel);
  const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const money = (n) => `${n} ₪`;
  const minus = (n) => `<bdi dir="ltr">−${money(n)}</bdi>`;
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

  // ETA options will be generated dynamically based on minEta from menu
  function getEtaOptions() {
    const minEta = MENU?.menu?.promos?.minEta || 10;
    const options = [];
    for (let t = minEta; t <= minEta + 25; t += 5) {
      options.push(t);
    }
    return options;
  }
  const STATUS = {
    new: { label: 'ההזמנה התקבלה', sub: 'העגלה קיבלה את ההזמנה שלך ותתחיל להכין בקרוב', emoji: '📨', step: 0, mood: 'sent' },
    preparing: { label: 'מכינים לך עכשיו', sub: 'הסנדוויץ\' שלך על הקרש 🔪', emoji: '👨‍🍳', step: 1, mood: 'cooking' },
    ready: { label: 'מוכן לאיסוף!', sub: 'ההזמנה מחכה לך בעגלה', emoji: '🎉', step: 2, mood: 'party' },
    picked_up: { label: 'בתיאבון!', sub: 'תודה שהזמנת, נתראה בפעם הבאה', emoji: '😋', step: 3, mood: 'done' },
    cancelled: { label: 'ההזמנה בוטלה', sub: 'לשאלות אפשר לפנות לעגלה', emoji: '😕', step: -1, mood: 'sad' },
  };
  const STEPS = [['התקבלה', '📨'], ['בהכנה', '🔥'], ['מוכן', '🎉'], ['נאסף', '😋']];

  let MENU = null;
  const builder = { product: null, picks: {}, qty: 1 };
  const keepItem = (i) => (i && (i.type === 'food' || i.type === 'drink') ? { ...i, picks: i.picks || {} } : null);
  let cart = store.get('sc_cart', []).map(keepItem).filter(Boolean);
  let favorites = store.get('sc_favorites', []).map(keepItem).filter((i) => i && i.type === 'food');
  let eta = null;
  let loyaltyState = null;
  let useReward = true;

  // ---------- menu helpers ----------
  const productOf = (id) => MENU && MENU.menu.products.find((p) => p.id === id);
  const drinkOf = (id) => MENU && MENU.menu.drinks.find((d) => d.id === id);
  const groupItem = (group, id) => group.items.find((x) => x.id === id);
  const sortedIds = (list) => [...(list || [])].sort().join(',');
  const foodKey = (s) => {
    const product = productOf(s.product);
    const parts = product ? product.groups.map((g) => `${g.id}:${sortedIds(s.picks[g.id])}`) : [];
    return `f:${s.product}|${parts.join('|')}`;
  };

  function foodPrice(productId, picks) {
    const product = productOf(productId);
    if (!product) return 0;
    let price = product.price || 0;
    for (const g of product.groups) {
      const ids = (picks[g.id] || []).filter((id) => groupItem(g, id));
      if (g.pricedBase) price += groupItem(g, ids[0])?.price || 0;
      else if (g.extraPrice > 0) price += Math.max(0, ids.length - (g.included || 0)) * g.extraPrice;
    }
    return price;
  }

  function foodBase(productId, picks) {
    const product = productOf(productId);
    if (!product) return 0;
    if (product.price != null) return product.price;
    const bread = product.groups.find((g) => g.pricedBase);
    const id = bread && (picks[bread.id] || [])[0];
    return (bread && groupItem(bread, id)?.price) || 0;
  }

  function foodReady(productId, picks) {
    const product = productOf(productId);
    if (!product) return false;
    return product.groups.every((g) => {
      const ids = (picks[g.id] || []).filter((id) => groupItem(g, id)?.available);
      if ((picks[g.id] || []).length !== ids.length) return false;
      if (ids.length < (g.min || 0)) return false;
      if (g.max != null && ids.length > g.max) return false;
      return true;
    });
  }

  function foodText(s) {
    const product = productOf(s.product);
    if (!product) return { title: '', sub: '', img: '' };
    const parts = [];
    let img = '';
    for (const g of product.groups) {
      const chosen = (s.picks[g.id] || []).map((id) => groupItem(g, id)).filter(Boolean);
      if (!img && chosen[0]) img = chosen[0].img;
      if (chosen.length) parts.push(`${g.name}: ${chosen.map((x) => x.name).join(', ')}`);
    }
    return { title: product.name, sub: parts.join(' · ') || 'בלי תוספות', img: img || '/img/placeholder.svg' };
  }

  function groupHint(g) {
    const parts = [];
    if (g.mode === 'single') parts.push(g.min ? 'חובה · בחירה אחת' : 'בחירה אחת');
    else if (g.max) parts.push(g.min ? `חובה · עד ${g.max}` : `עד ${g.max}`);
    else parts.push(g.min ? 'חובה · אפשר כמה' : 'אפשר כמה');
    if (g.extraPrice > 0 && (g.included || 0) > 0) parts.push(`הראשון כלול · כל נוספת ${g.extraPrice} ₪`);
    else if (g.extraPrice > 0) parts.push(`${g.extraPrice} ₪`);
    return parts.join(' · ');
  }

  const itemPrice = (item) => (item.type === 'food' ? foodPrice(item.product, item.picks) : drinkOf(item.drink)?.price || 0);
  const cartCount = () => cart.reduce((n, i) => n + i.qty, 0);

  // Mirrors the server's pricing; the server's numbers are what the order is actually charged.
  function cartTotals() {
    const promos = MENU.menu.promos || { comboDiscount: 0 };
    const subtotal = cart.reduce((n, i) => n + itemPrice(i) * i.qty, 0);
    const sandwiches = cart.reduce((n, i) => n + (i.type === 'food' ? i.qty : 0), 0);
    const drinks = cart.reduce((n, i) => n + (i.type === 'drink' ? i.qty : 0), 0);
    const bases = cart.filter((i) => i.type === 'food').map((i) => foodBase(i.product, i.picks));
    const reward = useReward && loyaltyState && loyaltyState.rewardReady && bases.length ? Math.min(...bases) : 0;
    const combo = Math.max(0, Math.min(sandwiches - (reward ? 1 : 0), drinks)) * promos.comboDiscount;
    return { subtotal, combo, reward, total: Math.max(0, subtotal - combo - reward), sandwiches, drinks };
  }
  const cartTotal = () => cartTotals().total;
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
  function optionButton(group, item, i) {
    const badge = group.pricedBase ? money(item.price) : (group.extraPrice > 0 && !(group.included > 0) ? `+${money(group.extraPrice)}` : '');
    return `<button type="button" class="opt" style="--i:${i}" data-group="${esc(group.id)}" data-id="${esc(item.id)}" aria-pressed="false" ${item.available ? '' : 'disabled'}>
      <span class="opt-img"><img src="${esc(item.img)}" alt="" loading="lazy" /></span>
      <span class="opt-name">${esc(item.name)}</span>
      ${badge ? `<span class="opt-price">${badge}</span>` : ''}
      <span class="check">✓</span>
      ${item.available ? '' : '<span class="sold-out">אזל</span>'}
    </button>`;
  }

  function productLabel(p) {
    if (p.price != null) return money(p.price);
    const breads = p.groups.find((g) => g.pricedBase);
    const prices = (breads ? breads.items : []).map((i) => i.price).filter((n) => Number.isFinite(n));
    return prices.length ? `מ-${money(Math.min(...prices))}` : '';
  }

  function renderBuilderOptions() {
    const products = MENU.menu.products;
    if (builder.product && !productOf(builder.product)) builder.product = null;
    const product = productOf(builder.product);
    $('#productSwitch').innerHTML = products.map((p) => `<div class="product-card" data-product="${esc(p.id)}" aria-pressed="${p.id === builder.product}" role="button" tabindex="0">
      <div class="product-card-img"><img src="/img/${esc(p.id)}.jpg" alt="${esc(p.name)}" loading="lazy" /></div>
      <div class="product-card-body">
        <div class="product-card-name">${esc(p.name)}</div>
        <div class="product-card-price">${productLabel(p)}</div>
      </div>
    </div>`).join('');
    $('#builderTitle').textContent = product ? product.name : 'מה תרצו לאכול היום?';
    for (const g of product?.groups || []) {
      builder.picks[g.id] = (builder.picks[g.id] || []).filter((id) => groupItem(g, id)?.available);
    }
    const cols = (n) => (n <= 3 ? 'cols-3' : 'cols-4');
    $('#builderSteps').innerHTML = (product?.groups || []).map((g, idx) => `<div class="step">
      <div class="step-title"><span class="step-num" data-group="${esc(g.id)}"><i>${idx + 1}</i></span> ${esc(g.name)} <small>${esc(groupHint(g))}</small></div>
      <div class="options ${cols(g.items.length)}">${g.items.map((item, i) => optionButton(g, item, i)).join('')}</div>
    </div>`).join('');
    syncBuilder();
  }

  function isSelected(groupId, id) {
    return (builder.picks[groupId] || []).includes(id);
  }

  function syncBuilder() {
    const product = productOf(builder.product);
    for (const btn of $$('.builder .opt')) btn.setAttribute('aria-pressed', String(isSelected(btn.dataset.group, btn.dataset.id)));
    for (const el of $$('.step-num')) {
      const done = (builder.picks[el.dataset.group] || []).length > 0;
      if (done && !el.classList.contains('done')) replay(el, 'pop');
      el.classList.toggle('done', done);
    }
    $('#qty').textContent = builder.qty;
    const ready = foodReady(builder.product, builder.picks);
    // Handle case when no product is selected
    if (!product) {
      $('#sandwichPrice').textContent = '';
      $('#addSandwich').disabled = true;
      $('#saveFav').disabled = true;
      $('#addSandwich').textContent = 'הוספה לסל';
      renderTray();
      return;
    }
    $('#sandwichPrice').textContent = ready || product.price != null ? money(ready ? foodPrice(builder.product, builder.picks) : product.price) : productLabel(product);
    $('#addSandwich').disabled = !ready;
    $('#saveFav').disabled = !ready;
    $('#addSandwich').textContent = ready ? `הוספה לסל · ${money(foodPrice(builder.product, builder.picks) * builder.qty)}` : 'הוספה לסל';
    if (!ready && product.price == null) $('#sandwichPrice').textContent = productLabel(product);
    renderTray();
  }

  function trayItems() {
    const product = productOf(builder.product);
    const items = [];
    if (!product) return items;
    for (const g of product.groups) {
      for (const id of builder.picks[g.id] || []) {
        const item = groupItem(g, id);
        if (item) items.push({ key: `${g.id}:${id}`, ...item });
      }
    }
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
    const product = productOf(builder.product);
    const group = product.groups.find((g) => g.id === btn.dataset.group);
    const id = btn.dataset.id;
    const current = builder.picks[group.id] || [];
    const firstPick = current.length === 0;
    if (group.mode === 'single' || group.max === 1) {
      builder.picks[group.id] = current[0] === id ? (group.min ? current : []) : [id];
    } else if (current.includes(id)) {
      builder.picks[group.id] = current.filter((x) => x !== id);
    } else if (group.max != null && current.length >= group.max) {
      notify('✋', `אפשר לבחור עד ${group.max}`, group.name);
      return;
    } else {
      builder.picks[group.id] = [...current, id];
    }
    vibrate(8);
    syncBuilder();
    if (isSelected(group.id, id)) replay(btn, 'just');
    if (firstPick && group === product.groups[0] && !reduceMotion) {
      const next = btn.closest('.step')?.nextElementSibling;
      if (next) replay(next, 'nudge');
    }
  }

  function addFoodToCart(productId, picks, qty) {
    const item = { type: 'food', product: productId, picks: structuredClone(picks) };
    const key = foodKey(item);
    const existing = cart.find((i) => i.type === 'food' && foodKey(i) === key);
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
  function favImages(f) {
    const product = productOf(f.product);
    if (!product) return '';
    const imgs = [];
    for (const g of product.groups) {
      for (const id of f.picks[g.id] || []) {
        const item = groupItem(g, id);
        if (item) imgs.push(item);
      }
    }
    return imgs.slice(0, 5).map((x) => `<img src="${esc(x.img)}" alt="" />`).join('');
  }

  function renderFavorites() {
    const section = $('#favoritesSection');
    if (!favorites.length) { section.classList.add('hidden'); return; }
    section.classList.remove('hidden');
    $('#favorites').innerHTML = favorites.map((f, idx) => {
      const ok = foodReady(f.product, f.picks);
      const t = foodText(f);
      return `<div class="fav glass" style="--i:${idx}">
        <button type="button" class="fav-del" data-del="${idx}" aria-label="מחיקה">✕</button>
        <div class="fav-imgs">${favImages(f)}</div>
        <div class="fav-label"><b>${esc(t.title)}</b><br><small>${esc(t.sub)}</small></div>
        <button type="button" class="btn primary" data-fav="${idx}" ${ok ? '' : 'disabled'}>${ok ? `+ לסל · ${money(foodPrice(f.product, f.picks))}` : 'חסר משהו כרגע'}</button>
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
      const fav = favorites[Number(add.dataset.fav)];
      addFoodToCart(fav.product, fav.picks, 1);
      replay(add, 'bump');
      vibrate(15);
      notify('⭐', 'הקבוע שלך בסל');
      afterAdd($$('.fav-imgs img', add.closest('.fav')));
    }
  }

  function saveFavorite() {
    if (!foodReady(builder.product, builder.picks)) return;
    const fav = { type: 'food', product: builder.product, picks: structuredClone(builder.picks) };
    if (favorites.some((f) => foodKey(f) === foodKey(fav))) { notify('⭐', 'כבר שמור אצלך'); return; }
    favorites.unshift(fav);
    favorites = favorites.slice(0, 8);
    store.set('sc_favorites', favorites);
    renderFavorites();
    replay($('#favoritesSection'), 'nudge');
    notify('⭐', 'נשמר כמנה קבועה', 'בפעם הבאה מזמינים בלחיצה אחת');
  }

  // ---------- drinks ----------
  function drinkCard(d, i) {
    try {
      const inCart = cart.find((x) => x.type === 'drink' && x.drink === d.id);
      const qtyControl = inCart ? `
        <div class="drink-qty-panel">
          <div class="stepper">
            <button type="button" data-drink-minus="${esc(d.id)}">−</button>
            <span>${inCart.qty}</span>
            <button type="button" data-drink-plus="${esc(d.id)}">+</button>
          </div>
        </div>` : '';
      return `<div class="drink glass ${d.available ? '' : 'disabled'} ${inCart ? 'in-cart' : ''}" style="--i:${i}" data-drink="${esc(d.id)}" data-drink-add="${esc(d.id)}">
        ${inCart ? `<span class="drink-badge">${inCart.qty}</span>` : ''}
        <span class="drink-img"><img src="${esc(d.img)}" alt="${esc(d.name)}" loading="lazy" /></span>
        <div class="drink-row"><span class="drink-name">${esc(d.name)}</span><span class="drink-price">${money(d.price)}</span></div>
        ${!d.available ? '<span class="drink-unavailable">אזל</span>' : ''}
        ${qtyControl}
      </div>`;
    } catch (err) {
      console.error('drinkCard error:', err, 'drink:', d);
      return `<div class="drink" style="background:red;color:white;padding:10px">שגיאה בשתייה: ${d?.name || 'unknown'}</div>`;
    }
  }

  function renderDrinks(changedId) {
    console.log('renderDrinks called, MENU:', MENU);
    if (!MENU || !MENU.menu) {
      console.error('MENU or MENU.menu is null/undefined');
      $('#drinks').innerHTML = '<p style="color:red">שגיאה: תפריט לא נטען</p>';
      return;
    }
    if (!MENU.menu.drinks || !MENU.menu.drinks.length) {
      console.error('No drinks in menu:', MENU.menu.drinks);
      $('#drinks').innerHTML = '<p style="color:red">שגיאה: אין שתיות בתפריט</p>';
      return;
    }
    const groups = MENU.menu.drinkGroups || [];
    let html = '';
    let i = 0;
    const used = new Set();
    for (const g of groups) {
      const list = MENU.menu.drinks.filter((d) => d.group === g.id);
      if (!list.length) continue;
      list.forEach((d) => used.add(d.id));
      html += `<h4 class="drink-group">${esc(g.name)}</h4>${list.map((d) => drinkCard(d, i++)).join('')}`;
    }
    const rest = MENU.menu.drinks.filter((d) => !used.has(d.id));
    if (rest.length) html += `<h4 class="drink-group">עוד</h4>${rest.map((d) => drinkCard(d, i++)).join('')}`;
    console.log('Drinks HTML length:', html.length, 'Total drinks rendered:', i);
    $('#drinks').innerHTML = html;
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
      if (item.type === 'food') {
        const t = foodText(item);
        img = t.img; title = t.title; sub = t.sub;
      } else {
        const d = drinkOf(item.drink);
        img = d?.img; title = d?.name || ''; sub = 'שתייה';
      }
      return `<li class="cart-line" style="--i:${idx}" data-line="${idx}">
        <img src="${esc(img || '')}" alt="" />
        <div class="desc"><b>${esc(title)}</b><small>${esc(sub)}</small></div>
        <div class="stepper small"><button type="button" data-line-minus="${idx}">−</button><span>${item.qty}</span><button type="button" data-line-plus="${idx}">+</button></div>
        <span class="line-price">${money(itemPrice(item) * item.qty)}</span>
      </li>`;
    }).join('');
    renderCartPromos();
    countTo($('#submitTotal'), cartTotal(), money);
    $('#submitOrder').disabled = !cart.length;
  }

  function renderCartPromos() {
    const t = cartTotals();
    const comboOff = (MENU.menu.promos || {}).comboDiscount || 0;
    const promos = [];
    if (loyaltyState && loyaltyState.rewardReady && t.sandwiches > 0) {
      promos.push(`<label class="promo reward ${useReward ? 'on' : ''}">
        <input type="checkbox" id="useReward" ${useReward ? 'checked' : ''} />
        <span class="promo-ico">🎁</span>
        <span><b>מגיע לך מנה חינם!</b><small>${useReward ? 'ממומש בהזמנה הזאת' : 'לחצו כדי לממש עכשיו'}</small></span>
      </label>`);
    }
    if (comboOff > 0 && t.sandwiches > t.drinks && t.sandwiches - (t.reward ? 1 : 0) > t.drinks) {
      promos.push(`<button type="button" class="promo nudge-drink" data-scroll-drinks>
        <span class="promo-ico">🥤</span>
        <span><b>הוסיפו שתייה וחסכו ${money(comboOff)}</b><small>קומבו: על כל מנה + שתייה</small></span>
        <span class="go">לשתייה</span>
      </button>`);
    }
    $('#cartPromos').innerHTML = promos.join('');

    const rows = [];
    if (t.combo || t.reward) rows.push(`<div class="row"><span>סכום ביניים</span><span>${money(t.subtotal)}</span></div>`);
    if (t.combo) rows.push(`<div class="row save"><span>🔥 הנחת קומבו</span><span>${minus(t.combo)}</span></div>`);
    if (t.reward) rows.push(`<div class="row save"><span>🎁 מנה חינם</span><span>${minus(t.reward)}</span></div>`);
    if (t.combo || t.reward) rows.push(`<div class="saved-pill">חסכת ${money(t.combo + t.reward)} 🎉</div>`);
    const box = $('#cartTotals');
    const html = rows.join('');
    if (box.innerHTML !== html) {
      const hadSavings = box.querySelector('.saved-pill');
      box.innerHTML = html;
      const pill = box.querySelector('.saved-pill');
      if (pill && !hadSavings) replay(pill, 'pop');
    }
  }

  function renderComboBanner() {
    const off = (MENU.menu.promos || {}).comboDiscount || 0;
    const el = $('#comboBanner');
    el.classList.toggle('hidden', off <= 0);
    if (off > 0) el.innerHTML = `<span class="cb-ico">🔥</span><span><b>קומבו!</b> מנה + שתייה = ${money(off)} הנחה</span>`;
  }

  // ---------- loyalty stamp card ----------
  async function refreshLoyalty(phone) {
    phone = String(phone || '').replace(/\D/g, '');
    if (!/^0\d{8,9}$/.test(phone)) { loyaltyState = null; renderLoyalty(); return; }
    try {
      const res = await fetch(`/api/loyalty/${phone}`);
      if (!res.ok) return;
      const prev = loyaltyState;
      loyaltyState = { ...(await res.json()), phone };
      renderLoyalty(prev);
      if (!$('#sheet').classList.contains('hidden')) { renderCartPromos(); countTo($('#submitTotal'), cartTotal(), money); }
      renderCartBar(false);
    } catch { /* offline */ }
  }

  function renderLoyalty(prev) {
    const el = $('#loyaltyCard');
    const goal = (MENU && MENU.menu.promos && MENU.menu.promos.loyaltyGoal) || 0;
    if (!goal) { el.classList.add('hidden'); return; }
    el.classList.remove('hidden');
    const s = loyaltyState;
    if (!s) {
      el.dataset.state = 'teaser';
      el.innerHTML = `<div class="lc-head"><span class="lc-ico">🎟️</span><div><b>${goal === 10 ? 'כל מנה עשירית עלינו!' : `כל ${goal} מנות, אחת עלינו!`}</b><small>הכרטיסייה נפתחת אוטומטית בהזמנה הראשונה, לפי מספר הטלפון</small></div></div>`;
      return;
    }
    const ready = s.rewardReady;
    const filled = ready ? goal : s.stamps % goal;
    el.dataset.state = ready ? 'ready' : 'progress';
    const stamps = Array.from({ length: goal }, (_, i) => {
      const on = i < filled;
      const fresh = prev && prev.phone === s.phone && on && i >= (prev.rewardReady ? goal : prev.stamps % goal);
      return `<span class="stamp ${on ? 'on' : ''} ${fresh ? 'fresh' : ''}" style="--i:${i}">${i === goal - 1 ? '🎁' : on ? '🥪' : ''}</span>`;
    }).join('');
    const left = goal - filled;
    el.innerHTML = `
      <div class="lc-head"><span class="lc-ico">🎟️</span><div>
        <b>${ready ? 'מגיע לך מנה חינם! 🎉' : 'הכרטיסייה שלי'}</b>
        <small>${ready ? 'ממומש אוטומטית בהזמנה הבאה' : `עוד ${left} ${left === 1 ? 'מנה' : 'מנות'} והבאה עלינו`}</small>
      </div><span class="lc-count">${filled}/${goal}</span></div>
      <div class="stamps">${stamps}</div>`;
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
    const options = getEtaOptions();
    const minEta = MENU?.menu?.promos?.minEta || 10;
    $('#etaChips').innerHTML = options.map((m) => `<button type="button" class="chip" data-eta="${m}" aria-pressed="${eta === m && !$('#fEtaCustom').value}">${m} דק'</button>`).join('');
    const customInput = $('#fEtaCustom');
    customInput.min = minEta;
    customInput.placeholder = `מ-${minEta} דקות`;
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
            useReward: cartTotals().reward > 0 && loyaltyState.phone === phone,
            items: cart.map((i) => (i.type === 'food'
              ? { type: 'food', product: i.product, picks: i.picks, qty: i.qty }
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
        if (data.loyaltyChanged) { await refreshLoyalty(phone); renderCartList(); renderCartBar(false); }
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
    refreshLoyalty(phone);
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
    cart = cart.filter((i) => (i.type === 'food' ? foodReady(i.product, i.picks) : Boolean(drinkOf(i.drink)?.available)));
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
      } else if (o.status === 'picked_up' && o.stampsEarned > 0) {
        vibrate(60);
        notify('🎟️', `+${o.stampsEarned} ניקובים בכרטיסייה`, 'בתיאבון! 😋', 4000);
        refreshLoyalty(store.get('sc_profile', {}).phone);
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
    if (i.type === 'food') {
      const bits = (i.groups || []).flatMap((g) => g.items.map((x) => x.name));
      const small = bits.length ? ` <small>(${esc(bits.join(', '))})</small>` : '';
      return `<span class="q">${i.qty}×</span> ${i.product.emoji || '🍽️'} ${esc(i.product.name)}${small}`;
    }
    const parts = [i.bread?.name, i.filling && i.filling.name].filter(Boolean).join(' · ');
    return `<span class="q">${i.qty}×</span> 🥪 ${esc(parts)}`;
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
      ${o.discounts && o.discounts.combo ? `<div class="status-save"><span>🔥 הנחת קומבו</span><span>${minus(o.discounts.combo)}</span></div>` : ''}
      ${o.discounts && o.discounts.reward ? `<div class="status-save"><span>🎁 מנה חינם</span><span>${minus(o.discounts.reward)}</span></div>` : ''}
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
    renderComboBanner();
    renderLoyalty();
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
    $('#builderSteps').addEventListener('click', onOptionClick);
    $('#productSwitch').addEventListener('click', (e) => {
      const btn = e.target.closest('[data-product]');
      if (!btn || btn.dataset.product === builder.product) return;
      builder.product = btn.dataset.product;
      builder.picks = {};
      builder.qty = 1;
      vibrate(8);
      renderBuilderOptions();
    });
    $('#qtyMinus').addEventListener('click', () => { builder.qty = Math.max(1, builder.qty - 1); syncBuilder(); replay($('#qty'), 'pop'); });
    $('#qtyPlus').addEventListener('click', () => { builder.qty = Math.min(20, builder.qty + 1); syncBuilder(); replay($('#qty'), 'pop'); });
    $('#addSandwich').addEventListener('click', () => {
      if (!foodReady(builder.product, builder.picks)) return;
      const sources = $$('#tray .ing:not(.leaving) img');
      const name = productOf(builder.product)?.name || 'המנה';
      addFoodToCart(builder.product, builder.picks, builder.qty);
      vibrate(20);
      notify('🧺', builder.qty > 1 ? `${builder.qty} ${name} נוספו לסל` : `${name} נוסף לסל`);
      afterAdd(sources);
      builder.picks = {};
      builder.qty = 1;
      syncBuilder();
    });
    $('#saveFav').addEventListener('click', saveFavorite);
    $('#favorites').addEventListener('click', onFavoritesClick);
    $('#drinks').addEventListener('click', (e) => {
      const plus = e.target.closest('[data-drink-plus]');
      const minus = e.target.closest('[data-drink-minus]');
      if (plus) { e.stopPropagation(); changeDrink(plus.dataset.drinkPlus, 1); return; }
      if (minus) { e.stopPropagation(); changeDrink(minus.dataset.drinkMinus, -1); return; }
      // Click on card itself to add drink
      const card = e.target.closest('[data-drink-add]');
      if (card && !card.classList.contains('disabled') && !card.classList.contains('in-cart')) {
        changeDrink(card.dataset.drinkAdd, 1);
      }
    });

    $('#openCart').addEventListener('click', openSheet);
    $('#sheet').addEventListener('click', (e) => { if (e.target.closest('[data-close]')) closeSheet(); });
    $('#cartList').addEventListener('click', onCartListClick);
    $('#cartPromos').addEventListener('change', (e) => {
      if (e.target.id !== 'useReward') return;
      useReward = e.target.checked;
      vibrate(10);
      renderCartPromos();
      countTo($('#submitTotal'), cartTotal(), money);
      renderCartBar(false);
    });
    $('#cartPromos').addEventListener('click', async (e) => {
      if (!e.target.closest('[data-scroll-drinks]')) return;
      await closeSheet();
      $('#drinks').scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth', block: 'center' });
      replay($('#drinks'), 'nudge');
    });
    let phoneTimer;
    $('#fPhone').addEventListener('input', (e) => {
      clearTimeout(phoneTimer);
      phoneTimer = setTimeout(() => refreshLoyalty(e.target.value), 500);
    });
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
      const minEta = MENU?.menu?.promos?.minEta || 10;
      eta = Number.isFinite(v) && v >= minEta && v <= 240 ? v : null;
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
    cart = cart.filter((i) => (i.type === 'food' ? foodReady(i.product, i.picks) : Boolean(drinkOf(i.drink))));
    favorites = favorites.filter((f) => productOf(f.product));
    saveCart();
    renderBuilderOptions();
    document.body.classList.add('ready');
    renderAll();
    if (profile && profile.phone) refreshLoyalty(profile.phone);

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
