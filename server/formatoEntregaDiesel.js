// Nov-2026 (Carlos): formato (vale) de cada entrega de diesel a una huerta, para
// mandárselo a la gasolinera por correo. Lleva folio, fecha, huerta, litros,
// quién registró y espacio para la firma de recibido.
const PDFDocument = require('pdfkit');

const AZUL = '#1F3864';
const GRIS = '#555555';
const t = (v) => (v === null || v === undefined ? '' : String(v));

function fechaHora_(d) {
  if (!d) return '';
  const f = d instanceof Date ? d : new Date(d);
  if (isNaN(f.getTime())) return t(d);
  return f.toLocaleString('es-MX', { timeZone: 'America/Mexico_City', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}
function litros_(n) { return Number(n || 0).toLocaleString('es-MX', { minimumFractionDigits: 0, maximumFractionDigits: 2 }); }

// e: { folio, fecha, huerta, litros, nombre, comentario, empresa, gasolinera }
function generarPdfEntrega(e) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'LETTER', margin: 48, info: { Title: 'Entrega de diesel ' + t(e.folio) } });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    const X = 48, ANCHO = doc.page.width - 96;

    doc.rect(X, 48, ANCHO, 54).fill(AZUL);
    doc.fillColor('#fff').font('Helvetica-Bold').fontSize(18).text('ENTREGA DE DIESEL A HUERTA', X + 14, 60, { width: ANCHO - 180 });
    doc.font('Helvetica').fontSize(10).text(t(e.empresa) || 'Chula Brand', X + 14, 82, { width: ANCHO - 180 });
    doc.font('Helvetica').fontSize(9).text('Folio', X + ANCHO - 160, 58, { width: 146, align: 'right' });
    doc.font('Helvetica-Bold').fontSize(16).text(t(e.folio), X + ANCHO - 160, 72, { width: 146, align: 'right' });

    let y = 130;
    const fila = (et, val, grande) => {
      doc.font('Helvetica').fontSize(10).fillColor(GRIS).text(et, X, y, { width: 150 });
      doc.font(grande ? 'Helvetica-Bold' : 'Helvetica').fontSize(grande ? 20 : 13).fillColor('#000').text(val, X + 160, y - (grande ? 5 : 1), { width: ANCHO - 160 });
      y += grande ? 40 : 28;
      doc.moveTo(X, y - 8).lineTo(X + ANCHO, y - 8).strokeColor('#DDDDDD').lineWidth(0.6).stroke();
    };
    if (e.gasolinera) fila('Gasolinera:', t(e.gasolinera));
    fila('Fecha y hora:', fechaHora_(e.fecha));
    fila('Huerta:', t(e.huerta));
    fila('Litros entregados:', litros_(e.litros) + ' L', true);
    fila('Registró:', t(e.nombre));
    if (e.solicitudFolio) fila('Solicitud:', t(e.solicitudFolio) + (e.solicitudFirmo ? ' · ' + t(e.solicitudFirmo) : ''));
    if (e.comentario) fila('Comentario:', t(e.comentario));

    // Firma del encargado que solicitó (nov-2026)
    if (e.firmaSolicitud) {
      y += 6;
      doc.font('Helvetica').fontSize(10).fillColor(GRIS).text('Firma de quien solicitó:', X, y);
      try { doc.image(e.firmaSolicitud, X + 160, y - 6, { fit: [220, 70] }); } catch (er) { /* firma ilegible: se omite */ }
      y += 72;
    }
    // Firma de recibido
    y += 70;
    const w = 230;
    doc.moveTo(X, y).lineTo(X + w, y).strokeColor('#000').lineWidth(0.8).stroke();
    doc.moveTo(X + ANCHO - w, y).lineTo(X + ANCHO, y).stroke();
    doc.font('Helvetica').fontSize(9).fillColor(GRIS)
      .text('Entregó (gasolinera) — nombre y firma', X, y + 6, { width: w, align: 'center' })
      .text('Recibió (huerta) — nombre y firma', X + ANCHO - w, y + 6, { width: w, align: 'center' });
    doc.fontSize(8).fillColor('#999').text('Generado por el sistema de Reporte de Fallas · ' + fechaHora_(new Date()), X, doc.page.height - 70, { width: ANCHO, align: 'center' });
    doc.end();
  });
}

module.exports = { generarPdfEntrega };
