// ============================================================
// Importar el listado de productos de CONTPAQi al catálogo de Refacciones
// (oct-2026, petición de Carlos: "este listado hay que subirlo al catálogo
// de refacciones y habilitar el folio comercial; hay piezas ya dadas de
// alta, a esas solo hay que agregarles el folio comercial, que es el código
// de producto; si son filtros, bandas, etc., agrégales la categoría").
//
// 1) leerExcelContpaq_: lee el reporte de CONTPAQi (columnas "Código
//    Producto", "Nombre Producto", "MARCA"; el encabezado puede venir
//    varias filas abajo).
// 2) planearImportacion_ (puro, sin base de datos): decide para cada
//    producto si
//      - ya está en el catálogo con ese folio            -> "ya tenía"
//      - corresponde a una refacción que ya existe        -> SOLO se le
//        agrega el folio comercial (no se toca nada más)
//      - es nueva                                         -> se crea con
//        descripción, marca y categoría (por palabras clave)
//      - es dudosa (coincide con varias, o la refacción ya tiene otro
//        folio, o dos productos apuntan a la misma)       -> NO se toca,
//        queda en "Revisar"
//    Coincidencia con una existente, en este orden:
//      a) el No. de parte de la refacción aparece en el nombre del producto
//         (p.ej. "EJE ... JD-LVU16956" con No. de parte "LVU16956");
//      b) la descripción es igual (sin acentos, mayúsculas ni espacios de más).
// 3) aplicarImportacion_: guarda el plan (crea categorías y marcas que
//    falten; las refacciones nuevas reciben su código REF-xxxxx).
// ============================================================

function normalizarTexto_(t) {
  return (t === null || t === undefined ? '' : String(t))
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toUpperCase().replace(/[^A-Z0-9Ñ]+/g, ' ').trim().replace(/\s+/g, ' ');
}
function normalizarParte_(t) {
  return (t === null || t === undefined ? '' : String(t)).toUpperCase().replace(/[^A-Z0-9]/g, '');
}
// "Pedazos" del nombre que parecen números de parte: con al menos un dígito
// y 5+ caracteres (AL174088, RE504836, 1300190...). Se prueban también sin
// el prefijo de marca (JD-, KB-, CAT-).
function partesEnNombre_(nombre) {
  const crudo = (nombre || '').toString().toUpperCase();
  const set = new Set();
  crudo.split(/[\s,;()/]+/).forEach((tok) => {
    const t = tok.replace(/^(JD|KB|CAT|KUB)[-_]/, '');
    [tok, t].forEach((x) => {
      const p = normalizarParte_(x);
      if (p.length >= 5 && /\d/.test(p)) set.add(p);
    });
  });
  return set;
}

// Categoría por palabras clave del nombre (solo para refacciones NUEVAS).
// El orden importa: lo más específico primero.
const REGLAS_CATEGORIA = [
  { categoria: 'Filtros', palabras: ['FILTRO', 'PREFILTRO', 'ELEMENTO FILTRANTE', 'CARTUCHO FILTRANTE'] },
  { categoria: 'Bandas', palabras: ['BANDA', 'CORREA'] },
  { categoria: 'Aceite', palabras: ['ACEITE'] },
  { categoria: 'Lubricantes', palabras: ['GRASA', 'LUBRICANTE'] },
  { categoria: 'Anticongelante', palabras: ['ANTICONGELANTE', 'REFRIGERANTE', 'COOLANT'] },
  { categoria: 'Baleros y chumaceras', palabras: ['BALERO', 'RODAMIENTO', 'CHUMACERA', 'COJINETE', 'RODILLO CONICO'] },
  { categoria: 'Retenes y empaques', palabras: ['RETEN', 'O RING', 'ORING', 'EMPAQUE', 'JUNTA', 'SELLO', 'KIT DE SELLOS'] },
  { categoria: 'Mangueras', palabras: ['MANGUERA'] },
  { categoria: 'Llantas y cámaras', palabras: ['LLANTA', 'CAMARA', 'NEUMATICO'] },
  { categoria: 'Baterías', palabras: ['BATERIA', 'ACUMULADOR'] },
  { categoria: 'Iluminación', palabras: ['FOCO', 'LAMPARA', 'FARO', 'CALAVERA', 'PLAFON'] },
  { categoria: 'Cadenas y piñones', palabras: ['CADENA', 'CATARINA', 'PINON', 'SPROCKET', 'ESLABON'] },
  { categoria: 'Cuchillas y discos', palabras: ['CUCHILLA', 'NAVAJA', 'DISCO', 'MACHETE', 'PUNTA DE ARADO', 'REJA'] },
  { categoria: 'Boquillas', palabras: ['BOQUILLA', 'ESPREA', 'PUNTA DE ASPERSION'] },
  { categoria: 'Tornillería', palabras: ['TORNILLO', 'TUERCA', 'ARANDELA', 'ESPARRAGO', 'PERNO', 'BIRLO', 'CHAVETA', 'PASADOR', 'PIJA', 'TAQUETE', 'RONDANA', 'OPRESOR'] },
  { categoria: 'Conexiones y abrazaderas', palabras: ['ABRAZADERA', 'CONEXION', 'COPLE', 'NIPLE', 'CODO', 'TEE', 'REDUCCION', 'ADAPTADOR'] },
  { categoria: 'Eléctrico', palabras: ['CABLE', 'ALAMBRE', 'CINTA AISLANTE', 'FUSIBLE', 'RELEVADOR', 'RELE', 'INTERRUPTOR', 'CONTACTO', 'CLAVIJA', 'CONECTOR', 'SWITCH', 'ALTERNADOR', 'MARCHA', 'ARNES'] },
  { categoria: 'Pintura', palabras: ['ESMALTE', 'PINTURA', 'THINNER', 'PRIMER', 'AEROSOL'] },
  { categoria: 'Bombas', palabras: ['BOMBA'] },
  { categoria: 'Bujes', palabras: ['BUJE', 'CASQUILLO'] },
  { categoria: 'Crucetas', palabras: ['CRUCETA', 'YUGO'] },
  { categoria: 'Seguros y anillos', palabras: ['SEGURO', 'ANILLO'] },
  { categoria: 'Válvulas', palabras: ['VALVULA'] },
  { categoria: 'Resortes', palabras: ['RESORTE'] },
  { categoria: 'Frenos', palabras: ['BALATA', 'FRENO', 'ZAPATA'] },
  { categoria: 'Suspensión', palabras: ['AMORTIGUADOR', 'ROTULA', 'GRILLETE', 'MUELLE', 'HORQUILLA'] },
  { categoria: 'Soldadura', palabras: ['ELECTRODO', 'SOLDADURA'] },
  { categoria: 'Eléctrico', palabras: ['SENSOR', 'CONDULET', 'BREAKER', 'CONTACTOR', 'CONMUTADOR', 'PORTALAMPARA', 'AISLADOR', 'POLIDUCTO', 'BUJIA'] },
];
function categoriaPorNombre_(nombre) {
  // Los nombres de CONTPAQi empiezan con el tipo de pieza ("SELLO DE ACEITE",
  // "TUERCA PARA BOQUILLA", "FILTRO DE AIRE..."): se clasifica por ese
  // inicio, no por cualquier palabra del nombre (si no, "SELLO DE ACEITE"
  // caería en Aceite). Se brinca un "KIT DE/DEL" al principio.
  let n = normalizarTexto_(nombre).replace(/^KIT (DE |DEL |PARA )?/, '');
  for (const regla of REGLAS_CATEGORIA) {
    for (const p of regla.palabras) {
      const re = new RegExp('^' + p.replace(/ /g, ' ') + '(S|ES)?( |$)');
      if (re.test(n)) return regla.categoria;
    }
  }
  return null;
}

// existentes: [{id, descripcion, noParte, folioComercial}]
function planearImportacion_(productos, existentes) {
  const plan = { nuevas: [], agregarFolio: [], yaTenian: [], revisar: [] };
  const porFolio = new Map();
  const porParte = new Map();
  const porDesc = new Map();
  (existentes || []).forEach((r) => {
    if (r.folioComercial) porFolio.set(String(r.folioComercial).trim().toUpperCase(), r);
    const p = normalizarParte_(r.noParte);
    if (p.length >= 4) { if (!porParte.has(p)) porParte.set(p, []); porParte.get(p).push(r); }
    const d = normalizarTexto_(r.descripcion);
    if (d) { if (!porDesc.has(d)) porDesc.set(d, []); porDesc.get(d).push(r); }
  });
  const vistos = new Set();
  const candidatos = []; // {producto, refaccion, via}
  (productos || []).forEach((p) => {
    const folio = String(p.codigo || '').trim().toUpperCase();
    if (!folio || !p.nombre) return;
    if (vistos.has(folio)) { plan.revisar.push({ producto: p, motivo: 'El código de producto viene repetido en el Excel.' }); return; }
    vistos.add(folio);
    if (porFolio.has(folio)) { plan.yaTenian.push({ producto: p, refaccion: porFolio.get(folio) }); return; }
    // a) por número de parte
    const porNp = new Map();
    partesEnNombre_(p.nombre).forEach((parte) => (porParte.get(parte) || []).forEach((r) => porNp.set(r.id, r)));
    if (porNp.size > 1) { plan.revisar.push({ producto: p, motivo: 'Coincide por No. de parte con varias refacciones: ' + Array.from(porNp.values()).map((r) => r.descripcion).join(' / ') }); return; }
    let ref = porNp.size === 1 ? Array.from(porNp.values())[0] : null;
    let via = ref ? 'No. de parte' : null;
    // b) por descripción igual
    if (!ref) {
      const iguales = porDesc.get(normalizarTexto_(p.nombre)) || [];
      if (iguales.length > 1) { plan.revisar.push({ producto: p, motivo: 'Hay ' + iguales.length + ' refacciones con la misma descripción.' }); return; }
      if (iguales.length === 1) { ref = iguales[0]; via = 'Descripción igual'; }
    }
    if (!ref) {
      plan.nuevas.push({ producto: p, categoria: categoriaPorNombre_(p.nombre), marca: (p.marca || '').toString().trim() || null });
      return;
    }
    if (ref.folioComercial && String(ref.folioComercial).trim().toUpperCase() !== folio) {
      plan.revisar.push({ producto: p, refaccion: ref, motivo: 'La refacción "' + ref.descripcion + '" ya tiene otro folio comercial (' + ref.folioComercial + ').' });
      return;
    }
    candidatos.push({ producto: p, refaccion: ref, via });
  });
  // Dos productos que apuntan a la misma refacción: ninguno se asigna solo.
  const cuenta = {};
  candidatos.forEach((c) => { cuenta[c.refaccion.id] = (cuenta[c.refaccion.id] || 0) + 1; });
  candidatos.forEach((c) => {
    if (cuenta[c.refaccion.id] > 1) plan.revisar.push({ producto: c.producto, refaccion: c.refaccion, motivo: 'Otro producto del Excel también coincide con "' + c.refaccion.descripcion + '".' });
    else plan.agregarFolio.push(c);
  });
  return plan;
}

async function leerExcelContpaq_(ruta) {
  const ExcelJS = require('exceljs');
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(ruta);
  const ws = wb.worksheets[0];
  let cols = null;
  const productos = [];
  const texto = (v) => {
    if (v === null || v === undefined) return '';
    if (typeof v === 'object') return (v.text || v.result || (v.richText ? v.richText.map((x) => x.text).join('') : '') || '').toString().trim();
    return String(v).trim();
  };
  ws.eachRow({ includeEmpty: false }, (row) => {
    const valores = row.values.map(texto);
    if (!cols) {
      const i = valores.findIndex((v) => /c[oó]digo\s+producto/i.test(v));
      if (i !== -1) {
        cols = {
          codigo: i,
          nombre: valores.findIndex((v) => /nombre\s+producto/i.test(v)),
          marca: valores.findIndex((v) => /^marca$/i.test(v)),
        };
      }
      return;
    }
    const codigo = valores[cols.codigo] || '';
    const nombre = cols.nombre !== -1 ? (valores[cols.nombre] || '') : '';
    // Las notas al pie de CONTPAQi ("(4) Series sin movimiento...") no traen nombre.
    if (!codigo || !nombre || /^\(\d+\)/.test(codigo)) return;
    productos.push({ codigo, nombre: nombre.replace(/\s+/g, ' '), marca: cols.marca !== -1 ? (valores[cols.marca] || '') : '' });
  });
  if (!cols) throw new Error('No encontré la columna "Código Producto" en el Excel.');
  return productos;
}

async function idCatalogo_(con, tabla, nombre, cache) {
  const clave = nombre.toUpperCase();
  if (cache[clave]) return cache[clave];
  const [rows] = await con.query(`SELECT id FROM ${tabla} WHERE UPPER(TRIM(nombre)) = ?`, [clave]);
  let id = rows.length ? rows[0].id : null;
  if (!id) {
    const [ins] = await con.query(`INSERT INTO ${tabla} (nombre) VALUES (?)`, [nombre]);
    id = ins.insertId;
  }
  cache[clave] = id;
  return id;
}

async function aplicarImportacion_(pool, plan, siguienteFolio_, avance) {
  const cacheCat = {};
  const cacheMarca = {};
  let creadas = 0;
  let folios = 0;
  for (const c of plan.agregarFolio) {
    const [r] = await pool.query('UPDATE refacciones SET folio_comercial = ? WHERE id = ? AND (folio_comercial IS NULL OR folio_comercial = ?)', [c.producto.codigo, c.refaccion.id, c.producto.codigo]);
    if (r.affectedRows) folios++;
  }
  if (avance) avance('  Folio agregado a ' + folios + ' refacciones que ya existían. Dando de alta las nuevas...');
  for (const n of plan.nuevas) {
    const categoriaId = n.categoria ? await idCatalogo_(pool, 'categorias_refacciones', n.categoria, cacheCat) : null;
    const marcaId = n.marca ? await idCatalogo_(pool, 'marcas_refacciones', n.marca, cacheMarca) : null;
    const codigo = await siguienteFolio_(pool, 'refaccion', 'REF', 5);
    await pool.query(
      'INSERT INTO refacciones (codigo, descripcion, categoria_id, marca_id, folio_comercial) VALUES (?, ?, ?, ?, ?)',
      [codigo, n.producto.nombre.slice(0, 255), categoriaId, marcaId, n.producto.codigo]
    );
    creadas++;
    if (avance && creadas % 100 === 0) avance('  ... ' + creadas + ' de ' + plan.nuevas.length + ' nuevas');
  }
  return { creadas, folios };
}

module.exports = {
  normalizarTexto_,
  partesEnNombre_,
  categoriaPorNombre_,
  planearImportacion_,
  leerExcelContpaq_,
  aplicarImportacion_,
  REGLAS_CATEGORIA,
};
