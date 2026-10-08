// Migra la hoja "Diesel" de Google Sheets a MySQL.
//
// Cómo obtener el CSV:
//   1) Abre el Google Sheet original -> pestaña "Diesel"
//   2) Archivo > Descargar > Valores separados por comas (.csv)
//   3) Guarda ese archivo como  diesel.csv  en esta misma carpeta
//      (o pasa la ruta como argumento: node importDiesel.js C:\ruta\diesel.csv)
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { parse } = require('csv-parse/sync');
const pool = require('../db');

function fechaOnull(valor) {
  if (!valor) return null;
  const d = new Date(valor);
  return isNaN(d.getTime()) ? null : d;
}

async function main() {
  const csvPath = process.argv[2] || path.join(__dirname, 'diesel.csv');
  if (!fs.existsSync(csvPath)) {
    console.error('No se encontró el archivo: ' + csvPath);
    console.error('Exporta la hoja "Diesel" como CSV y colócala ahí, o pasa la ruta como argumento.');
    process.exit(1);
  }

  const records = parse(fs.readFileSync(csvPath, 'utf8'), { columns: true, skip_empty_lines: true, trim: true });

  let insertados = 0;
  let omitidos = 0;

  for (const row of records) {
    const folio = (row.Folio || '').trim();
    if (!folio) { omitidos++; continue; }

    const [existe] = await pool.query('SELECT id FROM diesel WHERE folio = ?', [folio]);
    if (existe.length > 0) { omitidos++; continue; }

    await pool.query(
      `INSERT INTO diesel
        (folio, codigo_unidad, unidad, huerta, litros, lectura, nombre, fecha, codigo_implemento, implemento)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        folio,
        row.CodigoUnidad || '',
        row.Unidad || '',
        row.Huerta || '',
        parseFloat(row.Litros) || 0,
        row.Lectura ? parseFloat(row.Lectura) : null,
        row.Nombre || '',
        fechaOnull(row.Fecha) || new Date(),
        row.CodigoImplemento || null,
        row.Implemento || null,
      ]
    );
    insertados++;
  }

  console.log(`Cargas de diesel importadas. Nuevas: ${insertados}, omitidas (ya existían o sin folio): ${omitidos}.`);
  await pool.end();
}

main().catch((err) => {
  console.error('Error al importar diesel:', err);
  process.exit(1);
});
