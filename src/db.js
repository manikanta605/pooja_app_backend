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
`);

try {
  db.exec('ALTER TABLE users ADD COLUMN email TEXT DEFAULT ""');
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

