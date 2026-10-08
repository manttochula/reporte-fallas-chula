// Da de alta las refacciones del servicio de motor (DIMSUR) del equipo
// AF648-6603 JD y las asigna a su regla de mantenimiento "SERVICIO MOTOR"
// (cada 300 horas).
//
// Qué hace, paso a paso:
//   1) Busca el proveedor "DIMSUR" en el catálogo de proveedores; si no
//      existe, lo crea.
//   2) Da de alta cada refacción de la lista de abajo en el catálogo
//      (pestaña Refacciones), con su "No. de parte" y su descripción
//      (con "JD" agregado al final), ligada al proveedor DIMSUR. El
//      precio queda en blanco (se puede capturar después desde "Editar").
//      Si una refacción con ese mismo No. de parte ya existía, no la
//      duplica: la reutiliza tal cual está.
//   3) Busca la regla de mantenimiento "SERVICIO MOTOR" (cada 300 horas)
//      del equipo cuyo campo "Unidad" contenga "648-6603", y le asigna
//      las 5 refacciones (cantidad 1 cada una). Si ya estaba asignada
//      alguna, no la duplica.
//
// Se puede correr más de una vez sin problema (no duplica nada).
//
// Cómo correrlo (en tu computadora, en la carpeta del proyecto):
//   node server/scripts/seedRefaccionesDimsurMotor.js
//
require('dotenv').config();
const pool = require('../db');
const { siguienteFolio_ } = require('../helpers');

const PROVEEDOR_NOMBRE = 'DIMSUR';

const REFACCIONES = [
  { noParte: 'RE504836', descripcion: 'FILTRO DE ACEITE MOTOR', cantidad: 1 },
  { noParte: 'RE509208', descripcion: '109779 CARTUCHO DE FILTRO', cantidad: 1 },
  { noParte: 'RE62419', descripcion: '47713 FILTRO DE COMBUSTIBLE 51099002', cantidad: 1 },
  { noParte: 'SU20768', descripcion: '106225 FILTRO DE AIRE PRIMARIO', cantidad: 1 },
  { noParte: 'RE253519', descripcion: '106226 CARTUCHO DE FILTRO AIRE SECUNDARIO', cantidad: 1 },
];

async function obtenerOCrearProveedorDimsur() {
  const [existentes] = await pool.query(
    'SELECT id, nombre FROM proveedores WHERE LOWER(nombre) = LOWER(?) LIMIT 1',
    [PROVEEDOR_NOMBRE]
  );
  if (existentes.length > 0) {
    console.log(`Proveedor "${existentes[0].nombre}" ya existía (id ${existentes[0].id}).`);
    return existentes[0].id;
  }
  const [result] = await pool.query('INSERT INTO proveedores (nombre) VALUES (?)', [PROVEEDOR_NOMBRE]);
  console.log(`Proveedor "${PROVEEDOR_NOMBRE}" creado (id ${result.insertId}).`);
  return result.insertId;
}

async function obtenerOCrearRefaccion(item, proveedorId) {
  const descripcionFinal = item.descripcion.trim() + ' JD';

  const [existentes] = await pool.query(
    'SELECT id, descripcion FROM refacciones WHERE no_parte = ? LIMIT 1',
    [item.noParte]
  );
  if (existentes.length > 0) {
    console.log(`Refacción No. de parte ${item.noParte} ya existía (id ${existentes[0].id}: "${existentes[0].descripcion}") — no se duplica.`);
    return existentes[0].id;
  }

  const codigo = await siguienteFolio_(pool, 'refaccion', 'REF', 5);
  const [result] = await pool.query(
    'INSERT INTO refacciones (codigo, no_parte, descripcion, precio, proveedor_id) VALUES (?, ?, ?, NULL, ?)',
    [codigo, item.noParte, descripcionFinal, proveedorId]
  );
  console.log(`Refacción creada: ${codigo} — No. de parte ${item.noParte} — "${descripcionFinal}" (id ${result.insertId}).`);
  return result.insertId;
}

async function buscarReglaServicioMotor() {
  const [reglas] = await pool.query(`
    SELECT r.id AS Id, r.codigo_unidad AS CodigoUnidad, r.nombre_servicio AS NombreServicio,
           r.tipo_periodicidad AS TipoPeriodicidad, r.intervalo AS Intervalo,
           m.unidad AS Unidad
    FROM mantenimiento_reglas r
    LEFT JOIN maquinaria m ON m.codigo_unidad = r.codigo_unidad
    WHERE m.unidad LIKE '%648-6603%'
      AND UPPER(r.nombre_servicio) LIKE '%MOTOR%'
      AND r.tipo_periodicidad = 'horas'
      AND r.intervalo = 300
  `);

  if (reglas.length === 1) return reglas[0];

  if (reglas.length === 0) {
    console.error('No se encontró ninguna regla de mantenimiento "SERVICIO MOTOR" (cada 300 horas) para una unidad que contenga "648-6603".');
    console.error('Revisa en la pestaña Mantenimiento que la regla exista con ese nombre y periodicidad, y vuelve a correr este script.');
  } else {
    console.error(`Se encontró más de una regla que coincide (${reglas.length}); no se va a adivinar cuál es. Ids encontrados: ${reglas.map((r) => r.Id).join(', ')}`);
    console.error('Asigna las refacciones manualmente desde el botón "Editar" de la regla correcta en la pestaña Mantenimiento.');
  }
  return null;
}

async function asignarRefaccionARegla(reglaId, refaccionId, cantidad) {
  const [existentes] = await pool.query(
    'SELECT id FROM mantenimiento_regla_refacciones WHERE regla_id = ? AND refaccion_id = ? LIMIT 1',
    [reglaId, refaccionId]
  );
  if (existentes.length > 0) {
    console.log(`  Ya estaba asignada (refacción id ${refaccionId}) a la regla — no se duplica.`);
    return;
  }
  await pool.query(
    'INSERT INTO mantenimiento_regla_refacciones (regla_id, refaccion_id, cantidad) VALUES (?, ?, ?)',
    [reglaId, refaccionId, cantidad]
  );
  console.log(`  Asignada refacción id ${refaccionId} a la regla (cantidad ${cantidad}).`);
}

async function main() {
  console.log('--- Dando de alta refacciones DIMSUR (servicio de motor AF648-6603 JD) ---');

  const proveedorId = await obtenerOCrearProveedorDimsur();

  const refaccionIds = [];
  for (const item of REFACCIONES) {
    const id = await obtenerOCrearRefaccion(item, proveedorId);
    refaccionIds.push({ id, item });
  }

  console.log('');
  console.log('Buscando la regla de mantenimiento "SERVICIO MOTOR" (cada 300 horas) de AF648-6603 JD...');
  const regla = await buscarReglaServicioMotor();

  if (regla) {
    console.log(`Regla encontrada: id ${regla.Id} — ${regla.Unidad} — "${regla.NombreServicio}" (cada ${regla.Intervalo} ${regla.TipoPeriodicidad}).`);
    console.log('Asignando refacciones a la regla...');
    for (const { id, item } of refaccionIds) {
      await asignarRefaccionARegla(regla.Id, id, item.cantidad);
    }
    console.log('');
    console.log('Listo. Las 5 refacciones quedaron dadas de alta y asignadas al servicio de motor.');
  } else {
    console.log('');
    console.log('Las 5 refacciones quedaron dadas de alta en el catálogo, pero NO se asignaron a ninguna regla');
    console.log('(no se encontró exactamente una regla que coincida — revisa el mensaje de arriba).');
  }

  await pool.end();
}

main().catch((err) => {
  console.error('Error:', err);
  process.exit(1);
});
