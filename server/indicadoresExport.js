// PDF y Excel de la pestaña INDICADORES con el MISMO diseño que se ve en el
// Panel (petición de Carlos, oct-2026: "genérame el PDF y el Excel justo
// como se ve en el panel"): fondo oscuro, tarjetas, tablas claras con
// encabezado verde grisáceo, barras de % de colores (≥90 verde, ≥70 ámbar,
// menos rojo), chip "en curso", encabezados oscuros por tipo de orden con su
// resumen en ámbar y resultados como "píldoras" de color.
//
// Recibe un "modelo" ya armado por el Panel (indModeloExportacion_ en
// public/Panel.html) -- aquí solo se dibuja, no se consulta la base.
//
// Tipografías del Panel (Oswald, Inter, IBM Plex Mono -- licencia SIL Open
// Font License, ver server/fonts/OFL-*.txt) incluidas en server/fonts para
// que el PDF se vea igual en cualquier computadora.
const path = require('path');
const PDFDocument = require('pdfkit');
const ExcelJS = require('exceljs');

const C = {
  fondo: '#1C1E1F',
  tarjeta: '#26292B',
  linea: '#3A3D3F',
  texto: '#EDECE7',
  textoDim: '#9A9D9E',
  ambar: '#E8871E',
  tablaFondo: '#FFFFFF',
  tablaTexto: '#1C1C1C',
  tablaEncabezado: '#E9EFEC',
  tablaBorde: '#EEEEEE',
  tablaBordeFuerte: '#DDDDDD',
  filaActiva: '#FFF4E5',
  filaTotal: '#F3F5F4',
  barraFondo: '#E5E7E6',
  ok: '#2E7D4F',
  medio: '#D98B1E',
  bajo: '#C0392B',
  gris: '#888888',
};
const RESULTADOS = {
  cumplida: { fondo: '#DCEFE2', texto: '#1E6B3E' },
  cerrada_antes: { fondo: '#E3EDF6', texto: '#2C5A80' },
  cerrada_despues: { fondo: '#FBEAD2', texto: '#8A5410' },
  pendiente: { fondo: '#F7DCD9', texto: '#8F2A20' },
};
const DIR_FUENTES = path.join(__dirname, 'fonts');
const FUENTES = {
  oswald: path.join(DIR_FUENTES, 'oswald-latin-600-normal.woff'),
  oswaldMedio: path.join(DIR_FUENTES, 'oswald-latin-500-normal.woff'),
  inter: path.join(DIR_FUENTES, 'inter-latin-400-normal.woff'),
  interSemi: path.join(DIR_FUENTES, 'inter-latin-600-normal.woff'),
  interBold: path.join(DIR_FUENTES, 'inter-latin-700-normal.woff'),
  mono: path.join(DIR_FUENTES, 'IBMPlexMono-SemiBold.woff'),
};

function colorPorcentaje(p) {
  if (p === null || p === undefined) return C.gris;
  if (p >= 90) return C.ok;
  if (p >= 70) return C.medio;
  return C.bajo;
}
function textoPorcentaje(p) {
  if (p === null || p === undefined) return 'Sin programadas';
  return (Math.round(p * 100) / 100).toString() + '%';
}
function v(x) { return (x === null || x === undefined) ? '' : String(x); }

// ------------------------------------------------------------------
// Columnas de las 3 tablas (mismas que en pantalla)
// ------------------------------------------------------------------
const COLS_SEMANAS = [
  { key: 'semana', header: 'Semana', w: 15, tipo: 'semana' },
  { key: 'fechas', header: 'Fechas', w: 19 },
  { key: 'programadas', header: 'Programadas', w: 9, tipo: 'num' },
  { key: 'cumplidas', header: 'Cumplidas en la semana', w: 11, tipo: 'num' },
  { key: 'porcentaje', header: '% Cumplimiento', w: 17, tipo: 'pct' },
  { key: 'antes', header: 'Cerradas antes', sub: 'fuera de programación', w: 11, tipo: 'num' },
  { key: 'despues', header: 'Cerradas después', w: 9, tipo: 'num' },
  { key: 'pendientes', header: 'Sin cerrar', w: 8, tipo: 'num' },
  { key: 'reprogramadas', header: 'Reprogramadas', w: 11, tipo: 'num' },
];
const COLS_TIPOS = [
  { key: 'nombre', header: 'Tipo de orden', w: 20 },
  { key: 'programadas', header: 'Programadas', w: 10, tipo: 'num' },
  { key: 'cumplidas', header: 'Cumplidas', w: 10, tipo: 'num' },
  { key: 'porcentaje', header: '% Cumplimiento', w: 20, tipo: 'pct' },
  { key: 'antes', header: 'Cerradas antes', w: 11, tipo: 'num' },
  { key: 'despues', header: 'Cerradas después', w: 11, tipo: 'num' },
  { key: 'pendientes', header: 'Sin cerrar', w: 9, tipo: 'num' },
];
const COLS_ORDENES = [
  { key: 'orden', header: 'Orden', w: 9, tipo: 'folio' },
  { key: 'unidad', header: 'Unidad', w: 14, tipo: 'wrap' },
  { key: 'huerta', header: 'Huerta', w: 11, tipo: 'wrap' },
  { key: 'descripcion', header: 'Descripción', w: 24, tipo: 'wrap', xspan: 2 },
  { key: 'programada', header: 'Programada', w: 11, tipo: 'wrap' },
  { key: 'salida', header: 'Fecha de salida', w: 9 },
  { key: 'resultado', header: 'Resultado', w: 22, tipo: 'resultado', xspan: 2 },
];

// ==================================================================
// PDF
// ==================================================================
const PAG = { margen: 26, pie: 22 };
const PAD_TARJETA = 12;
const ALTO_TITULO_TARJETA = 24;
const PAD_CELDA_X = 6;

function anchos_(columnas, total) {
  const peso = columnas.reduce((s, c) => s + c.w, 0);
  return columnas.map((c) => (c.w / peso) * total);
}

function altoEncabezado_(doc, columnas, anchos) {
  let max = 0;
  columnas.forEach((c, i) => {
    doc.font('mono').fontSize(6.6);
    let h = doc.heightOfString(c.header.toUpperCase(), { width: anchos[i] - PAD_CELDA_X * 2, characterSpacing: 0.3 });
    if (c.sub) { doc.font('inter').fontSize(6); h += doc.heightOfString(c.sub, { width: anchos[i] - PAD_CELDA_X * 2 }); }
    max = Math.max(max, h);
  });
  return Math.max(22, max + 12);
}

function altoFila_(doc, fila, columnas, anchos) {
  if (fila.__grupo) return 22;
  let max = 0;
  columnas.forEach((c, i) => {
    const ancho = anchos[i] - PAD_CELDA_X * 2;
    if (c.tipo === 'wrap') {
      doc.font('inter').fontSize(8);
      max = Math.max(max, doc.heightOfString(v(fila[c.key]) || '—', { width: ancho }));
    } else if (c.tipo === 'resultado' && fila.repro) {
      max = Math.max(max, 13 + 11);
    }
  });
  return Math.max(21, max + 10);
}

function dibujarEncabezadoTabla_(doc, x, y, columnas, anchos, alto, anchoTabla) {
  doc.save();
  doc.rect(x, y, anchoTabla, alto).fill(C.tablaEncabezado);
  doc.restore();
  let cx = x;
  columnas.forEach((c, i) => {
    const ancho = anchos[i] - PAD_CELDA_X * 2;
    const alinear = (c.tipo === 'num') ? 'right' : 'left';
    doc.font('mono').fontSize(6.6).fillColor(C.tablaTexto)
      .text(c.header.toUpperCase(), cx + PAD_CELDA_X, y + 7, { width: ancho, align: alinear, characterSpacing: 0.3 });
    if (c.sub) {
      doc.font('inter').fontSize(6).fillColor('#666666').text(c.sub, cx + PAD_CELDA_X, doc.y, { width: ancho, align: alinear });
    }
    cx += anchos[i];
  });
  doc.moveTo(x, y + alto).lineTo(x + anchoTabla, y + alto).lineWidth(0.6).strokeColor(C.tablaBordeFuerte).stroke();
}

function dibujarBarra_(doc, x, y, anchoCelda, p) {
  const anchoTexto = 38;
  if (p === null || p === undefined) {
    doc.font('inter').fontSize(8).fillColor(C.gris).text('Sin programadas', x, y + 6, { width: anchoCelda, lineBreak: false });
    return;
  }
  const anchoBarra = Math.max(20, anchoCelda - anchoTexto - 6);
  const yb = y + 7.5;
  doc.save();
  doc.roundedRect(x, yb, anchoBarra, 5, 2.5).fill(C.barraFondo);
  const lleno = Math.max(0, Math.min(1, p / 100)) * anchoBarra;
  if (lleno > 0) doc.roundedRect(x, yb, Math.max(lleno, 5), 5, 2.5).fill(colorPorcentaje(p));
  doc.restore();
  doc.font('interSemi').fontSize(8.5).fillColor(C.tablaTexto)
    .text(textoPorcentaje(p), x + anchoBarra + 4, y + 5.5, { width: anchoTexto, align: 'right', lineBreak: false });
}

function dibujarPildora_(doc, x, y, texto, colores, anchoMax) {
  // Si el texto no cabe, se achica la letra (nunca se parte en 2 renglones).
  let tam = 7.2;
  doc.font('interSemi').fontSize(tam);
  while (tam > 5.4 && doc.widthOfString(texto) + 12 > anchoMax) { tam -= 0.3; doc.fontSize(tam); }
  const ancho = Math.min(anchoMax, doc.widthOfString(texto) + 12);
  doc.save();
  doc.roundedRect(x, y, ancho, 12, 6).fill(colores.fondo);
  doc.restore();
  doc.fillColor(colores.texto).text(texto, x + 6, y + 2.6 + (7.2 - tam) / 2, { width: ancho - 8, lineBreak: false });
}

function dibujarFila_(doc, x, y, fila, columnas, anchos, alto, anchoTabla) {
  if (fila.__grupo) {
    doc.save();
    doc.rect(x, y, anchoTabla, alto).fill(C.tarjeta);
    doc.restore();
    doc.font('oswald').fontSize(9.5).fillColor(C.texto).text(fila.nombre.toUpperCase(), x + PAD_CELDA_X + 2, y + 5, { lineBreak: false, characterSpacing: 0.6, continued: false });
    const anchoNombre = doc.widthOfString(fila.nombre.toUpperCase(), { characterSpacing: 0.6 });
    doc.font('inter').fontSize(8).fillColor(C.ambar).text(fila.resumen || '', x + PAD_CELDA_X + 2 + anchoNombre + 10, y + 7, { lineBreak: false });
    return;
  }
  if (fila.__total || fila.__activa) {
    doc.save();
    doc.rect(x, y, anchoTabla, alto).fill(fila.__total ? C.filaTotal : C.filaActiva);
    doc.restore();
  }
  let cx = x;
  columnas.forEach((c, i) => {
    const ancho = anchos[i] - PAD_CELDA_X * 2;
    const valor = fila[c.key];
    const tx = cx + PAD_CELDA_X;
    const negrita = !!fila.__total;
    if (c.tipo === 'pct') {
      dibujarBarra_(doc, tx, y, ancho, valor);
    } else if (c.tipo === 'num') {
      doc.font(negrita ? 'interBold' : 'inter').fontSize(8.5).fillColor(C.tablaTexto).text(v(valor), tx, y + 6, { width: ancho, align: 'right', lineBreak: false });
    } else if (c.tipo === 'semana') {
      doc.font('interBold').fontSize(8.5).fillColor(C.tablaTexto).text(v(valor), tx, y + 6, { lineBreak: false });
      if (fila.enCurso) {
        const wTexto = doc.widthOfString(v(valor));
        doc.font('interSemi').fontSize(6.6);
        const wChip = doc.widthOfString('en curso') + 10;
        doc.save();
        doc.roundedRect(tx + wTexto + 5, y + 5.5, wChip, 10, 5).fill(C.ambar);
        doc.restore();
        doc.fillColor(C.tablaTexto).text('en curso', tx + wTexto + 10, y + 7.2, { lineBreak: false });
      }
    } else if (c.tipo === 'folio') {
      doc.font('mono').fontSize(8).fillColor(C.tablaTexto).text(v(valor), tx, y + 6.3, { width: ancho, lineBreak: false });
    } else if (c.tipo === 'resultado') {
      const r = valor || {};
      dibujarPildora_(doc, tx, y + 4.5, r.texto || '', RESULTADOS[r.clase] || RESULTADOS.pendiente, ancho);
      if (fila.repro) doc.font('inter').fontSize(7).fillColor('#8A5410').text(fila.repro, tx, y + 18.5, { width: ancho, lineBreak: false });
    } else if (c.tipo === 'wrap') {
      doc.font('inter').fontSize(8).fillColor(C.tablaTexto).text(v(valor) || '—', tx, y + 6, { width: ancho });
    } else {
      doc.font(negrita ? 'interBold' : 'inter').fontSize(8.5).fillColor(C.tablaTexto).text(v(valor) || (fila.__total ? '' : '—'), tx, y + 6, { width: ancho, lineBreak: false, ellipsis: true });
    }
    cx += anchos[i];
  });
  doc.moveTo(x, y + alto).lineTo(x + anchoTabla, y + alto).lineWidth(0.5).strokeColor(C.tablaBorde).stroke();
}

function pintarFondoPagina_(doc) {
  doc.save();
  doc.rect(0, 0, doc.page.width, doc.page.height).fill(C.fondo);
  doc.restore();
}

// Dibuja una tarjeta con una o varias tablas, partiéndola en páginas si no
// cabe (en la página siguiente repite el título con "(continúa)" y el
// encabezado de la tabla).
function dibujarTarjeta_(doc, estado, tarjeta) {
  const x = PAG.margen;
  const anchoTarjeta = doc.page.width - PAG.margen * 2;
  const anchoTabla = anchoTarjeta - PAD_TARJETA * 2;
  const xTabla = x + PAD_TARJETA;
  // Partes a dibujar, en orden: [{tipo:'titulo'|'encabezado'|'fila'|'espacio', alto, tabla}]
  const tablas = tarjeta.tablas.map((t) => Object.assign({}, t, { anchos: anchos_(t.columnas, anchoTabla) }));
  const limiteY = () => doc.page.height - PAG.margen - PAG.pie;
  let primeraVez = true;
  let ti = 0; // tabla actual
  let fi = 0; // fila actual dentro de la tabla
  while (ti < tablas.length) {
    // ¿Cabe al menos el título + encabezado + 1 fila en esta página?
    const t0 = tablas[ti];
    const altoEnc0 = altoEncabezado_(doc, t0.columnas, t0.anchos);
    const altoFila0 = t0.filas.length ? altoFila_(doc, t0.filas[fi], t0.columnas, t0.anchos) : 22;
    if (estado.y + ALTO_TITULO_TARJETA + altoEnc0 + altoFila0 + PAD_TARJETA * 2 > limiteY()) {
      doc.addPage();
      pintarFondoPagina_(doc);
      estado.y = PAG.margen;
    }
    // Decide qué cabe en este pedazo de tarjeta.
    let y = estado.y + PAD_TARJETA + ALTO_TITULO_TARJETA;
    const pedazos = [];
    let tj = ti, fj = fi;
    while (tj < tablas.length) {
      const t = tablas[tj];
      const altoEnc = altoEncabezado_(doc, t.columnas, t.anchos);
      if (y + altoEnc + 22 > limiteY() - PAD_TARJETA) break;
      const pedazo = { tabla: t, desdeY: y, filas: [], altoEnc };
      y += altoEnc;
      // Si la tabla sigue de la página anterior a media agrupación, se repite
      // el encabezado del tipo de orden con "(continúa)".
      if (fj > 0 && t.filas[fj] && !t.filas[fj].__grupo) {
        let g = fj - 1;
        while (g >= 0 && !t.filas[g].__grupo) g--;
        if (g >= 0) {
          pedazo.filas.push({ fila: Object.assign({}, t.filas[g], { resumen: (t.filas[g].resumen || '') + '  (continúa)' }), alto: 22 });
          y += 22;
        }
      }
      if (!t.filas.length) {
        pedazo.vacio = true;
        y += 24;
      }
      while (fj < t.filas.length) {
        const h = altoFila_(doc, t.filas[fj], t.columnas, t.anchos);
        if (y + h > limiteY() - PAD_TARJETA) break;
        pedazo.filas.push({ fila: t.filas[fj], alto: h });
        y += h;
        fj++;
      }
      pedazo.hastaY = y;
      pedazos.push(pedazo);
      if (fj < t.filas.length) break; // no cupo toda la tabla: sigue en otra página
      tj++; fj = 0;
      y += 10; // espacio entre tablas
    }
    const finTarjeta = Math.max(...pedazos.map((p) => p.hastaY)) + PAD_TARJETA;
    // Fondo de la tarjeta
    doc.save();
    doc.roundedRect(x, estado.y, anchoTarjeta, finTarjeta - estado.y, 8).fillAndStroke(C.tarjeta, C.linea);
    doc.restore();
    // Título
    const titulo = (tarjeta.titulo || '').toUpperCase() + (primeraVez ? '' : '  (CONTINÚA)');
    doc.font('oswald').fontSize(11.5).fillColor(C.texto).text(titulo, x + PAD_TARJETA, estado.y + PAD_TARJETA - 1, { lineBreak: false, characterSpacing: 0.6 });
    if (tarjeta.sub && primeraVez) {
      const w = doc.widthOfString(titulo, { characterSpacing: 0.6 });
      doc.font('inter').fontSize(7.5).fillColor(C.textoDim).text(tarjeta.sub, x + PAD_TARJETA + w + 8, estado.y + PAD_TARJETA + 2.5, { lineBreak: false });
    }
    // Tablas
    pedazos.forEach((p) => {
      const t = p.tabla;
      doc.save();
      doc.roundedRect(xTabla, p.desdeY, anchoTabla, p.hastaY - p.desdeY, 6).fill(C.tablaFondo);
      doc.restore();
      dibujarEncabezadoTabla_(doc, xTabla, p.desdeY, t.columnas, t.anchos, p.altoEnc, anchoTabla);
      let yy = p.desdeY + p.altoEnc;
      if (p.vacio) {
        doc.font('inter').fontSize(8.5).fillColor('#777777').text(t.mensajeVacio || 'Sin datos.', xTabla, yy + 8, { width: anchoTabla, align: 'center' });
      }
      p.filas.forEach((f) => {
        dibujarFila_(doc, xTabla, yy, f.fila, t.columnas, t.anchos, f.alto, anchoTabla);
        yy += f.alto;
      });
    });
    estado.y = finTarjeta + 12;
    primeraVez = false;
    ti = tj; fi = fj;
    if (ti < tablas.length) {
      doc.addPage();
      pintarFondoPagina_(doc);
      estado.y = PAG.margen;
    }
  }
}

function filasSemanas_(modelo) {
  const filas = (modelo.semanas || []).map((s) => Object.assign({}, s, { __activa: !!s.activa }));
  if (modelo.total) filas.push(Object.assign({ semana: 'Total del rango', fechas: '' }, modelo.total, { __total: true, enCurso: false }));
  return filas;
}
function filasTipos_(detalle) {
  return (detalle.tipos || []).map((t) => Object.assign({}, t, { __total: !!t.esTotal }));
}
function filasOrdenes_(detalle) {
  const filas = [];
  (detalle.grupos || []).forEach((g) => {
    filas.push({ __grupo: true, nombre: g.nombre, resumen: g.resumen });
    (g.ordenes || []).forEach((o) => filas.push(o));
  });
  return filas;
}

async function construirPdfIndicadores(modelo) {
  modelo = modelo || {};
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({ size: 'letter', layout: 'landscape', margin: PAG.margen, bufferPages: true, autoFirstPage: true });
      Object.keys(FUENTES).forEach((k) => doc.registerFont(k, FUENTES[k]));
      const partes = [];
      doc.on('data', (c) => partes.push(c));
      doc.on('end', () => resolve(Buffer.concat(partes)));
      doc.on('error', reject);
      pintarFondoPagina_(doc);
      const anchoUtil = doc.page.width - PAG.margen * 2;
      // Encabezado como el del Panel
      doc.font('oswaldMedio').fontSize(8).fillColor(C.ambar).text('FLOTA & MANTENIMIENTO  ·  INDICADORES', PAG.margen, PAG.margen, { characterSpacing: 1.2 });
      doc.font('interBold').fontSize(18).fillColor(C.texto).text(modelo.titulo || 'Cumplimiento de programación semanal', PAG.margen, doc.y + 2);
      doc.font('inter').fontSize(8.3).fillColor(C.textoDim).text(modelo.ayuda || '', PAG.margen, doc.y + 3, { width: anchoUtil * 0.78, lineGap: 1.5 });
      // Filtros como "chips"
      let cx = PAG.margen;
      const yChips = doc.y + 7;
      (modelo.filtros || []).forEach((f) => {
        doc.font('mono').fontSize(6.6);
        const wEt = doc.widthOfString(f.etiqueta.toUpperCase(), { characterSpacing: 0.4 });
        doc.font('interSemi').fontSize(8);
        const wVal = doc.widthOfString(f.valor);
        const w = Math.max(wEt, wVal) + 18;
        doc.save();
        doc.roundedRect(cx, yChips, w, 26, 5).fillAndStroke(C.tarjeta, C.linea);
        doc.restore();
        doc.font('mono').fontSize(6.6).fillColor(C.textoDim).text(f.etiqueta.toUpperCase(), cx + 9, yChips + 4.5, { lineBreak: false, characterSpacing: 0.4 });
        doc.font('interSemi').fontSize(8).fillColor(C.texto).text(f.valor, cx + 9, yChips + 13.5, { lineBreak: false });
        cx += w + 8;
      });
      const estado = { y: yChips + 26 + 12 };

      dibujarTarjeta_(doc, estado, {
        titulo: 'Por semana', sub: '(de la más reciente a la más antigua)',
        tablas: [{ columnas: COLS_SEMANAS, filas: filasSemanas_(modelo), mensajeVacio: 'No hay semanas en ese rango.' }],
      });
      if (modelo.detalle) {
        dibujarTarjeta_(doc, estado, {
          titulo: modelo.detalle.titulo,
          tablas: [
            { columnas: COLS_TIPOS, filas: filasTipos_(modelo.detalle) },
            { columnas: COLS_ORDENES, filas: filasOrdenes_(modelo.detalle), mensajeVacio: 'No hay órdenes programadas de este tipo en esta semana.' },
          ],
        });
      }

      // Pie: generado y número de página
      const total = doc.bufferedPageRange().count;
      for (let i = 0; i < total; i++) {
        doc.switchToPage(i);
        doc.page.margins.bottom = 0;
        doc.font('inter').fontSize(7).fillColor(C.textoDim)
          .text(v(modelo.generado), PAG.margen, doc.page.height - 18, { width: anchoUtil / 2, lineBreak: false })
          .text('Página ' + (i + 1) + ' de ' + total, PAG.margen + anchoUtil / 2, doc.page.height - 18, { width: anchoUtil / 2, align: 'right', lineBreak: false });
      }
      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}

// ==================================================================
// EXCEL
// ==================================================================
const X = (hex) => 'FF' + hex.replace('#', '').toUpperCase();
const BORDE_FINO = { style: 'thin', color: { argb: X('#E2E4E3') } };

function barraTexto_(p) {
  if (p === null || p === undefined) return '';
  const llenos = Math.round(Math.max(0, Math.min(100, p)) / 10);
  return '█'.repeat(llenos) + '░'.repeat(10 - llenos);
}

function rellenar_(ws, fila, desde, hasta, color) {
  for (let c = desde; c <= hasta; c++) {
    ws.getCell(fila, c).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: X(color) } };
  }
}

// Columnas de Excel: la de % se vuelve 2 (barra de color + número).
function colsExcel_(cols) {
  const out = [];
  cols.forEach((c) => {
    if (c.tipo === 'pct') {
      out.push(Object.assign({}, c, { tipo: 'pctBarra', header: c.header }));
      out.push(Object.assign({}, c, { tipo: 'pctNum', header: '' }));
    } else out.push(c);
  });
  return out;
}

async function construirExcelIndicadores(modelo) {
  modelo = modelo || {};
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Reporte de Fallas';
  const ws = wb.addWorksheet('Indicadores', { views: [{ showGridLines: false }], pageSetup: { orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0, paperSize: 1 } });
  // Columna 1 y la última: margen oscuro. Las 3 tablas comparten las
  // columnas 2 a 11 (la más ancha, "Por semana", usa las 10).
  const NCOL = 11;
  // (en Órdenes, Descripción y Resultado ocupan 2 columnas cada una: ver xspan)
  ws.columns = [2, 17, 24, 17, 16, 18, 12, 15, 14, 13, 15, 2].map((w) => ({ width: w }));
  // Fondo oscuro en todo el ancho usado (como el Panel)
  let fila = 1;
  const filaOscura = (alto) => { rellenar_(ws, fila, 1, NCOL + 1, C.fondo); if (alto) ws.getRow(fila).height = alto; };
  filaOscura(8); fila++;
  filaOscura(16);
  ws.getCell(fila, 2).value = 'FLOTA & MANTENIMIENTO  ·  INDICADORES';
  ws.getCell(fila, 2).font = { name: 'Oswald', size: 9, bold: true, color: { argb: X(C.ambar) } };
  fila++;
  filaOscura(28);
  ws.getCell(fila, 2).value = modelo.titulo || 'Cumplimiento de programación semanal';
  ws.getCell(fila, 2).font = { name: 'Inter', size: 18, bold: true, color: { argb: X(C.texto) } };
  fila++;
  filaOscura(42);
  ws.mergeCells(fila, 2, fila, 8);
  ws.getCell(fila, 2).value = modelo.ayuda || '';
  ws.getCell(fila, 2).font = { name: 'Inter', size: 9, color: { argb: X(C.textoDim) } };
  ws.getCell(fila, 2).alignment = { wrapText: true, vertical: 'top' };
  fila++;
  filaOscura(20);
  // Filtros en una sola franja (como los selectores de arriba en el Panel)
  ws.mergeCells(fila, 2, fila, NCOL);
  const textoFiltros = [];
  (modelo.filtros || []).forEach((f, k) => {
    if (k) textoFiltros.push({ text: '      ', font: { name: 'Inter', size: 10 } });
    textoFiltros.push({ text: f.etiqueta.toUpperCase() + '  ', font: { name: 'IBM Plex Mono', size: 8, color: { argb: X(C.textoDim) } } });
    textoFiltros.push({ text: f.valor, font: { name: 'Inter', size: 10, bold: true, color: { argb: X(C.texto) } } });
  });
  ws.getCell(fila, 2).value = { richText: textoFiltros.length ? textoFiltros : [{ text: '' }] };
  ws.getCell(fila, 2).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: X(C.tarjeta) } };
  ws.getCell(fila, 2).alignment = { vertical: 'middle', indent: 1 };
  fila++;
  filaOscura(10); fila++;

  // Una "tarjeta": título oscuro + tabla clara
  const tarjeta = (titulo, sub, tablas) => {
    rellenar_(ws, fila, 1, NCOL + 1, C.fondo);
    rellenar_(ws, fila, 2, NCOL, C.tarjeta);
    ws.getRow(fila).height = 24;
    ws.getCell(fila, 2).value = { richText: [
      { text: titulo.toUpperCase(), font: { name: 'Oswald', size: 12, bold: true, color: { argb: X(C.texto) } } },
      { text: sub ? '   ' + sub : '', font: { name: 'Inter', size: 9, color: { argb: X(C.textoDim) } } },
    ] };
    ws.getCell(fila, 2).alignment = { vertical: 'middle' };
    fila++;
    tablas.forEach((t, k) => {
      const cols = colsExcel_(t.columnas);
      // Columna de la hoja donde empieza cada columna de la tabla (xspan = cuántas ocupa).
      const pos = [];
      let p0 = 2;
      cols.forEach((c) => { pos.push(p0); p0 += (c.xspan || 1); });
      const ultimaCol = p0 - 1;
      const unir = (f) => cols.forEach((c, i) => { if ((c.xspan || 1) > 1) ws.mergeCells(f, pos[i], f, pos[i] + c.xspan - 1); });
      // encabezado
      rellenar_(ws, fila, 1, NCOL + 1, C.fondo);
      rellenar_(ws, fila, 2, NCOL, C.tarjeta);
      ws.getRow(fila).height = 30;
      cols.forEach((c, i) => {
        const celda = ws.getCell(fila, pos[i]);
        celda.value = c.header ? (c.header.toUpperCase() + (c.sub ? '\n' + c.sub : '')) : '';
        celda.font = { name: 'IBM Plex Mono', size: 8, bold: true, color: { argb: X(C.tablaTexto) } };
        celda.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: X(C.tablaEncabezado) } };
        celda.alignment = { vertical: 'middle', wrapText: true, horizontal: c.tipo === 'num' ? 'right' : 'left' };
        celda.border = { bottom: { style: 'thin', color: { argb: X(C.tablaBordeFuerte) } } };
      });
      unir(fila);
      if (cols.some((c) => c.tipo === 'pctBarra')) {
        const i = cols.findIndex((c) => c.tipo === 'pctBarra');
        ws.mergeCells(fila, pos[i], fila, pos[i] + 1);
      }
      fila++;
      if (!t.filas.length) {
        rellenar_(ws, fila, 1, NCOL + 1, C.fondo);
        rellenar_(ws, fila, 2, NCOL, C.tarjeta);
        ws.mergeCells(fila, 2, fila, ultimaCol);
        ws.getCell(fila, 2).value = t.mensajeVacio || 'Sin datos.';
        ws.getCell(fila, 2).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: X(C.tablaFondo) } };
        ws.getCell(fila, 2).font = { name: 'Inter', size: 9, italic: true, color: { argb: 'FF777777' } };
        ws.getCell(fila, 2).alignment = { horizontal: 'center' };
        fila++;
      }
      t.filas.forEach((f) => {
        rellenar_(ws, fila, 1, NCOL + 1, C.fondo);
        rellenar_(ws, fila, 2, NCOL, C.tarjeta);
        if (f.__grupo) {
          ws.getRow(fila).height = 22;
          ws.mergeCells(fila, 2, fila, ultimaCol);
          const celda = ws.getCell(fila, 2);
          celda.value = { richText: [
            { text: f.nombre.toUpperCase() + '   ', font: { name: 'Oswald', size: 11, bold: true, color: { argb: X(C.texto) } } },
            { text: f.resumen || '', font: { name: 'Inter', size: 9, color: { argb: X(C.ambar) } } },
          ] };
          celda.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: X('#2F3234') } };
          celda.alignment = { vertical: 'middle' };
          fila++;
          return;
        }
        const fondo = f.__total ? C.filaTotal : (f.__activa ? C.filaActiva : C.tablaFondo);
        // Alto según lo largo de la descripción (~40 letras por renglón) o si trae "Reprogramada al...".
        const renglones = Math.max(f.repro ? 2 : 1, cols.some((c) => c.key === 'descripcion') ? Math.ceil(v(f.descripcion).length / 40) : 1);
        ws.getRow(fila).height = renglones > 1 ? 14 * renglones + 4 : 19;
        unir(fila);
        cols.forEach((c, i) => {
          const celda = ws.getCell(fila, pos[i]);
          celda.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: X(fondo) } };
          celda.border = { bottom: BORDE_FINO };
          celda.alignment = { vertical: 'middle', horizontal: c.tipo === 'num' ? 'right' : 'left', wrapText: c.key === 'descripcion' || (c.tipo === 'resultado' && !!f.repro) };
          const fuente = { name: 'Inter', size: 10, bold: !!f.__total, color: { argb: X(C.tablaTexto) } };
          const valor = f[c.key];
          if (c.tipo === 'num') {
            celda.value = (valor === null || valor === undefined || valor === '') ? null : Number(valor);
            celda.numFmt = '0';
            celda.font = fuente;
          } else if (c.tipo === 'pctBarra') {
            celda.value = valor === null || valor === undefined ? 'Sin programadas' : barraTexto_(valor);
            celda.font = valor === null || valor === undefined ? { name: 'Inter', size: 9, color: { argb: X(C.gris) } } : { name: 'Consolas', size: 9, color: { argb: X(colorPorcentaje(valor)) } };
          } else if (c.tipo === 'pctNum') {
            celda.value = (valor === null || valor === undefined) ? null : valor / 100;
            celda.numFmt = '0.##%';
            celda.font = Object.assign({}, fuente, { bold: true });
            celda.alignment = { vertical: 'middle', horizontal: 'right' };
          } else if (c.tipo === 'semana') {
            celda.value = f.enCurso
              ? { richText: [{ text: v(valor) + '  ', font: { name: 'Inter', size: 10, bold: true, color: { argb: X(C.tablaTexto) } } }, { text: ' en curso ', font: { name: 'Inter', size: 8, bold: true, color: { argb: X(C.ambar) } } }] }
              : v(valor);
            if (!f.enCurso) celda.font = Object.assign({}, fuente, { bold: true });
          } else if (c.tipo === 'folio') {
            celda.value = v(valor);
            celda.font = { name: 'IBM Plex Mono', size: 10, bold: true, color: { argb: X(C.tablaTexto) } };
          } else if (c.tipo === 'resultado') {
            const r = valor || {};
            const colores = RESULTADOS[r.clase] || RESULTADOS.pendiente;
            celda.value = f.repro
              ? { richText: [{ text: r.texto || '', font: { name: 'Inter', size: 9, bold: true, color: { argb: X(colores.texto) } } }, { text: '\n' + f.repro, font: { name: 'Inter', size: 8, color: { argb: X('#8A5410') } } }] }
              : (r.texto || '');
            if (!f.repro) celda.font = { name: 'Inter', size: 9, bold: true, color: { argb: X(colores.texto) } };
            celda.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: X(colores.fondo) } };
          } else {
            celda.value = v(valor) || (f.__total ? '' : '—');
            celda.font = fuente;
          }
        });
        fila++;
      });
      // margen inferior de la tarjeta
      rellenar_(ws, fila, 1, NCOL + 1, C.fondo);
      rellenar_(ws, fila, 2, NCOL, C.tarjeta);
      ws.getRow(fila).height = k < tablas.length - 1 ? 10 : 8;
      fila++;
    });
    filaOscura(12); fila++;
  };

  tarjeta('Por semana', '(de la más reciente a la más antigua)', [{ columnas: COLS_SEMANAS, filas: filasSemanas_(modelo), mensajeVacio: 'No hay semanas en ese rango.' }]);
  if (modelo.detalle) {
    tarjeta(modelo.detalle.titulo, '', [
      { columnas: COLS_TIPOS, filas: filasTipos_(modelo.detalle) },
      { columnas: COLS_ORDENES, filas: filasOrdenes_(modelo.detalle), mensajeVacio: 'No hay órdenes programadas de este tipo en esta semana.' },
    ]);
  }
  filaOscura(18);
  ws.getCell(fila, 2).value = v(modelo.generado);
  ws.getCell(fila, 2).font = { name: 'Inter', size: 8, color: { argb: X(C.textoDim) } };
  return wb.xlsx.writeBuffer();
}

module.exports = { construirPdfIndicadores, construirExcelIndicadores, barraTexto_, colorPorcentaje, textoPorcentaje };
