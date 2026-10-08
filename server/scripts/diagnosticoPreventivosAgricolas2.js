// Segunda parte del diagnóstico (SOLO LECTURA, no cambia nada).
//
// Con el primer diagnóstico ya vimos el problema: en tu Catálogo existen
// DOS familias de nombres para los mismos modelos John Deere/Kubota, por
// ejemplo "3036-E" (creado hace tiempo por el importador de filtros) y
// "T-3036E" (el que en realidad usan tus equipos en Maquinaria). Antes de
// corregir el script y mover las reglas al nombre correcto, falta
// confirmar UNA cosa: que ningún equipo esté usando ya el modelo "limpio"
// (ej. "3036-E"), para no romper algo que ya esté funcionando bien.
//
// Cómo correrlo (en tu computadora, en la carpeta del proyecto):
//   node server\scripts\diagnosticoPreventivosAgricolas2.js > diagnostico2.txt
//
require('dotenv').config();
const pool = require('../db');

// ids "limpios" (los que coinciden EXACTO con las claves del script) que
// encontramos en el diagnóstico anterior.
const IDS_LIMPIOS = [13, 12, 7, 17, 16, 18, 8, 9, 10, 11, 6, 14, 15, 4, 2, 3, 1];

function marcar(s) {
  if (s === null || s === undefined) return '(NULL)';
  return '[' + s + ']';
}

async function main() {
  console.log('=== Equipos que YA usan alguno de los modelos "limpios" (ids: ' + IDS_LIMPIOS.join(',') + ') ===');
  const [rows] = await pool.query(
    `SELECT m.codigo_unidad, m.unidad, m.modelo_id, mo.nombre AS modelo, ma.nombre AS marca
     FROM maquinaria m
     JOIN modelos_refacciones mo ON mo.id = m.modelo_id
     JOIN marcas_refacciones ma ON ma.id = mo.marca_id
     WHERE m.modelo_id IN (${IDS_LIMPIOS.join(',')})
     ORDER BY mo.nombre, m.unidad`
  );
  if (rows.length === 0) {
    console.log('  (ninguno — confirma que es seguro mover las reglas al nombre "T-..." que sí usan tus equipos)');
  } else {
    rows.forEach((r) => console.log('  ' + r.codigo_unidad + '  unidad=' + marcar(r.unidad) + '  modelo_id=' + r.modelo_id + '  modelo=' + marcar(r.modelo) + '  marca=' + r.marca));
  }

  console.log('');
  console.log('=== ¿Esos modelos "limpios" tienen algo en refacciones_modelos (tabla de otro importador anterior)? ===');
  const [refMod] = await pool.query(
    `SELECT modelo_id, COUNT(*) AS c FROM refacciones_modelos WHERE modelo_id IN (${IDS_LIMPIOS.join(',')}) GROUP BY modelo_id`
  );
  if (refMod.length === 0) {
    console.log('  (ninguno)');
  } else {
    refMod.forEach((r) => console.log('  modelo_id=' + r.modelo_id + '  filas=' + r.c));
  }

  await pool.end();
}

main().catch((err) => {
  console.error('Error:', err);
  process.exit(1);
});
