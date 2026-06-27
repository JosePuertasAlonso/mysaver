require('dotenv').config();
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

async function run() {
  const { rows: [admin] } = await pool.query('SELECT id FROM users WHERE is_admin=true LIMIT 1');
  const uid = admin.id;

  // Dejar solo el id más bajo de cada duplicado en etf_compras
  await pool.query(`
    DELETE FROM etf_compras WHERE id NOT IN (
      SELECT MIN(id) FROM etf_compras WHERE user_id=$1
      GROUP BY etf, isin, fecha_compra, importe, precio, titulos, comision
    ) AND user_id=$1
  `, [uid]);
  console.log('✅ Duplicados de etf_compras eliminados');

  // Idem fondos_catalogo
  await pool.query(`
    DELETE FROM fondos_catalogo WHERE id NOT IN (
      SELECT MIN(id) FROM fondos_catalogo WHERE user_id=$1
      GROUP BY nombre, isin
    ) AND user_id=$1
  `, [uid]);
  console.log('✅ Duplicados de fondos_catalogo eliminados');

  await pool.end();
}
run().catch(e => { console.error(e.message); process.exit(1); });
