const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const dbPath = process.env.DB_PATH
  ? path.resolve(process.env.DB_PATH)
  : path.join(__dirname, '..', 'data', 'pujadiary.db');

fs.mkdirSync(path.dirname(dbPath), { recursive: true });

const db = new DatabaseSync(dbPath);
db.exec('PRAGMA journal_mode = WAL;');
db.exec('PRAGMA foreign_keys = ON;');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    phone TEXT NOT NULL UNIQUE,
    email TEXT DEFAULT '',
    username TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    name TEXT NOT NULL,
    addr TEXT DEFAULT '',
    locations TEXT DEFAULT '',
    notify INTEGER DEFAULT 1,
    lang TEXT DEFAULT 'te',
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS password_resets (
    email TEXT PRIMARY KEY,
    code TEXT NOT NULL,
    expires_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS otps (
    phone TEXT PRIMARY KEY,
    code TEXT NOT NULL,
    expires_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS puja_types (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    UNIQUE(user_id, name)
  );

  CREATE TABLE IF NOT EXISTS customers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    phone TEXT NOT NULL,
    gotram TEXT DEFAULT '-',
    addr TEXT DEFAULT '-',
    family TEXT DEFAULT '',
    notes TEXT DEFAULT '',
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS bookings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    cid INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
    type TEXT NOT NULL,
    date TEXT NOT NULL,
    time TEXT NOT NULL,
    addr TEXT NOT NULL,
    total REAL NOT NULL,
    adv REAL NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'upcoming' CHECK(status IN ('upcoming','completed','cancelled')),
    notes TEXT DEFAULT '',
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS samagri (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    puja TEXT NOT NULL,
    name TEXT NOT NULL,
    qty TEXT NOT NULL DEFAULT '1',
    done INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS payments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK(kind IN ('income','expense')),
    booking_id INTEGER REFERENCES bookings(id) ON DELETE SET NULL,
    title TEXT NOT NULL,
    amount REAL NOT NULL,
    mode TEXT NOT NULL CHECK(mode IN ('Cash','UPI','Bank')),
    date TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS reminders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    date TEXT NOT NULL,
    time TEXT NOT NULL,
    done INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS rituals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    family TEXT NOT NULL,
    gotram TEXT DEFAULT '-',
    type TEXT NOT NULL,
    date TEXT NOT NULL,
    tithi TEXT DEFAULT '-',
    reminder_date TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS stock (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    qty REAL NOT NULL DEFAULT 0,
    unit TEXT NOT NULL DEFAULT 'pcs',
    min_qty REAL NOT NULL DEFAULT 3
  );

  CREATE TABLE IF NOT EXISTS subscriptions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    plan TEXT NOT NULL,
    amount REAL NOT NULL,
    status TEXT NOT NULL,
    started_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS pooja_categories (
    id TEXT PRIMARY KEY,
    en TEXT NOT NULL,
    te TEXT NOT NULL,
    sort_order INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS pooja_catalog (
    id TEXT PRIMARY KEY,
    category TEXT NOT NULL REFERENCES pooja_categories(id) ON DELETE CASCADE,
    en TEXT NOT NULL,
    te TEXT NOT NULL,
    sort_order INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS pooja_catalog_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    pooja_id TEXT NOT NULL REFERENCES pooja_catalog(id) ON DELETE CASCADE,
    item TEXT NOT NULL,
    qty TEXT NOT NULL,
    te TEXT NOT NULL,
    price REAL NOT NULL DEFAULT 30,
    available INTEGER NOT NULL DEFAULT 1
  );

  CREATE TABLE IF NOT EXISTS web_customers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    phone TEXT NOT NULL UNIQUE,
    email TEXT DEFAULT '',
    password_hash TEXT NOT NULL,
    address TEXT DEFAULT '',
    source TEXT NOT NULL DEFAULT 'direct',
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS samagri_checks (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    item_key TEXT NOT NULL,
    done INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (user_id, item_key)
  );

  CREATE TABLE IF NOT EXISTS shared_lists (
    token TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    pooja_type TEXT NOT NULL,
    items_json TEXT NOT NULL DEFAULT '[]',
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS store_orders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    token TEXT NOT NULL,
    user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    web_customer_id INTEGER REFERENCES web_customers(id) ON DELETE SET NULL,
    booking_id INTEGER REFERENCES bookings(id) ON DELETE SET NULL,
    customer_name TEXT NOT NULL,
    phone TEXT NOT NULL,
    address TEXT NOT NULL,
    pooja_type TEXT NOT NULL,
    items_json TEXT NOT NULL DEFAULT '[]',
    missing_items_json TEXT NOT NULL DEFAULT '[]',
    total_amount REAL NOT NULL DEFAULT 0,
    source TEXT NOT NULL DEFAULT 'ayyagaru_link',
    notes TEXT DEFAULT '',
    status TEXT NOT NULL DEFAULT 'pending',
    created_at TEXT DEFAULT (datetime('now'))
  );
`);

try { db.exec("ALTER TABLE bookings ADD COLUMN items_json TEXT DEFAULT '[]'"); } catch {}
try { db.exec("ALTER TABLE bookings ADD COLUMN share_token TEXT DEFAULT ''"); } catch {}
try { db.exec('ALTER TABLE pooja_catalog_items ADD COLUMN price REAL NOT NULL DEFAULT 30'); } catch {}
try { db.exec('ALTER TABLE pooja_catalog_items ADD COLUMN available INTEGER NOT NULL DEFAULT 1'); } catch {}
try { db.exec('ALTER TABLE store_orders ADD COLUMN web_customer_id INTEGER'); } catch {}
try { db.exec("ALTER TABLE store_orders ADD COLUMN missing_items_json TEXT DEFAULT '[]'"); } catch {}
try { db.exec('ALTER TABLE store_orders ADD COLUMN total_amount REAL NOT NULL DEFAULT 0'); } catch {}
try { db.exec("ALTER TABLE store_orders ADD COLUMN source TEXT DEFAULT 'ayyagaru_link'"); } catch {}

function estimateItemPrice(item, qty) {
  const s = String(item || '').toLowerCase();
  const q = String(qty || '').toLowerCase();
  if (s.includes('saree') || s.includes('vastram') || s.includes('mandapam')) return 350;
  if (s.includes('idol') || s.includes('lingam') || s.includes('kalasham') || s.includes('kundam') || s.includes('vessel') || s.includes('pot') || s.includes('stove')) return 250;
  if (s.includes('ghee')) return q.includes('litre') ? 650 : 220;
  if (s.includes('honey')) return 120;
  if (s.includes('homam wood') || s.includes('homam samagri')) return 180;
  if (s.includes('garland') || s.includes('flower') || s.includes('rose') || s.includes('lotus')) return 100;
  if (s.includes('milk') || s.includes('curd') || s.includes('panchamrutam')) return 70;
  if (s.includes('coconut')) return 120;
  if (s.includes('rice') || s.includes('banana') || s.includes('fruit') || s.includes('sweet') || s.includes('payasam') || s.includes('modak')) return 90;
  return 40;
}

const { POOJA_CATEGORIES, POOJA_CATALOG } = require('./catalogSeed');
const catCount = db.prepare('SELECT COUNT(*) AS cnt FROM pooja_catalog').get().cnt;
if (catCount === 0) {
  runTx(() => {
    const insCat = db.prepare('INSERT OR IGNORE INTO pooja_categories (id, en, te, sort_order) VALUES (?, ?, ?, ?)');
    POOJA_CATEGORIES.forEach((c, idx) => insCat.run(c.id, c.en, c.te, idx));
    const insPooja = db.prepare('INSERT OR IGNORE INTO pooja_catalog (id, category, en, te, sort_order) VALUES (?, ?, ?, ?, ?)');
    const insItem = db.prepare('INSERT INTO pooja_catalog_items (pooja_id, item, qty, te, price, available) VALUES (?, ?, ?, ?, ?, 1)');
    POOJA_CATALOG.forEach((p, idx) => {
      insPooja.run(p.id, p.category, p.en, p.te, idx);
      for (const it of p.items) {
        insItem.run(p.id, it.item, it.qty, it.te, estimateItemPrice(it.item, it.qty));
      }
    });
  });
}

try {
  db.exec('ALTER TABLE users ADD COLUMN email TEXT DEFAULT ""');
} catch {}
try {
  db.exec('ALTER TABLE users ADD COLUMN sub_active INTEGER DEFAULT 0');
} catch {}
try {
  db.exec("ALTER TABLE users ADD COLUMN sub_plan TEXT DEFAULT 'yearly_1299'");
} catch {}
try {
  db.exec('ALTER TABLE users ADD COLUMN sub_expires_at TEXT DEFAULT ""');
} catch {}
db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email ON users(email) WHERE email IS NOT NULL AND email != ''");

function runTx(fn) {
  db.exec('BEGIN');
  try {
    const res = fn();
    db.exec('COMMIT');
    return res;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

module.exports = { db, runTx, dbPath };

