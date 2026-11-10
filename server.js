const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const webpush = require('web-push');
const QRCode = require('qrcode');
const defaultMenu = require('./defaultMenu');

const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin1234';
const SHOP_NAME = process.env.SHOP_NAME || "עגלת הסנדוויצ'ים";
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const TIME_ZONE = 'Asia/Jerusalem';

const STATUSES = ['new', 'preparing', 'ready', 'picked_up', 'cancelled'];

fs.mkdirSync(DATA_DIR, { recursive: true });

// ---------- persistence ----------

function todayKey() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TIME_ZONE }).format(new Date());
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(file, data) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data));
  fs.renameSync(tmp, file);
}

const menuFile = path.join(DATA_DIR, 'menu.json');
const ordersFile = (day) => path.join(DATA_DIR, `orders-${day}.json`);

const uploadsDir = path.join(DATA_DIR, 'uploads');
fs.mkdirSync(uploadsDir, { recursive: true });

function loadMenu() {
  const saved = readJson(menuFile, null);
  const menu = structuredClone(defaultMenu);
  if (!saved || saved.version !== 3 || !Array.isArray(saved.products) || !Array.isArray(saved.drinks)) return menu;
  saved.promos = { ...menu.promos, ...(saved.promos || {}) };
  if (!Array.isArray(saved.drinkGroups)) saved.drinkGroups = menu.drinkGroups;
  return saved;
}

let menu = loadMenu();

function loadDay(day) {
  const saved = readJson(ordersFile(day), null);
  return saved && saved.day === day ? saved : { day, seq: 0, orders: [] };
}

let state = loadDay(todayKey());

function saveState() {
  writeJson(ordersFile(state.day), state);
}

// ---------- history (anonymous daily totals, kept after the day's orders are deleted) ----------

const historyFile = path.join(DATA_DIR, 'history.json');
const HISTORY_DAYS = 400;
let history = readJson(historyFile, { days: {} });

const hourOf = (ts) => new Intl.DateTimeFormat('en-GB', { hour: '2-digit', hourCycle: 'h23', timeZone: TIME_ZONE }).format(ts);

function summarizeDay(dayState) {
  const valid = dayState.orders.filter((o) => o.status !== 'cancelled');
  const items = {};
  const hours = {};
  const add = (cat, name, qty) => {
    if (!items[cat]) items[cat] = {};
    items[cat][name] = (items[cat][name] || 0) + qty;
  };
  let sandwiches = 0;
  let drinks = 0;
  for (const o of valid) {
    const h = hourOf(o.createdAt);
    hours[h] = (hours[h] || 0) + 1;
    for (const i of o.items) {
      if (i.type === 'drink') { drinks += i.qty; add('drinks', i.drink.name, i.qty); continue; }
      sandwiches += i.qty;
      if (i.type === 'food') {
        add('products', i.product.name, i.qty);
        for (const g of i.groups || []) for (const it of g.items) add(g.id, it.name, i.qty);
        continue;
      }
      add('breads', i.bread.name, i.qty);
      add('fillings', i.filling ? i.filling.name : 'בלי מילוי', i.qty);
      for (const s of i.spreads) add('spreads', s.name, i.qty);
      for (const v of i.vegetables || []) add('vegetables', v.name, i.qty);
      for (const x of i.extras || []) add('extras', x.name, i.qty);
    }
  }
  const sum = (list, f) => list.reduce((n, o) => n + (f(o) || 0), 0);
  return {
    day: dayState.day,
    orders: valid.length,
    cancelled: dayState.orders.length - valid.length,
    revenue: sum(valid, (o) => o.total),
    collected: sum(valid.filter((o) => o.status === 'picked_up'), (o) => o.total),
    discounts: sum(valid, (o) => (o.discounts ? o.discounts.combo + o.discounts.reward : 0)),
    rewards: valid.filter((o) => o.discounts && o.discounts.reward > 0).length,
    sandwiches,
    drinks,
    items,
    hours,
  };
}

function archiveDay(dayState) {
  if (!dayState || !dayState.orders.length) return;
  history.days[dayState.day] = summarizeDay(dayState);
  const keep = Object.keys(history.days).sort().slice(-HISTORY_DAYS);
  history.days = Object.fromEntries(keep.map((d) => [d, history.days[d]]));
  writeJson(historyFile, history);
}

function removeOldDays() {
  for (const f of fs.readdirSync(DATA_DIR)) {
    if (/^orders-\d{4}-\d{2}-\d{2}\.json$/.test(f) && f !== `orders-${state.day}.json`) {
      const old = readJson(path.join(DATA_DIR, f), null);
      if (old && old.day && !history.days[old.day]) archiveDay(old);
      fs.rmSync(path.join(DATA_DIR, f), { force: true });
    }
  }
}
removeOldDays();

function ensureToday() {
  const day = todayKey();
  if (day === state.day) return;
  archiveDay(state);
  state = { day, seq: 0, orders: [] };
  saveState();
  removeOldDays();
  broadcastAdmin('reset', {});
}
setInterval(ensureToday, 60 * 1000);

// ---------- loyalty (stamp card per phone) ----------

const loyaltyFile = path.join(DATA_DIR, 'loyalty.json');
const loyalty = readJson(loyaltyFile, {});
const saveLoyalty = () => writeJson(loyaltyFile, loyalty);

function loyaltyView(phone) {
  const goal = menu.promos.loyaltyGoal;
  const stamps = (loyalty[phone] && loyalty[phone].stamps) || 0;
  return { enabled: goal > 0, goal, stamps, rewardReady: goal > 0 && stamps >= goal };
}

function addStamps(phone, delta) {
  const rec = loyalty[phone] || { stamps: 0 };
  rec.stamps = Math.max(0, rec.stamps + delta);
  rec.updatedAt = Date.now();
  loyalty[phone] = rec;
  saveLoyalty();
}

const sandwichCount = (o) => o.items.reduce((n, i) => n + (i.type === 'food' || i.type === 'sandwich' ? i.qty : 0), 0);

// Stamps are earned on pickup and the free sandwich is refunded on cancel, so status flips stay consistent.
function syncLoyalty(order, prevStatus) {
  if (order.status === prevStatus) return;
  if (order.status === 'picked_up' && !order.stampsGranted) {
    order.stampsGranted = sandwichCount(order);
    addStamps(order.phone, order.stampsGranted);
  } else if (prevStatus === 'picked_up' && order.stampsGranted) {
    addStamps(order.phone, -order.stampsGranted);
    order.stampsGranted = 0;
  }
  if (order.reward) {
    if (order.status === 'cancelled' && !order.reward.refunded) {
      addStamps(order.phone, order.reward.stamps);
      order.reward.refunded = true;
    } else if (prevStatus === 'cancelled' && order.reward.refunded) {
      addStamps(order.phone, -order.reward.stamps);
      order.reward.refunded = false;
    }
  }
}

// ---------- web push ----------

function loadVapidKeys() {
  if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
    return { publicKey: process.env.VAPID_PUBLIC_KEY, privateKey: process.env.VAPID_PRIVATE_KEY };
  }
  // Keys must stay stable across restarts, otherwise every existing subscription breaks.
  const file = path.join(DATA_DIR, 'vapid.json');
  const saved = readJson(file, null);
  if (saved && saved.publicKey && saved.privateKey) return saved;
  const keys = webpush.generateVAPIDKeys();
  writeJson(file, keys);
  return keys;
}

const vapid = loadVapidKeys();
webpush.setVapidDetails(process.env.VAPID_SUBJECT || 'mailto:orders@sandwich-cart.app', vapid.publicKey, vapid.privateKey);

const PUSH_MESSAGES = {
  preparing: { title: '👨‍🍳 מתחילים להכין!', body: (o) => `${o.name}, ההזמנה שלך (#${o.number}) בהכנה עכשיו` },
  ready: { title: '🎉 ההזמנה מוכנה!', body: (o) => `${o.name}, הזמנה #${o.number} מחכה לך בעגלה. אפשר לבוא לאסוף` },
  cancelled: { title: '😕 ההזמנה בוטלה', body: (o) => `הזמנה #${o.number} בוטלה. לשאלות אפשר לפנות לעגלה` },
};

function isValidSubscription(sub) {
  return Boolean(
    sub && typeof sub.endpoint === 'string' && /^https:\/\//.test(sub.endpoint) && sub.endpoint.length < 1000 &&
    sub.keys && typeof sub.keys.p256dh === 'string' && typeof sub.keys.auth === 'string',
  );
}

async function pushStatus(order) {
  const msg = PUSH_MESSAGES[order.status];
  if (!msg || !order.pushSubs || !order.pushSubs.length) return;
  order.pushed = order.pushed || {};
  if (order.pushed[order.status]) return;
  order.pushed[order.status] = true;
  const payload = JSON.stringify({
    title: msg.title,
    body: msg.body(order),
    tag: `order-${order.id}`,
    url: `/?order=${order.id}`,
    status: order.status,
  });
  const dead = new Set();
  await Promise.all(order.pushSubs.map((sub) =>
    webpush.sendNotification(sub, payload, { TTL: 60 * 60, urgency: 'high' }).catch((err) => {
      if (err.statusCode === 404 || err.statusCode === 410) dead.add(sub.endpoint);
      else console.warn('push failed', err.statusCode || err.message);
    })));
  if (dead.size) {
    order.pushSubs = order.pushSubs.filter((s) => !dead.has(s.endpoint));
    saveState();
  }
}

// ---------- realtime (SSE) ----------

const adminClients = new Set();
const orderClients = new Map(); // orderId -> Set<res>

function openStream(req, res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write('retry: 3000\n\n');
  const ping = setInterval(() => res.write(': ping\n\n'), 25000);
  req.on('close', () => clearInterval(ping));
}

function send(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function broadcastAdmin(event, data) {
  for (const res of adminClients) send(res, event, data);
}

function notifyOrder(order) {
  const set = orderClients.get(order.id);
  if (!set) return;
  const view = publicOrder(order);
  for (const res of set) send(res, 'order', view);
}

// ---------- helpers ----------

function publicOrder(o) {
  return {
    id: o.id,
    number: o.number,
    name: o.name,
    items: o.items,
    subtotal: o.subtotal ?? o.total,
    discounts: o.discounts || { combo: 0, reward: 0 },
    total: o.total,
    stampsEarned: o.stampsGranted || 0,
    status: o.status,
    createdAt: o.createdAt,
    arriveAt: o.arriveAt,
    etaMinutes: o.etaMinutes,
  };
}

function adminOrder(o) {
  const { pushSubs, pushed, ...rest } = o;
  return { ...rest, push: Boolean(pushSubs && pushSubs.length) };
}

function rateLimiter(max, windowMs) {
  const hits = new Map();
  setInterval(() => {
    const cutoff = Date.now() - windowMs;
    for (const [k, arr] of hits) {
      const kept = arr.filter((t) => t > cutoff);
      if (kept.length) hits.set(k, kept);
      else hits.delete(k);
    }
  }, windowMs).unref();
  return (req, res, next) => {
    const now = Date.now();
    const arr = (hits.get(req.ip) || []).filter((t) => t > now - windowMs);
    if (arr.length >= max) return res.status(429).json({ error: 'יותר מדי בקשות, נסו שוב בעוד כמה דקות' });
    arr.push(now);
    hits.set(req.ip, arr);
    next();
  };
}

const adminToken = crypto.createHmac('sha256', ADMIN_PASSWORD).update('sandwich-cart-admin').digest('hex');

function isAdminToken(token) {
  if (typeof token !== 'string' || token.length !== adminToken.length) return false;
  return crypto.timingSafeEqual(Buffer.from(token), Buffer.from(adminToken));
}

function requireAdmin(req, res, next) {
  const header = req.get('authorization') || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : req.query.token;
  if (!isAdminToken(token)) return res.status(401).json({ error: 'לא מורשה' });
  next();
}

function cleanText(v, max) {
  return typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max) : '';
}

function buildFood(raw, qty) {
  const product = menu.products.find((p) => p.id === raw.product);
  if (!product) throw new Error('המנה שנבחרה לא בתפריט');
  const picks = raw.picks && typeof raw.picks === 'object' ? raw.picks : {};
  const groups = [];
  let price = Number(product.price) || 0;
  let basePrice = Number(product.price) || 0;
  for (const g of product.groups) {
    const ids = Array.isArray(picks[g.id]) ? [...new Set(picks[g.id].filter((id) => typeof id === 'string'))] : [];
    if (g.mode === 'single' && ids.length > 1) throw new Error(`אפשר לבחור רק ${g.name} אחד`);
    if (ids.length < (g.min || 0)) throw new Error(`חסרה בחירה: ${g.name}`);
    if (g.max != null && ids.length > g.max) throw new Error(`אפשר לבחור עד ${g.max} ב${g.name}`);
    const items = ids.map((id) => {
      const item = g.items.find((x) => x.id === id);
      if (!item || !item.available) throw new Error(`פריט לא זמין: ${g.name}`);
      return { id: item.id, name: item.name };
    });
    if (g.pricedBase) {
      if (items.length !== 1) throw new Error(`צריך לבחור ${g.name}`);
      const chosen = g.items.find((x) => x.id === items[0].id);
      price += chosen.price || 0;
      basePrice = chosen.price || 0;
    } else if (g.extraPrice > 0) {
      const free = g.included || 0;
      price += Math.max(0, items.length - free) * g.extraPrice;
      items.forEach((it, i) => { it.charged = i >= free ? g.extraPrice : 0; });
    }
    groups.push({ id: g.id, name: g.name, items });
  }
  price = Math.round(price * 2) / 2;
  return {
    type: 'food',
    product: { id: product.id, name: product.name, emoji: product.emoji || '' },
    groups,
    basePrice,
    qty,
    unitPrice: price,
    lineTotal: price * qty,
    done: false,
  };
}

function buildItems(rawItems) {
  if (!Array.isArray(rawItems) || rawItems.length === 0) throw new Error('הסל ריק');
  if (rawItems.length > 30) throw new Error('יותר מדי פריטים בהזמנה אחת');
  return rawItems.map((raw) => {
    const qty = Number.parseInt(raw && raw.qty, 10);
    if (!(qty >= 1 && qty <= 20)) throw new Error('כמות לא תקינה');
    if (raw.type === 'food') return buildFood(raw, qty);
    if (raw.type === 'drink') {
      const d = menu.drinks.find((x) => x.id === raw.drink);
      if (!d || !d.available) throw new Error('המשקה שנבחר לא זמין כרגע');
      return {
        type: 'drink',
        drink: { id: d.id, name: d.name },
        qty,
        unitPrice: d.price,
        lineTotal: d.price * qty,
        done: false,
      };
    }
    throw new Error('פריט לא מוכר');
  });
}

// ---------- app ----------

const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '32kb' }));
const siteUrl = (req) => `${req.protocol}://${req.get('host')}`;

// Link previews (WhatsApp, Facebook) need absolute URLs, so the origin is filled in per request.
const indexFile = path.join(__dirname, 'public', 'index.html');
app.get(['/', '/index.html'], (req, res) => {
  fs.readFile(indexFile, 'utf8', (err, html) => {
    if (err) return res.status(500).end();
    res.set('Cache-Control', 'no-cache').type('html').send(html.replaceAll('%ORIGIN%', siteUrl(req)));
  });
});

app.get('/qr.svg', async (req, res) => {
  const svg = await QRCode.toString(`${siteUrl(req)}/`, {
    type: 'svg', margin: 0, errorCorrectionLevel: 'M', color: { dark: '#2b1d3a', light: '#0000' },
  });
  res.set('Cache-Control', 'public, max-age=3600').type('image/svg+xml').send(svg);
});

app.use('/img', express.static(path.join(__dirname, 'public', 'img'), { maxAge: '7d' }));
app.use('/uploads', express.static(uploadsDir, { maxAge: '30d', immutable: true }));
app.use(express.static(path.join(__dirname, 'public'), { maxAge: 0 }));

app.get('/api/menu', (req, res) => {
  res.json({ shopName: SHOP_NAME, menu });
});

app.post('/api/orders', rateLimiter(30, 10 * 60 * 1000), (req, res) => {
  ensureToday();
  const body = req.body || {};
  const name = cleanText(body.name, 40);
  const phone = String(body.phone || '').replace(/\D/g, '');
  const notes = cleanText(body.notes, 300);
  const etaMinutes = Number.parseInt(body.etaMinutes, 10);

  if (!name) return res.status(400).json({ error: 'נא למלא שם' });
  if (!/^0\d{8,9}$/.test(phone)) return res.status(400).json({ error: 'מספר טלפון לא תקין' });
  if (!(etaMinutes >= 0 && etaMinutes <= 240)) return res.status(400).json({ error: 'נא לבחור בעוד כמה דקות תגיעו' });

  let items;
  try {
    items = buildItems(body.items);
  } catch (err) {
    return res.status(400).json({ error: err.message, menuChanged: true });
  }

  const now = Date.now();
  const subtotal = items.reduce((sum, i) => sum + i.lineTotal, 0);
  const sandwiches = items.reduce((n, i) => n + (i.type === 'food' ? i.qty : 0), 0);
  const drinks = items.reduce((n, i) => n + (i.type === 'drink' ? i.qty : 0), 0);
  const card = loyaltyView(phone);
  const bases = items.filter((i) => i.type === 'food').map((i) => i.basePrice);
  const rewardAmount = bases.length ? Math.min(...bases) : 0;
  const reward = body.useReward === true && card.rewardReady && sandwiches > 0
    ? { stamps: card.goal, amount: rewardAmount, refunded: false }
    : null;
  if (body.useReward === true && !reward) {
    return res.status(400).json({ error: 'המנה החינמית לא זמינה כרגע. עדכנו את הסל ונסו שוב', loyaltyChanged: true });
  }
  const combo = Math.min(sandwiches - (reward ? 1 : 0), drinks) * menu.promos.comboDiscount;
  const discounts = { combo, reward: reward ? reward.amount : 0 };
  const order = {
    id: crypto.randomUUID(),
    number: ++state.seq,
    name,
    phone,
    notes,
    etaMinutes,
    items,
    subtotal,
    discounts,
    total: Math.max(0, subtotal - discounts.combo - discounts.reward),
    reward,
    status: 'new',
    createdAt: now,
    arriveAt: now + etaMinutes * 60 * 1000,
    updatedAt: now,
  };
  if (reward) addStamps(phone, -reward.stamps);
  state.orders.push(order);
  saveState();
  broadcastAdmin('order', adminOrder(order));
  res.status(201).json(publicOrder(order));
});

app.get('/api/loyalty/:phone', rateLimiter(60, 10 * 60 * 1000), (req, res) => {
  const phone = String(req.params.phone).replace(/\D/g, '');
  if (!/^0\d{8,9}$/.test(phone)) return res.status(400).json({ error: 'מספר טלפון לא תקין' });
  res.json(loyaltyView(phone));
});

app.get('/api/push/key', (req, res) => {
  res.json({ key: vapid.publicKey });
});

app.post('/api/orders/:id/push', rateLimiter(60, 10 * 60 * 1000), (req, res) => {
  const order = state.orders.find((o) => o.id === req.params.id);
  if (!order) return res.status(404).json({ error: 'ההזמנה לא נמצאה' });
  const sub = req.body && req.body.subscription;
  if (!isValidSubscription(sub)) return res.status(400).json({ error: 'מנוי התראות לא תקין' });
  order.pushSubs = (order.pushSubs || []).filter((s) => s.endpoint !== sub.endpoint);
  order.pushSubs.push({ endpoint: sub.endpoint, keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth } });
  order.pushSubs = order.pushSubs.slice(-5);
  saveState();
  broadcastAdmin('order', adminOrder(order));
  res.json({ ok: true });
});

app.get('/api/orders/:id', (req, res) => {
  const order = state.orders.find((o) => o.id === req.params.id);
  if (!order) return res.status(404).json({ error: 'ההזמנה לא נמצאה' });
  res.json(publicOrder(order));
});

app.get('/api/orders/:id/stream', (req, res) => {
  const order = state.orders.find((o) => o.id === req.params.id);
  if (!order) return res.status(404).end();
  openStream(req, res);
  if (!orderClients.has(order.id)) orderClients.set(order.id, new Set());
  const set = orderClients.get(order.id);
  set.add(res);
  send(res, 'order', publicOrder(order));
  req.on('close', () => {
    set.delete(res);
    if (set.size === 0) orderClients.delete(order.id);
  });
});

// ---------- admin ----------

app.post('/api/admin/login', rateLimiter(10, 10 * 60 * 1000), (req, res) => {
  const password = String((req.body && req.body.password) || '');
  const a = crypto.createHash('sha256').update(password).digest();
  const b = crypto.createHash('sha256').update(ADMIN_PASSWORD).digest();
  if (!crypto.timingSafeEqual(a, b)) return res.status(401).json({ error: 'סיסמה שגויה' });
  res.json({ token: adminToken });
});

app.get('/api/admin/orders', requireAdmin, (req, res) => {
  ensureToday();
  res.json({ day: state.day, orders: state.orders.map(adminOrder) });
});

app.get('/api/admin/stream', requireAdmin, (req, res) => {
  openStream(req, res);
  adminClients.add(res);
  send(res, 'hello', { day: state.day });
  req.on('close', () => adminClients.delete(res));
});

function updateOrder(order) {
  order.updatedAt = Date.now();
  saveState();
  broadcastAdmin('order', adminOrder(order));
  notifyOrder(order);
}

app.patch('/api/admin/orders/:id', requireAdmin, (req, res) => {
  const order = state.orders.find((o) => o.id === req.params.id);
  if (!order) return res.status(404).json({ error: 'ההזמנה לא נמצאה' });
  const { status } = req.body || {};
  if (!STATUSES.includes(status)) return res.status(400).json({ error: 'סטטוס לא תקין' });
  const prevStatus = order.status;
  const changed = prevStatus !== status;
  order.status = status;
  syncLoyalty(order, prevStatus);
  updateOrder(order);
  if (changed) pushStatus(order).catch((err) => console.warn('push error', err.message));
  res.json(adminOrder(order));
});

app.patch('/api/admin/orders/:id/items/:index', requireAdmin, (req, res) => {
  const order = state.orders.find((o) => o.id === req.params.id);
  const item = order && order.items[Number.parseInt(req.params.index, 10)];
  if (!item) return res.status(404).json({ error: 'הפריט לא נמצא' });
  item.done = Boolean(req.body && req.body.done);
  updateOrder(order);
  res.json(adminOrder(order));
});

app.put('/api/admin/menu', requireAdmin, (req, res) => {
  const body = req.body || {};
  const next = structuredClone(menu);
  const promos = body.promos || {};
  const combo = parsePrice(promos.comboDiscount);
  if ('comboDiscount' in promos && combo !== null) next.promos.comboDiscount = combo;
  const goal = Number.parseInt(promos.loyaltyGoal, 10);
  if ('loyaltyGoal' in promos && goal >= 0 && goal <= 50) next.promos.loyaltyGoal = goal;
  for (const incoming of Array.isArray(body.products) ? body.products : []) {
    const product = next.products.find((p) => p.id === incoming.id);
    const price = parsePrice(incoming.price);
    if (product && product.price != null && price !== null) product.price = price;
  }
  for (const incoming of Array.isArray(body.groups) ? body.groups : []) {
    const product = next.products.find((p) => p.id === incoming.product);
    const group = product && product.groups.find((g) => g.id === incoming.id);
    const price = parsePrice(incoming.extraPrice);
    if (group && price !== null) group.extraPrice = price;
  }
  saveMenu(next);
  res.json(menu);
});

function saveMenu(next) {
  next.version = 3;
  menu = next;
  writeJson(menuFile, menu);
  broadcastAdmin('menu', menu);
}

function locate(cat) {
  if (cat === 'drinks') return { list: menu.drinks, priced: true };
  const [pid, gid] = String(cat || '').split('__');
  const product = menu.products.find((p) => p.id === pid);
  const group = product && product.groups.find((g) => g.id === gid);
  if (!group) return null;
  return { list: group.items, priced: Boolean(group.pricedBase), product, group };
}

function menuItem(req, res) {
  const spot = locate(req.params.cat);
  const item = spot && spot.list.find((x) => x.id === req.params.id);
  if (!item) { res.status(404).json({ error: 'הפריט לא נמצא' }); return null; }
  return { ...spot, item };
}

function removeUpload(img) {
  if (typeof img === 'string' && img.startsWith('/uploads/')) {
    fs.rm(path.join(uploadsDir, path.basename(img)), { force: true }, () => {});
  }
}

function parsePrice(v) {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 && n <= 1000 ? Math.round(n * 2) / 2 : null;
}

app.post('/api/admin/menu/:cat', requireAdmin, (req, res) => {
  const spot = locate(req.params.cat);
  if (!spot) return res.status(404).json({ error: 'קטגוריה לא קיימת' });
  const name = cleanText(req.body && req.body.name, 40);
  if (!name) return res.status(400).json({ error: 'נא לתת שם לפריט' });
  if (spot.list.length >= 40) return res.status(400).json({ error: 'יותר מדי פריטים בקטגוריה' });
  const item = { id: `i-${crypto.randomBytes(3).toString('hex')}`, name, img: '/img/placeholder.svg', available: true };
  if (req.params.cat === 'drinks') {
    const sample = spot.list[0];
    item.group = (req.body && req.body.group) || (sample && sample.group) || 'hot';
  }
  if (spot.priced) {
    const price = parsePrice(req.body && req.body.price);
    if (price === null) return res.status(400).json({ error: 'נא להזין מחיר' });
    item.price = price;
  }
  const next = structuredClone(menu);
  const dest = locateOn(next, req.params.cat);
  dest.list.push(item);
  saveMenu(next);
  res.status(201).json({ item, menu });
});

function locateOn(source, cat) {
  if (cat === 'drinks') return { list: source.drinks, priced: true };
  const [pid, gid] = String(cat || '').split('__');
  const product = source.products.find((p) => p.id === pid);
  const group = product && product.groups.find((g) => g.id === gid);
  if (!group) return null;
  return { list: group.items, priced: Boolean(group.pricedBase), product, group };
}

app.patch('/api/admin/menu/:cat/:id', requireAdmin, (req, res) => {
  const spot = menuItem(req, res);
  if (!spot) return;
  const body = req.body || {};
  const next = structuredClone(menu);
  const item = locateOn(next, req.params.cat).list.find((x) => x.id === req.params.id);
  if ('name' in body) {
    const name = cleanText(body.name, 40);
    if (!name) return res.status(400).json({ error: 'השם לא יכול להיות ריק' });
    item.name = name;
  }
  if (typeof body.available === 'boolean') item.available = body.available;
  if (spot.priced && 'price' in body) {
    const price = parsePrice(body.price);
    if (price === null) return res.status(400).json({ error: 'מחיר לא תקין' });
    item.price = price;
  }
  saveMenu(next);
  res.json(menu);
});

app.delete('/api/admin/menu/:cat/:id', requireAdmin, (req, res) => {
  const spot = menuItem(req, res);
  if (!spot) return;
  if (spot.group && spot.group.pricedBase && spot.group.items.length === 1) {
    return res.status(400).json({ error: 'חייב להישאר לפחות סוג לחם אחד' });
  }
  const next = structuredClone(menu);
  const dest = locateOn(next, req.params.cat);
  dest.list.splice(dest.list.findIndex((x) => x.id === req.params.id), 1);
  saveMenu(next);
  removeUpload(spot.item.img);
  res.json(menu);
});

const IMAGE_TYPES = [
  { ext: 'jpg', test: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { ext: 'png', test: (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
  { ext: 'webp', test: (b) => b.subarray(0, 4).toString('ascii') === 'RIFF' && b.subarray(8, 12).toString('ascii') === 'WEBP' },
];

app.post(
  '/api/admin/menu/:cat/:id/image',
  requireAdmin,
  express.raw({ type: ['image/jpeg', 'image/png', 'image/webp'], limit: '4mb' }),
  (req, res) => {
    const spot = menuItem(req, res);
    if (!spot) return;
    const buf = req.body;
    const type = Buffer.isBuffer(buf) && buf.length > 12 && IMAGE_TYPES.find((t) => t.test(buf));
    if (!type) return res.status(400).json({ error: 'הקובץ אינו תמונה נתמכת (JPG / PNG / WEBP)' });
    const file = `${spot.item.id}-${Date.now().toString(36)}.${type.ext}`;
    fs.writeFileSync(path.join(uploadsDir, file), buf);
    const { cat, id } = req.params;
    const next = structuredClone(menu);
    locateOn(next, cat).list.find((x) => x.id === id).img = `/uploads/${file}`;
    saveMenu(next);
    removeUpload(spot.item.img);
    res.json(menu);
  },
);

app.get('/api/admin/reports', requireAdmin, (req, res) => {
  ensureToday();
  const days = Math.min(HISTORY_DAYS, Math.max(1, Number.parseInt(req.query.days, 10) || 30));
  const from = new Date(Date.now() - (days - 1) * 86400000);
  const fromKey = new Intl.DateTimeFormat('en-CA', { timeZone: TIME_ZONE }).format(from);
  const past = Object.values(history.days).filter((d) => d.day >= fromKey && d.day !== state.day);
  res.json({ days: [...past, summarizeDay(state)].sort((a, b) => a.day.localeCompare(b.day)) });
});

app.listen(PORT, () => {
  console.log(`Sandwich cart running on http://localhost:${PORT}`);
  if (!process.env.ADMIN_PASSWORD) console.warn('ADMIN_PASSWORD is not set - using default "admin1234"');
});
