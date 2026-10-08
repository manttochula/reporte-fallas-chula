// Llena PLACA (y, si están vacíos, Año/Marca/Modelo/Color/Serie/Tipo de
// unidad) en el catálogo de maquinaria, a partir del archivo que Carlos
// mandó (CAMIONETAS.xlsx, ya convertido aquí a datos_camionetas.csv).
//
// Cómo funciona:
//   - Empareja cada renglón del CSV contra un equipo YA EXISTENTE en el
//     catálogo, comparando el texto de "Unidad" normalizado (mayúsculas,
//     sin espacios/guiones/puntos) contra CodigoUnidad y Unidad de cada
//     equipo — así "AF-688 FREIGHTLINER" sí empareja con "AF-688-FREIGHTLINER".
//   - NUNCA crea equipos nuevos: si un renglón del CSV no encuentra pareja,
//     se reporta como "sin coincidencia" y no se toca nada.
//   - NUNCA pisa un dato que el equipo YA tenga capturado — solo llena los
//     campos que estén vacíos (para no borrar algo que ya esté bien puesto,
//     aunque no coincida con el Excel). Si quieres forzar que el Excel gane
//     siempre, corre con --forzar.
//   - Marca/Modelo van por catálogo (marcas_refacciones/modelos_refacciones,
//     no texto libre) — si la marca o el modelo del Excel no existen
//     todavía, los da de alta antes de ligarlos al equipo.
//   - Por default es un ENSAYO (dry-run): imprime todo lo que HARÍA, sin
//     escribir nada en la base de datos. Para aplicar los cambios de
//     verdad, corre con --aplicar.
//
// Uso:
//   node server/scripts/importDatosCamionetas.js            (solo revisa, no guarda nada)
//   node server/scripts/importDatosCamionetas.js --aplicar   (ya guarda los cambios)
//   node server/scripts/importDatosCamionetas.js --aplicar --forzar   (además, sobrescribe campos que ya tenían algo capturado)
//
// Nota conocida: en el Excel original, el renglón de "AF-598-AMAROK DC"
// traía Marca="AMAROK BLANCA" y Modelo="VOLKSWAGEN" (evidentemente
// desfasados/mal capturados) — se corrigió a mano en datos_camionetas.csv
// a Marca=VOLKSWAGEN, Modelo=AMAROK, Color=BLANCA. Revísalo si algo no
// cuadra.

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { parse } = require('csv-parse/sync');
const pool = require('../db');

const APLICAR = process.argv.includes('--aplicar');
const FORZAR = process.argv.includes('--forzar');

function normaliza(texto) {
  return (texto || '')
    .toString()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');
}

async function obtenerOCrearMarca(nombre, cache) {
  const clave = normaliza(nombre);
  if (!clave) return null;
  if (cache.marcas.has(clave)) return cache.marcas.get(clave);
  const [rows] = await pool.query('SELECT id FROM marcas_refacciones WHERE UPPER(TRIM(nombre)) = UPPER(TRIM(?))', [nombre]);
  if (rows.length) {
    cache.marcas.set(clave, rows[0].id);
    return rows[0].id;
  }
  if (!APLICAR) {
    // En ensayo no insertamos nada; regresamos un id ficticio para que el
    // reporte diga "(nueva)" — ver abajo.
    return 'NUEVA';
  }
  const [result] = await pool.query('INSERT INTO marcas_refacciones (nombre) VALUES (?)', [nombre.trim()]);
  cache.marcas.set(clave, result.insertId);
  return result.insertId;
}

async function obtenerOCrearModelo(marcaId, nombre, cache) {
  const clave = marcaId + '|' + normaliza(nombre);
  if (!nombre.trim() || marcaId === null) return null;
  if (cache.modelos.has(clave)) return cache.modelos.get(clave);
  if (marcaId === 'NUEVA') return 'NUEVA'; // la marca tampoco existe todavía (ensayo)
  const [rows] = await pool.query(
    'SELECT id FROM modelos_refacciones WHERE marca_id = ? AND UPPER(TRIM(nombre)) = UPPER(TRIM(?))',
    [marcaId, nombre]
  );
  if (rows.length) {
    cache.modelos.set(clave, rows[0].id);
    return rows[0].id;
  }
  if (!APLICAR) return 'NUEVA';
  const [result] = await pool.query('INSERT INTO modelos_refacciones (marca_id, nombre) VALUES (?, ?)', [marcaId, nombre.trim()]);
  cache.modelos.set(clave, result.insertId);
  return result.insertId;
}

async function main() {
  const csvPath = process.argv[3] && !process.argv[3].startsWith('--')
    ? process.argv[3]
    : path.join(__dirname, 'datos_camionetas.csv');
  if (!fs.existsSync(csvPath)) {
    console.error('No se encontró el archivo: ' + csvPath);
    process.exit(1);
  }
  const registros = parse(fs.readFileSync(csvPath, 'utf8'), { columns: true, skip_empty_lines: true, trim: true });

  const [equipos] = await pool.query(
    'SELECT codigo_unidad, unidad, anio, color, serie, placa, tipo_unidad, marca_id, modelo_id FROM maquinaria'
  );
  const porCodigo = new Map();
  const porUnidad = new Map();
  equipos.forEach((e) => {
    porCodigo.set(normaliza(e.codigo_unidad), e);
    porUnidad.set(normaliza(e.unidad), e);
  });

  // Ya sea que exista o no en tipos_unidad (catálogo de sugerencias), se
  // deja también registrado ahí para que aparezca en los desplegables del
  // Panel — no afecta nada si ya estaba.
  const tiposUnidadCsv = Array.from(new Set(registros.map((r) => (r.TipoUnidad || '').trim()).filter(Boolean)));
  if (APLICAR && tiposUnidadCsv.length) {
    for (const t of tiposUnidadCsv) {
      await pool.query('INSERT IGNORE INTO tipos_unidad (nombre) VALUES (?)', [t]);
    }
  }

  const cache = { marcas: new Map(), modelos: new Map() };

  let coincidencias = 0;
  let sinCoincidencia = [];
  let sinCambios = 0;
  let actualizados = 0;

  for (const row of registros) {
    const unidadCsv = (row.Unidad || '').trim();
    const clave = normaliza(unidadCsv);
    const equipo = porCodigo.get(clave) || porUnidad.get(clave);
    if (!equipo) {
      sinCoincidencia.push(unidadCsv);
      continue;
    }
    coincidencias++;

    const cambios = {};
    const camposTexto = [
      ['anio', 'Anio', row.Anio],
      ['color', 'Color', row.Color],
      ['serie', 'Serie', row.Serie],
      ['placa', 'Placa', row.Placa],
      ['tipo_unidad', 'TipoUnidad', row.TipoUnidad],
    ];
    camposTexto.forEach(([col, etiqueta, valorNuevo]) => {
      valorNuevo = (valorNuevo || '').trim();
      if (!valorNuevo) return; // el Excel no trae dato para ese campo, no tocar nada
      const valorActual = (equipo[col] || '').toString().trim();
      if (valorActual && !FORZAR) return; // ya tenía algo capturado, no se pisa (salvo --forzar)
      if (valorActual === valorNuevo) return; // ya está igual, no hay nada que cambiar
      cambios[col] = { etiqueta, de: valorActual, a: valorNuevo };
    });

    // Marca / Modelo (van por catálogo, no texto libre)
    const marcaCsv = (row.Marca || '').trim();
    const modeloCsv = (row.Modelo || '').trim();
    if (marcaCsv && (!equipo.marca_id || FORZAR)) {
      const marcaId = await obtenerOCrearMarca(marcaCsv, cache);
      if (marcaId !== equipo.marca_id) {
        cambios.marca_id = { etiqueta: 'Marca', de: equipo.marca_id ? '(otra marca ya ligada)' : '(sin marca)', a: marcaCsv + (marcaId === 'NUEVA' ? ' (nueva)' : '') };
        if (modeloCsv) {
          const modeloId = await obtenerOCrearModelo(marcaId, modeloCsv, cache);
          cambios.modelo_id = { etiqueta: 'Modelo', de: equipo.modelo_id ? '(otro modelo ya ligado)' : '(sin modelo)', a: modeloCsv + (modeloId === 'NUEVA' ? ' (nuevo)' : '') };
          cambios._modeloId = modeloId;
        }
        cambios._marcaId = marcaId;
      }
    }

    if (Object.keys(cambios).length === 0) {
      sinCambios++;
      continue;
    }

    actualizados++;
    console.log('\n' + equipo.codigo_unidad + ' (' + equipo.unidad + ')');
    Object.keys(cambios).forEach((k) => {
      if (k === '_marcaId' || k === '_modeloId') return;
      const c = cambios[k];
      console.log('  ' + c.etiqueta + ': "' + c.de + '" -> "' + c.a + '"');
    });

    if (APLICAR) {
      const sets = [];
      const valores = [];
      ['anio', 'color', 'serie', 'placa', 'tipo_unidad'].forEach((col) => {
        if (cambios[col]) {
          sets.push(col + ' = ?');
          valores.push(row[camposTexto.find((c) => c[0] === col)[1]].trim());
        }
      });
      if (cambios._marcaId && cambios._marcaId !== 'NUEVA') {
        sets.push('marca_id = ?');
        valores.push(cambios._marcaId);
      }
      if (cambios._modeloId && cambios._modeloId !== 'NUEVA') {
        sets.push('modelo_id = ?');
        valores.push(cambios._modeloId);
      }
      if (sets.length) {
        valores.push(equipo.codigo_unidad);
        await pool.query('UPDATE maquinaria SET ' + sets.join(', ') + ' WHERE codigo_unidad = ?', valores);
      }
    }
  }

  console.log('\n=== Resumen ===');
  console.log('Renglones en el archivo: ' + registros.length);
  console.log('Con coincidencia en el catálogo: ' + coincidencias);
  console.log('  - Con cambios ' + (APLICAR ? 'aplicados' : 'propuestos') + ': ' + actualizados);
  console.log('  - Sin cambios (ya estaba todo igual o lleno): ' + sinCambios);
  console.log('Sin coincidencia en el catálogo (no se tocó nada): ' + sinCoincidencia.length);
  if (sinCoincidencia.length) {
    console.log('  ' + sinCoincidencia.join('\n  '));
  }
  if (!APLICAR) {
    console.log('\nEsto fue solo un ENSAYO, no se guardó nada. Si se ve bien, corre de nuevo agregando --aplicar.');
  } else {
    console.log('\nCambios guardados.');
  }
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
