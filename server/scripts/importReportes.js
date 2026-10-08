// Migra la hoja "Reportes" de Google Sheets a MySQL.
//
// Cómo obtener el CSV:
//   1) Abre el Google Sheet original -> pestaña "Reportes"
//   2) Archivo > Descargar > Valores separados por comas (.csv)
//   3) Guarda ese archivo como  reportes.csv  en esta misma carpeta
//      (o pasa la ruta como argumento: node importReportes.js C:\ruta\reportes.csv)
//
// Nota sobre fotos: las URLs de fotos/videos que ya estaban en Drive
// (FotoURL, EvidenciaURL) se copian tal cual como enlaces externos; no se
// vuelven a descargar ni a alojar localmente en esta primera importación.
// Los reportes nuevos que se capturen desde el sistema local sí guardan su
// foto en /uploads.
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
  const csvPath = process.argv[2] || path.join(__dirname, 'reportes.csv');
  if (!fs.existsSync(csvPath)) {
    console.error('No se encontró el archivo: ' + csvPath);
    console.error('Exporta la hoja "Reportes" como CSV y colócala ahí, o pasa la ruta como argumento.');
    process.exit(1);
  }

  const records = parse(fs.readFileSync(csvPath, 'utf8'), { columns: true, skip_empty_lines: true, trim: true });

  let insertados = 0;
  let omitidos = 0;

  for (const row of records) {
    const orden = (row.Orden || '').trim();
    if (!orden) { omitidos++; continue; }

    const [existe] = await pool.query('SELECT id FROM reportes WHERE orden = ?', [orden]);
    if (existe.length > 0) { omitidos++; continue; } // ya importado, no duplicar

    await pool.query(
      `INSERT INTO reportes
        (orden, codigo_unidad, unidad, huerta, descripcion, nombre, fecha, foto_url,
         descripcion_audio_url, trabajo_realizado, trabajo_realizado_audio_url,
         fecha_atencion, fecha_salida, refaccionamiento, atendio_por, evidencia_url,
         visto_bueno, comentario_reportante)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        orden,
        row.CodigoUnidad || '',
        row.Unidad || '',
        row.Huerta || '',
        row.Descripcion || '',
        row.Nombre || '',
        fechaOnull(row.Fecha) || new Date(),
        row.FotoURL || null,
        row.DescripcionAudioURL || null,
        row.TrabajoRealizado || null,
        row.TrabajoRealizadoAudioURL || null,
        fechaOnull(row.FechaAtencion),
        fechaOnull(row.FechaSalida),
        row.Refaccionamiento || null,
        row.AtendioPor || null,
        row.EvidenciaURL || null,
        row.VistoBueno || null,
        row.ComentarioReportante || null,
      ]
    );
    insertados++;
  }

  console.log(`Reportes importados. Nuevos: ${insertados}, omitidos (ya existían o sin folio): ${omitidos}.`);
  await pool.end();
}

main().catch((err) => {
  console.error('Error al importar reportes:', err);
  process.exit(1);
});
