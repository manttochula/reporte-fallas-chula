// Catálogo de partes por modelo (oct-2026) — compartido por el Panel y Taller.
//
//   CatalogoPartes.abrir({ code, usuario, orden, manualId, onAgregar })
//     Abre el visor: secciones del catálogo (con su dibujo) y la tabla de
//     piezas de cada una, buscador, y "Proponer con IA" (según la falla de la
//     orden). Si se pasa onAgregar(item), cada pieza tiene botón "Agregar"
//     que la manda a la lista de refacciones necesarias de la orden:
//       item = { piezaManualId, refaccionId, texto, cantidad, origen: 'catalogo' }
//
//   CatalogoPartes.subirPdf({ file, modeloId, code, usuario, onProgreso })
//     (Panel) Lee el PDF en el navegador con pdf.js + ManualPartesParser,
//     recorta el dibujo de cada sección y lo sube sección por sección.
//
// Usa google.script.run (el mismo puente que el resto del Panel/Taller).
(function () {
  'use strict';

  var CSS = [
    '.cp-overlay{position:fixed;inset:0;background:rgba(0,0,0,.55);z-index:3000;display:flex;align-items:stretch;justify-content:center;padding:12px;box-sizing:border-box;font-family:inherit;}',
    '.cp-ventana{background:#fff;color:#222;border-radius:10px;width:100%;max-width:1200px;display:flex;flex-direction:column;overflow:hidden;box-shadow:0 10px 40px rgba(0,0,0,.35);}',
    '.cp-cabeza{display:flex;align-items:flex-start;gap:10px;padding:12px 14px;border-bottom:1px solid #e5e5e5;}',
    '.cp-titulo{flex:1;font-size:16px;font-weight:600;line-height:1.3;}',
    '.cp-equipo{display:block;font-size:12px;font-weight:400;color:#666;}',
    '.cp-cerrar{border:none;background:none;font-size:26px;line-height:1;cursor:pointer;color:#555;padding:0 4px;}',
    '.cp-barra{display:flex;flex-wrap:wrap;gap:8px;padding:10px 14px;border-bottom:1px solid #eee;align-items:center;}',
    '.cp-buscar{flex:1;min-width:200px;padding:8px 10px;border:1px solid #ccc;border-radius:6px;font-size:14px;}',
    '.cp-manual{padding:7px;border:1px solid #ccc;border-radius:6px;font-size:13px;max-width:260px;}',
    '.cp-btn{padding:8px 12px;border:1px solid #ccc;border-radius:6px;background:#fafafa;cursor:pointer;font-size:13px;white-space:nowrap;}',
    '.cp-btn:hover{border-color:#999;}',
    '.cp-btn:disabled{opacity:.55;cursor:default;}',
    '.cp-btn-ia{background:#f3ecff;border-color:#c9b2f5;color:#4b2a91;}',
    '.cp-aviso{display:none;margin:10px 14px 0;padding:10px 12px;border-radius:6px;background:#fff6e5;color:#7a4a17;font-size:13px;}',
    '.cp-aviso.cp-mostrar{display:block;}',
    '.cp-ia-panel{display:none;margin:10px 14px 0;padding:10px 12px;border-radius:6px;background:#f7f3ff;border:1px solid #ddd0f7;font-size:13px;}',
    '.cp-ia-panel.cp-mostrar{display:block;}',
    '.cp-ia-resumen{margin-bottom:6px;color:#3d2a6b;}',
    '.cp-ia-nota-fila{display:flex;gap:6px;margin-top:8px;flex-wrap:wrap;}',
    '.cp-ia-nota{flex:1;min-width:180px;padding:7px;border:1px solid #ccc;border-radius:6px;font-size:13px;}',
    '.cp-cuerpo{flex:1;display:grid;grid-template-columns:minmax(0,280px) minmax(0,1fr);min-height:0;}',
    '.cp-secciones{overflow:auto;border-right:1px solid #eee;padding:8px 0;}',
    '.cp-grupo{font-size:11px;font-weight:700;color:#888;text-transform:uppercase;padding:10px 14px 4px;letter-spacing:.03em;}',
    '.cp-sec{display:block;width:100%;text-align:left;border:none;background:none;padding:7px 14px;font-size:13px;cursor:pointer;color:#222;}',
    '.cp-sec:hover{background:#f4f4f4;}',
    '.cp-sec.cp-activa{background:#e8f1ff;color:#0b4fa8;font-weight:600;}',
    '.cp-sec small{color:#999;font-weight:400;margin-left:4px;}',
    '.cp-sec.cp-sec-ia{background:#f7f3ff;}',
    '.cp-detalle{overflow:auto;padding:12px 14px;}',
    '.cp-detalle h4{margin:0 0 2px;font-size:15px;}',
    '.cp-sub{font-size:12px;color:#777;margin-bottom:8px;}',
    '.cp-dibujo-wrap{overflow:auto;border:1px solid #eee;border-radius:6px;margin-bottom:10px;background:#fff;max-height:60vh;}',
    '.cp-dibujo{display:block;width:100%;max-width:760px;margin:0 auto;cursor:zoom-in;}',
    '.cp-dibujo.cp-zoom{width:200%;max-width:none;cursor:zoom-out;}',
    '.cp-tabla{width:100%;border-collapse:collapse;font-size:12.5px;}',
    '.cp-tabla th{position:sticky;top:0;background:#f6f6f6;text-align:left;padding:6px;border-bottom:1px solid #ddd;font-weight:600;}',
    '.cp-tabla td{padding:6px;border-bottom:1px solid #eee;vertical-align:top;}',
    '.cp-tabla tr.cp-propuesta td{background:#f7f3ff;}',
    '.cp-tabla tr.cp-resaltada td{background:#fff3c4;}',
    '.cp-motivo{display:block;font-size:11.5px;color:#4b2a91;margin-top:2px;}',
    '.cp-inv-si{color:#2f6f3a;font-weight:600;}',
    '.cp-inv-no{color:#8a8a8a;}',
    '.cp-notas{color:#666;font-size:11.5px;}',
    '.cp-agregar{padding:5px 10px;border:1px solid #5fa36a;color:#2f6f3a;background:#f2faf3;border-radius:5px;cursor:pointer;font-size:12px;white-space:nowrap;}',
    '.cp-agregar:disabled{opacity:.6;cursor:default;}',
    '.cp-vacio{color:#888;font-style:italic;padding:20px 0;}',
    '.cp-sec-movil{display:none;margin-top:3px;}',
    '.cp-col-codigo{white-space:nowrap;}',
    '.cp-ir{border:none;background:none;color:#0b5cad;cursor:pointer;padding:0;font-size:12px;text-decoration:underline;}',
    // El Panel tiene estilos generales para tablas/inputs (tema oscuro,
    // tablas de 1200px): aquí se anulan dentro del visor.
    '.cp-ventana table.cp-tabla{min-width:0;width:100%;}',
    '.cp-ventana .cp-tabla thead th{font-family:inherit;font-size:11.5px;letter-spacing:0;text-transform:none;color:#555;cursor:default;white-space:nowrap;padding:6px;}',
    '.cp-ventana .cp-tabla tbody td{color:#222;font-size:12.5px;padding:6px;}',
    '.cp-ventana input,.cp-ventana select{background:#fff;color:#222;font-family:inherit;}',
    '.cp-ventana input::placeholder{color:#888;}',
    '@media (max-width:760px){.cp-overlay{padding:0;}.cp-ventana{border-radius:0;}.cp-cuerpo{grid-template-columns:1fr;grid-template-rows:auto 1fr;}',
    '.cp-secciones{max-height:32vh;border-right:none;border-bottom:1px solid #eee;}.cp-tabla .cp-col-notas,.cp-tabla .cp-col-no,.cp-tabla .cp-col-sec,.cp-tabla .cp-col-cant{display:none;}.cp-sec-movil{display:block;}',
    '.cp-ventana .cp-tabla tbody td,.cp-ventana .cp-tabla thead th{padding:6px 4px;}.cp-detalle{padding:10px;}',
    '.cp-agregar{padding:5px 7px;}}',
  ].join('\n');

  function inyectarCss_() {
    if (document.getElementById('cp-estilos')) return;
    var st = document.createElement('style');
    st.id = 'cp-estilos';
    st.textContent = CSS;
    document.head.appendChild(st);
  }

  function esc_(s) {
    return (s === null || s === undefined ? '' : String(s))
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function norm_(s) {
    return (s || '').toString().normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase();
  }

  function llamar_(fn) {
    var args = Array.prototype.slice.call(arguments, 1);
    return new Promise(function (ok, mal) {
      var run = window.google && window.google.script && window.google.script.run;
      if (!run) { mal(new Error('No hay conexión con el servidor.')); return; }
      run.withSuccessHandler(ok).withFailureHandler(function (e) { mal(e instanceof Error ? e : new Error((e && e.message) || String(e))); })[fn].apply(null, args);
    });
  }

  // Quita el prefijo común de los grupos ("L3800DT MOTOR" -> "MOTOR").
  function nombresGrupo_(secciones) {
    var grupos = [];
    secciones.forEach(function (s) { if (s.grupo && grupos.indexOf(s.grupo) === -1) grupos.push(s.grupo); });
    var primeras = grupos.map(function (g) { return g.split(' ')[0]; });
    var comun = grupos.length > 1 && primeras.every(function (p) { return p === primeras[0]; }) ? primeras[0] + ' ' : '';
    return function (g) {
      if (!g) return 'Otras';
      return comun && g.indexOf(comun) === 0 ? g.slice(comun.length) : g;
    };
  }

  // =====================================================================
  // Visor
  // =====================================================================
  var V = null; // estado del visor abierto

  function abrir(opts) {
    inyectarCss_();
    cerrar();
    opts = opts || {};
    V = {
      opts: opts,
      datos: null,
      manual: null,
      seccionId: null,
      busqueda: '',
      resaltarPieza: null,
      propuesta: { secciones: [], piezas: {} },
      agregadas: {},
    };
    var ov = document.createElement('div');
    ov.className = 'cp-overlay';
    ov.id = 'cp-overlay';
    ov.innerHTML =
      '<div class="cp-ventana" role="dialog" aria-label="Catálogo de partes">' +
      '<div class="cp-cabeza"><div class="cp-titulo" id="cp-titulo">Catálogo de partes<span class="cp-equipo" id="cp-equipo"></span></div>' +
      '<button type="button" class="cp-cerrar" id="cp-cerrar" title="Cerrar">&times;</button></div>' +
      '<div class="cp-barra">' +
      '<input type="search" class="cp-buscar" id="cp-buscar" placeholder="Buscar pieza por nombre o número de parte...">' +
      '<select class="cp-manual" id="cp-manual" title="Otro catálogo"></select>' +
      (opts.orden ? '<button type="button" class="cp-btn cp-btn-ia" id="cp-ia">✨ Proponer con IA</button>' : '') +
      '</div>' +
      '<div class="cp-aviso" id="cp-aviso"></div>' +
      '<div class="cp-ia-panel" id="cp-ia-panel"><div class="cp-ia-resumen" id="cp-ia-resumen"></div>' +
      '<div id="cp-ia-lista"></div>' +
      '<div class="cp-ia-nota-fila"><input type="text" class="cp-ia-nota" id="cp-ia-nota" placeholder="¿No es eso? Describe la falla con tus palabras y vuelve a proponer">' +
      '<button type="button" class="cp-btn cp-btn-ia" id="cp-ia-otra">Volver a proponer</button></div></div>' +
      '<div class="cp-cuerpo"><div class="cp-secciones" id="cp-secciones"></div><div class="cp-detalle" id="cp-detalle"><div class="cp-vacio">Cargando catálogo...</div></div></div>' +
      '</div>';
    document.body.appendChild(ov);
    ov.addEventListener('click', function (e) { if (e.target === ov) cerrar(); });
    document.getElementById('cp-cerrar').addEventListener('click', cerrar);
    document.addEventListener('keydown', teclaEsc_);
    var buscar = document.getElementById('cp-buscar');
    buscar.addEventListener('input', function () { V.busqueda = buscar.value; pintarDetalle_(); });
    document.getElementById('cp-manual').addEventListener('change', function () {
      var id = Number(this.value);
      if (id) cargar_(id);
    });
    var btnIa = document.getElementById('cp-ia');
    if (btnIa) btnIa.addEventListener('click', function () { proponer_(''); });
    document.getElementById('cp-ia-otra').addEventListener('click', function () {
      proponer_(document.getElementById('cp-ia-nota').value.trim());
    });
    cargar_(opts.manualId || null);
  }

  function teclaEsc_(e) { if (e.key === 'Escape') cerrar(); }

  function cerrar() {
    var ov = document.getElementById('cp-overlay');
    if (ov) ov.parentNode.removeChild(ov);
    document.removeEventListener('keydown', teclaEsc_);
    V = null;
  }

  function aviso_(texto) {
    var el = document.getElementById('cp-aviso');
    if (!el) return;
    el.textContent = texto || '';
    el.className = 'cp-aviso' + (texto ? ' cp-mostrar' : '');
  }

  function cargar_(manualId) {
    var o = V.opts;
    var p = o.orden
      ? llamar_('getManualPartesOrden', o.code, o.usuario, o.orden, manualId || null)
      : llamar_('getManualPartes', o.code, o.usuario, manualId);
    var esteV = V;
    p.then(function (r) {
      if (V !== esteV) return;
      if (!r || !r.success) { aviso_((r && r.error) || 'No se pudo cargar el catálogo.'); pintarVacio_(''); return; }
      V.datos = r;
      V.manual = r.manual;
      V.propuesta = { secciones: [], piezas: {} };
      document.getElementById('cp-ia-panel').className = 'cp-ia-panel';
      pintarCabeza_();
      aviso_(r.aviso || '');
      if (!V.manual) { pintarVacio_('Sin catálogo para mostrar.'); return; }
      V.seccionId = V.manual.secciones.length ? V.manual.secciones[0].id : null;
      pintarSecciones_();
      pintarDetalle_();
    }).catch(function (e) {
      if (V !== esteV) return;
      aviso_((e && e.message) || 'No se pudo cargar el catálogo. Revisa tu conexión.');
      pintarVacio_('');
    });
  }

  function pintarVacio_(t) {
    document.getElementById('cp-secciones').innerHTML = '';
    document.getElementById('cp-detalle').innerHTML = t ? '<div class="cp-vacio">' + esc_(t) + '</div>' : '';
  }

  function pintarCabeza_() {
    var r = V.datos;
    var m = V.manual;
    var tit = document.getElementById('cp-titulo');
    var eq = r.equipo;
    tit.innerHTML = 'Catálogo de partes' + (m ? ' — ' + esc_((m.marca + ' ' + m.modelo).trim()) : '') +
      '<span class="cp-equipo">' +
      (eq ? esc_([eq.codigo, eq.unidad, eq.serie ? 'Serie ' + eq.serie : '', V.opts.orden ? 'Orden ' + V.opts.orden : ''].filter(Boolean).join(' · ')) : '') +
      (m ? (eq ? ' · ' : '') + m.secciones.length + ' secciones' : '') + '</span>';
    var sel = document.getElementById('cp-manual');
    var disp = r.disponibles || [];
    sel.innerHTML = (m ? '' : '<option value="">Elegir catálogo...</option>') +
      disp.map(function (d) {
        return '<option value="' + d.id + '"' + (m && m.id === d.id ? ' selected' : '') + '>' + esc_((d.marca + ' ' + d.modelo).trim()) + '</option>';
      }).join('');
    sel.style.display = disp.length > (m ? 1 : 0) ? '' : 'none';
    var btnIa = document.getElementById('cp-ia');
    if (btnIa) btnIa.disabled = !m;
  }

  function pintarSecciones_() {
    var m = V.manual;
    var cont = document.getElementById('cp-secciones');
    var nombre = nombresGrupo_(m.secciones);
    var html = '';
    var boton = function (s, ia) {
      return '<button type="button" class="cp-sec' + (s.id === V.seccionId && !V.busqueda ? ' cp-activa' : '') + (ia ? ' cp-sec-ia' : '') +
        '" data-sec="' + s.id + '">' + (ia ? '✨ ' : '') + esc_(s.titulo) + (s.serie ? ' <small>' + esc_(s.serie) + '</small>' : '') + '</button>';
    };
    if (V.propuesta.secciones.length) {
      html += '<div class="cp-grupo">Propuestas por la IA</div>';
      V.propuesta.secciones.forEach(function (id) {
        var s = m.secciones.find(function (x) { return x.id === id; });
        if (s) html += boton(s, true);
      });
    }
    var grupos = [];
    m.secciones.forEach(function (s) {
      var g = nombre(s.grupo);
      var grupo = grupos.find(function (x) { return x.g === g; });
      if (!grupo) grupos.push(grupo = { g: g, secs: [] });
      grupo.secs.push(s);
    });
    grupos.forEach(function (g) {
      html += '<div class="cp-grupo">' + esc_(g.g) + '</div>';
      g.secs.slice().sort(function (a, b) { return a.titulo.localeCompare(b.titulo, 'es'); }).forEach(function (s) { html += boton(s, false); });
    });
    cont.innerHTML = html;
    Array.prototype.forEach.call(cont.querySelectorAll('.cp-sec'), function (b) {
      b.addEventListener('click', function () { irASeccion_(Number(b.getAttribute('data-sec')), null); });
    });
  }

  function irASeccion_(id, piezaId) {
    V.seccionId = id;
    V.resaltarPieza = piezaId || null;
    if (V.busqueda) {
      V.busqueda = '';
      document.getElementById('cp-buscar').value = '';
    }
    pintarSecciones_();
    pintarDetalle_();
    var det = document.getElementById('cp-detalle');
    if (piezaId) {
      var fila = det.querySelector('tr[data-pieza="' + piezaId + '"]');
      if (fila && fila.scrollIntoView) fila.scrollIntoView({ block: 'center' });
    } else det.scrollTop = 0;
  }

  function filaPieza_(p, seccion, conSeccion) {
    var puede = !!V.opts.onAgregar;
    var motivo = V.propuesta.piezas[p.id];
    var inv = !p.codigo
      ? '<span class="cp-inv-no">No se vende sola</span>'
      : p.refaccionId
        ? '<span class="cp-inv-si" title="' + esc_(p.refaccionTexto) + '">✓ ' + esc_(p.refaccionCodigo || 'En catálogo') + '</span>' + (p.folioComercial ? '<br><span class="cp-notas">Folio ' + esc_(p.folioComercial) + '</span>' : '')
        : '<span class="cp-inv-no"' + (puede ? ' title="Si la agregas, se da de alta en Refacciones al guardar"' : '') + '>No está en Refacciones</span>';
    var notas = [p.serie ? 'Serie ' + p.serie : '', p.observaciones].filter(Boolean).join(' · ');
    var accion = '';
    if (puede) {
      var ya = V.agregadas[p.id];
      accion = '<button type="button" class="cp-agregar" data-agregar="' + p.id + '"' + (ya ? ' disabled' : '') + '>' + (ya ? '✓ Agregada' : 'Agregar') + '</button>';
    }
    return '<tr data-pieza="' + p.id + '" class="' + (motivo !== undefined ? 'cp-propuesta' : '') + (V.resaltarPieza === p.id ? ' cp-resaltada' : '') + '">' +
      (conSeccion ? '<td class="cp-col-sec"><button type="button" class="cp-ir" data-ir="' + seccion.id + '" data-ir-pieza="' + p.id + '">' + esc_(seccion.titulo) + '</button></td>' : '') +
      '<td class="cp-col-no">' + esc_(p.ref) + '</td>' +
      '<td class="cp-col-codigo">' + esc_(p.codigo || '—') + '</td>' +
      '<td>' + esc_(p.descripcion) + (motivo ? '<span class="cp-motivo">✨ ' + esc_(motivo) + '</span>' : '') +
      (p.cantidad !== null && p.cantidad !== undefined ? '<span class="cp-sec-movil cp-notas">Lleva ' + esc_(p.cantidad) + '</span>' : '') +
      (conSeccion ? '<span class="cp-sec-movil"><button type="button" class="cp-ir" data-ir="' + seccion.id + '" data-ir-pieza="' + p.id + '">' + esc_(seccion.titulo) + '</button></span>' : '') + '</td>' +
      '<td class="cp-col-cant">' + (p.cantidad !== null && p.cantidad !== undefined ? esc_(p.cantidad) : '') + '</td>' +
      '<td class="cp-col-notas"><span class="cp-notas">' + esc_(notas) + '</span></td>' +
      '<td>' + inv + '</td>' +
      (puede ? '<td>' + accion + '</td>' : '') +
      '</tr>';
  }

  function encabezadoTabla_(conSeccion) {
    return '<table class="cp-tabla"><thead><tr>' + (conSeccion ? '<th class="cp-col-sec">Sección</th>' : '') +
      '<th class="cp-col-no">No.</th><th>No. de parte</th><th>Descripción</th><th class="cp-col-cant">Cant.</th><th class="cp-col-notas">Notas</th><th>Inventario</th>' +
      (V.opts.onAgregar ? '<th></th>' : '') + '</tr></thead><tbody>';
  }

  function pintarDetalle_() {
    var det = document.getElementById('cp-detalle');
    var m = V.manual;
    if (!m) return;
    var q = norm_(V.busqueda).trim();
    var html = '';
    if (q.length >= 2) {
      var qCodigo = q.replace(/[^0-9A-Z]/g, '');
      var palabras = q.split(/\s+/).filter(Boolean);
      var res = [];
      m.secciones.forEach(function (s) {
        var tit = norm_(s.titulo);
        s.piezas.forEach(function (p) {
          var texto = norm_(p.descripcion + ' ' + p.observaciones + ' ' + p.codigo + ' ' + p.refaccionCodigo + ' ' + p.folioComercial) + ' ' + tit;
          var porCodigo = qCodigo.length >= 4 && p.codigo.toUpperCase().replace(/[^0-9A-Z]/g, '').indexOf(qCodigo) !== -1;
          if (porCodigo || palabras.every(function (w) { return texto.indexOf(w) !== -1; })) res.push({ p: p, s: s });
        });
      });
      html += '<h4>Resultados de "' + esc_(V.busqueda.trim()) + '"</h4><div class="cp-sub">' + res.length + ' pieza(s)' + (res.length > 200 ? ' — se muestran las primeras 200' : '') + '</div>';
      if (!res.length) html += '<div class="cp-vacio">No se encontró ninguna pieza. Prueba con otra palabra (p. ej. "reten", "junta", "filtro") o con el número de parte.</div>';
      else {
        html += encabezadoTabla_(true);
        res.slice(0, 200).forEach(function (x) { html += filaPieza_(x.p, x.s, true); });
        html += '</tbody></table>';
      }
    } else {
      var s = m.secciones.find(function (x) { return x.id === V.seccionId; }) || m.secciones[0];
      if (!s) { det.innerHTML = '<div class="cp-vacio">Este catálogo no tiene secciones.</div>'; return; }
      html += '<h4>' + esc_(s.titulo) + '</h4><div class="cp-sub">' + esc_([s.codigo, s.grupo, s.aplica, s.serie].filter(Boolean).join(' · ')) + '</div>';
      if (s.imagenUrl) {
        html += '<div class="cp-dibujo-wrap"><img class="cp-dibujo" id="cp-dibujo" alt="Dibujo de ' + esc_(s.titulo) + '" src="' + esc_(s.imagenUrl) + '" title="Clic para acercar"></div>';
      }
      html += encabezadoTabla_(false);
      s.piezas.forEach(function (p) { html += filaPieza_(p, s, false); });
      html += '</tbody></table>';
    }
    det.innerHTML = html;
    var img = document.getElementById('cp-dibujo');
    if (img) img.addEventListener('click', function () { img.classList.toggle('cp-zoom'); });
    Array.prototype.forEach.call(det.querySelectorAll('[data-agregar]'), function (b) {
      b.addEventListener('click', function () { agregar_(Number(b.getAttribute('data-agregar')), b); });
    });
    Array.prototype.forEach.call(det.querySelectorAll('[data-ir]'), function (b) {
      b.addEventListener('click', function () { irASeccion_(Number(b.getAttribute('data-ir')), Number(b.getAttribute('data-ir-pieza'))); });
    });
  }

  function buscarPieza_(id) {
    var m = V.manual;
    for (var i = 0; i < m.secciones.length; i++) {
      var p = m.secciones[i].piezas.find(function (x) { return x.id === id; });
      if (p) return { p: p, s: m.secciones[i] };
    }
    return null;
  }

  function agregar_(id, boton) {
    var x = buscarPieza_(id);
    if (!x || !V.opts.onAgregar) return;
    var p = x.p;
    V.opts.onAgregar({
      piezaManualId: p.codigo ? p.id : null,
      refaccionId: p.refaccionId || null,
      texto: p.refaccionId ? p.refaccionTexto : ((p.codigo ? p.codigo + ' - ' : '') + p.descripcion + ' (' + (V.manual.marca + ' ' + V.manual.modelo).trim() + ')'),
      cantidad: 1,
      origen: 'catalogo',
    });
    V.agregadas[id] = true;
    // Todas las filas de esa pieza (puede verse en la propuesta y en la tabla).
    Array.prototype.forEach.call(document.querySelectorAll('[data-agregar="' + id + '"]'), function (b) {
      b.disabled = true;
      b.textContent = '✓ Agregada';
    });
  }

  function proponer_(nota) {
    if (!V || !V.manual || !V.opts.orden) return;
    var panel = document.getElementById('cp-ia-panel');
    var resumen = document.getElementById('cp-ia-resumen');
    var lista = document.getElementById('cp-ia-lista');
    var btns = [document.getElementById('cp-ia'), document.getElementById('cp-ia-otra')];
    btns.forEach(function (b) { if (b) b.disabled = true; });
    panel.className = 'cp-ia-panel cp-mostrar';
    resumen.textContent = 'La IA está revisando la falla y el catálogo... (tarda unos segundos)';
    lista.innerHTML = '';
    var esteV = V;
    llamar_('proponerPiezasManual', V.opts.code, V.opts.usuario, V.opts.orden, V.manual.id, nota || '')
      .then(function (r) {
        if (V !== esteV) return;
        btns.forEach(function (b) { if (b) b.disabled = false; });
        if (!r || !r.success) { resumen.textContent = (r && r.error) || 'No se pudo obtener la propuesta.'; return; }
        V.propuesta = { secciones: r.secciones || [], piezas: {} };
        (r.piezas || []).forEach(function (x) { V.propuesta.piezas[x.id] = x.motivo || ''; });
        resumen.textContent = (r.resumen ? r.resumen + ' ' : '') + (r.piezas && r.piezas.length ? 'Piezas sugeridas:' : 'Revisa las secciones marcadas con ✨.');
        if (r.piezas && r.piezas.length) {
          var html = encabezadoTabla_(true);
          r.piezas.forEach(function (x) {
            var e = buscarPieza_(x.id);
            if (e) html += filaPieza_(e.p, e.s, true);
          });
          lista.innerHTML = html + '</tbody></table>';
          Array.prototype.forEach.call(lista.querySelectorAll('[data-agregar]'), function (b) {
            b.addEventListener('click', function () { agregar_(Number(b.getAttribute('data-agregar')), b); });
          });
          Array.prototype.forEach.call(lista.querySelectorAll('[data-ir]'), function (b) {
            b.addEventListener('click', function () { irASeccion_(Number(b.getAttribute('data-ir')), Number(b.getAttribute('data-ir-pieza'))); });
          });
        }
        if (V.propuesta.secciones.length) V.seccionId = V.propuesta.secciones[0];
        pintarSecciones_();
        pintarDetalle_();
      })
      .catch(function (e) {
        if (V !== esteV) return;
        btns.forEach(function (b) { if (b) b.disabled = false; });
        resumen.textContent = (e && e.message) || 'No se pudo obtener la propuesta. Revisa tu conexión.';
      });
  }

  // =====================================================================
  // Subir PDF (Panel)
  // =====================================================================
  var pdfjsPromesa_ = null;
  function cargarPdfJs_() {
    if (!pdfjsPromesa_) {
      pdfjsPromesa_ = import('/vendor/pdfjs/pdf.min.mjs').then(function (m) {
        m.GlobalWorkerOptions.workerSrc = '/vendor/pdfjs/pdf.worker.min.mjs';
        return m;
      });
      pdfjsPromesa_.catch(function () { pdfjsPromesa_ = null; });
    }
    return pdfjsPromesa_;
  }

  // Textos con posición de cada página (formato que espera ManualPartesParser).
  function leerPdf(file, onProgreso) {
    return cargarPdfJs_().then(function (pdfjs) {
      return file.arrayBuffer().then(function (buf) {
        return pdfjs.getDocument({ data: new Uint8Array(buf), isEvalSupported: false }).promise;
      });
    }).then(function (doc) {
      var paginas = [];
      var n = 0;
      function siguiente() {
        n++;
        if (n > doc.numPages) return Promise.resolve({ doc: doc, paginas: paginas });
        if (onProgreso) onProgreso('Leyendo página ' + n + ' de ' + doc.numPages + '...');
        return doc.getPage(n).then(function (pg) {
          var vp = pg.getViewport({ scale: 1 });
          return pg.getTextContent().then(function (tc) {
            paginas.push({
              numero: n,
              width: vp.width,
              height: vp.height,
              items: tc.items.filter(function (i) { return i.str && i.str.trim(); }).map(function (i) {
                return { str: i.str, x: i.transform[4], y: vp.height - i.transform[5], w: i.width };
              }),
            });
            return siguiente();
          });
        });
      }
      return siguiente();
    });
  }

  function recortarDibujo_(doc, seccion) {
    if (!seccion.dibujo || !seccion.paginaDibujo) return Promise.resolve(null);
    var escala = 2;
    return doc.getPage(seccion.paginaDibujo).then(function (pg) {
      var vp = pg.getViewport({ scale: escala });
      var lienzo = document.createElement('canvas');
      lienzo.width = Math.ceil(vp.width);
      lienzo.height = Math.ceil(vp.height);
      var ctx = lienzo.getContext('2d');
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, lienzo.width, lienzo.height);
      return pg.render({ canvasContext: ctx, viewport: vp }).promise.then(function () {
        var y0 = Math.max(0, Math.floor(seccion.dibujo.y0 * escala));
        var y1 = Math.min(lienzo.height, Math.ceil(seccion.dibujo.y1 * escala));
        var x0 = Math.floor(10 * escala);
        var ancho = lienzo.width - 2 * x0;
        var alto = Math.max(1, y1 - y0);
        var recorte = document.createElement('canvas');
        recorte.width = ancho;
        recorte.height = alto;
        var c2 = recorte.getContext('2d');
        c2.fillStyle = '#fff';
        c2.fillRect(0, 0, ancho, alto);
        c2.drawImage(lienzo, x0, y0, ancho, alto, 0, 0, ancho, alto);
        return recorte.toDataURL('image/jpeg', 0.82);
      });
    });
  }

  function subirPdf(o) {
    var progreso = o.onProgreso || function () {};
    var parser = window.ManualPartesParser;
    if (!parser) return Promise.reject(new Error('Falta el lector de catálogos (manualPartesParser.js). Recarga la página.'));
    var doc = null;
    var secciones = null;
    var manualId = null;
    return leerPdf(o.file, progreso).then(function (r) {
      doc = r.doc;
      secciones = parser.leerCatalogo(r.paginas);
      if (!secciones.length) {
        throw new Error('No se encontró ninguna tabla de piezas en el PDF. Por ahora se leen catálogos con el formato de Kubota ' +
          '(No. | Código de pieza | Descripción | Cant ...). Si es de otra marca, mándaselo a Claude para agregar ese formato.');
      }
      progreso('Se encontraron ' + secciones.length + ' secciones. Guardando...');
      return llamar_('crearManualPartes', o.code, o.usuario, { modeloId: o.modeloId, nombreArchivo: o.file.name, paginas: doc.numPages });
    }).then(function (r) {
      if (!r || !r.success) throw new Error((r && r.error) || 'No se pudo empezar a guardar el catálogo.');
      manualId = r.id;
      var i = 0;
      function guardarUna(intento) {
        if (i >= secciones.length) return Promise.resolve();
        var s = secciones[i];
        progreso('Guardando sección ' + (i + 1) + ' de ' + secciones.length + ': ' + s.titulo);
        return recortarDibujo_(doc, s).then(function (img) {
          var datos = { orden: i, codigo: s.codigo, titulo: s.titulo, aplica: s.aplica, serie: s.serie, grupo: s.grupo, piezas: s.piezas };
          return llamar_('guardarSeccionManualPartes', o.code, o.usuario, manualId, datos, img);
        }).then(function (res) {
          if (!res || !res.success) throw new Error((res && res.error) || 'No se pudo guardar la sección ' + s.titulo);
          i++;
          return guardarUna(0);
        }, function (err) {
          if (intento < 2) return guardarUna(intento + 1); // reintenta (internet lento)
          throw err;
        });
      }
      return guardarUna(0);
    }).then(function () {
      progreso('Terminando...');
      return llamar_('terminarManualPartes', o.code, o.usuario, manualId);
    }).then(function (r) {
      if (!r || !r.success) throw new Error((r && r.error) || 'No se pudo terminar de guardar el catálogo.');
      return r;
    });
  }

  window.CatalogoPartes = { abrir: abrir, cerrar: cerrar, subirPdf: subirPdf, leerPdf: leerPdf };
})();
