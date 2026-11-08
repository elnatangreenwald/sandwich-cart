const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
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

function loadMenu() {
  const saved = readJson(menuFile, null);
  const menu = structuredClone(defaultMenu);
  if (!saved) return menu;
  // Overlay saved availability/prices onto the default catalog so new products still appear.
  if (saved.prices && Number.isFinite(saved.prices.sandwich)) menu.prices.sandwich = saved.prices.sandwich;
  for (const cat of ['breads', 'spreads', 'fillings', 'drinks']) {
    for (const item of menu[cat]) {
      const s = (saved[cat] || []).find((x) => x.id === item.id);
      if (!s) continue;
      if (typeof s.available === 'boolean') item.available = s.available;
      if (cat === 'drinks' && Number.isFinite(s.price)) item.price = s.price;
    }
  }
  return menu;
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

function removeOldDays() {
  for (const f of fs.readdirSync(DATA_DIR)) {
    if (/^orders-\d{4}-\d{2}-\d{2}\.json$/.test(f) && f !== `orders-${state.day}.json`) {
      fs.rmSync(path.join(DATA_DIR, f), { force: true });
    }
  }
}
removeOldDays();

function ensureToday() {
  const day = todayKey();
  if (day === state.day) return;
  state = { day, seq: 0, orders: [] };
  saveState();
  removeOldDays();
  broadcastAdmin('reset', {});
}
setInterval(ensureToday, 60 * 1000);

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
    total: o.total,
    status: o.status,
    createdAt: o.createdAt,
    arriveAt: o.arriveAt,
    etaMinutes: o.etaMinutes,
  };
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

function findAvailable(cat, id) {
  const item = menu[cat].find((x) => x.id === id);
  return item && item.available ? item : null;
}

function buildItems(rawItems) {
  if (!Array.isArray(rawItems) || rawItems.length === 0) throw new Error('הסל ריק');
  if (rawItems.length > 30) throw new Error('יותר מדי פריטים בהזמנה אחת');
  return rawItems.map((raw) => {
    const qty = Number.parseInt(raw && raw.qty, 10);
    if (!(qty >= 1 && qty <= 20)) throw new Error('כמות לא תקינה');

    if (raw.type === 'sandwich') {
      const bread = findAvailable('breads', raw.bread);
      if (!bread) throw new Error('סוג הלחם שנבחר לא זמין כרגע');
      const spreadIds = Array.isArray(raw.spreads) ? [...new Set(raw.spreads)] : [];
      const spreads = spreadIds.map((id) => {
        const s = findAvailable('spreads', id);
        if (!s) throw new Error('אחד הממרחים שנבחרו לא זמין כרגע');
        return { id: s.id, name: s.name };
      });
      let filling = null;
      if (raw.filling) {
        const f = findAvailable('fillings', raw.filling);
        if (!f) throw new Error('המילוי שנבחר לא זמין כרגע');
        filling = { id: f.id, name: f.name };
      }
      const unitPrice = menu.prices.sandwich;
      return {
        type: 'sandwich',
        bread: { id: bread.id, name: bread.name },
        spreads,
        filling,
        qty,
        unitPrice,
        lineTotal: unitPrice * qty,
        done: false,
      };
    }

    if (raw.type === 'drink') {
      const d = findAvailable('drinks', raw.drink);
      if (!d) throw new Error('המשקה שנבחר לא זמין כרגע');
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
app.use('/img', express.static(path.join(__dirname, 'public', 'img'), { maxAge: '7d' }));
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
  const order = {
    id: crypto.randomUUID(),
    number: ++state.seq,
    name,
    phone,
    notes,
    etaMinutes,
    items,
    total: items.reduce((sum, i) => sum + i.lineTotal, 0),
    status: 'new',
    createdAt: now,
    arriveAt: now + etaMinutes * 60 * 1000,
    updatedAt: now,
  };
  state.orders.push(order);
  saveState();
  broadcastAdmin('order', order);
  res.status(201).json(publicOrder(order));
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
  res.json({ day: state.day, orders: state.orders });
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
  broadcastAdmin('order', order);
  notifyOrder(order);
}

app.patch('/api/admin/orders/:id', requireAdmin, (req, res) => {
  const order = state.orders.find((o) => o.id === req.params.id);
  if (!order) return res.status(404).json({ error: 'ההזמנה לא נמצאה' });
  const { status } = req.body || {};
  if (!STATUSES.includes(status)) return res.status(400).json({ error: 'סטטוס לא תקין' });
  order.status = status;
  updateOrder(order);
  res.json(order);
});

app.patch('/api/admin/orders/:id/items/:index', requireAdmin, (req, res) => {
  const order = state.orders.find((o) => o.id === req.params.id);
  const item = order && order.items[Number.parseInt(req.params.index, 10)];
  if (!item) return res.status(404).json({ error: 'הפריט לא נמצא' });
  item.done = Boolean(req.body && req.body.done);
  updateOrder(order);
  res.json(order);
});

app.put('/api/admin/menu', requireAdmin, (req, res) => {
  const body = req.body || {};
  const next = structuredClone(menu);
  const sandwichPrice = Number(body.prices && body.prices.sandwich);
  if (Number.isFinite(sandwichPrice) && sandwichPrice >= 0 && sandwichPrice <= 1000) {
    next.prices.sandwich = sandwichPrice;
  }
  for (const cat of ['breads', 'spreads', 'fillings', 'drinks']) {
    for (const incoming of Array.isArray(body[cat]) ? body[cat] : []) {
      const item = next[cat].find((x) => x.id === incoming.id);
      if (!item) continue;
      if (typeof incoming.available === 'boolean') item.available = incoming.available;
      const price = Number(incoming.price);
      if (cat === 'drinks' && Number.isFinite(price) && price >= 0 && price <= 1000) item.price = price;
    }
  }
  menu = next;
  writeJson(menuFile, menu);
  broadcastAdmin('menu', menu);
  res.json(menu);
});

app.listen(PORT, () => {
  console.log(`Sandwich cart running on http://localhost:${PORT}`);
  if (!process.env.ADMIN_PASSWORD) console.warn('ADMIN_PASSWORD is not set - using default "admin1234"');
});
