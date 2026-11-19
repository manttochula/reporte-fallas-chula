// Lee el TEXTO de las pólizas de seguro de autos en PDF (formato de Seguros
// Banorte: carátula por inciso con "NÚMERO DE PÓLIZA", "DATOS DE LA PÓLIZA" y
// "DATOS DEL VEHÍCULO") y regresa un renglón por vehículo (inciso).
//
// Igual que manualPartesParser.js: recibe, por página, los textos con su
// posición (pdf.js getTextContent ya convertido a coordenadas de la página) y
// no depende de nada. Lo usa el Panel en Seguros → "Importar pólizas (PDF)" y
// las pruebas en Node (tests/unitarias/test_polizas_parser.js).
//
// Banorte manda dos estilos de carátula:
//   - "flotilla" (el PDF de toda la póliza, 1 página por inciso): las
//     etiquetas llevan una raya ("Serie: _____") y el valor va abajo;
//   - "endoso" (alta de un vehículo a la flotilla): etiqueta y valor en el
//     mismo renglón.
// Por eso se arma el texto renglón por renglón y se buscan los datos por
// etiqueta, tomando el valor del mismo renglón o, si está vacío, del de abajo.
(function (raiz, fabrica) {
  if (typeof module === 'object' && module.exports) module.exports = fabrica();
  else raiz.PolizasParser = fabrica();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const MESES = { ENE: '01', FEB: '02', MAR: '03', ABR: '04', MAY: '05', JUN: '06', JUL: '07', AGO: '08', SEP: '09', SEPT: '09', OCT: '10', NOV: '11', DIC: '12',
    JAN: '01', APR: '04', AUG: '08', DEC: '12' };
  const VIN = /\b([A-HJ-NPR-Z0-9]{17})\b/;

  function limpiar_(s) { return (s || '').toString().replace(/\s+/g, ' ').trim(); }
  function sinAcentos_(s) { return limpiar_(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase(); }
  // Igual pero respetando los saltos de renglón (para buscar en todo el texto)
  function mayus_(s) { return (s || '').toString().normalize('NFD').replace(/[\u0300-\u036f]/g, '').toUpperCase().replace(/[ \t]+/g, ' '); }

  // Renglones de la página (misma altura con tolerancia), de arriba a abajo.
  function renglones_(items) {
    const ord = (items || []).map(function (i) { return { str: limpiar_(i.str), x: Number(i.x) || 0, y: Number(i.y) || 0 }; })
      .filter(function (i) { return i.str; })
      .sort(function (a, b) { return a.y - b.y || a.x - b.x; });
    const out = [];
    ord.forEach(function (it) {
      const u = out[out.length - 1];
      if (u && Math.abs(u.y - it.y) <= 2.5) u.items.push(it);
      else out.push({ y: it.y, items: [it] });
    });
    return out.map(function (r) {
      r.items.sort(function (a, b) { return a.x - b.x; });
      return limpiar_(r.items.map(function (i) { return i.str; }).join(' '));
    });
  }

  // "15/DIC/2025", "01/oct/2026", "09/Enero/2026" -> "2025-12-15"
  function fecha_(s) {
    const m = /(\d{1,2})\s*\/\s*([A-Za-zÁÉÍÓÚáéíóú]{3,10})\s*\/\s*(\d{4})/.exec(s || '');
    if (!m) return null;
    const mes = MESES[sinAcentos_(m[2]).slice(0, 4)] || MESES[sinAcentos_(m[2]).slice(0, 3)];
    return mes ? m[3] + '-' + mes + '-' + String(m[1]).padStart(2, '0') : null;
  }
  function numero_(s) {
    const m = /([\d,]+\.\d{2}|[\d,]+)/.exec(s || '');
    return m ? Number(m[1].replace(/,/g, '')) : null;
  }
  // Quita las rayas de los formularios ("Serie: ______")
  function sinRayas_(s) { return limpiar_((s || '').replace(/_{2,}/g, ' ')); }

  // Valor de una etiqueta: lo que sigue en el renglón (hasta la siguiente
  // etiqueta conocida) o, si no hay nada, el renglón de abajo.
  function valor_(lineas, etiqueta, siguientes) {
    for (let i = 0; i < lineas.length; i++) {
      const l = sinRayas_(lineas[i]);
      const k = sinAcentos_(l).indexOf(sinAcentos_(etiqueta));
      if (k === -1) continue;
      let resto = l.slice(k + etiqueta.length).replace(/^\s*:?\s*/, '');
      (siguientes || []).forEach(function (s) {
        const j = sinAcentos_(resto).indexOf(sinAcentos_(s));
        if (j !== -1) resto = resto.slice(0, j);
      });
      resto = limpiar_(resto);
      if (resto) return { texto: resto, linea: i };
      const abajo = sinRayas_(lineas[i + 1] || '');
      return { texto: abajo, linea: i + 1, abajo: true };
    }
    return null;
  }

  function leerCaratula_(lineas, texto) {
    const sa = mayus_(texto);
    if (sa.indexOf('DATOS DEL VEHICULO') === -1 || sa.indexOf('NUMERO DE POLIZA') === -1) return null;
    // Encabezado: "Flotilla Producto No. de Póliza Módulo Oficina Ramo Subramo Inciso" y abajo los valores
    let poliza = '', inciso = '';
    for (let i = 0; i < lineas.length; i++) {
      if (/INCISO/.test(sinAcentos_(lineas[i])) && /POLIZA/.test(sinAcentos_(lineas[i]))) {
        const toks = limpiar_(lineas[i + 1] || '').split(' ');
        const p = toks.findIndex(function (t) { return /^[A-Z]\d{3}$/.test(t); });
        if (p !== -1 && toks[p + 1]) poliza = toks[p + 1];
        else { const n7 = toks.filter(function (t) { return /^\d{6,10}$/.test(t); }); poliza = n7[n7.length > 1 ? 1 : 0] || ''; }
        inciso = toks[toks.length - 1] || '';
        break;
      }
    }
    const tipo = (function () {
      const i = lineas.findIndex(function (l) { return /POLIZA DE SEGURO DE/.test(sinAcentos_(l)); });
      return i === -1 ? '' : limpiar_(sinAcentos_(lineas[i]).replace(/.*POLIZA DE SEGURO DE/, '')) || limpiar_(lineas[i + 1] || '');
    })();
    const fechaDe = function (et) {
      for (let i = 0; i < lineas.length; i++) {
        if (sinAcentos_(lineas[i]).indexOf(sinAcentos_(et)) === -1) continue;
        return fecha_(lineas[i]) || fecha_(lineas[i + 1]) || fecha_(lineas[i - 1]);
      }
      return null;
    };
    const dinero = function (et) {
      const re = new RegExp(et + '\\s*:?\\s*\\$\\s*([\\d,]+\\.\\d{2})', 'i');
      const m = re.exec(sa.replace(/\n/g, ' '));
      return m ? Number(m[1].replace(/,/g, '')) : null;
    };
    const contr = valor_(lineas, 'Nombre del Contratante', ['R.F.C', 'RFC']);
    let contratante = contr ? contr.texto : '';
    if (contr && contr.abajo) contratante = limpiar_(contratante.replace(/R\.?F\.?C\.?.*$/i, ''));
    const rfc = (/\b([A-ZÑ&]{3,4}\d{6}[A-Z0-9]{3})\b/.exec(texto.slice(sa.indexOf('DATOS DEL ASEGURADO'))) || [])[1] || '';
    const veh = lineas.slice(lineas.findIndex(function (l) { return /DATOS DEL VEHICULO/.test(sinAcentos_(l)); }));
    const desc = valor_(veh, 'Descripción', ['Clave SB']);
    const modelo = (/MODELO\s*:?[\s_]*(\d{4})/.exec(mayus_(veh.join('\n'))) || /\n\s*(?:\d+\s+)?(\d{4})\s+TRANSMISI/.exec(mayus_(veh.join('\n'))) || [])[1] || '';
    const textoVeh = veh.join('\n');
    const mv = mayus_(textoVeh);
    const serie = (VIN.exec(mv.slice(Math.max(0, mv.indexOf('SERVICIO')))) || VIN.exec(mv) || [])[1] || '';
    let placas = '';
    const pl = /PLACAS\s*:?\s*([A-Z0-9-]{5,9})\s+SERIE/.exec(mayus_(sinRayas_(textoVeh)));
    if (pl && pl[1] !== serie) placas = pl[1];
    const paquete = (/PAQUETE\s*:\s*([^\n]+)/.exec(sa) || [])[1] || '';
    const ded = function (cob) {
      const m = new RegExp(cob + '[^\\n%]*?(\\d{1,2}\\s?%)').exec(sa);
      return m ? m[1].replace(/\s/g, '') : '';
    };
    const dm = ded('DANOS MATERIALES'), rt = ded('ROBO TOTAL');
    const agente = (/INTERMEDIARIO\s*:?\s*\d*\s*([A-Z][A-Z .]+?)\s+PRIMA/.exec(sa) || /AGENTE\s*:\s*([A-Z][A-Z .]+?)(\n|\s{2}|$)/.exec(sa) || [])[1] || '';
    const telSin = (/SINIESTROS EN MEXICO\s*:?\s*(\d[\d ]{9,13}\d)/.exec(sa) || [])[1] || '';
    return {
      aseguradora: /BANORTE/.test(sa) ? 'Seguros Banorte' : ((/SEGUROS\s+([A-Z]+)/.exec(sa) || [])[1] ? 'Seguros ' + (/SEGUROS\s+([A-Z]+)/.exec(sa))[1] : ''),
      poliza: poliza,
      inciso: inciso,
      tipo: tipo,
      contratante: contratante,
      rfc: rfc,
      emision: fechaDe('Fecha de emisión'),
      inicio: fechaDe('Inicio de vigencia'),
      fin: fechaDe('Fin de vigencia'),
      formaPago: limpiar_(((valor_(lineas, 'Forma de pago', ['Impuesto', 'Recargo']) || {}).texto || '').split(' ')[0]),
      primaNeta: dinero('PRIMA NETA'),
      primaTotal: dinero('PRIMA TOTAL'),
      descripcion: desc ? limpiar_(desc.texto) : '',
      modelo: modelo,
      serie: serie,
      placas: placas,
      paquete: limpiar_(paquete),
      deducible: [dm ? 'DM ' + dm : '', rt ? 'RT ' + rt : ''].filter(Boolean).join(' / '),
      agente: limpiar_(agente),
      telefonoSiniestros: limpiar_(telSin),
    };
  }

  // paginas: [{ numero, items: [{str,x,y}] }] -> incisos (uno por vehículo)
  function leerPolizas(paginas) {
    const out = [];
    let ultimo = null;
    (paginas || []).forEach(function (p) {
      const lineas = renglones_(p.items);
      const texto = lineas.join('\n');
      const c = leerCaratula_(lineas, texto);
      if (c) {
        c.paginas = [p.numero];
        out.push(c);
        ultimo = c;
        return;
      }
      // Hoja de coberturas del mismo inciso: deducibles y paquete si faltaban
      const sa = mayus_(texto);
      if (ultimo && sa.indexOf('COBERTURAS') !== -1) {
        ultimo.paginas.push(p.numero);
        if (!ultimo.paquete) ultimo.paquete = limpiar_((/PAQUETE\s*:\s*([^\n]+)/.exec(sa) || [])[1] || '');
        if (!ultimo.deducible) {
          const ded = function (cob) { const m = new RegExp(cob + '[^\\n%]*?(\\d{1,2}\\s?%)').exec(sa); return m ? m[1].replace(/\s/g, '') : ''; };
          const dm = ded('DANOS MATERIALES'), rt = ded('ROBO TOTAL');
          ultimo.deducible = [dm ? 'DM ' + dm : '', rt ? 'RT ' + rt : ''].filter(Boolean).join(' / ');
        }
        if (!ultimo.telefonoSiniestros) ultimo.telefonoSiniestros = limpiar_((/SINIESTROS EN MEXICO\s*:?\s*(\d[\d ]{9,13}\d)/.exec(sa) || [])[1] || '');
      }
    });
    return out.filter(function (c) { return c.poliza && (c.serie || c.descripcion); });
  }

  // "LIGEROS INTEGRAL" -> cobertura del Panel (Amplia / Limitada / Responsabilidad civil / Otra)
  function cobertura(paquete) {
    const s = sinAcentos_(paquete);
    if (!s) return '';
    if (/INTEGRAL|AMPLIA/.test(s)) return 'Amplia';
    if (/LIMITADA/.test(s)) return 'Limitada';
    if (/RESPONSABILIDAD|\bRC\b/.test(s)) return 'Responsabilidad civil';
    return 'Otra';
  }

  return { leerPolizas: leerPolizas, renglones_: renglones_, fecha_: fecha_, cobertura: cobertura };
});
