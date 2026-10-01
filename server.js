require('dotenv').config();
const express      = require('express');
const { Pool }     = require('pg');
const path         = require('path');
const fs           = require('fs');
const multer       = require('multer');
const { google }   = require('googleapis');
const { execFile } = require('child_process');
const session      = require('express-session');
const PgSession    = require('connect-pg-simple')(session);
const bcrypt       = require('bcryptjs');

const upload = multer({ dest: path.join(__dirname, 'tmp') });

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes('neon.tech') ? { rejectUnauthorized: false } : false,
});

const app  = express();
const PORT = process.env.PORT || 3000;

const q = (sql, params) => pool.query(sql, params);

// ── Helpers ───────────────────────────────────────────────────────────────────
function getOAuth2Client(cfg) {
  const redirect = process.env.OAUTH_REDIRECT_URI || `http://localhost:${PORT}/api/drive/callback`;
  return new google.auth.OAuth2(cfg.drive_client_id, cfg.drive_client_secret, redirect);
}
async function getConfig(userId) {
  const { rows } = await q('SELECT * FROM config WHERE user_id=$1', [userId]);
  const c = {};
  for (const r of rows) c[r.key] = r.value;
  return c;
}
async function setConfig(userId, key, value) {
  await q(
    'INSERT INTO config (user_id,key,value) VALUES ($1,$2,$3) ON CONFLICT (user_id,key) DO UPDATE SET value=EXCLUDED.value',
    [userId, key, String(value)]
  );
}
async function delConfig(userId, keys) {
  for (const k of keys) await q('DELETE FROM config WHERE user_id=$1 AND key=$2', [userId, k]);
}

// ── DB Init ───────────────────────────────────────────────────────────────────
async function initDB() {
  await q(`
    CREATE TABLE IF NOT EXISTS users (
      id            SERIAL PRIMARY KEY,
      username      TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      is_admin      BOOLEAN NOT NULL DEFAULT false,
      permissions   JSONB NOT NULL DEFAULT '["dashboard","snapshots","objetivo","estadisticas","operaciones","backup"]'
    );
    CREATE TABLE IF NOT EXISTS sessions (
      sid    VARCHAR NOT NULL COLLATE "default",
      sess   JSON NOT NULL,
      expire TIMESTAMP(6) NOT NULL,
      CONSTRAINT session_pkey PRIMARY KEY (sid)
    );
    CREATE INDEX IF NOT EXISTS idx_sessions_expire ON sessions (expire);
    CREATE TABLE IF NOT EXISTS snapshots (
      id       SERIAL PRIMARY KEY,
      user_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      label    TEXT NOT NULL,
      fecha    TEXT NOT NULL,
      acciones REAL NOT NULL DEFAULT 0,
      fondos   REAL NOT NULL DEFAULT 0,
      ahorro   REAL NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS config (
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      key     TEXT NOT NULL,
      value   TEXT,
      PRIMARY KEY (user_id, key)
    );
    CREATE TABLE IF NOT EXISTS acciones_ops (
      id                    SERIAL PRIMARY KEY,
      user_id               INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      accion                TEXT NOT NULL,
      fecha_compra          TEXT,
      fecha_venta           TEXT,
      titulos               REAL,
      precio_compra         REAL,
      comision_compra       REAL,
      precio_dolar_compra   REAL,
      comision_divisa_c     REAL,
      precio_venta          REAL,
      comision_venta        REAL,
      precio_dolar_venta    REAL,
      comision_divisa_v     REAL,
      total_compra          REAL,
      total_venta           REAL,
      beneficio             REAL
    );
    CREATE TABLE IF NOT EXISTS dividendos (
      id           SERIAL PRIMARY KEY,
      user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      accion       TEXT NOT NULL,
      fecha        TEXT,
      euros_accion REAL,
      bruto        REAL,
      neto         REAL
    );
    CREATE TABLE IF NOT EXISTS etf_compras (
      id           SERIAL PRIMARY KEY,
      user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      etf          TEXT NOT NULL,
      isin         TEXT,
      fecha_compra TEXT,
      importe      REAL,
      precio       REAL,
      titulos      REAL,
      comision     REAL
    );
    CREATE TABLE IF NOT EXISTS fondos_catalogo (
      id      SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      nombre  TEXT NOT NULL,
      isin    TEXT
    );
    CREATE TABLE IF NOT EXISTS fondos_traspasos (
      id            SERIAL PRIMARY KEY,
      user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      fondo_origen  TEXT NOT NULL,
      fondo_destino TEXT NOT NULL,
      fecha         TEXT,
      importe       REAL NOT NULL
    );
    CREATE TABLE IF NOT EXISTS etf_ventas (
      id                SERIAL PRIMARY KEY,
      user_id           INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      etf               TEXT NOT NULL,
      fecha_venta       TEXT,
      coste_total       REAL,
      comision_compra   REAL,
      cantidad          REAL,
      precio_venta      REAL,
      venta_bruto       REAL,
      venta_neto        REAL,
      comision_venta    REAL,
      irpf              REAL,
      ganancia_sin_irpf REAL,
      ganancia_con_irpf REAL
    );
    CREATE TABLE IF NOT EXISTS gastos (
      id        SERIAL PRIMARY KEY,
      user_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      nombre    TEXT NOT NULL,
      importe   REAL NOT NULL DEFAULT 0,
      categoria TEXT NOT NULL DEFAULT 'Otros'
    );
  `);

  // Seed users
  const { rows: [{ n }] } = await q('SELECT COUNT(*) as n FROM users');
  if (parseInt(n) === 0) {
    const adminHash = await bcrypt.hash(process.env.ADMIN_PASSWORD || 'admin123', 10);
    const userHash  = await bcrypt.hash(process.env.USER_PASSWORD  || 'user123',  10);
    await q(
      `INSERT INTO users (username, password_hash, is_admin, permissions) VALUES
       ($1,$2,true, '["dashboard","snapshots","objetivo","estadisticas","operaciones","backup"]'),
       ($3,$4,false,'["dashboard","estadisticas"]')`,
      [process.env.ADMIN_USERNAME || 'pepe', adminHash,
       process.env.USER_USERNAME  || 'padre', userHash]
    );
    console.log('✅ Usuarios creados');

    // Seed datos solo para el admin
    const { rows: [admin] } = await q('SELECT id FROM users WHERE is_admin=true LIMIT 1');
    const uid = admin.id;
    await seedData(uid);
  }
}

async function seedData(uid) {
  const snaps = [
    { mes:'Septiembre 2024', fecha:'2024-09-28', acciones:15574.96, fondos:1971.15,  ahorro:2847.52 },
    { mes:'Octubre 2024',    fecha:'2024-10-10', acciones:15899.60, fondos:2355.36,  ahorro:4149.30 },
    { mes:'Octubre 2024b',   fecha:'2024-10-29', acciones:16060.07, fondos:3316.44,  ahorro:4219.06 },
    { mes:'Noviembre 2024',  fecha:'2024-11-29', acciones:15767.49, fondos:3668.42,  ahorro:5293.11 },
    { mes:'Diciembre 2024',  fecha:'2024-12-29', acciones:15734.42, fondos:4022.05,  ahorro:5941.59 },
    { mes:'Enero 2025',      fecha:'2025-01-29', acciones:17085.33, fondos:4636.74,  ahorro:6585.80 },
    { mes:'Febrero 2025',    fecha:'2025-02-29', acciones:16131.96, fondos:3149.82,  ahorro:8561.94 },
    { mes:'Marzo 2025',      fecha:'2025-03-29', acciones:15249.48, fondos:3930.72,  ahorro:8447.31 },
    { mes:'Abril 2025',      fecha:'2025-04-29', acciones:19471.59, fondos:4234.65,  ahorro:2865.76 },
    { mes:'Mayo 2025',       fecha:'2025-05-29', acciones:18473.16, fondos:4368.25,  ahorro:4323.67 },
  ];
  for (const r of snaps)
    await q('INSERT INTO snapshots (user_id,label,fecha,acciones,fondos,ahorro) VALUES ($1,$2,$3,$4,$5,$6)',
      [uid, r.mes, r.fecha, r.acciones, r.fondos, r.ahorro]);

  const acciones = [
    { accion:'Merlin Properties', fecha_compra:'2024-09-10', fecha_venta:'2025-08-06', titulos:500,  precio_compra:11.55,  comision_compra:21.48, precio_dolar_compra:null, comision_divisa_c:null, precio_venta:12.7,    comision_venta:10.21, precio_dolar_venta:null, comision_divisa_v:null, total_compra:5796.48, total_venta:6339.79, beneficio:543.31 },
    { accion:'Repsol',            fecha_compra:'2025-02-19', fecha_venta:'2025-06-24', titulos:164,  precio_compra:12.15,  comision_compra:4.99,  precio_dolar_compra:null, comision_divisa_c:null, precio_venta:12.375,  comision_venta:1,     precio_dolar_venta:null, comision_divisa_v:null, total_compra:1997.59, total_venta:2028.5,  beneficio:30.91 },
    { accion:'Bayer',             fecha_compra:'2025-08-11', fecha_venta:'2025-10-02', titulos:120,  precio_compra:26,     comision_compra:6.12,  precio_dolar_compra:null, comision_divisa_c:null, precio_venta:29.35,   comision_venta:6.52,  precio_dolar_venta:null, comision_divisa_v:null, total_compra:3126.12, total_venta:3515.48, beneficio:389.36 },
    { accion:'United Health',     fecha_compra:'2025-08-18', fecha_venta:'2025-11-04', titulos:11,   precio_compra:268.159,comision_compra:5.55,  precio_dolar_compra:0.8567, comision_divisa_c:14.73, precio_venta:287.634,comision_venta:5.77, precio_dolar_venta:0.8703, comision_divisa_v:15.81, total_compra:2970.029,total_venta:3142.394,beneficio:172.365 },
    { accion:'Puig Brands',       fecha_compra:'2024-09-06', fecha_venta:null,         titulos:300,  precio_compra:21.55,  comision_compra:10.56, precio_dolar_compra:null, comision_divisa_c:null, precio_venta:null,    comision_venta:null,  precio_dolar_venta:null, comision_divisa_v:null, total_compra:6475.56, total_venta:0,       beneficio:-6475.56 },
    { accion:'Puig Brands',       fecha_compra:'2024-12-31', fecha_venta:null,         titulos:200,  precio_compra:17.75,  comision_compra:14.53, precio_dolar_compra:null, comision_divisa_c:null, precio_venta:null,    comision_venta:null,  precio_dolar_venta:null, comision_divisa_v:null, total_compra:3564.53, total_venta:0,       beneficio:-3564.53 },
    { accion:'Puig Brands',       fecha_compra:'2026-04-21', fecha_venta:null,         titulos:135,  precio_compra:18.6,   comision_compra:6.02,  precio_dolar_compra:null, comision_divisa_c:null, precio_venta:null,    comision_venta:null,  precio_dolar_venta:null, comision_divisa_v:null, total_compra:2517.02, total_venta:0,       beneficio:-2517.02 },
    { accion:'Bureau Veritas',    fecha_compra:'2025-06-30', fecha_venta:'2026-04-16', titulos:40,   precio_compra:29.6,   comision_compra:5.23,  precio_dolar_compra:null, comision_divisa_c:null, precio_venta:29.05,   comision_venta:1,     precio_dolar_venta:null, comision_divisa_v:null, total_compra:1189.23, total_venta:1161,    beneficio:-28.23 },
    { accion:'Bureau Veritas',    fecha_compra:'2025-06-30', fecha_venta:null,         titulos:40,   precio_compra:29.6,   comision_compra:5.24,  precio_dolar_compra:null, comision_divisa_c:null, precio_venta:null,    comision_venta:null,  precio_dolar_venta:null, comision_divisa_v:null, total_compra:1189.24, total_venta:0,       beneficio:-1189.24 },
    { accion:'Conagra',           fecha_compra:'2025-11-06', fecha_venta:'2026-01-26', titulos:100,  precio_compra:14.7487,comision_compra:4.1,   precio_dolar_compra:0.8675,comision_divisa_c:7.37, precio_venta:null,   comision_venta:null,  precio_dolar_venta:null, comision_divisa_v:null, total_compra:1486.34, total_venta:1502.11, beneficio:15.77 },
    { accion:'Opera',             fecha_compra:'2025-11-06', fecha_venta:'2026-02-27', titulos:120,  precio_compra:12.493, comision_compra:4.12,  precio_dolar_compra:0.8675,comision_divisa_c:7.49, precio_venta:13.84,  comision_venta:4.23,  precio_dolar_venta:0.8543,comision_divisa_v:8.3, total_compra:1510.77, total_venta:1648.27, beneficio:137.5 },
    { accion:'Opera (en euros)',  fecha_compra:'2026-01-30', fecha_venta:'2026-02-02', titulos:180,  precio_compra:11.3,   comision_compra:1,     precio_dolar_compra:null, comision_divisa_c:null, precio_venta:12.4,   comision_venta:1,     precio_dolar_venta:null, comision_divisa_v:null, total_compra:2035.0,  total_venta:2231,    beneficio:196.0 },
    { accion:'Cellnex Telecom',   fecha_compra:'2026-01-13', fecha_venta:null,         titulos:76,   precio_compra:26.3,   comision_compra:5,     precio_dolar_compra:null, comision_divisa_c:null, precio_venta:null,   comision_venta:null,  precio_dolar_venta:null, comision_divisa_v:null, total_compra:2003.8,  total_venta:0,       beneficio:-2003.8 },
    { accion:'Cellnex Telecom',   fecha_compra:null,         fecha_venta:null,         titulos:100,  precio_compra:30.7,   comision_compra:7.07,  precio_dolar_compra:null, comision_divisa_c:null, precio_venta:null,   comision_venta:null,  precio_dolar_venta:null, comision_divisa_v:null, total_compra:3077.07, total_venta:0,       beneficio:-3077.07 },
    { accion:'Santander',         fecha_compra:'2026-02-04', fecha_venta:'2026-02-23', titulos:200,  precio_compra:10.6,   comision_compra:5.24,  precio_dolar_compra:null, comision_divisa_c:null, precio_venta:11.08,  comision_venta:1,     precio_dolar_venta:null, comision_divisa_v:null, total_compra:2125.24, total_venta:2215,    beneficio:89.76 },
    { accion:'Brent Crude Oil (Acc)', fecha_compra:'2026-03-02', fecha_venta:'2026-03-06', titulos:25, precio_compra:42.498,comision_compra:1, precio_dolar_compra:null,comision_divisa_c:null, precio_venta:46.244,comision_venta:0.5,precio_dolar_venta:null,comision_divisa_v:null, total_compra:1063.45,total_venta:1155.6, beneficio:92.15 },
    { accion:'Brent Crude Oil (Acc)', fecha_compra:'2026-03-03', fecha_venta:'2026-03-06', titulos:45, precio_compra:45.182,comision_compra:1, precio_dolar_compra:null,comision_divisa_c:null, precio_venta:46.244,comision_venta:0.5,precio_dolar_venta:null,comision_divisa_v:null, total_compra:2034.19,total_venta:2080.48,beneficio:46.29 },
    { accion:'Merlin Properties', fecha_compra:'2025-10-10', fecha_venta:'2026-02-17', titulos:260,  precio_compra:13.5,   comision_compra:14.64, precio_dolar_compra:null, comision_divisa_c:null, precio_venta:13.7,   comision_venta:7.67,  precio_dolar_venta:null, comision_divisa_v:null, total_compra:3524.64, total_venta:3554.33, beneficio:29.69 },
    { accion:'IAG',               fecha_compra:'2026-04-21', fecha_venta:null,         titulos:550,  precio_compra:4.6,    comision_compra:6.06,  precio_dolar_compra:null, comision_divisa_c:null, precio_venta:null,   comision_venta:null,  precio_dolar_venta:null, comision_divisa_v:null, total_compra:2536.06, total_venta:null,    beneficio:-2536.06 },
  ];
  for (const r of acciones)
    await q(`INSERT INTO acciones_ops (user_id,accion,fecha_compra,fecha_venta,titulos,precio_compra,comision_compra,
      precio_dolar_compra,comision_divisa_c,precio_venta,comision_venta,precio_dolar_venta,comision_divisa_v,
      total_compra,total_venta,beneficio) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
      [uid,r.accion,r.fecha_compra,r.fecha_venta,r.titulos,r.precio_compra,r.comision_compra,
       r.precio_dolar_compra,r.comision_divisa_c,r.precio_venta,r.comision_venta,
       r.precio_dolar_venta,r.comision_divisa_v,r.total_compra,r.total_venta,r.beneficio]);

  const divs = [
    { accion:'Merlin Properties', fecha:'2025-05-26', euros_accion:0.02,  bruto:9.55,   neto:7.74 },
    { accion:'Puig Brands',       fecha:'2025-06-12', euros_accion:0.376, bruto:188.41, neto:152.61 },
    { accion:'Bureau Veritas',    fecha:'2025-07-04', euros_accion:0.9,   bruto:72,     neto:50.85 },
    { accion:'United Health',     fecha:'2025-09-23', euros_accion:1.876, bruto:20.64,  neto:14.21 },
    { accion:'Merlin Properties', fecha:'2025-12-10', euros_accion:0.2,   bruto:52,     neto:42.12 },
    { accion:'Opera',             fecha:'2026-01-15', euros_accion:0.335, bruto:40.24,  neto:32.59 },
  ];
  for (const r of divs)
    await q('INSERT INTO dividendos (user_id,accion,fecha,euros_accion,bruto,neto) VALUES ($1,$2,$3,$4,$5,$6)',
      [uid, r.accion, r.fecha, r.euros_accion, r.bruto, r.neto]);

  console.log('✅ Datos de ejemplo cargados');
}

// ── Middleware ────────────────────────────────────────────────────────────────
app.use(express.json());
app.use(session({
  store: new PgSession({ pool, tableName: 'sessions', createTableIfMissing: false }),
  secret: process.env.SESSION_SECRET || 'mysaver-secret-local',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 30 * 24 * 60 * 60 * 1000 }, // 30 días
}));

// Rutas públicas
const PUBLIC_PATHS = ['/api/auth/login', '/api/auth/logout', '/login.html'];
app.use((req, res, next) => {
  if (PUBLIC_PATHS.includes(req.path) || req.path.startsWith('/assets')) return next();
  if (!req.session.userId) {
    if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'No autenticado' });
    return res.sendFile(path.join(__dirname, 'public', 'login.html'));
  }
  next();
});

app.use(express.static(path.join(__dirname, 'public')));

// ── Auth ──────────────────────────────────────────────────────────────────────
app.post('/api/auth/login', async (req, res) => {
  const { username, password } = req.body;
  const { rows } = await q('SELECT * FROM users WHERE username=$1', [username]);
  const user = rows[0];
  if (!user || !await bcrypt.compare(password, user.password_hash))
    return res.status(401).json({ error: 'Usuario o contraseña incorrectos' });
  req.session.userId   = user.id;
  req.session.username = user.username;
  req.session.isAdmin  = user.is_admin;
  res.json({ username: user.username, isAdmin: user.is_admin, permissions: user.permissions });
});

app.post('/api/auth/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

app.get('/api/auth/me', async (req, res) => {
  const { rows: [user] } = await q('SELECT id,username,is_admin,permissions FROM users WHERE id=$1', [req.session.userId]);
  res.json({ username: user.username, isAdmin: user.is_admin, permissions: user.permissions });
});

// ── Admin: gestión de usuarios ────────────────────────────────────────────────
function requireAdmin(req, res, next) {
  if (!req.session.isAdmin) return res.status(403).json({ error: 'Solo administradores' });
  next();
}

app.get('/api/admin/users', requireAdmin, async (req, res) => {
  const { rows } = await q('SELECT id,username,is_admin,permissions FROM users ORDER BY id');
  res.json(rows);
});

app.put('/api/admin/users/:id/permissions', requireAdmin, async (req, res) => {
  const { permissions } = req.body;
  const { rows: [u] } = await q(
    'UPDATE users SET permissions=$1 WHERE id=$2 RETURNING id,username,is_admin,permissions',
    [JSON.stringify(permissions), req.params.id]);
  if (!u) return res.status(404).json({ error: 'Not found' });
  res.json(u);
});

app.put('/api/admin/users/:id/password', requireAdmin, async (req, res) => {
  const { password } = req.body;
  if (!password || password.length < 4) return res.status(400).json({ error: 'Contraseña demasiado corta' });
  const hash = await bcrypt.hash(password, 10);
  const { rows: [u] } = await q(
    'UPDATE users SET password_hash=$1 WHERE id=$2 RETURNING id,username',
    [hash, req.params.id]);
  if (!u) return res.status(404).json({ error: 'Not found' });
  res.json({ ok: true });
});

// ── API: Snapshots ────────────────────────────────────────────────────────────
app.get('/api/snapshots', async (req, res) => {
  const { rows } = await q('SELECT * FROM snapshots WHERE user_id=$1 ORDER BY fecha ASC, id ASC', [req.session.userId]);
  res.json(rows);
});
app.post('/api/snapshots', async (req, res) => {
  const { label, fecha, acciones, fondos, ahorro } = req.body;
  if (!label || !fecha) return res.status(400).json({ error: 'label and fecha required' });
  const { rows: [r] } = await q(
    'INSERT INTO snapshots (user_id,label,fecha,acciones,fondos,ahorro) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *',
    [req.session.userId, label, fecha, +acciones||0, +fondos||0, +ahorro||0]);
  res.status(201).json(r);
});
app.put('/api/snapshots/:id', async (req, res) => {
  const { label, fecha, acciones, fondos, ahorro } = req.body;
  const { rows: [r] } = await q(
    'UPDATE snapshots SET label=$1,fecha=$2,acciones=$3,fondos=$4,ahorro=$5 WHERE id=$6 AND user_id=$7 RETURNING *',
    [label, fecha, +acciones||0, +fondos||0, +ahorro||0, req.params.id, req.session.userId]);
  if (!r) return res.status(404).json({ error: 'Not found' });
  res.json(r);
});
app.delete('/api/snapshots/:id', async (req, res) => {
  const { rowCount } = await q('DELETE FROM snapshots WHERE id=$1 AND user_id=$2', [req.params.id, req.session.userId]);
  if (!rowCount) return res.status(404).json({ error: 'Not found' });
  res.json({ success: true });
});

// ── API: Config ───────────────────────────────────────────────────────────────
app.get('/api/config', async (req, res) => res.json(await getConfig(req.session.userId)));
app.post('/api/config', async (req, res) => {
  const { key, value } = req.body;
  if (!key) return res.status(400).json({ error: 'key required' });
  await setConfig(req.session.userId, key, value);
  res.json({ key, value });
});

// ── API: Acciones ─────────────────────────────────────────────────────────────
app.get('/api/acciones', async (req, res) => {
  const { rows } = await q(
    'SELECT * FROM acciones_ops WHERE user_id=$1 ORDER BY (fecha_venta IS NULL) DESC, fecha_venta DESC, id DESC',
    [req.session.userId]);
  res.json(rows);
});
app.post('/api/acciones', async (req, res) => {
  const f = req.body;
  const { rows: [r] } = await q(`
    INSERT INTO acciones_ops (user_id,accion,fecha_compra,fecha_venta,titulos,precio_compra,comision_compra,
      precio_dolar_compra,comision_divisa_c,precio_venta,comision_venta,precio_dolar_venta,comision_divisa_v,
      total_compra,total_venta,beneficio)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING *`,
    [req.session.userId,f.accion,f.fecha_compra||null,f.fecha_venta||null,+f.titulos||null,+f.precio_compra||null,
     +f.comision_compra||null,f.precio_dolar_compra?+f.precio_dolar_compra:null,f.comision_divisa_c?+f.comision_divisa_c:null,
     f.precio_venta?+f.precio_venta:null,f.comision_venta?+f.comision_venta:null,
     f.precio_dolar_venta?+f.precio_dolar_venta:null,f.comision_divisa_v?+f.comision_divisa_v:null,
     f.total_compra?+f.total_compra:null,f.total_venta?+f.total_venta:null,f.beneficio?+f.beneficio:null]);
  res.status(201).json(r);
});
app.put('/api/acciones/:id', async (req, res) => {
  const f = req.body;
  const { rows: [r] } = await q(`
    UPDATE acciones_ops SET accion=$1,fecha_compra=$2,fecha_venta=$3,titulos=$4,precio_compra=$5,comision_compra=$6,
      precio_dolar_compra=$7,comision_divisa_c=$8,precio_venta=$9,comision_venta=$10,precio_dolar_venta=$11,
      comision_divisa_v=$12,total_compra=$13,total_venta=$14,beneficio=$15
    WHERE id=$16 AND user_id=$17 RETURNING *`,
    [f.accion,f.fecha_compra||null,f.fecha_venta||null,+f.titulos||null,+f.precio_compra||null,+f.comision_compra||null,
     f.precio_dolar_compra?+f.precio_dolar_compra:null,f.comision_divisa_c?+f.comision_divisa_c:null,
     f.precio_venta?+f.precio_venta:null,f.comision_venta?+f.comision_venta:null,
     f.precio_dolar_venta?+f.precio_dolar_venta:null,f.comision_divisa_v?+f.comision_divisa_v:null,
     f.total_compra?+f.total_compra:null,f.total_venta?+f.total_venta:null,f.beneficio?+f.beneficio:null,
     req.params.id,req.session.userId]);
  if (!r) return res.status(404).json({ error: 'Not found' });
  res.json(r);
});
app.delete('/api/acciones/:id', async (req, res) => {
  const { rowCount } = await q('DELETE FROM acciones_ops WHERE id=$1 AND user_id=$2', [req.params.id, req.session.userId]);
  if (!rowCount) return res.status(404).json({ error: 'Not found' });
  res.json({ success: true });
});

// Vende total o parcialmente una posición abierta. Si se vende menos de lo
// que hay, la fila original se reduce (sigue abierta) y se crea una fila
// nueva para el lote vendido, con las comisiones de compra prorrateadas.
app.post('/api/acciones/:id/vender', async (req, res) => {
  const { titulos, fecha_venta, precio_venta, comision_venta, precio_dolar_venta, comision_divisa_v } = req.body;
  const tVender = +titulos;
  const pVenta  = +precio_venta;
  if (!tVender || tVender <= 0) return res.status(400).json({ error: 'Indica cuántos títulos quieres vender' });
  if (!pVenta) return res.status(400).json({ error: 'Indica el precio de venta' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: [row] } = await client.query(
      'SELECT * FROM acciones_ops WHERE id=$1 AND user_id=$2 FOR UPDATE', [req.params.id, req.session.userId]);
    if (!row) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Not found' }); }
    if (row.fecha_venta) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'Esta posición ya está vendida' }); }
    if (!row.titulos || !row.precio_compra) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'La compra original no tiene títulos/precio registrados' }); }
    if (tVender > row.titulos + 1e-6) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: `No puedes vender más de los ${row.titulos} títulos disponibles` });
    }

    const cv  = comision_venta ? +comision_venta : 0;
    const cdv = comision_divisa_v ? +comision_divisa_v : 0;
    const ratio   = tVender / row.titulos;
    const ccSold  = (row.comision_compra  || 0) * ratio;
    const cdcSold = (row.comision_divisa_c || 0) * ratio;
    const totalCompraSold = tVender * row.precio_compra + ccSold + cdcSold;
    const totalVentaSold  = tVender * pVenta - cv - cdv;
    const beneficioSold   = totalVentaSold - totalCompraSold;
    const esVentaTotal    = tVender > row.titulos - 1e-6;

    let venta;
    if (esVentaTotal) {
      const { rows: [r] } = await client.query(`
        UPDATE acciones_ops SET fecha_venta=$1,precio_venta=$2,comision_venta=$3,precio_dolar_venta=$4,
          comision_divisa_v=$5,total_venta=$6,beneficio=$7
        WHERE id=$8 RETURNING *`,
        [fecha_venta || null, pVenta, cv || null, precio_dolar_venta ? +precio_dolar_venta : null, cdv || null,
         totalVentaSold, beneficioSold, row.id]);
      venta = r;
    } else {
      const titulosRestantes = row.titulos - tVender;
      const ccRestante  = (row.comision_compra  || 0) - ccSold;
      const cdcRestante = (row.comision_divisa_c || 0) - cdcSold;
      const totalCompraRestante = titulosRestantes * row.precio_compra + ccRestante + cdcRestante;

      await client.query(
        'UPDATE acciones_ops SET titulos=$1,comision_compra=$2,comision_divisa_c=$3,total_compra=$4 WHERE id=$5',
        [titulosRestantes, ccRestante || null, cdcRestante || null, totalCompraRestante, row.id]);

      const { rows: [r] } = await client.query(`
        INSERT INTO acciones_ops (user_id,accion,fecha_compra,fecha_venta,titulos,precio_compra,comision_compra,
          precio_dolar_compra,comision_divisa_c,precio_venta,comision_venta,precio_dolar_venta,comision_divisa_v,
          total_compra,total_venta,beneficio)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING *`,
        [req.session.userId, row.accion, row.fecha_compra, fecha_venta || null, tVender, row.precio_compra,
         ccSold || null, row.precio_dolar_compra, cdcSold || null, pVenta, cv || null,
         precio_dolar_venta ? +precio_dolar_venta : null, cdv || null, totalCompraSold, totalVentaSold, beneficioSold]);
      venta = r;
    }

    await client.query('COMMIT');
    res.status(201).json({ success: true, venta });
  } catch (e) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: e.message });
  } finally {
    client.release();
  }
});

// ── API: Dividendos ───────────────────────────────────────────────────────────
app.get('/api/dividendos', async (req, res) => {
  const { rows } = await q('SELECT * FROM dividendos WHERE user_id=$1 ORDER BY fecha ASC', [req.session.userId]);
  res.json(rows);
});
app.post('/api/dividendos', async (req, res) => {
  const { accion, fecha, euros_accion, bruto, neto } = req.body;
  const { rows: [r] } = await q(
    'INSERT INTO dividendos (user_id,accion,fecha,euros_accion,bruto,neto) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *',
    [req.session.userId, accion, fecha||null, +euros_accion||null, +bruto||null, +neto||null]);
  res.status(201).json(r);
});
app.put('/api/dividendos/:id', async (req, res) => {
  const { accion, fecha, euros_accion, bruto, neto } = req.body;
  const { rows: [r] } = await q(
    'UPDATE dividendos SET accion=$1,fecha=$2,euros_accion=$3,bruto=$4,neto=$5 WHERE id=$6 AND user_id=$7 RETURNING *',
    [accion, fecha||null, +euros_accion||null, +bruto||null, +neto||null, req.params.id, req.session.userId]);
  if (!r) return res.status(404).json({ error: 'Not found' });
  res.json(r);
});
app.delete('/api/dividendos/:id', async (req, res) => {
  const { rowCount } = await q('DELETE FROM dividendos WHERE id=$1 AND user_id=$2', [req.params.id, req.session.userId]);
  if (!rowCount) return res.status(404).json({ error: 'Not found' });
  res.json({ success: true });
});

// ── API: ETF Compras ──────────────────────────────────────────────────────────
app.get('/api/etf-compras', async (req, res) => {
  const { rows } = await q('SELECT * FROM etf_compras WHERE user_id=$1 ORDER BY fecha_compra DESC, id DESC', [req.session.userId]);
  res.json(rows);
});
app.post('/api/etf-compras', async (req, res) => {
  const { etf, isin, fecha_compra, importe, precio, titulos, comision } = req.body;
  const { rows: [r] } = await q(
    'INSERT INTO etf_compras (user_id,etf,isin,fecha_compra,importe,precio,titulos,comision) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *',
    [req.session.userId, etf, isin||null, fecha_compra||null, +importe||null, +precio||null, +titulos||null, comision?+comision:null]);
  res.status(201).json(r);
});
app.put('/api/etf-compras/:id', async (req, res) => {
  const { etf, isin, fecha_compra, importe, precio, titulos, comision } = req.body;
  const { rows: [r] } = await q(
    'UPDATE etf_compras SET etf=$1,isin=$2,fecha_compra=$3,importe=$4,precio=$5,titulos=$6,comision=$7 WHERE id=$8 AND user_id=$9 RETURNING *',
    [etf, isin||null, fecha_compra||null, +importe||null, +precio||null, +titulos||null, comision?+comision:null, req.params.id, req.session.userId]);
  if (!r) return res.status(404).json({ error: 'Not found' });
  res.json(r);
});
app.delete('/api/etf-compras/:id', async (req, res) => {
  const { rowCount } = await q('DELETE FROM etf_compras WHERE id=$1 AND user_id=$2', [req.params.id, req.session.userId]);
  if (!rowCount) return res.status(404).json({ error: 'Not found' });
  res.json({ success: true });
});

// ── API: ETF Ventas ───────────────────────────────────────────────────────────
app.get('/api/etf-ventas', async (req, res) => {
  const { rows } = await q('SELECT * FROM etf_ventas WHERE user_id=$1 ORDER BY id ASC', [req.session.userId]);
  res.json(rows);
});
app.post('/api/etf-ventas', async (req, res) => {
  const f = req.body;
  const { rows: [r] } = await q(`
    INSERT INTO etf_ventas (user_id,etf,fecha_venta,coste_total,comision_compra,cantidad,precio_venta,
      venta_bruto,venta_neto,comision_venta,irpf,ganancia_sin_irpf,ganancia_con_irpf)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
    [req.session.userId,f.etf,f.fecha_venta||null,f.coste_total?+f.coste_total:null,f.comision_compra?+f.comision_compra:null,
     f.cantidad?+f.cantidad:null,f.precio_venta?+f.precio_venta:null,f.venta_bruto?+f.venta_bruto:null,
     f.venta_neto?+f.venta_neto:null,f.comision_venta?+f.comision_venta:null,f.irpf?+f.irpf:null,
     f.ganancia_sin_irpf?+f.ganancia_sin_irpf:null,f.ganancia_con_irpf?+f.ganancia_con_irpf:null]);
  res.status(201).json(r);
});
app.put('/api/etf-ventas/:id', async (req, res) => {
  const f = req.body;
  const { rows: [r] } = await q(`
    UPDATE etf_ventas SET etf=$1,fecha_venta=$2,coste_total=$3,comision_compra=$4,cantidad=$5,precio_venta=$6,
      venta_bruto=$7,venta_neto=$8,comision_venta=$9,irpf=$10,ganancia_sin_irpf=$11,ganancia_con_irpf=$12
    WHERE id=$13 AND user_id=$14 RETURNING *`,
    [f.etf,f.fecha_venta||null,f.coste_total?+f.coste_total:null,f.comision_compra?+f.comision_compra:null,
     f.cantidad?+f.cantidad:null,f.precio_venta?+f.precio_venta:null,f.venta_bruto?+f.venta_bruto:null,
     f.venta_neto?+f.venta_neto:null,f.comision_venta?+f.comision_venta:null,f.irpf?+f.irpf:null,
     f.ganancia_sin_irpf?+f.ganancia_sin_irpf:null,f.ganancia_con_irpf?+f.ganancia_con_irpf:null,
     req.params.id,req.session.userId]);
  if (!r) return res.status(404).json({ error: 'Not found' });
  res.json(r);
});
app.delete('/api/etf-ventas/:id', async (req, res) => {
  const { rowCount } = await q('DELETE FROM etf_ventas WHERE id=$1 AND user_id=$2', [req.params.id, req.session.userId]);
  if (!rowCount) return res.status(404).json({ error: 'Not found' });
  res.json({ success: true });
});

// ── API: Fondos catálogo ──────────────────────────────────────────────────────
app.get('/api/fondos-catalogo', async (req, res) => {
  const { rows } = await q('SELECT * FROM fondos_catalogo WHERE user_id=$1 ORDER BY nombre ASC', [req.session.userId]);
  res.json(rows);
});
app.post('/api/fondos-catalogo', async (req, res) => {
  const { nombre, isin } = req.body;
  if (!nombre) return res.status(400).json({ error: 'nombre required' });
  const { rows: [r] } = await q(
    'INSERT INTO fondos_catalogo (user_id,nombre,isin) VALUES ($1,$2,$3) RETURNING *',
    [req.session.userId, nombre, isin||null]);
  res.status(201).json(r);
});
app.put('/api/fondos-catalogo/:id', async (req, res) => {
  const { nombre, isin } = req.body;
  const { rows: [r] } = await q(
    'UPDATE fondos_catalogo SET nombre=$1,isin=$2 WHERE id=$3 AND user_id=$4 RETURNING *',
    [nombre, isin||null, req.params.id, req.session.userId]);
  if (!r) return res.status(404).json({ error: 'Not found' });
  res.json(r);
});
app.delete('/api/fondos-catalogo/:id', async (req, res) => {
  const { rowCount } = await q('DELETE FROM fondos_catalogo WHERE id=$1 AND user_id=$2', [req.params.id, req.session.userId]);
  if (!rowCount) return res.status(404).json({ error: 'Not found' });
  res.json({ success: true });
});

// ── API: Fondos traspasos ──────────────────────────────────────────────────────
async function fondosPosiciones(userId) {
  const [compras, ventas, traspasos] = await Promise.all([
    q('SELECT etf, COALESCE(SUM(importe),0) as total FROM etf_compras WHERE user_id=$1 GROUP BY etf', [userId]),
    q('SELECT etf, COALESCE(SUM(coste_total),0) as total FROM etf_ventas WHERE user_id=$1 GROUP BY etf', [userId]),
    q('SELECT fondo_origen, fondo_destino, importe FROM fondos_traspasos WHERE user_id=$1', [userId]),
  ]);
  const pos = {};
  for (const r of compras.rows) pos[r.etf] = (pos[r.etf] || 0) + Number(r.total);
  for (const r of ventas.rows)  pos[r.etf] = (pos[r.etf] || 0) - Number(r.total);
  for (const r of traspasos.rows) {
    pos[r.fondo_origen]  = (pos[r.fondo_origen]  || 0) - Number(r.importe);
    pos[r.fondo_destino] = (pos[r.fondo_destino] || 0) + Number(r.importe);
  }
  for (const k of Object.keys(pos)) pos[k] = Math.max(0, pos[k]);
  return pos;
}

app.get('/api/fondos-posiciones', async (req, res) => {
  res.json(await fondosPosiciones(req.session.userId));
});
app.get('/api/fondos-traspasos', async (req, res) => {
  const { rows } = await q('SELECT * FROM fondos_traspasos WHERE user_id=$1 ORDER BY fecha DESC, id DESC', [req.session.userId]);
  res.json(rows);
});
app.post('/api/fondos-traspasos', async (req, res) => {
  const { fondo_origen, fondo_destino, fecha, importe } = req.body;
  const imp = +importe;
  if (!fondo_origen || !fondo_destino) return res.status(400).json({ error: 'Selecciona fondo origen y destino' });
  if (fondo_origen === fondo_destino) return res.status(400).json({ error: 'El fondo origen y destino deben ser distintos' });
  if (!imp || imp <= 0) return res.status(400).json({ error: 'Importe inválido' });
  const { rows: [r] } = await q(
    'INSERT INTO fondos_traspasos (user_id,fondo_origen,fondo_destino,fecha,importe) VALUES ($1,$2,$3,$4,$5) RETURNING *',
    [req.session.userId, fondo_origen, fondo_destino, fecha || null, imp]);
  res.status(201).json(r);
});
app.delete('/api/fondos-traspasos/:id', async (req, res) => {
  const { rowCount } = await q('DELETE FROM fondos_traspasos WHERE id=$1 AND user_id=$2', [req.params.id, req.session.userId]);
  if (!rowCount) return res.status(404).json({ error: 'Not found' });
  res.json({ success: true });
});

// ── API: Gastos ───────────────────────────────────────────────────────────────
app.get('/api/gastos', async (req, res) => {
  const { rows } = await q('SELECT * FROM gastos WHERE user_id=$1 ORDER BY categoria ASC, nombre ASC', [req.session.userId]);
  res.json(rows);
});
app.post('/api/gastos', async (req, res) => {
  const { nombre, importe, categoria } = req.body;
  if (!nombre) return res.status(400).json({ error: 'nombre required' });
  const { rows: [r] } = await q(
    'INSERT INTO gastos (user_id,nombre,importe,categoria) VALUES ($1,$2,$3,$4) RETURNING *',
    [req.session.userId, nombre, +importe||0, categoria||'Otros']);
  res.status(201).json(r);
});
app.put('/api/gastos/:id', async (req, res) => {
  const { nombre, importe, categoria } = req.body;
  const { rows: [r] } = await q(
    'UPDATE gastos SET nombre=$1,importe=$2,categoria=$3 WHERE id=$4 AND user_id=$5 RETURNING *',
    [nombre, +importe||0, categoria||'Otros', req.params.id, req.session.userId]);
  if (!r) return res.status(404).json({ error: 'Not found' });
  res.json(r);
});
app.delete('/api/gastos/:id', async (req, res) => {
  const { rowCount } = await q('DELETE FROM gastos WHERE id=$1 AND user_id=$2', [req.params.id, req.session.userId]);
  if (!rowCount) return res.status(404).json({ error: 'Not found' });
  res.json({ success: true });
});

// ── API: Backup ───────────────────────────────────────────────────────────────
async function exportData(userId) {
  const tables = ['snapshots','acciones_ops','dividendos','etf_compras','fondos_catalogo','etf_ventas','fondos_traspasos','gastos'];
  const data = { version: 3, exported_at: new Date().toISOString(), tables: {} };
  for (const t of tables) {
    const { rows } = await q(`SELECT * FROM ${t} WHERE user_id=$1`, [userId]);
    data.tables[t] = rows;
  }
  return data;
}

app.get('/api/backup/download', async (req, res) => {
  const data = await exportData(req.session.userId);
  const now      = new Date();
  const datePart = now.toISOString().slice(0,10);
  const timePart = now.toTimeString().slice(0,8).replace(/:/g,'-');
  res.setHeader('Content-Disposition', `attachment; filename="patrimonio-backup-${datePart}_${timePart}.json"`);
  res.json(data);
});

app.post('/api/backup/restore', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file' });
  try {
    const content = fs.readFileSync(req.file.path, 'utf8');
    fs.unlinkSync(req.file.path);
    const data = JSON.parse(content);
    if (!data.tables) return res.status(400).json({ error: 'Formato de backup inválido' });
    const uid = req.session.userId;
    const tables = ['etf_ventas','etf_compras','dividendos','acciones_ops','fondos_catalogo','fondos_traspasos','snapshots','gastos'];
    for (const t of tables) await q(`DELETE FROM ${t} WHERE user_id=$1`, [uid]);
    for (const [table, rows] of Object.entries(data.tables)) {
      for (const row of rows) {
        const keys = Object.keys(row).filter(k => k !== 'id' && k !== 'user_id');
        const vals = [uid, ...keys.map(k => row[k])];
        const cols = ['user_id', ...keys].join(',');
        const phs  = vals.map((_,i) => `$${i+1}`).join(',');
        await q(`INSERT INTO ${table} (${cols}) VALUES (${phs})`, vals);
      }
    }
    res.json({ success: true, message: 'Restauración completada.' });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ── API: Google Drive ─────────────────────────────────────────────────────────
app.get('/api/drive/status', async (req, res) => {
  const cfg = await getConfig(req.session.userId);
  res.json({ configured: !!(cfg.drive_client_id && cfg.drive_client_secret), authorized: !!cfg.drive_tokens, last_backup: cfg.drive_last_backup || null });
});
app.get('/api/drive/auth-url', async (req, res) => {
  const cfg = await getConfig(req.session.userId);
  if (!cfg.drive_client_id || !cfg.drive_client_secret)
    return res.status(400).json({ error: 'Configura Client ID y Client Secret primero' });
  res.json({ url: getOAuth2Client(cfg).generateAuthUrl({ access_type:'offline', scope:['https://www.googleapis.com/auth/drive.file'], prompt:'consent' }) });
});
app.get('/api/drive/callback', async (req, res) => {
  const { code, state } = req.query;
  const cfg = await getConfig(req.session.userId);
  try {
    const oauth2 = getOAuth2Client(cfg);
    const { tokens } = await oauth2.getToken(code);
    await setConfig(req.session.userId, 'drive_tokens', JSON.stringify(tokens));
    res.send(`<html><body style="font-family:sans-serif;background:#09090f;color:#e8e8f0;display:flex;align-items:center;justify-content:center;height:100vh;margin:0"><div style="text-align:center"><div style="font-size:48px">✅</div><h2>Google Drive conectado</h2><p style="color:#6b6b8a">Puedes cerrar esta pestaña</p></div></body></html>`);
  } catch(e) { res.status(500).send(`Error: ${e.message}`); }
});
app.post('/api/drive/upload', async (req, res) => {
  const uid = req.session.userId;
  const cfg = await getConfig(uid);
  if (!cfg.drive_tokens) return res.status(401).json({ error: 'No autorizado. Conecta Google Drive primero.' });
  try {
    const oauth2 = getOAuth2Client(cfg);
    oauth2.setCredentials(JSON.parse(cfg.drive_tokens));
    oauth2.on('tokens', async t => await setConfig(uid, 'drive_tokens', JSON.stringify(t)));
    const drive = google.drive({ version:'v3', auth:oauth2 });
    const now   = new Date();
    const fname = `patrimonio-backup-${now.toISOString().slice(0,10)}_${now.toTimeString().slice(0,8).replace(/:/g,'-')}.json`;
    let folderId = cfg.drive_folder_id || null;
    if (!folderId) {
      const s = await drive.files.list({ q:"name='mysaver-backup' and mimeType='application/vnd.google-apps.folder' and trashed=false", fields:'files(id)' });
      folderId = s.data.files.length > 0 ? s.data.files[0].id
        : (await drive.files.create({ requestBody:{ name:'mysaver-backup', mimeType:'application/vnd.google-apps.folder' }, fields:'id' })).data.id;
      await setConfig(uid, 'drive_folder_id', folderId);
    }
    const data    = await exportData(uid);
    const tmpPath = path.join(__dirname, 'tmp', fname);
    fs.writeFileSync(tmpPath, JSON.stringify(data));
    const r = await drive.files.create({
      requestBody:{ name:fname, mimeType:'application/json', parents:[folderId] },
      media:{ mimeType:'application/json', body:fs.createReadStream(tmpPath) }, fields:'id' });
    fs.unlinkSync(tmpPath);
    const nowIso = now.toISOString();
    await setConfig(uid, 'drive_last_backup', nowIso);
    res.json({ success:true, fileId:r.data.id, timestamp:nowIso });
  } catch(e) { res.status(500).json({ error:e.message }); }
});
app.get('/api/drive/files', async (req, res) => {
  const cfg = await getConfig(req.session.userId);
  if (!cfg.drive_tokens) return res.status(401).json({ error:'No autorizado' });
  try {
    const oauth2 = getOAuth2Client(cfg);
    oauth2.setCredentials(JSON.parse(cfg.drive_tokens));
    const drive = google.drive({ version:'v3', auth:oauth2 });
    if (!cfg.drive_folder_id) return res.json([]);
    const list = await drive.files.list({ q:`'${cfg.drive_folder_id}' in parents and trashed=false`, fields:'files(id,name,createdTime,size)', orderBy:'createdTime desc' });
    res.json(list.data.files);
  } catch(e) { res.status(500).json({ error:e.message }); }
});
app.get('/api/drive/download/:fileId', async (req, res) => {
  const cfg = await getConfig(req.session.userId);
  if (!cfg.drive_tokens) return res.status(401).json({ error:'No autorizado' });
  try {
    const oauth2 = getOAuth2Client(cfg);
    oauth2.setCredentials(JSON.parse(cfg.drive_tokens));
    const drive  = google.drive({ version:'v3', auth:oauth2 });
    const meta   = await drive.files.get({ fileId:req.params.fileId, fields:'name' });
    const stream = await drive.files.get({ fileId:req.params.fileId, alt:'media' }, { responseType:'stream' });
    res.setHeader('Content-Disposition', `attachment; filename="${meta.data.name}"`);
    res.setHeader('Content-Type', 'application/json');
    stream.data.pipe(res);
  } catch(e) { res.status(500).json({ error:e.message }); }
});
app.post('/api/drive/disconnect', async (req, res) => {
  await delConfig(req.session.userId, ['drive_tokens','drive_file_id','drive_folder_id','drive_last_backup']);
  res.json({ success:true });
});

// ── API: Renta ────────────────────────────────────────────────────────────────
app.get('/api/renta/:anio', async (req, res) => {
  const año = parseInt(req.params.anio);
  if (!año || año < 2000 || año > 2100) return res.status(400).json({ error:'Año inválido' });
  const uid = req.session.userId;
  const [va, dv, ve] = await Promise.all([
    q(`SELECT * FROM acciones_ops WHERE user_id=$1 AND fecha_venta LIKE $2 AND total_venta > 0 ORDER BY fecha_venta`, [uid, `${año}-%`]),
    q(`SELECT *, (bruto-neto) as retencion FROM dividendos WHERE user_id=$1 AND fecha LIKE $2 ORDER BY fecha`, [uid, `${año}-%`]),
    q(`SELECT * FROM etf_ventas WHERE user_id=$1 AND fecha_venta LIKE $2 ORDER BY fecha_venta`, [uid, `${año}-%`]),
  ]);
  const dataPath = path.join(__dirname, 'tmp', `renta-data-${uid}-${año}.json`);
  const outPath  = path.join(__dirname, 'tmp', `renta-${uid}-${año}.pdf`);
  fs.writeFileSync(dataPath, JSON.stringify({ año, ventas_acc:va.rows, dividendos:dv.rows, ventas_etf:ve.rows }));
  execFile('python', [path.join(__dirname,'generar_renta.py'), dataPath, outPath], (err,_,stderr) => {
    try { fs.unlinkSync(dataPath); } catch {}
    if (err) return res.status(500).json({ error:stderr||err.message });
    res.download(outPath, `informe-renta-${año}.pdf`, () => { try { fs.unlinkSync(outPath); } catch {} });
  });
});

// ── Start ─────────────────────────────────────────────────────────────────────
initDB().then(() => {
  app.listen(PORT, () => console.log(`🚀 Mi Patrimonio en http://localhost:${PORT}`));
}).catch(err => { console.error('Error DB:', err.message); process.exit(1); });
