const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const webpush = require('web-push');
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

const CATEGORIES = ['breads', 'spreads', 'vegetables', 'fillings', 'drinks'];
const uploadsDir = path.join(DATA_DIR, 'uploads');
fs.mkdirSync(uploadsDir, { recursive: true });

function loadMenu() {
  const saved = readJson(menuFile, null);
  const menu = structuredClone(defaultMenu);
  if (!saved) return menu;
  if (saved.version === 2) {
    for (const cat of CATEGORIES) if (!Array.isArray(saved[cat])) saved[cat] = menu[cat];
    if (!saved.prices) saved.prices = menu.prices;
    return saved;
  }
  // Legacy file only stored availability/prices: overlay them onto the default catalog.
  if (saved.prices && Number.isFinite(saved.prices.sandwich)) menu.prices.sandwich = saved.prices.sandwich;
  for (const cat of CATEGORIES) {
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
    total: o.total,
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
      const vegIds = Array.isArray(raw.vegetables) ? [...new Set(raw.vegetables)] : [];
      const vegetables = vegIds.map((id) => {
        const v = findAvailable('vegetables', id);
        if (!v) throw new Error('אחד הירקות שנבחרו לא זמין כרגע');
        return { id: v.id, name: v.name };
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
        vegetables,
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
  broadcastAdmin('order', adminOrder(order));
  res.status(201).json(publicOrder(order));
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
  const changed = order.status !== status;
  order.status = status;
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
  const sandwichPrice = Number(body.prices && body.prices.sandwich);
  if (Number.isFinite(sandwichPrice) && sandwichPrice >= 0 && sandwichPrice <= 1000) {
    next.prices.sandwich = sandwichPrice;
  }
  for (const cat of CATEGORIES) {
    for (const incoming of Array.isArray(body[cat]) ? body[cat] : []) {
      const item = next[cat].find((x) => x.id === incoming.id);
      if (!item) continue;
      if (typeof incoming.available === 'boolean') item.available = incoming.available;
      const price = Number(incoming.price);
      if (cat === 'drinks' && Number.isFinite(price) && price >= 0 && price <= 1000) item.price = price;
    }
  }
  saveMenu(next);
  res.json(menu);
});

function saveMenu(next) {
  next.version = 2;
  menu = next;
  writeJson(menuFile, menu);
  broadcastAdmin('menu', menu);
}

function menuItem(req, res) {
  const { cat, id } = req.params;
  if (!CATEGORIES.includes(cat)) { res.status(404).json({ error: 'קטגוריה לא קיימת' }); return null; }
  const item = menu[cat].find((x) => x.id === id);
  if (!item) { res.status(404).json({ error: 'הפריט לא נמצא' }); return null; }
  return item;
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
  const { cat } = req.params;
  if (!CATEGORIES.includes(cat)) return res.status(404).json({ error: 'קטגוריה לא קיימת' });
  const name = cleanText(req.body && req.body.name, 30);
  if (!name) return res.status(400).json({ error: 'נא לתת שם לפריט' });
  if (menu[cat].length >= 40) return res.status(400).json({ error: 'יותר מדי פריטים בקטגוריה' });
  const item = { id: `${cat.slice(0, 3)}-${crypto.randomBytes(4).toString('hex')}`, name, img: '/img/placeholder.svg', available: true };
  if (cat === 'drinks') {
    const price = parsePrice(req.body.price);
    if (price === null) return res.status(400).json({ error: 'נא להזין מחיר' });
    item.price = price;
  }
  const next = structuredClone(menu);
  next[cat].push(item);
  saveMenu(next);
  res.status(201).json({ item, menu });
});

app.patch('/api/admin/menu/:cat/:id', requireAdmin, (req, res) => {
  if (!menuItem(req, res)) return;
  const { cat, id } = req.params;
  const body = req.body || {};
  const next = structuredClone(menu);
  const item = next[cat].find((x) => x.id === id);
  if ('name' in body) {
    const name = cleanText(body.name, 30);
    if (!name) return res.status(400).json({ error: 'השם לא יכול להיות ריק' });
    item.name = name;
  }
  if (typeof body.available === 'boolean') item.available = body.available;
  if (cat === 'drinks' && 'price' in body) {
    const price = parsePrice(body.price);
    if (price === null) return res.status(400).json({ error: 'מחיר לא תקין' });
    item.price = price;
  }
  saveMenu(next);
  res.json(menu);
});

app.delete('/api/admin/menu/:cat/:id', requireAdmin, (req, res) => {
  const item = menuItem(req, res);
  if (!item) return;
  const { cat, id } = req.params;
  if (cat === 'breads' && menu.breads.length === 1) return res.status(400).json({ error: 'חייב להישאר לפחות סוג לחם אחד' });
  const next = structuredClone(menu);
  next[cat] = next[cat].filter((x) => x.id !== id);
  saveMenu(next);
  removeUpload(item.img);
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
    const item = menuItem(req, res);
    if (!item) return;
    const buf = req.body;
    const type = Buffer.isBuffer(buf) && buf.length > 12 && IMAGE_TYPES.find((t) => t.test(buf));
    if (!type) return res.status(400).json({ error: 'הקובץ אינו תמונה נתמכת (JPG / PNG / WEBP)' });
    const file = `${item.id}-${Date.now().toString(36)}.${type.ext}`;
    fs.writeFileSync(path.join(uploadsDir, file), buf);
    const { cat, id } = req.params;
    const next = structuredClone(menu);
    next[cat].find((x) => x.id === id).img = `/uploads/${file}`;
    saveMenu(next);
    removeUpload(item.img);
    res.json(menu);
  },
);

app.listen(PORT, () => {
  console.log(`Sandwich cart running on http://localhost:${PORT}`);
  if (!process.env.ADMIN_PASSWORD) console.warn('ADMIN_PASSWORD is not set - using default "admin1234"');
});
