require('dotenv').config();
const Database = require('better-sqlite3');
const { Pool } = require('pg');
const path = require('path');

const DB_PATH = process.argv[2];
if (!DB_PATH) { console.error('Uso: node migrate_etfs.js <ruta_backup.db>'); process.exit(1); }

const sqlite = new Database(DB_PATH, { readonly: true });
const pool   = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

async function run() {
  // Obtener user admin
  const { rows: [admin] } = await pool.query('SELECT id FROM users WHERE is_admin=true LIMIT 1');
  const uid = admin.id;
  console.log(`Migrando datos al usuario admin (id=${uid})...`);

  // ETF Compras
  const compras = sqlite.prepare('SELECT * FROM etf_compras').all();
  let c = 0;
  for (const r of compras) {
    await pool.query(
      `INSERT INTO etf_compras (user_id,etf,isin,fecha_compra,importe,precio,titulos,comision)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [uid, r.etf, r.isin||null, r.fecha_compra||null, r.importe||null, r.precio||null, r.titulos||null, r.comision||null]
    );
    c++;
  }
  console.log(`✅ ${c} compras de ETF migradas`);

  // ETF Ventas
  const ventas = sqlite.prepare('SELECT * FROM etf_ventas').all();
  let v = 0;
  for (const r of ventas) {
    await pool.query(
      `INSERT INTO etf_ventas (user_id,etf,fecha_venta,coste_total,comision_compra,cantidad,precio_venta,venta_bruto,venta_neto,comision_venta,irpf,ganancia_sin_irpf,ganancia_con_irpf)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [uid, r.etf, r.fecha_venta||null, r.coste_total||null, r.comision_compra||null, r.cantidad||null,
       r.precio_venta||null, r.venta_bruto||null, r.venta_neto||null, r.comision_venta||null,
       r.irpf||null, r.ganancia_sin_irpf||null, r.ganancia_con_irpf||null]
    );
    v++;
  }
  console.log(`✅ ${v} ventas de ETF migradas`);

  // Fondos catálogo
  const fondos = sqlite.prepare('SELECT * FROM fondos_catalogo').all();
  let f = 0;
  for (const r of fondos) {
    await pool.query(
      'INSERT INTO fondos_catalogo (user_id,nombre,isin) VALUES ($1,$2,$3)',
      [uid, r.nombre, r.isin||null]
    );
    f++;
  }
  console.log(`✅ ${f} fondos del catálogo migrados`);

  sqlite.close();
  await pool.end();
}

run().catch(e => { console.error('Error:', e.message); process.exit(1); });
