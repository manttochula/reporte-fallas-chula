// Lee el TEXTO de un catálogo de partes en PDF (formato de los catálogos de
// Kubota: L3800, etc.; y desde nov-2026 los de John Deere, ver leerCatalogoJd_) y lo convierte en secciones con su tabla de piezas.
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

  // ------------------------------------------------------------------
  // Nov-2026: formato John Deere (lo que se descarga de partscatalog.deere.com
  // con "Imprimir/PDF" de un diagrama):
  //   Página del dibujo (a veces acostada): "Parts List", título
  //     "11AD Valve Cover (007601 - ) - ST969832", el equipo
  //     "6603 Tractor (PIN: ...) - PC6195 > 20 Engine" y a veces el motor;
  //     abajo el dibujo (imagen, sin textos) y "Page 1".
  //   Páginas de la lista: "Part | Quantity Required" y por pieza
  //     "1 - Valve Cover Button Plug   6", "Part Number : DZ133300",
  //     "Remarks : SUB FOR DZ122513" (y avisos sueltos).
  // Se aceptan también los textos en español del mismo sitio.
  // ------------------------------------------------------------------
  const JD_LISTA_ = /^(PARTS LIST|LISTA DE PIEZAS|LISTA DE PARTES|LISTA DE REPUESTOS)$/;
  const JD_NUMERO_ = /^(PART NUMBER|NUMERO DE PIEZA|NUMERO DE PARTE|NO\.? DE PIEZA|NO\.? DE PARTE|N\.? ?º? DE PIEZA)\s*:\s*(.*)$/;
  const JD_NOTA_ = /^(REMARKS|OBSERVACIONES|COMENTARIOS|NOTAS?)\s*:\s*(.*)$/;
  const JD_CANTIDAD_ = /^(QUANTITY REQUIRED|CANTIDAD REQUERIDA|CANTIDAD NECESARIA|CANTIDAD)$/;
  const JD_PAGINA_ = /^(PAGE|PAGINA|PAG\.)\s*\d+(\s+(OF|DE)\s+\d+)?$/;

  function esJohnDeere_(paginas) {
    return (paginas || []).some(function (p) {
      return (p.items || []).some(function (i) { return JD_LISTA_.test(sinAcentos_(i.str)); });
    });
  }

  // "11AD Valve Cover (007601 - ) - ST969832" -> codigo ST969832, titulo "11AD Valve Cover", serie "007601 -"
  function partirTituloJd_(texto) {
    const t = limpiar_(texto);
    const m = t.match(/^(.*?)\s+-\s+([A-Z]{1,4}[0-9]{3,}[A-Z0-9]*)$/);
    let resto = m ? m[1] : t;
    const codigo = m ? m[2] : '';
    let serie = '';
    const ms = resto.match(/^(.*?)\s*\(([^()]*)\)\s*$/);
    if (ms) { resto = ms[1]; serie = limpiar_(ms[2]); }
    return { codigo: codigo, titulo: limpiar_(resto) || t, serie: serie };
  }

  // ["11AD Valve Cover (007601 - ) - ST969832", "6603 Tractor (PIN: …) - PC6195 > 20", "Engine", "6068TP063-DZ107919-ETN166062"]
  //   -> { titulo: {codigo, titulo, serie}, grupo: "20 Engine", aplica: "6068TP063-DZ107919-ETN166062" }
  function encabezadoJd_(lineas) {
    const ls = lineas.map(limpiar_).filter(Boolean);
    let aplica = '';
    // Renglón del motor/componente: un solo código con guiones (sin espacios).
    if (ls.length > 1 && /^[0-9A-Z]{4,}(-[0-9A-Z]+)+$/.test(ls[ls.length - 1])) aplica = ls.pop();
    const todo = ls.join(' ');
    const m = todo.match(/^(.*?)\s+-\s+([A-Z]{1,4}[0-9]{3,}[A-Z0-9]*)(?=\s|$)\s*(.*)$/);
    const titulo = partirTituloJd_(m ? m[1] + ' - ' + m[2] : ls[0] || '');
    const resto = m ? m[3] : ls.slice(1).join(' ');
    const grupo = resto.indexOf('>') !== -1 ? limpiar_(resto.split('>').pop()) : '';
    if (!aplica && resto) aplica = limpiar_(resto.split(/\s+-\s+/)[0]);
    return { titulo: titulo, grupo: grupo.slice(0, 255), aplica: aplica.slice(0, 100) };
  }

  function leerCatalogoJd_(paginas) {
    const secciones = [];
    let actual = null;
    (paginas || []).forEach(function (pagina) {
      const items = (pagina.items || [])
        .map(function (i) { return { str: limpiar_(i.str), x: Number(i.x) || 0, y: Number(i.y) || 0, w: Number(i.w) || 0 }; })
        .filter(function (i) { return i.str; });
      const lineas = renglones_(items, 3).filter(function (l) { return !JD_PAGINA_.test(sinAcentos_(l.texto)); });
      const pie = items.find(function (i) { return JD_PAGINA_.test(sinAcentos_(i.str)); });
      const alto = Number(pagina.height) || 792;

      // ¿Empieza aquí un diagrama?
      const iLista = lineas.findIndex(function (l) { return JD_LISTA_.test(sinAcentos_(l.texto)); });
      let desde = 0;
      if (iLista !== -1 && lineas[iLista + 1]) {
        const cab = [lineas[iLista + 1]];
        for (let k = iLista + 2; k < lineas.length; k++) {
          if (lineas[k].y - cab[cab.length - 1].y > 30) break;
          if (JD_CANTIDAD_.test(sinAcentos_(lineas[k].texto.replace(/^.*\s(?=QUANTITY|CANTIDAD)/i, '')))) break;
          cab.push(lineas[k]);
        }
        // Los renglones largos se cortan (el título, el equipo o el grupo
        // pueden seguir en el renglón de abajo): se juntan y se parten por
        // su contenido, no por renglón.
        const enc = encabezadoJd_(cab.map(function (l) { return l.texto; }));
        const tit = enc.titulo, grupo = enc.grupo, aplica = enc.aplica;
        const y0 = cab[cab.length - 1].y + 8;
        const y1 = (pie ? pie.y : alto) - 12;
        actual = {
          codigo: tit.codigo,
          titulo: tit.titulo,
          aplica: aplica.slice(0, 100),
          serie: tit.serie ? 'S.N. ' + tit.serie : '',
          grupo: grupo,
          idPie: '',
          paginas: [pagina.numero],
          paginaDibujo: y1 - y0 > 120 ? pagina.numero : null,
          dibujo: y1 - y0 > 120 ? { y0: y0, y1: y1 } : null,
          piezas: [],
        };
        secciones.push(actual);
        desde = iLista + cab.length + 1;
      } else if (actual) {
        actual.paginas.push(pagina.numero);
      }
      if (!actual) return;

      // Lista de piezas
      const iEnc = lineas.findIndex(function (l, k) { return k >= desde && l.items.some(function (i) { return JD_CANTIDAD_.test(sinAcentos_(i.str)); }); });
      const encab = iEnc !== -1 ? lineas[iEnc].items.find(function (i) { return JD_CANTIDAD_.test(sinAcentos_(i.str)); }) : null;
      // Sin encabezado en esta página: sigue la lista de la página anterior.
      if (!encab && !actual.colCantidad) return;
      if (encab) actual.colCantidad = encab.x;
      const colCant = actual.colCantidad;
      let pieza = actual.piezas[actual.piezas.length - 1] || null;
      lineas.slice(encab ? iEnc + 1 : desde).forEach(function (l) {
        const izq = limpiar_(l.items.filter(function (i) { return i.x < colCant - 20; }).map(function (i) { return i.str; }).join(' '));
        const der = limpiar_(l.items.filter(function (i) { return i.x >= colCant - 20; }).map(function (i) { return i.str; }).join(' '));
        if (!izq) return;
        const sa = sinAcentos_(izq);
        const mPieza = izq.match(/^([0-9]{1,4}[A-Z]?)\s*-\s+(.+)$/);
        const mNum = sa.match(JD_NUMERO_);
        const mNota = sa.match(JD_NOTA_);
        if (mPieza) {
          const cant = Number(der.replace(',', '.'));
          pieza = { ref: mPieza[1], codigo: '', descripcion: mPieza[2], cantidad: der && !isNaN(cant) ? cant : null, serie: '', observaciones: '' };
          actual.piezas.push(pieza);
        } else if (!pieza) {
          return;
        } else if (mNum) {
          pieza.codigo = izq.slice(izq.indexOf(':') + 1).replace(/\s+/g, '');
        } else if (mNota) {
          pieza.observaciones = limpiar_(pieza.observaciones + ' ' + izq.slice(izq.indexOf(':') + 1));
        } else if (!pieza.codigo) {
          pieza.descripcion = limpiar_(pieza.descripcion + ' ' + izq);
        } else {
          pieza.observaciones = limpiar_(pieza.observaciones + (pieza.observaciones ? '. ' : '') + izq);
        }
      });
    });
    return secciones
      .map(function (s) { delete s.colCantidad; return s; })
      .filter(function (s) { return s.piezas.length; });
  }

  function leerCatalogoDetectando(paginas) {
    if (esJohnDeere_(paginas)) return leerCatalogoJd_(paginas);
    return leerCatalogo(paginas);
  }

  return { leerPagina: leerPagina, leerCatalogo: leerCatalogoDetectando, leerCatalogoKubota: leerCatalogo, leerCatalogoJd: leerCatalogoJd_, encabezadoJd_: encabezadoJd_, esJohnDeere: esJohnDeere_, partirTitulo_: partirTitulo_, partirTituloJd_: partirTituloJd_ };
});
