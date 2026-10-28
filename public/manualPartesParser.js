// Lee el TEXTO de un catálogo de partes en PDF (formato de los catálogos de
// Kubota: L3800, etc.) y lo convierte en secciones con su tabla de piezas.
//
// No depende de nada: recibe, por página, los textos con su posición (lo
// que da pdf.js con getTextContent) y regresa las secciones. Lo usa el Panel
// al "Subir catálogo de partes (PDF)" (ver catalogoPartes.js) y las pruebas
// en Node (tests/unitarias/test_manual_partes_parser.js).
//
// Cómo viene cada página del catálogo:
//   - Arriba a la izquierda, 2 renglones: "000302 CILINDRO CULATA ## D1803-M-E3-LB5"
//     (código de la sección, nombre y a qué aplica) y "L3800DT MOTOR" (grupo).
//   - En la primera página de cada sección, el dibujo; abajo de él la
//     leyenda ("Interchangeable ...") y la tabla con encabezados
//     No. | Código de pieza | Descripción | Cant | FRT[h] | Int | N.º de serie/PIN | Observaciones | Kg
//   - Si la tabla no cabe, sigue en la página siguiente (mismo encabezado
//     de sección, sin dibujo).
//   - Hay páginas sueltas sin texto (capturas de pantalla): se ignoran.
(function (raiz, fabrica) {
  if (typeof module === 'object' && module.exports) module.exports = fabrica();
  else raiz.ManualPartesParser = fabrica();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function limpiar_(s) {
    return (s || '').toString().replace(/\s+/g, ' ').trim();
  }

  function sinAcentos_(s) {
    return limpiar_(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase();
  }

  // Agrupa textos en renglones (misma altura, con tolerancia).
  function renglones_(items, tolerancia) {
    const ordenados = items.slice().sort(function (a, b) { return a.y - b.y || a.x - b.x; });
    const salida = [];
    ordenados.forEach(function (it) {
      const ultimo = salida[salida.length - 1];
      if (ultimo && Math.abs(ultimo.y - it.y) <= tolerancia) ultimo.items.push(it);
      else salida.push({ y: it.y, items: [it] });
    });
    salida.forEach(function (r) {
      r.items.sort(function (a, b) { return a.x - b.x; });
      r.texto = limpiar_(r.items.map(function (i) { return i.str; }).join(' '));
    });
    return salida;
  }

  // "000302 CILINDRO CULATA ## D1803-M-E3-LB5" -> { codigo, titulo, aplica }
  function partirTitulo_(texto) {
    const t = limpiar_(texto);
    const partes = t.split('##');
    const izquierda = limpiar_(partes[0]);
    const aplica = partes.length > 1 ? limpiar_(partes.slice(1).join('##')) : '';
    const m = izquierda.match(/^([0-9A-Z]{4,8})\s+(.+)$/);
    if (m) return { codigo: m[1], titulo: m[2], aplica: aplica };
    return { codigo: '', titulo: izquierda, aplica: aplica };
  }

  // Nombre de cada columna tal como aparece en el encabezado (sin acentos,
  // en mayúsculas). A veces el PDF junta varios en un solo texto
  // ("FRT[h] Int N. º de serie/PIN"), por eso se buscan DENTRO del texto.
  const COLUMNAS_ = [
    { clave: 'ref', patron: /(^|\s)NO\./ },
    { clave: 'codigo', patron: /CODIGO DE PIEZA/ },
    { clave: 'descripcion', patron: /DESCRIPCION/ },
    { clave: 'cantidad', patron: /(^|\s)CANT\b/ },
    { clave: 'frt', patron: /FRT\[?H?\]?/ },
    { clave: 'int', patron: /(^|\s)INT(\s|$)/ },
    { clave: 'serie', patron: /N\. ?º? ?DE SERIE\/PIN|DE SERIE/ },
    { clave: 'observaciones', patron: /OBSERVACIONES/ },
    { clave: 'kg', patron: /(^|\s)KG(\s|$)/ },
  ];

  // Busca el renglón de encabezados de la tabla y la posición (centro) de
  // cada columna. Regresa null si la página no trae tabla de piezas.
  function encabezadoTabla_(items) {
    const candidatos = items.filter(function (i) { return /^NO\.?(\s|$)/.test(sinAcentos_(i.str)); });
    for (let k = 0; k < candidatos.length; k++) {
      const y = candidatos[k].y;
      const mismos = items.filter(function (i) { return Math.abs(i.y - y) <= 3; });
      const cols = {};
      const derecha = {};
      mismos.forEach(function (i) {
        const t = sinAcentos_(i.str);
        const porLetra = (i.w || 0) / Math.max(1, t.length);
        COLUMNAS_.forEach(function (c) {
          if (cols[c.clave] !== undefined) return;
          const m = c.patron.exec(t);
          if (!m) return;
          const texto = m[0].trim();
          const inicio = m.index + m[0].indexOf(texto);
          cols[c.clave] = i.x + porLetra * (inicio + texto.length / 2);
          derecha[c.clave] = i.x + porLetra * (inicio + texto.length);
        });
      });
      if (cols.ref !== undefined && cols.codigo !== undefined && cols.descripcion !== undefined) {
        return { y: y, columnas: cols, derecha: derecha };
      }
    }
    return null;
  }

  function columnaMasCercana_(centro, columnas) {
    let mejor = null;
    let dist = Infinity;
    Object.keys(columnas).forEach(function (clave) {
      const d = Math.abs(columnas[clave] - centro);
      if (d < dist) { dist = d; mejor = clave; }
    });
    return mejor;
  }

  // Lee una página. Regresa null si no es una página de catálogo (sin
  // encabezado de sección o sin tabla).
  function leerPagina(pagina) {
    const items = (pagina.items || [])
      .map(function (i) { return { str: limpiar_(i.str), x: Number(i.x) || 0, y: Number(i.y) || 0, w: Number(i.w) || 0 }; })
      .filter(function (i) { return i.str; });
    const tabla = encabezadoTabla_(items);
    if (!tabla) return null;

    // Encabezado de sección: renglones arriba del todo (antes del dibujo/
    // leyenda), sin las fechas de la derecha.
    const arriba = items.filter(function (i) {
      return i.y < Math.min(tabla.y, 90) && !/^FECHA DE /.test(sinAcentos_(i.str));
    });
    const lineas = renglones_(arriba, 3);
    if (!lineas.length) return null;
    const titulo = partirTitulo_(lineas[0].texto);
    // Algunas secciones traen un renglón con el rango de serie al que
    // aplican ("S.No.<=83903 S.No.;<=83903") antes del grupo.
    let serieSeccion = '';
    let grupo = '';
    lineas.slice(1).forEach(function (l) {
      if (/^S\.\s?NO\./.test(sinAcentos_(l.texto))) serieSeccion = limpiar_(l.texto.split(/\s+S\.No\.;/i)[0]);
      else if (!grupo) grupo = l.texto;
    });
    const alturaEncabezado = lineas[lineas.length - 1].y;

    const leyenda = items.find(function (i) { return /^INTERCHANGEABLE$/.test(sinAcentos_(i.str)); });
    const pie = items.find(function (i) { return /^PAGE \d+ OF \d+$/.test(sinAcentos_(i.str)); });
    const altoPagina = Number(pagina.height) || 842;
    const limiteAbajo = (function () {
      const avisos = items.filter(function (i) { return /^LA INFORMACION QUE AQUI/.test(sinAcentos_(i.str)); });
      if (avisos.length) return avisos[0].y - 2;
      if (pie) return pie.y - 10;
      return altoPagina;
    })();
    const idPie = items.find(function (i) { return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(i.str); });

    // Renglones de la tabla: cada uno empieza con un número en la columna
    // "No." (010, 020, 110...). Lo demás (observaciones en 2-3 líneas, etc.)
    // se pega al renglón más cercano en altura.
    // A veces el PDF trae pegados "030 05012-01018" (No. y código en un
    // solo texto): se separan, repartiendo el ancho por letras.
    const cuerpo = [];
    items.forEach(function (i) {
      if (!(i.y > tabla.y + 3 && i.y < limiteAbajo)) return;
      const m = i.str.match(/^([0-9]{2,4}[A-Z]?)\s+(\S.*)$/);
      if (m && columnaMasCercana_(i.x, tabla.columnas) === 'ref') {
        const porLetra = i.w / i.str.length;
        cuerpo.push({ str: m[1], x: i.x, y: i.y, w: porLetra * m[1].length });
        const inicio = i.str.length - m[2].length;
        cuerpo.push({ str: m[2], x: i.x + porLetra * inicio, y: i.y, w: porLetra * m[2].length });
      } else cuerpo.push(i);
    });
    const anclas = cuerpo
      .filter(function (i) {
        return /^[0-9]{2,4}[A-Z]?$/.test(i.str) && columnaMasCercana_(i.x + i.w / 2, tabla.columnas) === 'ref';
      })
      .sort(function (a, b) { return a.y - b.y; });
    const filas = anclas.map(function (a) { return { ancla: a, celdas: {} }; });
    cuerpo.forEach(function (i) {
      if (anclas.indexOf(i) !== -1) return;
      let fila = null;
      let dist = Infinity;
      filas.forEach(function (f) {
        const d = Math.abs(f.ancla.y - i.y);
        if (d < dist) { dist = d; fila = f; }
      });
      if (!fila || dist > 22) return;
      let col = columnaMasCercana_(i.x + i.w / 2, tabla.columnas);
      // Las observaciones van pegadas a la izquierda de su celda: un texto
      // corto ("18T") queda más cerca del centro de "N.º de serie" aunque
      // empiece ya pasada esa columna.
      if (col === 'serie' && tabla.columnas.observaciones !== undefined && i.x >= tabla.derecha.serie) col = 'observaciones';
      (fila.celdas[col] = fila.celdas[col] || []).push(i);
    });

    const texto = function (lista) {
      return limpiar_((lista || []).slice().sort(function (a, b) { return a.y - b.y || a.x - b.x; }).map(function (i) { return i.str; }).join(' '));
    };
    const piezas = filas
      .map(function (f) {
        const cantidadTexto = texto(f.celdas.cantidad);
        const cantidad = /^\d+(\.\d+)?$/.test(cantidadTexto) ? Number(cantidadTexto) : null;
        // "----" = la pieza no se vende por separado (no trae número).
        const codigo = texto(f.celdas.codigo).replace(/\s+/g, '');
        return {
          ref: f.ancla.str,
          codigo: /^-+$/.test(codigo) ? '' : codigo,
          descripcion: texto(f.celdas.descripcion),
          cantidad: cantidad,
          serie: texto(f.celdas.serie),
          observaciones: texto(f.celdas.observaciones),
        };
      })
      .filter(function (p) { return p.codigo || p.descripcion; });

    const tieneDibujo = !!leyenda && leyenda.y - alturaEncabezado > 120;
    return {
      numero: pagina.numero,
      ancho: Number(pagina.width) || 595,
      alto: altoPagina,
      codigo: titulo.codigo,
      titulo: titulo.titulo,
      aplica: titulo.aplica,
      serie: serieSeccion,
      grupo: grupo,
      idPie: idPie ? idPie.str : '',
      dibujo: tieneDibujo ? { y0: alturaEncabezado + 8, y1: leyenda.y - 10 } : null,
      piezas: piezas,
    };
  }

  // Junta las páginas en secciones (páginas seguidas con el mismo encabezado
  // y, si lo trae, el mismo identificador al pie).
  function leerCatalogo(paginas) {
    const secciones = [];
    (paginas || []).forEach(function (p) {
      const leida = leerPagina(p);
      if (!leida) return;
      const ultima = secciones[secciones.length - 1];
      const misma =
        ultima &&
        ultima.codigo === leida.codigo &&
        ultima.titulo === leida.titulo &&
        (!ultima.idPie || !leida.idPie || ultima.idPie === leida.idPie);
      if (misma) {
        ultima.paginas.push(leida.numero);
        ultima.piezas = ultima.piezas.concat(leida.piezas);
        if (!ultima.dibujo && leida.dibujo) { ultima.dibujo = leida.dibujo; ultima.paginaDibujo = leida.numero; }
        return;
      }
      secciones.push({
        codigo: leida.codigo,
        titulo: leida.titulo,
        aplica: leida.aplica,
        serie: leida.serie,
        grupo: leida.grupo,
        idPie: leida.idPie,
        paginas: [leida.numero],
        paginaDibujo: leida.dibujo ? leida.numero : null,
        dibujo: leida.dibujo,
        piezas: leida.piezas,
      });
    });
    return secciones;
  }

  return { leerPagina: leerPagina, leerCatalogo: leerCatalogo, partirTitulo_: partirTitulo_ };
});
