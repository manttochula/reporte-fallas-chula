// Script de SOLO LECTURA para diagnosticar por qué la corrida real de
// importarPreventivosAgricolas.js dejó fuera (omitidos) varios equipos
// JOHN DEERE / KUBOTA que sí deberían tener regla (3036-E, 5075-E, 3320,
// 6603, MX5100), y por qué "AF-12 L3800 KUBOTA" / "AF-13 L3800 KUBOTA"
// salieron como "equipo no encontrado en Maquinaria".
//
// NO modifica nada en la base de datos. Solo imprime información para
// comparar contra lo que trae el script.
//
// Cómo correrlo (en tu computadora, en la carpeta del proyecto):
//   node server/scripts/diagnosticoPreventivosAgricolas.js > diagnostico.txt
//
// Después mándame el archivo diagnostico.txt (o pega aquí el contenido).
//
require('dotenv').config();
const pool = require('../db');

const MODELO_MARCA = {
  '5415': 'JOHN DEERE', '5615': 'JOHN DEERE', '5725': 'JOHN DEERE',
  '6115D': 'JOHN DEERE', '5303': 'JOHN DEERE', '4120': 'JOHN DEERE',
  '3036-E': 'JOHN DEERE', '5075-E': 'JOHN DEERE', '3320': 'JOHN DEERE',
  '5715': 'JOHN DEERE', '5065-E': 'JOHN DEERE', '6115D AMERICANO': 'JOHN DEERE',
  '6603': 'JOHN DEERE',
  'L3800': 'KUBOTA', 'M7040': 'KUBOTA', 'M9540': 'KUBOTA', 'MX5100': 'KUBOTA',
  'FORD': 'FORD',
};

function marcar(s) {
  if (s === null || s === undefined) return '(NULL)';
  return '[' + s + ']  (longitud ' + String(s).length + ')';
}

function norm(s) {
  return String(s || '').trim().toUpperCase().replace(/\s+/g, ' ');
}

async function main() {
  console.log('=== 1) Marcas en marcas_refacciones (JOHN DEERE / KUBOTA / FORD) ===');
  const [marcas] = await pool.query(
    "SELECT id, nombre FROM marcas_refacciones WHERE UPPER(TRIM(nombre)) IN ('JOHN DEERE','KUBOTA','FORD') ORDER BY nombre, id"
  );
  marcas.forEach((m) => console.log('  id=' + m.id + '  nombre=' + marcar(m.nombre)));
  console.log('  (si aparece la misma marca más de una vez arriba, con distinto id, ese ya es un problema de por sí)');

  console.log('');
  console.log('=== 2) Modelos en modelos_refacciones para esas marcas ===');
  const [modelos] = await pool.query(
    `SELECT mo.id, mo.marca_id, ma.nombre AS marca, mo.nombre AS modelo
     FROM modelos_refacciones mo
     JOIN marcas_refacciones ma ON ma.id = mo.marca_id
     WHERE UPPER(TRIM(ma.nombre)) IN ('JOHN DEERE','KUBOTA','FORD')
     ORDER BY ma.nombre, mo.nombre, mo.id`
  );
  modelos.forEach((m) => console.log('  id=' + m.id + '  marca_id=' + m.marca_id + '  marca=' + m.marca + '  modelo=' + marcar(m.modelo)));

  console.log('');
  console.log('=== 3) Comparación contra las claves que usa el script (MODELO_MARCA) ===');
  for (const modeloKey of Object.keys(MODELO_MARCA)) {
    const marcaNombre = MODELO_MARCA[modeloKey];
    const exacto = modelos.find((m) => m.marca === marcaNombre && m.modelo === modeloKey);
    if (exacto) {
      console.log('  OK exacto: "' + marcaNombre + '" "' + modeloKey + '" -> id ' + exacto.id);
      continue;
    }
    const normEncontrado = modelos.find((m) => norm(m.marca) === norm(marcaNombre) && norm(m.modelo) === norm(modeloKey));
    if (normEncontrado) {
      console.log('  *** MISMATCH *** "' + marcaNombre + '" "' + modeloKey + '":');
      console.log('      el script busca (exacto): modelo=' + marcar(modeloKey));
      console.log('      lo que ya existe en la BD: modelo=' + marcar(normEncontrado.modelo) + '  (id ' + normEncontrado.id + ', marca_id ' + normEncontrado.marca_id + ')');
      console.log('      -> como no son EXACTAMENTE iguales, el script creó un modelo NUEVO/duplicado en vez de reusar este.');
    } else {
      console.log('  (no existía ningún modelo parecido a "' + marcaNombre + '" "' + modeloKey + '" antes de correr el script - normal si es la primera vez que se usa)');
    }
  }

  console.log('');
  console.log('=== 4) Equipos (Maquinaria) cuyo modelo_id NO tiene regla nueva creada ===');
  const [reglaModelos] = await pool.query(
    `SELECT DISTINCT modelo_id FROM mantenimiento_reglas WHERE activo = 1 AND modelo_id IS NOT NULL`
  );
  const modelosConRegla = new Set(reglaModelos.map((r) => r.modelo_id));
  const [equiposJdKubota] = await pool.query(
    `SELECT m.codigo_unidad, m.unidad, m.modelo_id, mo.nombre AS modelo_nombre, ma.nombre AS marca_nombre
     FROM maquinaria m
     JOIN modelos_refacciones mo ON mo.id = m.modelo_id
     JOIN marcas_refacciones ma ON ma.id = mo.marca_id
     WHERE UPPER(TRIM(ma.nombre)) IN ('JOHN DEERE','KUBOTA')
     ORDER BY ma.nombre, mo.nombre, m.unidad`
  );
  equiposJdKubota.forEach((e) => {
    const tieneRegla = modelosConRegla.has(e.modelo_id);
    if (!tieneRegla) {
      console.log('  SIN REGLA: ' + e.codigo_unidad + '  unidad=' + marcar(e.unidad) + '  modelo_id=' + e.modelo_id + '  modelo=' + marcar(e.modelo_nombre) + '  marca=' + e.marca_nombre);
    }
  });

  console.log('');
  console.log('=== 5) Búsqueda de "AF-12 L3800 KUBOTA" / "AF-13 L3800 KUBOTA" en Maquinaria ===');
  const [l3800] = await pool.query(
    `SELECT codigo_unidad, unidad, modelo_id FROM maquinaria WHERE unidad LIKE '%L3800%' ORDER BY unidad`
  );
  l3800.forEach((e) => console.log('  ' + e.codigo_unidad + '  unidad=' + marcar(e.unidad) + '  modelo_id=' + e.modelo_id));

  console.log('');
  console.log('=== 6) Búsqueda amplia por "AF-12" / "AF-13" / "AF12" / "AF13" en Maquinaria ===');
  const [af1213] = await pool.query(
    `SELECT codigo_unidad, unidad, modelo_id FROM maquinaria
     WHERE unidad LIKE '%AF-12%' OR unidad LIKE '%AF12%' OR unidad LIKE '%AF-13%' OR unidad LIKE '%AF13%'
     ORDER BY unidad`
  );
  af1213.forEach((e) => console.log('  ' + e.codigo_unidad + '  unidad=' + marcar(e.unidad) + '  modelo_id=' + e.modelo_id));

  console.log('');
  console.log('=== Fin del diagnóstico ===');
  await pool.end();
}

main().catch((err) => {
  console.error('Error:', err);
  process.exit(1);
});
