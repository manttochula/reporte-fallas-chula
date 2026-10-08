// Generador del "Reporte en PDF" de órdenes — botón del Panel junto a
// "Exportar a Excel" (ver Panel.html: btn-export-pdf). A diferencia del
// Excel (que solo da formato a filas/columnas), este reporte necesita
// además: 1) las piezas/refacciones ya CONFIRMADAS de cada orden
// (reportes_refacciones_necesarias, mandadas ya armadas por el cliente —
// ver getRefaccionesNecesarias en handlers.js) y 2) la foto original del
// reportante (columna foto_url / FotoURL). El cliente ya arma y filtra los
// datos generales (igual que para Excel); aquí solo se necesita leer la
// imagen (usa el mismo convenio "VID:" que el resto del sistema para saber
// cuándo NO es una imagen; el contenido se lee vía server/storage.js, que
// sabe traerla de disco local o de la nube según cómo esté configurado) y
// darle formato al documento.
//
// Las imágenes se piden TODAS de antemano (antes de dibujar nada), con
// Promise.all — así, si están en la nube (una petición por red a R2 en vez
// de una lectura de disco instantánea), no se hace una por una y en medio
// del dibujado del PDF, que sería mucho más lento con varias órdenes.
//
// Diseño COMPACTO (pedido por Carlos después de ver la primera versión, que
// ponía una orden por página con mucho espacio en blanco): varias órdenes
// seguidas en la misma página, separadas por una línea delgada, con los
// campos cortos en pareja (2 por línea) y la foto en miniatura — solo se
// pasa a una página nueva cuando de verdad ya no cabe la siguiente orden.
const PDFDocument = require('pdfkit');
const { leerArchivoComoBuffer_ } = require('./storage');

// Mismo acento ámbar que usa el resto del sistema (Panel.html / excelExport.js).
const COLOR_AMBER = '#E8871E';
const COLOR_AMBER_SUAVE = '#FBE7CE';
const COLOR_TEXTO = '#1C1E1F';
const COLOR_TEXTO_SUAVE = '#6B6B6B';
const COLOR_BORDE = '#D9D9D9';
const COLOR_FILA_PAR = '#F7F7F7';

const MARGEN = 40;
const ALTO_BARRA = 18;
// Más chica que antes: con menos campos de texto (se quitaron Atendió,
// Fecha salida, Refaccionamiento y Visto bueno) el bloque de la izquierda
// quedó más corto, así que una miniatura grande dejaba un hueco en blanco
// antes de la Descripción/Piezas.
const ANCHO_FOTO = 72;
const ALTO_FOTO = 55;

function formatearFecha_(valor) {
  if (!valor) return '—';
  const d = new Date(valor);
  if (isNaN(d.getTime())) return String(valor);
  return d.toLocaleDateString('es-MX');
}

function formatearValor_(v) {
  return v == null || v === '' ? '—' : String(v);
}

// Junta, en un solo Map (fotoUrl -> Buffer), el contenido de todas las
// fotos de un lote de órdenes que de verdad son imágenes (nunca intenta
// traer un video). Se usa ANTES de dibujar el PDF, para no mezclar
// lecturas asíncronas (red, si las fotos viven en la nube) con el dibujado
// del documento, que es síncrono.
async function precargarImagenesOrdenes_(ordenes) {
  const mapa = new Map();
  await Promise.all(
    ordenes.map(async (orden) => {
      const fotoUrl = orden.fotoUrl;
      if (!fotoUrl || fotoUrl.startsWith('VID:') || fotoUrl.startsWith('AUD:') || mapa.has(fotoUrl)) return;
      const buffer = await leerArchivoComoBuffer_(fotoUrl);
      if (buffer) mapa.set(fotoUrl, buffer);
    })
  );
  return mapa;
}

// Asegura que quede suficiente espacio vertical antes de dibujar el
// siguiente bloque; si no cabe, agrega una página nueva. pdfkit no hace
// esto solo (no hay "salto de página automático" al escribir texto que
// respete coordenadas explícitas — ver la nota grande más abajo, junto a
// la numeración de páginas, sobre el bug que causó esto originalmente).
function asegurarEspacio_(doc, alturaNecesaria) {
  const limite = doc.page.height - doc.page.margins.bottom;
  if (doc.y + alturaNecesaria > limite) {
    doc.addPage();
  }
}

// Una sola fila con 1 o 2 campos "Etiqueta: valor" (para compactar: la
// mayoría de los campos son cortos y caben dos por línea). Todo con texto
// que fluye normal (sin x/y explícitos), para que pdfkit haga solo el wrap
// y el salto de página si hiciera falta — más seguro que calcular
// coordenadas a mano (ver fila_ vieja en el historial de este archivo, que
// sí las calculaba y causó bugs de texto encimado).
function filaCampos_(doc, l1, v1, l2, v2) {
  asegurarEspacio_(doc, 11);
  doc.x = MARGEN;
  doc.font('Helvetica-Bold').fontSize(8).fillColor(COLOR_TEXTO_SUAVE).text(l1 + ': ', { continued: true });
  doc.font('Helvetica').fontSize(8).fillColor(COLOR_TEXTO).text(formatearValor_(v1) + (l2 ? '      ' : ''), { continued: !!l2 });
  if (l2) {
    doc.font('Helvetica-Bold').fontSize(8).fillColor(COLOR_TEXTO_SUAVE).text(l2 + ': ', { continued: true });
    doc.font('Helvetica').fontSize(8).fillColor(COLOR_TEXTO).text(formatearValor_(v2));
  }
  doc.moveDown(0.15);
}

// Campo largo (Descripción, Trabajo realizado, Comentario) — uno por línea,
// puede hacer wrap a varias líneas.
function filaLarga_(doc, etiqueta, valor) {
  if (!valor) return;
  asegurarEspacio_(doc, 11);
  doc.x = MARGEN;
  doc.font('Helvetica-Bold').fontSize(8).fillColor(COLOR_TEXTO_SUAVE).text(etiqueta + ': ', { continued: true });
  doc.font('Helvetica').fontSize(8).fillColor(COLOR_TEXTO).text(String(valor));
  doc.moveDown(0.15);
}

function renderizarOrden_(doc, orden, esPrimera, etiquetaUbicacion, mapaImagenes) {
  const anchoUtil = doc.page.width - MARGEN * 2;

  // Antes de empezar una orden nueva, nos aseguramos de que quepa al menos
  // el encabezado + un par de líneas — si no, mejor que la orden completa
  // empiece en la siguiente página, en vez de partirla justo después del
  // encabezado.
  asegurarEspacio_(doc, 90);

  if (!esPrimera) {
    doc.moveDown(0.35);
    doc.moveTo(MARGEN, doc.y).lineTo(doc.page.width - MARGEN, doc.y).strokeColor(COLOR_BORDE).lineWidth(0.5).stroke();
    doc.moveDown(0.35);
  }

  // --- Encabezado de la orden ---
  // Ojo: dibujar el rectángulo (rect().fill()) NO mueve doc.y — por eso se
  // guarda yBarra ANTES y se usa esa misma coordenada para posicionar el
  // texto encima, en vez de encadenar doc.y.
  const yBarra = doc.y;
  doc.rect(MARGEN, yBarra, anchoUtil, ALTO_BARRA).fill(COLOR_AMBER);
  doc
    .fillColor('#FFFFFF').font('Helvetica-Bold').fontSize(10)
    .text((orden.orden || '(sin folio)') + '   ·   ' + (orden.unidad || ''), MARGEN + 8, yBarra + 4.5, { width: anchoUtil - 140, lineBreak: false });
  doc
    .fillColor('#FFFFFF').font('Helvetica-Bold').fontSize(9)
    .text(orden.estatus || '', MARGEN, yBarra + 5, { width: anchoUtil - 8, align: 'right', lineBreak: false });
  doc.x = MARGEN;
  doc.y = yBarra + ALTO_BARRA + 6;
  doc.fillColor(COLOR_TEXTO);

  // --- Foto en miniatura, pegada arriba a la derecha (si hay) --- el resto
  // del contenido usa el ancho completo por debajo/izquierda; como la
  // miniatura es chica (95x72) casi nunca estorba con las 4-5 líneas de
  // campos cortos que van junto a ella.
  const yInicioContenido = doc.y;
  let notaFoto = null;
  const bufferImagen = orden.fotoUrl ? mapaImagenes.get(orden.fotoUrl) : null;
  if (bufferImagen) {
    try {
      doc.image(bufferImagen, MARGEN + anchoUtil - ANCHO_FOTO, yInicioContenido, { fit: [ANCHO_FOTO, ALTO_FOTO] });
    } catch (err) {
      notaFoto = 'No se pudo cargar la imagen.';
    }
  } else if (orden.fotoUrl && orden.fotoUrl.startsWith('VID:')) {
    notaFoto = 'El reportante adjuntó un video (ver desde el Panel).';
  } else {
    notaFoto = 'Sin foto del reportante.';
  }

  // --- Datos generales (2 columnas cortas + los largos aparte) ---
  // Pedido por Carlos: quitar Atendió, Fecha salida, Refaccionamiento y
  // Visto bueno del reporte (no los necesita aquí).
  filaCampos_(doc, etiquetaUbicacion || 'Huerta', orden.huerta, 'Reportó', orden.reporto);
  filaCampos_(doc, 'Fecha reporte', formatearFecha_(orden.fecha), 'Fecha atención', orden.fechaAtencion ? formatearFecha_(orden.fechaAtencion) : '—');
  filaLarga_(doc, 'Descripción', orden.descripcion);
  filaLarga_(doc, 'Trabajo realizado', orden.trabajoRealizado);
  filaLarga_(doc, 'Comentario reportante', orden.comentario);

  // Si la miniatura es más alta que el bloque de campos que acabamos de
  // escribir (orden con pocos datos), bajamos doc.y para no encimar lo que
  // sigue con la foto.
  if (bufferImagen || notaFoto) {
    const yMinDespuesFoto = yInicioContenido + (bufferImagen ? ALTO_FOTO : 10) + 4;
    if (doc.y < yMinDespuesFoto) doc.y = yMinDespuesFoto;
  }
  if (notaFoto) {
    doc.x = MARGEN;
    doc.font('Helvetica-Oblique').fontSize(7.5).fillColor(COLOR_TEXTO_SUAVE).text(notaFoto);
    doc.fillColor(COLOR_TEXTO);
  }

  // --- Piezas / refacciones desglosadas ---
  const piezas = Array.isArray(orden.piezas) ? orden.piezas : [];
  doc.x = MARGEN;
  doc.font('Helvetica-Bold').fontSize(8).fillColor(COLOR_AMBER).text('Piezas: ', { continued: piezas.length > 0 });
  if (piezas.length === 0) {
    doc.font('Helvetica-Oblique').fontSize(8).fillColor(COLOR_TEXTO_SUAVE).text('sin piezas registradas.');
  } else {
    // En una sola línea (o las que hagan falta con wrap), separadas por
    // punto y coma — más compacto que una fila por pieza cuando son pocas;
    // si son muchas, pdfkit hace wrap solo.
    const texto = piezas.map((p) => (p.texto || '(sin descripción)') + ' x' + (p.cantidad == null ? '1' : p.cantidad)).join('  ·  ');
    doc.font('Helvetica').fontSize(8).fillColor(COLOR_TEXTO).text(texto);
  }
  doc.fillColor(COLOR_TEXTO);
  doc.moveDown(0.1);
}

async function construirPdfOrdenes({ titulo, subtitulo, ordenes, etiquetaUbicacion }) {
  // Se traen todas las fotos de antemano (puede implicar red, si viven en
  // la nube) para que el dibujado del PDF de abajo sea puramente síncrono.
  const mapaImagenes = await precargarImagenesOrdenes_(ordenes);

  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({ size: 'letter', margin: MARGEN, bufferPages: true });
      const chunks = [];
      doc.on('data', (chunk) => chunks.push(chunk));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      // --- Encabezado del reporte (compacto, no ocupa una página aparte) ---
      doc.font('Helvetica-Bold').fontSize(15).fillColor(COLOR_TEXTO).text(titulo || 'Reporte de Órdenes');
      doc.font('Helvetica').fontSize(8.5).fillColor(COLOR_TEXTO_SUAVE).text(subtitulo || '');
      doc.moveDown(0.4);
      doc.x = MARGEN;
      doc.moveTo(MARGEN, doc.y).lineTo(doc.page.width - MARGEN, doc.y).strokeColor(COLOR_BORDE).stroke();
      doc.moveDown(0.5);

      ordenes.forEach((orden, i) => {
        renderizarOrden_(doc, orden, i === 0, etiquetaUbicacion, mapaImagenes);
      });

      // Ojo: escribir tan cerca del borde inferior de la página cae FUERA del
      // área "escribible" que define el margen inferior — pdfkit interpreta
      // eso como que el texto no cabe y agrega una página en blanco extra
      // para "continuarlo" ahí. Bajar el margen inferior a 0 momentáneamente
      // evita ese salto de página automático.
      const totalPaginas = doc.bufferedPageRange().count;
      for (let i = 0; i < totalPaginas; i++) {
        doc.switchToPage(i);
        doc.page.margins.bottom = 0;
        doc
          .font('Helvetica').fontSize(7.5).fillColor(COLOR_TEXTO_SUAVE)
          .text('Página ' + (i + 1) + ' de ' + totalPaginas, MARGEN, doc.page.height - 22, {
            width: doc.page.width - MARGEN * 2,
            align: 'center',
            lineBreak: false,
          });
      }

      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}

// ---------------------------------------------------------------
// Reporte "simple" en PDF, agrupado por secciones (una tabla por sección)
// — pensado para mandarse a un grupo (WhatsApp/correo) donde estén los
// encargados de campo, por ejemplo "qué órdenes están en proceso en cada
// huerta". A diferencia de construirPdfOrdenes (una orden por bloque, con
// foto y piezas), aquí cada sección es una TABLA compacta de filas cortas
// — mismo criterio visual (barra ámbar, bordes, Helvetica) pero mucho más
// ligero, para que sea fácil de leer de un vistazo en el celular.
//
// secciones: [{ titulo, columnas: [{header,key,width}], filas: [{key:valor,...}], mensajeVacio? }]
// `width` es un peso relativo (igual que en excelExport.js) — se reparte
// proporcionalmente el ancho útil de la página entre las columnas de cada
// sección.
const ALTO_BARRA_SECCION = 16;
const ALTO_FILA_MIN = 14;
const PAD_CELDA = 3;

function anchosColumnas_(columnas, anchoUtil) {
  const pesoTotal = columnas.reduce((s, c) => s + (Number(c.width) || 10), 0) || 1;
  return columnas.map((c) => ((Number(c.width) || 10) / pesoTotal) * anchoUtil);
}

function dibujarEncabezadoTabla_(doc, columnas, anchos, xInicio) {
  asegurarEspacio_(doc, ALTO_FILA_MIN + 4);
  const y = doc.y;
  let x = xInicio;
  columnas.forEach((col, i) => {
    doc
      .font('Helvetica-Bold').fontSize(7.5).fillColor(COLOR_TEXTO_SUAVE)
      .text(col.header || '', x + PAD_CELDA, y + 2, { width: anchos[i] - PAD_CELDA * 2, lineBreak: false });
    x += anchos[i];
  });
  doc.y = y + ALTO_FILA_MIN;
  doc.x = xInicio;
  doc.moveTo(xInicio, doc.y).lineTo(xInicio + anchos.reduce((s, a) => s + a, 0), doc.y).strokeColor(COLOR_BORDE).lineWidth(0.75).stroke();
  doc.moveDown(0.1);
}

function dibujarFilaTabla_(doc, columnas, anchos, xInicio, fila, esPar) {
  // Alto real de la fila: el máximo que necesite cualquier columna al
  // envolver su texto con el ancho que le toca (normalmente la columna de
  // descripción es la que manda).
  const alturas = columnas.map((col, i) => doc.font('Helvetica').fontSize(8).heightOfString(formatearValor_(fila[col.key]), { width: anchos[i] - PAD_CELDA * 2 }));
  const altoFila = Math.max(ALTO_FILA_MIN, Math.max.apply(null, alturas) + PAD_CELDA);

  asegurarEspacio_(doc, altoFila + 2);
  const y = doc.y;
  const anchoTotal = anchos.reduce((s, a) => s + a, 0);
  if (esPar) {
    doc.rect(xInicio, y, anchoTotal, altoFila).fill(COLOR_FILA_PAR);
  }
  let x = xInicio;
  columnas.forEach((col, i) => {
    doc
      .font('Helvetica').fontSize(8).fillColor(COLOR_TEXTO)
      .text(formatearValor_(fila[col.key]), x + PAD_CELDA, y + 2, { width: anchos[i] - PAD_CELDA * 2 });
    x += anchos[i];
  });
  doc.x = xInicio;
  doc.y = y + altoFila;
  doc.moveTo(xInicio, doc.y).lineTo(xInicio + anchoTotal, doc.y).strokeColor(COLOR_BORDE).lineWidth(0.5).stroke();
  doc.moveDown(0.1);
}

function dibujarSeccion_(doc, seccion) {
  const anchoUtil = doc.page.width - MARGEN * 2;
  asegurarEspacio_(doc, ALTO_BARRA_SECCION + ALTO_FILA_MIN + 10);

  const yBarra = doc.y;
  doc.rect(MARGEN, yBarra, anchoUtil, ALTO_BARRA_SECCION).fill(COLOR_AMBER);
  const totalFilas = Array.isArray(seccion.filas) ? seccion.filas.length : 0;
  doc
    .fillColor('#FFFFFF').font('Helvetica-Bold').fontSize(9.5)
    .text(seccion.titulo || '', MARGEN + 8, yBarra + 3, { width: anchoUtil - 90, lineBreak: false });
  doc
    .fillColor('#FFFFFF').font('Helvetica').fontSize(8)
    .text(totalFilas + (totalFilas === 1 ? ' pendiente' : ' pendientes'), MARGEN, yBarra + 3.5, { width: anchoUtil - 8, align: 'right', lineBreak: false });
  doc.x = MARGEN;
  doc.y = yBarra + ALTO_BARRA_SECCION + 5;
  doc.fillColor(COLOR_TEXTO);

  const columnas = seccion.columnas || [];
  const anchos = anchosColumnas_(columnas, anchoUtil);

  if (totalFilas === 0) {
    doc.font('Helvetica-Oblique').fontSize(8.5).fillColor(COLOR_TEXTO_SUAVE).text(seccion.mensajeVacio || 'Sin pendientes.');
    doc.fillColor(COLOR_TEXTO);
    doc.moveDown(0.3);
    return;
  }

  dibujarEncabezadoTabla_(doc, columnas, anchos, MARGEN);
  seccion.filas.forEach((fila, idx) => {
    dibujarFilaTabla_(doc, columnas, anchos, MARGEN, fila, idx % 2 === 1);
  });
  doc.moveDown(0.3);
}

async function construirPdfReporteSimple({ titulo, subtitulo, secciones }) {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({ size: 'letter', margin: MARGEN, bufferPages: true });
      const chunks = [];
      doc.on('data', (chunk) => chunks.push(chunk));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      doc.font('Helvetica-Bold').fontSize(15).fillColor(COLOR_TEXTO).text(titulo || 'Reporte');
      doc.font('Helvetica').fontSize(8.5).fillColor(COLOR_TEXTO_SUAVE).text(subtitulo || '');
      doc.moveDown(0.4);
      doc.x = MARGEN;
      doc.moveTo(MARGEN, doc.y).lineTo(doc.page.width - MARGEN, doc.y).strokeColor(COLOR_BORDE).stroke();
      doc.moveDown(0.5);

      (secciones || []).forEach((seccion) => dibujarSeccion_(doc, seccion));

      const totalPaginas = doc.bufferedPageRange().count;
      for (let i = 0; i < totalPaginas; i++) {
        doc.switchToPage(i);
        doc.page.margins.bottom = 0;
        doc
          .font('Helvetica').fontSize(7.5).fillColor(COLOR_TEXTO_SUAVE)
          .text('Página ' + (i + 1) + ' de ' + totalPaginas, MARGEN, doc.page.height - 22, {
            width: doc.page.width - MARGEN * 2,
            align: 'center',
            lineBreak: false,
          });
      }

      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}

module.exports = { construirPdfOrdenes, construirPdfReporteSimple };
