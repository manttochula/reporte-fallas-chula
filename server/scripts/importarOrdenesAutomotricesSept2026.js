// Importa, de un jalón, las órdenes del reporte operativo "Vehiculares"
// (Excel que mandó Carlos) como órdenes automotrices (es_automotriz = 1).
//
// Por qué un script y no una fila más en db/schema.sql: el folio de cada
// orden (OF-00001, OF-00002...) se genera con un consecutivo atómico
// (siguienteFolio_, tabla `contadores`) que depende de qué folios ya
// existan en la base real de cada quien — no se puede dejar fijo en un
// script que se comparte entre el sandbox y la base de producción sin
// correr el riesgo de chocar con una orden que ya exista ahí. Este script
// sí usa ese mismo consecutivo (la misma función que usa el Panel al
// capturar una orden nueva), así que es seguro correrlo en cualquier base,
// sin importar cuántas órdenes tenga ya.
//
// Cada unidad se busca por su nombre EXACTO en el catálogo de Maquinaria
// (tabla `maquinaria`, columna `unidad`) — así, si el código interno
// (codigo_unidad) no es el mismo en tu base que en el sandbox donde se
// armó este script, igual encuentra la unidad correcta por su nombre.
// Si no la encuentra (o encuentra más de una con el mismo nombre), avisa
// y NO inserta esa orden — para no adivinar y terminar atando la orden al
// equipo equivocado.
//
// Cómo correrlo (en tu computadora, en la carpeta del proyecto):
//   node server/scripts/importarOrdenesAutomotricesSept2026.js
//
// Se puede correr más de una vez: antes de insertar, revisa si ya existe
// una orden con exactamente la misma unidad + fecha + descripción, y si ya
// existe la salta (no duplica).

require('dotenv').config();
const pool = require('../db');
const { siguienteFolio_ } = require('../helpers');

// --------------------------------------------------------------
// Datos del reporte operativo "Vehiculares" (Reporte_operativo.xlsx).
// `unidad` es el nombre EXACTO como aparece en el catálogo de Maquinaria
// (Panel → Maquinaria), no necesariamente idéntico al texto de la columna
// "ACTIVO" del Excel (ahí venía con espacios/guiones inconsistentes).
// --------------------------------------------------------------
const HUERTA = 'TALLER';
const REPORTO = 'Carlos Antonio Contreras Meza';

const ORDENES = [
  { unidad: 'AF-688 FREIGHTLINER', fecha: '2026-02-19', descripcion: 'CUARTIADURA DE CRISTAL' },
  { unidad: 'AF-582-HILUX DC', fecha: '2026-03-02', descripcion: 'SINIESTRO' },
  { unidad: 'AF-619-HILUX CHASIS', fecha: '2026-07-22', descripcion: 'CAMBIO DE ACEITE Y FILTROS' },
  { unidad: 'AF-688 FREIGHTLINER', fecha: '2026-07-22', descripcion: 'CAMBIO DE ACEITE Y FILTROS' },
  { unidad: 'AF-662-RAM700 CS', fecha: '2026-08-27', descripcion: 'AVISO LIQUIDO DE FRENOS, CAMBIO BATERIA, SUENA LAMINA DE ABAJO, DESPUES DE LOS 70KM TIEMBLA' },
  { unidad: 'AF-753 HILUX CHASIS', fecha: '2026-08-27', descripcion: 'MUELLE DE CARGA' },
  { unidad: 'AF-596-HINO 500', fecha: '2026-08-27', descripcion: 'TABLA ROTA, CADENA DESOLDADA' },
  { unidad: 'AF-739 RAM 700 CS', fecha: '2026-09-02', descripcion: 'SERVICIO AGENCIA' },
  { unidad: 'AF-686-MOTO HONDA', fecha: '2026-09-09', descripcion: 'NO FINCIONA EL TABLERO' },
  { unidad: 'AF-038-HINO 500', fecha: '2026-09-09', descripcion: 'LLANTA DELANTERA GASTADA' },
  { unidad: 'AF-626-HILUX CHASIS', fecha: '2026-09-10', descripcion: 'TESTIGOS ENCENDIDOS, TIRA AGUA DEL AIRE ACONDICIONADO, GOMAS DE AMORTIGUADOR, GOMAS DE MUELLE' },
  { unidad: 'AF-688 FREIGHTLINER', fecha: '2026-09-15', descripcion: 'FUGA DE AIRE EN EN LOS FRENOS, FUGA EN EL RADIADOR, ESPEJO CAIDO' },
  { unidad: 'AF-650-RAM 700 DC', fecha: '2026-09-15', descripcion: 'DEJO DE FUNCIONAR EL CLIMA' },
  { unidad: 'AF-022-HILUX CHASIS', fecha: '2026-09-15', descripcion: 'PROBLEMA DE ARRANQUE' },
  { unidad: 'AF-617-HILUX CHASIS', fecha: '2026-09-21', descripcion: 'TORNILLO DE CENTRO QUEBRADO' },
  { unidad: 'AF-660-RAM700 CS', fecha: '2026-09-22', descripcion: 'REVISION DE LLANTA' },
  { unidad: 'AF-618-HILUX CHASIS', fecha: '2026-09-23', descripcion: 'CAMBIO DE ACEITE Y FILTROS' },
  { unidad: 'AF-015-HILUX DC', fecha: '2026-09-23', descripcion: 'CAMBIO DE ACEITE Y FILTROS' },
  { unidad: 'AF-043-MOTO HONDA', fecha: '2026-09-23', descripcion: 'SERVICIO AGENCIA' },
  { unidad: 'AF-753 HILUX CHASIS', fecha: '2026-09-25', descripcion: 'LLANTAS' },
];

async function registrarAuditoria_(tabla, registro, accion, usuario, detalle) {
  try {
    await pool.query(
      'INSERT INTO auditoria (tabla, registro, accion, usuario, detalle) VALUES (?, ?, ?, ?, ?)',
      [tabla, String(registro), accion, usuario, detalle || null]
    );
  } catch (err) {
    console.error('  (no se pudo registrar en la bitácora de auditoría, pero la orden sí se creó):', err.message);
  }
}

async function main() {
  console.log('Importando ' + ORDENES.length + ' órdenes automotrices...');
  let creadas = 0;
  let saltadas = 0;
  let errores = 0;

  for (const fila of ORDENES) {
    try {
      const [unidades] = await pool.query(
        'SELECT codigo_unidad AS CodigoUnidad, unidad AS Unidad FROM maquinaria WHERE unidad = ?',
        [fila.unidad]
      );
      if (unidades.length === 0) {
        console.error('  ✗ No se encontró en Maquinaria la unidad "' + fila.unidad + '" — se omite esta orden.');
        errores++;
        continue;
      }
      if (unidades.length > 1) {
        console.error('  ✗ Hay más de un equipo llamado "' + fila.unidad + '" en Maquinaria — se omite para no adivinar.');
        errores++;
        continue;
      }
      const codigoUnidad = unidades[0].CodigoUnidad;

      const [existentes] = await pool.query(
        'SELECT orden FROM reportes WHERE codigo_unidad = ? AND fecha = ? AND descripcion = ?',
        [codigoUnidad, fila.fecha + ' 00:00:00', fila.descripcion]
      );
      if (existentes.length > 0) {
        console.log('  - Ya existe (' + existentes[0].orden + '): ' + fila.unidad + ' — ' + fila.descripcion);
        saltadas++;
        continue;
      }

      const orden = await siguienteFolio_(pool, 'orden', 'OF', 5);
      await pool.query(
        `INSERT INTO reportes
          (orden, codigo_unidad, unidad, huerta, descripcion, nombre, fecha, es_automotriz)
         VALUES (?, ?, ?, ?, ?, ?, ?, 1)`,
        [orden, codigoUnidad, fila.unidad, HUERTA, fila.descripcion, REPORTO, fila.fecha + ' 00:00:00']
      );
      await registrarAuditoria_('reportes', orden, 'crear', REPORTO, fila.unidad + ' — ' + fila.descripcion);
      console.log('  ✓ ' + orden + ': ' + fila.unidad + ' — ' + fila.descripcion);
      creadas++;
    } catch (err) {
      console.error('  ✗ Error con "' + fila.unidad + '" (' + fila.descripcion + '):', err.message);
      errores++;
    }
  }

  console.log('');
  console.log('Listo. Creadas: ' + creadas + ' · Ya existían (saltadas): ' + saltadas + ' · Con error: ' + errores);
  await pool.end();
}

main().catch((err) => {
  console.error('Error al importar:', err.message);
  process.exit(1);
});
