// Carga el "Rendimiento aceptable (L/h)" por equipo, a partir del archivo
// catalogo_maquinaria_recalculado_diesel.csv que mandó Carlos (columnas
// Unidad / Rendimiento Diesel), dentro de la pestaña "Combustible
// Agrícola" > "Rendimiento aceptable por equipo".
//
// Busca cada equipo por el texto de "Unidad" (tal como aparece en
// Maquinaria/Catálogo) y le actualiza maquinaria.rendimiento_max. Nunca
// inventa nada: si un equipo del archivo no se encuentra en tu Catálogo,
// o si su casilla "Funciona con diesel" está apagada (por lo que no
// aparecería en la tabla del Panel aunque el dato ya haya quedado
// guardado), se reporta al final para que lo revises tú.
//
// Se puede correr más de una vez sin problema: simplemente vuelve a
// dejar el mismo valor.
//
// Cómo correrlo (en tu computadora, en la carpeta del proyecto):
//   node server\scripts\importarRendimientoDiesel.js
//
require('dotenv').config();
const pool = require('../db');

// unidad (tal como aparece en Maquinaria) -> rendimiento aceptable (L/h)
const RENDIMIENTOS = [
  ['AF-001-5065E JD', 6.0],
  ['AF-003-L3800 KUBOTA', 3.5],
  ['AF-004-L3800 KUBOTA', 3.5],
  ['AF-011-7040 KUBOTA', 7.0],
  ['AF-012-L3800 KUBOTA', 3.5],
  ['AF-013-L3800 KUBOTA', 3.5],
  ['AF-016-L3800 KUBOTA', 3.5],
  ['AF-017-9540 KUBOTA', 10.0],
  ['AF-023-5100 KUBOTA', 8.5],
  ['AF-026-7040 KUBOTA', 7.0],
  ['AF-027-7040 KUBOTA', 7.0],
  ['AF-028-L3800 KUBOTA', 3.5],
  ['AF-029-7040 KUBOTA', 7.0],
  ['AF-030-L3800 KUBOTA', 3.5],
  ['AF-031-L3800 KUBOTA', 3.5],
  ['AF-032-L3800 KUBOTA', 3.5],
  ['AF-034-L3800 KUBOTA', 3.5],
  ['AF-306-3320 JD', 4.5],
  ['AF-307-3320 JD', 4.5],
  ['AF-311-3320 JD', 4.5],
  ['AF-431-7610 NW', 17.0],
  ['AF-441-6600 FORD', 13.0],
  ['AF-442-6600 FORD', 13.0],
  ['AF-477-5615 JD', 8.5],
  ['AF-478-5615 JD', 8.5],
  ['AF-481-6115 JD', 13.0],
  ['AF-499-5715 JD', 10.0],
  ['AF-511-6115 JD', 13.0],
  ['AF-512-4120 JD', 5.5],
  ['AF-513-3320 JD', 4.5],
  ['AF-517-416D CAT', 10.0],
  ['AF-523-5075 JD', 8.0],
  ['AF-524-6115 JD', 13.0],
  ['AF-525-3320 JD', 4.5],
  ['AF-526-3320 JD', 4.5],
  ['AF-542-3320 JD', 4.5],
  ['AF-543-3320 JD', 4.5],
  ['AF-554-5725 JD', 10.5],
  ['AF-555-5303 JD', 7.5],
  ['AF-571-5415 JD', 7.5],
  ['AF-572-5415 JD', 7.5],
  ['AF-573-5415 JD', 7.5],
  ['AF-574-5415 JD', 7.5],
  ['AF-575-5415 JD', 7.5],
  ['AF-586-3036 JD', 4.0],
  ['AF-587-3036 JD', 4.0],
  ['AF-588-3036 JD', 4.0],
  ['AF-590-3036 JD', 4.0],
  ['AF-597-L3800 KUBOTA', 3.5],
  ['AF-598-L3800 KUBOTA', 3.5],
  ['AF-599-7040 KUBOTA', 7.0],
  ['AF-600-7040 KUBOTA', 7.0],
  ['AF-602-M7040 KUBOTA', 7.0],
  ['AF-624-7040 KUBOTA', 7.0],
  ['AF-625-L3800 KUBOTA', 3.5],
  ['AF-630-L3800 KUBOTA', 3.5],
  ['AF-631-L3800 KUBOTA', 3.5],
  ['AF-632-L3800 KUBOTA', 3.5],
  ['AF-633-L3800 KUBOTA', 3.5],
  ['AF-638-L3800 KUBOTA', 3.5],
  ['AF-639-L3800 KUBOTA', 3.5],
  ['AF-640-L3800 KUBOTA', 3.5],
  ['AF-641-L3800 KUBOTA', 3.5],
  ['AF-642-L3800 KUBOTA', 3.5],
  ['AF-648-6603 JD', 13.0],
  ['AF-719-L3800 KUBOTA', 3.5],
  ['AF-720-L3800 KUBOTA', 3.5],
  ['AF-721-L3800 KUBOTA', 3.5],
  ['AF-722-L3800 KUBOTA', 3.5],
  ['AF-723-L3800 KUBOTA', 3.5],
  ['AF-724-L3800 KUBOTA', 3.5],
  ['AF-725-L3800 KUBOTA', 3.5],
  ['AF-726-L3800 KUBOTA', 3.5],
  ['AF-727-L3800 KUBOTA', 3.5],
  ['AF-728-L3800 KUBOTA', 3.5],
  ['AF-729-L3800 KUBOTA', 3.5],
  ['AF-730-L3800 KUBOTA', 3.5],
  ['AF-731-6603 JD', 13.0],
  ['FMG-01-L3800 KUBOTA', 3.5],
  ['FMG-02-L3800 KUBOTA', 3.5],
  ['FMG-04-L3800 KUBOTA', 3.5],
  ['FMG-05-L3800 KUBOTA', 3.5],
];

function norm(s) {
  return (s || '').toString().trim().toUpperCase().replace(/\s+/g, ' ');
}

async function main() {
  const [maquinaria] = await pool.query(
    'SELECT codigo_unidad AS CodigoUnidad, unidad AS Unidad, usa_diesel AS UsaDiesel FROM maquinaria'
  );
  const porUnidadNorm = new Map();
  maquinaria.forEach((m) => {
    if (m.Unidad) porUnidadNorm.set(norm(m.Unidad), m);
  });

  let actualizados = 0;
  const noEncontrados = [];
  const sinUsaDiesel = [];

  for (const [unidadTexto, rendimiento] of RENDIMIENTOS) {
    const equipo = porUnidadNorm.get(norm(unidadTexto));
    if (!equipo) {
      noEncontrados.push(unidadTexto);
      continue;
    }
    await pool.query('UPDATE maquinaria SET rendimiento_max = ? WHERE codigo_unidad = ?', [rendimiento, equipo.CodigoUnidad]);
    actualizados++;
    if (!equipo.UsaDiesel) {
      sinUsaDiesel.push(unidadTexto + ' (' + equipo.CodigoUnidad + ')');
    }
    console.log('  ' + unidadTexto + ' (' + equipo.CodigoUnidad + '): rendimiento aceptable = ' + rendimiento + ' L/h.');
  }

  console.log('');
  console.log('=== RESUMEN ===');
  console.log('Equipos actualizados: ' + actualizados + ' de ' + RENDIMIENTOS.length);
  if (noEncontrados.length) {
    console.log('');
    console.log('No encontrados en Maquinaria (revisa el texto de "Unidad" en el Catálogo, puede que esté escrito distinto):');
    noEncontrados.forEach((u) => console.log('  - ' + u));
  }
  if (sinUsaDiesel.length) {
    console.log('');
    console.log('Se guardó el rendimiento, pero estos equipos tienen apagada la casilla "Funciona con diesel" en Catálogo,');
    console.log('así que NO van a aparecer todavía en "Rendimiento aceptable por equipo" del Panel hasta que la actives ahí:');
    sinUsaDiesel.forEach((u) => console.log('  - ' + u));
  }

  await pool.end();
}

main().catch((err) => {
  console.error('Error:', err);
  process.exit(1);
});
