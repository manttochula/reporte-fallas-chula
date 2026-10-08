// Da de alta el listado de refacciones que mandó Carlos (archivo Export.xlsx,
// hoja "A") para SERVICIO MOTOR y SERVICIO HIDRAULICO de 7 unidades, y crea
// (o reutiliza) las reglas de mantenimiento correspondientes con sus
// refacciones asignadas.
//
// Qué hace, paso a paso:
//   1) Da de alta cada refacción del listado en el catálogo (pestaña
//      Refacciones), SIN proveedor asignado (se puede capturar después
//      desde "Editar"). Si una refacción con ese mismo "No. de parte" ya
//      existía en tu catálogo, NO la duplica: la reutiliza tal cual está
//      (con la descripción que ya tenía). Las refacciones cuya
//      descripción empieza con "ACEITE" (nuevas o ya existentes sin
//      categoría) se marcan con la categoría "Aceite", igual que hace
//      db/schema.sql, para que aparezcan en el selector de aceite de
//      Mantenimiento.
//   2) Para cada unidad (AF) y servicio (MOTOR/HIDRAULICO) del listado,
//      busca si ya existe una regla de mantenimiento por horas con ese
//      nombre de servicio para esa unidad:
//        - Si ya existe, la reutiliza tal cual (no le toca el intervalo
//          ni la última lectura que ya tuviera) y solo le agrega las
//          refacciones del listado que le falten.
//        - Si no existe, la crea con el intervalo y la última lectura de
//          este listado (ver INTERVALOS_POR_MARCA / ULTIMAS_LECTURAS
//          abajo), y le asigna las refacciones.
//   3) La regla de AF-648 / SERVICIO MOTOR ya existía antes de este listado
//      (según lo indicado) — el paso 2 la detecta como ya existente y la
//      reutiliza tal cual (no le toca el intervalo ni la última lectura),
//      solo le agrega las refacciones del listado que le falten.
//   4) Al final avisa si alguna unidad (AF) del listado no se encontró en
//      tu catálogo de maquinaria (pestaña Catálogo), por si el código de
//      unidad no coincide exactamente (p.ej. "017" con o sin ceros).
//
// Se puede correr más de una vez sin problema: no duplica refacciones,
// reglas ni asignaciones ya existentes.
//
// Cómo correrlo (en tu computadora, en la carpeta del proyecto):
//   node server/scripts/importarRefaccionesMantenimientoSept2026.js
//
require('dotenv').config();
const pool = require('../db');
const { siguienteFolio_ } = require('../helpers');

// Intervalo (horas) para SERVICIO MOTOR / SERVICIO HIDRAULICO, según lo que
// indicó Carlos: 300/800 para las unidades John Deere, 250/500 para Kubota.
const INTERVALOS_POR_MARCA = {
  JD: { MOTOR: 300, HIDRAULICO: 800 },
  KUBOTA: { MOTOR: 250, HIDRAULICO: 500 },
};

// A qué marca pertenece cada unidad (AF) de este listado.
const MARCA_POR_AF = {
  '511': 'JD',
  '481': 'JD',
  '554': 'JD',
  '731': 'JD',
  '575': 'JD',
  '648': 'JD',
  '017': 'KUBOTA',
};

// Última lectura (horas) de cada servicio por unidad, tomada de la parte
// de abajo del Excel.
const ULTIMAS_LECTURAS = {
  '554': { HIDRAULICO: 1049, MOTOR: 1328 },
  '511': { HIDRAULICO: 20046, MOTOR: 20046 },
  '481': { HIDRAULICO: 22380, MOTOR: 22577 },
  '648': { HIDRAULICO: 6733, MOTOR: 7067 },
  '731': { HIDRAULICO: 2981, MOTOR: 2981 },
  '575': { HIDRAULICO: 5753, MOTOR: 6089 },
  '017': { HIDRAULICO: 6152, MOTOR: 6060 },
};

// Listado de refacciones tal cual viene en el Excel (No Parte, Descripción,
// Cantidad para ese servicio de esa unidad, SERVICIO, AF).
const FILAS = [
  { noParte: '01-05-0535', descripcion: 'ACEITE HIDRAULICO UDT', cantidad: 60, servicio: 'HIDRAULICO', af: '017' },
  { noParte: '01-05-1481', descripcion: 'ACEITE MOTOR KB', cantidad: 20, servicio: 'MOTOR', af: '017' },
  { noParte: '1G311-43380', descripcion: 'FILTRO SEDIMENTOR DE DIESEL', cantidad: 1, servicio: 'MOTOR', af: '017' },
  { noParte: '1G311-43570', descripcion: 'O RING DE FILTRO DE DIESEL M7040', cantidad: 1, servicio: 'MOTOR', af: '017' },
  { noParte: '55231-26150', descripcion: 'FILTRO DE AIRE INTERIOR', cantidad: 1, servicio: 'MOTOR', af: '017' },
  { noParte: '59700-26112', descripcion: 'FILTRO DE AIRE EXTERIOR', cantidad: 1, servicio: 'MOTOR', af: '017' },
  { noParte: 'AL150288', descripcion: 'FILTRO DE AIRE PRIMARIO JD', cantidad: 1, servicio: 'MOTOR', af: '511' },
  { noParte: 'AL150288', descripcion: 'FILTRO DE AIRE PRIMARIO JD', cantidad: 1, servicio: 'MOTOR', af: '481' },
  { noParte: 'AL172780', descripcion: 'FILTRO DE AIRE SECUNDARIO JD', cantidad: 1, servicio: 'MOTOR', af: '511' },
  { noParte: 'AL172780', descripcion: 'FILTRO DE AIRE SECUNDARIO JD', cantidad: 1, servicio: 'MOTOR', af: '481' },
  { noParte: 'AP31646', descripcion: 'ACEITE MOTOR MULTIG. 15W-40 JD', cantidad: 10, servicio: 'MOTOR', af: '554' },
  { noParte: 'AP31646', descripcion: 'ACEITE MOTOR MULTIG. 15W-40 JD', cantidad: 15, servicio: 'MOTOR', af: '511' },
  { noParte: 'AP31646', descripcion: 'ACEITE MOTOR MULTIG. 15W-40 JD', cantidad: 15, servicio: 'MOTOR', af: '481' },
  { noParte: 'AP31646', descripcion: 'ACEITE MOTOR MULTIG. 15W-40 JD', cantidad: 27, servicio: 'MOTOR', af: '648' },
  { noParte: 'AP31646', descripcion: 'ACEITE MOTOR MULTIG. 15W-40 JD', cantidad: 27, servicio: 'MOTOR', af: '731' },
  { noParte: 'AP31646', descripcion: 'ACEITE MOTOR MULTIG. 15W-40 JD', cantidad: 12, servicio: 'MOTOR', af: '575' },
  { noParte: 'AP32697', descripcion: 'ACEITE HIDRAULICO JC20C JD', cantidad: 40, servicio: 'HIDRAULICO', af: '554' },
  { noParte: 'AP32697', descripcion: 'ACEITE HIDRAULICO JC20C JD', cantidad: 60, servicio: 'HIDRAULICO', af: '511' },
  { noParte: 'AP32697', descripcion: 'ACEITE HIDRAULICO JC20C JD', cantidad: 60, servicio: 'HIDRAULICO', af: '481' },
  { noParte: 'AP32697', descripcion: 'ACEITE HIDRAULICO JC20C JD', cantidad: 60, servicio: 'HIDRAULICO', af: '648' },
  { noParte: 'AP32697', descripcion: 'ACEITE HIDRAULICO JC20C JD', cantidad: 60, servicio: 'HIDRAULICO', af: '731' },
  { noParte: 'AP32697', descripcion: 'ACEITE HIDRAULICO JC20C JD', cantidad: 40, servicio: 'HIDRAULICO', af: '575' },
  { noParte: 'AT171853', descripcion: 'FILTRO DE AIRE PRIMARIO JD', cantidad: 1, servicio: 'MOTOR', af: '554' },
  { noParte: 'AT171853', descripcion: 'FILTRO DE AIRE PRIMARIO JD', cantidad: 1, servicio: 'MOTOR', af: '575' },
  { noParte: 'AT171854', descripcion: 'FILTRO DE AIRE SECUNDARIO JD', cantidad: 1, servicio: 'MOTOR', af: '554' },
  { noParte: 'AT171854', descripcion: 'FILTRO DE AIRE SECUNDARIO JD', cantidad: 1, servicio: 'MOTOR', af: '575' },
  { noParte: 'HH166-43560', descripcion: 'FILTRO DE DIESEL M7040', cantidad: 1, servicio: 'MOTOR', af: '017' },
  { noParte: 'HH1C0-32430', descripcion: 'FILTRO DE ACEITE DE MOTOR', cantidad: 1, servicio: 'MOTOR', af: '017' },
  { noParte: 'HHTA0-37710', descripcion: 'FILTRO HIDRAULICO KB', cantidad: 1, servicio: 'HIDRAULICO', af: '017' },
  { noParte: 'RE253519', descripcion: 'FILTRO DE AIRE SECUNDARIO JD', cantidad: 1, servicio: 'MOTOR', af: '648' },
  { noParte: 'RE253519', descripcion: 'FILTRO DE AIRE SECUNDARIO JD', cantidad: 1, servicio: 'MOTOR', af: '731' },
  { noParte: 'RE45864', descripcion: 'FILTRO HIDRAULICO JD', cantidad: 1, servicio: 'HIDRAULICO', af: '554' },
  { noParte: 'RE45864', descripcion: 'FILTRO HIDRAULICO JD', cantidad: 1, servicio: 'HIDRAULICO', af: '575' },
  { noParte: 'RE504836', descripcion: 'FILTRO DE ACEITE JD', cantidad: 1, servicio: 'MOTOR', af: '554' },
  { noParte: 'RE504836', descripcion: 'FILTRO DE ACEITE JD', cantidad: 1, servicio: 'MOTOR', af: '511' },
  { noParte: 'RE504836', descripcion: 'FILTRO DE ACEITE JD', cantidad: 1, servicio: 'MOTOR', af: '481' },
  { noParte: 'RE504836', descripcion: 'FILTRO DE ACEITE JD', cantidad: 1, servicio: 'MOTOR', af: '648' },
  { noParte: 'RE504836', descripcion: 'FILTRO DE ACEITE JD', cantidad: 1, servicio: 'MOTOR', af: '731' },
  { noParte: 'RE504836', descripcion: 'FILTRO DE ACEITE JD', cantidad: 1, servicio: 'MOTOR', af: '575' },
  { noParte: 'RE509208', descripcion: 'FILTRO DE COMBUSTIBLE JD', cantidad: 1, servicio: 'MOTOR', af: '648' },
  { noParte: 'RE509208', descripcion: 'FILTRO DE COMBUSTIBLE JD', cantidad: 1, servicio: 'MOTOR', af: '731' },
  { noParte: 'RE526557', descripcion: 'FILTRO DE COMBUSTIBLE JD', cantidad: 1, servicio: 'MOTOR', af: '511' },
  { noParte: 'RE526557', descripcion: 'FILTRO DE COMBUSTIBLE JD', cantidad: 1, servicio: 'MOTOR', af: '481' },
  { noParte: 'RE541922', descripcion: 'FILTRO DE COMBUSTIBLE JD', cantidad: 1, servicio: 'MOTOR', af: '511' },
  { noParte: 'RE541922', descripcion: 'FILTRO DE COMBUSTIBLE JD', cantidad: 1, servicio: 'MOTOR', af: '481' },
  { noParte: 'RE60021', descripcion: 'FILTRO DE COMBUSTIBLE JD', cantidad: 1, servicio: 'MOTOR', af: '554' },
  { noParte: 'RE60021', descripcion: 'FILTRO DE COMBUSTIBLE JD', cantidad: 1, servicio: 'MOTOR', af: '575' },
  { noParte: 'RE62419', descripcion: 'FILTRO DE COMBUSTIBLE JD', cantidad: 1, servicio: 'MOTOR', af: '648' },
  { noParte: 'RE62419', descripcion: 'FILTRO DE COMBUSTIBLE JD', cantidad: 1, servicio: 'MOTOR', af: '731' },
  { noParte: 'SJ11792', descripcion: 'FILTRO HIDRAULICO JD', cantidad: 1, servicio: 'HIDRAULICO', af: '511' },
  { noParte: 'SJ11792', descripcion: 'FILTRO HIDRAULICO JD', cantidad: 1, servicio: 'HIDRAULICO', af: '481' },
  { noParte: 'SJ11792', descripcion: 'FILTRO HIDRAULICO JD', cantidad: 1, servicio: 'HIDRAULICO', af: '648' },
  { noParte: 'SJ11792', descripcion: 'FILTRO HIDRAULICO JD', cantidad: 1, servicio: 'HIDRAULICO', af: '731' },
  { noParte: 'SU20768', descripcion: 'FILTRO DE AIRE PRIMARIO JD', cantidad: 1, servicio: 'MOTOR', af: '648' },
  { noParte: 'SU20768', descripcion: 'FILTRO DE AIRE PRIMARIO JD', cantidad: 1, servicio: 'MOTOR', af: '731' },
];

// Igual que el backfill de db/schema.sql: da de alta la categoría "Aceite"
// si todavía no existe, y devuelve su id.
async function obtenerCategoriaAceiteId() {
  const [existentes] = await pool.query(
    "SELECT id FROM categorias_refacciones WHERE nombre = 'Aceite' LIMIT 1"
  );
  if (existentes.length > 0) return existentes[0].id;
  const [result] = await pool.query(
    "INSERT INTO categorias_refacciones (nombre) VALUES ('Aceite')"
  );
  console.log(`  Categoría "Aceite" creada (id ${result.insertId}) — no existía todavía en tu catálogo.`);
  return result.insertId;
}

function esAceite(descripcion) {
  return /^ACEITE/i.test((descripcion || '').trim());
}

async function obtenerOCrearRefaccion(noParte, descripcion, categoriaAceiteId) {
  const [existentes] = await pool.query(
    'SELECT id, descripcion, categoria_id FROM refacciones WHERE no_parte = ? LIMIT 1',
    [noParte]
  );
  if (existentes.length > 0) {
    const ex = existentes[0];
    console.log(`  Refacción "${noParte}" ya existía (id ${ex.id}: "${ex.descripcion}") — no se duplica.`);
    if (ex.categoria_id === null && esAceite(ex.descripcion)) {
      await pool.query('UPDATE refacciones SET categoria_id = ? WHERE id = ?', [categoriaAceiteId, ex.id]);
      console.log(`    Se le asignó la categoría "Aceite" (no tenía categoría todavía).`);
    }
    return ex.id;
  }
  const codigo = await siguienteFolio_(pool, 'refaccion', 'REF', 5);
  const categoriaId = esAceite(descripcion) ? categoriaAceiteId : null;
  const [result] = await pool.query(
    'INSERT INTO refacciones (codigo, no_parte, descripcion, precio, proveedor_id, categoria_id) VALUES (?, ?, ?, NULL, NULL, ?)',
    [codigo, noParte, descripcion, categoriaId]
  );
  console.log(`  Refacción creada: ${codigo} — "${noParte}" — "${descripcion}" (id ${result.insertId})${categoriaId ? ' — categoría "Aceite".' : '.'}`);
  return result.insertId;
}

async function buscarOCrearRegla(af, servicioKey) {
  const nombreServicio = 'SERVICIO ' + servicioKey;
  const [existentes] = await pool.query(
    `SELECT id, intervalo, ultima_lectura FROM mantenimiento_reglas
     WHERE codigo_unidad = ? AND UPPER(nombre_servicio) = ? AND tipo_periodicidad = 'horas'
     LIMIT 1`,
    [af, nombreServicio]
  );
  if (existentes.length > 0) {
    const r = existentes[0];
    console.log(`Regla "${nombreServicio}" de AF-${af} ya existía (id ${r.id}, cada ${r.intervalo} h, última lectura ${r.ultima_lectura}) — se reutiliza tal cual.`);
    return r.id;
  }

  const marca = MARCA_POR_AF[af];
  const intervalo = INTERVALOS_POR_MARCA[marca][servicioKey];
  const ultimaLectura = (ULTIMAS_LECTURAS[af] || {})[servicioKey];

  const [result] = await pool.query(
    `INSERT INTO mantenimiento_reglas
      (codigo_unidad, nombre_servicio, tipo_periodicidad, intervalo, ultima_lectura, ultima_fecha, activo)
     VALUES (?, ?, 'horas', ?, ?, NULL, 1)`,
    [af, nombreServicio, intervalo, ultimaLectura !== undefined ? ultimaLectura : null]
  );
  console.log(`Regla "${nombreServicio}" de AF-${af} creada (id ${result.insertId}, cada ${intervalo} h, última lectura ${ultimaLectura}).`);
  return result.insertId;
}

async function asignarRefaccionARegla(reglaId, refaccionId, cantidad) {
  const [existentes] = await pool.query(
    'SELECT id FROM mantenimiento_regla_refacciones WHERE regla_id = ? AND refaccion_id = ? LIMIT 1',
    [reglaId, refaccionId]
  );
  if (existentes.length > 0) {
    console.log(`    Ya estaba asignada (refacción id ${refaccionId}) — no se duplica.`);
    return;
  }
  await pool.query(
    'INSERT INTO mantenimiento_regla_refacciones (regla_id, refaccion_id, cantidad) VALUES (?, ?, ?)',
    [reglaId, refaccionId, cantidad]
  );
  console.log(`    Asignada refacción id ${refaccionId} (cantidad ${cantidad}).`);
}

async function main() {
  console.log('--- 1) Dando de alta refacciones del catálogo ---');
  const categoriaAceiteId = await obtenerCategoriaAceiteId();
  const partesUnicas = new Map(); // noParte -> descripcion
  FILAS.forEach((f) => { if (!partesUnicas.has(f.noParte)) partesUnicas.set(f.noParte, f.descripcion); });

  const idPorNoParte = new Map();
  for (const [noParte, descripcion] of partesUnicas) {
    const id = await obtenerOCrearRefaccion(noParte, descripcion, categoriaAceiteId);
    idPorNoParte.set(noParte, id);
  }

  console.log('');
  console.log('--- 2) Creando/reutilizando reglas y asignando refacciones ---');
  const grupos = new Map(); // "af|servicio" -> [filas]
  FILAS.forEach((f) => {
    const key = f.af + '|' + f.servicio;
    if (!grupos.has(key)) grupos.set(key, []);
    grupos.get(key).push(f);
  });

  for (const [key, filas] of grupos) {
    const [af, servicioKey] = key.split('|');
    const reglaId = await buscarOCrearRegla(af, servicioKey);
    for (const f of filas) {
      await asignarRefaccionARegla(reglaId, idPorNoParte.get(f.noParte), f.cantidad);
    }
  }

  console.log('');
  console.log('--- 3) Revisando que las unidades existan en el catálogo de maquinaria ---');
  const afsUnicos = [...new Set(FILAS.map((f) => f.af))];
  for (const af of afsUnicos) {
    const [maq] = await pool.query('SELECT unidad FROM maquinaria WHERE codigo_unidad = ? LIMIT 1', [af]);
    if (maq.length === 0) {
      console.log(`  AVISO: no se encontró ninguna unidad con código "${af}" en el catálogo de maquinaria. Las reglas de esa unidad van a mostrar "Sin ubicación" hasta que corrijas el código (o el catálogo).`);
    } else {
      console.log(`  AF-${af} -> ${maq[0].unidad} (encontrada, ok).`);
    }
  }

  console.log('');
  console.log('Listo.');
  await pool.end();
}

main().catch((err) => {
  console.error('Error:', err);
  process.exit(1);
});
