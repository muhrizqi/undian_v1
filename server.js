const express = require('express');
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const app = express();
app.use(express.json({ limit: '8mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ---------- DATABASE ----------
// DATA_DIR bisa di-set lewat environment variable (dipakai untuk mount volume
// persisten di Coolify, misal /app/data), supaya data.db tidak hilang saat
// container di-redeploy/rebuild.
const DATA_DIR = process.env.DATA_DIR || __dirname;
fs.mkdirSync(DATA_DIR, { recursive: true });
const DB_PATH = path.join(DATA_DIR, 'data.db');
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

db.exec(`
CREATE TABLE IF NOT EXISTS participants (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  nik TEXT UNIQUE NOT NULL,
  nama TEXT NOT NULL,
  alamat TEXT NOT NULL,
  nomor_undian INTEGER UNIQUE NOT NULL,
  petugas TEXT,
  sumber TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_nomor_undian ON participants(nomor_undian);
CREATE INDEX IF NOT EXISTS idx_nama ON participants(nama);
CREATE INDEX IF NOT EXISTS idx_alamat ON participants(alamat);
`);

// ---------- SIMPLE PIN PROTECTION FOR ADMIN/DRAW DATA ----------
// Ganti PIN ini via environment variable ADMIN_PIN saat menjalankan server,
// contoh: ADMIN_PIN=778899 npm start
const ADMIN_PIN = process.env.ADMIN_PIN || '123456';

function requireAdminPin(req, res, next) {
  const pin = req.headers['x-admin-pin'] || req.query.pin;
  if (String(pin) !== String(ADMIN_PIN)) {
    return res.status(401).json({ error: 'PIN salah atau belum diisi.' });
  }
  next();
}

// Health check sederhana (berguna untuk healthcheck Coolify/Docker)
app.get('/api/health', (req, res) => {
  res.json({ ok: true });
});

app.get('/api/verify-pin', (req, res) => {
  const pin = req.headers['x-admin-pin'] || req.query.pin;
  res.json({ ok: String(pin) === String(ADMIN_PIN) });
});

// ---------- HELPERS ----------
function nextNomorUndian() {
  const row = db.prepare('SELECT MAX(nomor_undian) as maxN FROM participants').get();
  return (row.maxN || 0) + 1;
}

const insertStmt = db.prepare(`
  INSERT INTO participants (nik, nama, alamat, nomor_undian, petugas, sumber, created_at)
  VALUES (?, ?, ?, ?, ?, ?, ?)
`);

// Semua langkah di bawah ini SINKRON (better-sqlite3) dan dibungkus transaction,
// sehingga aman meski banyak petugas mengirim data hampir bersamaan.
const registerTx = db.transaction((nik, nama, alamat, petugas, sumber) => {
  const existing = db.prepare('SELECT * FROM participants WHERE nik = ?').get(nik);
  if (existing) {
    return { isNew: false, data: existing };
  }
  const nomor = nextNomorUndian();
  const created_at = new Date().toISOString();
  insertStmt.run(nik, nama, alamat, nomor, petugas || null, sumber || null, created_at);
  const data = db.prepare('SELECT * FROM participants WHERE nik = ?').get(nik);
  return { isNew: true, data };
});

// ---------- API: REGISTER / SCAN ----------
// Dipakai oleh halaman /scan.html (petugas) dan /self-scan.html (peserta mandiri)
app.post('/api/register', (req, res) => {
  try {
    let { nik, nama, alamat, petugas, sumber } = req.body || {};
    if (!nik || !nama || !alamat) {
      return res.status(400).json({ error: 'NIK, nama, dan alamat wajib diisi.' });
    }
    nik = String(nik).replace(/\D/g, '');
    if (nik.length !== 16) {
      return res.status(400).json({ error: 'NIK harus berupa 16 digit angka. Mohon periksa/edit hasil scan.' });
    }
    nama = String(nama).trim().toUpperCase();
    alamat = String(alamat).trim().toUpperCase();
    if (!nama || !alamat) {
      return res.status(400).json({ error: 'Nama dan alamat tidak boleh kosong.' });
    }

    const result = registerTx(nik, nama, alamat, petugas, sumber);
    res.json({
      isNew: result.isNew,
      nomor_undian: result.data.nomor_undian,
      nama: result.data.nama,
      alamat: result.data.alamat,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Terjadi kesalahan server. Coba lagi.' });
  }
});

// ---------- API: LIST / SEARCH PARTICIPANTS (untuk halaman admin) ----------
app.get('/api/participants', requireAdminPin, (req, res) => {
  const q = (req.query.q || '').trim();
  const page = Math.max(parseInt(req.query.page) || 1, 1);
  const pageSize = Math.min(Math.max(parseInt(req.query.pageSize) || 50, 1), 200);
  const offset = (page - 1) * pageSize;

  let where = '';
  let params = [];
  if (q) {
    where = `WHERE CAST(nomor_undian AS TEXT) LIKE ? OR nama LIKE ? OR alamat LIKE ?`;
    params = [`%${q}%`, `%${q.toUpperCase()}%`, `%${q.toUpperCase()}%`];
  }

  const total = db.prepare(`SELECT COUNT(*) as c FROM participants ${where}`).get(...params).c;
  const rows = db
    .prepare(
      `SELECT nomor_undian, nama, alamat FROM participants ${where} ORDER BY nomor_undian ASC LIMIT ? OFFSET ?`
    )
    .all(...params, pageSize, offset);

  res.json({ total, page, pageSize, rows });
});

// ---------- API: LOOKUP BY NOMOR UNDIAN (untuk halaman pengundian) ----------
app.get('/api/undian/:nomor', requireAdminPin, (req, res) => {
  const nomor = parseInt(req.params.nomor);
  if (!nomor) return res.status(400).json({ error: 'Nomor tidak valid.' });
  const row = db
    .prepare('SELECT nomor_undian, nama, alamat FROM participants WHERE nomor_undian = ?')
    .get(nomor);
  if (!row) return res.status(404).json({ error: 'Nomor undian tidak ditemukan.' });
  res.json(row);
});

// ---------- API: STATS ----------
app.get('/api/stats', requireAdminPin, (req, res) => {
  const total = db.prepare('SELECT COUNT(*) as c FROM participants').get().c;
  res.json({ total });
});

// ---------- API: EXPORT CSV ----------
app.get('/api/export.csv', requireAdminPin, (req, res) => {
  const rows = db
    .prepare('SELECT nomor_undian, nama, alamat, nik, created_at FROM participants ORDER BY nomor_undian ASC')
    .all();
  const esc = (s) => `"${String(s).replace(/"/g, '""')}"`;
  let csv = 'nomor_undian,nama,alamat,nik,created_at\n';
  for (const r of rows) {
    csv += [r.nomor_undian, esc(r.nama), esc(r.alamat), r.nik, r.created_at].join(',') + '\n';
  }
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename=peserta_undian_jogokariyan.csv');
  res.send('\uFEFF' + csv);
});

// ---------- START SERVER ----------
const PORT = process.env.PORT || 3000;
const USE_HTTPS = process.env.USE_HTTPS === '1';

if (USE_HTTPS) {
  const https = require('https');
  const certDir = path.join(__dirname, 'cert');
  const options = {
    key: fs.readFileSync(path.join(certDir, 'key.pem')),
    cert: fs.readFileSync(path.join(certDir, 'cert.pem')),
  };
  https.createServer(options, app).listen(PORT, '0.0.0.0', () => {
    console.log(`Server HTTPS berjalan di https://0.0.0.0:${PORT}`);
  });
} else {
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server berjalan di http://0.0.0.0:${PORT}`);
    console.log('CATATAN: kamera (scan KTP) hanya bisa diakses lewat HTTPS atau localhost.');
    console.log('Lihat README.md bagian HTTPS sebelum dipakai di banyak laptop/HP.');
  });
}
