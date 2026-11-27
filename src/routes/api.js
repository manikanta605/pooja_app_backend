const express = require('express');
const { db, runTx } = require('../db');
const { authRequired } = require('../middleware/auth');

const router = express.Router();
router.use(authRequired);

const todayIso = () => {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};

router.get('/bootstrap', (req, res) => {
  const uid = req.userId;
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(uid);
  if (!user) return res.status(404).json({ error: 'User not found' });

  const types = db.prepare('SELECT name FROM puja_types WHERE user_id = ? ORDER BY id').all(uid).map((r) => r.name);
  const customers = db.prepare('SELECT id, name, phone, gotram, addr, family, notes FROM customers WHERE user_id = ? ORDER BY id DESC').all(uid);
  const bookings = db.prepare('SELECT id, cid, type, date, time, addr, total, adv, status, notes FROM bookings WHERE user_id = ? ORDER BY date, time').all(uid);
  const samagri = db.prepare('SELECT id, puja, name, qty, done FROM samagri WHERE user_id = ? ORDER BY id').all(uid).map((r) => ({ ...r, done: Boolean(r.done) }));
  const payments = db.prepare('SELECT id, kind, booking_id AS bookingId, title, amount, mode, date FROM payments WHERE user_id = ? ORDER BY id DESC').all(uid);
  const reminders = db.prepare('SELECT id, title, date, time, done FROM reminders WHERE user_id = ? ORDER BY date, time').all(uid).map((r) => ({ ...r, done: Boolean(r.done) }));
  const rituals = db.prepare('SELECT id, family, gotram, type, date, tithi, reminder_date AS reminderDate FROM rituals WHERE user_id = ? ORDER BY date').all(uid);
  const stock = db.prepare('SELECT id, name, qty, unit, min_qty AS minQty FROM stock WHERE user_id = ? ORDER BY id DESC').all(uid);

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
    types,
    customers,
    bookings,
    samagri,
    payments,
    reminders,
    rituals,
    stock,
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

/* Puja Types */
router.post('/types', (req, res) => {
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
router.post('/customers', (req, res) => {
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

router.put('/customers/:id', (req, res) => {
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
router.post('/bookings', (req, res) => {
  const uid = req.userId;
  const { cid, newCustomer, type, date, time, addr, total, adv = 0, notes = '' } = req.body || {};

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

    const bInfo = db
      .prepare('INSERT INTO bookings (user_id, cid, type, date, time, addr, total, adv, status, notes) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(uid, targetCid, String(type), String(date), String(time), String(addr || '-').trim(), Number(total), Number(adv) || 0, 'upcoming', String(notes || '').trim());
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
      booking: { id: bookingId, cid: targetCid, type: String(type), date: String(date), time: String(time), addr: String(addr || '-').trim(), total: Number(total), adv: Number(adv) || 0, status: 'upcoming', notes: String(notes || '').trim() },
      customer: createdCustomer,
      payment: createdPayment,
    };
  });

  res.status(201).json(result);
});

router.put('/bookings/:id', (req, res) => {
  const id = Number(req.params.id);
  const { cid, type, date, time, addr, total, adv = 0, notes = '' } = req.body || {};
  if (!type || !/^\d{4}-\d{2}-\d{2}$/.test(String(date)) || !/^\d{2}:\d{2}$/.test(String(time)) || !(Number(total) > 0) || Number(adv) > Number(total)) {
    return res.status(400).json({ error: 'Invalid booking details' });
  }
  const info = db
    .prepare('UPDATE bookings SET cid=?, type=?, date=?, time=?, addr=?, total=?, adv=?, notes=? WHERE id=? AND user_id=?')
    .run(Number(cid), String(type), String(date), String(time), String(addr || '-').trim(), Number(total), Number(adv) || 0, String(notes || '').trim(), id, req.userId);
  if (!info.changes) return res.status(404).json({ error: 'Booking not found' });
  const updated = db.prepare('SELECT id, cid, type, date, time, addr, total, adv, status, notes FROM bookings WHERE id = ?').get(id);
  res.json(updated);
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

router.post('/bookings/:id/payments', (req, res) => {
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
router.post('/samagri', (req, res) => {
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

router.delete('/samagri/:id', (req, res) => {
  db.prepare('DELETE FROM samagri WHERE id = ? AND user_id = ?').run(Number(req.params.id), req.userId);
  res.json({ ok: true });
});

/* Payments */
router.post('/payments', (req, res) => {
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
router.post('/reminders', (req, res) => {
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
router.post('/rituals', (req, res) => {
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
router.post('/stock', (req, res) => {
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

module.exports = router;
