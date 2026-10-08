// Da de alta el catálogo de marcas/modelos y marca la compatibilidad de
// refacciones, a partir del archivo "FILTROS Y ACEITES.xlsx" que mandó
// Carlos (filtros de John Deere, Kubota y Ford, por modelo).
//
// Qué hace, paso a paso:
//   1) Da de alta cada marca (JOHN DEERE, KUBOTA, FORD) en el catálogo de
//      marcas, si todavía no existe.
//   2) Da de alta cada modelo de cada marca (ej. JOHN DEERE → 5415, 5615...),
//      si todavía no existe.
//   3) Para cada refacción del listado (identificada por su "No. de parte"):
//        - Si YA existe en tu catálogo (algunas ya estaban agregadas), se
//          conserva tal cual (descripción, precio, proveedor, categoría —
//          nada de eso se toca) y SOLO se le pone/actualiza la marca y los
//          modelos compatibles según este listado.
//        - Si NO existe, se crea nueva (con su descripción, sin precio ni
//          proveedor — se puede completar después desde "Editar") y se le
//          asignan su marca y modelos compatibles.
//   4) Solo se incluyen los FILTROS (los que tienen número de parte real);
//      los aceites/lubricantes a granel del mismo archivo (que no traen
//      número de parte, solo litros) se dejaron fuera a propósito, según lo
//      que se acordó.
//
// Se puede correr más de una vez sin problema: no duplica marcas, modelos
// ni refacciones ya existentes, y vuelve a dejar la misma compatibilidad
// (no se van acumulando modelos repetidos).
//
// Cómo correrlo (en tu computadora, en la carpeta del proyecto):
//   node server/scripts/importarMarcasModelosFiltros.js
//
require('dotenv').config();
const pool = require('../db');
const { siguienteFolio_ } = require('../helpers');

// Listado de refacciones (filtros) tal cual se extrajo de "FILTROS Y
// ACEITES.xlsx": No. de parte, marca, modelos con los que es compatible
// (puede ser más de uno) y una descripción genérica según el tipo de
// filtro que indicaba la hoja.
const FILAS = [
  { noParte: '04811-50650', marca: 'KUBOTA', modelos: ['MX5100'], descripcion: 'O-ring de diesel' },
  { noParte: '04816-00160', marca: 'KUBOTA', modelos: ['MX5100'], descripcion: 'O-ring de diesel' },
  { noParte: '15521-43160', marca: 'KUBOTA', modelos: ['MX5100'], descripcion: 'Filtro de diesel' },
  { noParte: '1G311-43380', marca: 'KUBOTA', modelos: ['M7040', 'M9540'], descripcion: 'Sedimentador de diesel' },
  { noParte: '1G311-43570', marca: 'KUBOTA', modelos: ['M7040', 'M9540'], descripcion: 'O-ring de diesel' },
  { noParte: '3A111-19130', marca: 'KUBOTA', modelos: ['M7040'], descripcion: 'Filtro de aire interior' },
  { noParte: '55231-26150', marca: 'KUBOTA', modelos: ['M9540'], descripcion: 'Filtro de aire interior' },
  { noParte: '59700-26112', marca: 'KUBOTA', modelos: ['M9540'], descripcion: 'Filtro de aire exterior' },
  { noParte: '59800-26110', marca: 'KUBOTA', modelos: ['M7040'], descripcion: 'Filtro de aire exterior' },
  { noParte: '6A320-59930', marca: 'KUBOTA', modelos: ['L3800'], descripcion: 'Filtro de diesel' },
  { noParte: '6A320-59940', marca: 'KUBOTA', modelos: ['L3800'], descripcion: 'O-ring de diesel' },
  { noParte: '6A320-59950', marca: 'KUBOTA', modelos: ['L3800'], descripcion: 'O-ring de diesel' },
  { noParte: '6A671-75090', marca: 'KUBOTA', modelos: ['M9540'], descripcion: 'Filtro de aire de cabina' },
  { noParte: '84518613', marca: 'FORD', modelos: ['FORD'], descripcion: 'Filtro hidráulico' },
  { noParte: 'A-1', marca: 'FORD', modelos: ['FORD'], descripcion: 'Filtro de aceite (motor)' },
  { noParte: 'AL150288', marca: 'JOHN DEERE', modelos: ['6115D'], descripcion: 'Filtro de aire primario' },
  { noParte: 'AL172780', marca: 'JOHN DEERE', modelos: ['6115D'], descripcion: 'Filtro de aire secundario' },
  { noParte: 'AP33330', marca: 'JOHN DEERE', modelos: ['4120'], descripcion: 'Filtro de aire primario' },
  { noParte: 'AP33331', marca: 'JOHN DEERE', modelos: ['4120'], descripcion: 'Filtro de aire secundario' },
  { noParte: 'AT171853', marca: 'JOHN DEERE', modelos: ['5415', '5615', '5715', '5725'], descripcion: 'Filtro de aire primario' },
  { noParte: 'AT171854', marca: 'JOHN DEERE', modelos: ['5415', '5615', '5715', '5725'], descripcion: 'Filtro de aire secundario' },
  { noParte: 'F-296', marca: 'FORD', modelos: ['FORD'], descripcion: 'Filtro de combustible' },
  { noParte: 'HH166-43560', marca: 'KUBOTA', modelos: ['M7040', 'M9540'], descripcion: 'Filtro de diesel' },
  { noParte: 'HH1C0-32430', marca: 'KUBOTA', modelos: ['L3800', 'M7040', 'M9540', 'MX5100'], descripcion: 'Filtro de aceite (motor)' },
  { noParte: 'HH3A0-82623', marca: 'KUBOTA', modelos: ['L3800'], descripcion: 'Filtro hidráulico' },
  { noParte: 'HHTA0-37710', marca: 'KUBOTA', modelos: ['M7040', 'M9540', 'MX5100'], descripcion: 'Filtro hidráulico' },
  { noParte: 'LVA13038', marca: 'JOHN DEERE', modelos: ['4120'], descripcion: 'Filtro hidráulico' },
  { noParte: 'LVA13065', marca: 'JOHN DEERE', modelos: ['3320'], descripcion: 'Filtro hidráulico' },
  { noParte: 'LVA14703', marca: 'JOHN DEERE', modelos: ['3036-E'], descripcion: 'Filtro hidráulico' },
  { noParte: 'M131802', marca: 'JOHN DEERE', modelos: ['3036-E'], descripcion: 'Filtro de aire primario' },
  { noParte: 'M131803', marca: 'JOHN DEERE', modelos: ['3036-E'], descripcion: 'Filtro de aire secundario' },
  { noParte: 'M806419', marca: 'JOHN DEERE', modelos: ['3036-E', '3320'], descripcion: 'Filtro de aceite' },
  { noParte: 'MIU800645', marca: 'JOHN DEERE', modelos: ['3036-E', '3320'], descripcion: 'Filtro de combustible' },
  { noParte: 'R1401-42270', marca: 'KUBOTA', modelos: ['MX5100'], descripcion: 'Filtro de aire exterior' },
  { noParte: 'R2401-42280', marca: 'KUBOTA', modelos: ['MX5100'], descripcion: 'Filtro de aire interior' },
  { noParte: 'RE253519', marca: 'JOHN DEERE', modelos: ['6115D AMERICANO', '6603'], descripcion: 'Filtro de aire secundario' },
  { noParte: 'RE282286', marca: 'JOHN DEERE', modelos: ['5075-E'], descripcion: 'Filtro de aire primario' },
  { noParte: 'RE282287', marca: 'JOHN DEERE', modelos: ['5075-E'], descripcion: 'Filtro de aire secundario' },
  { noParte: 'RE45864', marca: 'JOHN DEERE', modelos: ['5065-E', '5075-E', '5303', '5415', '5615', '5715', '5725'], descripcion: 'Filtro hidráulico' },
  { noParte: 'RE504836', marca: 'JOHN DEERE', modelos: ['5415', '5615', '5715', '5725', '6115D', '6115D AMERICANO', '6603'], descripcion: 'Filtro de aceite' },
  { noParte: 'RE508202', marca: 'JOHN DEERE', modelos: ['4120'], descripcion: 'Filtro de combustible' },
  { noParte: 'RE509208', marca: 'JOHN DEERE', modelos: ['6603'], descripcion: 'Filtro de combustible' },
  { noParte: 'RE519626', marca: 'JOHN DEERE', modelos: ['4120', '5065-E', '5075-E'], descripcion: 'Filtro de aceite' },
  { noParte: 'RE526557', marca: 'JOHN DEERE', modelos: ['6115D'], descripcion: 'Filtro de combustible' },
  { noParte: 'RE541922', marca: 'JOHN DEERE', modelos: ['6115D'], descripcion: 'Filtro de combustible' },
  { noParte: 'RE544391', marca: 'JOHN DEERE', modelos: ['6115D AMERICANO'], descripcion: 'Filtro de combustible' },
  { noParte: 'RE544394', marca: 'JOHN DEERE', modelos: ['6115D AMERICANO'], descripcion: 'Filtro de combustible' },
  { noParte: 'RE60021', marca: 'JOHN DEERE', modelos: ['5065-E', '5075-E', '5303', '5415', '5615', '5715', '5725'], descripcion: 'Filtro de combustible' },
  { noParte: 'RE62419', marca: 'JOHN DEERE', modelos: ['6603'], descripcion: 'Filtro de combustible' },
  { noParte: 'RE68048', marca: 'JOHN DEERE', modelos: ['3320', '5303'], descripcion: 'Filtro de aire primario' },
  { noParte: 'RE68049', marca: 'JOHN DEERE', modelos: ['3320', '5303'], descripcion: 'Filtro de aire secundario' },
  { noParte: 'SJ11792', marca: 'JOHN DEERE', modelos: ['6115D', '6115D AMERICANO', '6603'], descripcion: 'Filtro hidráulico' },
  { noParte: 'SU20768', marca: 'JOHN DEERE', modelos: ['6115D AMERICANO', '6603'], descripcion: 'Filtro de aire primario' },
  { noParte: 'SU29300', marca: 'JOHN DEERE', modelos: ['5065-E'], descripcion: 'Filtro de aire primario' },
  { noParte: 'SU29301', marca: 'JOHN DEERE', modelos: ['5065-E'], descripcion: 'Filtro de aire secundario' },
  { noParte: 'T19044', marca: 'JOHN DEERE', modelos: ['5303'], descripcion: 'Filtro de aceite' },
  { noParte: 'TA040-93220', marca: 'KUBOTA', modelos: ['L3800'], descripcion: 'Filtro de aire interior' },
  { noParte: 'TA040-93230', marca: 'KUBOTA', modelos: ['L3800'], descripcion: 'Filtro de aire exterior' },
];

async function obtenerOCrearMarca(nombre, cache) {
  if (cache.has(nombre)) return cache.get(nombre);
  const [existentes] = await pool.query('SELECT id FROM marcas_refacciones WHERE nombre = ? LIMIT 1', [nombre]);
  if (existentes.length > 0) {
    cache.set(nombre, existentes[0].id);
    return existentes[0].id;
  }
  const [result] = await pool.query('INSERT INTO marcas_refacciones (nombre) VALUES (?)', [nombre]);
  console.log(`Marca creada: "${nombre}" (id ${result.insertId}).`);
  cache.set(nombre, result.insertId);
  return result.insertId;
}

async function obtenerOCrearModelo(marcaId, nombre, cache) {
  const key = marcaId + '|' + nombre;
  if (cache.has(key)) return cache.get(key);
  const [existentes] = await pool.query(
    'SELECT id FROM modelos_refacciones WHERE marca_id = ? AND nombre = ? LIMIT 1',
    [marcaId, nombre]
  );
  if (existentes.length > 0) {
    cache.set(key, existentes[0].id);
    return existentes[0].id;
  }
  const [result] = await pool.query(
    'INSERT INTO modelos_refacciones (marca_id, nombre) VALUES (?, ?)',
    [marcaId, nombre]
  );
  console.log(`  Modelo creado: "${nombre}" (id ${result.insertId}).`);
  cache.set(key, result.insertId);
  return result.insertId;
}

async function obtenerOCrearRefaccion(noParte, descripcion, marcaId) {
  const [existentes] = await pool.query(
    'SELECT id, descripcion, marca_id FROM refacciones WHERE LOWER(TRIM(no_parte)) = LOWER(TRIM(?)) LIMIT 1',
    [noParte]
  );
  if (existentes.length > 0) {
    const ex = existentes[0];
    console.log(`  Refacción "${noParte}" ya existía (id ${ex.id}: "${ex.descripcion}") — se conserva tal cual, solo se le pone marca y modelos.`);
    if (ex.marca_id !== marcaId) {
      await pool.query('UPDATE refacciones SET marca_id = ? WHERE id = ?', [marcaId, ex.id]);
    }
    return ex.id;
  }
  const codigo = await siguienteFolio_(pool, 'refaccion', 'REF', 5);
  const [result] = await pool.query(
    'INSERT INTO refacciones (codigo, no_parte, descripcion, precio, proveedor_id, categoria_id, marca_id) VALUES (?, ?, ?, NULL, NULL, NULL, ?)',
    [codigo, noParte, descripcion, marcaId]
  );
  console.log(`  Refacción creada: ${codigo} — "${noParte}" — "${descripcion}" (id ${result.insertId}).`);
  return result.insertId;
}

async function sincronizarModelosCompatibles(refaccionId, modeloIds) {
  await pool.query('DELETE FROM refacciones_modelos WHERE refaccion_id = ?', [refaccionId]);
  if (modeloIds.length === 0) return;
  const values = modeloIds.map((mid) => [refaccionId, mid]);
  await pool.query('INSERT INTO refacciones_modelos (refaccion_id, modelo_id) VALUES ?', [values]);
}

async function main() {
  console.log('--- 1) Marcas y modelos ---');
  const marcaCache = new Map();
  const modeloCache = new Map();

  const marcasUnicas = [...new Set(FILAS.map((f) => f.marca))];
  for (const m of marcasUnicas) {
    await obtenerOCrearMarca(m, marcaCache);
  }
  for (const f of FILAS) {
    const marcaId = marcaCache.get(f.marca);
    for (const modelo of f.modelos) {
      await obtenerOCrearModelo(marcaId, modelo, modeloCache);
    }
  }

  console.log('');
  console.log('--- 2) Refacciones (filtros) y su compatibilidad ---');
  let creadas = 0;
  let reutilizadas = 0;
  for (const f of FILAS) {
    const marcaId = marcaCache.get(f.marca);
    const [existentesAntes] = await pool.query(
      'SELECT id FROM refacciones WHERE LOWER(TRIM(no_parte)) = LOWER(TRIM(?)) LIMIT 1',
      [f.noParte]
    );
    if (existentesAntes.length > 0) reutilizadas++; else creadas++;

    const refaccionId = await obtenerOCrearRefaccion(f.noParte, f.descripcion, marcaId);
    const modeloIds = f.modelos.map((modelo) => modeloCache.get(marcaId + '|' + modelo));
    await sincronizarModelosCompatibles(refaccionId, modeloIds);
  }

  console.log('');
  console.log(`Listo. ${creadas} refacción(es) nueva(s), ${reutilizadas} ya existían y se les actualizó marca/modelos.`);
  await pool.end();
}

main().catch((err) => {
  console.error('Error:', err);
  process.exit(1);
});
