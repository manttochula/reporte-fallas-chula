// Script de una sola vez: repara las órdenes que YA se generaron (antes del
// cambio en crearOrdenDesdeRegla_) con las refacciones del preventivo
// escritas como texto dentro de la descripción ("...\nRefacciones:\n  ...")
// y/o con el aceite ("...\nAceite: X L") sin reflejarse en "piezas".
// A partir de ahora las órdenes nuevas ya no llevan el texto de
// "Refacciones:" y además el aceite también se guarda como una pieza más —
// todo se ve y se cuenta en el botón "+ piezas" (reportes_refacciones_
// necesarias). Este script hace lo mismo para las órdenes viejas que se
// generaron desde un preventivo (ligadas en mantenimiento_ordenes) y se
// quedaron sin eso:
//   1) Busca esas órdenes cuya descripción tenga el bloque
//      "\nRefacciones:..." y/o la línea "\nAceite: X L".
//   2) Del bloque de refacciones extrae cada línea (no. de parte opcional,
//      descripción, cantidad) — exactamente el mismo formato que escribía
//      crearOrdenDesdeRegla_. Si el no. de parte hace match con el
//      catálogo (refacciones.no_parte), guarda la pieza ligada a ese
//      refaccion_id (así se ve con su no. de parte, igual que en el resto
//      del Panel); si no, la guarda como texto libre (no se pierde
//      información).
//   3) Si hay línea de aceite, agrega una pieza más "Aceite" con esa
//      cantidad (en litros).
//   4) Quita el bloque "Refacciones:..." de la descripción (deja intacto
//      el resto: "Mantenimiento preventivo: ...", "Notas adicionales",
//      "Aceite: X L" — esa línea de aceite SÍ se deja en la descripción,
//      solo se agrega también como pieza; "Comentario").
//
// Las refacciones (del bloque "Refacciones:") solo se agregan si la orden
// TODAVÍA no tiene ninguna pieza guardada — así no se duplica nada si
// alguien ya las revisó a mano desde el modal. El aceite se revisa APARTE:
// si la orden ya tiene piezas (por ejemplo porque una corrida anterior de
// este mismo script ya le puso las refacciones, antes de que este script
// supiera de aceite) pero todavía no tiene una pieza "Aceite", se agrega
// solo esa, sin tocar lo demás. Por eso es seguro correrlo otra vez aunque
// ya se haya corrido antes — va completando lo que falte.
//
// Por seguridad corre en modo de SOLO REPORTE por default: no cambia nada
// en la base de datos, solo imprime qué haría. Para aplicarlo de verdad:
//
//   node server\scripts\limpiarRefaccionesDescripcionPreventivos.js
//        (modo de prueba: no cambia nada, solo muestra el reporte)
//   node server\scripts\limpiarRefaccionesDescripcionPreventivos.js --aplicar
//        (aplica los cambios en la base de datos)

require('dotenv').config();
const pool = require('../db');

const APLICAR = process.argv.includes('--aplicar');

function extraerRefaccionesYLimpiar(descripcion) {
  const m = descripcion.match(/\nRefacciones:([\s\S]*?)(?=\nNotas adicionales:|\nAceite:|\nComentario:|$)/);
  if (!m) return { piezas: [], noParseadas: [], descripcionLimpia: descripcion };

  const bloque = m[1];
  const lineas = bloque.split('\n  ').map((s) => s.trim()).filter(Boolean);
  const piezas = [];
  const noParseadas = [];
  lineas.forEach((linea) => {
    const lm = linea.match(/^(?:(.+?)\s-\s)?(.+?)\sx\s([\d.]+)$/);
    if (lm) {
      piezas.push({ noParte: lm[1] || null, descripcion: lm[2], cantidad: Number(lm[3]) || 1 });
    } else if (linea) {
      noParseadas.push(linea);
    }
  });

  const descripcionLimpia = descripcion.replace(
    /\nRefacciones:[\s\S]*?(?=\nNotas adicionales:|\nAceite:|\nComentario:|$)/,
    ''
  );
  return { piezas, noParseadas, descripcionLimpia };
}

function extraerAceite(descripcion) {
  const m = descripcion.match(/\nAceite:\s*([\d.]+)\s*L\b/);
  if (!m) return null;
  const litros = Number(m[1]);
  return litros > 0 ? litros : null;
}

async function main() {
  console.log(APLICAR ? '=== MODO: APLICANDO CAMBIOS ===' : '=== MODO DE PRUEBA (no se cambia nada; usa --aplicar para aplicar) ===');
  console.log('');

  // Solo órdenes que de verdad vienen de un preventivo (ligadas en
  // mantenimiento_ordenes) — así "Aceite:"/"Refacciones:" no se confunde
  // nunca con texto que alguien haya escrito a mano en otra orden.
  const [candidatas] = await pool.query(
    `SELECT r.orden, r.descripcion
     FROM reportes r
     INNER JOIN mantenimiento_ordenes mo ON mo.orden = r.orden
     WHERE r.descripcion LIKE '%\\nRefacciones:%' OR r.descripcion LIKE '%\\nAceite:%'`
  );
  console.log('Órdenes de preventivos con "Refacciones:" y/o "Aceite:" pendientes de reflejarse en piezas: ' + candidatas.length);

  if (candidatas.length === 0) {
    console.log('No hay nada que reparar.');
    await pool.end();
    return;
  }

  // Catálogo de refacciones, para hacer match por no. de parte.
  const [catalogo] = await pool.query('SELECT id, no_parte FROM refacciones WHERE no_parte IS NOT NULL AND no_parte <> ""');
  const porNoParte = new Map();
  catalogo.forEach((r) => porNoParte.set(r.no_parte.trim().toUpperCase(), r.id));

  // Qué tiene guardado cada orden ya en "piezas": si tiene algo (lo que
  // sea) y, específicamente, si ya tiene una pieza "Aceite".
  const [conPiezas] = await pool.query("SELECT orden, texto_libre FROM reportes_refacciones_necesarias");
  const yaTienenPiezas = new Set();
  const yaTienenAceite = new Set();
  conPiezas.forEach((r) => {
    yaTienenPiezas.add(r.orden);
    if ((r.texto_libre || '').trim() === 'Aceite') yaTienenAceite.add(r.orden);
  });

  let reparadas = 0;
  let soloAceiteCompletado = 0;
  let omitidas = 0;
  let totalPiezasInsertadas = 0;
  const conLineasNoParseadas = [];

  for (const rep of candidatas) {
    const tienePiezas = yaTienenPiezas.has(rep.orden);
    const aceiteLitros = extraerAceite(rep.descripcion);
    const yaTieneAceite = yaTienenAceite.has(rep.orden);

    if (tienePiezas) {
      // Ya se revisó/reparó antes — lo único que puede faltar es el
      // aceite (por ejemplo si se agregó con una versión anterior de este
      // script, de antes de que supiera de aceite).
      if (aceiteLitros && !yaTieneAceite) {
        console.log('- ' + rep.orden + ': ya tenía piezas guardadas; solo le faltaba agregar Aceite x ' + aceiteLitros + '.');
        if (APLICAR) {
          await pool.query(
            'INSERT INTO reportes_refacciones_necesarias (orden, refaccion_id, texto_libre, cantidad, origen, capturado_por) VALUES (?, NULL, ?, ?, ?, ?)',
            [rep.orden, 'Aceite', aceiteLitros, 'preventivo', 'Migración (limpieza de descripción)']
          );
          totalPiezasInsertadas += 1;
        }
        soloAceiteCompletado++;
      } else {
        omitidas++;
        console.log('- ' + rep.orden + ': se omite (ya tiene piezas guardadas, incluido el aceite si aplicaba; no se toca para no duplicar).');
      }
      continue;
    }

    const refacc = extraerRefaccionesYLimpiar(rep.descripcion);

    if (refacc.noParseadas.length > 0) {
      conLineasNoParseadas.push({ orden: rep.orden, lineas: refacc.noParseadas });
    }

    const piezasParaGuardar = refacc.piezas.map((p) => {
      const refaccionId = p.noParte ? porNoParte.get(p.noParte.trim().toUpperCase()) || null : null;
      const textoLibre = refaccionId ? null : (p.noParte ? p.noParte + ' - ' + p.descripcion : p.descripcion);
      return { refaccionId, textoLibre, cantidad: p.cantidad };
    });
    if (aceiteLitros) {
      piezasParaGuardar.push({ refaccionId: null, textoLibre: 'Aceite', cantidad: aceiteLitros });
    }

    if (piezasParaGuardar.length === 0) continue; // no debería pasar, ya filtramos por LIKE arriba

    console.log(
      '- ' + rep.orden + ': ' + piezasParaGuardar.length + ' pieza(s) -> "piezas"' +
      (refacc.noParseadas.length > 0 ? ' (¡' + refacc.noParseadas.length + ' línea(s) no se pudieron leer, revisar abajo!)' : '')
    );
    piezasParaGuardar.forEach((p) => {
      console.log('    · ' + (p.refaccionId ? '[catálogo #' + p.refaccionId + '] ' : '[texto libre] ') + (p.textoLibre || '(descripción del catálogo)') + ' x ' + p.cantidad);
    });

    if (APLICAR) {
      const capturadoPor = 'Migración (limpieza de descripción)';
      const filas = piezasParaGuardar.map((p) => [rep.orden, p.refaccionId, p.textoLibre, p.cantidad, 'preventivo', capturadoPor]);
      await pool.query(
        'INSERT INTO reportes_refacciones_necesarias (orden, refaccion_id, texto_libre, cantidad, origen, capturado_por) VALUES ?',
        [filas]
      );
      totalPiezasInsertadas += filas.length;

      // La línea "Aceite: X L" se deja tal cual en la descripción (solo se
      // agrega también como pieza); únicamente se quita el bloque de
      // "Refacciones:..." si lo había.
      if (refacc.descripcionLimpia !== rep.descripcion) {
        await pool.query('UPDATE reportes SET descripcion = ? WHERE orden = ?', [refacc.descripcionLimpia, rep.orden]);
      }
    }

    reparadas++;
  }

  console.log('');
  console.log('Órdenes reparadas por completo' + (APLICAR ? '' : ' (simulado)') + ': ' + reparadas);
  console.log('Órdenes que ya tenían piezas y solo les faltaba el aceite' + (APLICAR ? '' : ' (simulado)') + ': ' + soloAceiteCompletado);
  console.log('Órdenes omitidas (ya estaban completas): ' + omitidas);
  if (APLICAR) console.log('Piezas insertadas en total: ' + totalPiezasInsertadas);

  if (conLineasNoParseadas.length > 0) {
    console.log('');
    console.log('⚠ Estas órdenes tuvieron líneas de refacciones que no se pudieron leer con el formato esperado (revísalas a mano si hace falta):');
    conLineasNoParseadas.forEach((c) => {
      console.log('  ' + c.orden + ':');
      c.lineas.forEach((l) => console.log('    "' + l + '"'));
    });
  }

  if (!APLICAR) {
    console.log('');
    console.log('Nada se cambió todavía. Si el reporte de arriba se ve bien, corre:');
    console.log('  node server\\scripts\\limpiarRefaccionesDescripcionPreventivos.js --aplicar');
  }

  await pool.end();
}

main().catch((err) => {
  console.error('Error:', err);
  process.exit(1);
});
