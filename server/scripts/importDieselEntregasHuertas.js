// Importa entregas de diesel a granel (pestaña Diesel -> "Diesel entregado
// a huertas") a partir del archivo que Carlos mandó (DIESEL ENTREGADO A
// HUERTAS.xlsx, ya convertido aquí a datos_diesel_entregas_huertas.csv).
//
// Cómo funciona:
//   - Cada renglón del CSV se vuelve una entrega nueva en diesel_entregas
//     (huerta, litros, quién registra, fecha, comentario), exactamente como
//     si se hubiera capturado a mano en el Panel — con su propio folio
//     ENT-##### consecutivo (mismo contador que usa el Panel, para no
//     chocar con folios ya usados ni con capturas nuevas).
//   - Es seguro correrlo más de una vez: antes de insertar un renglón,
//     revisa si YA existe una entrega con la misma huerta+litros+fecha+
//     comentario, y si ya existe la salta (no la duplica).
//   - Por default es un ENSAYO (dry-run): imprime todo lo que HARÍA, sin
//     escribir nada en la base de datos ni gastar folios. Para aplicar los
//     cambios de verdad, corre con --aplicar.
//
// Uso:
//   node server/scripts/importDieselEntregasHuertas.js            (solo revisa, no guarda nada)
//   node server/scripts/importDieselEntregasHuertas.js --aplicar   (ya guarda las entregas)
//
// Nota: la columna HUERTA del archivo trae "LABORATORIO", que no está en el
// catálogo de huertas de cultivo — se importa tal cual (el campo es texto
// libre en la base de datos), pero si quieres que aparezca como opción en
// el desplegable de capturas nuevas, agrégala en Catálogo -> Catálogos ->
// Huertas.

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { parse } = require('csv-parse/sync');
const pool = require('../db');
const { siguienteFolio_ } = require('../helpers');

const APLICAR = process.argv.includes('--aplicar');

async function main() {
  // Ruta de CSV opcional: el primer argumento que NO empiece con "--",
  // sin importar si va antes o después de --aplicar.
  const argCsv = process.argv.slice(2).find((a) => !a.startsWith('--'));
  const csvPath = argCsv || path.join(__dirname, 'datos_diesel_entregas_huertas.csv');
  if (!fs.existsSync(csvPath)) {
    console.error('No se encontró el archivo: ' + csvPath);
    process.exit(1);
  }
  const registros = parse(fs.readFileSync(csvPath, 'utf8'), { columns: true, skip_empty_lines: true, trim: true });

  // OJO: se usa DATE_FORMAT (no DATE()) para que MySQL regrese la fecha ya
  // como texto "AAAA-MM-DD" directo del motor — si se dejara que el driver
  // la convierta a objeto Date de JavaScript, compararla como texto podía
  // salir mal según la zona horaria del proceso de Node (mismo tipo de
  // error del que ya se cuidan fechaLocalHoy_/sumarDiaLocal_ en el Panel).
  const [existentes] = await pool.query(
    `SELECT huerta, litros, nombre, comentario, DATE_FORMAT(fecha, '%Y-%m-%d') AS fecha_dia FROM diesel_entregas WHERE eliminado = 0`
  );
  const yaExiste = (huerta, litros, nombre, fecha, comentario) =>
    existentes.some(
      (e) =>
        (e.huerta || '').trim().toUpperCase() === huerta.toUpperCase() &&
        Number(e.litros) === Number(litros) &&
        (e.nombre || '').trim().toUpperCase() === nombre.toUpperCase() &&
        (e.comentario || '').trim().toUpperCase() === comentario.toUpperCase() &&
        e.fecha_dia === fecha
    );

  let insertadas = 0;
  let omitidas = 0;
  let sinDatos = 0;

  for (const row of registros) {
    const huerta = (row.Huerta || '').trim();
    const litros = parseFloat(row.Litros);
    const nombre = (row.Registro || '').trim();
    const fecha = (row.Fecha || '').trim(); // AAAA-MM-DD
    const comentario = (row.Comentario || '').trim();

    if (!huerta || !litros || Number.isNaN(litros)) {
      sinDatos++;
      console.log('SIN DATOS (se omite): ' + JSON.stringify(row));
      continue;
    }

    if (yaExiste(huerta, litros, nombre, fecha, comentario)) {
      omitidas++;
      console.log('YA EXISTE (se omite): ' + huerta + ' — ' + litros + ' L — ' + fecha + ' — ' + comentario);
      continue;
    }

    // Se guarda al mediodía (no a medianoche) para que la fecha no se
    // corra un día al mostrarse en el navegador si el huso horario del
    // servidor y el de quien lo ve no coinciden exactamente.
    const fechaHora = fecha + ' 12:00:00';

    if (APLICAR) {
      const folio = await siguienteFolio_(pool, 'entrega', 'ENT', 5);
      await pool.query(
        `INSERT INTO diesel_entregas (folio, huerta, litros, nombre, fecha, comentario) VALUES (?, ?, ?, ?, ?, ?)`,
        [folio, huerta, litros, nombre, fechaHora, comentario || null]
      );
      console.log('INSERTADA ' + folio + ': ' + huerta + ' — ' + litros + ' L — ' + fecha + ' — ' + comentario);
    } else {
      console.log('SE INSERTARÍA: ' + huerta + ' — ' + litros + ' L — ' + fecha + ' — ' + comentario + ' (registró: ' + nombre + ')');
    }
    insertadas++;
  }

  console.log('\n=== Resumen ===');
  console.log('Renglones en el archivo: ' + registros.length);
  console.log('Entregas ' + (APLICAR ? 'insertadas' : 'a insertar') + ': ' + insertadas);
  console.log('Ya existían (se omitieron): ' + omitidas);
  if (sinDatos) console.log('Sin huerta/litros válidos (se omitieron): ' + sinDatos);
  if (!APLICAR) {
    console.log('\nEsto fue solo un ENSAYO, no se guardó nada. Si se ve bien, corre de nuevo agregando --aplicar.');
  } else {
    console.log('\nEntregas guardadas.');
  }
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
