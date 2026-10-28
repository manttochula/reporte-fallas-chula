// ============================================================
// Orden de compra al proveedor + nota contable en su factura (oct-2026).
//
// Pedido de Carlos: al terminar de autorizar ("Aut") las piezas de un
// proveedor en una orden, mandarle una OC "semejante" a la de CONTPAQi
// (serie mtto, folio, datos de la empresa y del proveedor, partidas con
// Descripción = cuenta / Observaciones = no. de parte, segmento, subtotal,
// descuentos, IVA, total con letra, Datos de Facturación y Autoriza) junto
// con un enlace para que suba su factura (PDF + XML). Al PDF de esa factura
// se le agrega la nota contable (Nombre de la Cuenta, No. de Cuenta,
// Huerta, Segmento, Observaciones, Empresa a contabilizar, Firma, Total de
// piezas) en la PRIMERA hoja: se alarga la hoja hacia abajo y la nota va en
// esa franja nueva, así nunca tapa nada de la factura.
//
// Aquí solo va lo que no toca la base de datos (cálculos, PDF, CFDI) para
// poder probarlo por separado; ver server/handlers.js: generarOcProveedor,
// getOcPublica, subirFacturaOc.
// ============================================================
const PDFDocument = require('pdfkit');
const { PDFDocument: PdfLibDoc, StandardFonts, rgb } = require('pdf-lib');

const IVA_POR_OMISION = 16;

function r2_(n) { return Math.round((Number(n) || 0) * 100) / 100; }
function texto_(v) { return (v === null || v === undefined ? '' : String(v)).trim(); }

// items: [{ cantidad, precio (unitario sin IVA y SIN descuento), descuentoPct, ivaPct }]
// Regresa cada partida con su importe y los totales como en la OC de
// CONTPAQi: Subtotal (antes de descuento), Descuentos, IVA (sobre lo ya
// descontado) y Total. Si el proveedor no dio IVA se toma 16 %.
function calcularTotales(items) {
  let subtotal = 0, descuento = 0, iva = 0, piezas = 0;
  const partidas = (items || []).map((it) => {
    const cantidad = Number(it.cantidad) || 0;
    const precio = Number(it.precio) || 0;
    const descPct = it.descuentoPct === null || it.descuentoPct === undefined || it.descuentoPct === '' ? 0 : Number(it.descuentoPct) || 0;
    const ivaPct = it.ivaPct === null || it.ivaPct === undefined || it.ivaPct === '' ? IVA_POR_OMISION : Number(it.ivaPct);
    const importe = r2_(cantidad * precio);
    // Por partida y redondeado a centavos, igual que CONTPAQi (así el total
    // cuadra al centavo con la OC de Comercial).
    const desc = r2_(importe * descPct / 100);
    subtotal += importe;
    descuento += desc;
    iva += r2_((importe - desc) * ivaPct / 100);
    piezas += cantidad;
    return Object.assign({}, it, { cantidad, precio, descuentoPct: descPct, ivaPct, importe });
  });
  subtotal = r2_(subtotal); descuento = r2_(descuento); iva = r2_(iva);
  return { partidas, subtotal, descuento, iva, total: r2_(subtotal - descuento + iva), piezas: Math.round(piezas * 100) / 100 };
}

// --- Importe con letra (pesos mexicanos) ---
const UNIDADES_ = ['', 'un', 'dos', 'tres', 'cuatro', 'cinco', 'seis', 'siete', 'ocho', 'nueve', 'diez', 'once', 'doce', 'trece', 'catorce', 'quince',
  'dieciséis', 'diecisiete', 'dieciocho', 'diecinueve', 'veinte', 'veintiún', 'veintidós', 'veintitrés', 'veinticuatro', 'veinticinco', 'veintiséis',
  'veintisiete', 'veintiocho', 'veintinueve'];
const DECENAS_ = ['', '', '', 'treinta', 'cuarenta', 'cincuenta', 'sesenta', 'setenta', 'ochenta', 'noventa'];
const CENTENAS_ = ['', 'ciento', 'doscientos', 'trescientos', 'cuatrocientos', 'quinientos', 'seiscientos', 'setecientos', 'ochocientos', 'novecientos'];

function menorDeMil_(n) {
  if (n === 0) return '';
  if (n === 100) return 'cien';
  const c = Math.floor(n / 100);
  const resto = n % 100;
  let txt = CENTENAS_[c];
  let dec = '';
  if (resto < 30) dec = UNIDADES_[resto];
  else dec = DECENAS_[Math.floor(resto / 10)] + (resto % 10 ? ' y ' + UNIDADES_[resto % 10] : '');
  return (txt + ' ' + dec).trim();
}

function enteroALetras_(n) {
  if (n === 0) return 'cero';
  const partes = [];
  const millones = Math.floor(n / 1000000);
  const miles = Math.floor((n % 1000000) / 1000);
  const resto = n % 1000;
  if (millones) partes.push(millones === 1 ? 'un millón' : enteroALetras_(millones) + ' millones');
  if (miles) partes.push(miles === 1 ? 'mil' : menorDeMil_(miles) + ' mil');
  if (resto) partes.push(menorDeMil_(resto));
  return partes.join(' ');
}

// 1654.75 -> "mil seiscientos cincuenta y cuatro Pesos 75/100 M.N."
function importeConLetra(total) {
  const cent = Math.round((Number(total) || 0) * 100);
  const enteros = Math.floor(cent / 100);
  const centavos = cent % 100;
  let letras = enteroALetras_(enteros);
  if (/millón$|millones$/.test(letras)) letras += ' de';
  return letras + ' ' + (enteros === 1 ? 'Peso' : 'Pesos') + ' ' + String(centavos).padStart(2, '0') + '/100 M.N.';
}

const MESES_CORTOS_ = ['Ene', 'Feb', 'Mar', 'Abr', 'May', 'Jun', 'Jul', 'Ago', 'Sep', 'Oct', 'Nov', 'Dic'];
function fechaOc_(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(texto_(iso));
  if (!m) return texto_(iso);
  return m[3] + '/' + MESES_CORTOS_[Number(m[2]) - 1] + '/' + m[1];
}

function dinero_(n) {
  return (Number(n) || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// "AF-648-6603 JD" -> "AF-648" (como lo escriben en la nota).
function observacionDeUnidad(unidad, codigo) {
  const u = texto_(unidad).toUpperCase();
  const m = /^([A-Z]{1,5})\s*-\s*(\d{1,5})/.exec(u);
  if (m) return m[1] + '-' + m[2];
  return texto_(codigo) || u;
}

// ------------------------------------------------------------
// PDF de la OC (pdfkit, Helvetica). oc = {
//   serie, folio, fecha, orden, empresa: { nombre, siglas, rfc, razonSocial, domicilio, usoCfdi, autoriza },
//   proveedor: { nombre, rfc, domicilio, telefono, correo },
//   descripcionOc, segmento, observacion, partidas: [{ cantidad, observaciones, precio, importe }],
//   subtotal, descuento, iva, total, enlaceFactura }
// ------------------------------------------------------------
const AZUL = '#1E88E5';
const GRIS = '#555555';

function generarPdfOc(oc) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'LETTER', margin: 36, info: { Title: 'Orden de compra ' + oc.serie + ' ' + oc.folio } });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    const W = doc.page.width;
    const X = 36;
    const ANCHO = W - 72;
    const emp = oc.empresa || {};
    const prov = oc.proveedor || {};

    // Recuadro de folio (arriba a la derecha)
    const xf = W - 36 - 230;
    doc.rect(xf, 36, 230, 14).fill('#BDBDBD');
    doc.fillColor(AZUL).font('Helvetica-Bold').fontSize(10).text('Orden de Compra', xf, 39, { width: 230, align: 'center' });
    const fila = (et, val, y, negrita) => {
      doc.font('Helvetica').fontSize(9).fillColor(AZUL).text(et, xf, y, { width: 110, align: 'right' });
      doc.font(negrita ? 'Helvetica-Bold' : 'Helvetica').fontSize(negrita ? 12 : 9).fillColor('#000').text(val, xf + 118, y - (negrita ? 2 : 0), { width: 112, align: 'right' });
    };
    fila('Serie:', texto_(oc.serie), 54, false);
    fila('Folio:', String(oc.folio), 68, true);
    fila('Fecha:', fechaOc_(oc.fecha), 84, false);

    // Banda de la empresa
    const yb = 102;
    doc.rect(X, yb, ANCHO, 58).fill(AZUL);
    doc.fillColor('#fff').font('Helvetica').fontSize(14).text(texto_(emp.nombreCorto || emp.nombre).toUpperCase(), X + 8, yb + 6, { width: ANCHO / 2 - 10 });
    doc.fontSize(9).text(texto_(emp.rfc), X + 8, yb + 24);
    doc.fontSize(8).text(texto_(emp.domicilio), X + ANCHO / 2 + 20, yb + 6, { width: ANCHO / 2 - 28 });

    // Proveedor
    let y = yb + 66;
    const par = (et, val, xx, yy, ancho) => {
      doc.font('Helvetica').fontSize(8.5).fillColor(AZUL).text(et, xx, yy, { continued: false });
      doc.fillColor(GRIS).text(texto_(val), xx + 58, yy, { width: ancho });
    };
    par('Proveedor:', prov.nombre, X + 6, y, ANCHO - 70); y += 13;
    par('RFC:', prov.rfc, X + 6, y, 200); y += 13;
    par('Domicilio:', (prov.domicilio || '').replace(/\s*\n\s*/g, ', '), X + 6, y, ANCHO - 70);
    y = doc.y + 3;
    par('Teléfono:', prov.telefono, X + 6, y, 160);
    par('Correo:', prov.correo, X + 250, y, ANCHO - 320);
    y += 18;

    // Tabla de partidas
    const cols = [
      { t: 'Cantidad', w: 52, a: 'right' }, { t: 'Unidad', w: 46, a: 'left' }, { t: 'Descripción', w: 150, a: 'left' },
      { t: 'Observaciones', w: 130, a: 'left' }, { t: 'Segmento', w: 50, a: 'center' }, { t: 'Valor unitario', w: 56, a: 'right' }, { t: 'Importe', w: 56, a: 'right' },
    ];
    const totalW = cols.reduce((s, c) => s + c.w, 0);
    const esc = ANCHO / totalW;
    cols.forEach((c) => { c.w = c.w * esc; });
    let xx = X;
    doc.rect(X, y, ANCHO, 14).fill(AZUL);
    cols.forEach((c) => { doc.fillColor('#fff').font('Helvetica-Bold').fontSize(7.5).text(c.t, xx + 2, y + 3, { width: c.w - 4, align: c.a === 'right' ? 'right' : 'left' }); xx += c.w; });
    y += 14;
    (oc.partidas || []).forEach((p) => {
      const valores = [
        Number(p.cantidad).toFixed(2), 'PZA', texto_(oc.descripcionOc), texto_(p.observaciones), texto_(oc.segmento), dinero_(p.precio), dinero_(p.importe),
      ];
      doc.font('Helvetica').fontSize(8);
      const alto = Math.max(16, ...valores.map((v, i) => doc.heightOfString(v, { width: cols[i].w - 4 }) + 6));
      if (y + alto > doc.page.height - 230) { doc.addPage(); y = 36; }
      xx = X;
      valores.forEach((v, i) => {
        doc.rect(xx, y, cols[i].w, alto).strokeColor('#9E9E9E').lineWidth(0.5).stroke();
        doc.fillColor(i === 0 || i === 1 ? GRIS : '#000').text(v, xx + 2, y + 3, { width: cols[i].w - 4, align: cols[i].a });
        xx += cols[i].w;
      });
      y += alto;
    });

    // Totales + importe con letra + observación
    y += 10;
    const xt = X + ANCHO - 200;
    const tot = (et, val, negrita) => {
      doc.font('Helvetica').fontSize(9).fillColor(AZUL).text(et, xt, y, { width: 110, align: 'right' });
      doc.font(negrita ? 'Helvetica-Bold' : 'Helvetica').fillColor(negrita ? '#000' : GRIS).text(val, xt + 115, y, { width: 85, align: 'right' });
      y += 13;
    };
    const yIzq = y;
    tot('Subtotal:', dinero_(oc.subtotal));
    tot('Descuentos:', dinero_(oc.descuento));
    tot('I.V.A.:', dinero_(oc.iva));
    tot('Total:', '$' + dinero_(oc.total), true);
    const anchoIzq = ANCHO - 215;
    doc.rect(X, yIzq, anchoIzq, 12).fill(AZUL);
    doc.fillColor('#fff').font('Helvetica').fontSize(8.5).text('Importe con letra', X, yIzq + 2, { width: anchoIzq, align: 'center' });
    doc.rect(X, yIzq + 12, anchoIzq, 14).strokeColor('#9E9E9E').stroke();
    doc.fillColor(GRIS).fontSize(8.5).text(importeConLetra(oc.total), X + 4, yIzq + 15, { width: anchoIzq - 8, align: 'center' });
    const yObs = yIzq + 34;
    doc.rect(X, yObs, anchoIzq, 12).fill(AZUL);
    doc.fillColor('#fff').text('Observación:', X, yObs + 2, { width: anchoIzq, align: 'center' });
    doc.rect(X, yObs + 12, anchoIzq, 34).strokeColor('#9E9E9E').stroke();
    doc.fillColor(GRIS).fontSize(8.5).text(
      [texto_(oc.observacion), oc.orden ? 'Orden de trabajo: ' + oc.orden : ''].filter(Boolean).join('   ·   '),
      X + 4, yObs + 16, { width: anchoIzq - 8 }
    );
    y = Math.max(y, yObs + 50) + 16;

    // Datos de facturación + Atentamente
    doc.fillColor('#000').font('Helvetica-Bold').fontSize(9.5).text('Datos de Facturación:', X, y);
    doc.font('Helvetica').fontSize(9).text(
      [texto_(emp.razonSocial || emp.nombre), texto_(emp.domicilio), emp.rfc ? 'RFC: ' + emp.rfc : '', emp.usoCfdi ? 'Uso del CFDI: ' + emp.usoCfdi : ''].filter(Boolean).join('\n'),
      X, y + 13, { width: ANCHO / 2 }
    );
    const xa = X + ANCHO - 220;
    doc.moveTo(xa + 20, y + 40).lineTo(xa + 200, y + 40).lineWidth(2).strokeColor(AZUL).stroke();
    doc.fillColor(AZUL).font('Helvetica').fontSize(9.5).text('ATENTAMENTE', xa, y + 46, { width: 220, align: 'center' });
    if (emp.autoriza) doc.text('AUT. ' + texto_(emp.autoriza).toUpperCase(), xa, y + 64, { width: 220, align: 'center' });

    // Instrucciones para la factura
    y = Math.max(doc.y, y + 90) + 14;
    doc.rect(X, y, ANCHO, 1).fill('#BDBDBD');
    doc.fillColor('#000').font('Helvetica-Bold').fontSize(9).text('Para facturar:', X, y + 8);
    doc.font('Helvetica').fontSize(8.5).fillColor(GRIS).text(
      'Facture a nombre de los Datos de Facturación de arriba e indique en su factura la Serie y Folio de esta orden (' + texto_(oc.serie) + ' ' + oc.folio + '). '
      + 'Suba el PDF y el XML de su factura en: ' + (oc.enlaceFactura || '(enlace)'),
      X, y + 21, { width: ANCHO, link: oc.enlaceFactura || null }
    );
    doc.end();
  });
}

// ------------------------------------------------------------
// Nota contable sobre la PRIMERA hoja de la factura. nota = {
//   cuentaNombre, cuentaNumero, huerta, segmento, observacion, empresaSiglas,
//   firma, totalPiezas, ocTexto }
// Regresa { buffer, modo: 'franja' | 'hoja' }.
// ------------------------------------------------------------
async function estamparNotaFactura(pdfBuffer, nota) {
  const pdf = await PdfLibDoc.load(pdfBuffer, { ignoreEncryption: true, updateMetadata: false });
  const fuente = await pdf.embedFont(StandardFonts.Helvetica);
  const negrita = await pdf.embedFont(StandardFonts.HelveticaBold);
  const filas = [
    ['Nombre de la Cuenta:', texto_(nota.cuentaNombre), true],
    ['No. De Cuenta:', texto_(nota.cuentaNumero), false],
    ['Huerta:', texto_(nota.huerta), true],
    ['Segmento', texto_(nota.segmento), false],
    ['Observaciones:', texto_(nota.observacion), false, true],
    ['Empresa a contabilizar:', texto_(nota.empresaSiglas), false, true],
    ['Firma:', texto_(nota.firma), false],
  ];
  const ALTO_FILA = 15;
  const ALTO_NOTA = filas.length * ALTO_FILA + 26;
  const paginas = pdf.getPages();
  let pagina = paginas[0];
  let modo = 'franja';
  let x0, y0;
  const rot = pagina ? (pagina.getRotation().angle % 360 + 360) % 360 : 0;
  if (!pagina || rot !== 0) {
    // Hoja girada (raro en facturas): la nota va en una hoja aparte al final.
    pagina = pdf.addPage([612, 792]);
    modo = 'hoja';
    x0 = 36; y0 = 792 - 36 - ALTO_NOTA;
  } else {
    // Se alarga la hoja hacia abajo (MediaBox/CropBox) y la nota va en esa
    // franja nueva: no tapa nada de lo que trae la factura.
    const mb = pagina.getMediaBox();
    const cb = pagina.getCropBox();
    const extra = ALTO_NOTA + 16;
    pagina.setMediaBox(mb.x, mb.y - extra, mb.width, mb.height + extra);
    pagina.setCropBox(cb.x, cb.y - extra, cb.width, cb.height + extra);
    try { pagina.setTrimBox(cb.x, cb.y - extra, cb.width, cb.height + extra); } catch (e) { /* opcional */ }
    try { pagina.setBleedBox(cb.x, cb.y - extra, cb.width, cb.height + extra); } catch (e) { /* opcional */ }
    pagina.drawRectangle({ x: cb.x, y: cb.y - extra, width: cb.width, height: extra, color: rgb(1, 1, 1) });
    pagina.drawLine({ start: { x: cb.x + 20, y: cb.y - 3 }, end: { x: cb.x + cb.width - 20, y: cb.y - 3 }, thickness: 0.6, color: rgb(0.3, 0.3, 0.3) });
    x0 = cb.x + 24; y0 = cb.y - extra + 8;
  }
  const ANCHO_ET = 128;
  const ANCHO_VAL = 170;
  const ROJO = rgb(0.85, 0, 0);
  const AMBAR = rgb(1, 0.76, 0.03);
  const NEGRO = rgb(0, 0, 0);
  let yTop = y0 + filas.length * ALTO_FILA;
  filas.forEach(([et, val, resaltar, rojo], i) => {
    const yy = yTop - (i + 1) * ALTO_FILA;
    pagina.drawRectangle({ x: x0, y: yy, width: ANCHO_ET, height: ALTO_FILA, borderColor: NEGRO, borderWidth: 0.8, color: rgb(1, 1, 1) });
    pagina.drawRectangle({ x: x0 + ANCHO_ET, y: yy, width: ANCHO_VAL, height: ALTO_FILA, borderColor: NEGRO, borderWidth: 0.8, color: resaltar ? AMBAR : rgb(1, 1, 1) });
    pagina.drawText(et, { x: x0 + 3, y: yy + 4, size: 8.5, font: negrita, color: rojo ? ROJO : NEGRO });
    pagina.drawText(limpiarWinAnsi_(val).slice(0, 40), { x: x0 + ANCHO_ET + 3, y: yy + 4, size: 8.5, font: rojo ? negrita : fuente, color: rojo ? ROJO : NEGRO });
  });
  const xd = x0 + ANCHO_ET + ANCHO_VAL + 18;
  pagina.drawText('Total de Piezas: ' + (nota.totalPiezas !== undefined && nota.totalPiezas !== null ? String(nota.totalPiezas) : ''), { x: xd, y: yTop - 14, size: 11, font: fuente, color: NEGRO });
  if (nota.ocTexto) pagina.drawText(limpiarWinAnsi_(nota.ocTexto), { x: xd, y: yTop - 32, size: 8.5, font: fuente, color: rgb(0.3, 0.3, 0.3) });
  if (nota.fechaTexto) pagina.drawText(limpiarWinAnsi_(nota.fechaTexto), { x: xd, y: yTop - 46, size: 8, font: fuente, color: rgb(0.3, 0.3, 0.3) });
  const buffer = Buffer.from(await pdf.save());
  return { buffer, modo };
}

// Las fuentes estándar de PDF solo traen WinAnsi: se quitan caracteres que
// truenan (emojis, etc.) sin perder acentos ni ñ.
function limpiarWinAnsi_(t) {
  return texto_(t).replace(/[^\x20-\x7E -ÿ]/g, '');
}

// ------------------------------------------------------------
// XML del CFDI: lo mínimo para revisar que corresponde a la OC.
// ------------------------------------------------------------
function attr_(xml, etiqueta, nombre) {
  const re = new RegExp('<(?:[\\w-]+:)?' + etiqueta + '\\b[^>]*?\\s' + nombre + '\\s*=\\s*"([^"]*)"', 'i');
  const m = re.exec(xml);
  return m ? m[1] : null;
}
function leerCfdi(xmlTexto) {
  const xml = String(xmlTexto || '');
  if (!/<(?:[\w-]+:)?Comprobante\b/i.test(xml)) return null;
  const total = attr_(xml, 'Comprobante', 'Total');
  return {
    serie: attr_(xml, 'Comprobante', 'Serie') || '',
    folio: attr_(xml, 'Comprobante', 'Folio') || '',
    total: total !== null ? Number(total) : null,
    rfcEmisor: (attr_(xml, 'Emisor', 'Rfc') || '').toUpperCase(),
    nombreEmisor: attr_(xml, 'Emisor', 'Nombre') || '',
    rfcReceptor: (attr_(xml, 'Receptor', 'Rfc') || '').toUpperCase(),
    uuid: (attr_(xml, 'TimbreFiscalDigital', 'UUID') || '').toUpperCase(),
  };
}

// Diferencias entre el CFDI y la OC (no bloquean: se le avisan al proveedor
// y quedan marcadas en el Panel para revisarlas).
function revisarCfdiContraOc(cfdi, oc) {
  const avisos = [];
  if (!cfdi) return ['El XML no parece un CFDI (no trae <cfdi:Comprobante>).'];
  if (oc.empresaRfc && cfdi.rfcReceptor && cfdi.rfcReceptor !== String(oc.empresaRfc).toUpperCase()) {
    avisos.push('La factura está a nombre del RFC ' + cfdi.rfcReceptor + ', pero la OC es para ' + oc.empresaRfc + '.');
  }
  if (oc.proveedorRfc && cfdi.rfcEmisor && cfdi.rfcEmisor !== String(oc.proveedorRfc).toUpperCase()) {
    avisos.push('El RFC emisor (' + cfdi.rfcEmisor + ') no es el del proveedor en la OC (' + oc.proveedorRfc + ').');
  }
  if (cfdi.total !== null && oc.total !== undefined && Math.abs(Number(cfdi.total) - Number(oc.total)) > 1) {
    avisos.push('El total de la factura ($' + dinero_(cfdi.total) + ') no coincide con el de la OC ($' + dinero_(oc.total) + ').');
  }
  if (!cfdi.uuid) avisos.push('El XML no trae timbre fiscal (UUID).');
  return avisos;
}

module.exports = {
  calcularTotales, importeConLetra, observacionDeUnidad, generarPdfOc, estamparNotaFactura, leerCfdi, revisarCfdiContraOc,
  fechaOc_, IVA_POR_OMISION,
};
