const express = require('express');
const crypto = require('node:crypto');
const { db, runTx } = require('../db');
const { authRequired } = require('../middleware/auth');

const router = express.Router();
router.use(authRequired);

const todayIso = () => {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};

const YEARLY_PRICE = 1299;

function getSubInfo(user) {
  const active =
    Boolean(user?.sub_active) &&
    Boolean(user?.sub_expires_at) &&
    new Date(user.sub_expires_at).getTime() > Date.now();
  return {
    active,
    plan: user?.sub_plan || 'yearly_1299',
    price: YEARLY_PRICE,
    expiresAt: user?.sub_expires_at || '',
  };
}

function requireSubscription(req, res, next) {
  const user = db.prepare('SELECT sub_active, sub_plan, sub_expires_at FROM users WHERE id = ?').get(req.userId);
  if (!getSubInfo(user).active) {
    return res.status(403).json({
      error: 'Yearly ₹1,299 subscription required',
      code: 'SUBSCRIPTION_REQUIRED',
    });
  }
  next();
}

function loadCatalogFromDb() {
  const categories = db.prepare('SELECT id, en, te FROM pooja_categories ORDER BY sort_order').all();
  const poojas = db.prepare('SELECT id, category, en, te FROM pooja_catalog ORDER BY sort_order').all();
  const allItems = db.prepare('SELECT pooja_id, item, qty, te FROM pooja_catalog_items ORDER BY id').all();
  const byPooja = new Map();
  for (const it of allItems) {
    if (!byPooja.has(it.pooja_id)) byPooja.set(it.pooja_id, []);
    byPooja.get(it.pooja_id).push({ item: it.item, qty: it.qty, te: it.te });
  }
  const catalog = poojas.map((p) => ({ ...p, items: byPooja.get(p.id) || [] }));
  return { categories, catalog };
}

router.get('/catalog', (_req, res) => {
  res.json(loadCatalogFromDb());
});

router.post('/catalog/items', requireSubscription, (req, res) => {
  const poojaId = String(req.body?.poojaId || '').trim();
  const item = String(req.body?.item || '').trim();
  const te = String(req.body?.te || item).trim() || item;
  const qty = String(req.body?.qty || '1').trim() || '1';
  if (!poojaId || !item) {
    return res.status(400).json({ error: 'Pooja and item name required' });
  }
  const exists = db.prepare('SELECT id FROM pooja_catalog WHERE id = ?').get(poojaId);
  if (!exists) return res.status(404).json({ error: 'Pooja not found' });

  const info = db
    .prepare('INSERT INTO pooja_catalog_items (pooja_id, item, qty, te) VALUES (?, ?, ?, ?)')
    .run(poojaId, item, qty, te);

  res.status(201).json({
    ok: true,
    poojaId,
    item: { id: Number(info.lastInsertRowid), item, te, qty },
  });
});

router.get('/bootstrap', (req, res) => {
  const uid = req.userId;
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(uid);
  if (!user) return res.status(404).json({ error: 'User not found' });

  const types = db.prepare('SELECT name FROM puja_types WHERE user_id = ? ORDER BY id').all(uid).map((r) => r.name);
  const customers = db.prepare('SELECT id, name, phone, gotram, addr, family, notes FROM customers WHERE user_id = ? ORDER BY id DESC').all(uid);
  const bookings = db
    .prepare('SELECT id, cid, type, date, time, addr, total, adv, status, notes, items_json, share_token FROM bookings WHERE user_id = ? ORDER BY date, time')
    .all(uid)
    .map((b) => {
      let items = [];
      try { items = JSON.parse(b.items_json || '[]'); } catch {}
      return { id: b.id, cid: b.cid, type: b.type, date: b.date, time: b.time, addr: b.addr, total: b.total, adv: b.adv, status: b.status, notes: b.notes, items, shareToken: b.share_token || '' };
    });
  const samagri = db.prepare('SELECT id, puja, name, qty, done FROM samagri WHERE user_id = ? ORDER BY id').all(uid).map((r) => ({ ...r, done: Boolean(r.done) }));
  const checkRows = db.prepare('SELECT item_key, done FROM samagri_checks WHERE user_id = ?').all(uid);
  const samagriChecks = {};
  for (const r of checkRows) samagriChecks[r.item_key] = Boolean(r.done);
  const payments = db.prepare('SELECT id, kind, booking_id AS bookingId, title, amount, mode, date FROM payments WHERE user_id = ? ORDER BY id DESC').all(uid);
  const reminders = db.prepare('SELECT id, title, date, time, done FROM reminders WHERE user_id = ? ORDER BY date, time').all(uid).map((r) => ({ ...r, done: Boolean(r.done) }));
  const rituals = db.prepare('SELECT id, family, gotram, type, date, tithi, reminder_date AS reminderDate FROM rituals WHERE user_id = ? ORDER BY date').all(uid);
  const stock = db.prepare('SELECT id, name, qty, unit, min_qty AS minQty FROM stock WHERE user_id = ? ORDER BY id DESC').all(uid);
  const { categories, catalog } = loadCatalogFromDb();

  res.json({
    lang: user.lang === 'en' ? 'en' : 'te',
    phone: user.phone,
    profile: {
      name: user.name,
      username: user.username,
      phone: user.phone,
      email: user.email || '',
      addr: user.addr || '',
      locations: user.locations || '',
      notify: Boolean(user.notify),
    },
    subscription: getSubInfo(user),
    types,
    customers,
    bookings,
    samagri,
    samagriChecks,
    payments,
    reminders,
    rituals,
    stock,
    categories,
    catalog,
  });
});

router.put('/profile', (req, res) => {
  const uid = req.userId;
  const cur = db.prepare('SELECT * FROM users WHERE id = ?').get(uid);
  if (!cur) return res.status(404).json({ error: 'User not found' });

  const name = req.body?.name !== undefined ? String(req.body.name).trim() : cur.name;
  const phone = req.body?.phone !== undefined ? String(req.body.phone).trim() : cur.phone;
  const email = req.body?.email !== undefined ? String(req.body.email).trim().toLowerCase() : (cur.email || '');
  const addr = req.body?.addr !== undefined ? String(req.body.addr).trim() : cur.addr;
  const locations = req.body?.locations !== undefined ? String(req.body.locations).trim() : cur.locations;
  const notify = req.body?.notify !== undefined ? (req.body.notify ? 1 : 0) : cur.notify;
  const lang = req.body?.lang === 'en' || req.body?.lang === 'te' ? req.body.lang : cur.lang;

  if (!name) return res.status(400).json({ error: 'Name is required' });
  db.prepare('UPDATE users SET name=?, phone=?, email=?, addr=?, locations=?, notify=?, lang=? WHERE id=?')
    .run(name, phone, email, addr, locations, notify, lang, uid);

  res.json({ ok: true, profile: { name, username: cur.username, phone, email, addr, locations, notify: Boolean(notify) }, lang });
});

/* Subscription */
router.post('/subscription/activate', (req, res) => {
  const now = new Date();
  const exp = new Date(now.getTime() + 365 * 24 * 60 * 60 * 1000);
  const startedAt = now.toISOString();
  const expiresAt = exp.toISOString();

  runTx(() => {
    db.prepare('UPDATE users SET sub_active = 1, sub_plan = ?, sub_expires_at = ? WHERE id = ?')
      .run('yearly_1299', expiresAt, req.userId);
    db.prepare('INSERT INTO subscriptions (user_id, plan, amount, status, started_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(req.userId, 'yearly_1299', YEARLY_PRICE, 'active', startedAt, expiresAt);
  });

  res.json({
    ok: true,
    subscription: { active: true, plan: 'yearly_1299', price: YEARLY_PRICE, expiresAt },
  });
});

/* Puja Types */
router.post('/types', requireSubscription, (req, res) => {
  const name = String(req.body?.name || '').trim();
  if (name.length < 2) return res.status(400).json({ error: 'Invalid puja type' });
  db.prepare('INSERT OR IGNORE INTO puja_types (user_id, name) VALUES (?, ?)').run(req.userId, name);
  res.status(201).json({ ok: true, name });
});

router.delete('/types/:name', (req, res) => {
  db.prepare('DELETE FROM puja_types WHERE user_id = ? AND name = ?').run(req.userId, req.params.name);
  res.json({ ok: true });
});

/* Customers */
router.post('/customers', requireSubscription, (req, res) => {
  const name = String(req.body?.name || '').trim();
  const phone = String(req.body?.phone || '').trim();
  const gotram = String(req.body?.gotram || '-').trim() || '-';
  const addr = String(req.body?.addr || '-').trim() || '-';
  const family = String(req.body?.family || '').trim();
  const notes = String(req.body?.notes || '').trim();

  if (name.length < 2 || !/^[6-9]\d{9}$/.test(phone)) {
    return res.status(400).json({ error: 'Valid name and 10-digit phone required' });
  }
  const info = db
    .prepare('INSERT INTO customers (user_id, name, phone, gotram, addr, family, notes) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(req.userId, name, phone, gotram, addr, family, notes);
  res.status(201).json({ id: Number(info.lastInsertRowid), name, phone, gotram, addr, family, notes });
});

router.put('/customers/:id', requireSubscription, (req, res) => {
  const id = Number(req.params.id);
  const name = String(req.body?.name || '').trim();
  const phone = String(req.body?.phone || '').trim();
  const gotram = String(req.body?.gotram || '-').trim() || '-';
  const addr = String(req.body?.addr || '-').trim() || '-';
  const family = String(req.body?.family || '').trim();
  const notes = String(req.body?.notes || '').trim();

  if (name.length < 2 || !/^[6-9]\d{9}$/.test(phone)) {
    return res.status(400).json({ error: 'Valid name and 10-digit phone required' });
  }
  const info = db
    .prepare('UPDATE customers SET name=?, phone=?, gotram=?, addr=?, family=?, notes=? WHERE id=? AND user_id=?')
    .run(name, phone, gotram, addr, family, notes, id, req.userId);
  if (!info.changes) return res.status(404).json({ error: 'Customer not found' });
  res.json({ id, name, phone, gotram, addr, family, notes });
});

router.delete('/customers/:id', (req, res) => {
  db.prepare('DELETE FROM customers WHERE id = ? AND user_id = ?').run(Number(req.params.id), req.userId);
  res.json({ ok: true });
});

/* Bookings */
router.post('/bookings', requireSubscription, (req, res) => {
  const uid = req.userId;
  const { cid, newCustomer, type, date, time, addr, total, adv = 0, notes = '', items = [] } = req.body || {};
  const safeItems = Array.isArray(items) ? items : [];
  const itemsJson = JSON.stringify(safeItems);

  if (!type || !/^\d{4}-\d{2}-\d{2}$/.test(String(date)) || !/^\d{2}:\d{2}$/.test(String(time)) || !(Number(total) > 0) || Number(adv) > Number(total)) {
    return res.status(400).json({ error: 'Invalid booking details' });
  }

  const result = runTx(() => {
    let targetCid = Number(cid);
    let createdCustomer = null;
    if (newCustomer) {
      const cn = String(newCustomer.name || '').trim();
      const cp = String(newCustomer.phone || '').trim();
      const cg = String(newCustomer.gotram || '-').trim() || '-';
      if (cn.length < 2 || !/^[6-9]\d{9}$/.test(cp)) {
        throw Object.assign(new Error('Invalid customer details'), { status: 400 });
      }
      const cInfo = db
        .prepare('INSERT INTO customers (user_id, name, phone, gotram, addr) VALUES (?, ?, ?, ?, ?)')
        .run(uid, cn, cp, cg, String(addr || '-').trim() || '-');
      targetCid = Number(cInfo.lastInsertRowid);
      createdCustomer = { id: targetCid, name: cn, phone: cp, gotram: cg, addr: String(addr || '-').trim() || '-' };
    }

    const cust = db.prepare('SELECT id, name FROM customers WHERE id = ? AND user_id = ?').get(targetCid, uid);
    if (!cust) throw Object.assign(new Error('Customer not found'), { status: 404 });

    const shareToken = crypto.randomBytes(6).toString('hex');
    const bInfo = db
      .prepare('INSERT INTO bookings (user_id, cid, type, date, time, addr, total, adv, status, notes, items_json, share_token) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(uid, targetCid, String(type), String(date), String(time), String(addr || '-').trim(), Number(total), Number(adv) || 0, 'upcoming', String(notes || '').trim(), itemsJson, shareToken);
    const bookingId = Number(bInfo.lastInsertRowid);

    let createdPayment = null;
    if (Number(adv) > 0) {
      const title = `${cust.name} - Advance`;
      const td = todayIso();
      const pInfo = db
        .prepare('INSERT INTO payments (user_id, kind, booking_id, title, amount, mode, date) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(uid, 'income', bookingId, title, Number(adv), 'Cash', td);
      createdPayment = { id: Number(pInfo.lastInsertRowid), kind: 'income', bookingId, title, amount: Number(adv), mode: 'Cash', date: td };
    }

    return {
      booking: { id: bookingId, cid: targetCid, type: String(type), date: String(date), time: String(time), addr: String(addr || '-').trim(), total: Number(total), adv: Number(adv) || 0, status: 'upcoming', notes: String(notes || '').trim(), items: safeItems, shareToken },
      customer: createdCustomer,
      payment: createdPayment,
    };
  });

  res.status(201).json(result);
});

router.put('/bookings/:id', requireSubscription, (req, res) => {
  const id = Number(req.params.id);
  const { cid, type, date, time, addr, total, adv = 0, notes = '', items } = req.body || {};
  if (!type || !/^\d{4}-\d{2}-\d{2}$/.test(String(date)) || !/^\d{2}:\d{2}$/.test(String(time)) || !(Number(total) > 0) || Number(adv) > Number(total)) {
    return res.status(400).json({ error: 'Invalid booking details' });
  }
  const cur = db.prepare('SELECT items_json FROM bookings WHERE id = ? AND user_id = ?').get(id, req.userId);
  if (!cur) return res.status(404).json({ error: 'Booking not found' });
  const itemsJson = Array.isArray(items) ? JSON.stringify(items) : (cur.items_json || '[]');
  db.prepare('UPDATE bookings SET cid=?, type=?, date=?, time=?, addr=?, total=?, adv=?, notes=?, items_json=? WHERE id=? AND user_id=?')
    .run(Number(cid), String(type), String(date), String(time), String(addr || '-').trim(), Number(total), Number(adv) || 0, String(notes || '').trim(), itemsJson, id, req.userId);
  const b = db.prepare('SELECT id, cid, type, date, time, addr, total, adv, status, notes, items_json, share_token FROM bookings WHERE id = ?').get(id);
  let parsedItems = [];
  try { parsedItems = JSON.parse(b.items_json || '[]'); } catch {}
  res.json({ id: b.id, cid: b.cid, type: b.type, date: b.date, time: b.time, addr: b.addr, total: b.total, adv: b.adv, status: b.status, notes: b.notes, items: parsedItems, shareToken: b.share_token || '' });
});

router.patch('/bookings/:id/items/:index/toggle', (req, res) => {
  const id = Number(req.params.id);
  const idx = Number(req.params.index);
  const b = db.prepare('SELECT items_json FROM bookings WHERE id = ? AND user_id = ?').get(id, req.userId);
  if (!b) return res.status(404).json({ error: 'Booking not found' });
  let items = [];
  try { items = JSON.parse(b.items_json || '[]'); } catch {}
  if (!items[idx]) return res.status(404).json({ error: 'Item not found' });
  items[idx] = { ...items[idx], done: !items[idx].done };
  db.prepare('UPDATE bookings SET items_json = ? WHERE id = ?').run(JSON.stringify(items), id);
  res.json({ ok: true, items });
});

router.patch('/bookings/:id/status', (req, res) => {
  const id = Number(req.params.id);
  const status = String(req.body?.status || '');
  if (!['upcoming', 'completed', 'cancelled'].includes(status)) {
    return res.status(400).json({ error: 'Invalid status' });
  }
  const info = db.prepare('UPDATE bookings SET status=? WHERE id=? AND user_id=?').run(status, id, req.userId);
  if (!info.changes) return res.status(404).json({ error: 'Booking not found' });
  res.json({ ok: true, id, status });
});

router.post('/bookings/:id/payments', requireSubscription, (req, res) => {
  const id = Number(req.params.id);
  const amount = Number(req.body?.amount);
  const mode = ['Cash', 'UPI', 'Bank'].includes(req.body?.mode) ? req.body.mode : 'UPI';
  if (!(amount > 0)) return res.status(400).json({ error: 'Valid amount required' });

  const result = runTx(() => {
    const b = db.prepare('SELECT * FROM bookings WHERE id = ? AND user_id = ?').get(id, req.userId);
    if (!b) throw Object.assign(new Error('Booking not found'), { status: 404 });
    const cust = db.prepare('SELECT name FROM customers WHERE id = ?').get(b.cid);
    const newAdv = Math.min(b.total, b.adv + amount);
    db.prepare('UPDATE bookings SET adv = ? WHERE id = ?').run(newAdv, id);
    const title = `${cust?.name ?? ''} - ${b.type}`;
    const td = todayIso();
    const pInfo = db
      .prepare('INSERT INTO payments (user_id, kind, booking_id, title, amount, mode, date) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(req.userId, 'income', id, title, amount, mode, td);
    return {
      adv: newAdv,
      payment: { id: Number(pInfo.lastInsertRowid), kind: 'income', bookingId: id, title, amount, mode, date: td },
    };
  });

  res.status(201).json(result);
});

/* Samagri */
router.post('/samagri', requireSubscription, (req, res) => {
  const puja = String(req.body?.puja || '').trim();
  const name = String(req.body?.name || '').trim();
  const qty = String(req.body?.qty || '1').trim() || '1';
  if (!puja || !name) return res.status(400).json({ error: 'Puja and item name required' });
  const info = db.prepare('INSERT INTO samagri (user_id, puja, name, qty, done) VALUES (?, ?, ?, ?, 0)').run(req.userId, puja, name, qty);
  res.status(201).json({ id: Number(info.lastInsertRowid), puja, name, qty, done: false });
});

router.patch('/samagri/:id/toggle', (req, res) => {
  const id = Number(req.params.id);
  const row = db.prepare('SELECT done FROM samagri WHERE id = ? AND user_id = ?').get(id, req.userId);
  if (!row) return res.status(404).json({ error: 'Item not found' });
  const done = row.done ? 0 : 1;
  db.prepare('UPDATE samagri SET done = ? WHERE id = ?').run(done, id);
  res.json({ id, done: Boolean(done) });
});

router.post('/samagri/mark-all', (req, res) => {
  const puja = String(req.body?.puja || '').trim();
  db.prepare('UPDATE samagri SET done = 1 WHERE user_id = ? AND puja = ?').run(req.userId, puja);
  res.json({ ok: true });
});

router.put('/samagri/checks', (req, res) => {
  const checks = req.body?.checks;
  if (!checks || typeof checks !== 'object') {
    return res.status(400).json({ error: 'checks object required' });
  }
  const stmt = db.prepare(
    'INSERT INTO samagri_checks (user_id, item_key, done) VALUES (?, ?, ?) ON CONFLICT(user_id, item_key) DO UPDATE SET done = excluded.done'
  );
  runTx(() => {
    for (const [k, v] of Object.entries(checks)) {
      stmt.run(req.userId, String(k), v ? 1 : 0);
    }
  });
  res.json({ ok: true });
});

router.delete('/samagri/:id', (req, res) => {
  db.prepare('DELETE FROM samagri WHERE id = ? AND user_id = ?').run(Number(req.params.id), req.userId);
  res.json({ ok: true });
});

/* Payments */
router.post('/payments', requireSubscription, (req, res) => {
  const kind = req.body?.kind === 'expense' ? 'expense' : 'income';
  const title = String(req.body?.title || '').trim();
  const amount = Number(req.body?.amount);
  const mode = ['Cash', 'UPI', 'Bank'].includes(req.body?.mode) ? req.body.mode : 'UPI';
  const date = /^\d{4}-\d{2}-\d{2}$/.test(String(req.body?.date)) ? String(req.body.date) : todayIso();
  if (!title || !(amount > 0)) return res.status(400).json({ error: 'Valid title and amount required' });
  const info = db
    .prepare('INSERT INTO payments (user_id, kind, title, amount, mode, date) VALUES (?, ?, ?, ?, ?, ?)')
    .run(req.userId, kind, title, amount, mode, date);
  res.status(201).json({ id: Number(info.lastInsertRowid), kind, title, amount, mode, date });
});

/* Reminders */
router.post('/reminders', requireSubscription, (req, res) => {
  const title = String(req.body?.title || '').trim();
  const date = String(req.body?.date || '').trim();
  const time = String(req.body?.time || '').trim();
  if (!title || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{2}:\d{2}$/.test(time)) {
    return res.status(400).json({ error: 'Valid title, date, and time required' });
  }
  const info = db.prepare('INSERT INTO reminders (user_id, title, date, time, done) VALUES (?, ?, ?, ?, 0)').run(req.userId, title, date, time);
  res.status(201).json({ id: Number(info.lastInsertRowid), title, date, time, done: false });
});

router.patch('/reminders/:id/toggle', (req, res) => {
  const id = Number(req.params.id);
  const row = db.prepare('SELECT done FROM reminders WHERE id = ? AND user_id = ?').get(id, req.userId);
  if (!row) return res.status(404).json({ error: 'Reminder not found' });
  const done = row.done ? 0 : 1;
  db.prepare('UPDATE reminders SET done = ? WHERE id = ?').run(done, id);
  res.json({ id, done: Boolean(done) });
});

router.delete('/reminders/:id', (req, res) => {
  db.prepare('DELETE FROM reminders WHERE id = ? AND user_id = ?').run(Number(req.params.id), req.userId);
  res.json({ ok: true });
});

/* Rituals */
router.post('/rituals', requireSubscription, (req, res) => {
  const family = String(req.body?.family || '').trim();
  const gotram = String(req.body?.gotram || '-').trim() || '-';
  const type = String(req.body?.type || '').trim();
  const date = String(req.body?.date || '').trim();
  const tithi = String(req.body?.tithi || '-').trim() || '-';
  const reminderDate = /^\d{4}-\d{2}-\d{2}$/.test(String(req.body?.reminderDate)) ? String(req.body.reminderDate) : date;
  if (!family || !type || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return res.status(400).json({ error: 'Family, ritual type, and valid date required' });
  }
  const info = db
    .prepare('INSERT INTO rituals (user_id, family, gotram, type, date, tithi, reminder_date) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(req.userId, family, gotram, type, date, tithi, reminderDate);
  res.status(201).json({ id: Number(info.lastInsertRowid), family, gotram, type, date, tithi, reminderDate });
});

router.delete('/rituals/:id', (req, res) => {
  db.prepare('DELETE FROM rituals WHERE id = ? AND user_id = ?').run(Number(req.params.id), req.userId);
  res.json({ ok: true });
});

/* Stock */
router.post('/stock', requireSubscription, (req, res) => {
  const name = String(req.body?.name || '').trim();
  const qty = Number(req.body?.qty);
  const unit = String(req.body?.unit || 'pcs').trim() || 'pcs';
  const minQty = Number(req.body?.minQty) || 0;
  if (!name || isNaN(qty) || qty < 0) return res.status(400).json({ error: 'Valid item name and quantity required' });
  const info = db.prepare('INSERT INTO stock (user_id, name, qty, unit, min_qty) VALUES (?, ?, ?, ?, ?)').run(req.userId, name, qty, unit, minQty);
  res.status(201).json({ id: Number(info.lastInsertRowid), name, qty, unit, minQty });
});

router.patch('/stock/:id/adjust', (req, res) => {
  const id = Number(req.params.id);
  const delta = Number(req.body?.delta) || 0;
  const row = db.prepare('SELECT qty FROM stock WHERE id = ? AND user_id = ?').get(id, req.userId);
  if (!row) return res.status(404).json({ error: 'Stock item not found' });
  const qty = Math.max(0, row.qty + delta);
  db.prepare('UPDATE stock SET qty = ? WHERE id = ?').run(qty, id);
  res.json({ id, qty });
});

router.delete('/stock/:id', (req, res) => {
  db.prepare('DELETE FROM stock WHERE id = ? AND user_id = ?').run(Number(req.params.id), req.userId);
  res.json({ ok: true });
});

/* Store Share Links & Delivery Orders */
router.post('/store/share', requireSubscription, (req, res) => {
  const poojaType = String(req.body?.poojaType || 'Pooja Samagri').trim();
  const items = Array.isArray(req.body?.items) ? req.body.items : [];
  if (!items.length) return res.status(400).json({ error: 'Items required' });
  const token = crypto.randomBytes(6).toString('hex');
  db.prepare('INSERT INTO shared_lists (token, user_id, pooja_type, items_json) VALUES (?, ?, ?, ?)')
    .run(token, req.userId, poojaType, JSON.stringify(items));
  res.status(201).json({ ok: true, token });
});

router.get('/store/orders', (req, res) => {
  const rows = db
    .prepare('SELECT id, token, booking_id AS bookingId, customer_name AS customerName, phone, address, pooja_type AS poojaType, items_json, notes, status, created_at AS createdAt FROM store_orders WHERE user_id = ? ORDER BY id DESC')
    .all(req.userId)
    .map((r) => {
      let items = [];
      try { items = JSON.parse(r.items_json || '[]'); } catch {}
      return { ...r, items };
    });
  res.json(rows);
});

module.exports = router;
