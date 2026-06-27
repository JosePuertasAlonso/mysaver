require('dotenv').config();
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
pool.query(`DROP TABLE IF EXISTS sessions, etf_ventas, etf_compras, dividendos, acciones_ops, fondos_catalogo, snapshots, config, users CASCADE`)
  .then(() => { console.log('✅ Tablas eliminadas'); pool.end(); })
  .catch(e => { console.error(e.message); pool.end(); });
