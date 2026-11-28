const express = require('express');
const { db } = require('../db');

const router = express.Router();

function loadSharePayload(token) {
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
    const order = db.prepare('SELECT id, status, created_at FROM store_orders WHERE token = ? ORDER BY id DESC LIMIT 1').get(token);
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
      items,
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
  const order = db.prepare('SELECT id, status, created_at FROM store_orders WHERE token = ? ORDER BY id DESC LIMIT 1').get(token);
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
    items,
    existingOrder: order || null,
  };
}

router.get('/api/public/store/:token', (req, res) => {
  const payload = loadSharePayload(String(req.params.token || '').trim());
  if (!payload) return res.status(404).json({ error: 'Samagri list not found' });
  const { userId, ...pub } = payload;
  res.json(pub);
});

router.post('/api/public/store/:token/order', (req, res) => {
  const payload = loadSharePayload(String(req.params.token || '').trim());
  if (!payload) return res.status(404).json({ error: 'Samagri list not found' });

  const customerName = String(req.body?.customerName || '').trim();
  const phone = String(req.body?.phone || '').replace(/\D/g, '');
  const address = String(req.body?.address || '').trim();
  const notes = String(req.body?.notes || '').trim();
  const items = Array.isArray(req.body?.items) ? req.body.items : payload.items;

  if (customerName.length < 2 || !/^[6-9]\d{9}$/.test(phone) || address.length < 3) {
    return res.status(400).json({ error: 'Please enter valid name, 10-digit mobile number, and delivery address.' });
  }
  if (!items.length) {
    return res.status(400).json({ error: 'Please select at least one item for delivery.' });
  }

  const info = db
    .prepare(
      `INSERT INTO store_orders (token, user_id, booking_id, customer_name, phone, address, pooja_type, items_json, notes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(payload.token, payload.userId, payload.bookingId, customerName, phone, address, payload.poojaType, JSON.stringify(items), notes);

  res.status(201).json({ ok: true, orderId: Number(info.lastInsertRowid), status: 'pending' });
});

router.get('/store/:token', (req, res) => {
  const payload = loadSharePayload(String(req.params.token || '').trim());
  if (!payload) {
    return res.status(404).send('<h2>Samagri list not found or expired.</h2>');
  }
  const safeJson = JSON.stringify({
    token: payload.token,
    poojaType: payload.poojaType,
    date: payload.date,
    time: payload.time,
    addr: payload.addr,
    customerName: payload.customerName,
    customerPhone: payload.customerPhone,
    priestName: payload.priestName,
    items: payload.items,
    existingOrder: payload.existingOrder,
  }).replace(/</g, '\\u003c');

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(`<!DOCTYPE html>
<html lang="te">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>PujaDiary Store – పూజా సామగ్రి డెలివరీ</title>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700&family=Noto+Sans+Telugu:wght@400;600;700&display=swap" rel="stylesheet">
  <style>
    * { box-sizing: border-box; }
    body { margin: 0; font-family: 'Noto Sans Telugu', 'Inter', sans-serif; background: #FFF9F0; color: #292524; }
    .hdr { background: linear-gradient(135deg, #D97706, #7F1D1D); color: #fff; padding: 20px 16px 26px; border-bottom-left-radius: 26px; border-bottom-right-radius: 26px; }
    .hdr h1 { margin: 0; font-size: 20px; }
    .hdr p { margin: 4px 0 0; font-size: 13px; color: #FFEDD5; }
    .wrap { max-width: 520px; margin: 0 auto; padding: 14px; }
    .card { background: #fff; border: 1px solid #EADFCB; border-radius: 16px; padding: 14px; margin-bottom: 12px; box-shadow: 0 2px 8px rgba(127,29,29,0.06); }
    .title { font-weight: 700; color: #7F1D1D; font-size: 16px; margin: 0 0 8px; }
    .row { display: flex; align-items: center; gap: 10px; padding: 9px 0; border-bottom: 1px solid #FFF9F0; cursor: pointer; }
    .row:last-child { border-bottom: none; }
    .row input { width: 20px; height: 20px; accent-color: #D97706; }
    .iname { flex: 1; font-size: 14px; font-weight: 600; }
    .isub { font-size: 12px; color: #78716C; font-weight: 400; }
    .qty { background: #FEF3C7; color: #7F1D1D; font-weight: 700; font-size: 12px; padding: 4px 10px; border-radius: 10px; white-space: nowrap; }
    label { display: block; font-size: 12px; color: #78716C; margin: 10px 0 4px; }
    input[type=text], input[type=tel], textarea { width: 100%; padding: 11px 12px; border: 1px solid #EADFCB; border-radius: 12px; font-size: 14px; font-family: inherit; }
    .btn { width: 100%; padding: 14px; border: none; border-radius: 14px; background: #D97706; color: #fff; font-size: 16px; font-weight: 700; cursor: pointer; margin-top: 14px; }
    .btn:disabled { opacity: 0.6; }
    .ok { background: #DCFCE7; border: 1px solid #15803D; color: #15803D; padding: 14px; border-radius: 14px; font-weight: 600; text-align: center; }
    .err { color: #DC2626; font-size: 13px; margin-top: 8px; }
  </style>
</head>
<body>
  <div class="hdr">
    <div class="wrap" style="padding:0">
      <h1>PujaDiary Store • పూజా సామగ్రి</h1>
      <p id="sub"></p>
    </div>
  </div>
  <div class="wrap">
    <div id="statusBox"></div>
    <div class="card">
      <div class="title" id="listTitle"></div>
      <div id="items"></div>
    </div>
    <div class="card" id="formCard">
      <div class="title">హోమ్ డెలివరీ వివరాలు / Delivery Details</div>
      <label>పేరు / Full Name</label>
      <input type="text" id="cname" />
      <label>మొబైల్ నంబర్ / Mobile Number (10 digits)</label>
      <input type="tel" id="cphone" maxlength="10" />
      <label>డెలివరీ చిరునామా / Delivery Address</label>
      <textarea id="caddr" rows="2"></textarea>
      <label>గమనికలు / Notes (optional)</label>
      <input type="text" id="cnotes" placeholder="Landmark / delivery time" />
      <div class="err" id="err"></div>
      <button class="btn" id="orderBtn" onclick="submitOrder()">డెలివరీ ఆర్డర్ చేయండి • Order for Delivery</button>
    </div>
  </div>
  <script>
    const DATA = ${safeJson};
    document.getElementById('sub').textContent = DATA.poojaType + (DATA.date ? ' • ' + DATA.date + ' ' + DATA.time : '') + ' • ' + DATA.priestName;
    document.getElementById('listTitle').textContent = 'పూజ సామగ్రి జాబితా (' + DATA.items.length + ' items)';
    document.getElementById('cname').value = DATA.customerName || '';
    document.getElementById('cphone').value = DATA.customerPhone || '';
    document.getElementById('caddr').value = DATA.addr || '';

    const checked = DATA.items.map(() => true);
    const itemsEl = document.getElementById('items');
    DATA.items.forEach((it, idx) => {
      const row = document.createElement('label');
      row.className = 'row';
      row.innerHTML = '<input type="checkbox" checked data-idx="' + idx + '" />' +
        '<div class="iname">' + (it.te || it.item) + (it.te && it.item && it.te !== it.item ? '<div class="isub">' + it.item + '</div>' : '') + '</div>' +
        '<span class="qty">' + it.qty + '</span>';
      row.querySelector('input').addEventListener('change', (e) => { checked[idx] = e.target.checked; });
      itemsEl.appendChild(row);
    });

    if (DATA.existingOrder) {
      document.getElementById('statusBox').innerHTML = '<div class="ok" style="margin-bottom:12px">ఆర్డర్ నమోదైంది! Order #' + DATA.existingOrder.id + ' (' + DATA.existingOrder.status + ')</div>';
    }

    async function submitOrder() {
      const errEl = document.getElementById('err');
      const btn = document.getElementById('orderBtn');
      errEl.textContent = '';
      const selectedItems = DATA.items.filter((_, i) => checked[i]);
      btn.disabled = true;
      try {
        const res = await fetch('/api/public/store/' + encodeURIComponent(DATA.token) + '/order', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            customerName: document.getElementById('cname').value,
            phone: document.getElementById('cphone').value,
            address: document.getElementById('caddr').value,
            notes: document.getElementById('cnotes').value,
            items: selectedItems
          })
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Failed');
        document.getElementById('statusBox').innerHTML = '<div class="ok" style="margin-bottom:12px">ధన్యవాదాలు! మీ డెలివరీ ఆర్డర్ #' + data.orderId + ' నమోదైంది.</div>';
        document.getElementById('formCard').style.display = 'none';
      } catch (e) {
        errEl.textContent = e.message;
      } finally {
        btn.disabled = false;
      }
    }
  </script>
</body>
</html>`);
});

module.exports = router;
