// ============================================================
// Exportar Órdenes de Compra para la carga masiva en CONTPAQi Comercial
// (oct-2026). Especificación: proyecto MANTTOS,
// claude/especificacion-exportar-oc-contpaqi.md. El servidor NO habla con
// CONTPAQi: solo arma el .xlsx; la macro de Carlos (Ejemplo_Lote_OC.xlsm,
// Enviar_Lote) lo manda desde la PC de Comercial.
//
// Partida = refacción con precio AUTORIZADO en una cotización (Aut).
// Decisiones de Carlos (28-oct):
//  - Una OC por proveedor Y por orden de mantenimiento (no se juntan órdenes).
//  - Refacción sin folio comercial = GASTO DIRECTO: no va a OC, sale en la
//    hoja "Gasto directo" y queda marcada para no volver a salir pendiente.
//  - Proveedor sin "Código en Comercial" (o sin cantidad/precio) -> hoja
//    "Revisar" con el motivo; NO se marca (vuelve a salir hasta corregirlo).
//  - El folio inicial lo da el usuario; las OC se numeran en consecutivo.
//  - Máximo 300 partidas por OC (si hay más, se parte en otra OC/folio).
// ============================================================
const ExcelJS = require('exceljs');

const MAX_PARTIDAS_OC = 300;

const ENCABEZADOS_LOTE = [
  'Serie', 'Folio*', 'Fecha*', 'Concepto*', 'Código Proveedor*', 'Vencimiento', 'Fecha Entrega',
  'Id Moneda', 'Tipo Cambio', 'Código Producto*', 'Código Almacén*', 'Cantidad*', 'Precio*',
  'Descuento 1', 'Descuento 2', 'Impuesto 1', 'Impuesto 2', 'Estado',
];

function texto_(v) {
  return (v === null || v === undefined ? '' : String(v)).trim();
}

// Decide a dónde va cada partida y arma las OC (puro, sin base de datos).
//   partidas: [{ respuestaItemId, orden, proveedorId, proveedor, codigoComercial,
//                refaccionId, refaccionCodigo, descripcion, folioComercial, cantidad, precio }]
//   opciones: { serie, folioInicial, concepto, almacen }
// Regresa { ocs: [{ serie, folio, orden, proveedorId, proveedor, codigoProveedor, partidas }],
//           gasto: [partida], revisar: [{ partida, motivo }] }
function planearOcs(partidas, opciones) {
  const serie = texto_(opciones.serie);
  let folio = Number(opciones.folioInicial);
  const gasto = [];
  const revisar = [];
  const grupos = new Map();
  (partidas || []).forEach((p) => {
    const cantidad = Number(p.cantidad);
    const precio = Number(p.precio);
    if (!texto_(p.folioComercial)) { gasto.push(p); return; }
    if (!(cantidad > 0)) { revisar.push({ partida: p, motivo: 'Sin cantidad.' }); return; }
    if (p.precio === null || p.precio === undefined || !(precio >= 0)) { revisar.push({ partida: p, motivo: 'Sin precio autorizado.' }); return; }
    if (!texto_(p.codigoComercial)) {
      revisar.push({ partida: p, motivo: 'El proveedor ' + (p.proveedor || '') + ' no tiene "Código en Comercial". Captúralo en Refacciones → Proveedores.' });
      return;
    }
    const clave = p.proveedorId + '|' + (p.orden || '');
    if (!grupos.has(clave)) grupos.set(clave, []);
    grupos.get(clave).push(p);
  });
  // Orden estable: por orden de mantenimiento y luego por proveedor.
  const claves = Array.from(grupos.keys()).sort((a, b) => {
    const pa = grupos.get(a)[0];
    const pb = grupos.get(b)[0];
    return texto_(pa.orden).localeCompare(texto_(pb.orden), 'es', { numeric: true }) || texto_(pa.proveedor).localeCompare(texto_(pb.proveedor), 'es');
  });
  const ocs = [];
  claves.forEach((clave) => {
    const lista = grupos.get(clave);
    for (let i = 0; i < lista.length; i += MAX_PARTIDAS_OC) {
      const p0 = lista[0];
      ocs.push({
        serie,
        folio: folio++,
        orden: p0.orden || '',
        proveedorId: p0.proveedorId,
        proveedor: p0.proveedor || '',
        codigoProveedor: texto_(p0.codigoComercial),
        partidas: lista.slice(i, i + MAX_PARTIDAS_OC),
      });
    }
  });
  return { ocs, gasto, revisar };
}

// "2026-10-28" -> Date a medianoche UTC (Excel la muestra como 28/10/2026).
function fechaExcel_(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(texto_(iso));
  if (!m) return null;
  return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
}

// Arma el .xlsx (Buffer) con las hojas Lote, Gasto directo y Revisar.
async function escribirExcel(plan, opciones) {
  const wb = new ExcelJS.Workbook();
  const fecha = fechaExcel_(opciones.fecha);
  const fechaEntrega = fechaExcel_(opciones.fechaEntrega);
  const concepto = texto_(opciones.concepto);
  const almacen = texto_(opciones.almacen);

  const lote = wb.addWorksheet('Lote');
  lote.addRow(ENCABEZADOS_LOTE);
  lote.getRow(1).font = { bold: true };
  [10, 10, 12, 26, 18, 12, 14, 10, 11, 18, 16, 10, 12, 11, 11, 11, 11, 14].forEach((w, i) => { lote.getColumn(i + 1).width = w; });
  ['C', 'F', 'G'].forEach((c) => { lote.getColumn(c).numFmt = 'dd/mm/yyyy'; });
  ['A', 'D', 'E', 'J', 'K'].forEach((c) => { lote.getColumn(c).numFmt = '@'; });
  lote.getColumn('M').numFmt = '0.00##';
  plan.ocs.forEach((oc) => {
    oc.partidas.forEach((p) => {
      lote.addRow([
        oc.serie, oc.folio, fecha, texto_(oc.concepto) || concepto, String(oc.codigoProveedor), null, fechaEntrega, 1, 1,
        String(texto_(p.folioComercial)), almacen, Number(p.cantidad), Number(p.precio),
        null, null, null, null, null,
      ]);
    });
  });
  lote.views = [{ state: 'frozen', ySplit: 1 }];

  const gasto = wb.addWorksheet('Gasto directo');
  gasto.columns = [
    { header: 'Empresa', key: 'empresa', width: 30 },
    { header: 'Orden', key: 'orden', width: 12 }, { header: 'Refacción', key: 'ref', width: 46 },
    { header: 'Código', key: 'cod', width: 12 }, { header: 'Proveedor', key: 'prov', width: 26 },
    { header: 'Cantidad', key: 'cant', width: 10 }, { header: 'Precio s/IVA', key: 'precio', width: 13 },
    { header: 'Total s/IVA', key: 'total', width: 13 },
  ];
  gasto.getRow(1).font = { bold: true };
  plan.gasto.forEach((p) => {
    gasto.addRow({ empresa: p.empresa || opciones.empresa || '', orden: p.orden || '', ref: p.descripcion || '', cod: p.refaccionCodigo || '', prov: p.proveedor || '',
      cant: Number(p.cantidad) || 0, precio: Number(p.precio) || 0, total: Math.round((Number(p.cantidad) || 0) * (Number(p.precio) || 0) * 100) / 100 });
  });
  // Con la columna Empresa al inicio: F = Cantidad (número), G = Precio, H = Total.
  gasto.getColumn('F').numFmt = '0.##';
  ['G', 'H'].forEach((c) => { gasto.getColumn(c).numFmt = '$#,##0.00'; });

  const rev = wb.addWorksheet('Revisar');
  rev.columns = [
    { header: 'Empresa', key: 'empresa', width: 30 },
    { header: 'Orden', key: 'orden', width: 12 }, { header: 'Refacción', key: 'ref', width: 46 },
    { header: 'Folio comercial', key: 'folio', width: 15 }, { header: 'Proveedor', key: 'prov', width: 26 },
    { header: 'Cantidad', key: 'cant', width: 10 }, { header: 'Precio s/IVA', key: 'precio', width: 13 },
    { header: 'Motivo', key: 'motivo', width: 70 },
  ];
  rev.getRow(1).font = { bold: true };
  plan.revisar.forEach((r) => {
    const p = r.partida;
    rev.addRow({ empresa: p.empresa || '', orden: p.orden || '', ref: p.descripcion || '', folio: p.folioComercial || '', prov: p.proveedor || '',
      cant: p.cantidad, precio: p.precio, motivo: r.motivo });
  });
  rev.getColumn('F').numFmt = '0.##';
  rev.getColumn('G').numFmt = '$#,##0.00';

  return Buffer.from(await wb.xlsx.writeBuffer());
}

module.exports = { planearOcs, escribirExcel, ENCABEZADOS_LOTE, MAX_PARTIDAS_OC };
