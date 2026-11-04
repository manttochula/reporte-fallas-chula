// Facturas semanales de combustible (nov-2026, Carlos).
// Se sube el CFDI (XML + PDF) de un proveedor de combustible por semana y su
// subtotal, IVA e IEPS se reparten POR LITROS entre lo que se le compró a ese
// proveedor en esas fechas: entregas de diesel a huertas y cargas de
// Combustible Automotriz. Cada tipo (diesel / gasolina) se reparte con sus
// propios conceptos; lo que no es combustible (p. ej. flete) se reparte entre
// todos los litros. Aquí solo van las funciones puras (leer y repartir).

function attrs_(texto) {
  const out = {};
  const re = /([\w:-]+)\s*=\s*"([^"]*)"/g;
  let m;
  while ((m = re.exec(texto))) out[m[1].replace(/^[\w-]+:/, '')] = m[2];
  return out;
}
const num_ = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const r2_ = (n) => Math.round((Number(n) || 0) * 100) / 100;

// Tipo de combustible de un concepto: por clave SAT y, si no, por la descripción.
function tipoConcepto_(clave, descripcion) {
  const c = String(clave || '').trim();
  const d = String(descripcion || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase();
  if (c === '15101505' || /\bDIESEL\b/.test(d)) return 'diesel';
  if (c === '15101514' || c === '15101515' || /GASOLINA|\bMAGNA\b|\bPREMIUM\b|\bREGULAR\b/.test(d)) return 'gasolina';
  return 'otro';
}

// CFDI → { uuid, serie, folio, fecha, rfcEmisor, nombreEmisor, rfcReceptor, subtotal, descuento, iva, ieps, total,
//          tipos: { diesel: { litros, subtotal, iva, ieps }, gasolina: {...}, otro: {...} }, conceptos: [...] }
function leerFacturaCombustible(xmlTexto) {
  const xml = String(xmlTexto || '').replace(/^﻿/, '');
  const mc = /<(?:[\w-]+:)?Comprobante\b([^>]*)>/i.exec(xml);
  if (!mc) return null;
  const comp = attrs_(mc[1]);
  const em = /<(?:[\w-]+:)?Emisor\b([^>]*)\/?>/i.exec(xml);
  const re = /<(?:[\w-]+:)?Receptor\b([^>]*)\/?>/i.exec(xml);
  const tf = /<(?:[\w-]+:)?TimbreFiscalDigital\b([^>]*)\/?>/i.exec(xml);
  const emisor = em ? attrs_(em[1]) : {}, receptor = re ? attrs_(re[1]) : {}, timbre = tf ? attrs_(tf[1]) : {};
  const conceptos = [];
  const rc = /<(?:[\w-]+:)?Concepto\b([^>]*?)(?:\/>|>([\s\S]*?)<\/(?:[\w-]+:)?Concepto>)/gi;
  let m;
  while ((m = rc.exec(xml))) {
    const a = attrs_(m[1]);
    const cuerpo = m[2] || '';
    let iva = 0, ieps = 0;
    const rt = /<(?:[\w-]+:)?Traslado\b([^>]*?)\/?>/gi;
    let t;
    while ((t = rt.exec(cuerpo))) {
      const ta = attrs_(t[1]);
      if (ta.Impuesto === '002') iva += num_(ta.Importe);
      else if (ta.Impuesto === '003') ieps += num_(ta.Importe);
    }
    const tipo = tipoConcepto_(a.ClaveProdServ, a.Descripcion);
    conceptos.push({
      tipo, clave: a.ClaveProdServ || '', descripcion: a.Descripcion || '', unidad: a.ClaveUnidad || '',
      litros: tipo === 'otro' ? 0 : num_(a.Cantidad),
      subtotal: r2_(num_(a.Importe) - num_(a.Descuento)), iva: r2_(iva), ieps: r2_(ieps),
    });
  }
  const tipos = {};
  conceptos.forEach((c) => {
    const g = tipos[c.tipo] = tipos[c.tipo] || { litros: 0, subtotal: 0, iva: 0, ieps: 0 };
    g.litros += c.litros; g.subtotal += c.subtotal; g.iva += c.iva; g.ieps += c.ieps;
  });
  Object.values(tipos).forEach((g) => { g.litros = Math.round(g.litros * 1000) / 1000; g.subtotal = r2_(g.subtotal); g.iva = r2_(g.iva); g.ieps = r2_(g.ieps); });
  const suma = (k) => r2_(conceptos.reduce((s, c) => s + c[k], 0));
  return {
    uuid: (timbre.UUID || '').toUpperCase(), serie: comp.Serie || '', folio: comp.Folio || '', fecha: (comp.Fecha || '').slice(0, 10),
    rfcEmisor: (emisor.Rfc || '').toUpperCase(), nombreEmisor: emisor.Nombre || '', rfcReceptor: (receptor.Rfc || '').toUpperCase(),
    subtotal: suma('subtotal'), iva: suma('iva'), ieps: suma('ieps'),
    total: comp.Total !== undefined ? num_(comp.Total) : null,
    tipos, conceptos,
  };
}

// Reparte "monto" entre pesos (litros) al centavo: la suma de las partes es
// exactamente el monto (los centavos sobrantes van a los residuos más grandes).
function repartir_(monto, pesos) {
  const total = pesos.reduce((s, p) => s + p, 0);
  const cent = Math.round(monto * 100);
  if (!(total > 0) || !pesos.length) return pesos.map(() => 0);
  const exactos = pesos.map((p) => (cent * p) / total);
  const base = exactos.map(Math.floor);
  let falta = cent - base.reduce((s, b) => s + b, 0);
  const orden = exactos.map((e, i) => [e - Math.floor(e), i]).sort((x, y) => y[0] - x[0]);
  for (let k = 0; falta > 0 && k < orden.length; k++, falta--) base[orden[k][1]]++;
  return base.map((c) => c / 100);
}

// factura: { tipos } (de leerFacturaCombustible); registros: [{ clave, tipo, litros }]
// → { porRegistro: { clave: { subtotal, iva, ieps, total } }, sinAsignar: [{ tipo, subtotal, iva, ieps }], litrosPorTipo }
function repartirFacturaCombustible(factura, registros) {
  const porRegistro = {};
  const sinAsignar = [];
  const litrosPorTipo = {};
  const lista = (registros || []).filter((r) => Number(r.litros) > 0);
  lista.forEach((r) => {
    porRegistro[r.clave] = { subtotal: 0, iva: 0, ieps: 0, total: 0 };
    litrosPorTipo[r.tipo] = (litrosPorTipo[r.tipo] || 0) + Number(r.litros);
  });
  const tipos = (factura && factura.tipos) || {};
  Object.keys(tipos).forEach((tipo) => {
    const g = tipos[tipo];
    const destino = tipo === 'otro' ? lista : lista.filter((r) => r.tipo === tipo);
    if (!destino.length) {
      if (g.subtotal || g.iva || g.ieps) sinAsignar.push({ tipo, litros: g.litros, subtotal: g.subtotal, iva: g.iva, ieps: g.ieps });
      return;
    }
    const pesos = destino.map((r) => Number(r.litros));
    ['subtotal', 'iva', 'ieps'].forEach((k) => {
      repartir_(g[k], pesos).forEach((v, i) => { porRegistro[destino[i].clave][k] = r2_(porRegistro[destino[i].clave][k] + v); });
    });
  });
  Object.values(porRegistro).forEach((x) => { x.total = r2_(x.subtotal + x.iva + x.ieps); });
  return { porRegistro, sinAsignar, litrosPorTipo };
}

module.exports = { leerFacturaCombustible, repartirFacturaCombustible, tipoConcepto_, repartir_ };
