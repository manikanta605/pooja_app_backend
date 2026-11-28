const express = require('express');
const crypto = require('node:crypto');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { db } = require('../db');

const router = express.Router();
const JWT_SECRET = process.env.JWT_SECRET || 'pujadiary-dev-secret-change-in-prod';

function signWebToken(id) {
  return jwt.sign({ wid: id }, JWT_SECRET, { expiresIn: '30d' });
}

function getWebCustomerFromReq(req) {
  const h = req.headers.authorization || '';
  const tok = h.startsWith('Bearer ') ? h.slice(7) : '';
  if (!tok) return null;
  try {
    const p = jwt.verify(tok, JWT_SECRET);
    if (!p?.wid) return null;
    return db.prepare('SELECT id, name, phone, email, address, source, created_at FROM web_customers WHERE id = ?').get(p.wid) || null;
  } catch {
    return null;
  }
}

function loadCatalogWithPrices() {
  const categories = db.prepare('SELECT id, en, te FROM pooja_categories ORDER BY sort_order').all();
  const poojas = db.prepare('SELECT id, category, en, te FROM pooja_catalog ORDER BY sort_order').all();
  const allItems = db.prepare('SELECT id, pooja_id, item, qty, te, price, available FROM pooja_catalog_items ORDER BY id').all();
  const byPooja = new Map();
  const priceIndex = new Map();
  for (const it of allItems) {
    const obj = { id: it.id, item: it.item, qty: it.qty, te: it.te, price: Number(it.price) || 40, available: Boolean(it.available ?? 1) };
    if (!byPooja.has(it.pooja_id)) byPooja.set(it.pooja_id, []);
    byPooja.get(it.pooja_id).push(obj);
    priceIndex.set(it.item.trim().toLowerCase(), obj);
  }
  const catalog = poojas.map((p) => ({ ...p, items: byPooja.get(p.id) || [] }));
  return { categories, catalog, priceIndex };
}

function enrichItemsWithPrice(items, priceIndex) {
  return (items || []).map((it) => {
    const match = priceIndex.get(String(it.item || '').trim().toLowerCase());
    return {
      item: it.item,
      te: it.te || match?.te || it.item,
      qty: it.qty || '1',
      price: it.price !== undefined ? Number(it.price) : (match?.price ?? 40),
      available: it.available !== undefined ? Boolean(it.available) : (match ? match.available : true),
    };
  });
}

function loadSharePayload(token) {
  const { priceIndex } = loadCatalogWithPrices();
  const b = db
    .prepare(
      `SELECT b.id, b.user_id, b.type, b.date, b.time, b.addr, b.items_json,
              c.name AS customer_name, c.phone AS customer_phone,
              u.name AS priest_name
       FROM bookings b
       LEFT JOIN customers c ON c.id = b.cid
       LEFT JOIN users u ON u.id = b.user_id
       WHERE b.share_token = ?`
    )
    .get(token);

  if (b) {
    let items = [];
    try { items = JSON.parse(b.items_json || '[]'); } catch {}
    const order = db.prepare('SELECT id, status, total_amount AS totalAmount, created_at AS createdAt FROM store_orders WHERE token = ? ORDER BY id DESC LIMIT 1').get(token);
    return {
      token,
      userId: b.user_id,
      bookingId: b.id,
      poojaType: b.type,
      date: b.date,
      time: b.time,
      addr: b.addr,
      customerName: b.customer_name || '',
      customerPhone: b.customer_phone || '',
      priestName: b.priest_name || 'PujaDiary',
      items: enrichItemsWithPrice(items, priceIndex),
      existingOrder: order || null,
    };
  }

  const s = db
    .prepare(
      `SELECT s.token, s.user_id, s.pooja_type, s.items_json, u.name AS priest_name
       FROM shared_lists s
       LEFT JOIN users u ON u.id = s.user_id
       WHERE s.token = ?`
    )
    .get(token);

  if (!s) return null;
  let items = [];
  try { items = JSON.parse(s.items_json || '[]'); } catch {}
  const order = db.prepare('SELECT id, status, total_amount AS totalAmount, created_at AS createdAt FROM store_orders WHERE token = ? ORDER BY id DESC LIMIT 1').get(token);
  return {
    token,
    userId: s.user_id,
    bookingId: null,
    poojaType: s.pooja_type,
    date: '',
    time: '',
    addr: '',
    customerName: '',
    customerPhone: '',
    priestName: s.priest_name || 'PujaDiary',
    items: enrichItemsWithPrice(items, priceIndex),
    existingOrder: order || null,
  };
}

/* Public Web Customer Auth (separate web_customers table with source tracking) */
router.post('/api/web/register', async (req, res) => {
  const name = String(req.body?.name || '').trim();
  const phone = String(req.body?.phone || '').replace(/\D/g, '');
  const email = String(req.body?.email || '').trim().toLowerCase();
  const password = String(req.body?.password || '');
  const address = String(req.body?.address || '').trim();
  const source = req.body?.source === 'ayyagaru_link' ? 'ayyagaru_link' : 'direct';

  if (name.length < 2 || !/^[6-9]\d{9}$/.test(phone) || password.length < 6) {
    return res.status(400).json({ error: 'Enter valid name, 10-digit mobile, and password (6+ chars).' });
  }
  const dup = db.prepare('SELECT id FROM web_customers WHERE phone = ?').get(phone);
  if (dup) return res.status(409).json({ error: 'Mobile number already registered. Please log in.' });

  const hash = await bcrypt.hash(password, 10);
  const info = db
    .prepare('INSERT INTO web_customers (name, phone, email, password_hash, address, source) VALUES (?, ?, ?, ?, ?, ?)')
    .run(name, phone, email, hash, address, source);
  const id = Number(info.lastInsertRowid);
  const customer = db.prepare('SELECT id, name, phone, email, address, source, created_at FROM web_customers WHERE id = ?').get(id);
  res.status(201).json({ ok: true, token: signWebToken(id), customer });
});

router.post('/api/web/login', async (req, res) => {
  const identifier = String(req.body?.identifier || '').trim().toLowerCase();
  const phoneDigits = identifier.replace(/\D/g, '');
  const password = String(req.body?.password || '');
  const row = db.prepare('SELECT * FROM web_customers WHERE phone = ? OR email = ?').get(phoneDigits || identifier, identifier);
  if (!row || !(await bcrypt.compare(password, row.password_hash))) {
    return res.status(401).json({ error: 'Invalid mobile/email or password' });
  }
  const { password_hash, ...customer } = row;
  res.json({ ok: true, token: signWebToken(row.id), customer });
});

router.get('/api/web/me', (req, res) => {
  const customer = getWebCustomerFromReq(req);
  if (!customer) return res.status(401).json({ error: 'Not logged in' });
  const orders = db
    .prepare('SELECT id, token, pooja_type AS poojaType, total_amount AS totalAmount, status, source, created_at AS createdAt FROM store_orders WHERE web_customer_id = ? OR phone = ? ORDER BY id DESC')
    .all(customer.id, customer.phone);
  res.json({ customer, orders });
});

router.get('/api/web/catalog', (_req, res) => {
  const { categories, catalog } = loadCatalogWithPrices();
  res.json({ categories, catalog });
});

router.get('/api/public/store/:token', (req, res) => {
  const payload = loadSharePayload(String(req.params.token || '').trim());
  if (!payload) return res.status(404).json({ error: 'Samagri list not found' });
  const { userId, ...pub } = payload;
  res.json(pub);
});

function buildMissingWhatsAppUrl(phone, customerName, poojaType, missingItems, orderId) {
  const digits = String(phone || '').replace(/\D/g, '');
  const waPhone = digits.length === 10 ? `91${digits}` : digits;
  const listText = missingItems.length
    ? missingItems.map((it, i) => `${i + 1}. ${it.te || it.item} (${it.item}) - ${it.qty}`).join('\n')
    : 'All items are included in your delivery!';
  const msg = `🙏 *PujaDiary Store – Order #${orderId}*\nNamaskaram ${customerName},\n*${poojaType}*\n\n${
    missingItems.length
      ? `*Missing / Unselected Items (Please arrange separately):*\n${listText}`
      : 'All required samagri items are confirmed for delivery!'
  }\n\n- PujaDiary Store`;
  return `https://wa.me/${waPhone}?text=${encodeURIComponent(msg)}`;
}

router.post('/api/public/store/:token/order', (req, res) => {
  const tok = String(req.params.token || '').trim();
  const payload = tok === 'direct' ? null : loadSharePayload(tok);
  if (tok !== 'direct' && !payload) return res.status(404).json({ error: 'Samagri list not found' });

  const webCust = getWebCustomerFromReq(req);
  const customerName = String(req.body?.customerName || webCust?.name || '').trim();
  const phone = String(req.body?.phone || webCust?.phone || '').replace(/\D/g, '');
  const address = String(req.body?.address || webCust?.address || '').trim();
  const notes = String(req.body?.notes || '').trim();
  const poojaType = String(req.body?.poojaType || payload?.poojaType || 'Pooja Samagri').trim();
  const items = Array.isArray(req.body?.items) ? req.body.items : (payload?.items || []);
  const missingItems = Array.isArray(req.body?.missingItems) ? req.body.missingItems : [];
  const totalAmount = Number(req.body?.totalAmount) || items.reduce((s, x) => s + (Number(x.price) || 0), 0);
  const source = tok === 'direct' ? 'direct' : 'ayyagaru_link';

  if (customerName.length < 2 || !/^[6-9]\d{9}$/.test(phone) || address.length < 3) {
    return res.status(400).json({ error: 'Please enter valid name, 10-digit mobile number, and delivery address.' });
  }
  if (!items.length) {
    return res.status(400).json({ error: 'Please keep at least one available item for delivery.' });
  }

  const orderToken = tok === 'direct' ? crypto.randomBytes(6).toString('hex') : tok;
  const info = db
    .prepare(
      `INSERT INTO store_orders (token, user_id, web_customer_id, booking_id, customer_name, phone, address, pooja_type, items_json, missing_items_json, total_amount, source, notes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      orderToken,
      payload?.userId || null,
      webCust?.id || null,
      payload?.bookingId || null,
      customerName,
      phone,
      address,
      poojaType,
      JSON.stringify(items),
      JSON.stringify(missingItems),
      totalAmount,
      source,
      notes
    );

  const orderId = Number(info.lastInsertRowid);
  const whatsappMissingUrl = buildMissingWhatsAppUrl(phone, customerName, poojaType, missingItems, orderId);
  res.status(201).json({ ok: true, orderId, status: 'pending', totalAmount, missingItems, whatsappMissingUrl });
});

function renderWebsiteHtml(sharedPayload) {
  const { categories, catalog } = loadCatalogWithPrices();
  const bootJson = JSON.stringify({
    categories,
    catalog,
    shared: sharedPayload || null,
  }).replace(/</g, '\\u003c');

  return `<!DOCTYPE html>
<html lang="te">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>PujaDiary Store • పూజా సామగ్రి</title>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700&family=Noto+Sans+Telugu:wght@400;600;700&display=swap" rel="stylesheet">
  <style>
    :root { --p:#D97706; --m:#7F1D1D; --bg:#FFF9F0; --card:#FFFFFF; --tx:#292524; --mut:#78716C; --ln:#EADFCB; --ok:#15803D; --okbg:#DCFCE7; --wnbg:#FEF3C7; --er:#DC2626; --erbg:#FEE2E2; }
    * { box-sizing: border-box; }
    body { margin: 0; font-family: 'Noto Sans Telugu', 'Inter', sans-serif; background: var(--bg); color: var(--tx); }
    .nav { background: linear-gradient(135deg, var(--p), var(--m)); color: #fff; position: sticky; top: 0; z-index: 50; box-shadow: 0 2px 10px rgba(127,29,29,0.2); }
    .nav-in { max-width: 1080px; margin: 0 auto; padding: 12px 16px; display: flex; align-items: center; justify-content: space-between; gap: 12px; }
    .brand { font-size: 19px; font-weight: 700; display: flex; align-items: center; gap: 8px; }
    .nav-btns { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
    .nbtn { background: rgba(255,255,255,0.18); color: #fff; border: none; padding: 8px 14px; border-radius: 20px; font-weight: 600; cursor: pointer; font-family: inherit; font-size: 13px; }
    .nbtn:hover { background: rgba(255,255,255,0.28); }
    .wrap { max-width: 1080px; margin: 0 auto; padding: 16px; }
    .hero { position: relative; border-radius: 24px; overflow: hidden; margin-bottom: 18px; background: linear-gradient(135deg, var(--m), var(--p)); color: #fff; min-height: 210px; display: flex; align-items: center; }
    .slide { display: none; padding: 28px 24px; width: 100%; }
    .slide.active { display: block; animation: fade .4s ease; }
    @keyframes fade { from { opacity: .4 } to { opacity: 1 } }
    .slide h2 { margin: 0 0 8px; font-size: 24px; }
    .slide p { margin: 0 0 14px; color: #FFEDD5; font-size: 14px; max-width: 600px; }
    .dots { position: absolute; bottom: 12px; left: 24px; display: flex; gap: 6px; }
    .dot { width: 8px; height: 8px; border-radius: 4px; background: rgba(255,255,255,0.4); cursor: pointer; }
    .dot.active { width: 22px; background: #fff; }
    .card { background: var(--card); border: 1px solid var(--ln); border-radius: 18px; padding: 16px; margin-bottom: 14px; box-shadow: 0 2px 8px rgba(127,29,29,0.06); }
    .tabs { display: flex; gap: 8px; overflow-x: auto; padding-bottom: 8px; margin-bottom: 10px; }
    .tab { padding: 8px 14px; border-radius: 20px; border: 1px solid var(--ln); background: #fff; cursor: pointer; white-space: nowrap; font-family: inherit; font-size: 13px; font-weight: 600; }
    .tab.on { background: var(--p); color: #fff; border-color: var(--p); }
    .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)); gap: 10px; }
    .pooja-card { border: 1px solid var(--ln); border-radius: 14px; padding: 12px; cursor: pointer; display: flex; align-items: center; gap: 10px; background: #fff; }
    .pooja-card.on { background: var(--wnbg); border-color: var(--p); }
    .row { display: flex; align-items: center; gap: 10px; padding: 10px 6px; border-bottom: 1px solid var(--bg); }
    .row.missing { opacity: 0.72; background: #FEF2F2; border-radius: 10px; padding-left: 8px; padding-right: 8px; }
    .row.missing .iname { text-decoration: line-through; color: var(--er); }
    .iname { flex: 1; font-size: 14px; font-weight: 600; min-width: 0; }
    .isub { font-size: 12px; color: var(--mut); font-weight: 400; }
    .qty { background: var(--wnbg); color: var(--m); font-weight: 700; font-size: 12px; padding: 4px 10px; border-radius: 10px; white-space: nowrap; }
    .price { font-weight: 700; color: var(--ok); font-size: 14px; min-width: 58px; text-align: right; }
    .miss-tag { background: var(--erbg); color: var(--er); font-size: 11px; font-weight: 700; padding: 2px 8px; border-radius: 8px; }
    .btn { padding: 13px 18px; border: none; border-radius: 14px; background: var(--p); color: #fff; font-size: 15px; font-weight: 700; cursor: pointer; font-family: inherit; }
    .btn.sec { background: #fff; color: var(--p); border: 1.5px solid var(--p); }
    .btn.wa { background: #25D366; color: #fff; display: inline-flex; align-items: center; justify-content: center; gap: 8px; text-decoration: none; }
    input, textarea { width: 100%; padding: 11px 12px; border: 1px solid var(--ln); border-radius: 12px; font-size: 14px; font-family: inherit; margin-bottom: 10px; }
    .modal-bg { display: none; position: fixed; inset: 0; background: rgba(0,0,0,0.5); z-index: 100; align-items: center; justify-content: center; padding: 16px; }
    .modal-bg.open { display: flex; }
    .modal { background: #fff; border-radius: 20px; padding: 20px; width: 100%; max-width: 420px; }
    .ok-box { background: var(--okbg); border: 1px solid var(--ok); color: var(--ok); padding: 16px; border-radius: 14px; margin-bottom: 14px; }
  </style>
</head>
<body>
  <div class="nav">
    <div class="nav-in">
      <div class="brand">🙏 PujaDiary Store • పూజా సామగ్రి</div>
      <div class="nav-btns">
        <button class="nbtn" onclick="showSection('shop')">Store</button>
        <button class="nbtn" id="ordersNavBtn" style="display:none" onclick="showSection('orders')">My Orders</button>
        <button class="nbtn" id="authBtn" onclick="openAuth()">Login / Register</button>
      </div>
    </div>
  </div>

  <div class="wrap">
    <div class="hero" id="hero">
      <div class="slide active">
        <h2>శుభకార్యాలకు స్వచ్ఛమైన పూజా సామగ్రి</h2>
        <p>Verified Pooja Kits curated by Ayyagaru with transparent pricing and doorstep delivery across Andhra & Telangana.</p>
        <button class="btn" onclick="document.getElementById('shopSec').scrollIntoView({behavior:'smooth'})">Browse 20+ Pooja Kits</button>
      </div>
      <div class="slide">
        <h2>Combine Multiple Poojas & Save</h2>
        <p>Select Ganapathi Vratham + Homam together — we automatically combine items, avoid duplicate idols, and calculate exact pricing.</p>
        <button class="btn" onclick="document.getElementById('shopSec').scrollIntoView({behavior:'smooth'})">Build Your Kit</button>
      </div>
      <div class="slide">
        <h2>Direct WhatsApp Sync with Ayyagaru</h2>
        <p>Opened a link from Ayyagaru? Review your exact list, uncheck items you already have, and get missing items notified on WhatsApp.</p>
      </div>
      <div class="dots" id="dots"></div>
    </div>

    <div id="shopSec">
      <div id="sharedBanner" class="card" style="display:none; background: var(--wnbg); border-color: var(--p);"></div>
      <div id="orderResult"></div>

      <div id="pickerCard" class="card">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px">
          <h3 style="margin:0;color:var(--m)">1. Select Pooja Categories & Kits</h3>
          <span id="selCount" style="color:var(--p);font-weight:700"></span>
        </div>
        <div class="tabs" id="catTabs"></div>
        <div class="grid" id="poojaGrid"></div>
      </div>

      <div class="card">
        <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px;margin-bottom:10px">
          <h3 style="margin:0;color:var(--m)" id="listHeading">2. Pooja Samagri & Pricing</h3>
          <div style="font-size:18px;font-weight:700;color:var(--m)" id="totalPrice">₹0</div>
        </div>
        <div id="itemsList"></div>
      </div>

      <div class="card" id="checkoutCard">
        <h3 style="margin:0 0 10px;color:var(--m)">3. Home Delivery Details</h3>
        <input type="text" id="dname" placeholder="Full Name / పూర్తి పేరు" />
        <input type="tel" id="dphone" maxlength="10" placeholder="10-digit Mobile / మొబైల్ నంబర్" />
        <textarea id="daddr" rows="2" placeholder="Delivery Address / చిరునామా"></textarea>
        <input type="text" id="dnotes" placeholder="Delivery notes / landmark (optional)" />
        <div id="orderErr" style="color:var(--er);font-size:13px;margin-bottom:8px"></div>
        <button class="btn" style="width:100%" onclick="placeOrder()">Confirm Delivery Order • ఆర్డర్ చేయండి</button>
      </div>
    </div>

    <div id="ordersSec" style="display:none">
      <div class="card">
        <h3 style="margin:0 0 10px;color:var(--m)">My Store Orders</h3>
        <div id="ordersList"></div>
      </div>
    </div>
  </div>

  <div class="modal-bg" id="authModal">
    <div class="modal">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">
        <h3 style="margin:0;color:var(--m)" id="authTitle">Customer Login</h3>
        <button class="btn sec" style="padding:4px 10px" onclick="closeAuth()">✕</button>
      </div>
      <div class="tabs">
        <button class="tab on" id="tabLog" onclick="setAuthMode('login')">Login</button>
        <button class="tab" id="tabReg" onclick="setAuthMode('register')">Register</button>
      </div>
      <div id="regFields" style="display:none">
        <input type="text" id="aname" placeholder="Full Name" />
        <input type="email" id="aemail" placeholder="Email (optional)" />
        <input type="text" id="aaddr" placeholder="Delivery Address" />
      </div>
      <input type="text" id="aphone" placeholder="Mobile Number (or Email for login)" />
      <input type="password" id="apass" placeholder="Password (6+ chars)" />
      <div id="authErr" style="color:var(--er);font-size:13px;margin-bottom:8px"></div>
      <button class="btn" style="width:100%" onclick="submitAuth()">Continue</button>
    </div>
  </div>

  <script>
    const BOOT = ${bootJson};
    const SOURCE = BOOT.shared ? 'ayyagaru_link' : 'direct';
    let webToken = localStorage.getItem('pujadiary_web_token') || '';
    let webUser = null;
    let activeCat = 'all';
    let selectedPoojaIds = BOOT.shared ? [] : (BOOT.catalog[0] ? [BOOT.catalog[0].id] : []);
    let currentItems = [];
    let authMode = 'login';

    // Carousel
    let slideIdx = 0;
    const slides = document.querySelectorAll('.slide');
    const dotsEl = document.getElementById('dots');
    slides.forEach((_, i) => {
      const d = document.createElement('div');
      d.className = 'dot' + (i === 0 ? ' active' : '');
      d.onclick = () => showSlide(i);
      dotsEl.appendChild(d);
    });
    function showSlide(i) {
      slideIdx = (i + slides.length) % slides.length;
      slides.forEach((s, idx) => s.classList.toggle('active', idx === slideIdx));
      dotsEl.querySelectorAll('.dot').forEach((d, idx) => d.classList.toggle('active', idx === slideIdx));
    }
    setInterval(() => showSlide(slideIdx + 1), 4500);

    // Auth
    async function loadMe() {
      if (!webToken) return;
      try {
        const res = await fetch('/api/web/me', { headers: { Authorization: 'Bearer ' + webToken } });
        if (!res.ok) throw new Error();
        const data = await res.json();
        webUser = data.customer;
        document.getElementById('authBtn').textContent = '👤 ' + webUser.name + ' (Logout)';
        document.getElementById('ordersNavBtn').style.display = 'inline-block';
        if (!document.getElementById('dname').value) document.getElementById('dname').value = webUser.name;
        if (!document.getElementById('dphone').value) document.getElementById('dphone').value = webUser.phone;
        if (!document.getElementById('daddr').value) document.getElementById('daddr').value = webUser.address || '';
        document.getElementById('ordersList').innerHTML = data.orders.length
          ? data.orders.map(o => '<div class="row"><div class="iname">' + o.poojaType + '<div class="isub">Order #' + o.id + ' • ' + o.source + ' • ' + o.status + '</div></div><div class="price">₹' + o.totalAmount + '</div></div>').join('')
          : '<p style="color:var(--mut)">No orders yet.</p>';
      } catch {
        localStorage.removeItem('pujadiary_web_token');
        webToken = '';
      }
    }
    function openAuth() {
      if (webUser) {
        localStorage.removeItem('pujadiary_web_token');
        webToken = ''; webUser = null;
        document.getElementById('authBtn').textContent = 'Login / Register';
        document.getElementById('ordersNavBtn').style.display = 'none';
        return;
      }
      document.getElementById('authModal').classList.add('open');
    }
    function closeAuth() { document.getElementById('authModal').classList.remove('open'); }
    function setAuthMode(m) {
      authMode = m;
      document.getElementById('tabLog').classList.toggle('on', m === 'login');
      document.getElementById('tabReg').classList.toggle('on', m === 'register');
      document.getElementById('regFields').style.display = m === 'register' ? 'block' : 'none';
      document.getElementById('authTitle').textContent = m === 'login' ? 'Customer Login' : 'Create Store Account';
    }
    async function submitAuth() {
      const err = document.getElementById('authErr'); err.textContent = '';
      const body = authMode === 'login'
        ? { identifier: document.getElementById('aphone').value, password: document.getElementById('apass').value }
        : { name: document.getElementById('aname').value, phone: document.getElementById('aphone').value, email: document.getElementById('aemail').value, address: document.getElementById('aaddr').value, password: document.getElementById('apass').value, source: SOURCE };
      const res = await fetch('/api/web/' + authMode, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const data = await res.json();
      if (!res.ok) { err.textContent = data.error || 'Failed'; return; }
      webToken = data.token;
      localStorage.setItem('pujadiary_web_token', webToken);
      closeAuth();
      loadMe();
    }

    function showSection(sec) {
      document.getElementById('shopSec').style.display = sec === 'shop' ? 'block' : 'none';
      document.getElementById('ordersSec').style.display = sec === 'orders' ? 'block' : 'none';
    }

    // Catalog & Samagri Merger
    function renderCatalog() {
      const tabs = [{ id: 'all', en: 'All', te: 'అన్నీ' }, ...BOOT.categories];
      document.getElementById('catTabs').innerHTML = tabs.map(c =>
        '<button class="tab ' + (activeCat === c.id ? 'on' : '') + '" onclick="activeCat=\\'' + c.id + '\\';renderCatalog()">' + c.te + ' (' + c.en + ')</button>'
      ).join('');
      const list = activeCat === 'all' ? BOOT.catalog : BOOT.catalog.filter(p => p.category === activeCat);
      document.getElementById('selCount').textContent = selectedPoojaIds.length + ' selected';
      document.getElementById('poojaGrid').innerHTML = list.map(p => {
        const on = selectedPoojaIds.includes(p.id);
        return '<div class="pooja-card ' + (on ? 'on' : '') + '" onclick="togglePooja(\\'' + p.id + '\\')">' +
          '<input type="checkbox" ' + (on ? 'checked' : '') + ' onclick="event.stopPropagation();togglePooja(\\'' + p.id + '\\')" />' +
          '<div><div style="font-weight:700;font-size:14px">' + p.te + '</div><div class="isub">' + p.en + ' • ' + p.items.length + ' items</div></div></div>';
      }).join('');
    }
    function togglePooja(id) {
      selectedPoojaIds = selectedPoojaIds.includes(id) ? selectedPoojaIds.filter(x => x !== id) : [...selectedPoojaIds, id];
      BOOT.shared = null;
      buildItemsFromSelection();
      renderCatalog();
    }
    function buildItemsFromSelection() {
      if (BOOT.shared) {
        currentItems = BOOT.shared.items.map(it => ({ ...it, checked: it.available !== false }));
      } else {
        const map = new Map();
        BOOT.catalog.filter(p => selectedPoojaIds.includes(p.id)).forEach(p => {
          p.items.forEach(it => {
            const k = it.item.trim().toLowerCase();
            if (!map.has(k)) map.set(k, { ...it, checked: it.available !== false });
          });
        });
        currentItems = Array.from(map.values());
      }
      renderItems();
    }
    function renderItems() {
      let total = 0;
      const el = document.getElementById('itemsList');
      el.innerHTML = currentItems.map((it, idx) => {
        const isMissing = !it.available || !it.checked;
        if (!isMissing) total += Number(it.price) || 0;
        return '<div class="row ' + (isMissing ? 'missing' : '') + '">' +
          '<input type="checkbox" ' + (it.checked && it.available ? 'checked' : '') + (!it.available ? ' disabled' : '') + ' onchange="toggleItem(' + idx + ')" />' +
          '<div class="iname">' + (it.te || it.item) + '<div class="isub">' + it.item + '</div></div>' +
          (isMissing ? '<span class="miss-tag">Missing / Crossed</span>' : '') +
          '<span class="qty">' + it.qty + '</span>' +
          '<span class="price">' + (isMissing ? '<s>₹' + it.price + '</s>' : '₹' + it.price) + '</span>' +
        '</div>';
      }).join('');
      document.getElementById('totalPrice').textContent = 'Total: ₹' + total.toLocaleString('en-IN');
    }
    function toggleItem(idx) {
      currentItems[idx].checked = !currentItems[idx].checked;
      renderItems();
    }

    if (BOOT.shared) {
      const b = document.getElementById('sharedBanner');
      b.style.display = 'block';
      b.innerHTML = '<strong style="color:var(--m)">🙏 Ayyagaru Shared List: ' + BOOT.shared.poojaType + '</strong>' +
        '<div class="isub" style="margin-top:4px">Priest: ' + BOOT.shared.priestName + (BOOT.shared.date ? ' • 📅 ' + BOOT.shared.date + ' ' + BOOT.shared.time : '') + '</div>';
      document.getElementById('dname').value = BOOT.shared.customerName || '';
      document.getElementById('dphone').value = BOOT.shared.customerPhone || '';
      document.getElementById('daddr').value = BOOT.shared.addr || '';
    }

    async function placeOrder() {
      const err = document.getElementById('orderErr'); err.textContent = '';
      const activeItems = currentItems.filter(it => it.available && it.checked);
      const missingItems = currentItems.filter(it => !it.available || !it.checked);
      const totalAmount = activeItems.reduce((s, x) => s + (Number(x.price) || 0), 0);
      const poojaType = BOOT.shared ? BOOT.shared.poojaType : BOOT.catalog.filter(p => selectedPoojaIds.includes(p.id)).map(p => p.te).join(' + ');
      const tok = BOOT.shared ? BOOT.shared.token : 'direct';

      const res = await fetch('/api/public/store/' + encodeURIComponent(tok) + '/order', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(webToken ? { Authorization: 'Bearer ' + webToken } : {}) },
        body: JSON.stringify({
          customerName: document.getElementById('dname').value,
          phone: document.getElementById('dphone').value,
          address: document.getElementById('daddr').value,
          notes: document.getElementById('dnotes').value,
          poojaType,
          items: activeItems,
          missingItems,
          totalAmount
        })
      });
      const data = await res.json();
      if (!res.ok) { err.textContent = data.error || 'Failed'; return; }

      document.getElementById('orderResult').innerHTML =
        '<div class="ok-box"><div>🎉 Order #' + data.orderId + ' Confirmed! Total: ₹' + data.totalAmount + '</div>' +
        (missingItems.length ? '<div style="margin-top:6px;font-size:13px">Missing items (' + missingItems.length + ') ready to send on WhatsApp:</div>' : '') +
        '<div style="margin-top:10px"><a class="btn wa" href="' + data.whatsappMissingUrl + '" target="_blank">📲 Send Missing Items on WhatsApp</a></div></div>';
      document.getElementById('checkoutCard').style.display = 'none';
      loadMe();
    }

    renderCatalog();
    buildItemsFromSelection();
    loadMe();
  </script>
</body>
</html>`;
}

router.get('/', (_req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(renderWebsiteHtml(null));
});

router.get('/store', (_req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(renderWebsiteHtml(null));
});

router.get('/store/:token', (req, res) => {
  const payload = loadSharePayload(String(req.params.token || '').trim());
  if (!payload) return res.status(404).send('<h2>Samagri list not found or expired.</h2>');
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(renderWebsiteHtml(payload));
});

module.exports = router;
