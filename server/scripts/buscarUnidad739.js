// Diagnóstico de un solo uso: busca en tu catálogo de Maquinaria cualquier
// unidad cuyo nombre contenga "739", para encontrar cómo está escrita
// exactamente la camioneta AF-739 RAM 700 en tu base real (el script de
// importación la buscó por nombre EXACTO y no la encontró, así que el
// nombre debe estar capturado distinto a como venía en el Excel).
//
// Cómo correrlo (misma carpeta de siempre):
//   node server/scripts/buscarUnidad739.js

require('dotenv').config();
const pool = require('../db');

async function main() {
  const [rows] = await pool.query(
    "SELECT codigo_unidad, unidad FROM maquinaria WHERE unidad LIKE '%739%'"
  );
  if (rows.length === 0) {
    console.log('No se encontró ninguna unidad con "739" en el nombre.');
  } else {
    console.log('Unidades encontradas:');
    rows.forEach((r) => console.log('  codigo_unidad=' + r.codigo_unidad + '  unidad="' + r.unidad + '"'));
  }
  await pool.end();
}

main().catch((err) => {
  console.error('Error:', err.message);
  process.exit(1);
});
