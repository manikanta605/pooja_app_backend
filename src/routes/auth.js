const express = require('express');
const crypto = require('node:crypto');
const bcrypt = require('bcryptjs');
const { db, runTx } = require('../db');
const { signToken } = require('../middleware/auth');
const { sendPasswordResetEmail } = require('../mailer');
const { sendWhatsAppOtp } = require('../whatsapp');

const router = express.Router();

const DEFAULT_PUJA_TYPES = [
  'సత్యనారాయణ స్వామి వ్రతం',
  'గణపతి పూజ',
  'గృహప్రవేశం',
  'వివాహం',
  'నామకరణం',
  'అన్నప్రాశన',
  'ఉపనయనం',
  'రుద్రాభిషేకం',
  'లక్ష్మీ పూజ',
  'హోమం',
];

function sanitizeUser(u) {
  return {
    id: u.id,
    name: u.name,
    username: u.username,
    phone: u.phone,
    email: u.email || '',
    addr: u.addr || '',
    locations: u.locations || '',
    notify: Boolean(u.notify),
    lang: u.lang === 'en' ? 'en' : 'te',
  };
}

router.post('/send-otp', async (req, res, next) => {
  try {
    const phone = String(req.body?.phone || '').trim();
    if (!/^[6-9]\d{9}$/.test(phone)) {
      return res.status(400).json({ error: 'Enter a valid 10-digit mobile number' });
    }
    const code = String(crypto.randomInt(100000, 999999));
    const expiresAt = Date.now() + 5 * 60 * 1000;
    db.prepare(
      `INSERT INTO otps (phone, code, expires_at) VALUES (?, ?, ?)
       ON CONFLICT(phone) DO UPDATE SET code = excluded.code, expires_at = excluded.expires_at`
    ).run(phone, code, expiresAt);

    const { sent, provider } = await sendWhatsAppOtp(phone, code);
    const existing = db.prepare('SELECT id FROM users WHERE phone = ?').get(phone);
    const allowDevOtp = process.env.ALLOW_DEV_OTP !== 'false';
    if (!sent && !allowDevOtp) {
      return res.status(503).json({ error: 'WhatsApp OTP service is not configured' });
    }

    res.json({
      ok: true,
      exists: Boolean(existing),
      whatsappSent: sent,
      provider,
      ...(!sent && allowDevOtp ? { devOtp: code } : {}),
    });
  } catch (err) {
    next(err);
  }
});

router.post('/verify-otp', (req, res) => {
  const phone = String(req.body?.phone || '').trim();
  const otp = String(req.body?.otp || '').trim();
  const row = db.prepare('SELECT code, expires_at FROM otps WHERE phone = ?').get(phone);
  if (!row || row.code !== otp || row.expires_at < Date.now()) {
    return res.status(400).json({ error: 'Incorrect or expired OTP' });
  }

  const user = db.prepare('SELECT * FROM users WHERE phone = ?').get(phone);
  if (!user) {
    return res.json({ ok: true, needsRegistration: true });
  }

  db.prepare('DELETE FROM otps WHERE phone = ?').run(phone);
  const token = signToken(user.id);
  res.json({ ok: true, token, user: sanitizeUser(user) });
});

router.post('/register', async (req, res) => {
  const phone = String(req.body?.phone || '').trim();
  const email = String(req.body?.email || '').trim().toLowerCase();
  const otp = req.body?.otp !== undefined ? String(req.body.otp).trim() : null;
  const name = String(req.body?.name || '').trim();
  const username = String(req.body?.username || '').trim().toLowerCase();
  const password = String(req.body?.password || '');

  if (otp !== null) {
    const row = db.prepare('SELECT code, expires_at FROM otps WHERE phone = ?').get(phone);
    if (!row || row.code !== otp || row.expires_at < Date.now()) {
      return res.status(400).json({ error: 'OTP expired or invalid' });
    }
  }
  if (!/^[6-9]\d{9}$/.test(phone)) return res.status(400).json({ error: 'Enter a valid 10-digit mobile number' });
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'Enter a valid email address' });
  if (name.length < 2) return res.status(400).json({ error: 'Enter your full name' });
  if (!/^[a-z0-9_]{4,20}$/.test(username)) {
    return res.status(400).json({ error: 'Username must be 4-20 chars (a-z, 0-9, _)' });
  }
  if (password.length < 8 || !/[A-Za-z]/.test(password) || !/\d/.test(password)) {
    return res.status(400).json({ error: 'Password must be 8+ chars with a letter and number' });
  }

  const dup = db.prepare('SELECT id FROM users WHERE phone = ? OR username = ? OR email = ?').get(phone, username, email);
  if (dup) {
    return res.status(409).json({ error: 'Phone, email, or username already registered' });
  }

  const passwordHash = await bcrypt.hash(password, 10);
  const userId = runTx(() => {
    const info = db
      .prepare('INSERT INTO users (phone, email, username, password_hash, name) VALUES (?, ?, ?, ?, ?)')
      .run(phone, email, username, passwordHash, name);
    const uid = Number(info.lastInsertRowid);
    const insType = db.prepare('INSERT INTO puja_types (user_id, name) VALUES (?, ?)');
    for (const tp of DEFAULT_PUJA_TYPES) insType.run(uid, tp);
    if (otp !== null) db.prepare('DELETE FROM otps WHERE phone = ?').run(phone);
    return uid;
  });

  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
  res.status(201).json({ ok: true, token: signToken(userId), user: sanitizeUser(user) });
});

router.post('/login', async (req, res) => {
  const identifier = String(req.body?.identifier || '').trim().toLowerCase();
  const password = String(req.body?.password || '');
  const user = db
    .prepare('SELECT * FROM users WHERE phone = ? OR username = ? OR email = ?')
    .get(identifier, identifier, identifier);
  if (!user || !(await bcrypt.compare(password, user.password_hash))) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }
  res.json({ ok: true, token: signToken(user.id), user: sanitizeUser(user) });
});

router.post('/forgot-password', async (req, res, next) => {
  try {
    const email = String(req.body?.email || '').trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ error: 'Enter a valid email address' });
    }
    const user = db.prepare('SELECT id, name, email FROM users WHERE email = ?').get(email);
    if (!user) {
      return res.status(404).json({ error: 'No account found with this email' });
    }

    const code = String(crypto.randomInt(100000, 999999));
    const expiresAt = Date.now() + 10 * 60 * 1000;
    db.prepare(
      `INSERT INTO password_resets (email, code, expires_at) VALUES (?, ?, ?)
       ON CONFLICT(email) DO UPDATE SET code = excluded.code, expires_at = excluded.expires_at`
    ).run(email, code, expiresAt);

    const { sent } = await sendPasswordResetEmail(email, user.name, code);
    const allowDev = process.env.ALLOW_DEV_OTP !== 'false';
    if (!sent && !allowDev) {
      return res.status(503).json({ error: 'Email service is not configured' });
    }

    res.json({
      ok: true,
      emailSent: sent,
      ...(!sent && allowDev ? { devCode: code } : {}),
    });
  } catch (err) {
    next(err);
  }
});

router.post('/reset-password', async (req, res) => {
  const email = String(req.body?.email || '').trim().toLowerCase();
  const code = String(req.body?.code || '').trim();
  const newPassword = String(req.body?.newPassword || '');

  const row = db.prepare('SELECT code, expires_at FROM password_resets WHERE email = ?').get(email);
  if (!row || row.code !== code || row.expires_at < Date.now()) {
    return res.status(400).json({ error: 'Invalid or expired reset code' });
  }
  if (newPassword.length < 8 || !/[A-Za-z]/.test(newPassword) || !/\d/.test(newPassword)) {
    return res.status(400).json({ error: 'Password must be 8+ chars with a letter and number' });
  }

  const hash = await bcrypt.hash(newPassword, 10);
  db.prepare('UPDATE users SET password_hash = ? WHERE email = ?').run(hash, email);
  db.prepare('DELETE FROM password_resets WHERE email = ?').run(email);
  res.json({ ok: true });
});

module.exports = router;
