// Script de una sola vez: "borra" (elimina suave, no destruye nada) TODAS
// las capturas que existan hasta ahora en las dos tablas de la pestaña
// "Combustible Agrícola" (antes "Diesel"):
//   - diesel_entregas ("Diesel entregado a huertas")
//   - diesel           ("captura por unidad")
//
// No hace un DELETE de verdad: marca eliminado=1 (con quién/cuándo) en
// cada fila que todavía estuviera activa, igual que si alguien le diera
// clic a "Eliminar" fila por fila desde el Panel. Por eso:
//   - Sigue siendo reversible: con la casilla "Mostrar eliminados" (nueva,
//     en cada apartado) se pueden ver y, si hace falta, restaurar.
//   - "Diesel restante por huerta" y los cálculos de rendimiento/última
//     lectura por equipo van a partir de aquí de cero (ya no cuentan las
//     capturas viejas), tal como se pidió.
//
// Requiere haber corrido primero (una sola vez, si no se ha hecho ya):
//   node server\scripts\aplicarSchema.js
// (agrega las columnas eliminado/eliminado_por/eliminado_en a ambas
// tablas; este script falla claramente si todavía no existen).
//
// Se puede correr más de una vez sin problema: la segunda vez ya no
// encuentra filas activas que marcar (solo afecta las que sigan con
// eliminado=0).
//
// Cómo correrlo (en tu computadora, en la carpeta del proyecto):
//   node server\scripts\limpiarCapturasCombustibleAgricola.js
//
require('dotenv').config();
const pool = require('../db');

const MARCADO_POR = 'Limpieza inicial (Combustible Agrícola)';

async function main() {
  const [entregasActivas] = await pool.query('SELECT COUNT(*) AS n FROM diesel_entregas WHERE eliminado = 0');
  const [cargasActivas] = await pool.query('SELECT COUNT(*) AS n FROM diesel WHERE eliminado = 0');

  console.log('Entregas a huertas activas antes de limpiar: ' + entregasActivas[0].n);
  console.log('Capturas por unidad activas antes de limpiar: ' + cargasActivas[0].n);

  const [resEntregas] = await pool.query(
    "UPDATE diesel_entregas SET eliminado = 1, eliminado_por = ?, eliminado_en = NOW() WHERE eliminado = 0",
    [MARCADO_POR]
  );
  const [resCargas] = await pool.query(
    "UPDATE diesel SET eliminado = 1, eliminado_por = ?, eliminado_en = NOW() WHERE eliminado = 0",
    [MARCADO_POR]
  );

  console.log('');
  console.log('Entregas a huertas marcadas como eliminadas ahora: ' + resEntregas.affectedRows);
  console.log('Capturas por unidad marcadas como eliminadas ahora: ' + resCargas.affectedRows);
  console.log('');
  console.log('Listo. Ambos apartados quedan en cero; lo anterior sigue disponible con "Mostrar eliminados".');

  await pool.end();
}

main().catch((err) => {
  console.error('Error:', err);
  process.exit(1);
});
