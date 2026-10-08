// Migra la hoja "Usuarios" de Google Sheets a MySQL.
//
// Cómo obtener el CSV:
//   1) Abre el Google Sheet original -> pestaña "Usuarios"
//   2) Archivo > Descargar > Valores separados por comas (.csv)
//   3) Guarda ese archivo como  usuarios.csv  en esta misma carpeta (server/scripts)
//      (o pasa la ruta como argumento: node importUsuarios.js C:\ruta\usuarios.csv)
//
// El CSV debe tener los encabezados: Nombre, Huerta, Password, Modulos
// (son los mismos nombres de columna que ya usaba la hoja).
//
// Las contraseñas se guardan con hash (bcrypt), nunca en texto plano.
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');
const { parse } = require('csv-parse/sync');
const pool = require('../db');

async function main() {
  const csvPath = process.argv[2] || path.join(__dirname, 'usuarios.csv');
  if (!fs.existsSync(csvPath)) {
    console.error('No se encontró el archivo: ' + csvPath);
    console.error('Exporta la hoja "Usuarios" como CSV y colócala ahí, o pasa la ruta como argumento.');
    process.exit(1);
  }

  const records = parse(fs.readFileSync(csvPath, 'utf8'), { columns: true, skip_empty_lines: true, trim: true });

  let insertados = 0;
  let actualizados = 0;
  let omitidos = 0;

  for (const row of records) {
    const nombre = (row.Nombre || '').trim();
    if (!nombre) { omitidos++; continue; }
    const huerta = (row.Huerta || '').trim();
    const passwordPlano = (row.Password || '').trim();
    const modulos = (row.Modulos || '').trim();

    const [existe] = await pool.query('SELECT id FROM usuarios WHERE LOWER(TRIM(nombre)) = LOWER(TRIM(?))', [nombre]);

    let hash = null;
    if (passwordPlano) hash = await bcrypt.hash(passwordPlano, 10);

    if (existe.length === 0) {
      await pool.query('INSERT INTO usuarios (nombre, huerta, password_hash, modulos) VALUES (?, ?, ?, ?)', [nombre, huerta, hash, modulos]);
      insertados++;
    } else {
      if (hash) {
        await pool.query('UPDATE usuarios SET huerta = ?, password_hash = ?, modulos = ? WHERE id = ?', [huerta, hash, modulos, existe[0].id]);
      } else {
        await pool.query('UPDATE usuarios SET huerta = ?, modulos = ? WHERE id = ?', [huerta, modulos, existe[0].id]);
      }
      actualizados++;
    }
  }

  console.log(`Usuarios importados. Nuevos: ${insertados}, actualizados: ${actualizados}, omitidos (sin nombre): ${omitidos}.`);
  await pool.end();
}

main().catch((err) => {
  console.error('Error al importar usuarios:', err);
  process.exit(1);
});
