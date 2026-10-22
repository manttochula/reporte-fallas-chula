// Handlers equivalentes, uno a uno, a las funciones de Codigo.gs que el
// frontend llamaba con google.script.run.<funcion>(...). Cada función aquí
// recibe los mismos argumentos y regresa (o lanza) exactamente lo mismo que
// su contraparte en Apps Script, para que los 4 archivos HTML casi no
// tuvieran que cambiar.
require('dotenv').config();
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const pool = require('./db');
const { siguienteFolio_, tieneAccesoModulo_, requiereClave_, tienePermisoPanel_ } = require('./helpers');
const { guardarArchivo_ } = require('./storage');
const avisos = require('./avisos');
const {
  preguntarleAClaudeSobreImagen_,
  preguntarleAClaudeSobreImagenes_,
  preguntarleAClaudeTexto_,
  extraerJson_,
} = require('./ia');

const HISTORY_ACCESS_CODE = process.env.HISTORY_ACCESS_CODE || 'CHULA2026';
const TALLER_ACCESS_CODE = process.env.TALLER_ACCESS_CODE || 'Operacion';

// Las pestañas del Panel tal cual las conoce el usuario (mismos nombres
// que se guardan en usuarios.panel_permisos). Maquinaria y Catálogo
// comparten los mismos datos/acciones (ver getMaquinaria/guardarMaquinaria/
// eliminarMaquinaria) — por eso, para esas acciones, basta con tener
// permiso en CUALQUIERA de las dos. "combustible_automotriz" es aparte de
// "diesel": son pestañas y permisos independientes (autos vs. maquinaria
// agrícola) — ver combustible_automotriz en schema.sql. Mismo criterio para
// "servicios_automotrices" contra "mantenimiento" (Preventivos Agrícolas):
// mismo motor por debajo (mantenimiento_reglas/mantenimiento_servicios),
// pero pestañas y permisos independientes para poder dar uno sin el otro.
// "ordenes_soldadura"/"ordenes_automotriz"/"ordenes_llantas"/"ordenes_terceros"
// son permisos independientes de "ordenes" para los otros cuatro apartados
// de la pestaña Órdenes (Soldadura, Automotriz, Llantas y Ponches, y
// Reparaciones con terceros respectivamente) — "ordenes" sigue siendo el de
// Agrícola/principal, para no migrar a nadie. Un mismo usuario puede tener
// niveles distintos en cada uno (ej. visualizar en Soldadura pero capturar
// en Agrícola) — ver permisoDeSeccionOrden_/seccionDeFila_ más abajo, que
// traducen cada orden a cuál de los cinco le corresponde.
// "avance_huerta": pestaña nueva del Panel para ver el mapa de avance de
// cada huerta (ver sección "Avance de huerta" más abajo). 'capturar' en
// este permiso es, además, lo que se revisa (sin la clave compartida del
// Panel, ver requierePermisoAvanceHuerta_) para dejar calibrar el mapa
// desde el celular -- no cualquier operador puede recalibrar, solo a quien
// Carlos le dé este permiso.
const PESTANAS_PANEL = ['ordenes', 'ordenes_soldadura', 'ordenes_automotriz', 'ordenes_llantas', 'ordenes_terceros', 'diesel', 'combustible_automotriz', 'movimientos', 'maquinaria', 'catalogo', 'mantenimiento', 'servicios_automotrices', 'refacciones', 'insumos', 'usuarios', 'avance_huerta', 'indicadores'];

// Verifica primero la clave compartida del Panel (igual que antes, como
// primera barrera), y luego el permiso específico de ESE usuario para la(s)
// pestaña(s) dada(s), al nivel pedido ('visualizar' o 'capturar'). Lanza un
// error (mismo patrón que requiereClave_) si algo no cuadra.
async function requierePermisoPanel_(code, nombreUsuario, pestanas, nivelRequerido) {
  requiereClave_(code, TALLER_ACCESS_CODE);
  const nombre = (nombreUsuario || '').toString().trim();
  if (!nombre) throw new Error('No se identificó al usuario del Panel.');
  const [rows] = await pool.query(
    'SELECT panel_permisos FROM usuarios WHERE LOWER(TRIM(nombre)) = LOWER(TRIM(?))',
    [nombre]
  );
  if (rows.length === 0) throw new Error('Usuario no encontrado.');
  if (!tienePermisoPanel_(rows[0].panel_permisos, pestanas, nivelRequerido)) {
    throw new Error('Tu usuario no tiene permiso de ' + nivelRequerido + ' en esta sección del Panel.');
  }
}

// Variante de requierePermisoPanel_ SIN la clave compartida del Panel —
// para la calibración del mapa de Avance de huerta, que se hace desde el
// celular (Index.html), no desde el Panel de escritorio, y el celular no
// maneja ni manda esa clave compartida (mismo nivel de confianza que
// submitReporte: con haber iniciado sesión con su nombre ya basta). Aun
// así, calibrar SÍ exige tener el permiso 'avance_huerta' en 'capturar'
// configurado desde Usuarios — no cualquiera que reporta fallas puede
// recalibrar el mapa de todos.
async function requierePermisoAvanceHuerta_(nombreUsuario, nivelRequerido) {
  const nombre = (nombreUsuario || '').toString().trim();
  if (!nombre) throw new Error('No se identificó a la persona.');
  const [rows] = await pool.query(
    'SELECT panel_permisos FROM usuarios WHERE LOWER(TRIM(nombre)) = LOWER(TRIM(?))',
    [nombre]
  );
  if (rows.length === 0) throw new Error('Usuario no encontrado.');
  if (!tienePermisoPanel_(rows[0].panel_permisos, 'avance_huerta', nivelRequerido)) {
    throw new Error('Tu usuario no tiene permiso para calibrar el mapa de avance. Pide que te lo den desde el Panel (Usuarios).');
  }
}

// getReportesTaller/actualizarOrden las usan TANTO el Panel (pestaña
// Órdenes) COMO Taller.html (que es una app aparte, sin el sistema de
// permisos por pestaña del Panel — solo pide la clave compartida, igual
// que Movimientos; ver el comentario en schema.sql junto a panel_permisos).
// Cuando la llamada viene del Panel, PANEL_USUARIO siempre va como
// nombreUsuario y ese usuario tiene panel_permisos configurado, así que
// aplicamos el permiso por pestaña de siempre. Cuando viene de Taller (no
// manda nombreUsuario, o manda el nombre del mecánico solo para la
// bitácora de auditoría, pero ese nombre no tiene panel_permisos), basta
// con la clave compartida.
// "pestana" permite exigir el permiso de una sección específica de Órdenes
// ('ordenes', 'ordenes_soldadura' u 'ordenes_automotriz', o un arreglo con
// varias — ver permisoDeSeccionOrden_ más abajo); si no se manda, se
// comporta igual que antes (exige 'ordenes', Agrícola/principal).
async function requiereAccesoOrdenes_(code, nombreUsuario, nivelPanelRequerido, pestana) {
  const nombre = (nombreUsuario || '').toString().trim();
  if (!nombre) {
    requiereClave_(code, TALLER_ACCESS_CODE);
    return;
  }
  const [rows] = await pool.query(
    'SELECT panel_permisos FROM usuarios WHERE LOWER(TRIM(nombre)) = LOWER(TRIM(?))',
    [nombre]
  );
  const esUsuarioDePanel = rows.length > 0 && !!rows[0].panel_permisos;
  if (esUsuarioDePanel) {
    await requierePermisoPanel_(code, nombre, pestana || 'ordenes', nivelPanelRequerido);
  } else {
    requiereClave_(code, TALLER_ACCESS_CODE);
  }
}

// A qué permiso de Panel corresponde cada sección de la pestaña Órdenes.
// 'ordenes' sigue siendo el de Agrícola/principal (así nadie pierde acceso
// al agregarse los demás); cada una de las otras cuatro tiene el suyo,
// independiente.
function permisoDeSeccionOrden_(seccion) {
  if (seccion === 'soldadura') return 'ordenes_soldadura';
  if (seccion === 'automotriz') return 'ordenes_automotriz';
  if (seccion === 'llantas') return 'ordenes_llantas';
  if (seccion === 'terceros') return 'ordenes_terceros';
  return 'ordenes';
}

// Misma sección que seccionDeOrden_ del cliente (Panel.html) — a partir de
// una fila de la tabla reportes (columnas es_soldadura/es_automotriz/
// es_llantas/es_terceros). Orden de prioridad si por algún motivo más de
// una bandera estuviera activa a la vez: Soldadura > Automotriz > Llantas y
// Ponches > Reparaciones con terceros > Agrícola/principal. Las cinco
// secciones son mutuamente excluyentes en la práctica (el modal de
// crear/editar orden solo deja marcar una a la vez).
function seccionDeFila_(fila) {
  if (fila && Number(fila.es_soldadura)) return 'soldadura';
  if (fila && Number(fila.es_automotriz)) return 'automotriz';
  if (fila && Number(fila.es_llantas)) return 'llantas';
  if (fila && Number(fila.es_terceros)) return 'terceros';
  return 'principal';
}

// Para acciones sobre una orden YA EXISTENTE identificada solo por su folio
// (ej. interpretar/guardar refacciones necesarias): busca a qué sección
// pertenece y exige el permiso de Panel de esa sección específica. Mismo
// mecanismo de siempre para Taller.html (requiereAccesoOrdenes_ ya resuelve
// ese caso sin distinguir sección). Lanza error si la orden no existe.
async function requiereAccesoOrdenSeccionPorFolio_(code, nombreUsuario, orden, nivelPanelRequerido) {
  const [rows] = await pool.query('SELECT es_soldadura, es_automotriz, es_llantas, es_terceros FROM reportes WHERE orden = ?', [orden]);
  if (rows.length === 0) throw new Error('No se encontró la orden ' + orden + '.');
  await requiereAccesoOrdenes_(code, nombreUsuario, nivelPanelRequerido, permisoDeSeccionOrden_(seccionDeFila_(rows[0])));
}

// Restricción opcional, por usuario, de qué huertas puede ver/editar/crear
// en el Panel (columna usuarios.huertas_ordenes, ver db/schema.sql). Se
// llama "huertas_ordenes" por cómo empezó (solo para la pestaña Órdenes),
// pero ahora la misma lista se usa también para restringir Combustible
// Agrícola (cargas/entregas de diesel) y Preventivos Agrícolas (servicios
// por equipo) — una sola lista por usuario, no una distinta por pestaña.
// Regresa un arreglo de huertas (ya en mayúsculas/trim) si esa persona está
// restringida, o null si no lo está (ve/edita todas, el comportamiento de
// siempre). Se consulta por nombre, igual que panel_permisos — así que
// aplica tanto si la llamada viene del Panel como si por coincidencia
// alguien usa ese mismo nombre en Taller.
async function obtenerHuertasRestringidasUsuario_(nombreUsuario) {
  const nombre = (nombreUsuario || '').toString().trim();
  if (!nombre) return null;
  const [rows] = await pool.query(
    'SELECT huertas_ordenes FROM usuarios WHERE LOWER(TRIM(nombre)) = LOWER(TRIM(?))',
    [nombre]
  );
  if (!rows.length || !rows[0].huertas_ordenes) return null;
  try {
    const lista = JSON.parse(rows[0].huertas_ordenes);
    if (Array.isArray(lista) && lista.length > 0) {
      return lista.map((h) => (h || '').toString().trim().toUpperCase()).filter(Boolean);
    }
  } catch (err) {
    // JSON inválido en la columna: se trata igual que "sin restricción",
    // para no dejar a alguien bloqueado por un dato corrupto.
  }
  return null;
}

function huertaPermitida_(huertasRestringidas, huerta) {
  if (!huertasRestringidas) return true;
  const h = (huerta || '').toString().trim().toUpperCase();
  return huertasRestringidas.indexOf(h) !== -1;
}

// Deja constancia en la bitácora de auditoría de quién capturó, editó o
// eliminó una orden/carga de diesel/movimiento — sobrevive aunque el
// registro original se borre después. `detalle` es un texto libre breve
// (p.ej. "AF-307 — No arranca") para poder identificar el registro en la
// bitácora aunque ya no exista.
async function registrarAuditoria_(tabla, registro, accion, usuario, detalle) {
  try {
    await pool.query(
      'INSERT INTO auditoria (tabla, registro, accion, usuario, detalle) VALUES (?, ?, ?, ?, ?)',
      [tabla, String(registro), accion, (usuario || '').toString().trim() || 'Desconocido', detalle || null]
    );
  } catch (err) {
    // No dejamos que un problema al escribir la bitácora tumbe la acción
    // real (capturar/editar/eliminar) que el usuario sí necesita que pase.
    console.error('No se pudo registrar en la bitácora de auditoría:', err);
  }
}

// Columnas de `reportes` -> nombres de campo que ya espera el frontend
// (idénticos a los encabezados que usaba la hoja de Google Sheets).
// LEFT JOIN con mantenimiento_ordenes/mantenimiento_reglas: le dice al
// frontend (Taller) si esta orden viene de una regla de Mantenimiento
// preventivo (ReglaMantenimientoId), con qué lectura se generó
// (LecturaGeneracion) y con qué lectura se cerró la última vez
// (LecturaCierre), y de qué tipo es la regla (TipoPeriodicidadRegla:
// 'horas' | 'kilometros' | 'tiempo') para saber si tiene sentido pedir
// un horómetro/kilometraje al cerrarla. Todas las columnas de `reportes`
// se califican con el nombre de la tabla porque, una vez con los JOIN,
// varias columnas (orden, codigo_unidad, id...) existen en más de una
// tabla.
const REPORTE_SELECT = `
  SELECT
    reportes.orden                       AS Orden,
    reportes.codigo_unidad                AS CodigoUnidad,
    reportes.unidad                       AS Unidad,
    reportes.huerta                       AS Huerta,
    reportes.descripcion                  AS Descripcion,
    reportes.nombre                       AS Nombre,
    reportes.fecha                        AS Fecha,
    reportes.foto_url                     AS FotoURL,
    reportes.descripcion_audio_url        AS DescripcionAudioURL,
    reportes.trabajo_realizado            AS TrabajoRealizado,
    reportes.trabajo_realizado_audio_url  AS TrabajoRealizadoAudioURL,
    reportes.fecha_atencion                AS FechaAtencion,
    reportes.fecha_salida                  AS FechaSalida,
    reportes.refaccionamiento               AS Refaccionamiento,
    reportes.atendio_por                    AS AtendioPor,
    reportes.evidencia_url                   AS EvidenciaURL,
    reportes.visto_bueno                      AS VistoBueno,
    reportes.comentario_reportante              AS ComentarioReportante,
    reportes.modificado_por                       AS ModificadoPor,
    reportes.modificado_en                         AS ModificadoEn,
    reportes.observaciones_staff                    AS ObservacionesStaff,
    reportes.dias_atencion                           AS DiasAtencion,
    reportes.es_soldadura                             AS EsSoldadura,
    reportes.es_automotriz                             AS EsAutomotriz,
    reportes.es_llantas                                 AS EsLlantas,
    reportes.es_terceros                                 AS EsTerceros,
    reportes.costo_reparacion                             AS CostoReparacion,
    reportes.en_proceso_sin_fecha                       AS EnProcesoSinFecha,
    reportes.semana_en_proceso                          AS SemanaEnProceso,
    (SELECT COUNT(*) FROM reportes_refacciones_necesarias rrn WHERE rrn.orden = reportes.orden) AS RefaccionesNecesariasCount,
    (SELECT COUNT(*) FROM reportes_refacciones_necesarias rrn WHERE rrn.orden = reportes.orden AND rrn.entregado = 1) AS RefaccionesEntregadasCount,
    mo.regla_id                          AS ReglaMantenimientoId,
    mo.lectura_generacion                AS LecturaGeneracion,
    mo.lectura_cierre                    AS LecturaCierre,
    mr.tipo_periodicidad                 AS TipoPeriodicidadRegla,
    m.departamento                       AS Departamento,
    m.operador_asignado                  AS OperadorAsignado,
    m.admite_terceros                    AS AdmiteTerceros
  FROM reportes
  LEFT JOIN mantenimiento_ordenes mo ON mo.orden = reportes.orden
  LEFT JOIN mantenimiento_reglas mr ON mr.id = mo.regla_id
  LEFT JOIN maquinaria m ON m.codigo_unidad = reportes.codigo_unidad
`;

// LEFT JOIN (no INNER) a propósito: una carga de diesel vieja puede seguir
// apuntando a un codigo_unidad que ya se borró del Catálogo — con LEFT JOIN
// esa carga se sigue listando igual (solo con Departamento vacío), en vez
// de desaparecer de la lista.
// Empresa/Proveedor de una carga agrícola NO se capturan por carga (a
// diferencia de Combustible Automotriz) — se derivan de la Huerta que trae
// esa carga (d.huerta, texto libre histórico) contra el catálogo de Huertas
// y su Empresa/Proveedor asignados (huertas.empresa_id/proveedor_id, ver
// getHuertasCatalogo). Es un LEFT JOIN por nombre a propósito: si la huerta
// ya no existe en el catálogo, o no tiene Empresa/Proveedor asignado, la
// carga se sigue listando igual, solo con Empresa/Proveedor vacíos.
const DIESEL_SELECT = `
  SELECT
    d.id                AS Id,
    d.folio             AS Folio,
    d.codigo_unidad     AS CodigoUnidad,
    d.unidad            AS Unidad,
    d.huerta            AS Huerta,
    d.litros            AS Litros,
    d.lectura           AS Lectura,
    d.nombre            AS Nombre,
    d.operador          AS Operador,
    d.fecha             AS Fecha,
    d.codigo_implemento AS CodigoImplemento,
    d.implemento        AS Implemento,
    d.modificado_por    AS ModificadoPor,
    d.modificado_en     AS ModificadoEn,
    d.eliminado         AS Eliminado,
    d.eliminado_por     AS EliminadoPor,
    d.eliminado_en      AS EliminadoEn,
    m.departamento      AS Departamento,
    eh.nombre           AS Empresa,
    ph.nombre           AS Proveedor
  FROM diesel d
  LEFT JOIN maquinaria m ON m.codigo_unidad = d.codigo_unidad
  LEFT JOIN huertas h ON h.nombre = d.huerta
  LEFT JOIN empresas eh ON eh.id = h.empresa_id
  LEFT JOIN proveedores_combustible ph ON ph.id = h.proveedor_id
`;

// Mismo patrón que DIESEL_SELECT (LEFT JOIN a propósito, por si el vehículo
// ya se borró del Catálogo) pero para Combustible Automotriz: sin
// implemento, con precio_litro y total (que sí trae impreso el ticket).
const CA_SELECT = `
  SELECT
    c.id             AS Id,
    c.folio          AS Folio,
    c.codigo_unidad  AS CodigoUnidad,
    c.unidad         AS Unidad,
    c.litros         AS Litros,
    c.precio_litro   AS PrecioLitro,
    c.total          AS Total,
    c.lectura        AS Lectura,
    c.tipo_combustible AS TipoCombustible,
    c.empresa        AS Empresa,
    c.proveedor      AS Proveedor,
    c.nombre         AS Nombre,
    c.fecha          AS Fecha,
    c.modificado_por AS ModificadoPor,
    c.modificado_en  AS ModificadoEn,
    c.eliminado      AS Eliminado,
    c.eliminado_por  AS EliminadoPor,
    c.eliminado_en   AS EliminadoEn,
    m.departamento   AS Departamento
  FROM combustible_automotriz c
  LEFT JOIN maquinaria m ON m.codigo_unidad = c.codigo_unidad
`;

const MOVIMIENTO_SELECT = `
  SELECT
    id                  AS Id,
    folio               AS Folio,
    codigo_unidad       AS CodigoUnidad,
    unidad              AS Unidad,
    huerta_origen       AS HuertaOrigen,
    huerta_destino      AS HuertaDestino,
    usuario_salida      AS UsuarioSalida,
    fecha_salida        AS FechaSalida,
    comentario_salida   AS ComentarioSalida,
    odometro_salida     AS OdometroSalida,
    usuario_llegada     AS UsuarioLlegada,
    fecha_llegada       AS FechaLlegada,
    comentario_llegada  AS ComentarioLlegada,
    odometro_llegada    AS OdometroLlegada,
    estado              AS Estado,
    foto_salida_url     AS FotoSalidaURL,
    foto_llegada_url    AS FotoLlegadaURL,
    modificado_por      AS ModificadoPor,
    modificado_en       AS ModificadoEn
  FROM movimientos_maquinaria
`;

function isoOrNull(v) {
  if (v === null || v === undefined) return '';
  return v instanceof Date ? v.toISOString() : v;
}

// Convierte el valor de un <input type="datetime-local"> (ej. "2026-09-10T14:30")
// al formato que espera una columna DATETIME de MySQL ("2026-09-10 14:30:00").
function normalizarFechaLocal_(v) {
  if (!v) return null;
  let s = String(v).trim().replace('T', ' ');
  if (!s) return null;
  if (s.length === 16) s += ':00'; // "YYYY-MM-DD HH:MM" -> agrega segundos
  return s;
}

// Para columnas DATE (sin hora, como solicitud_cotizacion_respuesta_items.fecha_entrega):
// usa los getters LOCALES del Date (no getUTC*/toISOString), porque mysql2
// arma el objeto Date a medianoche en la hora local del proceso — si en vez
// de esto se usara toISOString(), en cualquier servidor que no esté en UTC
// (como una computadora en México) la fecha se recorrería un día para atrás.
function fechaSoloOrNull(v) {
  if (!v) return null;
  if (v instanceof Date) {
    const y = v.getFullYear();
    const m = String(v.getMonth() + 1).padStart(2, '0');
    const d = String(v.getDate()).padStart(2, '0');
    return y + '-' + m + '-' + d;
  }
  return String(v).slice(0, 10);
}

// Calcula, a partir del precio unitario que cargó el proveedor, el precio ya
// con su descuento aplicado y el precio total (con IVA sobre ese precio ya
// descontado). El descuento (%) es UNO SOLO por respuesta/cotización
// completa; el IVA (%) sí lo captura el proveedor pieza por pieza. Si el
// precio todavía no se cargó (null), no hay nada que calcular.
function calcularPreciosCotizados(precioCotizado, descuentoPct, ivaPct) {
  if (precioCotizado === null || precioCotizado === undefined) {
    return { PrecioConDescuento: null, PrecioTotal: null };
  }
  const desc = (descuentoPct === null || descuentoPct === undefined) ? 0 : Number(descuentoPct);
  const iva = (ivaPct === null || ivaPct === undefined) ? 0 : Number(ivaPct);
  const precioConDescuento = Number(precioCotizado) * (1 - desc / 100);
  const precioTotal = precioConDescuento * (1 + iva / 100);
  return {
    PrecioConDescuento: Math.round(precioConDescuento * 100) / 100,
    PrecioTotal: Math.round(precioTotal * 100) / 100,
  };
}

function normalizaFilas(rows) {
  return rows.map((row) => {
    const obj = {};
    Object.keys(row).forEach((k) => {
      obj[k] = isoOrNull(row[k]);
    });
    return obj;
  });
}

// ---------------------------------------------------------------
// Reportes de falla
// ---------------------------------------------------------------

// Clasificación automática de la sección de Órdenes para un reporte NUEVO
// capturado desde el celular (Index.html, submitReporte abajo). Reemplaza
// las antiguas casillas manuales "Es trabajo de Soldadura"/"Es trabajo
// Automotriz" del formulario de Reportar -- ahora el servidor decide solo,
// sin pedirle nada extra a quien reporta ("automático y silencioso", como
// lo pidió Carlos). No aplica a crearOrdenPanel (el Panel sigue dejando
// elegir la sección a mano, eso no cambia).
//
// Orden de prioridad (cada paso solo se evalúa si el anterior no aplicó):
//   1) Reparaciones con terceros: SIEMPRE que el equipo esté habilitado en
//      el Catálogo ("Admite reparación con terceros"), sin importar la
//      descripción ni el tipo de unidad -- "siempre que el equipo sea
//      elegible", tal cual lo pidió Carlos. Por encima incluso de
//      Soldadura/Automotriz/Llantas.
//   2) Soldadura: si la descripción menciona palabras relacionadas (ver
//      PALABRAS_SOLDADURA_ abajo).
//   3) Automotriz: si el "Tipo de unidad" del equipo (Catálogo) tiene
//      categoría "automotriz" (columna tipos_unidad.categoria, asignada a
//      mano por Carlos en Catálogo → Tipos de unidad).
//   4) Llantas y Ponches: si la descripción menciona palabras relacionadas
//      (ver PALABRAS_LLANTAS_ abajo).
//   5) Agrícola/principal: si ninguna de las anteriores aplicó -- incluye
//      equipos sin tipo de unidad capturado, o con un tipo de unidad que
//      todavía no tiene categoría asignada en el Catálogo (nunca se quedan
//      sin poder reportar, solo caen en la sección de siempre).
// Mismo orden relativo que ya usaba seccionDeFila_ para Soldadura/
// Automotriz/Llantas/principal -- lo único nuevo es que Terceros ahora va
// primero en vez de entre Llantas y principal, por ser "siempre que el
// equipo sea elegible" en vez de depender de la descripción.
// Además de las palabras genéricas, se incluyen nombres de partes/fallas
// del tractor que casi siempre implican una reparación de soldadura aunque
// la descripción no diga "soldar" explícitamente (según Carlos): "tirón"
// (incluye "tirones"), "tercer punto" (del enganche de 3 puntos), y
// "abocard..." (abocardado/abocardada/se abocardó/etc. -- cuando un
// barreno o perno queda ovalado/agrandado, típicamente se repara soldando
// y volviendo a barrenar).
const PALABRAS_SOLDADURA_ = [
  'soldar', 'soldadura', 'soldado', 'soldada', 'soldador',
  'tiron', 'tercer punto', 'abocard',
];
const PALABRAS_LLANTAS_ = [
  'llanta', 'llantas', 'ponche', 'ponchada', 'ponchado', 'ponchadura',
  'rin', 'rines', 'neumatico', 'neumaticos', 'camara de aire', 'birlo', 'birlos',
];

function normalizarTextoBusqueda_(s) {
  return (s || '')
    .toString()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '');
}

function descripcionContienePalabra_(descripcion, listaPalabras) {
  const texto = normalizarTextoBusqueda_(descripcion);
  if (!texto) return false;
  return listaPalabras.some((p) => texto.indexOf(normalizarTextoBusqueda_(p)) !== -1);
}

// Busca la categoría ('agricola'/'automotriz') del tipo de unidad de un
// equipo, comparando por nombre contra el catálogo "Tipos de unidad" (no
// hay llave foránea entre maquinaria.tipo_unidad y tipos_unidad -- es texto
// libre que debería coincidir con un nombre del catálogo, igual que ya
// pasa con el desplegable "Tipo de unidad" del modal de Catálogo). Regresa
// null si el equipo no tiene tipo de unidad, o si ese tipo de unidad no
// está en el catálogo, o si está pero sin categoría asignada todavía.
async function categoriaTipoUnidad_(tipoUnidadTexto) {
  const texto = (tipoUnidadTexto || '').toString().trim();
  if (!texto) return null;
  const [rows] = await pool.query(
    'SELECT categoria FROM tipos_unidad WHERE LOWER(TRIM(nombre)) = LOWER(TRIM(?))',
    [texto]
  );
  return rows.length > 0 ? (rows[0].categoria || null) : null;
}

async function clasificarReporteAutomatico_(codigoUnidad, descripcion) {
  const codigo = (codigoUnidad || '').toString().trim();
  let tipoUnidad = '';
  let admiteTerceros = false;
  if (codigo) {
    const [rows] = await pool.query(
      'SELECT tipo_unidad, admite_terceros FROM maquinaria WHERE codigo_unidad = ?',
      [codigo]
    );
    if (rows.length > 0) {
      tipoUnidad = rows[0].tipo_unidad || '';
      admiteTerceros = !!Number(rows[0].admite_terceros);
    }
  }

  if (admiteTerceros) {
    return { esSoldadura: 0, esAutomotriz: 0, esLlantas: 0, esTerceros: 1 };
  }
  if (descripcionContienePalabra_(descripcion, PALABRAS_SOLDADURA_)) {
    return { esSoldadura: 1, esAutomotriz: 0, esLlantas: 0, esTerceros: 0 };
  }
  const categoria = await categoriaTipoUnidad_(tipoUnidad);
  if (categoria === 'automotriz') {
    return { esSoldadura: 0, esAutomotriz: 1, esLlantas: 0, esTerceros: 0 };
  }
  if (descripcionContienePalabra_(descripcion, PALABRAS_LLANTAS_)) {
    return { esSoldadura: 0, esAutomotriz: 0, esLlantas: 1, esTerceros: 0 };
  }
  return { esSoldadura: 0, esAutomotriz: 0, esLlantas: 0, esTerceros: 0 };
}

async function submitReporte(data) {
  data = data || {};
  try {
    let fotoUrl = '';
    if (data.foto) fotoUrl = await guardarArchivo_(data.foto);
    let descripcionAudioUrl = '';
    if (data.descripcionAudio) descripcionAudioUrl = await guardarArchivo_(data.descripcionAudio);

    const orden = await siguienteFolio_(pool, 'orden', 'OF', 5);
    const clasificacion = await clasificarReporteAutomatico_(data.unidad, data.descripcion);
    await pool.query(
      `INSERT INTO reportes
        (orden, codigo_unidad, unidad, huerta, descripcion, nombre, fecha, foto_url, descripcion_audio_url, es_soldadura, es_automotriz, es_llantas, es_terceros)
       VALUES (?, ?, ?, ?, ?, ?, NOW(), ?, ?, ?, ?, ?, ?)`,
      [orden, data.unidad || '', data.unidadLabel || '', data.huerta || '', data.descripcion || '', data.nombre || '', fotoUrl || null, descripcionAudioUrl || null, clasificacion.esSoldadura, clasificacion.esAutomotriz, clasificacion.esLlantas, clasificacion.esTerceros]
    );

    return { success: true, orden, fotoUrl, descripcionAudioUrl };
  } catch (err) {
    return { success: false, error: err.toString() };
  }
}

// Reparaciones con terceros solo se puede marcar si el equipo está dado de
// alta en el Catálogo con "Admite reparación con terceros" activo — el
// cliente ya oculta/deshabilita esa casilla cuando no aplica, pero el
// servidor siempre la vuelve a validar (mismo criterio de "no confiar solo
// en el cliente" que el resto del sistema).
async function equipoAdmiteTerceros_(codigoUnidad) {
  const codigo = (codigoUnidad || '').toString().trim();
  if (!codigo) return false;
  const [rows] = await pool.query('SELECT admite_terceros FROM maquinaria WHERE codigo_unidad = ?', [codigo]);
  return rows.length > 0 && !!Number(rows[0].admite_terceros);
}

// Staff: crea una orden directamente desde el Panel (pestaña Órdenes →
// "Nueva orden"), sin pasar por el formulario "Reportar" del celular. A
// diferencia de submitReporte, aquí la foto es opcional (el Panel es de
// escritorio, no siempre hay una foto a la mano) y la fecha del reporte la
// elige quien la captura en vez de tomarse siempre como "ahora".
async function crearOrdenPanel(code, nombreUsuario, data) {
  data = data || {};
  // El permiso depende de a qué sección va la orden nueva (la elige quien
  // la captura con las casillas "Es trabajo de Soldadura"/"Es trabajo
  // Automotriz"/"Llantas y Ponches"/"Reparaciones con terceros" del modal)
  // -- no siempre es 'ordenes' (Agrícola/principal).
  const seccionNueva = seccionDeFila_({
    es_soldadura: data.esSoldadura ? 1 : 0,
    es_automotriz: data.esAutomotriz ? 1 : 0,
    es_llantas: data.esLlantas ? 1 : 0,
    es_terceros: data.esTerceros ? 1 : 0,
  });
  await requierePermisoPanel_(code, nombreUsuario, permisoDeSeccionOrden_(seccionNueva), 'capturar');
  try {
    const codigoUnidad = (data.unidad || '').toString().trim();
    const unidadLabel = (data.unidadLabel || '').toString().trim();
    const huerta = (data.huerta || '').toString().trim();
    const descripcion = (data.descripcion || '').toString().trim();
    const nombre = (data.nombre || '').toString().trim();
    const fecha = normalizarFechaLocal_(data.fecha);
    const esSoldadura = data.esSoldadura ? 1 : 0;
    const esAutomotriz = data.esAutomotriz ? 1 : 0;
    const esLlantas = data.esLlantas ? 1 : 0;
    const esTerceros = data.esTerceros ? 1 : 0;

    if (!codigoUnidad || !unidadLabel) return { success: false, error: 'Selecciona la unidad.' };
    if (!huerta) return { success: false, error: 'Selecciona la huerta.' };
    const huertasRestringidas = await obtenerHuertasRestringidasUsuario_(nombreUsuario);
    if (!huertaPermitida_(huertasRestringidas, huerta)) {
      return { success: false, error: 'Tu usuario no tiene acceso a crear órdenes en la huerta ' + huerta + '.' };
    }
    if (!descripcion) return { success: false, error: 'Escribe la descripción.' };
    if (!nombre) return { success: false, error: 'Escribe quién reportó.' };
    if (!fecha) return { success: false, error: 'Selecciona la fecha del reporte.' };
    if (esTerceros && !(await equipoAdmiteTerceros_(codigoUnidad))) {
      return { success: false, error: 'Este equipo no está habilitado en el Catálogo para "Reparaciones con terceros".' };
    }

    let fotoUrl = '';
    if (data.foto) fotoUrl = await guardarArchivo_(data.foto);

    const orden = await siguienteFolio_(pool, 'orden', 'OF', 5);
    await pool.query(
      `INSERT INTO reportes
        (orden, codigo_unidad, unidad, huerta, descripcion, nombre, fecha, foto_url, es_soldadura, es_automotriz, es_llantas, es_terceros)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [orden, codigoUnidad, unidadLabel, huerta, descripcion, nombre, fecha, fotoUrl || null, esSoldadura, esAutomotriz, esLlantas, esTerceros]
    );

    await registrarAuditoria_('reportes', orden, 'crear', nombreUsuario, unidadLabel + ' — ' + descripcion);

    return { success: true, orden };
  } catch (err) {
    return { success: false, error: err.toString() };
  }
}

async function getReportes(code) {
  requiereClave_(code, HISTORY_ACCESS_CODE);
  const [rows] = await pool.query(REPORTE_SELECT + ' ORDER BY reportes.id DESC');
  return normalizaFilas(rows);
}

async function getReportesTaller(code, nombreUsuario) {
  // Basta con tener 'visualizar' en CUALQUIERA de las cinco secciones para
  // poder entrar a la pestaña -- de cuáles en concreto sí puede ver, se
  // encarga el filtro de abajo (seccionesPermitidas).
  await requiereAccesoOrdenes_(code, nombreUsuario, 'visualizar', ['ordenes', 'ordenes_soldadura', 'ordenes_automotriz', 'ordenes_llantas', 'ordenes_terceros']);

  // A un usuario de Panel (con panel_permisos propio) solo se le regresan
  // las secciones de Órdenes que sí puede ver -- así nunca le llega al
  // cliente una fila de una sección que no debería ver, sin tener que
  // repetir ese filtro en cada lugar que usa ALL_RECORDS (alertas, letrero
  // de pendientes, exportaciones, etc.). Taller.html (sin nombreUsuario, o
  // con un nombre sin fila propia de panel_permisos) sigue viendo las cinco,
  // igual que siempre -- Taller.html no distingue secciones.
  const nombre = (nombreUsuario || '').toString().trim();
  let seccionesPermitidas = null;
  if (nombre) {
    const [filaUsuario] = await pool.query(
      'SELECT panel_permisos FROM usuarios WHERE LOWER(TRIM(nombre)) = LOWER(TRIM(?))',
      [nombre]
    );
    if (filaUsuario.length > 0 && filaUsuario[0].panel_permisos) {
      seccionesPermitidas = ['principal', 'soldadura', 'automotriz', 'llantas', 'terceros'].filter((seccion) =>
        tienePermisoPanel_(filaUsuario[0].panel_permisos, permisoDeSeccionOrden_(seccion), 'visualizar')
      );
    }
  }

  const huertasRestringidas = await obtenerHuertasRestringidasUsuario_(nombreUsuario);
  const condiciones = [];
  const params = [];
  if (huertasRestringidas) {
    condiciones.push('UPPER(TRIM(reportes.huerta)) IN (?)');
    params.push(huertasRestringidas);
  }
  if (seccionesPermitidas) {
    // Mismo orden de prioridad que seccionDeFila_: Soldadura > Automotriz >
    // Llantas y Ponches > Reparaciones con terceros > Agrícola/principal.
    const porSeccion = [];
    if (seccionesPermitidas.includes('principal')) porSeccion.push('(reportes.es_soldadura = 0 AND reportes.es_automotriz = 0 AND reportes.es_llantas = 0 AND reportes.es_terceros = 0)');
    if (seccionesPermitidas.includes('soldadura')) porSeccion.push('reportes.es_soldadura = 1');
    if (seccionesPermitidas.includes('automotriz')) porSeccion.push('(reportes.es_automotriz = 1 AND reportes.es_soldadura = 0)');
    if (seccionesPermitidas.includes('llantas')) porSeccion.push('(reportes.es_llantas = 1 AND reportes.es_soldadura = 0 AND reportes.es_automotriz = 0)');
    if (seccionesPermitidas.includes('terceros')) porSeccion.push('(reportes.es_terceros = 1 AND reportes.es_soldadura = 0 AND reportes.es_automotriz = 0 AND reportes.es_llantas = 0)');
    // requiereAccesoOrdenes_ ya garantizó arriba al menos una sección
    // visible, así que porSeccion nunca queda vacío aquí.
    condiciones.push('(' + porSeccion.join(' OR ') + ')');
  }
  const where = condiciones.length ? ' WHERE ' + condiciones.join(' AND ') : '';
  const [rows] = await pool.query(REPORTE_SELECT + where + ' ORDER BY reportes.id DESC', params);
  return normalizaFilas(rows);
}

async function actualizarOrden(code, nombreUsuario, orden, campos) {
  // El permiso depende de a qué sección pertenece ESTA orden (Agrícola,
  // Soldadura o Automotriz) -- se busca antes de entrar al try para que un
  // error de permiso se propague igual que antes (no se devuelva como
  // {success:false}).
  const [filaSeccion] = await pool.query('SELECT es_soldadura, es_automotriz, es_llantas, es_terceros FROM reportes WHERE orden = ?', [orden]);
  if (filaSeccion.length === 0) throw new Error('No se encontró la orden ' + orden);
  await requiereAccesoOrdenes_(code, nombreUsuario, 'capturar', permisoDeSeccionOrden_(seccionDeFila_(filaSeccion[0])));
  campos = campos || {};
  try {
    const [existe] = await pool.query('SELECT id, unidad, descripcion, huerta, fecha_atencion FROM reportes WHERE orden = ?', [orden]);
    if (existe.length === 0) throw new Error('No se encontró la orden ' + orden);
    const huertasRestringidas = await obtenerHuertasRestringidasUsuario_(nombreUsuario);
    if (!huertaPermitida_(huertasRestringidas, existe[0].huerta)) {
      throw new Error('Tu usuario no tiene acceso a esta orden (huerta ' + (existe[0].huerta || 'sin huerta') + ').');
    }

    const sets = [];
    const values = [];
    const mapaCampos = {
      FechaAtencion: 'fecha_atencion',
      FechaSalida: 'fecha_salida',
      Refaccionamiento: 'refaccionamiento',
      AtendioPor: 'atendio_por',
      TrabajoRealizado: 'trabajo_realizado',
    };
    Object.keys(mapaCampos).forEach((campo) => {
      if (Object.prototype.hasOwnProperty.call(campos, campo)) {
        sets.push(mapaCampos[campo] + ' = ?');
        values.push(campos[campo] === '' ? null : campos[campo]);
      }
    });

    // En cuanto se asigna una Fecha de atención de verdad (desde cualquiera
    // de los flujos que llaman a actualizarOrden: fila de la tabla de
    // Órdenes o letrero de avisos), la orden deja de estar "en proceso sin
    // fecha" — ver marcarOrdenEnProceso más abajo.
    if (Object.prototype.hasOwnProperty.call(campos, 'FechaAtencion') && campos.FechaAtencion) {
      sets.push('en_proceso_sin_fecha = 0');
    }

    let evidenciaUrl = '';
    if (campos.evidenciaFoto) {
      evidenciaUrl = await guardarArchivo_(campos.evidenciaFoto);
      sets.push('evidencia_url = ?');
      values.push(evidenciaUrl);
    }

    // Foto/video ORIGINAL del reportante (foto_url) — capturado o corregido
    // por Taller/Panel directamente desde el modal de la orden, no solo por
    // quien reportó la falla desde su formulario.
    let fotoUrl = '';
    if (campos.fotoOriginal) {
      fotoUrl = await guardarArchivo_(campos.fotoOriginal);
      sets.push('foto_url = ?');
      values.push(fotoUrl);
    }

    let trabajoAudioUrl = '';
    if (campos.trabajoRealizadoAudio) {
      trabajoAudioUrl = await guardarArchivo_(campos.trabajoRealizadoAudio);
      sets.push('trabajo_realizado_audio_url = ?');
      values.push(trabajoAudioUrl);
    }

    if (sets.length > 0) {
      values.push(orden);
      await pool.query(`UPDATE reportes SET ${sets.join(', ')} WHERE orden = ?`, values);
    }
    // Indicadores: si se puso o cambió la Fecha de atención, queda en el
    // historial de programación de la orden.
    if (Object.prototype.hasOwnProperty.call(campos, 'FechaAtencion') && campos.FechaAtencion
        && fechaYmd_(campos.FechaAtencion) !== fechaYmd_(existe[0].fecha_atencion)) {
      await registrarProgramacionOrden_(orden, campos.FechaAtencion, 'fecha_atencion', nombreUsuario);
    }

    // Si esta orden se generó desde una regla de Mantenimiento preventivo
    // (ver generarOrdenMantenimiento) y Taller la está cerrando ahora
    // (FechaSalida), actualizamos el "último registro" para que el próximo
    // servicio se recalcule a partir de aquí. Desde que las reglas son por
    // MODELO, ese "último registro" vive por EQUIPO en
    // mantenimiento_servicios (no en la regla, que ahora es compartida por
    // todos los equipos del modelo); las reglas antiguas (por equipo, ya
    // desactivadas) se quedan actualizando mantenimiento_reglas directo,
    // por compatibilidad.
    if (campos.FechaSalida) {
      const [ligas] = await pool.query(
        `SELECT o.regla_id AS ReglaId, o.lectura_generacion AS LecturaGeneracion, o.codigo_unidad AS CodigoUnidad,
                r.modelo_id AS ModeloId
           FROM mantenimiento_ordenes o
           INNER JOIN mantenimiento_reglas r ON r.id = o.regla_id
          WHERE o.orden = ?`,
        [orden]
      );
      if (ligas.length > 0) {
        const liga = ligas[0];

        // La lectura (horómetro/kilometraje) que manda es la que Taller
        // captura AL CERRAR la orden (LecturaServicio) — la lectura real
        // del equipo el día que se hizo el servicio. Si Taller no la
        // captura (campo opcional, o la regla es por tiempo), se sigue
        // usando de respaldo lectura_generacion (la que tenía el equipo
        // cuando se GENERÓ la orden), igual que antes. Usar solo esa
        // última era el problema: si pasa tiempo entre que se genera la
        // orden y que el servicio se hace de verdad, se queda vieja y el
        // "próximo servicio" no se recalcula bien.
        const lecturaServicioNum = (campos.LecturaServicio === '' || campos.LecturaServicio === undefined || campos.LecturaServicio === null)
          ? null : Number(campos.LecturaServicio);
        const lecturaServicio = (lecturaServicioNum !== null && !Number.isNaN(lecturaServicioNum)) ? lecturaServicioNum : null;
        const lecturaFinal = lecturaServicio !== null ? lecturaServicio : liga.LecturaGeneracion;

        await pool.query('UPDATE mantenimiento_ordenes SET lectura_cierre = ? WHERE orden = ?', [lecturaServicio, orden]);

        if (liga.ModeloId && liga.CodigoUnidad) {
          // Regla nueva (por modelo): actualiza el histórico de ESE equipo.
          await pool.query(
            `INSERT INTO mantenimiento_servicios (regla_id, codigo_unidad, ultima_fecha, ultima_lectura)
             VALUES (?, ?, ?, ?)
             ON DUPLICATE KEY UPDATE
              ultima_fecha = VALUES(ultima_fecha),
              ultima_lectura = COALESCE(VALUES(ultima_lectura), ultima_lectura)`,
            [liga.ReglaId, liga.CodigoUnidad, campos.FechaSalida, lecturaFinal !== null && lecturaFinal !== undefined ? lecturaFinal : null]
          );
        } else {
          // Regla antigua (por equipo, ya desactivada) — compatibilidad.
          const setsRegla = ['ultima_fecha = ?'];
          const valuesRegla = [campos.FechaSalida];
          if (lecturaFinal !== null && lecturaFinal !== undefined) {
            setsRegla.push('ultima_lectura = ?');
            valuesRegla.push(lecturaFinal);
          }
          valuesRegla.push(liga.ReglaId);
          await pool.query(`UPDATE mantenimiento_reglas SET ${setsRegla.join(', ')} WHERE id = ?`, valuesRegla);
        }
      }
    }

    await registrarAuditoria_('reportes', orden, 'editar', nombreUsuario, (existe[0].unidad || '') + ' — ' + (existe[0].descripcion || ''));

    return { success: true, evidenciaUrl, trabajoAudioUrl, fotoUrl };
  } catch (err) {
    return { success: false, error: err.toString() };
  }
}

// Staff (solo Panel): marca una orden como "En proceso" sin todavía
// asignarle una Fecha de atención — para que el jefe de taller la vea de
// inmediato en su lista de pendientes en Taller.html (que se filtra por
// estadoDe() === 'En proceso') y la oficina le asigne la fecha real más
// adelante, cuando la tenga. Taller.html NO puede llamar a esta función
// (no tiene botón para ello) ni poner la Fecha de atención directamente;
// eso sigue siendo exclusivo del Panel.
async function marcarOrdenEnProceso(code, nombreUsuario, orden, semanaCodigo) {
  const [filaSeccion] = await pool.query('SELECT es_soldadura, es_automotriz, es_llantas, es_terceros FROM reportes WHERE orden = ?', [orden]);
  if (filaSeccion.length === 0) return { success: false, error: 'No se encontró la orden ' + orden + '.' };
  await requierePermisoPanel_(code, nombreUsuario, permisoDeSeccionOrden_(seccionDeFila_(filaSeccion[0])), 'capturar');
  try {
    const [rows] = await pool.query(
      'SELECT id, unidad, descripcion, huerta, fecha_atencion, fecha_salida FROM reportes WHERE orden = ?',
      [orden]
    );
    if (rows.length === 0) return { success: false, error: 'No se encontró la orden ' + orden + '.' };
    const huertasRestringidas = await obtenerHuertasRestringidasUsuario_(nombreUsuario);
    if (!huertaPermitida_(huertasRestringidas, rows[0].huerta)) {
      return { success: false, error: 'Tu usuario no tiene acceso a esta orden (huerta ' + (rows[0].huerta || 'sin huerta') + ').' };
    }
    if (rows[0].fecha_salida) {
      return { success: false, error: 'Esta orden ya está Completada.' };
    }
    if (rows[0].fecha_atencion) {
      return { success: false, error: 'Esta orden ya tiene Fecha de atención asignada.' };
    }
    // Semana en que se planea atender (Indicadores, oct-2026). Opcional
    // para no romper llamadas viejas; el Panel siempre la manda.
    let semana = null;
    const codigoSemana = (semanaCodigo || '').toString().trim();
    if (codigoSemana) {
      const [sem] = await pool.query('SELECT codigo, fecha_inicio, fecha_fin FROM semanas WHERE codigo = ?', [codigoSemana]);
      if (sem.length === 0) return { success: false, error: 'La semana ' + codigoSemana + ' no está en el catálogo de semanas.' };
      semana = sem[0];
    }
    const [antes] = await pool.query('SELECT semana_en_proceso FROM reportes WHERE orden = ?', [orden]);
    const semanaAnterior = antes.length ? antes[0].semana_en_proceso : null;
    await pool.query('UPDATE reportes SET en_proceso_sin_fecha = 1, semana_en_proceso = COALESCE(?, semana_en_proceso) WHERE orden = ?', [semana ? semana.codigo : null, orden]);
    if (semana && semana.codigo !== semanaAnterior) {
      await registrarProgramacionOrden_(orden, semana.fecha_inicio, 'en_proceso', nombreUsuario);
    }
    await agregarObservacionOrden_(
      orden,
      (semanaAnterior && semana && semanaAnterior !== semana.codigo
        ? 'Reprogramada "En proceso" de la semana ' + semanaAnterior + ' a la ' + semana.codigo
        : 'Marcada "En proceso"' + (semana ? ' para la semana ' + semana.codigo : '')) +
      ' (todavía sin Fecha de atención) por ' + (nombreUsuario || 'alguien del Panel') + '.'
    );
    await registrarAuditoria_('reportes', orden, 'marcar-en-proceso', nombreUsuario, (rows[0].unidad || '') + ' — ' + (rows[0].descripcion || ''));
    return { success: true };
  } catch (err) {
    return { success: false, error: err.toString() };
  }
}


// ------------------------------------------------------------------
// INDICADORES (oct-2026): cumplimiento semanal de órdenes. Petición de
// Carlos: de las órdenes que se programaron para una semana (por Fecha de
// atención dentro de esa semana, o marcadas "En proceso" para esa semana),
// qué porcentaje se cerró (Fecha de salida) en esa misma semana.
//  - Si se reprograma a otra semana, cuenta en todas las semanas en que se
//    programó (en las anteriores como no cumplida).
//  - Si se cerró ANTES de la semana programada: dato aparte ("cerradas
//    antes, fuera de programación"), no cuenta como cumplida.
// ------------------------------------------------------------------
function fechaYmd_(valor) {
  if (valor === null || valor === undefined || valor === '') return null;
  if (valor instanceof Date) {
    if (Number.isNaN(valor.getTime())) return null;
    return valor.getFullYear() + '-' + String(valor.getMonth() + 1).padStart(2, '0') + '-' + String(valor.getDate()).padStart(2, '0');
  }
  const m = valor.toString().trim().match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? m[1] + '-' + m[2] + '-' + m[3] : null;
}

// Guarda en el historial de programación que la orden quedó programada
// para "fecha" (no repite si es la misma fecha que la última vez).
async function registrarProgramacionOrden_(orden, fecha, origen, usuario) {
  const ymd = fechaYmd_(fecha);
  if (!orden || !ymd) return false;
  const [ultima] = await pool.query('SELECT fecha_programada FROM ordenes_programacion WHERE orden = ? ORDER BY id DESC LIMIT 1', [orden]);
  if (ultima.length && fechaYmd_(ultima[0].fecha_programada) === ymd) return false;
  await pool.query(
    'INSERT INTO ordenes_programacion (orden, fecha_programada, origen, registrado_por) VALUES (?, ?, ?, ?)',
    [orden, ymd, origen, (usuario || '').toString().trim() || null]
  );
  return true;
}

const SECCIONES_INDICADOR = [
  { clave: 'principal', nombre: 'Agrícola' },
  { clave: 'soldadura', nombre: 'Soldadura' },
  { clave: 'automotriz', nombre: 'Automotriz' },
  { clave: 'llantas', nombre: 'Llantas y Ponches' },
  { clave: 'terceros', nombre: 'Reparaciones con terceros' },
];
const PERMISOS_VER_SEMANAS = ['indicadores', 'ordenes', 'ordenes_soldadura', 'ordenes_automotriz', 'ordenes_llantas', 'ordenes_terceros'];

function semanaDeFila_(f) {
  return { id: f.id, codigo: f.codigo, inicio: fechaYmd_(f.fecha_inicio), fin: fechaYmd_(f.fecha_fin) };
}

// Catálogo de semanas (para el indicador y para "Marcar en proceso").
async function getSemanas(code, nombreUsuario) {
  await requierePermisoPanel_(code, nombreUsuario, PERMISOS_VER_SEMANAS, 'visualizar');
  const [rows] = await pool.query('SELECT id, codigo, fecha_inicio, fecha_fin FROM semanas ORDER BY fecha_inicio');
  return { success: true, semanas: rows.map(semanaDeFila_), hoy: fechaYmd_(new Date()) };
}

async function guardarSemana(code, nombreUsuario, datos) {
  await requierePermisoPanel_(code, nombreUsuario, 'indicadores', 'capturar');
  const d = datos || {};
  const id = d.id ? Number(d.id) : null;
  const codigo = (d.codigo || '').toString().trim().toUpperCase();
  const inicio = fechaYmd_(d.inicio);
  const fin = fechaYmd_(d.fin);
  if (!codigo) return { success: false, error: 'Escribe el número de semana (ej. S01-2027).' };
  if (codigo.length > 20) return { success: false, error: 'El número de semana es demasiado largo.' };
  if (!inicio || !fin) return { success: false, error: 'Pon la fecha de inicio y la de cierre.' };
  if (fin < inicio) return { success: false, error: 'La fecha de cierre no puede ser antes del inicio.' };
  const dias = Math.round((new Date(fin + 'T00:00:00') - new Date(inicio + 'T00:00:00')) / 86400000) + 1;
  if (dias > 14) return { success: false, error: 'Una semana no puede durar más de 14 días (' + dias + ').' };
  const [repetida] = await pool.query('SELECT id FROM semanas WHERE codigo = ? AND (? IS NULL OR id <> ?)', [codigo, id, id]);
  if (repetida.length) return { success: false, error: 'Ya existe la semana ' + codigo + '.' };
  const [encimada] = await pool.query(
    'SELECT codigo FROM semanas WHERE fecha_inicio <= ? AND fecha_fin >= ? AND (? IS NULL OR id <> ?) LIMIT 1',
    [fin, inicio, id, id]
  );
  if (encimada.length) return { success: false, error: 'Esas fechas se enciman con la semana ' + encimada[0].codigo + '.' };
  if (id) {
    const [r] = await pool.query('UPDATE semanas SET codigo = ?, fecha_inicio = ?, fecha_fin = ? WHERE id = ?', [codigo, inicio, fin, id]);
    if (!r.affectedRows) return { success: false, error: 'No se encontró esa semana.' };
    await registrarAuditoria_('semanas', String(id), 'editar', nombreUsuario, codigo + ' ' + inicio + ' a ' + fin);
    return { success: true, id };
  }
  const [r] = await pool.query('INSERT INTO semanas (codigo, fecha_inicio, fecha_fin) VALUES (?, ?, ?)', [codigo, inicio, fin]);
  await registrarAuditoria_('semanas', String(r.insertId), 'crear', nombreUsuario, codigo + ' ' + inicio + ' a ' + fin);
  return { success: true, id: r.insertId };
}

async function eliminarSemana(code, nombreUsuario, id) {
  await requierePermisoPanel_(code, nombreUsuario, 'indicadores', 'capturar');
  const [rows] = await pool.query('SELECT codigo FROM semanas WHERE id = ?', [Number(id)]);
  if (!rows.length) return { success: false, error: 'No se encontró esa semana.' };
  const [uso] = await pool.query('SELECT COUNT(*) n FROM reportes WHERE semana_en_proceso = ?', [rows[0].codigo]);
  if (uso[0].n > 0) return { success: false, error: 'No se puede eliminar: hay ' + uso[0].n + ' orden(es) marcadas "En proceso" para la ' + rows[0].codigo + '.' };
  await pool.query('DELETE FROM semanas WHERE id = ?', [Number(id)]);
  await registrarAuditoria_('semanas', String(id), 'eliminar', nombreUsuario, rows[0].codigo);
  return { success: true };
}

// Cálculo puro (sin BD) del indicador -- se prueba aparte.
//   semanas: [{codigo, inicio, fin}] (YYYY-MM-DD), en orden
//   programaciones: [{orden, fecha}]   (historial, cualquier orden)
//   ordenes: { [orden]: {seccion, fechaSalida, unidad, huerta, descripcion} }
function calcularIndicadorCumplimiento_(semanas, programaciones, ordenes) {
  const resultado = [];
  semanas.forEach((sem) => {
    const enSemana = {};
    programaciones.forEach((p) => {
      if (p.fecha >= sem.inicio && p.fecha <= sem.fin && ordenes[p.orden]) {
        if (!enSemana[p.orden]) enSemana[p.orden] = [];
        enSemana[p.orden].push(p);
      }
    });
    const totales = {};
    const nuevo = () => ({ programadas: 0, cumplidas: 0, cerradasAntes: 0, cerradasDespues: 0, pendientes: 0, reprogramadas: 0 });
    totales.todas = nuevo();
    SECCIONES_INDICADOR.forEach((s) => { totales[s.clave] = nuevo(); });
    const detalle = [];
    Object.keys(enSemana).sort().forEach((orden) => {
      const o = ordenes[orden];
      const salida = o.fechaSalida || null;
      // ¿Se volvió a programar después para una fecha POSTERIOR a esta semana?
      const posteriores = programaciones.filter((p) => p.orden === orden && p.fecha > sem.fin).map((p) => p.fecha).sort();
      let resultadoOrden;
      if (salida && salida >= sem.inicio && salida <= sem.fin) resultadoOrden = 'cumplida';
      else if (salida && salida < sem.inicio) resultadoOrden = 'cerrada_antes';
      else if (salida && salida > sem.fin) resultadoOrden = 'cerrada_despues';
      else resultadoOrden = 'pendiente';
      const reprogramada = resultadoOrden !== 'cumplida' && resultadoOrden !== 'cerrada_antes' && posteriores.length > 0;
      [totales.todas, totales[o.seccion] || totales.principal].forEach((t) => {
        t.programadas++;
        if (resultadoOrden === 'cumplida') t.cumplidas++;
        else if (resultadoOrden === 'cerrada_antes') t.cerradasAntes++;
        else if (resultadoOrden === 'cerrada_despues') t.cerradasDespues++;
        else t.pendientes++;
        if (reprogramada) t.reprogramadas++;
      });
      detalle.push({
        orden,
        seccion: o.seccion,
        unidad: o.unidad || '',
        huerta: o.huerta || '',
        descripcion: o.descripcion || '',
        fechasProgramadas: enSemana[orden].map((p) => p.fecha).sort(),
        origen: enSemana[orden][enSemana[orden].length - 1].origen || '',
        fechaSalida: salida,
        resultado: resultadoOrden,
        reprogramadaA: reprogramada ? posteriores[0] : null,
      });
    });
    Object.keys(totales).forEach((k) => {
      const t = totales[k];
      // % de cumplimiento: cerradas dentro de la semana / programadas.
      t.porcentaje = t.programadas ? Math.round((t.cumplidas / t.programadas) * 10000) / 100 : null;
    });
    resultado.push({ codigo: sem.codigo, inicio: sem.inicio, fin: sem.fin, totales, detalle });
  });
  return resultado;
}

// Indicador para un rango de semanas del catálogo (códigos desde/hasta).
async function getIndicadorCumplimientoSemanal(code, nombreUsuario, desdeCodigo, hastaCodigo) {
  await requierePermisoPanel_(code, nombreUsuario, 'indicadores', 'visualizar');
  const [todas] = await pool.query('SELECT id, codigo, fecha_inicio, fecha_fin FROM semanas ORDER BY fecha_inicio');
  const lista = todas.map(semanaDeFila_);
  if (!lista.length) return { success: false, error: 'El catálogo de semanas está vacío.' };
  let i = lista.findIndex((s) => s.codigo === desdeCodigo);
  let j = lista.findIndex((s) => s.codigo === hastaCodigo);
  if (i === -1 || j === -1) {
    // Por defecto: las últimas 8 semanas hasta la actual.
    const hoy = fechaYmd_(new Date());
    let actual = lista.findIndex((s) => s.inicio <= hoy && s.fin >= hoy);
    if (actual === -1) actual = lista.length - 1;
    if (j === -1) j = actual;
    if (i === -1) i = Math.max(0, j - 7);
  }
  if (i > j) { const t = i; i = j; j = t; }
  if (j - i > 104) return { success: false, error: 'Elige un rango de máximo 2 años.' };
  const rango = lista.slice(i, j + 1);
  const desde = rango[0].inicio;
  const hasta = rango[rango.length - 1].fin;
  const huertasRestringidas = await obtenerHuertasRestringidasUsuario_(nombreUsuario);
  // Órdenes programadas en el rango (y su historial completo, para saber si se reprogramaron).
  const [progs] = await pool.query(
    `SELECT p.orden, p.fecha_programada, p.origen FROM ordenes_programacion p
      WHERE p.orden IN (SELECT DISTINCT orden FROM ordenes_programacion WHERE fecha_programada BETWEEN ? AND ?)
      ORDER BY p.id`,
    [desde, hasta]
  );
  const folios = Array.from(new Set(progs.map((p) => p.orden)));
  const ordenes = {};
  if (folios.length) {
    const [rows] = await pool.query(
      `SELECT orden, unidad, codigo_unidad, huerta, descripcion, fecha_salida, es_soldadura, es_automotriz, es_llantas, es_terceros
         FROM reportes WHERE orden IN (?)`,
      [folios]
    );
    rows.forEach((r) => {
      if (!huertaPermitida_(huertasRestringidas, r.huerta)) return;
      ordenes[r.orden] = {
        seccion: seccionDeFila_(r),
        fechaSalida: fechaYmd_(r.fecha_salida),
        unidad: r.unidad || r.codigo_unidad || '',
        huerta: r.huerta || '',
        descripcion: r.descripcion || '',
      };
    });
  }
  const programaciones = progs.map((p) => ({ orden: p.orden, fecha: fechaYmd_(p.fecha_programada), origen: p.origen }));
  return {
    success: true,
    secciones: SECCIONES_INDICADOR,
    semanas: calcularIndicadorCumplimiento_(rango, programaciones, ordenes),
    catalogo: lista,
  };
}

async function getMisOrdenes(nombre) {
  if (!nombre) return [];
  const [rows] = await pool.query(REPORTE_SELECT + ' WHERE LOWER(TRIM(reportes.nombre)) = LOWER(TRIM(?)) ORDER BY reportes.id DESC', [nombre]);
  return normalizaFilas(rows);
}

async function guardarVistoBueno(nombre, orden, vistoBueno, comentario) {
  try {
    const [rows] = await pool.query('SELECT nombre FROM reportes WHERE orden = ?', [orden]);
    if (rows.length === 0) throw new Error('No se encontró la orden.');
    const nombreOriginal = (rows[0].nombre || '').toString().trim().toLowerCase();
    if (nombreOriginal !== (nombre || '').toString().trim().toLowerCase()) {
      throw new Error('Esta orden no te pertenece.');
    }
    await pool.query('UPDATE reportes SET visto_bueno = ?, comentario_reportante = ? WHERE orden = ?', [
      vistoBueno ? 'Si' : null,
      comentario || null,
      orden,
    ]);
    return { success: true };
  } catch (err) {
    return { success: false, error: err.toString() };
  }
}

// Agrega una línea (con fecha) al historial de observaciones de una orden,
// sin borrar las anteriores — igual idea que el "Editado por X · fecha" de
// diesel/movimientos, pero aquí se guarda cada línea (no solo la última),
// porque el pedido original fue justo "poner observación de modificación"
// como bitácora de qué se le fue cambiando a la orden con el tiempo.
async function agregarObservacionOrden_(orden, texto) {
  const [rows] = await pool.query('SELECT observaciones_staff FROM reportes WHERE orden = ?', [orden]);
  if (rows.length === 0) return;
  const previo = rows[0].observaciones_staff || '';
  const fecha = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const marca = pad(fecha.getDate()) + '/' + pad(fecha.getMonth() + 1) + '/' + fecha.getFullYear() + ' ' + pad(fecha.getHours()) + ':' + pad(fecha.getMinutes());
  const linea = '[' + marca + '] ' + texto;
  const nuevo = previo ? previo + '\n' + linea : linea;
  await pool.query('UPDATE reportes SET observaciones_staff = ? WHERE orden = ?', [nuevo, orden]);
}

// Cuando un movimiento de maquinaria queda "confirmado" (llegada
// confirmada), actualiza automáticamente la huerta de cualquier orden
// ABIERTA (sin fecha_salida) que tenga esa misma unidad, para que
// Mantenimiento/Órdenes reflejen dónde está el equipo de verdad — y deja
// constancia en observaciones_staff de por qué cambió. Solo toca órdenes
// cuya huerta sea distinta a la nueva (si ya coincide, no hace nada). No
// se mete con órdenes ya cerradas (esas quedan como constancia histórica
// de dónde estaba el equipo cuando se atendieron).
async function sincronizarUbicacionOrdenesAbiertas_(codigoUnidad, huertaNueva, origenTexto, usuario) {
  if (!codigoUnidad || !huertaNueva) return;
  const [abiertas] = await pool.query(
    'SELECT orden, huerta FROM reportes WHERE codigo_unidad = ? AND fecha_salida IS NULL',
    [codigoUnidad]
  );
  for (const r of abiertas) {
    const huertaVieja = r.huerta || '';
    if (huertaVieja.trim().toLowerCase() === huertaNueva.trim().toLowerCase()) continue;
    await pool.query('UPDATE reportes SET huerta = ?, modificado_por = ?, modificado_en = NOW() WHERE orden = ?', [
      huertaNueva,
      usuario || null,
      r.orden,
    ]);
    await agregarObservacionOrden_(
      r.orden,
      'Ubicación actualizada automáticamente a ' + huertaNueva + ' (antes ' + (huertaVieja || 'sin huerta') + ') por ' + origenTexto + (usuario ? ', confirmado por ' + usuario : '') + '.'
    );
  }
}

// Staff: corrige una orden ya registrada, desde el Panel (huerta,
// descripción, fechas, etc. — no el código/unidad, para no desligarla de
// mantenimiento_ordenes/diesel). Deja constancia de quién y cuándo
// (modificado_por/modificado_en) y agrega una línea a observaciones_staff,
// igual que editarMovimiento/editarCargaDiesel.
async function editarOrden(code, nombreUsuario, orden, data) {
  data = data || {};
  const [filaSeccion] = await pool.query('SELECT es_soldadura, es_automotriz, es_llantas, es_terceros FROM reportes WHERE orden = ?', [orden]);
  if (filaSeccion.length === 0) return { success: false, error: 'No se encontró la orden ' + orden + '.' };
  const seccionAnterior = seccionDeFila_(filaSeccion[0]);
  await requierePermisoPanel_(code, nombreUsuario, permisoDeSeccionOrden_(seccionAnterior), 'capturar');
  // Este modal también puede cambiar las casillas de Soldadura/Automotriz/
  // Llantas y Ponches/Reparaciones con terceros (mover la orden a otra
  // sección) -- si la sección destino es distinta, también se exige permiso
  // de capturar ahí, para que nadie pueda "mover" una orden a una sección
  // donde no tiene permiso de editar.
  const seccionNueva = seccionDeFila_({
    es_soldadura: data.esSoldadura ? 1 : 0,
    es_automotriz: data.esAutomotriz ? 1 : 0,
    es_llantas: data.esLlantas ? 1 : 0,
    es_terceros: data.esTerceros ? 1 : 0,
  });
  if (seccionNueva !== seccionAnterior) {
    await requierePermisoPanel_(code, nombreUsuario, permisoDeSeccionOrden_(seccionNueva), 'capturar');
  }
  try {
    const [rows] = await pool.query('SELECT * FROM reportes WHERE orden = ?', [orden]);
    if (rows.length === 0) return { success: false, error: 'No se encontró la orden ' + orden + '.' };
    const anterior = rows[0];
    const huertasRestringidas = await obtenerHuertasRestringidasUsuario_(nombreUsuario);
    if (!huertaPermitida_(huertasRestringidas, anterior.huerta)) {
      return { success: false, error: 'Tu usuario no tiene acceso a esta orden (huerta ' + (anterior.huerta || 'sin huerta') + ').' };
    }

    const huerta = (data.huerta || '').toString().trim();
    const descripcion = (data.descripcion || '').toString().trim();
    const nombre = (data.nombre || '').toString().trim();
    const fecha = normalizarFechaLocal_(data.fecha);
    const fechaAtencion = (data.fechaAtencion || '').toString().trim() || null;
    const fechaSalida = (data.fechaSalida || '').toString().trim() || null;
    const refaccionamiento = (data.refaccionamiento || '').toString().trim() || null;
    const atendioPor = (data.atendioPor || '').toString().trim() || null;
    const trabajoRealizado = (data.trabajoRealizado || '').toString().trim() || null;
    const vistoBueno = data.vistoBueno ? 'Si' : null;
    const esSoldadura = data.esSoldadura ? 1 : 0;
    const esAutomotriz = data.esAutomotriz ? 1 : 0;
    const esLlantas = data.esLlantas ? 1 : 0;
    const esTerceros = data.esTerceros ? 1 : 0;
    const nota = (data.nota || '').toString().trim();

    if (!huerta) return { success: false, error: 'Selecciona la huerta.' };
    if (!descripcion) return { success: false, error: 'Escribe la descripción.' };
    if (!nombre) return { success: false, error: 'Escribe quién reportó.' };
    if (!fecha) return { success: false, error: 'Selecciona la fecha del reporte.' };
    if (esTerceros && !(await equipoAdmiteTerceros_(anterior.codigo_unidad))) {
      return { success: false, error: 'Este equipo no está habilitado en el Catálogo para "Reparaciones con terceros".' };
    }

    let diasAtencion = null;
    const diasAtencionRaw = (data.diasAtencion === undefined || data.diasAtencion === null)
      ? ''
      : data.diasAtencion.toString().trim();
    if (diasAtencionRaw !== '') {
      const diasNum = Number(diasAtencionRaw);
      if (!Number.isInteger(diasNum) || diasNum < 0) {
        return { success: false, error: 'Los días de atención deben ser un número entero de 0 o más.' };
      }
      diasAtencion = diasNum;
    }

    const modificadoPor = (nombreUsuario || '').toString().trim() || null;

    // En cuanto este editor asigna una Fecha de atención de verdad, la orden
    // deja de estar "en proceso sin fecha" (ver marcarOrdenEnProceso). Si no
    // se está asignando fecha aquí, se deja la bandera como estaba.
    const enProcesoSinFecha = fechaAtencion ? 0 : (anterior.en_proceso_sin_fecha ? 1 : 0);

    await pool.query(
      `UPDATE reportes SET huerta = ?, descripcion = ?, nombre = ?, fecha = ?, fecha_atencion = ?, fecha_salida = ?,
        refaccionamiento = ?, atendio_por = ?, trabajo_realizado = ?, visto_bueno = ?, dias_atencion = ?, es_soldadura = ?, es_automotriz = ?, es_llantas = ?, es_terceros = ?, en_proceso_sin_fecha = ?, modificado_por = ?, modificado_en = NOW()
       WHERE orden = ?`,
      [huerta, descripcion, nombre, fecha, fechaAtencion, fechaSalida, refaccionamiento, atendioPor, trabajoRealizado, vistoBueno, diasAtencion, esSoldadura, esAutomotriz, esLlantas, esTerceros, enProcesoSinFecha, modificadoPor, orden]
    );

    // Indicadores: si se puso o cambió la Fecha de atención, queda en el
    // historial de programación de la orden.
    if (fechaAtencion && fechaYmd_(fechaAtencion) !== fechaYmd_(anterior.fecha_atencion)) {
      await registrarProgramacionOrden_(orden, fechaAtencion, 'fecha_atencion', modificadoPor);
    }

    // Bitácora: qué campos cambiaron de verdad, más la nota libre si el
    // usuario escribió una.
    const cambios = [];
    if ((anterior.huerta || '') !== huerta) cambios.push('huerta: "' + (anterior.huerta || '') + '" → "' + huerta + '"');
    if ((anterior.descripcion || '') !== descripcion) cambios.push('descripción');
    if ((anterior.nombre || '') !== nombre) cambios.push('nombre: "' + (anterior.nombre || '') + '" → "' + nombre + '"');
    if ((anterior.refaccionamiento || '') !== (refaccionamiento || '')) cambios.push('refaccionamiento');
    if ((anterior.atendio_por || '') !== (atendioPor || '')) cambios.push('atendió: "' + (anterior.atendio_por || '') + '" → "' + (atendioPor || '') + '"');
    if ((anterior.trabajo_realizado || '') !== (trabajoRealizado || '')) cambios.push('trabajo realizado');
    if ((anterior.visto_bueno || null) !== vistoBueno) cambios.push('visto bueno: ' + (vistoBueno ? 'Sí' : 'quitado'));
    if (Number(anterior.es_soldadura || 0) !== esSoldadura) cambios.push('Área de Soldadura: ' + (esSoldadura ? 'marcada' : 'quitada'));
    if (Number(anterior.es_automotriz || 0) !== esAutomotriz) cambios.push('Automotriz: ' + (esAutomotriz ? 'marcada' : 'quitada'));
    if (Number(anterior.es_llantas || 0) !== esLlantas) cambios.push('Llantas y Ponches: ' + (esLlantas ? 'marcada' : 'quitada'));
    if (Number(anterior.es_terceros || 0) !== esTerceros) cambios.push('Reparaciones con terceros: ' + (esTerceros ? 'marcada' : 'quitada'));
    if ((anterior.dias_atencion === null ? null : Number(anterior.dias_atencion)) !== diasAtencion) {
      cambios.push('días de atención: ' + (anterior.dias_atencion === null || anterior.dias_atencion === undefined ? 'sin definir' : anterior.dias_atencion) + ' → ' + (diasAtencion === null ? 'sin definir' : diasAtencion));
    }

    let textoObs = 'Editado por ' + (modificadoPor || 'alguien del Panel');
    if (cambios.length > 0) textoObs += ' — cambió: ' + cambios.join(', ');
    if (nota) textoObs += '. Nota: ' + nota;
    await agregarObservacionOrden_(orden, textoObs);

    // Si esta orden se generó desde una regla de Mantenimiento preventivo
    // (ver generarOrdenMantenimiento) y aquí se está cerrando (fechaSalida),
    // actualiza el "último registro" para que el próximo servicio se
    // recalcule a partir de aquí — misma lógica que actualizarOrden (la que
    // usa Taller), para que cerrar una orden preventiva desde el Panel
    // también alimente el cálculo del siguiente preventivo, no solo cuando
    // se cierra desde Taller.
    if (fechaSalida) {
      const [ligas] = await pool.query(
        `SELECT o.regla_id AS ReglaId, o.lectura_generacion AS LecturaGeneracion, o.codigo_unidad AS CodigoUnidad,
                r.modelo_id AS ModeloId
           FROM mantenimiento_ordenes o
           INNER JOIN mantenimiento_reglas r ON r.id = o.regla_id
          WHERE o.orden = ?`,
        [orden]
      );
      if (ligas.length > 0) {
        const liga = ligas[0];
        const lecturaServicioNum = (data.lecturaServicio === '' || data.lecturaServicio === undefined || data.lecturaServicio === null)
          ? null : Number(data.lecturaServicio);
        const lecturaServicio = (lecturaServicioNum !== null && !Number.isNaN(lecturaServicioNum)) ? lecturaServicioNum : null;
        const lecturaFinal = lecturaServicio !== null ? lecturaServicio : liga.LecturaGeneracion;

        await pool.query('UPDATE mantenimiento_ordenes SET lectura_cierre = ? WHERE orden = ?', [lecturaServicio, orden]);

        if (liga.ModeloId && liga.CodigoUnidad) {
          await pool.query(
            `INSERT INTO mantenimiento_servicios (regla_id, codigo_unidad, ultima_fecha, ultima_lectura)
             VALUES (?, ?, ?, ?)
             ON DUPLICATE KEY UPDATE
              ultima_fecha = VALUES(ultima_fecha),
              ultima_lectura = COALESCE(VALUES(ultima_lectura), ultima_lectura)`,
            [liga.ReglaId, liga.CodigoUnidad, fechaSalida, lecturaFinal !== null && lecturaFinal !== undefined ? lecturaFinal : null]
          );
        } else {
          const setsRegla = ['ultima_fecha = ?'];
          const valuesRegla = [fechaSalida];
          if (lecturaFinal !== null && lecturaFinal !== undefined) {
            setsRegla.push('ultima_lectura = ?');
            valuesRegla.push(lecturaFinal);
          }
          valuesRegla.push(liga.ReglaId);
          await pool.query(`UPDATE mantenimiento_reglas SET ${setsRegla.join(', ')} WHERE id = ?`, valuesRegla);
        }
      }
    }

    await registrarAuditoria_('reportes', orden, 'editar', nombreUsuario, (anterior.unidad || '') + ' — ' + descripcion);

    return { success: true };
  } catch (err) {
    return { success: false, error: err.toString() };
  }
}

// Staff: borra una orden por completo (desde el Panel). También limpia su
// liga con mantenimiento_ordenes si venía de una regla de Mantenimiento
// preventivo, para no dejar una referencia suelta a una orden que ya no
// existe.
async function eliminarOrden(code, nombreUsuario, orden) {
  const [filaSeccion] = await pool.query('SELECT es_soldadura, es_automotriz, es_llantas, es_terceros FROM reportes WHERE orden = ?', [orden]);
  if (filaSeccion.length === 0) return { success: false, error: 'No se encontró la orden ' + orden + '.' };
  await requierePermisoPanel_(code, nombreUsuario, permisoDeSeccionOrden_(seccionDeFila_(filaSeccion[0])), 'capturar');
  try {
    const [rows] = await pool.query('SELECT id, unidad, descripcion, huerta FROM reportes WHERE orden = ?', [orden]);
    if (rows.length === 0) return { success: false, error: 'No se encontró la orden ' + orden + '.' };
    const huertasRestringidas = await obtenerHuertasRestringidasUsuario_(nombreUsuario);
    if (!huertaPermitida_(huertasRestringidas, rows[0].huerta)) {
      return { success: false, error: 'Tu usuario no tiene acceso a esta orden (huerta ' + (rows[0].huerta || 'sin huerta') + ').' };
    }
    await pool.query('DELETE FROM mantenimiento_ordenes WHERE orden = ?', [orden]);
    await pool.query('DELETE FROM reportes WHERE orden = ?', [orden]);
    await registrarAuditoria_('reportes', orden, 'eliminar', nombreUsuario, (rows[0].unidad || '') + ' — ' + (rows[0].descripcion || ''));
    return { success: true };
  } catch (err) {
    return { success: false, error: err.toString() };
  }
}

// ---------------------------------------------------------------
// Diesel
// ---------------------------------------------------------------

async function submitDiesel(data) {
  data = data || {};
  try {
    const folio = await siguienteFolio_(pool, 'diesel', 'DSL', 5);
    await pool.query(
      `INSERT INTO diesel
        (folio, codigo_unidad, unidad, huerta, litros, lectura, nombre, fecha, codigo_implemento, implemento)
       VALUES (?, ?, ?, ?, ?, ?, ?, NOW(), ?, ?)`,
      [
        folio,
        data.unidad || '',
        data.unidadLabel || '',
        data.huerta || '',
        data.litros || 0,
        data.lectura === '' || data.lectura === undefined ? null : data.lectura,
        data.nombre || '',
        data.implemento || null,
        data.implementoLabel || null,
      ]
    );
    return { success: true, folio };
  } catch (err) {
    return { success: false, error: err.toString() };
  }
}

async function getCargasDiesel(code, nombreUsuario, incluirEliminados) {
  await requierePermisoPanel_(code, nombreUsuario, 'diesel', 'visualizar');
  const huertasRestringidas = await obtenerHuertasRestringidasUsuario_(nombreUsuario);
  const condicionesDiesel = [];
  const paramsDiesel = [];
  if (!incluirEliminados) condicionesDiesel.push('d.eliminado = 0');
  if (huertasRestringidas) {
    condicionesDiesel.push('UPPER(TRIM(d.huerta)) IN (?)');
    paramsDiesel.push(huertasRestringidas);
  }
  const whereDiesel = condicionesDiesel.length > 0 ? ' WHERE ' + condicionesDiesel.join(' AND ') : '';
  const [rows] = await pool.query(
    DIESEL_SELECT + whereDiesel + ' ORDER BY d.id DESC',
    paramsDiesel
  );

  // Rendimiento máximo aceptable configurado por equipo (litros por hora de
  // labor), para poder marcar en rojo las capturas cuyo rendimiento calculado
  // salió por encima de ese límite. NULL/ausente = sin límite configurado.
  const [maqRows] = await pool.query('SELECT codigo_unidad AS CodigoUnidad, rendimiento_max AS RendimientoMax, horas_max AS HorasMax FROM maquinaria');
  const rendimientoMaxPorUnidad = {};
  const horasMaxPorUnidad = {};
  maqRows.forEach((m) => {
    rendimientoMaxPorUnidad[m.CodigoUnidad] = m.RendimientoMax === null || m.RendimientoMax === undefined ? null : Number(m.RendimientoMax);
    horasMaxPorUnidad[m.CodigoUnidad] = m.HorasMax === null || m.HorasMax === undefined ? null : Number(m.HorasMax);
  });

  // Para cada carga, buscamos cuál fue la lectura (odómetro/horómetro)
  // registrada la vez anterior para esa MISMA unidad, y calculamos cuántas
  // horas/kilómetros de labor pasaron entre esa lectura y la actual. Esto
  // se hace agrupando por unidad y ordenando cada grupo cronológicamente
  // (no por id, por si alguna carga se capturó fuera de orden), sin alterar
  // el orden general en el que se devuelven las filas (más reciente primero).
  const porUnidad = {};
  rows.forEach((r) => {
    const clave = r.CodigoUnidad || '';
    if (!porUnidad[clave]) porUnidad[clave] = [];
    porUnidad[clave].push(r);
  });

  const anteriorPorId = {};
  Object.keys(porUnidad).forEach((clave) => {
    const grupo = porUnidad[clave].slice().sort((a, b) => {
      const fa = a.Fecha ? new Date(a.Fecha).getTime() : 0;
      const fb = b.Fecha ? new Date(b.Fecha).getTime() : 0;
      if (fa !== fb) return fa - fb;
      return (a.Id || 0) - (b.Id || 0);
    });
    let lecturaPrevia = null;
    grupo.forEach((r) => {
      const lecturaActual = r.Lectura === null || r.Lectura === undefined || r.Lectura === '' ? null : Number(r.Lectura);
      const lecturaActualValida = lecturaActual !== null && !Number.isNaN(lecturaActual);

      let lecturaAnterior = null;
      let horasLabor = null;
      if (lecturaPrevia !== null && lecturaActualValida) {
        lecturaAnterior = lecturaPrevia;
        horasLabor = lecturaActual - lecturaPrevia;
      }
      anteriorPorId[r.Id] = { lecturaAnterior, horasLabor };

      if (lecturaActualValida) lecturaPrevia = lecturaActual;
    });
  });

  const normalizadas = normalizaFilas(rows);
  normalizadas.forEach((r) => {
    const extra = anteriorPorId[r.Id] || { lecturaAnterior: null, horasLabor: null };
    r.LecturaAnterior = extra.lecturaAnterior;
    r.HorasLabor = extra.horasLabor;

    // Rendimiento = litros entre horas de labor. Solo se calcula si hay
    // horas de labor positivas (si no hay lectura anterior, o las horas
    // salieron en 0 o negativas por una lectura capturada fuera de orden,
    // no se puede calcular un rendimiento confiable).
    const litros = r.Litros === null || r.Litros === undefined || r.Litros === '' ? null : Number(r.Litros);
    const horas = extra.horasLabor;
    if (litros !== null && !Number.isNaN(litros) && horas !== null && horas !== undefined && horas > 0) {
      r.Rendimiento = Math.round((litros / horas) * 100) / 100;
    } else {
      r.Rendimiento = null;
    }
    r.RendimientoMax = Object.prototype.hasOwnProperty.call(rendimientoMaxPorUnidad, r.CodigoUnidad)
      ? rendimientoMaxPorUnidad[r.CodigoUnidad]
      : null;
    r.HorasMax = Object.prototype.hasOwnProperty.call(horasMaxPorUnidad, r.CodigoUnidad)
      ? horasMaxPorUnidad[r.CodigoUnidad]
      : null;
  });
  return normalizadas;
}

// Staff: captura manualmente una carga de diesel NUEVA desde el Panel (a
// diferencia de submitDiesel(), que es la que usa Taller.html — esta es
// aparte para no tocar ese flujo). El campo "Cargó" siempre se llena con el
// usuario que inició sesión en el Panel, igual que en editarCargaDiesel.
async function crearCargaDieselPanel(code, nombreUsuario, data) {
  await requierePermisoPanel_(code, nombreUsuario, 'diesel', 'capturar');
  data = data || {};
  try {
    const huerta = (data.huerta || '').toString().trim();
    const codigoUnidad = (data.unidad || '').toString().trim();
    const unidadLabel = (data.unidadLabel || '').toString().trim();
    const litros = Number(data.litros);
    const lectura = (data.lectura === '' || data.lectura === undefined || data.lectura === null) ? null : Number(data.lectura);
    const fecha = normalizarFechaLocal_(data.fecha);
    const codigoImplemento = (data.implemento || '').toString().trim() || null;
    const implementoLabel = (data.implementoLabel || '').toString().trim() || null;
    const nombre = (nombreUsuario || '').toString().trim();
    const operador = (data.operador || '').toString().trim() || null;

    if (!huerta) return { success: false, error: 'Selecciona la huerta.' };
    if (!codigoUnidad) return { success: false, error: 'Selecciona la unidad.' };
    if (!litros || litros <= 0) return { success: false, error: 'Escribe una cantidad de litros válida.' };
    if (!fecha) return { success: false, error: 'Selecciona la fecha.' };
    if (!nombre) return { success: false, error: 'No se pudo identificar quién captura la carga.' };
    const huertasRestringidas = await obtenerHuertasRestringidasUsuario_(nombreUsuario);
    if (!huertaPermitida_(huertasRestringidas, huerta)) {
      return { success: false, error: 'Tu usuario no tiene acceso a capturar diesel en la huerta ' + huerta + '.' };
    }

    const folio = await siguienteFolio_(pool, 'diesel', 'DSL', 5);
    const [result] = await pool.query(
      `INSERT INTO diesel
        (folio, codigo_unidad, unidad, huerta, litros, lectura, nombre, operador, fecha, codigo_implemento, implemento)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [folio, codigoUnidad, unidadLabel, huerta, litros, lectura, nombre, operador, fecha, codigoImplemento, implementoLabel]
    );
    await registrarAuditoria_('diesel', result.insertId, 'crear', nombreUsuario, unidadLabel + ' — ' + litros + ' L');
    return { success: true, id: result.insertId, folio };
  } catch (err) {
    return { success: false, error: err.toString() };
  }
}

// Staff: corrige una carga de diesel ya registrada, desde el Panel. Deja
// constancia de quién y cuándo la modificó (modificado_por/modificado_en) —
// nombreUsuario es el usuario que inició sesión en el Panel (ver
// validarUsuario), no el "nombre" original de quien cargó el diesel.
async function editarCargaDiesel(code, nombreUsuario, id, data) {
  await requierePermisoPanel_(code, nombreUsuario, 'diesel', 'capturar');
  data = data || {};
  try {
    const idNum = Number(id);
    if (!idNum) return { success: false, error: 'Falta el identificador de la carga.' };
    const [rows] = await pool.query('SELECT id, codigo_unidad, unidad, huerta FROM diesel WHERE id = ?', [idNum]);
    if (rows.length === 0) return { success: false, error: 'No se encontró esa carga de diesel.' };
    const huertasRestringidas = await obtenerHuertasRestringidasUsuario_(nombreUsuario);
    if (!huertaPermitida_(huertasRestringidas, rows[0].huerta)) {
      return { success: false, error: 'Tu usuario no tiene acceso a esta carga (huerta ' + (rows[0].huerta || 'sin huerta') + ').' };
    }
    const codigoUnidadOriginal = rows[0].codigo_unidad;

    const huerta = (data.huerta || '').toString().trim();
    const codigoUnidad = (data.unidad || '').toString().trim();
    const unidadLabel = (data.unidadLabel || '').toString().trim();
    const litros = Number(data.litros);
    const lectura = (data.lectura === '' || data.lectura === undefined || data.lectura === null) ? null : Number(data.lectura);
    const fecha = normalizarFechaLocal_(data.fecha);
    const codigoImplemento = (data.implemento || '').toString().trim() || null;
    const implementoLabel = (data.implementoLabel || '').toString().trim() || null;
    const operador = (data.operador || '').toString().trim() || null;

    if (!huerta) return { success: false, error: 'Selecciona la huerta.' };
    if (!codigoUnidad) return { success: false, error: 'Selecciona la unidad.' };
    if (!litros || litros <= 0) return { success: false, error: 'Escribe una cantidad de litros válida.' };
    if (!fecha) return { success: false, error: 'Selecciona la fecha.' };
    if (!huertaPermitida_(huertasRestringidas, huerta)) {
      return { success: false, error: 'Tu usuario no tiene acceso a mover esta carga a la huerta ' + huerta + '.' };
    }

    const modificadoPor = (nombreUsuario || '').toString().trim() || null;

    await pool.query(
      `UPDATE diesel SET codigo_unidad = ?, unidad = ?, huerta = ?, litros = ?, lectura = ?, operador = ?, fecha = ?,
        codigo_implemento = ?, implemento = ?, modificado_por = ?, modificado_en = NOW()
       WHERE id = ?`,
      [codigoUnidad, unidadLabel, huerta, litros, lectura, operador, fecha, codigoImplemento, implementoLabel, modificadoPor, idNum]
    );
    await registrarAuditoria_('diesel', idNum, 'editar', nombreUsuario, unidadLabel + ' — ' + litros + ' L');
    // Si esta carga traía la lectura que se estaba usando como "lectura
    // actual" de algún preventivo (p. ej. se había capturado mal y disparó
    // una orden automática), al corregirla puede que ese equipo ya no esté
    // vencido — revisa y cancela esas órdenes. Se revisan tanto la unidad
    // original como la nueva, por si la carga se reasignó de equipo.
    await cancelarOrdenesPreventivasYaNoVencidas_(codigoUnidadOriginal, nombreUsuario);
    if (codigoUnidad !== codigoUnidadOriginal) {
      await cancelarOrdenesPreventivasYaNoVencidas_(codigoUnidad, nombreUsuario);
    }
    return { success: true };
  } catch (err) {
    return { success: false, error: err.toString() };
  }
}

// Staff: elimina (borrado suave) una carga de diesel desde el Panel. No
// borra la fila — la marca eliminado=1 con quién y cuándo, para que se
// pueda ver/restaurar después con "Mostrar eliminados" (ver
// getCargasDiesel/restaurarCargaDiesel). getCargasDiesel calcula
// "Anterior" y "Horas de labor" al vuelo cada vez que se piden las cargas
// ACTIVAS, así que en cuanto se elimina una captura de en medio, la
// siguiente carga de esa misma unidad automáticamente vuelve a
// compararse contra la que quedó antes de ella (ya no contra la que se
// acaba de eliminar).
async function eliminarCargaDiesel(code, nombreUsuario, id) {
  await requierePermisoPanel_(code, nombreUsuario, 'diesel', 'capturar');
  try {
    const idNum = Number(id);
    if (!idNum) return { success: false, error: 'Falta el identificador de la carga.' };
    const [rows] = await pool.query('SELECT id, codigo_unidad, unidad, litros, huerta, eliminado FROM diesel WHERE id = ?', [idNum]);
    if (rows.length === 0) return { success: false, error: 'No se encontró esa carga de diesel.' };
    const huertasRestringidas = await obtenerHuertasRestringidasUsuario_(nombreUsuario);
    if (!huertaPermitida_(huertasRestringidas, rows[0].huerta)) {
      return { success: false, error: 'Tu usuario no tiene acceso a esta carga (huerta ' + (rows[0].huerta || 'sin huerta') + ').' };
    }
    if (rows[0].eliminado) return { success: false, error: 'Esa carga ya estaba eliminada.' };
    const eliminadoPor = (nombreUsuario || '').toString().trim() || null;
    await pool.query(
      'UPDATE diesel SET eliminado = 1, eliminado_por = ?, eliminado_en = NOW() WHERE id = ?',
      [eliminadoPor, idNum]
    );
    await registrarAuditoria_('diesel', idNum, 'eliminar', nombreUsuario, (rows[0].unidad || '') + ' — ' + rows[0].litros + ' L');
    // Si esta carga era la que se estaba usando como "lectura actual" de
    // algún preventivo, al borrarla el equipo puede volver a su lectura
    // anterior (o quedarse sin ninguna) y dejar de estar vencido.
    await cancelarOrdenesPreventivasYaNoVencidas_(rows[0].codigo_unidad, nombreUsuario);
    return { success: true };
  } catch (err) {
    return { success: false, error: err.toString() };
  }
}

// Staff: revierte una eliminación de carga de diesel (botón "Restaurar",
// visible solo con "Mostrar eliminados" activo).
async function restaurarCargaDiesel(code, nombreUsuario, id) {
  await requierePermisoPanel_(code, nombreUsuario, 'diesel', 'capturar');
  try {
    const idNum = Number(id);
    if (!idNum) return { success: false, error: 'Falta el identificador de la carga.' };
    const [rows] = await pool.query('SELECT id, unidad, litros, huerta, eliminado FROM diesel WHERE id = ?', [idNum]);
    if (rows.length === 0) return { success: false, error: 'No se encontró esa carga de diesel.' };
    const huertasRestringidas = await obtenerHuertasRestringidasUsuario_(nombreUsuario);
    if (!huertaPermitida_(huertasRestringidas, rows[0].huerta)) {
      return { success: false, error: 'Tu usuario no tiene acceso a esta carga (huerta ' + (rows[0].huerta || 'sin huerta') + ').' };
    }
    if (!rows[0].eliminado) return { success: false, error: 'Esa carga no estaba eliminada.' };
    await pool.query('UPDATE diesel SET eliminado = 0, eliminado_por = NULL, eliminado_en = NULL WHERE id = ?', [idNum]);
    await registrarAuditoria_('diesel', idNum, 'restaurar', nombreUsuario, (rows[0].unidad || '') + ' — ' + rows[0].litros + ' L');
    return { success: true };
  } catch (err) {
    return { success: false, error: err.toString() };
  }
}

// Debe coincidir con la constante HUERTAS de public/Panel.html — se usa
// aquí solo como ayuda para que la IA tenga contra qué comparar el nombre
// de huerta que lea en el encabezado de la bitácora.
const HUERTAS_DIESEL_ = [
  'ALMA LUCIA', 'AURORA', 'BRILLANTE', 'GUADALUPE', 'LA CRUZ', 'MATA CAZUELA',
  'MATA DE GALLO', 'NIDO DE AGUILA', 'ORGANITO', 'PASO LIMON', 'RANCHO NUEVO',
  'SAN CENOVIO', 'SAN JOACHIN', 'SANTA EULALIA',
];

// Staff (Panel, pestaña Diesel): recibe una o varias fotos de bitácoras
// "Control Diesel" llenadas a mano (igual que en Combustible Automotriz, se
// puede mandar varias de un jalón) y le pide a la IA que las lea TODAS en
// un solo llamado y regrese, por cada renglón con datos de CUALQUIERA de
// las fotos, los campos que ya usa una carga de diesel normal (fecha,
// unidad, huerta, litros, lectura/horómetro) — todos juntos en una sola
// lista, sin agrupar por foto (la tabla de revisión no distingue de qué
// foto salió cada renglón, igual que antes cuando solo se admitía una).
// NO guarda nada todavía — regresa los renglones para que el capturista
// los revise, corrija lo que haga falta y los guarde con
// guardarCargasDieselLote().
async function leerBitacoraDiesel(code, nombreUsuario, fotosDataUrl) {
  await requierePermisoPanel_(code, nombreUsuario, 'diesel', 'capturar');
  if (!Array.isArray(fotosDataUrl) || fotosDataUrl.length === 0) {
    throw new Error('No se recibió ninguna foto.');
  }

  const [maqRows] = await pool.query(
    `SELECT codigo_unidad AS CodigoUnidad, unidad AS Unidad FROM maquinaria WHERE usa_diesel = 1 ORDER BY unidad`
  );
  if (maqRows.length === 0) {
    throw new Error(
      'Todavía no hay ningún equipo marcado como "Funciona con diesel" en el Catálogo, así que no hay ' +
        'con qué comparar los tractores de la bitácora. Marca primero esos equipos en el Catálogo.'
    );
  }
  // Implementos (accesorios que se enganchan a un tractor, p.ej. "IA058-
  // CHAPEADORA.15") — mismo criterio que usa el modal de captura manual
  // (equiposDieselPermitidos/implementos en Panel.html): cualquier equipo
  // del Catálogo cuyo código empiece con "IA", sin filtrar por "Funciona
  // con diesel" (el implemento en sí no carga diesel, el tractor sí).
  const [implRows] = await pool.query(
    `SELECT codigo_unidad AS CodigoUnidad, unidad AS Unidad FROM maquinaria
     WHERE UPPER(TRIM(COALESCE(unidad, codigo_unidad))) LIKE 'IA%' ORDER BY unidad`
  );
  const listaEquipos = maqRows.map((m) => '- ' + m.CodigoUnidad + ' (' + m.Unidad + ')').join('\n');
  const listaImplementos = implRows.map((m) => '- ' + m.CodigoUnidad + ' (' + m.Unidad + ')').join('\n');
  const listaHuertas = HUERTAS_DIESEL_.join(', ');

  // Fecha de hoy (servidor), en AAAA-MM-DD: se le pasa a la IA como
  // referencia para inferir el año (y a veces el mes) de las fechas de la
  // bitácora, que casi nunca se anotan completas a mano.
  const hoy = new Date();
  const hoyIso =
    hoy.getFullYear() + '-' + String(hoy.getMonth() + 1).padStart(2, '0') + '-' + String(hoy.getDate()).padStart(2, '0');

  // Formato de salida compacto (arreglo de arreglos, con el orden de
  // columnas fijo, en vez de un objeto con llaves repetidas en cada
  // renglón) — la IA tiene que escribir menos para bitácoras de varios
  // renglones, lo que ayuda a que termine más rápido.
  //
  // La fecha SÍ se le vuelve a pedir a la IA (se había quitado, pero el
  // capturista prefiere ver el día que trae cada renglón y decidir él
  // mismo cuáles quitar de la captura — por ejemplo, días que ya había
  // capturado antes de una bitácora que se llena varios días seguidos —
  // en vez de que el sistema le asigne un día por default y tenga que
  // corregirlo a mano renglón por renglón). No se descarta ningún renglón
  // por su fecha: todos se muestran para que el capturista los revise y
  // quite los que no quiera con la ✕ — ver el frontend de "Capturar
  // bitácora por foto" / guardarCargasDieselLote.
  const n = fotosDataUrl.length;
  const prompt =
    'Te mando ' + n + ' foto(s) (cada una está marcada arriba como "Foto #N:") de bitácoras de "Control Diesel" ' +
    'llenadas a mano en papel por personal de campo — cada foto es una hoja de bitácora, y puede traer varios ' +
    'renglones. Cada renglón representa una carga de diesel a un tractor.\n\n' +
    'Léelas todas con cuidado y regresa ÚNICAMENTE un arreglo JSON de arreglos (sin texto antes ni después, sin ' +
    'explicación, sin marcar código) con TODOS los renglones que tengan datos de TODAS las fotos juntos en una ' +
    'sola lista (ignora los renglones vacíos; no agrupes ni separes la respuesta por foto, ni marques de cuál ' +
    'foto salió cada renglón). Cada renglón es un arreglo de EXACTAMENTE 8 posiciones, en este orden:\n\n' +
    '1. La fecha de ese renglón (columna FECHA), en formato "AAAA-MM-DD". La bitácora normalmente NO trae el ' +
    'año, y a veces la fecha solo se anota una vez al inicio de un grupo de renglones del mismo día (los ' +
    'siguientes renglones sin fecha propia son del mismo día que el último que sí la tenía, DENTRO DE LA MISMA ' +
    'FOTO — nunca le copies la fecha a un renglón de una foto distinta). Hoy es ' +
    hoyIso +
    '; esta bitácora normalmente se captura pocos días después de llenarse, así que usa esa fecha como ' +
    'referencia para inferir el año (y el mes, si solo viene el día). Si de verdad no se puede leer ni ' +
    'inferir, usa null — no inventes una fecha.\n' +
    '2. Tal cual está escrito el tractor/código en la columna "TRACTOR" (ej. "AF=571"), sin interpretar.\n' +
    '3. El "codigo_unidad" (la parte ANTES del paréntesis) de la siguiente lista de equipos conocidos que ' +
    'mejor corresponda a la posición 2. En la bitácora el tractor casi siempre se anota abreviado o distinto ' +
    'a como está en el catálogo (por ejemplo solo un número corto, sin letras ni guiones) — compara con ' +
    'cuidado la posición 2 contra CADA equipo de la lista, tanto contra su codigo_unidad como contra su ' +
    'nombre entre paréntesis, buscando coincidencias parciales o números en común, antes de decidir que no ' +
    'hay ninguno. Solo usa "" si de verdad no hay ningún equipo de la lista que pueda corresponder.\n' +
    '4. El número de la columna de horómetro FINAL, o null si no se puede leer.\n' +
    '5. El número de la columna "TOTAL LITROS", como número (o null si no se puede leer).\n' +
    '6. Si la bitácora trae un encabezado de HUERTA que aplica a toda la hoja, el nombre de esta lista de ' +
    'huertas conocidas que mejor corresponda; si no se puede determinar, usa "".\n' +
    '7. Tal cual está escrito en la columna IMPLEMENTO o APERO de ese renglón (el accesorio que traía ' +
    'enganchado el tractor, por ejemplo una chapeadora, aspersora, subsuelo, rastra, fertilizadora, etc.), sin ' +
    'interpretar — usa "" si esa bitácora no tiene esa columna o el renglón no trae nada anotado ahí.\n' +
    '8. El "codigo_unidad" (empieza con "IA") de la siguiente lista de implementos conocidos que mejor ' +
    'corresponda a la posición 7, con el mismo criterio de comparación que usaste para la posición 3 (coincidencias ' +
    'parciales, abreviado, etc.); usa "" si la posición 7 vino vacía o no hay ningún implemento de la lista que ' +
    'corresponda.\n\n' +
    'Ejemplo de un renglón: ["2026-09-16","AF=571","AF-571-L3800",1234.5,25,"SANTA EULALIA","Chapeadora","IA058-CHAPEADORA.15"]\n\n' +
    'Lista de equipos conocidos (codigo_unidad y nombre) que ya cargan diesel:\n' +
    listaEquipos +
    '\n\nLista de implementos conocidos (codigo_unidad y nombre):\n' +
    listaImplementos +
    '\n\nLista de huertas conocidas:\n' +
    listaHuertas +
    '\n\nResponde SOLO con el arreglo JSON de arreglos (todos los renglones de todas las fotos juntos), nada más.';

  const textoRespuesta = await preguntarleAClaudeSobreImagenes_(fotosDataUrl, prompt);
  const filas = extraerJson_(textoRespuesta);
  if (!Array.isArray(filas)) throw new Error('La IA no regresó una lista de renglones.');

  const mapaEquipos = {};
  maqRows.forEach((m) => {
    mapaEquipos[m.CodigoUnidad] = m.Unidad;
  });
  const mapaImplementos = {};
  implRows.forEach((m) => {
    mapaImplementos[m.CodigoUnidad] = m.Unidad;
  });

  // AAAA-MM-DD válido (no revisa que el día/mes existan de verdad — con eso
  // basta para decidir si se usa o se descarta, el frontend ya trae su
  // propio manejo de fechas raras vía el selector "Otro día...").
  const FECHA_VALIDA_RE = /^\d{4}-\d{2}-\d{2}$/;

  const normalizadas = filas.map((f) => {
    // Compatibilidad: si por alguna razón la IA regresa el formato viejo
    // sin fecha (5 posiciones) en vez de las 6-8 que se le piden ahora, no
    // se rompe — simplemente esos renglones quedan sin fecha (el frontend
    // les asigna un día por default) en vez de tronar toda la lectura.
    // Igual para el implemento (posiciones 7-8): si la IA regresó el
    // formato viejo de 6 posiciones sin implemento, esos renglones
    // simplemente quedan sin implemento detectado (se puede elegir a mano).
    const esArreglo = Array.isArray(f);
    const tieneFecha = esArreglo && f.length >= 6;
    const offset = tieneFecha ? 1 : 0;
    const rawFecha = tieneFecha ? f[0] : f && f.fecha;
    const rawTractorTexto = esArreglo ? f[offset] : f && f.tractorTexto;
    const rawCodigoUnidad = esArreglo ? f[offset + 1] : f && f.codigoUnidad;
    const rawHorometroFinal = esArreglo ? f[offset + 2] : f && f.horometroFinal;
    const rawLitros = esArreglo ? f[offset + 3] : f && f.litros;
    const rawHuerta = esArreglo ? f[offset + 4] : f && f.huerta;
    const tieneImplemento = esArreglo && f.length >= offset + 7;
    const rawImplementoTexto = tieneImplemento ? f[offset + 5] : f && f.implementoTexto;
    const rawCodigoImplemento = tieneImplemento ? f[offset + 6] : f && f.codigoImplemento;

    const fechaLeida = (rawFecha || '').toString().trim();
    const codigoUnidad = (rawCodigoUnidad || '').toString().trim();
    const coincide = Object.prototype.hasOwnProperty.call(mapaEquipos, codigoUnidad);
    const codigoImplemento = (rawCodigoImplemento || '').toString().trim();
    const coincideImplemento = Object.prototype.hasOwnProperty.call(mapaImplementos, codigoImplemento);
    const litros = rawLitros === null || rawLitros === undefined || rawLitros === '' ? null : Number(rawLitros);
    const horometroFinal =
      rawHorometroFinal === null || rawHorometroFinal === undefined || rawHorometroFinal === ''
        ? null
        : Number(rawHorometroFinal);
    const huertaLeida = (rawHuerta || '').toString().trim().toUpperCase();
    return {
      // Cadena vacía si la IA no pudo leer/inferir la fecha de este
      // renglón — el frontend la detecta y le asigna un día por default
      // (en vez de dejarlo sin nada), para no perder el renglón.
      fecha: FECHA_VALIDA_RE.test(fechaLeida) ? fechaLeida : '',
      tractorTexto: (rawTractorTexto || '').toString().trim(),
      codigoUnidad: coincide ? codigoUnidad : '',
      unidadLabel: coincide ? mapaEquipos[codigoUnidad] : '',
      lectura: horometroFinal !== null && !Number.isNaN(horometroFinal) ? horometroFinal : null,
      litros: litros !== null && !Number.isNaN(litros) ? litros : null,
      huerta: HUERTAS_DIESEL_.indexOf(huertaLeida) !== -1 ? huertaLeida : '',
      implementoTexto: (rawImplementoTexto || '').toString().trim(),
      codigoImplemento: coincideImplemento ? codigoImplemento : '',
      implementoLabel: coincideImplemento ? mapaImplementos[codigoImplemento] : '',
    };
  });

  return { success: true, filas: normalizadas };
}

// Staff (Panel): guarda de un jalón varias cargas de diesel a la vez (las
// que vinieron de revisar/corregir la lectura por IA de una bitácora en
// foto — ver leerBitacoraDiesel). Cada renglón se valida y se guarda por
// separado con la misma lógica que crearCargaDieselPanel, así que un
// renglón con datos incompletos no impide que se guarden los demás; el
// capturista siempre queda logueado como quien cargó ("nombre"), igual que
// en la captura manual.
async function guardarCargasDieselLote(code, nombreUsuario, cargas) {
  await requierePermisoPanel_(code, nombreUsuario, 'diesel', 'capturar');
  if (!Array.isArray(cargas) || cargas.length === 0) {
    return { success: false, error: 'No hay renglones para guardar.' };
  }
  const nombre = (nombreUsuario || '').toString().trim();
  if (!nombre) return { success: false, error: 'No se pudo identificar quién captura la carga.' };
  const huertasRestringidas = await obtenerHuertasRestringidasUsuario_(nombreUsuario);

  const guardadas = [];
  const errores = [];
  for (let i = 0; i < cargas.length; i++) {
    const data = cargas[i] || {};
    try {
      const huerta = (data.huerta || '').toString().trim();
      const codigoUnidad = (data.unidad || '').toString().trim();
      const unidadLabel = (data.unidadLabel || '').toString().trim();
      const codigoImplemento = (data.implemento || '').toString().trim() || null;
      const implementoLabel = codigoImplemento ? (data.implementoLabel || '').toString().trim() || null : null;
      const litros = Number(data.litros);
      const lectura =
        data.lectura === '' || data.lectura === undefined || data.lectura === null ? null : Number(data.lectura);
      const fecha = normalizarFechaLocal_(data.fecha);

      if (!huerta) throw new Error('Falta la huerta.');
      if (!huertaPermitida_(huertasRestringidas, huerta)) throw new Error('Tu usuario no tiene acceso a la huerta ' + huerta + '.');
      if (!codigoUnidad) throw new Error('Falta seleccionar la unidad.');
      if (!litros || Number.isNaN(litros) || litros <= 0) throw new Error('Litros inválidos.');
      if (!fecha) throw new Error('Fecha inválida.');

      const folio = await siguienteFolio_(pool, 'diesel', 'DSL', 5);
      const [result] = await pool.query(
        `INSERT INTO diesel (folio, codigo_unidad, unidad, huerta, litros, lectura, nombre, fecha, codigo_implemento, implemento)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [folio, codigoUnidad, unidadLabel, huerta, litros, lectura, nombre, fecha, codigoImplemento, implementoLabel]
      );
      await registrarAuditoria_('diesel', result.insertId, 'crear', nombreUsuario, unidadLabel + ' — ' + litros + ' L (bitácora foto)');
      guardadas.push({ index: i, id: result.insertId, folio });
    } catch (err) {
      errores.push({ index: i, error: err.message || err.toString() });
    }
  }
  return { success: errores.length === 0, guardadas, errores };
}

// ---------------------------------------------------------------
// Combustible Automotriz (autos/camionetas — aparte de diesel, que es solo
// para maquinaria agrícola). No maneja huerta ni implemento; sí guarda
// precio por litro y total, porque el ticket de la gasolinera los trae
// impresos. "lectura" es el odómetro (KM). Mismo patrón de borrado suave
// que diesel.
// ---------------------------------------------------------------

async function getCombustibleAutomotriz(code, nombreUsuario, incluirEliminados) {
  await requierePermisoPanel_(code, nombreUsuario, 'combustible_automotriz', 'visualizar');
  const [rows] = await pool.query(
    CA_SELECT + (incluirEliminados ? '' : ' WHERE c.eliminado = 0') + ' ORDER BY c.id DESC'
  );
  return normalizaFilas(rows);
}

// Busca en el Catálogo el "Tipo de combustible" (gasolina/diesel) marcado
// para este vehículo, para copiarlo a la carga que se esté guardando (ver
// la nota junto a maquinaria.combustible_automotriz_tipo en
// db/schema.sql). Si el vehículo no existe o no tiene nada marcado, se usa
// 'gasolina' — así ninguna carga se guarda con el campo vacío.
async function obtenerTipoCombustibleAutomotriz_(codigoUnidad) {
  if (!codigoUnidad) return 'gasolina';
  const [rows] = await pool.query('SELECT combustible_automotriz_tipo FROM maquinaria WHERE codigo_unidad = ?', [codigoUnidad]);
  const tipo = rows.length ? String(rows[0].combustible_automotriz_tipo || '').toLowerCase() : '';
  return tipo === 'diesel' ? 'diesel' : 'gasolina';
}

// Staff: captura manualmente una carga de gasolina NUEVA desde el Panel. El
// campo "Cargó" siempre se llena con el usuario que inició sesión en el
// Panel, igual que en crearCargaDieselPanel/editarCargaGasolina. Si no
// viene el total pero sí litros y precio por litro, se calcula solo.
async function crearCargaGasolinaPanel(code, nombreUsuario, data) {
  await requierePermisoPanel_(code, nombreUsuario, 'combustible_automotriz', 'capturar');
  data = data || {};
  try {
    const codigoUnidad = (data.unidad || '').toString().trim();
    const unidadLabel = (data.unidadLabel || '').toString().trim();
    const litros = Number(data.litros);
    const precioLitro =
      data.precioLitro === '' || data.precioLitro === undefined || data.precioLitro === null ? null : Number(data.precioLitro);
    let total = data.total === '' || data.total === undefined || data.total === null ? null : Number(data.total);
    if ((total === null || Number.isNaN(total)) && precioLitro !== null && !Number.isNaN(precioLitro) && litros) {
      total = Math.round(litros * precioLitro * 100) / 100;
    }
    const lectura = data.lectura === '' || data.lectura === undefined || data.lectura === null ? null : Number(data.lectura);
    const fecha = normalizarFechaLocal_(data.fecha);
    const nombre = (nombreUsuario || '').toString().trim();
    const empresa = (data.empresa || '').toString().trim() || null;
    const proveedor = (data.proveedor || '').toString().trim() || null;

    if (!codigoUnidad) return { success: false, error: 'Selecciona el vehículo.' };
    if (!litros || litros <= 0) return { success: false, error: 'Escribe una cantidad de litros válida.' };
    if (!fecha) return { success: false, error: 'Selecciona la fecha.' };
    if (!nombre) return { success: false, error: 'No se pudo identificar quién captura la carga.' };

    const tipoCombustible = await obtenerTipoCombustibleAutomotriz_(codigoUnidad);
    const folio = await siguienteFolio_(pool, 'combustible_automotriz', 'GAS', 5);
    const [result] = await pool.query(
      `INSERT INTO combustible_automotriz
        (folio, codigo_unidad, unidad, litros, precio_litro, total, lectura, tipo_combustible, empresa, proveedor, nombre, fecha)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [folio, codigoUnidad, unidadLabel, litros, precioLitro, total, lectura, tipoCombustible, empresa, proveedor, nombre, fecha]
    );
    await registrarAuditoria_('combustible_automotriz', result.insertId, 'crear', nombreUsuario, unidadLabel + ' — ' + litros + ' L');
    return { success: true, id: result.insertId, folio };
  } catch (err) {
    return { success: false, error: err.toString() };
  }
}

// Staff: corrige una carga de gasolina ya registrada, desde el Panel.
async function editarCargaGasolina(code, nombreUsuario, id, data) {
  await requierePermisoPanel_(code, nombreUsuario, 'combustible_automotriz', 'capturar');
  data = data || {};
  try {
    const idNum = Number(id);
    if (!idNum) return { success: false, error: 'Falta el identificador de la carga.' };
    const [rows] = await pool.query('SELECT id, codigo_unidad, unidad FROM combustible_automotriz WHERE id = ?', [idNum]);
    if (rows.length === 0) return { success: false, error: 'No se encontró esa carga de gasolina.' };
    const codigoUnidadOriginal = rows[0].codigo_unidad;

    const codigoUnidad = (data.unidad || '').toString().trim();
    const unidadLabel = (data.unidadLabel || '').toString().trim();
    const litros = Number(data.litros);
    const precioLitro =
      data.precioLitro === '' || data.precioLitro === undefined || data.precioLitro === null ? null : Number(data.precioLitro);
    let total = data.total === '' || data.total === undefined || data.total === null ? null : Number(data.total);
    if ((total === null || Number.isNaN(total)) && precioLitro !== null && !Number.isNaN(precioLitro) && litros) {
      total = Math.round(litros * precioLitro * 100) / 100;
    }
    const lectura = data.lectura === '' || data.lectura === undefined || data.lectura === null ? null : Number(data.lectura);
    const fecha = normalizarFechaLocal_(data.fecha);
    const empresa = (data.empresa || '').toString().trim() || null;
    const proveedor = (data.proveedor || '').toString().trim() || null;

    if (!codigoUnidad) return { success: false, error: 'Selecciona el vehículo.' };
    if (!litros || litros <= 0) return { success: false, error: 'Escribe una cantidad de litros válida.' };
    if (!fecha) return { success: false, error: 'Selecciona la fecha.' };

    const modificadoPor = (nombreUsuario || '').toString().trim() || null;
    // Se recalcula por si al editar también se cambió el vehículo — así la
    // carga queda marcada con el tipo de combustible del vehículo correcto.
    const tipoCombustible = await obtenerTipoCombustibleAutomotriz_(codigoUnidad);

    await pool.query(
      `UPDATE combustible_automotriz SET codigo_unidad = ?, unidad = ?, litros = ?, precio_litro = ?, total = ?,
        lectura = ?, tipo_combustible = ?, empresa = ?, proveedor = ?, fecha = ?, modificado_por = ?, modificado_en = NOW()
       WHERE id = ?`,
      [codigoUnidad, unidadLabel, litros, precioLitro, total, lectura, tipoCombustible, empresa, proveedor, fecha, modificadoPor, idNum]
    );
    await registrarAuditoria_('combustible_automotriz', idNum, 'editar', nombreUsuario, unidadLabel + ' — ' + litros + ' L');
    // Si esta carga traía la lectura (odómetro) que se estaba usando como
    // "lectura actual" de algún servicio de Servicios Automotrices, al
    // corregirla puede que ese vehículo ya no esté vencido — revisa y
    // cancela esas órdenes (mismo criterio que editarCargaDiesel). Se
    // revisan tanto el vehículo original como el nuevo, por si la carga se
    // reasignó de vehículo.
    await cancelarOrdenesPreventivasYaNoVencidas_(codigoUnidadOriginal, nombreUsuario);
    if (codigoUnidad !== codigoUnidadOriginal) {
      await cancelarOrdenesPreventivasYaNoVencidas_(codigoUnidad, nombreUsuario);
    }
    return { success: true };
  } catch (err) {
    return { success: false, error: err.toString() };
  }
}

// Staff: elimina (borrado suave) una carga de gasolina desde el Panel.
async function eliminarCargaGasolina(code, nombreUsuario, id) {
  await requierePermisoPanel_(code, nombreUsuario, 'combustible_automotriz', 'capturar');
  try {
    const idNum = Number(id);
    if (!idNum) return { success: false, error: 'Falta el identificador de la carga.' };
    const [rows] = await pool.query('SELECT id, codigo_unidad, unidad, litros, eliminado FROM combustible_automotriz WHERE id = ?', [idNum]);
    if (rows.length === 0) return { success: false, error: 'No se encontró esa carga de gasolina.' };
    if (rows[0].eliminado) return { success: false, error: 'Esa carga ya estaba eliminada.' };
    const eliminadoPor = (nombreUsuario || '').toString().trim() || null;
    await pool.query(
      'UPDATE combustible_automotriz SET eliminado = 1, eliminado_por = ?, eliminado_en = NOW() WHERE id = ?',
      [eliminadoPor, idNum]
    );
    await registrarAuditoria_('combustible_automotriz', idNum, 'eliminar', nombreUsuario, (rows[0].unidad || '') + ' — ' + rows[0].litros + ' L');
    // Si esta carga era la que se estaba usando como "lectura actual" de
    // algún servicio, al borrarla el vehículo puede volver a su lectura
    // anterior (o quedarse sin ninguna) y dejar de estar vencido.
    await cancelarOrdenesPreventivasYaNoVencidas_(rows[0].codigo_unidad, nombreUsuario);
    return { success: true };
  } catch (err) {
    return { success: false, error: err.toString() };
  }
}

// Staff: revierte una eliminación de carga de gasolina.
async function restaurarCargaGasolina(code, nombreUsuario, id) {
  await requierePermisoPanel_(code, nombreUsuario, 'combustible_automotriz', 'capturar');
  try {
    const idNum = Number(id);
    if (!idNum) return { success: false, error: 'Falta el identificador de la carga.' };
    const [rows] = await pool.query('SELECT id, unidad, litros, eliminado FROM combustible_automotriz WHERE id = ?', [idNum]);
    if (rows.length === 0) return { success: false, error: 'No se encontró esa carga de gasolina.' };
    if (!rows[0].eliminado) return { success: false, error: 'Esa carga no estaba eliminada.' };
    await pool.query('UPDATE combustible_automotriz SET eliminado = 0, eliminado_por = NULL, eliminado_en = NULL WHERE id = ?', [idNum]);
    await registrarAuditoria_('combustible_automotriz', idNum, 'restaurar', nombreUsuario, (rows[0].unidad || '') + ' — ' + rows[0].litros + ' L');
    return { success: true };
  } catch (err) {
    return { success: false, error: err.toString() };
  }
}

// Staff (Panel, pestaña Combustible Automotriz): recibe VARIAS fotos y le
// pide a la IA que las lea TODAS en un solo llamado. Cada foto puede traer
// un solo ticket o VARIOS tickets físicos juntos en una misma imagen (por
// ejemplo, varios tickets acomodados sobre una mesa y fotografiados de un
// jalón) — la IA identifica cada ticket individual por separado y regresa
// un renglón por cada uno (no uno por foto), con los campos de una carga de
// gasolina (de qué foto salió, fecha, vehículo, odómetro, litros, precio
// por litro, total). NO guarda nada todavía — regresa los renglones para
// que el capturista los revise, corrija lo que haga falta y los guarde con
// guardarCargasGasolinaLote().
async function leerTicketsGasolina(code, nombreUsuario, fotosDataUrl) {
  await requierePermisoPanel_(code, nombreUsuario, 'combustible_automotriz', 'capturar');
  if (!Array.isArray(fotosDataUrl) || fotosDataUrl.length === 0) {
    throw new Error('No se recibió ninguna foto.');
  }

  const [maqRows] = await pool.query(
    `SELECT codigo_unidad AS CodigoUnidad, unidad AS Unidad FROM maquinaria WHERE usa_gasolina = 1 ORDER BY unidad`
  );
  if (maqRows.length === 0) {
    throw new Error(
      'Todavía no hay ningún vehículo marcado como "Funciona con gasolina" en el Catálogo, así que no hay ' +
        'con qué comparar los tickets. Marca primero esos vehículos en el Catálogo.'
    );
  }
  const listaVehiculos = maqRows.map((m) => '- ' + m.CodigoUnidad + ' (' + m.Unidad + ')').join('\n');

  const hoy = new Date();
  const hoyIso =
    hoy.getFullYear() + '-' + String(hoy.getMonth() + 1).padStart(2, '0') + '-' + String(hoy.getDate()).padStart(2, '0');

  const n = fotosDataUrl.length;
  const prompt =
    'Te mando ' + n + ' foto(s) (cada una está marcada arriba como "Foto #N:"). Cada foto puede traer UN SOLO ' +
    'ticket de gasolinera, o VARIOS tickets físicos distintos fotografiados juntos en una sola imagen (por ' +
    'ejemplo, varios tickets de papel acomodados uno junto a otro sobre una mesa o un escritorio, como en un ' +
    'montón o una fila) — revisa cada foto con cuidado buscando TODOS los tickets individuales que aparezcan en ' +
    'ella, no asumas que cada foto trae exactamente uno. Cada ticket individual es UNA carga de gasolina a UN ' +
    'vehículo. Léelos con cuidado y regresa ÚNICAMENTE un arreglo JSON de arreglos (sin texto antes ni después, ' +
    'sin explicación, sin marcar código), con UN RENGLÓN POR CADA TICKET INDIVIDUAL que identifiques en total ' +
    '(sumando los de todas las fotos) — si una foto trae 3 tickets, esa foto aporta 3 renglones; si algún ' +
    'ticket no se puede leer bien, de todos modos regresa su renglón con lo que sí se pudo leer y null en lo ' +
    'demás; nunca omitas un ticket que hayas detectado. Cada renglón es un arreglo de EXACTAMENTE 8 posiciones, ' +
    'en este orden:\n\n' +
    '1. El número de foto (1 a ' + n + ') en la que aparece este ticket, tal cual la etiqueta "Foto #N" de arriba ' +
    '— como número entero.\n' +
    '2. La fecha de compra del ticket (el campo tipo "Fecha Compra"), en formato "AAAA-MM-DD" (el ticket casi ' +
    'siempre trae el año completo impreso, no hay que inferirlo — solo reordénala a AAAA-MM-DD si viene como ' +
    'DD/MM/AAAA). Hoy es ' + hoyIso + ' por si acaso hace falta de referencia. Si de verdad no se puede leer, usa null.\n' +
    '3. Tal cual esté escrita a mano (normalmente una nota agregada después, junto al total) la identificación ' +
    'del vehículo — por ejemplo "AF 530" — sin interpretar. Si no hay ninguna nota a mano legible, usa "".\n' +
    '4. El "codigo_unidad" (la parte ANTES del paréntesis) de la siguiente lista de vehículos conocidos que ' +
    'mejor corresponda a la posición 3 — compara con cuidado, buscando coincidencias parciales o números en ' +
    'común, antes de decidir que no hay ninguno. Solo usa "" si de verdad no hay ningún vehículo de la lista que ' +
    'pueda corresponder, o si la posición 3 quedó vacía.\n' +
    '5. El número del campo "Odómetro" (kilometraje del vehículo), como número, o null si no se puede leer.\n' +
    '6. La cantidad de litros cargados (columna "Cantidad", en el renglón del producto de combustible que ' +
    'aparezca en el ticket — puede ser Magna, Premium O Diesel; usa el renglón que corresponda, no asumas que ' +
    'siempre es Magna/Premium), como número, o null si no se puede leer.\n' +
    '7. El precio por litro (columna tipo "$xLts"), como número, o null si no se puede leer.\n' +
    '8. El total pagado (columna "Pesos" o "Total"), como número, o null si no se puede leer.\n\n' +
    'Ejemplo de un renglón (ticket que salió en la Foto #2): [2,"2026-09-14","AF 530","AF-530-KIA",238728,64.844,23.85,1546.53]\n\n' +
    'Lista de vehículos conocidos (codigo_unidad y nombre) que ya cargan combustible aquí (algunos cargan ' +
    'gasolina y otros diesel, pero eso no cambia cómo se lee el ticket):\n' +
    listaVehiculos +
    '\n\nResponde SOLO con el arreglo JSON de arreglos, un renglón por cada ticket individual detectado, nada más.';

  const textoRespuesta = await preguntarleAClaudeSobreImagenes_(fotosDataUrl, prompt);
  const filas = extraerJson_(textoRespuesta);
  if (!Array.isArray(filas)) throw new Error('La IA no regresó una lista de renglones.');

  const mapaVehiculos = {};
  maqRows.forEach((m) => {
    mapaVehiculos[m.CodigoUnidad] = m.Unidad;
  });

  const FECHA_VALIDA_RE = /^\d{4}-\d{2}-\d{2}$/;
  const numOrNull = (v) => {
    if (v === null || v === undefined || v === '') return null;
    const num = Number(v);
    return Number.isNaN(num) ? null : num;
  };

  const normalizadas = filas.map((f) => {
    const esArreglo = Array.isArray(f);
    const rawFotoIndice = esArreglo ? f[0] : f && (f.fotoIndice != null ? f.fotoIndice : f.foto);
    const rawFecha = esArreglo ? f[1] : f && f.fecha;
    const rawNota = esArreglo ? f[2] : f && f.nota;
    const rawCodigoUnidad = esArreglo ? f[3] : f && f.codigoUnidad;
    const rawLectura = esArreglo ? f[4] : f && f.lectura;
    const rawLitros = esArreglo ? f[5] : f && f.litros;
    const rawPrecioLitro = esArreglo ? f[6] : f && f.precioLitro;
    const rawTotal = esArreglo ? f[7] : f && f.total;

    const fechaLeida = (rawFecha || '').toString().trim();
    const codigoUnidad = (rawCodigoUnidad || '').toString().trim();
    const coincide = Object.prototype.hasOwnProperty.call(mapaVehiculos, codigoUnidad);

    // El número de foto que regresa la IA es 1-based ("Foto #1" es la
    // primera); aquí lo pasamos a índice 0-based dentro de fotosDataUrl
    // para que el frontend pueda mostrar la miniatura correcta. Si la IA no
    // lo mandó o mandó algo fuera de rango, usamos la foto 0 como respaldo
    // en vez de tronar — de todos modos el capturista ve la tabla completa
    // y puede corregir cualquier dato mal leído.
    const fotoNum = Number(rawFotoIndice);
    const fotoIdx = Number.isInteger(fotoNum) && fotoNum >= 1 && fotoNum <= n ? fotoNum - 1 : 0;

    return {
      fotoIdx: fotoIdx,
      fecha: FECHA_VALIDA_RE.test(fechaLeida) ? fechaLeida : '',
      notaVehiculo: (rawNota || '').toString().trim(),
      codigoUnidad: coincide ? codigoUnidad : '',
      unidadLabel: coincide ? mapaVehiculos[codigoUnidad] : '',
      lectura: numOrNull(rawLectura),
      litros: numOrNull(rawLitros),
      precioLitro: numOrNull(rawPrecioLitro),
      total: numOrNull(rawTotal),
    };
  });

  return { success: true, filas: normalizadas };
}

// Staff (Panel): guarda de un jalón varias cargas de gasolina a la vez (las
// que vinieron de revisar/corregir la lectura por IA de varios tickets en
// foto — ver leerTicketsGasolina). Cada renglón se valida y se guarda por
// separado con la misma lógica que crearCargaGasolinaPanel, así que un
// renglón con datos incompletos no impide que se guarden los demás.
async function guardarCargasGasolinaLote(code, nombreUsuario, cargas) {
  await requierePermisoPanel_(code, nombreUsuario, 'combustible_automotriz', 'capturar');
  if (!Array.isArray(cargas) || cargas.length === 0) {
    return { success: false, error: 'No hay renglones para guardar.' };
  }
  const nombre = (nombreUsuario || '').toString().trim();
  if (!nombre) return { success: false, error: 'No se pudo identificar quién captura la carga.' };

  const guardadas = [];
  const errores = [];
  for (let i = 0; i < cargas.length; i++) {
    const data = cargas[i] || {};
    try {
      const codigoUnidad = (data.unidad || '').toString().trim();
      const unidadLabel = (data.unidadLabel || '').toString().trim();
      const litros = Number(data.litros);
      const precioLitro =
        data.precioLitro === '' || data.precioLitro === undefined || data.precioLitro === null ? null : Number(data.precioLitro);
      let total = data.total === '' || data.total === undefined || data.total === null ? null : Number(data.total);
      if ((total === null || Number.isNaN(total)) && precioLitro !== null && !Number.isNaN(precioLitro) && litros) {
        total = Math.round(litros * precioLitro * 100) / 100;
      }
      const lectura =
        data.lectura === '' || data.lectura === undefined || data.lectura === null ? null : Number(data.lectura);
      const fecha = normalizarFechaLocal_(data.fecha);
      const empresa = (data.empresa || '').toString().trim() || null;
      const proveedor = (data.proveedor || '').toString().trim() || null;

      if (!codigoUnidad) throw new Error('Falta seleccionar el vehículo.');
      if (!litros || Number.isNaN(litros) || litros <= 0) throw new Error('Litros inválidos.');
      if (!fecha) throw new Error('Fecha inválida.');

      const tipoCombustible = await obtenerTipoCombustibleAutomotriz_(codigoUnidad);
      const folio = await siguienteFolio_(pool, 'combustible_automotriz', 'GAS', 5);
      const [result] = await pool.query(
        `INSERT INTO combustible_automotriz (folio, codigo_unidad, unidad, litros, precio_litro, total, lectura, tipo_combustible, empresa, proveedor, nombre, fecha)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [folio, codigoUnidad, unidadLabel, litros, precioLitro, total, lectura, tipoCombustible, empresa, proveedor, nombre, fecha]
      );
      await registrarAuditoria_(
        'combustible_automotriz',
        result.insertId,
        'crear',
        nombreUsuario,
        unidadLabel + ' — ' + litros + ' L (ticket foto)'
      );
      guardadas.push({ index: i, id: result.insertId, folio });
    } catch (err) {
      errores.push({ index: i, error: err.message || err.toString() });
    }
  }
  return { success: errores.length === 0, guardadas, errores };
}

// ---------------------------------------------------------------
// Usuarios / acceso
// ---------------------------------------------------------------

// Datos de "huerta" que necesita Reportar (Index.html) para una persona:
// su huerta única de siempre (usuarios.huerta, la misma que usan
// Movimientos/Diesel — no se toca), la lista opcional de varias huertas
// (usuarios.huertas_reportar, ver db/schema.sql) y si ve las casillas
// opcionales de Soldadura/Automotriz. Se comparte entre getHuertaPorUsuario
// (recarga de página, sesión ya guardada en localStorage) y validarUsuario
// (login recién hecho), para no repetir el mismo JSON.parse en los dos
// lados.
// Convierte un valor opcional de formulario (puede venir vacío, undefined
// o no numérico) a número o null — usado por los campos de odómetro de
// Movimientos (ver odometro_salida/odometro_llegada en db/schema.sql).
function numeroOpcional_(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isNaN(n) ? null : n;
}

// Arreglo de huertas (ver huertas_adicionales en db/schema.sql) tal cual
// viene guardado, limpio de vacíos/espacios.
function parseHuertasJson_(crudo) {
  try {
    const lista = crudo ? JSON.parse(crudo) : [];
    return Array.isArray(lista) ? lista.map((h) => (h || '').toString().trim()).filter(Boolean) : [];
  } catch (err) {
    return [];
  }
}

// Todas las huertas en las que esta persona "está asignada" de verdad: su
// huerta única de siempre (usuarios.huerta) más, opcionalmente, las
// adicionales que le haya dado el admin (usuarios.huertas_adicionales, ver
// db/schema.sql) — sin duplicados, con la huerta única primero. Si no tiene
// huerta única pero sí adicionales (caso raro), igual se usan esas. Esta es
// la lista que de verdad importa para: qué equipo ve en Reportar/Diesel
// (recomputarUnidadesFiltradas en el cliente), de qué huertas ve "llegadas
// pendientes" y desde cuál de ellas puede registrar una salida en
// Movimientos (ver getMovimientosDeUsuario/confirmarLlegadaMovimiento/
// submitMovimientoSalida más abajo).
function huertasEfectivasDeFila_(usuario) {
  const huertaUnica = (usuario && usuario.huerta) ? usuario.huerta.toString().trim() : '';
  const adicionales = parseHuertasJson_(usuario && usuario.huertas_adicionales);
  const todas = huertaUnica ? [huertaUnica, ...adicionales] : adicionales;
  const vistas = new Set();
  return todas.filter((h) => {
    const key = h.toUpperCase();
    if (vistas.has(key)) return false;
    vistas.add(key);
    return true;
  });
}

// Equipo (maquinaria) asignado específicamente a esta persona por su
// nombre de usuario de la app (ver maquinaria.usuario_asignado_app en
// db/schema.sql) — separado del catálogo libre de Operadores. Vacío =
// esta persona no tiene nada asignado -> en Index.html se sigue viendo
// todo el equipo, igual que siempre.
async function equiposAsignadosUsuario_(nombre) {
  if (!nombre) return [];
  const [rows] = await pool.query(
    'SELECT codigo_unidad FROM maquinaria WHERE usuario_asignado_app IS NOT NULL AND LOWER(TRIM(usuario_asignado_app)) = LOWER(TRIM(?))',
    [nombre]
  );
  return rows.map((r) => r.codigo_unidad);
}

async function datosReportarUsuario_(usuario) {
  return {
    huerta: usuario.huerta || '',
    huertas: huertasEfectivasDeFila_(usuario),
    huertasReportar: parseHuertasJson_(usuario.huertas_reportar),
    veCasillaSoldadura: !!usuario.ve_casilla_soldadura,
    veCasillaAutomotriz: !!usuario.ve_casilla_automotriz,
    // Pestañas del celular (Index.html) que esta persona NO debe ver —
    // ver pestanas_celular_ocultas en db/schema.sql. Vacío/ausente = las
    // ve todas, igual que siempre.
    pestanasCelularOcultas: parseHuertasJson_(usuario.pestanas_celular_ocultas),
    // Equipo asignado a esta persona (ver equiposAsignadosUsuario_ arriba)
    // — en Index.html restringe, en TODA la app, qué unidades puede
    // elegir (Reportar, Diesel, Movimientos, Avance Huerta). Vacío = ve
    // todo el equipo, igual que siempre.
    equiposAsignados: await equiposAsignadosUsuario_(usuario.nombre),
  };
}

async function getHuertaPorUsuario(nombre) {
  if (!nombre) return datosReportarUsuario_({});
  const [rows] = await pool.query(
    'SELECT nombre, huerta, huertas_adicionales, huertas_reportar, ve_casilla_soldadura, ve_casilla_automotriz, pestanas_celular_ocultas FROM usuarios WHERE LOWER(TRIM(nombre)) = LOWER(TRIM(?))',
    [nombre]
  );
  return datosReportarUsuario_(rows.length ? rows[0] : {});
}

async function getNombresUsuarios(modulo) {
  const [rows] = await pool.query('SELECT nombre, modulos FROM usuarios');
  return rows.filter((r) => r.nombre && tieneAccesoModulo_(r.modulos, modulo)).map((r) => r.nombre);
}

async function validarUsuario(nombre, password, modulo) {
  if (!nombre || !password) {
    return { success: false, error: 'Selecciona tu nombre y escribe tu contraseña.' };
  }
  const [rows] = await pool.query('SELECT * FROM usuarios WHERE LOWER(TRIM(nombre)) = LOWER(TRIM(?))', [nombre]);
  if (rows.length === 0) return { success: false, error: 'Usuario no encontrado.' };
  const usuario = rows[0];
  if (!usuario.password_hash) {
    return { success: false, error: 'Este usuario no tiene contraseña asignada. Pide al taller que te la configure en el Panel.' };
  }
  const ok = await bcrypt.compare(String(password), usuario.password_hash);
  if (!ok) return { success: false, error: 'Contraseña incorrecta.' };
  if (modulo && !tieneAccesoModulo_(usuario.modulos, modulo)) {
    return { success: false, error: 'Tu usuario no tiene acceso a este módulo.' };
  }
  const resultado = { success: true, ...(await datosReportarUsuario_(usuario)) };
  // Para el Panel, además del ok/error del login, ya regresamos de una vez
  // los permisos por pestaña de esta persona — así el frontend sabe qué
  // pestañas mostrarle y en cuáles solo puede ver (sin tener que pedirlos
  // aparte justo después de entrar).
  if (modulo === 'Panel') {
    try {
      resultado.panelPermisos = usuario.panel_permisos ? JSON.parse(usuario.panel_permisos) : {};
    } catch (err) {
      resultado.panelPermisos = {};
    }
    // Huertas a las que esta persona queda restringida en el Panel —
    // Órdenes, Combustible Agrícola y Preventivos Agrícolas (ver
    // obtenerHuertasRestringidasUsuario_) — se manda aquí solo para que el
    // Panel pueda, de forma cosmética, limitar de una vez el desplegable de
    // filtro por huerta a lo que de verdad le toca ver; el servidor vuelve
    // a validar esto en cada llamada, sin confiar en nada que mande el
    // cliente.
    try {
      const lista = usuario.huertas_ordenes ? JSON.parse(usuario.huertas_ordenes) : [];
      resultado.huertasOrdenes = Array.isArray(lista) ? lista : [];
    } catch (err) {
      resultado.huertasOrdenes = [];
    }
    // Si esta persona puede ver el letrero de Órdenes "sin fecha de
    // atención" (independiente de si puede ver la pestaña Órdenes en sí —
    // ver usuarios.ver_letrero_ord_pend, configurable desde Usuarios).
    // DEFAULT 1 en la columna: alguien sin este dato (cuenta vieja) lo sigue
    // viendo igual que siempre, hasta que alguien lo desmarque a propósito.
    resultado.veLetreroOrdPend = usuario.ver_letrero_ord_pend === undefined || usuario.ver_letrero_ord_pend === null
      ? true
      : !!usuario.ver_letrero_ord_pend;
    // Qué cuadros de la pestaña Diesel del Panel NO debe ver esta persona
    // (ver DZ_CUADROS en Panel.html) — permiso asignado desde Usuarios,
    // igual que huertasOrdenes. Vacío/ausente = los ve todos.
    try {
      const lista = usuario.diesel_cuadros_ocultos ? JSON.parse(usuario.diesel_cuadros_ocultos) : [];
      resultado.dieselCuadrosOcultos = Array.isArray(lista) ? lista : [];
    } catch (err) {
      resultado.dieselCuadrosOcultos = [];
    }
  }
  return resultado;
}

// Valida y limpia el objeto de permisos del Panel que manda el frontend
// (ver PESTANAS_PANEL arriba) antes de guardarlo — solo deja pasar
// pestañas conocidas y valores 'visualizar'/'capturar' (cualquier otra
// cosa, incluido null/vacío, se descarta y esa pestaña queda sin acceso).
function limpiarPanelPermisos_(panelPermisos) {
  const limpio = {};
  if (panelPermisos && typeof panelPermisos === 'object') {
    PESTANAS_PANEL.forEach((pestana) => {
      const nivel = panelPermisos[pestana];
      if (nivel === 'visualizar' || nivel === 'capturar') limpio[pestana] = nivel;
    });
  }
  return limpio;
}

async function getUsuarios(code, nombreUsuario) {
  await requierePermisoPanel_(code, nombreUsuario, 'usuarios', 'visualizar');
  const [rows] = await pool.query('SELECT nombre, huerta, huertas_adicionales, password_hash, modulos, panel_permisos, huertas_ordenes, ver_letrero_ord_pend, huertas_reportar, ve_casilla_soldadura, ve_casilla_automotriz, diesel_cuadros_ocultos, pestanas_celular_ocultas FROM usuarios ORDER BY nombre');
  return rows
    .filter((r) => r.nombre)
    .map((r) => ({
      Nombre: r.nombre,
      Huerta: r.huerta || '',
      HuertasAdicionales: parseHuertasJson_(r.huertas_adicionales),
      TieneClave: !!(r.password_hash && r.password_hash.trim()),
      Modulos: (r.modulos || '').split(',').map((m) => m.trim()).filter(Boolean),
      PanelPermisos: (() => {
        try { return r.panel_permisos ? JSON.parse(r.panel_permisos) : {}; } catch (err) { return {}; }
      })(),
      HuertasOrdenes: (() => {
        try {
          const lista = r.huertas_ordenes ? JSON.parse(r.huertas_ordenes) : [];
          return Array.isArray(lista) ? lista : [];
        } catch (err) { return []; }
      })(),
      VeLetreroOrdPend: r.ver_letrero_ord_pend === undefined || r.ver_letrero_ord_pend === null ? true : !!r.ver_letrero_ord_pend,
      HuertasReportar: (() => {
        try {
          const lista = r.huertas_reportar ? JSON.parse(r.huertas_reportar) : [];
          return Array.isArray(lista) ? lista : [];
        } catch (err) { return []; }
      })(),
      VeCasillaSoldadura: !!r.ve_casilla_soldadura,
      VeCasillaAutomotriz: !!r.ve_casilla_automotriz,
      DieselCuadrosOcultos: (() => {
        try {
          const lista = r.diesel_cuadros_ocultos ? JSON.parse(r.diesel_cuadros_ocultos) : [];
          return Array.isArray(lista) ? lista : [];
        } catch (err) { return []; }
      })(),
      PestanasCelularOcultas: parseHuertasJson_(r.pestanas_celular_ocultas),
    }));
}

// `huertasOrdenes` (opcional): arreglo de nombres de huerta que restringe
// qué puede ver/editar/crear esta persona en Órdenes, Combustible Agrícola
// y Preventivos Agrícolas del Panel (ver obtenerHuertasRestringidasUsuario_).
// Un arreglo vacío o ausente
// guarda NULL — sin restricción, ve todas las huertas, igual que siempre.
// `veLetreroOrdPend` (opcional, default true): si esta persona ve el
// letrero de Órdenes "sin fecha de atención" — independiente de si puede
// ver la pestaña Órdenes. Solo se guarda false cuando el formulario manda
// explícitamente false (checkbox desmarcado); cualquier otro valor
// (undefined, true) guarda "sí lo ve", para no sorprender con un cambio
// de comportamiento a quien no toque esta casilla.
// `huertasReportar` (opcional): arreglo de varias huertas para el
// formulario Reportar (ver datosReportarUsuario_ arriba). Vacío/ausente
// guarda NULL — sigue usando la huerta única de `huerta`, igual que
// siempre. `veCasillaSoldadura`/`veCasillaAutomotriz` (opcional, default
// false): si esta persona ve esas casillas en Reportar — a propósito
// default false, hay que activarlas por persona.
// `dieselCuadrosOcultos` (opcional): arreglo de ids de cuadro (ver
// DZ_CUADROS en Panel.html) que esta persona NO debe ver en la pestaña
// Diesel del Panel. Vacío/ausente guarda NULL — los ve todos, igual que
// siempre.
// `huertasAdicionales` (opcional): arreglo de huertas EXTRA a la huerta
// única de `huerta` (ver huertas_adicionales en db/schema.sql y
// huertasEfectivasDeFila_ arriba). Vacío/ausente guarda NULL — sigue
// teniendo una sola huerta, igual que siempre. Si tiene 2+ huertas en
// total (la única + estas), cambia qué equipo ve en Reportar/Diesel, de
// qué huertas ve llegadas pendientes en Movimientos y desde cuál puede
// registrar una salida.
// `pestanasCelularOcultas` (opcional): arreglo de ids de pestaña del
// celular (ver PESTANAS_CELULAR en Panel.html / pestanas_celular_ocultas
// en db/schema.sql) que esta persona NO debe ver en Index.html.
// Vacío/ausente guarda NULL — las ve todas, igual que siempre.
async function guardarUsuario(code, nombreUsuario, nombre, huerta, password, modulos, panelPermisos, huertasOrdenes, veLetreroOrdPend, huertasReportar, veCasillaSoldadura, veCasillaAutomotriz, dieselCuadrosOcultos, huertasAdicionales, pestanasCelularOcultas) {
  await requierePermisoPanel_(code, nombreUsuario, 'usuarios', 'capturar');
  if (!nombre) return { success: false, error: 'Falta el nombre.' };
  const modulosStr = Array.isArray(modulos) ? modulos.join(',') : (modulos || '').toString();
  const panelPermisosStr = JSON.stringify(limpiarPanelPermisos_(panelPermisos));
  const huertasOrdenesLimpio = Array.isArray(huertasOrdenes)
    ? huertasOrdenes.map((h) => (h || '').toString().trim()).filter(Boolean)
    : [];
  const huertasOrdenesStr = huertasOrdenesLimpio.length > 0 ? JSON.stringify(huertasOrdenesLimpio) : null;
  const veLetreroOrdPendInt = veLetreroOrdPend === false ? 0 : 1;
  const huertasReportarLimpio = Array.isArray(huertasReportar)
    ? huertasReportar.map((h) => (h || '').toString().trim()).filter(Boolean)
    : [];
  const huertasReportarStr = huertasReportarLimpio.length > 0 ? JSON.stringify(huertasReportarLimpio) : null;
  const veCasillaSoldaduraInt = veCasillaSoldadura === true ? 1 : 0;
  const veCasillaAutomotrizInt = veCasillaAutomotriz === true ? 1 : 0;
  const dieselCuadrosOcultosLimpio = Array.isArray(dieselCuadrosOcultos)
    ? dieselCuadrosOcultos.map((c) => (c || '').toString().trim()).filter(Boolean)
    : [];
  const dieselCuadrosOcultosStr = dieselCuadrosOcultosLimpio.length > 0 ? JSON.stringify(dieselCuadrosOcultosLimpio) : null;
  const huertasAdicionalesLimpio = Array.isArray(huertasAdicionales)
    ? huertasAdicionales.map((h) => (h || '').toString().trim()).filter(Boolean)
    : [];
  const huertasAdicionalesStr = huertasAdicionalesLimpio.length > 0 ? JSON.stringify(huertasAdicionalesLimpio) : null;
  const pestanasCelularOcultasLimpio = Array.isArray(pestanasCelularOcultas)
    ? pestanasCelularOcultas.map((p) => (p || '').toString().trim()).filter(Boolean)
    : [];
  const pestanasCelularOcultasStr = pestanasCelularOcultasLimpio.length > 0 ? JSON.stringify(pestanasCelularOcultasLimpio) : null;
  try {
    const [existe] = await pool.query('SELECT id, password_hash FROM usuarios WHERE LOWER(TRIM(nombre)) = LOWER(TRIM(?))', [nombre]);
    if (existe.length === 0) {
      if (!password) return { success: false, error: 'Asigna una contraseña al crear un usuario nuevo.' };
      const hash = await bcrypt.hash(String(password), 10);
      await pool.query(
        'INSERT INTO usuarios (nombre, huerta, password_hash, modulos, panel_permisos, huertas_ordenes, ver_letrero_ord_pend, huertas_reportar, ve_casilla_soldadura, ve_casilla_automotriz, diesel_cuadros_ocultos, huertas_adicionales, pestanas_celular_ocultas) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [nombre, huerta || '', hash, modulosStr, panelPermisosStr, huertasOrdenesStr, veLetreroOrdPendInt, huertasReportarStr, veCasillaSoldaduraInt, veCasillaAutomotrizInt, dieselCuadrosOcultosStr, huertasAdicionalesStr, pestanasCelularOcultasStr]
      );
    } else {
      if (password) {
        const hash = await bcrypt.hash(String(password), 10);
        await pool.query(
          'UPDATE usuarios SET huerta = ?, password_hash = ?, modulos = ?, panel_permisos = ?, huertas_ordenes = ?, ver_letrero_ord_pend = ?, huertas_reportar = ?, ve_casilla_soldadura = ?, ve_casilla_automotriz = ?, diesel_cuadros_ocultos = ?, huertas_adicionales = ?, pestanas_celular_ocultas = ? WHERE id = ?',
          [huerta || '', hash, modulosStr, panelPermisosStr, huertasOrdenesStr, veLetreroOrdPendInt, huertasReportarStr, veCasillaSoldaduraInt, veCasillaAutomotrizInt, dieselCuadrosOcultosStr, huertasAdicionalesStr, pestanasCelularOcultasStr, existe[0].id]
        );
      } else {
        await pool.query(
          'UPDATE usuarios SET huerta = ?, modulos = ?, panel_permisos = ?, huertas_ordenes = ?, ver_letrero_ord_pend = ?, huertas_reportar = ?, ve_casilla_soldadura = ?, ve_casilla_automotriz = ?, diesel_cuadros_ocultos = ?, huertas_adicionales = ?, pestanas_celular_ocultas = ? WHERE id = ?',
          [huerta || '', modulosStr, panelPermisosStr, huertasOrdenesStr, veLetreroOrdPendInt, huertasReportarStr, veCasillaSoldaduraInt, veCasillaAutomotrizInt, dieselCuadrosOcultosStr, huertasAdicionalesStr, pestanasCelularOcultasStr, existe[0].id]
        );
      }
    }
    return { success: true };
  } catch (err) {
    return { success: false, error: err.toString() };
  }
}

async function eliminarUsuario(code, nombreUsuario, nombre) {
  await requierePermisoPanel_(code, nombreUsuario, 'usuarios', 'capturar');
  try {
    await pool.query('DELETE FROM usuarios WHERE LOWER(TRIM(nombre)) = LOWER(TRIM(?))', [nombre]);
    return { success: true };
  } catch (err) {
    return { success: false, error: err.toString() };
  }
}

// ---------------------------------------------------------------
// Movimientos de maquinaria entre huertas
// ---------------------------------------------------------------

// Última huerta_destino CONFIRMADA por unidad = "dónde está ahora" ese
// equipo. Las unidades sin ningún movimiento confirmado no aparecen aquí
// (se consideran "sin ubicar" y el frontend las deja visibles para todos).
async function getUbicacionesUnidades() {
  const [rows] = await pool.query(`
    SELECT m.codigo_unidad AS CodigoUnidad, m.huerta_destino AS Huerta
    FROM movimientos_maquinaria m
    INNER JOIN (
      SELECT codigo_unidad, MAX(id) AS max_id
      FROM movimientos_maquinaria
      WHERE estado = 'confirmado'
      GROUP BY codigo_unidad
    ) ult ON ult.codigo_unidad = m.codigo_unidad AND ult.max_id = m.id
  `);
  return rows;
}

async function submitMovimientoSalida(data) {
  data = data || {};
  try {
    const nombre = (data.nombre || '').toString().trim();
    if (!nombre) return { success: false, error: 'Falta el usuario que reporta la salida.' };
    if (!data.unidad || !data.huertaDestino) {
      return { success: false, error: 'Selecciona la unidad y la huerta de destino.' };
    }

    const [urows] = await pool.query('SELECT huerta, huertas_adicionales FROM usuarios WHERE LOWER(TRIM(nombre)) = LOWER(TRIM(?))', [nombre]);
    const huertasUsuario = huertasEfectivasDeFila_(urows[0] || {});
    if (!huertasUsuario.length) return { success: false, error: 'Tu usuario no tiene una huerta asignada. Pídele al Panel que te la configure.' };

    let huertaOrigen = '';
    if (huertasUsuario.length > 1) {
      // Con 2+ huertas asignadas, debe elegir explícitamente desde cuál sale.
      const origenPedido = (data.huertaOrigen || '').toString().trim();
      if (!origenPedido) return { success: false, error: 'Selecciona la huerta de origen.' };
      huertaOrigen = huertasUsuario.find((h) => h.toLowerCase() === origenPedido.toLowerCase()) || '';
      if (!huertaOrigen) return { success: false, error: 'La huerta de origen elegida no es una de tus huertas asignadas.' };
    } else {
      huertaOrigen = huertasUsuario[0];
    }
    if (huertaOrigen.trim().toLowerCase() === data.huertaDestino.trim().toLowerCase()) {
      return { success: false, error: 'La huerta de destino debe ser diferente a tu huerta de origen.' };
    }

    // Si el equipo ya tiene una ubicación registrada por un movimiento
    // confirmado anterior, debe coincidir con la huerta de quien reporta.
    const [ubic] = await pool.query(
      `SELECT m.huerta_destino AS huerta
       FROM movimientos_maquinaria m
       INNER JOIN (
         SELECT codigo_unidad, MAX(id) AS max_id FROM movimientos_maquinaria
         WHERE estado = 'confirmado' AND codigo_unidad = ? GROUP BY codigo_unidad
       ) ult ON ult.codigo_unidad = m.codigo_unidad AND ult.max_id = m.id`,
      [data.unidad]
    );
    if (ubic.length && ubic[0].huerta && ubic[0].huerta.trim().toLowerCase() !== huertaOrigen.trim().toLowerCase()) {
      return { success: false, error: 'Según el sistema, ese equipo no está actualmente en tu huerta (está en ' + ubic[0].huerta + ').' };
    }

    // No permitir un segundo movimiento pendiente simultáneo para la misma unidad.
    const [pend] = await pool.query("SELECT id FROM movimientos_maquinaria WHERE codigo_unidad = ? AND estado = 'pendiente'", [data.unidad]);
    if (pend.length) return { success: false, error: 'Este equipo ya tiene un movimiento pendiente de confirmación.' };

    let fotoSalidaUrl = '';
    if (data.foto) fotoSalidaUrl = await guardarArchivo_(data.foto);

    // Odómetro al salir (opcional — no todo equipo tiene, ver
    // db/schema.sql junto a odometro_salida/odometro_llegada).
    const odometroSalidaValido = numeroOpcional_(data.odometroSalida);

    const folio = await siguienteFolio_(pool, 'movimiento', 'MOV', 5);
    await pool.query(
      `INSERT INTO movimientos_maquinaria
        (folio, codigo_unidad, unidad, huerta_origen, huerta_destino, usuario_salida, fecha_salida, comentario_salida, odometro_salida, estado, foto_salida_url)
       VALUES (?, ?, ?, ?, ?, ?, NOW(), ?, ?, 'pendiente', ?)`,
      [folio, data.unidad, data.unidadLabel || '', huertaOrigen, data.huertaDestino, nombre, data.comentario || null, odometroSalidaValido, fotoSalidaUrl || null]
    );
    return { success: true, folio, fotoUrl: fotoSalidaUrl };
  } catch (err) {
    return { success: false, error: err.toString() };
  }
}

// Para la pantalla del módulo Movimientos: lo que le falta confirmar a la
// huerta del usuario (llegadas pendientes) y sus propias salidas recientes.
async function getMovimientosDeUsuario(nombre) {
  if (!nombre) return { huerta: '', huertas: [], pendientesLlegada: [], misSalidas: [] };
  const [urows] = await pool.query('SELECT huerta, huertas_adicionales FROM usuarios WHERE LOWER(TRIM(nombre)) = LOWER(TRIM(?))', [nombre]);
  const huerta = (urows[0] && urows[0].huerta) || '';
  const huertas = huertasEfectivasDeFila_(urows[0] || {});
  let pendientes = [];
  if (huertas.length) {
    const huertasLower = huertas.map((h) => h.toLowerCase());
    const placeholders = huertasLower.map(() => '?').join(',');
    [pendientes] = await pool.query(
      MOVIMIENTO_SELECT + ` WHERE estado = 'pendiente' AND LOWER(TRIM(huerta_destino)) IN (${placeholders}) ORDER BY id DESC`,
      huertasLower
    );
  }
  const [misSalidas] = await pool.query(
    MOVIMIENTO_SELECT + ' WHERE LOWER(TRIM(usuario_salida)) = LOWER(TRIM(?)) ORDER BY id DESC LIMIT 20',
    [nombre]
  );
  return { huerta, huertas, pendientesLlegada: normalizaFilas(pendientes), misSalidas: normalizaFilas(misSalidas) };
}

async function confirmarLlegadaMovimiento(folio, nombre, comentario, foto, odometroLlegada) {
  try {
    if (!folio || !nombre) return { success: false, error: 'Faltan datos para confirmar la llegada.' };
    const [rows] = await pool.query('SELECT * FROM movimientos_maquinaria WHERE folio = ?', [folio]);
    if (!rows.length) return { success: false, error: 'No se encontró ese movimiento.' };
    const mov = rows[0];
    if (mov.estado === 'confirmado') return { success: false, error: 'Este movimiento ya había sido confirmado.' };

    const [urows] = await pool.query('SELECT huerta, huertas_adicionales FROM usuarios WHERE LOWER(TRIM(nombre)) = LOWER(TRIM(?))', [nombre]);
    const huertasUsuario = huertasEfectivasDeFila_(urows[0] || {}).map((h) => h.toLowerCase());
    if (!huertasUsuario.includes((mov.huerta_destino || '').trim().toLowerCase())) {
      return { success: false, error: 'Solo alguien de ' + mov.huerta_destino + ' puede confirmar esta llegada.' };
    }

    let fotoLlegadaUrl = '';
    if (foto) fotoLlegadaUrl = await guardarArchivo_(foto);

    // Odómetro al llegar (opcional, igual que al salir).
    const odometroLlegadaValido = numeroOpcional_(odometroLlegada);

    await pool.query(
      "UPDATE movimientos_maquinaria SET estado = 'confirmado', usuario_llegada = ?, fecha_llegada = NOW(), comentario_llegada = ?, foto_llegada_url = ?, odometro_llegada = ? WHERE folio = ?",
      [nombre, comentario || null, fotoLlegadaUrl || null, odometroLlegadaValido, folio]
    );

    await sincronizarUbicacionOrdenesAbiertas_(mov.codigo_unidad, mov.huerta_destino, 'el movimiento ' + folio, nombre);

    return { success: true };
  } catch (err) {
    return { success: false, error: err.toString() };
  }
}

// Historial completo, para la pestaña "Movimientos" del Panel.
async function getMovimientosHistorial(code, nombreUsuario) {
  await requierePermisoPanel_(code, nombreUsuario, 'movimientos', 'visualizar');
  const [rows] = await pool.query(MOVIMIENTO_SELECT + ' ORDER BY id DESC');
  return normalizaFilas(rows);
}

// Staff: captura un movimiento de maquinaria manualmente desde el Panel
// (pestaña Movimientos), para dejar registrado algo que ya pasó o que no
// se alcanzó a reportar desde el módulo Movimientos.html. A diferencia de
// submitMovimientoSalida (self-service, usado por esa app desde el
// celular) aquí el capturista del Panel elige la huerta de origen y
// destino libremente — no se valida que coincida con la huerta de quien
// reporta, porque quien captura en el Panel no necesariamente es quien
// está físicamente ahí. Igual que submitMovimientoSalida, no se permite un
// segundo movimiento pendiente simultáneo para la misma unidad. Se puede
// capturar directamente como "confirmado" (si ya se sabe que llegó) dando
// también usuario/fecha de llegada — mismo criterio que editarMovimiento.
async function crearMovimientoPanel(code, nombreUsuario, data) {
  await requierePermisoPanel_(code, nombreUsuario, 'movimientos', 'capturar');
  data = data || {};
  try {
    const codigoUnidad = (data.unidad || '').toString().trim();
    const unidadLabel = (data.unidadLabel || '').toString().trim();
    const huertaOrigen = (data.huertaOrigen || '').toString().trim();
    const huertaDestino = (data.huertaDestino || '').toString().trim();
    const usuarioSalida = (data.usuarioSalida || '').toString().trim();
    const fechaSalida = normalizarFechaLocal_(data.fechaSalida);
    const comentarioSalida = (data.comentarioSalida || '').toString().trim() || null;
    const odometroSalida = numeroOpcional_(data.odometroSalida);
    const usuarioLlegada = (data.usuarioLlegada || '').toString().trim() || null;
    const fechaLlegada = normalizarFechaLocal_(data.fechaLlegada);
    const comentarioLlegada = (data.comentarioLlegada || '').toString().trim() || null;
    const odometroLlegada = numeroOpcional_(data.odometroLlegada);
    const estado = (data.estado || 'pendiente').toString().trim();

    if (!codigoUnidad) return { success: false, error: 'Selecciona la unidad.' };
    if (!huertaOrigen || !huertaDestino) return { success: false, error: 'Selecciona la huerta de origen y destino.' };
    if (!usuarioSalida) return { success: false, error: 'Escribe el usuario de salida.' };
    if (!fechaSalida) return { success: false, error: 'Selecciona la fecha de salida.' };
    if (estado !== 'pendiente' && estado !== 'confirmado') return { success: false, error: 'Estado inválido.' };
    if (estado === 'confirmado' && (!usuarioLlegada || !fechaLlegada)) {
      return { success: false, error: 'Para capturarlo ya confirmado, escribe también el usuario y la fecha de llegada.' };
    }

    const [maquinas] = await pool.query('SELECT unidad FROM maquinaria WHERE codigo_unidad = ?', [codigoUnidad]);
    if (!maquinas.length) return { success: false, error: 'No se encontró esa unidad en el catálogo.' };
    const unidadFinal = unidadLabel || maquinas[0].unidad;

    const [pend] = await pool.query("SELECT id FROM movimientos_maquinaria WHERE codigo_unidad = ? AND estado = 'pendiente'", [codigoUnidad]);
    if (pend.length) return { success: false, error: 'Ese equipo ya tiene un movimiento pendiente de confirmación.' };

    const folio = await siguienteFolio_(pool, 'movimiento', 'MOV', 5);
    const [result] = await pool.query(
      `INSERT INTO movimientos_maquinaria
        (folio, codigo_unidad, unidad, huerta_origen, huerta_destino, usuario_salida, fecha_salida, comentario_salida, odometro_salida,
         usuario_llegada, fecha_llegada, comentario_llegada, odometro_llegada, estado)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [folio, codigoUnidad, unidadFinal, huertaOrigen, huertaDestino, usuarioSalida, fechaSalida, comentarioSalida, odometroSalida,
        usuarioLlegada, fechaLlegada, comentarioLlegada, odometroLlegada, estado]
    );

    if (estado === 'confirmado') {
      await sincronizarUbicacionOrdenesAbiertas_(codigoUnidad, huertaDestino, 'un movimiento capturado manualmente', nombreUsuario);
    }

    await registrarAuditoria_('movimientos_maquinaria', result.insertId, 'crear', nombreUsuario, unidadFinal + ' — ' + huertaOrigen + ' → ' + huertaDestino);

    return { success: true, id: result.insertId, folio };
  } catch (err) {
    return { success: false, error: err.toString() };
  }
}

// Staff: corrige un movimiento de maquinaria ya registrado, desde el
// Panel. Deja constancia de quién y cuándo lo modificó
// (modificado_por/modificado_en) — nombreUsuario es el usuario que inició
// sesión en el Panel (ver validarUsuario), no usuario_salida/usuario_llegada.
async function editarMovimiento(code, nombreUsuario, id, data) {
  await requierePermisoPanel_(code, nombreUsuario, 'movimientos', 'capturar');
  data = data || {};
  try {
    const idNum = Number(id);
    if (!idNum) return { success: false, error: 'Falta el identificador del movimiento.' };
    const [rows] = await pool.query('SELECT id, codigo_unidad, unidad FROM movimientos_maquinaria WHERE id = ?', [idNum]);
    if (rows.length === 0) return { success: false, error: 'No se encontró ese movimiento.' };

    const huertaOrigen = (data.huertaOrigen || '').toString().trim();
    const huertaDestino = (data.huertaDestino || '').toString().trim();
    const usuarioSalida = (data.usuarioSalida || '').toString().trim();
    const fechaSalida = normalizarFechaLocal_(data.fechaSalida);
    const comentarioSalida = (data.comentarioSalida || '').toString().trim() || null;
    const odometroSalida = numeroOpcional_(data.odometroSalida);
    const usuarioLlegada = (data.usuarioLlegada || '').toString().trim() || null;
    const fechaLlegada = normalizarFechaLocal_(data.fechaLlegada);
    const comentarioLlegada = (data.comentarioLlegada || '').toString().trim() || null;
    const odometroLlegada = numeroOpcional_(data.odometroLlegada);
    const estado = (data.estado || '').toString().trim();

    if (!huertaOrigen || !huertaDestino) return { success: false, error: 'Selecciona la huerta de origen y destino.' };
    if (!usuarioSalida) return { success: false, error: 'Escribe el usuario de salida.' };
    if (!fechaSalida) return { success: false, error: 'Selecciona la fecha de salida.' };
    if (estado !== 'pendiente' && estado !== 'confirmado') return { success: false, error: 'Estado inválido.' };
    if (estado === 'confirmado' && (!usuarioLlegada || !fechaLlegada)) {
      return { success: false, error: 'Para marcarlo como confirmado, captura el usuario y la fecha de llegada.' };
    }

    const modificadoPor = (nombreUsuario || '').toString().trim() || null;

    await pool.query(
      `UPDATE movimientos_maquinaria SET huerta_origen = ?, huerta_destino = ?, usuario_salida = ?, fecha_salida = ?,
        comentario_salida = ?, odometro_salida = ?, usuario_llegada = ?, fecha_llegada = ?, comentario_llegada = ?, odometro_llegada = ?, estado = ?,
        modificado_por = ?, modificado_en = NOW()
       WHERE id = ?`,
      [huertaOrigen, huertaDestino, usuarioSalida, fechaSalida, comentarioSalida, odometroSalida, usuarioLlegada, fechaLlegada, comentarioLlegada, odometroLlegada, estado, modificadoPor, idNum]
    );

    if (estado === 'confirmado') {
      await sincronizarUbicacionOrdenesAbiertas_(rows[0].codigo_unidad, huertaDestino, 'una corrección al movimiento', modificadoPor);
    }

    await registrarAuditoria_('movimientos_maquinaria', idNum, 'editar', nombreUsuario, (rows[0].unidad || '') + ' — ' + huertaOrigen + ' → ' + huertaDestino);

    return { success: true };
  } catch (err) {
    return { success: false, error: err.toString() };
  }
}

// Staff: borra un movimiento de maquinaria por completo (desde el Panel).
async function eliminarMovimiento(code, nombreUsuario, id) {
  await requierePermisoPanel_(code, nombreUsuario, 'movimientos', 'capturar');
  try {
    const idNum = Number(id);
    if (!idNum) return { success: false, error: 'Falta el identificador del movimiento.' };
    const [rows] = await pool.query('SELECT id, unidad, huerta_origen, huerta_destino FROM movimientos_maquinaria WHERE id = ?', [idNum]);
    if (rows.length === 0) return { success: false, error: 'No se encontró ese movimiento.' };
    await pool.query('DELETE FROM movimientos_maquinaria WHERE id = ?', [idNum]);
    await registrarAuditoria_('movimientos_maquinaria', idNum, 'eliminar', nombreUsuario, (rows[0].unidad || '') + ' — ' + rows[0].huerta_origen + ' → ' + rows[0].huerta_destino);
    return { success: true };
  } catch (err) {
    return { success: false, error: err.toString() };
  }
}

// ---------------------------------------------------------------
// Catálogo de maquinaria: departamento (CAMPO/COSECHA/PREPARACION),
// ficha técnica y estatus automático (según si hay una orden abierta
// en Taller para esa unidad).
// ---------------------------------------------------------------

const MAQUINARIA_SELECT = `
  SELECT
    m.codigo_unidad   AS CodigoUnidad,
    m.unidad          AS Unidad,
    m.departamento    AS Departamento,
    m.marca           AS MarcaTexto,
    m.marca_id        AS MarcaId,
    mca.nombre        AS MarcaNombre,
    m.modelo          AS ModeloTexto,
    m.modelo_id       AS ModeloId,
    mdo.nombre        AS ModeloNombre,
    m.anio            AS Anio,
    m.color           AS Color,
    m.serie           AS Serie,
    m.placa           AS Placa,
    m.tipo_unidad     AS TipoUnidad,
    m.observaciones   AS Observaciones,
    m.usa_diesel      AS UsaDiesel,
    m.usa_gasolina    AS UsaGasolina,
    m.combustible_automotriz_tipo AS CombustibleAutomotrizTipo,
    m.operador_asignado AS OperadorAsignado,
    m.usuario_asignado_app AS UsuarioAsignadoApp,
    m.admite_terceros AS AdmiteTerceros
  FROM maquinaria m
  LEFT JOIN marcas_refacciones mca ON mca.id = m.marca_id
  LEFT JOIN modelos_refacciones mdo ON mdo.id = m.modelo_id
`;

function esImplemento_(unidad) {
  return (unidad || '').trim().toUpperCase().startsWith('IA');
}

async function getUbicacionesActuales_() {
  const [rows] = await pool.query(`
    SELECT m.codigo_unidad AS CodigoUnidad, m.huerta_destino AS Huerta
    FROM movimientos_maquinaria m
    INNER JOIN (
      SELECT codigo_unidad, MAX(id) AS max_id
      FROM movimientos_maquinaria
      WHERE estado = 'confirmado'
      GROUP BY codigo_unidad
    ) ult ON ult.codigo_unidad = m.codigo_unidad AND ult.max_id = m.id
  `);
  const map = {};
  rows.forEach((r) => { map[r.CodigoUnidad] = r.Huerta; });
  return map;
}

async function getMaquinaria(code, nombreUsuario) {
  await requierePermisoPanel_(code, nombreUsuario, ['maquinaria', 'catalogo'], 'visualizar');

  const [rows] = await pool.query(MAQUINARIA_SELECT + ' ORDER BY m.unidad');
  const ubicMap = await getUbicacionesActuales_();

  // Estatus automático: si el equipo tiene una orden SIN cerrar en Taller
  // (fecha_salida vacía), se muestra "En mantenimiento" con la descripción
  // de esa falla; si no, "En trabajo" (con la nota manual, si tiene).
  const [abiertos] = await pool.query(`
    SELECT codigo_unidad AS CodigoUnidad, descripcion AS Descripcion
    FROM reportes
    WHERE fecha_salida IS NULL
    ORDER BY id DESC
  `);
  const abiertoMap = {};
  abiertos.forEach((r) => {
    if (!abiertoMap[r.CodigoUnidad]) abiertoMap[r.CodigoUnidad] = r.Descripcion;
  });

  return normalizaFilas(rows).map((r) => {
    const enMantenimiento = Object.prototype.hasOwnProperty.call(abiertoMap, r.CodigoUnidad);
    return {
      ...r,
      // Nombre a mostrar: el del catálogo de marcas/modelos si el equipo
      // ya está ligado, si no, el texto libre que se haya capturado antes
      // de que existiera ese catálogo (mismo patrón que Proveedor en
      // refacciones).
      Marca: r.MarcaNombre || r.MarcaTexto || '',
      Modelo: r.ModeloNombre || r.ModeloTexto || '',
      Huerta: ubicMap[r.CodigoUnidad] || '',
      Estatus: enMantenimiento ? 'En mantenimiento' : 'En trabajo',
      ObservacionMostrada: enMantenimiento ? abiertoMap[r.CodigoUnidad] : (r.Observaciones || ''),
      EsImplemento: esImplemento_(r.Unidad),
    };
  });
}

// Lista de personas con cuenta de acceso a la app (módulo 'Reportar') para
// el combo "Usuario de la app asignado" del modal de Maquinaria en el
// Panel — a propósito separada del catálogo libre de Operadores (ver
// usuario_asignado_app en db/schema.sql): aquí solo aparecen nombres que
// de verdad existen como cuenta, para que el filtro de equipo en
// Index.html (equiposAsignadosUsuario_) nunca falle por una mala escritura.
async function getUsuariosOperadoresApp(code, nombreUsuario) {
  await requierePermisoPanel_(code, nombreUsuario, ['maquinaria', 'catalogo'], 'visualizar');
  const [rows] = await pool.query('SELECT nombre, modulos FROM usuarios ORDER BY nombre');
  return rows
    .filter((r) => r.nombre && tieneAccesoModulo_(r.modulos, 'Reportar'))
    .map((r) => r.nombre);
}

async function guardarMaquinaria(code, nombreUsuario, codigoUnidad, data) {
  await requierePermisoPanel_(code, nombreUsuario, ['maquinaria', 'catalogo'], 'capturar');
  data = data || {};
  const unidad = (data.unidad || '').toString().trim();
  if (!unidad) return { success: false, error: 'Falta el nombre/etiqueta de la unidad.' };
  const departamentosValidos = ['CAMPO', 'COSECHA', 'PREPARACION'];
  const departamento =
    data.departamento && departamentosValidos.indexOf(String(data.departamento).toUpperCase()) !== -1
      ? String(data.departamento).toUpperCase()
      : null;

  const usaDiesel = data.usaDiesel ? 1 : 0;
  const usaGasolina = data.usaGasolina ? 1 : 0;
  // Solo aplica cuando usaGasolina = 1: algunas unidades automotrices en
  // realidad cargan diesel (no gasolina) — ver la nota en db/schema.sql
  // junto a la columna combustible_automotriz_tipo. 'gasolina' por default.
  const combustibleAutomotrizTipo = String(data.combustibleAutomotrizTipo || '').toLowerCase() === 'diesel' ? 'diesel' : 'gasolina';

  const marcaId = (data.marcaId === '' || data.marcaId === undefined || data.marcaId === null)
    ? null : Number(data.marcaId);
  let modeloId = (data.modeloId === '' || data.modeloId === undefined || data.modeloId === null)
    ? null : Number(data.modeloId);
  // El modelo elegido debe pertenecer a la marca elegida (por si el
  // frontend manda algo desfasado, igual que en guardarRefaccion).
  if (marcaId && modeloId) {
    const [modeloValido] = await pool.query(
      'SELECT id FROM modelos_refacciones WHERE id = ? AND marca_id = ?',
      [modeloId, marcaId]
    );
    if (modeloValido.length === 0) modeloId = null;
  } else {
    modeloId = null;
  }

  let codigo = (codigoUnidad || '').toString().trim();
  try {
    if (!codigo) {
      codigo = await siguienteFolio_(pool, 'maquinaria_nueva', 'EQ', 5);
    }
    // Las columnas "marca"/"modelo" (texto libre) ya no se escriben desde
    // aquí: se dejan como quedaron (respaldo de lo que se había capturado
    // antes de este catálogo), y el nombre a mostrar se resuelve en
    // getMaquinaria a partir de marca_id/modelo_id primero.
    const operadorAsignado = (data.operadorAsignado || '').toString().trim() || null;
    // A qué USUARIO de la app (cuenta real de Usuarios) se asigna este
    // equipo — ver usuario_asignado_app en db/schema.sql. Validamos que de
    // verdad sea una cuenta existente con acceso a 'Reportar' (si ya no lo
    // es -- se borró o se le quitó el acceso --, se guarda igual para no
    // sorprender con un valor "corregido" solo al editar otra cosa del
    // equipo; getUsuariosOperadoresApp ya no se lo ofrecerá para elegir).
    const usuarioAsignadoApp = (data.usuarioAsignadoApp || '').toString().trim() || null;
    // Admite Reparaciones con terceros (pestaña Órdenes): marca qué equipos
    // pueden usar esa categoría al crear/editar una orden — ver es_terceros
    // en db/schema.sql y la validación en crearOrdenPanel/editarOrden.
    const admiteTerceros = data.admiteTerceros ? 1 : 0;

    await pool.query(
      `INSERT INTO maquinaria
        (codigo_unidad, unidad, departamento, marca_id, modelo_id, anio, color, serie, placa, tipo_unidad, observaciones, usa_diesel, usa_gasolina, combustible_automotriz_tipo, operador_asignado, usuario_asignado_app, admite_terceros)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
        unidad = VALUES(unidad), departamento = VALUES(departamento), marca_id = VALUES(marca_id),
        modelo_id = VALUES(modelo_id), anio = VALUES(anio), color = VALUES(color), serie = VALUES(serie),
        placa = VALUES(placa), tipo_unidad = VALUES(tipo_unidad), observaciones = VALUES(observaciones),
        usa_diesel = VALUES(usa_diesel), usa_gasolina = VALUES(usa_gasolina),
        combustible_automotriz_tipo = VALUES(combustible_automotriz_tipo),
        operador_asignado = VALUES(operador_asignado),
        usuario_asignado_app = VALUES(usuario_asignado_app),
        admite_terceros = VALUES(admite_terceros)`,
      [
        codigo,
        unidad,
        departamento,
        marcaId,
        modeloId,
        data.anio || null,
        data.color || null,
        data.serie || null,
        data.placa || null,
        data.tipoUnidad || null,
        data.observaciones || null,
        usaDiesel,
        usaGasolina,
        combustibleAutomotrizTipo,
        operadorAsignado,
        usuarioAsignadoApp,
        admiteTerceros,
      ]
    );
    return { success: true, codigoUnidad: codigo };
  } catch (err) {
    return { success: false, error: err.toString() };
  }
}

async function eliminarMaquinaria(code, nombreUsuario, codigoUnidad) {
  await requierePermisoPanel_(code, nombreUsuario, ['maquinaria', 'catalogo'], 'capturar');
  await pool.query('DELETE FROM maquinaria WHERE codigo_unidad = ?', [codigoUnidad]);
  return { success: true };
}

async function getResumenHuertas(code, nombreUsuario) {
  await requierePermisoPanel_(code, nombreUsuario, 'maquinaria', 'visualizar');

  const ubicMap = await getUbicacionesActuales_();
  const [maquinas] = await pool.query('SELECT codigo_unidad AS CodigoUnidad, unidad AS Unidad FROM maquinaria');
  const unidadPorCodigo = {};
  maquinas.forEach((m) => { unidadPorCodigo[m.CodigoUnidad] = m.Unidad; });

  const porHuerta = {};
  function huertaBucket(h) {
    const key = (h || '').trim().toUpperCase();
    if (!porHuerta[key]) porHuerta[key] = { huerta: h, equipos: 0, tractores: 0, implementos: 0, reportes: 0 };
    return porHuerta[key];
  }

  Object.keys(ubicMap).forEach((codigo) => {
    const huerta = ubicMap[codigo];
    if (!huerta) return;
    const bucket = huertaBucket(huerta);
    bucket.equipos += 1;
    if (esImplemento_(unidadPorCodigo[codigo])) bucket.implementos += 1;
    else bucket.tractores += 1;
  });

  const [reportesAbiertos] = await pool.query(
    "SELECT huerta AS Huerta, COUNT(*) AS n FROM reportes WHERE fecha_salida IS NULL GROUP BY huerta"
  );
  reportesAbiertos.forEach((r) => {
    if (!r.Huerta) return;
    huertaBucket(r.Huerta).reportes = Number(r.n);
  });

  const [entregado] = await pool.query('SELECT huerta AS Huerta, SUM(litros) AS total FROM diesel_entregas WHERE eliminado = 0 GROUP BY huerta');
  const [cargado] = await pool.query('SELECT huerta AS Huerta, SUM(litros) AS total FROM diesel WHERE eliminado = 0 GROUP BY huerta');
  const entregadoMap = {};
  entregado.forEach((r) => { entregadoMap[(r.Huerta || '').trim().toUpperCase()] = Number(r.total) || 0; });
  const cargadoMap = {};
  cargado.forEach((r) => { cargadoMap[(r.Huerta || '').trim().toUpperCase()] = Number(r.total) || 0; });

  // Que aparezca cualquier huerta con diesel entregado/cargado, aunque
  // todavía no tenga ningún equipo ubicado ahí.
  Object.keys(entregadoMap).concat(Object.keys(cargadoMap)).forEach((key) => {
    if (!porHuerta[key]) porHuerta[key] = { huerta: key, equipos: 0, tractores: 0, implementos: 0, reportes: 0 };
  });

  return Object.keys(porHuerta)
    .map((key) => {
      const b = porHuerta[key];
      const entregadoTotal = entregadoMap[key] || 0;
      const cargadoTotal = cargadoMap[key] || 0;
      return {
        Huerta: b.huerta,
        Equipos: b.equipos,
        Tractores: b.tractores,
        Implementos: b.implementos,
        Reportes: b.reportes || 0,
        DieselEntregado: entregadoTotal,
        DieselCargado: cargadoTotal,
        DieselDisponible: entregadoTotal - cargadoTotal,
      };
    })
    .sort((a, b) => a.Huerta.localeCompare(b.Huerta, 'es'));
}

// ---------------------------------------------------------------
// Diesel entregado a huertas (a granel), para poder calcular cuánto le
// queda disponible a cada una: entregado - cargado.
// ---------------------------------------------------------------

// Deriva precioLitro/total de lo que mandó el formulario — mismo patrón que
// crearCargaGasolinaPanel: ambos son opcionales (no siempre se conoce el
// precio al momento de entregar), y si se manda litros+precio pero no
// total, se calcula solo.
function derivarCostoEntrega_(data, litros) {
  const precioLitro =
    data.precioLitro === '' || data.precioLitro === undefined || data.precioLitro === null ? null : Number(data.precioLitro);
  let total = data.total === '' || data.total === undefined || data.total === null ? null : Number(data.total);
  if ((total === null || Number.isNaN(total)) && precioLitro !== null && !Number.isNaN(precioLitro) && litros) {
    total = Math.round(litros * precioLitro * 100) / 100;
  }
  return {
    precioLitro: precioLitro === null || Number.isNaN(precioLitro) ? null : precioLitro,
    total: total === null || Number.isNaN(total) ? null : total,
  };
}

async function submitDieselEntrega(code, nombreUsuario, data) {
  await requierePermisoPanel_(code, nombreUsuario, 'diesel', 'capturar');
  data = data || {};
  try {
    if (!data.huerta || !data.litros) {
      return { success: false, error: 'Selecciona la huerta y captura los litros entregados.' };
    }
    const huertasRestringidas = await obtenerHuertasRestringidasUsuario_(nombreUsuario);
    if (!huertaPermitida_(huertasRestringidas, data.huerta)) {
      return { success: false, error: 'Tu usuario no tiene acceso a registrar entregas en la huerta ' + data.huerta + '.' };
    }
    const { precioLitro, total } = derivarCostoEntrega_(data, Number(data.litros));
    const folio = await siguienteFolio_(pool, 'entrega', 'ENT', 5);
    await pool.query(
      `INSERT INTO diesel_entregas (folio, huerta, litros, nombre, fecha, comentario, precio_litro, total)
       VALUES (?, ?, ?, ?, NOW(), ?, ?, ?)`,
      [folio, data.huerta, data.litros, data.nombre || '', data.comentario || null, precioLitro, total]
    );
    return { success: true, folio };
  } catch (err) {
    return { success: false, error: err.toString() };
  }
}

async function getDieselEntregas(code, nombreUsuario, incluirEliminados) {
  await requierePermisoPanel_(code, nombreUsuario, 'diesel', 'visualizar');
  const huertasRestringidas = await obtenerHuertasRestringidasUsuario_(nombreUsuario);
  const condicionesEnt = [];
  const paramsEnt = [];
  if (!incluirEliminados) condicionesEnt.push('eliminado = 0');
  if (huertasRestringidas) {
    condicionesEnt.push('UPPER(TRIM(huerta)) IN (?)');
    paramsEnt.push(huertasRestringidas);
  }
  const whereEnt = condicionesEnt.length > 0 ? 'WHERE ' + condicionesEnt.join(' AND ') : '';
  const [rows] = await pool.query(`
    SELECT id AS Id, folio AS Folio, huerta AS Huerta, litros AS Litros, nombre AS Nombre,
           fecha AS Fecha, comentario AS Comentario, precio_litro AS PrecioLitro, total AS Total,
           modificado_por AS ModificadoPor, modificado_en AS ModificadoEn,
           eliminado AS Eliminado, eliminado_por AS EliminadoPor, eliminado_en AS EliminadoEn
    FROM diesel_entregas
    ${whereEnt}
    ORDER BY id DESC
  `, paramsEnt);
  return normalizaFilas(rows);
}

// Staff: corrige una entrega de diesel a huerta ya registrada, desde el
// Panel. Deja constancia de quién y cuándo la modificó, igual que
// editarCargaDiesel.
async function editarDieselEntrega(code, nombreUsuario, id, data) {
  await requierePermisoPanel_(code, nombreUsuario, 'diesel', 'capturar');
  data = data || {};
  try {
    const idNum = Number(id);
    if (!idNum) return { success: false, error: 'Falta el identificador de la entrega.' };
    const [rows] = await pool.query('SELECT id, huerta FROM diesel_entregas WHERE id = ?', [idNum]);
    if (rows.length === 0) return { success: false, error: 'No se encontró esa entrega de diesel.' };
    const huertasRestringidas = await obtenerHuertasRestringidasUsuario_(nombreUsuario);
    if (!huertaPermitida_(huertasRestringidas, rows[0].huerta)) {
      return { success: false, error: 'Tu usuario no tiene acceso a esta entrega (huerta ' + (rows[0].huerta || 'sin huerta') + ').' };
    }

    const huerta = (data.huerta || '').toString().trim();
    const litros = Number(data.litros);
    const fecha = normalizarFechaLocal_(data.fecha);
    const comentario = (data.comentario || '').toString().trim() || null;

    if (!huerta) return { success: false, error: 'Selecciona la huerta.' };
    if (!litros || litros <= 0) return { success: false, error: 'Escribe una cantidad de litros válida.' };
    if (!fecha) return { success: false, error: 'Selecciona la fecha.' };
    if (!huertaPermitida_(huertasRestringidas, huerta)) {
      return { success: false, error: 'Tu usuario no tiene acceso a mover esta entrega a la huerta ' + huerta + '.' };
    }

    const modificadoPor = (nombreUsuario || '').toString().trim() || null;
    const { precioLitro, total } = derivarCostoEntrega_(data, litros);

    await pool.query(
      `UPDATE diesel_entregas SET huerta = ?, litros = ?, fecha = ?, comentario = ?, precio_litro = ?, total = ?,
        modificado_por = ?, modificado_en = NOW()
       WHERE id = ?`,
      [huerta, litros, fecha, comentario, precioLitro, total, modificadoPor, idNum]
    );
    await registrarAuditoria_('diesel_entregas', idNum, 'editar', nombreUsuario, huerta + ' — ' + litros + ' L');
    return { success: true };
  } catch (err) {
    return { success: false, error: err.toString() };
  }
}

// Staff: elimina (borrado suave) una entrega de diesel a huerta desde el
// Panel — igual que eliminarCargaDiesel, no borra la fila, la marca
// eliminado=1 (ver getDieselEntregas/restaurarDieselEntrega).
async function eliminarDieselEntrega(code, nombreUsuario, id) {
  await requierePermisoPanel_(code, nombreUsuario, 'diesel', 'capturar');
  try {
    const idNum = Number(id);
    if (!idNum) return { success: false, error: 'Falta el identificador de la entrega.' };
    const [rows] = await pool.query('SELECT id, huerta, litros, eliminado FROM diesel_entregas WHERE id = ?', [idNum]);
    if (rows.length === 0) return { success: false, error: 'No se encontró esa entrega de diesel.' };
    const huertasRestringidas = await obtenerHuertasRestringidasUsuario_(nombreUsuario);
    if (!huertaPermitida_(huertasRestringidas, rows[0].huerta)) {
      return { success: false, error: 'Tu usuario no tiene acceso a esta entrega (huerta ' + (rows[0].huerta || 'sin huerta') + ').' };
    }
    if (rows[0].eliminado) return { success: false, error: 'Esa entrega ya estaba eliminada.' };
    const eliminadoPor = (nombreUsuario || '').toString().trim() || null;
    await pool.query(
      'UPDATE diesel_entregas SET eliminado = 1, eliminado_por = ?, eliminado_en = NOW() WHERE id = ?',
      [eliminadoPor, idNum]
    );
    await registrarAuditoria_('diesel_entregas', idNum, 'eliminar', nombreUsuario, (rows[0].huerta || '') + ' — ' + rows[0].litros + ' L');
    return { success: true };
  } catch (err) {
    return { success: false, error: err.toString() };
  }
}

// Staff: revierte una eliminación de entrega de diesel a huerta.
async function restaurarDieselEntrega(code, nombreUsuario, id) {
  await requierePermisoPanel_(code, nombreUsuario, 'diesel', 'capturar');
  try {
    const idNum = Number(id);
    if (!idNum) return { success: false, error: 'Falta el identificador de la entrega.' };
    const [rows] = await pool.query('SELECT id, huerta, litros, eliminado FROM diesel_entregas WHERE id = ?', [idNum]);
    if (rows.length === 0) return { success: false, error: 'No se encontró esa entrega de diesel.' };
    const huertasRestringidas = await obtenerHuertasRestringidasUsuario_(nombreUsuario);
    if (!huertaPermitida_(huertasRestringidas, rows[0].huerta)) {
      return { success: false, error: 'Tu usuario no tiene acceso a esta entrega (huerta ' + (rows[0].huerta || 'sin huerta') + ').' };
    }
    if (!rows[0].eliminado) return { success: false, error: 'Esa entrega no estaba eliminada.' };
    await pool.query('UPDATE diesel_entregas SET eliminado = 0, eliminado_por = NULL, eliminado_en = NULL WHERE id = ?', [idNum]);
    await registrarAuditoria_('diesel_entregas', idNum, 'restaurar', nombreUsuario, (rows[0].huerta || '') + ' — ' + rows[0].litros + ' L');
    return { success: true };
  } catch (err) {
    return { success: false, error: err.toString() };
  }
}

// Cuánto diesel le queda disponible a cada huerta (entregado - cargado),
// para la tabla "Diesel restante por huerta" dentro de la pestaña Diesel.
// Deliberadamente aparte de getResumenHuertas (que exige permiso de
// "maquinaria" y trae además equipos/tractores/reportes) para que alguien
// con acceso solo a Diesel pueda verla sin necesitar la pestaña Maquinaria.
async function getDieselDisponiblePorHuerta(code, nombreUsuario, fechaInicio, fechaFin) {
  await requierePermisoPanel_(code, nombreUsuario, 'diesel', 'visualizar');
  const huertasRestringidas = await obtenerHuertasRestringidasUsuario_(nombreUsuario);

  // fechaInicio/fechaFin son opcionales ('YYYY-MM-DD'): si se dan, el
  // entregado/cargado/restante se calcula solo con lo que pasó en ese rango
  // de fechas, en vez del acumulado de todo el historial. "Hasta" se
  // extiende al final de ese día para incluir todo lo capturado ese día.
  // eliminado = 0 siempre, para no contar entregas/cargas que se hayan
  // eliminado (borrado suave) desde el Panel.
  const condiciones = ['eliminado = 0'];
  const params = [];
  if (fechaInicio) {
    condiciones.push('fecha >= ?');
    params.push(fechaInicio + ' 00:00:00');
  }
  if (fechaFin) {
    condiciones.push('fecha <= ?');
    params.push(fechaFin + ' 23:59:59');
  }
  const whereSql = ' WHERE ' + condiciones.join(' AND ');

  const [entregado] = await pool.query(
    'SELECT huerta AS Huerta, SUM(litros) AS total FROM diesel_entregas' + whereSql + ' GROUP BY huerta',
    params
  );
  const [cargado] = await pool.query(
    'SELECT huerta AS Huerta, SUM(litros) AS total FROM diesel' + whereSql + ' GROUP BY huerta',
    params
  );

  const porHuerta = {};
  function bucket(huerta) {
    const key = (huerta || '').trim().toUpperCase();
    if (!key) return null;
    if (!porHuerta[key]) porHuerta[key] = { huerta: huerta.trim(), entregado: 0, cargado: 0 };
    return porHuerta[key];
  }
  entregado.forEach((r) => {
    const b = bucket(r.Huerta);
    if (b) b.entregado = Number(r.total) || 0;
  });
  cargado.forEach((r) => {
    const b = bucket(r.Huerta);
    if (b) b.cargado = Number(r.total) || 0;
  });

  return Object.keys(porHuerta)
    .filter((key) => huertaPermitida_(huertasRestringidas, key))
    .map((key) => {
      const b = porHuerta[key];
      return {
        Huerta: b.huerta,
        DieselEntregado: b.entregado,
        DieselCargado: b.cargado,
        DieselDisponible: b.entregado - b.cargado,
      };
    })
    .sort((a, b) => a.Huerta.localeCompare(b.Huerta, 'es'));
}

// Reporte combinado de diesel: junta lo agrícola (bitácora por tractor/
// implemento) y lo automotriz (autos/camionetas marcados como diesel en
// Catálogo — ver combustible_automotriz_tipo) en un solo reporte por rango
// de fechas, ordenado como lo pidió Carlos: primero las huertas (a dónde
// entró el diesel, tabla diesel_entregas — el costo ahí es opcional, ver
// derivarCostoEntrega_), después los activos fijos a los que se les cargó
// (agrícola: tabla diesel, sin costo capturado por unidad; automotriz
// diesel: tabla combustible_automotriz, si tiene precio/total). Requiere
// ver 'diesel' O 'combustible_automotriz' (con cualquiera de los dos basta,
// igual que getMaquinaria con 'maquinaria'/'catalogo').
//
// Muestra cada registro por separado (folio + fecha de esa captura, no un
// acumulado) — se ordena por huerta/unidad primero y por fecha después,
// para que se puedan seguir viendo agrupadas las de una misma huerta o
// unidad, pero cada una con su propia fecha visible. El Panel (Panel.html)
// suma los totales del lado del cliente para la fila "TOTAL" de cada tabla.
async function getReporteDieselCombinado(code, nombreUsuario, fechaInicio, fechaFin) {
  await requierePermisoPanel_(code, nombreUsuario, ['diesel', 'combustible_automotriz'], 'visualizar');
  const huertasRestringidas = await obtenerHuertasRestringidasUsuario_(nombreUsuario);

  const condiciones = ['eliminado = 0'];
  const params = [];
  if (fechaInicio) {
    condiciones.push('fecha >= ?');
    params.push(fechaInicio + ' 00:00:00');
  }
  if (fechaFin) {
    condiciones.push('fecha <= ?');
    params.push(fechaFin + ' 23:59:59');
  }
  const whereSql = ' WHERE ' + condiciones.join(' AND ');

  // Registros "vacíos" (sin litros capturados — típicamente una bitácora
  // ingestada por IA que quedó a medias, folio reservado pero sin datos) no
  // aportan nada a un reporte de volumen de diesel, así que se excluyen
  // AQUÍ (solo del reporte combinado) — se siguen viendo en la pestaña
  // normal de Diesel/Combustible para que se puedan corregir.
  const litrosValido_ = (v) => {
    const n = Number(v);
    return !Number.isNaN(n) && n > 0;
  };

  // Empresa/Proveedor de una entrega a huerta: mismo criterio que en
  // DIESEL_SELECT — se derivan de la Huerta (texto) contra el catálogo de
  // Huertas, con LEFT JOIN para no perder la entrega si la huerta ya no
  // tiene Empresa/Proveedor asignado o fue borrada del catálogo.
  const [huertasRows] = await pool.query(
    `SELECT de.folio AS Folio, de.huerta AS Huerta, de.litros AS Litros, de.total AS Costo, de.fecha AS Fecha,
            eh.nombre AS Empresa, ph.nombre AS Proveedor
     FROM diesel_entregas de
     LEFT JOIN huertas h ON h.nombre = de.huerta
     LEFT JOIN empresas eh ON eh.id = h.empresa_id
     LEFT JOIN proveedores_combustible ph ON ph.id = h.proveedor_id`
      + whereSql.replace(/\bfecha\b/g, 'de.fecha').replace(/\beliminado\b/g, 'de.eliminado'),
    params
  );
  const huertas = huertasRows
    .filter((r) => litrosValido_(r.Litros) && huertaPermitida_(huertasRestringidas, r.Huerta))
    .map((r) => ({
      Folio: r.Folio,
      Huerta: (r.Huerta || '').trim(),
      Litros: Number(r.Litros) || 0,
      Costo: r.Costo === null ? null : Number(r.Costo),
      Fecha: r.Fecha,
      Empresa: r.Empresa || null,
      Proveedor: r.Proveedor || null,
    }))
    .sort((a, b) => a.Huerta.localeCompare(b.Huerta, 'es') || new Date(a.Fecha) - new Date(b.Fecha));

  // Para la bitácora agrícola necesitamos TODAS sus cargas (no solo las del
  // rango del reporte), porque "horas de labor"/"rendimiento" se calculan
  // contra la lectura ANTERIOR de esa unidad, que puede haber quedado fuera
  // del rango — mismo criterio que usa getCargasDiesel. Ya filtramos al
  // rango después de calcular, con agricolaEnRango_.
  const [dieselCrudas] = await pool.query(DIESEL_SELECT + ' WHERE d.eliminado = 0');
  const horasLaborPorId = calcularHorasLaborYRendimientoPorId_(dieselCrudas);
  const agricolaEnRango_ = (fecha) => {
    const t = fecha ? new Date(fecha).getTime() : NaN;
    if (Number.isNaN(t)) return false;
    if (fechaInicio && t < new Date(fechaInicio + ' 00:00:00').getTime()) return false;
    if (fechaFin && t > new Date(fechaFin + ' 23:59:59').getTime()) return false;
    return true;
  };
  const agricolaRows = dieselCrudas.filter((r) => agricolaEnRango_(r.Fecha) && litrosValido_(r.Litros) && huertaPermitida_(huertasRestringidas, r.Huerta));

  const [automotrizRowsCrudas] = await pool.query(
    `SELECT folio AS Folio, codigo_unidad AS CodigoUnidad, unidad AS Unidad, litros AS Litros, total AS Costo, fecha AS Fecha,
            empresa AS Empresa, proveedor AS Proveedor
     FROM combustible_automotriz` + whereSql + ` AND tipo_combustible = 'diesel'`,
    params
  );
  const automotrizRows = automotrizRowsCrudas.filter((r) => litrosValido_(r.Litros));

  const activos = agricolaRows
    .map((r) => {
      const extra = horasLaborPorId[r.Id] || { horasLabor: null, rendimiento: null };
      return {
        Folio: r.Folio,
        CodigoUnidad: r.CodigoUnidad,
        Unidad: r.Unidad,
        Origen: 'agricola',
        Litros: Number(r.Litros) || 0,
        Costo: null, // la bitácora agrícola no captura precio por carga
        Fecha: r.Fecha,
        // Solo con sentido para agrícola — automotriz no captura huerta,
        // implemento ni horómetro por carga (ver combustible_automotriz).
        Departamento: (r.Departamento || '').trim(),
        Huerta: (r.Huerta || '').trim(),
        HorasLabor: extra.horasLabor,
        Rendimiento: extra.rendimiento,
        Implemento: (r.Implemento || '').trim(),
        Empresa: r.Empresa || null,
        Proveedor: r.Proveedor || null,
      };
    })
    .concat(
      automotrizRows.map((r) => ({
        Folio: r.Folio,
        CodigoUnidad: r.CodigoUnidad,
        Unidad: r.Unidad,
        Origen: 'automotriz',
        Litros: Number(r.Litros) || 0,
        Costo: r.Costo === null ? null : Number(r.Costo),
        Fecha: r.Fecha,
        Departamento: null,
        Huerta: null,
        HorasLabor: null,
        Rendimiento: null,
        Implemento: null,
        // Automotriz sí captura Empresa/Proveedor directo por carga (texto
        // copiado al momento del ticket — ver combustible_automotriz.empresa/
        // .proveedor), a diferencia de agrícola que se deriva de la Huerta.
        Empresa: r.Empresa || null,
        Proveedor: r.Proveedor || null,
      }))
    )
    .sort((a, b) => (a.Unidad || '').localeCompare(b.Unidad || '', 'es') || new Date(a.Fecha) - new Date(b.Fecha));

  return { huertas, activos };
}

// Reporte general de combustible: lo mismo que getReporteDieselCombinado
// (huertas + activos fijos), pero además de diesel también junta la
// gasolina de Combustible Automotriz — pedido por Carlos para no tener que
// revisar el reporte de diesel y el de Combustible Automotriz por separado.
// Cada carga/entrega trae un campo Tipo ('diesel' o 'gasolina') para poder
// distinguirlas en el reporte; en huertas y en la bitácora agrícola siempre
// es 'diesel' (ahí no se maneja gasolina). Mismos permisos que el reporte
// de diesel: basta con 'diesel' O 'combustible_automotriz'.
async function getReporteCombustibleGeneral(code, nombreUsuario, fechaInicio, fechaFin) {
  await requierePermisoPanel_(code, nombreUsuario, ['diesel', 'combustible_automotriz'], 'visualizar');
  const huertasRestringidas = await obtenerHuertasRestringidasUsuario_(nombreUsuario);

  const condiciones = ['eliminado = 0'];
  const params = [];
  if (fechaInicio) {
    condiciones.push('fecha >= ?');
    params.push(fechaInicio + ' 00:00:00');
  }
  if (fechaFin) {
    condiciones.push('fecha <= ?');
    params.push(fechaFin + ' 23:59:59');
  }
  const whereSql = ' WHERE ' + condiciones.join(' AND ');

  const litrosValido_ = (v) => {
    const n = Number(v);
    return !Number.isNaN(n) && n > 0;
  };

  const [huertasRows] = await pool.query(
    `SELECT de.folio AS Folio, de.huerta AS Huerta, de.litros AS Litros, de.total AS Costo, de.fecha AS Fecha,
            eh.nombre AS Empresa, ph.nombre AS Proveedor
     FROM diesel_entregas de
     LEFT JOIN huertas h ON h.nombre = de.huerta
     LEFT JOIN empresas eh ON eh.id = h.empresa_id
     LEFT JOIN proveedores_combustible ph ON ph.id = h.proveedor_id`
      + whereSql.replace(/\bfecha\b/g, 'de.fecha').replace(/\beliminado\b/g, 'de.eliminado'),
    params
  );
  const huertas = huertasRows
    .filter((r) => litrosValido_(r.Litros) && huertaPermitida_(huertasRestringidas, r.Huerta))
    .map((r) => ({
      Folio: r.Folio,
      Huerta: (r.Huerta || '').trim(),
      Tipo: 'diesel',
      Litros: Number(r.Litros) || 0,
      Costo: r.Costo === null ? null : Number(r.Costo),
      Fecha: r.Fecha,
      Empresa: r.Empresa || null,
      Proveedor: r.Proveedor || null,
    }))
    .sort((a, b) => a.Huerta.localeCompare(b.Huerta, 'es') || new Date(a.Fecha) - new Date(b.Fecha));

  const [dieselCrudas] = await pool.query(DIESEL_SELECT + ' WHERE d.eliminado = 0');
  const horasLaborPorId = calcularHorasLaborYRendimientoPorId_(dieselCrudas);
  const agricolaEnRango_ = (fecha) => {
    const t = fecha ? new Date(fecha).getTime() : NaN;
    if (Number.isNaN(t)) return false;
    if (fechaInicio && t < new Date(fechaInicio + ' 00:00:00').getTime()) return false;
    if (fechaFin && t > new Date(fechaFin + ' 23:59:59').getTime()) return false;
    return true;
  };
  const agricolaRows = dieselCrudas.filter((r) => agricolaEnRango_(r.Fecha) && litrosValido_(r.Litros) && huertaPermitida_(huertasRestringidas, r.Huerta));

  // A diferencia de getReporteDieselCombinado, aquí NO se filtra por
  // tipo_combustible — se traen tanto diesel como gasolina.
  const [automotrizRowsCrudas] = await pool.query(
    `SELECT folio AS Folio, codigo_unidad AS CodigoUnidad, unidad AS Unidad, litros AS Litros, total AS Costo, fecha AS Fecha,
            tipo_combustible AS TipoCombustible, empresa AS Empresa, proveedor AS Proveedor
     FROM combustible_automotriz` + whereSql,
    params
  );
  const automotrizRows = automotrizRowsCrudas.filter((r) => litrosValido_(r.Litros));

  const activos = agricolaRows
    .map((r) => {
      const extra = horasLaborPorId[r.Id] || { horasLabor: null, rendimiento: null };
      return {
        Folio: r.Folio,
        CodigoUnidad: r.CodigoUnidad,
        Unidad: r.Unidad,
        Origen: 'agricola',
        Tipo: 'diesel',
        Litros: Number(r.Litros) || 0,
        Costo: null,
        Fecha: r.Fecha,
        Departamento: (r.Departamento || '').trim(),
        Huerta: (r.Huerta || '').trim(),
        HorasLabor: extra.horasLabor,
        Rendimiento: extra.rendimiento,
        Implemento: (r.Implemento || '').trim(),
        Empresa: r.Empresa || null,
        Proveedor: r.Proveedor || null,
      };
    })
    .concat(
      automotrizRows.map((r) => ({
        Folio: r.Folio,
        CodigoUnidad: r.CodigoUnidad,
        Unidad: r.Unidad,
        Origen: 'automotriz',
        Tipo: r.TipoCombustible === 'gasolina' ? 'gasolina' : 'diesel',
        Litros: Number(r.Litros) || 0,
        Costo: r.Costo === null ? null : Number(r.Costo),
        Fecha: r.Fecha,
        Departamento: null,
        Huerta: null,
        HorasLabor: null,
        Rendimiento: null,
        Implemento: null,
        Empresa: r.Empresa || null,
        Proveedor: r.Proveedor || null,
      }))
    )
    .sort((a, b) => (a.Unidad || '').localeCompare(b.Unidad || '', 'es') || new Date(a.Fecha) - new Date(b.Fecha));

  return { huertas, activos };
}

// Mismo cálculo de "horas de labor" y "rendimiento" que usa getCargasDiesel
// (diferencia contra la lectura/horómetro anterior de la MISMA unidad,
// ordenando cronológicamente) pero factorizado aparte para poder
// reutilizarlo en getReporteDieselCombinado sin tocar getCargasDiesel.
// Recibe filas crudas de DIESEL_SELECT (con Id, CodigoUnidad, Fecha,
// Lectura, Litros) y regresa un mapa { [Id]: { horasLabor, rendimiento } }.
function calcularHorasLaborYRendimientoPorId_(rowsCrudas) {
  const porUnidad = {};
  rowsCrudas.forEach((r) => {
    const clave = r.CodigoUnidad || '';
    if (!porUnidad[clave]) porUnidad[clave] = [];
    porUnidad[clave].push(r);
  });

  const resultado = {};
  Object.keys(porUnidad).forEach((clave) => {
    const grupo = porUnidad[clave].slice().sort((a, b) => {
      const fa = a.Fecha ? new Date(a.Fecha).getTime() : 0;
      const fb = b.Fecha ? new Date(b.Fecha).getTime() : 0;
      if (fa !== fb) return fa - fb;
      return (a.Id || 0) - (b.Id || 0);
    });
    let lecturaPrevia = null;
    grupo.forEach((r) => {
      const lecturaActual = r.Lectura === null || r.Lectura === undefined || r.Lectura === '' ? null : Number(r.Lectura);
      const lecturaActualValida = lecturaActual !== null && !Number.isNaN(lecturaActual);

      let horasLabor = null;
      if (lecturaPrevia !== null && lecturaActualValida) {
        horasLabor = lecturaActual - lecturaPrevia;
      }
      const litros = r.Litros === null || r.Litros === undefined || r.Litros === '' ? null : Number(r.Litros);
      let rendimiento = null;
      if (litros !== null && !Number.isNaN(litros) && horasLabor !== null && horasLabor > 0) {
        rendimiento = Math.round((litros / horasLabor) * 100) / 100;
      }
      resultado[r.Id] = { horasLabor, rendimiento };

      if (lecturaActualValida) lecturaPrevia = lecturaActual;
    });
  });
  return resultado;
}

// Rendimiento aceptable (litros por hora de labor) configurado por equipo.
// Vive dentro de la pestaña Diesel (mismos permisos 'diesel') para no tener
// que dar de alta una pestaña nueva ni tocar el sistema de permisos.
async function getRendimientoMaquinaria(code, nombreUsuario) {
  await requierePermisoPanel_(code, nombreUsuario, 'diesel', 'visualizar');
  // Solo equipos marcados "funciona con diesel" en el Catálogo: a los demás
  // ni siquiera se les puede capturar diesel, así que no tiene sentido
  // pedirles un rendimiento aceptable.
  const [rows] = await pool.query(
    `SELECT codigo_unidad AS CodigoUnidad, unidad AS Unidad, rendimiento_max AS RendimientoMax,
            horas_max AS HorasMax, actualizado_en AS ActualizadoEn
     FROM maquinaria
     WHERE usa_diesel = 1
     ORDER BY unidad`
  );
  return normalizaFilas(rows);
}

// Público (sin código de acceso ni usuario): lo usa la captura de campo
// (Index.html) para saber a qué unidades se les puede cargar diesel — solo
// tractores y retros marcados "funciona con diesel" en el Catálogo. Mismo
// criterio que usa el Panel en poblarSelectsDiesel().
async function getUnidadesDieselPermitidas() {
  const [rows] = await pool.query(
    `SELECT codigo_unidad AS CodigoUnidad, unidad AS Unidad
     FROM maquinaria
     WHERE usa_diesel = 1`
  );
  return normalizaFilas(rows);
}

async function guardarRendimientoMaquinaria(code, nombreUsuario, codigoUnidad, rendimientoMax, horasMax) {
  await requierePermisoPanel_(code, nombreUsuario, 'diesel', 'capturar');
  const codigo = (codigoUnidad || '').toString().trim();
  if (!codigo) return { success: false, error: 'Falta el equipo.' };

  let valor = null;
  if (rendimientoMax !== null && rendimientoMax !== undefined && rendimientoMax !== '') {
    valor = Number(rendimientoMax);
    if (Number.isNaN(valor) || valor < 0) return { success: false, error: 'El rendimiento aceptable debe ser un número mayor o igual a 0.' };
  }

  let valorHoras = null;
  if (horasMax !== null && horasMax !== undefined && horasMax !== '') {
    valorHoras = Number(horasMax);
    if (Number.isNaN(valorHoras) || valorHoras < 0) return { success: false, error: 'Las horas máximas entre cargas deben ser un número mayor o igual a 0.' };
  }

  try {
    const [existe] = await pool.query('SELECT codigo_unidad AS CodigoUnidad, unidad AS Unidad FROM maquinaria WHERE codigo_unidad = ?', [codigo]);
    if (!existe.length) return { success: false, error: 'No se encontró ese equipo.' };

    await pool.query('UPDATE maquinaria SET rendimiento_max = ?, horas_max = ? WHERE codigo_unidad = ?', [valor, valorHoras, codigo]);
    await registrarAuditoria_(
      'maquinaria',
      codigo,
      'editar',
      nombreUsuario,
      'rendimiento aceptable: ' + (valor === null ? 'sin límite' : valor + ' L/h') +
        ' · horas máximas entre cargas: ' + (valorHoras === null ? 'sin límite' : valorHoras + ' h') +
        ' (' + existe[0].Unidad + ')'
    );
    return { success: true };
  } catch (err) {
    return { success: false, error: err.toString() };
  }
}

// ---------------------------------------------------------------
// Mantenimiento preventivo (pestaña "Mantenimiento")
// ---------------------------------------------------------------

// Calcula, a partir de una lectura base (ultimaLectura/ultimaFecha) y un
// intervalo, si el servicio está vencido y cuánto falta — la misma fórmula
// para "reglas" (antes) y ahora para "servicios" (por equipo). `lecturaActual`
// es la lectura vigente del equipo (diesel/manual); solo se usa para tipo
// 'horas'/'kilometros'.
function calcularProximoServicio_(tipo, intervalo, ultimaLectura, ultimaFecha, lecturaActual, ahora) {
  const MS_DIA = 24 * 60 * 60 * 1000;
  let sinLineaBase = false;
  let proximaLectura = null;
  let proximaFecha = null;
  let restante = null;
  let vencido = false;

  if (tipo === 'horas' || tipo === 'kilometros') {
    if (ultimaLectura === null) {
      sinLineaBase = true;
    } else {
      proximaLectura = ultimaLectura + intervalo;
      if (lecturaActual !== null) {
        restante = proximaLectura - lecturaActual;
        vencido = restante <= 0;
      }
    }
  } else {
    // tipo === 'tiempo': intervalo está en MESES; se aproxima a días (x30).
    if (!ultimaFecha) {
      sinLineaBase = true;
    } else {
      proximaFecha = new Date(ultimaFecha.getTime() + Math.round(intervalo * 30) * MS_DIA);
      restante = Math.round((proximaFecha.getTime() - ahora) / MS_DIA);
      vencido = proximaFecha.getTime() <= ahora;
    }
  }

  return { sinLineaBase, proximaLectura, proximaFecha, restante, vencido };
}

// Lectura vigente (horómetro/odómetro) de cada equipo: la última carga de
// diesel (horómetro, agrícola) o de Combustible Automotriz (odómetro, autos/
// camionetas/camiones/motos) con lectura capturada, o la lectura manual si
// es más reciente (ver también getMaquinaria/getReglasMantenimiento
// originalmente). Un equipo normalmente solo aparece en diesel O en
// combustible_automotriz (nunca en los dos: uno es agrícola por huerta, el
// otro es autos por ticket de gasolinera) — pero por si acaso se toma
// siempre la más reciente de las dos, igual que ya se hacía entre la
// automática y la manual.
async function getLecturasActualesPorEquipo_() {
  // Antes esto comparaba por MAX(fecha) y hacía JOIN contra esa fecha: si
  // una unidad tenía dos cargas con la MISMA fecha (algo normal — "fecha"
  // es un DATETIME, pero varias capturas quedan a medianoche cuando se
  // editan a mano o vienen de un campo de solo fecha), el JOIN podía
  // regresar ambas filas empatadas y cuál "ganaba" en el mapa final
  // dependía del orden en que MySQL las devolviera — no necesariamente la
  // más reciente. Eso hacía que, por ejemplo, al corregir una lectura mal
  // capturada, la pantalla de Servicios/Preventivos pudiera seguir
  // mostrando el valor viejo. Ahora se usa ROW_NUMBER() para quedarnos,
  // de forma determinística, con UNA sola fila por unidad: la de fecha
  // más reciente y, si hay empate de fecha, la de mayor id (la última
  // guardada).
  const [dieselUlt] = await pool.query(`
    SELECT CodigoUnidad, Lectura, Fecha FROM (
      SELECT d.codigo_unidad AS CodigoUnidad, d.lectura AS Lectura, d.fecha AS Fecha,
             ROW_NUMBER() OVER (PARTITION BY d.codigo_unidad ORDER BY d.fecha DESC, d.id DESC) AS rn
      FROM diesel d
      WHERE d.lectura IS NOT NULL AND d.eliminado = 0
    ) ranked
    WHERE rn = 1
  `);
  const dieselMap = {};
  dieselUlt.forEach((r) => {
    dieselMap[r.CodigoUnidad] = { lectura: Number(r.Lectura), fecha: r.Fecha };
  });

  const [automotrizUlt] = await pool.query(`
    SELECT CodigoUnidad, Lectura, Fecha FROM (
      SELECT c.codigo_unidad AS CodigoUnidad, c.lectura AS Lectura, c.fecha AS Fecha,
             ROW_NUMBER() OVER (PARTITION BY c.codigo_unidad ORDER BY c.fecha DESC, c.id DESC) AS rn
      FROM combustible_automotriz c
      WHERE c.lectura IS NOT NULL AND c.eliminado = 0
    ) ranked
    WHERE rn = 1
  `);
  const automotrizMap = {};
  automotrizUlt.forEach((r) => {
    automotrizMap[r.CodigoUnidad] = { lectura: Number(r.Lectura), fecha: r.Fecha };
  });

  const [maquinas] = await pool.query(
    'SELECT codigo_unidad AS CodigoUnidad, lectura_manual AS LecturaManual, lectura_manual_fecha AS LecturaManualFecha FROM maquinaria'
  );

  const map = {};
  maquinas.forEach((m) => {
    const codigo = m.CodigoUnidad;
    const deDiesel = dieselMap[codigo] || null;
    const deAutomotriz = automotrizMap[codigo] || null;
    // Entre diesel y combustible_automotriz, se queda con la más reciente
    // (normalmente solo una de las dos existe para un equipo dado).
    let auto = null;
    let autoOrigen = null;
    if (deDiesel && deAutomotriz) {
      if (new Date(deAutomotriz.fecha).getTime() >= new Date(deDiesel.fecha).getTime()) {
        auto = deAutomotriz; autoOrigen = 'automotriz';
      } else {
        auto = deDiesel; autoOrigen = 'diesel';
      }
    } else if (deAutomotriz) {
      auto = deAutomotriz; autoOrigen = 'automotriz';
    } else if (deDiesel) {
      auto = deDiesel; autoOrigen = 'diesel';
    }

    const manualLectura = m.LecturaManual !== null && m.LecturaManual !== undefined ? Number(m.LecturaManual) : null;
    const manualFecha = m.LecturaManualFecha ? new Date(m.LecturaManualFecha) : null;

    let lecturaActual = null;
    let lecturaActualFecha = null;
    let lecturaActualOrigen = null;
    if (auto && manualLectura !== null && manualFecha) {
      if (manualFecha.getTime() >= new Date(auto.fecha).getTime()) {
        lecturaActual = manualLectura; lecturaActualFecha = manualFecha; lecturaActualOrigen = 'manual';
      } else {
        lecturaActual = auto.lectura; lecturaActualFecha = new Date(auto.fecha); lecturaActualOrigen = autoOrigen;
      }
    } else if (auto) {
      lecturaActual = auto.lectura; lecturaActualFecha = new Date(auto.fecha); lecturaActualOrigen = autoOrigen;
    } else if (manualLectura !== null) {
      lecturaActual = manualLectura; lecturaActualFecha = manualFecha; lecturaActualOrigen = 'manual';
    }
    map[codigo] = { lecturaActual, lecturaActualFecha, lecturaActualOrigen };
  });
  return map;
}

// Refacciones asignadas a cada regla (catálogo estructurado, ver tabla
// mantenimiento_regla_refacciones / pestaña "Refacciones"), agrupadas por
// regla_id.
async function getRefaccionesAsignadasPorRegla_() {
  const [asignaciones] = await pool.query(`
    SELECT mrr.regla_id AS ReglaId, mrr.cantidad AS Cantidad,
           ref.id AS Id, ref.no_parte AS NoParte, ref.descripcion AS Descripcion,
           ref.precio AS Precio, ref.proveedor AS Proveedor
    FROM mantenimiento_regla_refacciones mrr
    INNER JOIN refacciones ref ON ref.id = mrr.refaccion_id
    ORDER BY ref.descripcion
  `);
  const asignadasPorRegla = {};
  asignaciones.forEach((a) => {
    if (!asignadasPorRegla[a.ReglaId]) asignadasPorRegla[a.ReglaId] = [];
    asignadasPorRegla[a.ReglaId].push({
      Id: a.Id,
      NoParte: a.NoParte || '',
      Descripcion: a.Descripcion,
      Precio: a.Precio !== null && a.Precio !== undefined ? Number(a.Precio) : null,
      Proveedor: a.Proveedor || '',
      Cantidad: Number(a.Cantidad),
    });
  });
  return asignadasPorRegla;
}

// ---------------------------------------------------------------
// Tipos de preventivo (catálogo chico: PREVENTIVO MOTOR / PREVENTIVO
// HIDRAULICO por ahora, administrable para agregar más después — mismo
// patrón que categorias_refacciones/marcas_refacciones).
// ---------------------------------------------------------------
// También administrable desde la pestaña Catálogo (además de Preventivos
// Agrícolas, donde ya se podía dar de alta con "+ Tipo de preventivo").
const PESTANAS_CATALOGO_TIPO_PREVENTIVO_ = ['mantenimiento', 'servicios_automotrices', 'catalogo'];

async function getTiposPreventivo(code, nombreUsuario) {
  await requierePermisoPanel_(code, nombreUsuario, PESTANAS_CATALOGO_TIPO_PREVENTIVO_, 'visualizar');
  const [rows] = await pool.query('SELECT id AS Id, nombre AS Nombre FROM tipos_preventivo ORDER BY nombre');
  return rows.map((r) => ({ Id: r.Id, Nombre: r.Nombre }));
}

async function guardarTipoPreventivo(code, nombreUsuario, id, data) {
  await requierePermisoPanel_(code, nombreUsuario, PESTANAS_CATALOGO_TIPO_PREVENTIVO_, 'capturar');
  data = data || {};
  try {
    const nombre = (data.nombre || '').toString().trim();
    if (!nombre) return { success: false, error: 'Escribe el nombre del tipo de preventivo.' };
    if (id) {
      await pool.query('UPDATE tipos_preventivo SET nombre=? WHERE id=?', [nombre, id]);
      return { success: true, id: Number(id) };
    }
    const [result] = await pool.query('INSERT INTO tipos_preventivo (nombre) VALUES (?)', [nombre]);
    return { success: true, id: result.insertId };
  } catch (err) {
    if (err && err.code === 'ER_DUP_ENTRY') {
      return { success: false, error: 'Ya existe un tipo de preventivo con ese nombre.' };
    }
    return { success: false, error: err.toString() };
  }
}

async function eliminarTipoPreventivo(code, nombreUsuario, id) {
  await requierePermisoPanel_(code, nombreUsuario, PESTANAS_CATALOGO_TIPO_PREVENTIVO_, 'capturar');
  const [reglas] = await pool.query('SELECT id FROM mantenimiento_reglas WHERE tipo_preventivo_id = ?', [id]);
  if (reglas.length > 0) {
    return { success: false, error: 'No se puede eliminar: hay reglas de mantenimiento que usan este tipo. Elimínalas o cámbiales el tipo primero.' };
  }
  await pool.query('DELETE FROM tipos_preventivo WHERE id = ?', [id]);
  return { success: true };
}

// ---------------------------------------------------------------
// Reglas de mantenimiento preventivo (pestaña "PREVENTIVOS AGRICOLAS"):
// catálogo por MODELO — una regla = un (modelo, tipo de preventivo), con
// sus filtros/refacciones y litros de aceite. Aplica automáticamente a
// todo equipo de ese modelo (ver getServiciosMantenimiento). Las reglas
// viejas por equipo (previas a este cambio) se quedan en la tabla
// desactivadas, sin modelo_id, y no aparecen en este listado.
// ---------------------------------------------------------------
// Núcleo compartido entre Preventivos Agrícolas y Servicios Automotrices
// (mismo motor, ver el comentario grande junto a SERVICIOS AUTOMOTRICES en
// schema.sql). "scope": 'agricola' deja solo las reglas de modelos SIN
// ningún equipo usa_gasolina=1, 'automotriz' deja solo las que SÍ tienen —
// así cada pestaña, y cada permiso, ve únicamente lo suyo.
async function obtenerReglasMantenimiento_(scope) {
  const [reglas] = await pool.query(`
    SELECT
      r.id                AS Id,
      r.modelo_id         AS ModeloId,
      mo.nombre           AS ModeloNombre,
      mo.marca_id         AS MarcaId,
      mc.nombre           AS MarcaNombre,
      r.tipo_preventivo_id AS TipoPreventivoId,
      tp.nombre           AS TipoPreventivoNombre,
      r.nombre_servicio   AS NombreServicio,
      r.tipo_periodicidad AS TipoPeriodicidad,
      r.intervalo         AS Intervalo,
      r.refacciones       AS Refacciones,
      r.aceite_litros     AS AceiteLitros,
      r.activo            AS Activo,
      EXISTS(SELECT 1 FROM maquinaria mm WHERE mm.modelo_id = r.modelo_id AND mm.usa_gasolina = 1) AS EsAutomotriz
    FROM mantenimiento_reglas r
    LEFT JOIN modelos_refacciones mo ON mo.id = r.modelo_id
    LEFT JOIN marcas_refacciones mc ON mc.id = mo.marca_id
    LEFT JOIN tipos_preventivo tp ON tp.id = r.tipo_preventivo_id
    WHERE r.modelo_id IS NOT NULL
    ORDER BY mc.nombre, mo.nombre, tp.nombre
  `);

  const asignadasPorRegla = await getRefaccionesAsignadasPorRegla_();

  const mapeadas = reglas.map((r) => ({
    Id: r.Id,
    ModeloId: r.ModeloId,
    ModeloNombre: r.ModeloNombre || '',
    MarcaId: r.MarcaId,
    MarcaNombre: r.MarcaNombre || '',
    TipoPreventivoId: r.TipoPreventivoId,
    TipoPreventivoNombre: r.TipoPreventivoNombre || '',
    NombreServicio: r.NombreServicio,
    TipoPeriodicidad: r.TipoPeriodicidad,
    Intervalo: Number(r.Intervalo) || 0,
    Notas: r.Refacciones || '',
    RefaccionesAsignadas: asignadasPorRegla[r.Id] || [],
    AceiteLitros: r.AceiteLitros !== null && r.AceiteLitros !== undefined ? Number(r.AceiteLitros) : null,
    Activo: !!r.Activo,
    EsAutomotriz: !!r.EsAutomotriz,
  }));

  if (scope === 'agricola') return mapeadas.filter((r) => !r.EsAutomotriz);
  if (scope === 'automotriz') return mapeadas.filter((r) => r.EsAutomotriz);
  return mapeadas;
}

async function getReglasMantenimiento(code, nombreUsuario) {
  await requierePermisoPanel_(code, nombreUsuario, 'mantenimiento', 'visualizar');
  return obtenerReglasMantenimiento_('agricola');
}

async function getReglasServiciosAutomotrices(code, nombreUsuario) {
  await requierePermisoPanel_(code, nombreUsuario, 'servicios_automotrices', 'visualizar');
  return obtenerReglasMantenimiento_('automotriz');
}

// Valida que el modelo elegido sea del ámbito correcto para el permiso que
// se está usando ('agricola' | 'automotriz') — así alguien con SOLO el
// permiso de Servicios Automotrices no puede crear/editar una regla de un
// modelo agrícola (y alguien con solo Preventivos Agrícolas no puede tocar
// una de un modelo automotriz). Mismo criterio que obtenerReglasMantenimiento_
// (usa_gasolina de los equipos de ese modelo). Un modelo sin NINGÚN equipo
// capturado todavía (recién dado de alta en Catálogo) se deja pasar en
// cualquiera de los dos ámbitos, porque todavía no se puede saber cuál es.
async function verificarModeloDelAmbito_(modeloId, scope) {
  if (!scope || !modeloId) return true;
  const [rows] = await pool.query(
    'SELECT COUNT(*) AS total, COALESCE(SUM(usa_gasolina), 0) AS automotrices FROM maquinaria WHERE modelo_id = ?',
    [modeloId]
  );
  const total = Number(rows[0].total) || 0;
  if (total === 0) return true;
  const esAutomotriz = Number(rows[0].automotrices) > 0;
  return scope === 'automotriz' ? esAutomotriz : !esAutomotriz;
}

async function guardarReglaMantenimiento(code, nombreUsuario, id, data) {
  await requierePermisoPanel_(code, nombreUsuario, 'mantenimiento', 'capturar');
  return guardarReglaMantenimiento_(id, data, 'agricola');
}

async function guardarReglaServicioAutomotriz(code, nombreUsuario, id, data) {
  await requierePermisoPanel_(code, nombreUsuario, 'servicios_automotrices', 'capturar');
  return guardarReglaMantenimiento_(id, data, 'automotriz');
}

async function guardarReglaMantenimiento_(id, data, scope) {
  data = data || {};
  try {
    const modeloId = (data.modeloId === '' || data.modeloId === undefined || data.modeloId === null)
      ? null : Number(data.modeloId);
    const tipoPreventivoId = (data.tipoPreventivoId === '' || data.tipoPreventivoId === undefined || data.tipoPreventivoId === null)
      ? null : Number(data.tipoPreventivoId);
    const tipo = (data.tipoPeriodicidad || 'horas').toString().trim();
    const intervalo = Number(data.intervalo);

    if (!modeloId) return { success: false, error: 'Selecciona el modelo.' };
    if (!(await verificarModeloDelAmbito_(modeloId, scope))) {
      return {
        success: false,
        error: scope === 'automotriz'
          ? 'Ese modelo no es de un vehículo automotriz.'
          : 'Ese modelo es de un vehículo automotriz — captura sus reglas desde Servicios Automotrices.',
      };
    }
    if (!tipoPreventivoId) return { success: false, error: 'Selecciona el tipo de preventivo.' };
    if (['horas', 'kilometros', 'tiempo'].indexOf(tipo) === -1) {
      return { success: false, error: 'Selecciona un tipo de periodicidad válido.' };
    }
    if (!intervalo || intervalo <= 0) return { success: false, error: 'Captura un intervalo mayor a cero.' };

    const [tipos] = await pool.query('SELECT nombre FROM tipos_preventivo WHERE id = ?', [tipoPreventivoId]);
    if (tipos.length === 0) return { success: false, error: 'El tipo de preventivo seleccionado ya no existe.' };
    const nombreServicio = tipos[0].nombre;

    const refacciones = (data.refacciones || '').toString().trim() || null; // notas adicionales (texto libre)
    const aceiteLitros = (data.aceiteLitros === '' || data.aceiteLitros === undefined || data.aceiteLitros === null)
      ? null : Number(data.aceiteLitros);
    const activo = data.activo === undefined ? true : !!data.activo;

    // Lista de refacciones estructuradas asignadas a esta regla:
    // [{ refaccionId, cantidad }, ...]
    const asignadas = Array.isArray(data.refaccionesAsignadas) ? data.refaccionesAsignadas : [];

    let reglaId = id ? Number(id) : null;

    if (reglaId) {
      await pool.query(
        `UPDATE mantenimiento_reglas
         SET modelo_id=?, tipo_preventivo_id=?, nombre_servicio=?, tipo_periodicidad=?, intervalo=?,
             refacciones=?, aceite_litros=?, activo=?
         WHERE id=?`,
        [modeloId, tipoPreventivoId, nombreServicio, tipo, intervalo, refacciones, aceiteLitros, activo ? 1 : 0, reglaId]
      );
    } else {
      const [result] = await pool.query(
        `INSERT INTO mantenimiento_reglas
          (modelo_id, tipo_preventivo_id, nombre_servicio, tipo_periodicidad, intervalo, refacciones, aceite_litros, activo)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [modeloId, tipoPreventivoId, nombreServicio, tipo, intervalo, refacciones, aceiteLitros, activo ? 1 : 0]
      );
      reglaId = result.insertId;
    }

    // Reemplaza por completo las refacciones asignadas (borra y vuelve a
    // insertar), así se evita duplicar o dejar asignaciones huérfanas.
    await pool.query('DELETE FROM mantenimiento_regla_refacciones WHERE regla_id = ?', [reglaId]);
    for (const a of asignadas) {
      const refaccionId = Number(a.refaccionId);
      const cantidad = Number(a.cantidad);
      if (!refaccionId || !cantidad || cantidad <= 0) continue;
      await pool.query(
        'INSERT INTO mantenimiento_regla_refacciones (regla_id, refaccion_id, cantidad) VALUES (?, ?, ?)',
        [reglaId, refaccionId, cantidad]
      );
    }

    return { success: true, id: reglaId };
  } catch (err) {
    if (err && err.code === 'ER_DUP_ENTRY') {
      return { success: false, error: 'Ya existe una regla para ese modelo y ese tipo de preventivo.' };
    }
    return { success: false, error: err.toString() };
  }
}

async function eliminarReglaMantenimiento(code, nombreUsuario, id) {
  await requierePermisoPanel_(code, nombreUsuario, 'mantenimiento', 'capturar');
  return eliminarReglaMantenimiento_(id, 'agricola');
}

async function eliminarReglaServicioAutomotriz(code, nombreUsuario, id) {
  await requierePermisoPanel_(code, nombreUsuario, 'servicios_automotrices', 'capturar');
  return eliminarReglaMantenimiento_(id, 'automotriz');
}

async function eliminarReglaMantenimiento_(id, scope) {
  const [reglas] = await pool.query('SELECT modelo_id FROM mantenimiento_reglas WHERE id = ?', [id]);
  if (reglas.length === 0) return { success: true }; // ya no existe, nada que hacer
  if (!(await verificarModeloDelAmbito_(reglas[0].modelo_id, scope))) {
    return {
      success: false,
      error: scope === 'automotriz'
        ? 'Esa regla no es de un vehículo automotriz.'
        : 'Esa regla es de un vehículo automotriz — elimínala desde Servicios Automotrices.',
    };
  }
  await pool.query('DELETE FROM mantenimiento_ordenes WHERE regla_id = ?', [id]);
  await pool.query('DELETE FROM mantenimiento_servicios WHERE regla_id = ?', [id]);
  await pool.query('DELETE FROM mantenimiento_regla_refacciones WHERE regla_id = ?', [id]);
  await pool.query('DELETE FROM mantenimiento_reglas WHERE id = ?', [id]);
  return { success: true };
}

// ---------------------------------------------------------------
// Servicios de mantenimiento (pestaña "PREVENTIVOS AGRICOLAS", apartado
// "Servicios"): el estado real, por EQUIPO, de cada regla de su modelo —
// último servicio (fecha/horómetro) y próximo servicio calculado. La
// lista se arma completa cruzando cada regla activa con cada equipo de su
// modelo, aunque ese equipo todavía no tenga ningún historial capturado
// (SinLineaBase=true en ese caso).
// ---------------------------------------------------------------
async function getServiciosMantenimiento(code, nombreUsuario) {
  await requierePermisoPanel_(code, nombreUsuario, 'mantenimiento', 'visualizar');
  return getServiciosConHuertasRestringidas_(nombreUsuario, 'agricola');
}

async function getServiciosAutomotrices(code, nombreUsuario) {
  await requierePermisoPanel_(code, nombreUsuario, 'servicios_automotrices', 'visualizar');
  return getServiciosConHuertasRestringidas_(nombreUsuario, 'automotriz');
}

async function getServiciosConHuertasRestringidas_(nombreUsuario, scope) {
  const servicios = await obtenerServiciosMantenimiento_(scope);
  const huertasRestringidas = await obtenerHuertasRestringidasUsuario_(nombreUsuario);
  if (!huertasRestringidas) return servicios;
  // Las reglas (pestaña "Reglas") no tienen huerta propia — aplican por
  // modelo de equipo, no por huerta, así que no se restringen aquí. Lo que
  // sí se filtra es esta lista de "Servicios" (el estado real por EQUIPO),
  // usando la huerta ACTUAL de cada equipo (Huerta, calculada arriba con
  // getUbicacionesActuales_) — un usuario restringido solo ve el estado de
  // mantenimiento de los equipos que hoy están en sus huertas permitidas.
  return servicios.filter((s) => huertaPermitida_(huertasRestringidas, s.Huerta));
}

// Misma consulta que getServiciosMantenimiento/getServiciosAutomotrices, sin
// el chequeo de permiso ni de huertas restringidas, para uso interno (p.ej.
// el job automático que revisa si hay que generar una orden — que debe
// cubrir TODOS los equipos, agrícolas y automotrices, así que llama esta
// función sin "scope"). No exportar directamente: siempre pasar por una
// función que sí valide permiso cuando la llame el frontend. "scope":
// 'agricola' deja solo equipos SIN usa_gasolina, 'automotriz' solo los que
// SÍ lo tienen, sin valor deja los dos.
async function obtenerServiciosMantenimiento_(scope) {
  const [filas] = await pool.query(`
    SELECT
      r.id                 AS ReglaId,
      r.nombre_servicio    AS NombreServicio,
      r.tipo_periodicidad  AS TipoPeriodicidad,
      r.intervalo          AS Intervalo,
      r.refacciones        AS Notas,
      r.aceite_litros      AS AceiteLitros,
      mo.nombre            AS ModeloNombre,
      mc.nombre            AS MarcaNombre,
      tp.nombre            AS TipoPreventivoNombre,
      m.codigo_unidad      AS CodigoUnidad,
      m.unidad             AS Unidad,
      m.departamento       AS Departamento,
      m.usa_gasolina       AS EsAutomotriz,
      s.id                 AS ServicioId,
      s.intervalo_override AS IntervaloOverride,
      s.ultima_lectura     AS UltimaLectura,
      s.ultima_fecha       AS UltimaFecha
    FROM mantenimiento_reglas r
    INNER JOIN modelos_refacciones mo ON mo.id = r.modelo_id
    LEFT JOIN marcas_refacciones mc ON mc.id = mo.marca_id
    LEFT JOIN tipos_preventivo tp ON tp.id = r.tipo_preventivo_id
    INNER JOIN maquinaria m ON m.modelo_id = r.modelo_id
    LEFT JOIN mantenimiento_servicios s ON s.regla_id = r.id AND s.codigo_unidad = m.codigo_unidad
    WHERE r.activo = 1
    ORDER BY m.unidad, tp.nombre
  `);

  const ubicMap = await getUbicacionesActuales_();
  const lecturaMap = await getLecturasActualesPorEquipo_();
  const asignadasPorRegla = await getRefaccionesAsignadasPorRegla_();

  const ahora = Date.now();

  let resultado = filas.map((r) => {
    const codigo = r.CodigoUnidad;
    const lect = lecturaMap[codigo] || { lecturaActual: null, lecturaActualFecha: null, lecturaActualOrigen: null };
    const tipo = r.TipoPeriodicidad;
    const intervaloOverride = r.IntervaloOverride !== null && r.IntervaloOverride !== undefined ? Number(r.IntervaloOverride) : null;
    const intervalo = intervaloOverride !== null ? intervaloOverride : (Number(r.Intervalo) || 0);
    const ultimaLectura = r.UltimaLectura !== null && r.UltimaLectura !== undefined ? Number(r.UltimaLectura) : null;
    const ultimaFecha = r.UltimaFecha ? new Date(r.UltimaFecha) : null;

    const calc = calcularProximoServicio_(tipo, intervalo, ultimaLectura, ultimaFecha, lect.lecturaActual, ahora);

    return {
      ReglaId: r.ReglaId,
      CodigoUnidad: codigo,
      ServicioId: r.ServicioId || null,
      Unidad: r.Unidad || codigo,
      Huerta: ubicMap[codigo] || '',
      Departamento: r.Departamento || '',
      ModeloNombre: r.ModeloNombre || '',
      MarcaNombre: r.MarcaNombre || '',
      EsAutomotriz: !!r.EsAutomotriz,
      TipoPreventivoNombre: r.TipoPreventivoNombre || '',
      NombreServicio: r.NombreServicio,
      TipoPeriodicidad: tipo,
      IntervaloBase: Number(r.Intervalo) || 0,
      IntervaloOverride: intervaloOverride,
      Intervalo: intervalo,
      Notas: r.Notas || '',
      RefaccionesAsignadas: asignadasPorRegla[r.ReglaId] || [],
      AceiteLitros: r.AceiteLitros !== null && r.AceiteLitros !== undefined ? Number(r.AceiteLitros) : null,
      UltimaLectura: ultimaLectura,
      UltimaFecha: isoOrNull(r.UltimaFecha),
      LecturaActual: lect.lecturaActual,
      LecturaActualFecha: lect.lecturaActualFecha ? lect.lecturaActualFecha.toISOString() : null,
      LecturaActualOrigen: lect.lecturaActualOrigen,
      SinLineaBase: calc.sinLineaBase,
      ProximaLectura: calc.proximaLectura,
      ProximaFecha: calc.proximaFecha ? calc.proximaFecha.toISOString() : null,
      Restante: calc.restante,
      Vencido: calc.vencido,
    };
  });

  if (scope === 'agricola') resultado = resultado.filter((r) => !r.EsAutomotriz);
  if (scope === 'automotriz') resultado = resultado.filter((r) => r.EsAutomotriz);
  return resultado;
}

// Captura/edita a mano el "último servicio" (fecha + horómetro) de un
// equipo para una regla en particular, y opcionalmente un intervalo propio
// para ese equipo (intervaloOverride) distinto al estándar del modelo.
async function guardarServicioMantenimiento(code, nombreUsuario, reglaId, codigoUnidad, data) {
  await requierePermisoPanel_(code, nombreUsuario, 'mantenimiento', 'capturar');
  return guardarServicioMantenimiento_(nombreUsuario, reglaId, codigoUnidad, data, 'agricola');
}

async function guardarServicioAutomotriz(code, nombreUsuario, reglaId, codigoUnidad, data) {
  await requierePermisoPanel_(code, nombreUsuario, 'servicios_automotrices', 'capturar');
  return guardarServicioMantenimiento_(nombreUsuario, reglaId, codigoUnidad, data, 'automotriz');
}

async function guardarServicioMantenimiento_(nombreUsuario, reglaId, codigoUnidad, data, scope) {
  data = data || {};
  try {
    if (!reglaId) return { success: false, error: 'Falta la regla.' };
    codigoUnidad = (codigoUnidad || '').toString().trim();
    if (!codigoUnidad) return { success: false, error: 'Falta el equipo.' };

    const [reglas] = await pool.query('SELECT modelo_id FROM mantenimiento_reglas WHERE id = ?', [reglaId]);
    if (reglas.length === 0) return { success: false, error: 'No se encontró la regla de mantenimiento.' };
    const [maquinas] = await pool.query('SELECT modelo_id, usa_gasolina FROM maquinaria WHERE codigo_unidad = ?', [codigoUnidad]);
    if (maquinas.length === 0) return { success: false, error: 'No se encontró el equipo.' };
    if (!reglas[0].modelo_id || reglas[0].modelo_id !== maquinas[0].modelo_id) {
      return { success: false, error: 'Ese equipo no es del modelo de esta regla.' };
    }
    if (scope === 'automotriz' && !maquinas[0].usa_gasolina) {
      return { success: false, error: 'Ese equipo no es un vehículo automotriz.' };
    }
    if (scope === 'agricola' && maquinas[0].usa_gasolina) {
      return { success: false, error: 'Ese equipo es un vehículo automotriz — captúralo desde Servicios Automotrices.' };
    }

    const huertasRestringidas = await obtenerHuertasRestringidasUsuario_(nombreUsuario);
    if (huertasRestringidas) {
      const ubicMap = await getUbicacionesActuales_();
      const huertaEquipo = ubicMap[codigoUnidad] || '';
      if (!huertaPermitida_(huertasRestringidas, huertaEquipo)) {
        return { success: false, error: 'Tu usuario no tiene acceso a este equipo (huerta ' + (huertaEquipo || 'sin huerta') + ').' };
      }
    }

    const ultimaLectura = (data.ultimaLectura === '' || data.ultimaLectura === undefined || data.ultimaLectura === null)
      ? null : Number(data.ultimaLectura);
    const ultimaFecha = data.ultimaFecha || null;
    const intervaloOverride = (data.intervaloOverride === '' || data.intervaloOverride === undefined || data.intervaloOverride === null)
      ? null : Number(data.intervaloOverride);

    await pool.query(
      `INSERT INTO mantenimiento_servicios (regla_id, codigo_unidad, ultima_lectura, ultima_fecha, intervalo_override)
       VALUES (?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
        ultima_lectura = VALUES(ultima_lectura), ultima_fecha = VALUES(ultima_fecha),
        intervalo_override = VALUES(intervalo_override)`,
      [Number(reglaId), codigoUnidad, ultimaLectura, ultimaFecha, intervaloOverride]
    );
    return { success: true };
  } catch (err) {
    return { success: false, error: err.toString() };
  }
}

// Lista mínima de equipos automotrices (código + nombre + modelo), para el
// botón "Importar lista" de Servicios Automotrices: con esto el navegador
// hace el emparejamiento entre cada fila del Excel/CSV y el equipo real
// ANTES de pedir confirmación (ver importarServiciosAutomotrices abajo, que
// ya recibe el emparejamiento ya resuelto, no vuelve a adivinarlo).
async function getEquiposAutomotrices(code, nombreUsuario) {
  await requierePermisoPanel_(code, nombreUsuario, 'servicios_automotrices', 'visualizar');
  const [rows] = await pool.query(
    'SELECT codigo_unidad AS CodigoUnidad, unidad AS Unidad, modelo_id AS ModeloId FROM maquinaria WHERE usa_gasolina = 1 ORDER BY unidad'
  );
  return rows.map((r) => ({ CodigoUnidad: r.CodigoUnidad, Unidad: r.Unidad, ModeloId: r.ModeloId }));
}

// Importación en lote del listado de Servicios Automotrices (botón
// "Importar lista"): el navegador ya resolvió cada fila a un codigo_unidad
// real (ver getEquiposAutomotrices arriba) y las mandó aquí ya revisadas
// por quien las subió. Por cada fila: encuentra o crea el tipo de
// preventivo (por nombre), encuentra o crea/actualiza la regla de ese
// modelo+tipo (tipo_periodicidad SIEMPRE 'kilometros' — Servicios
// Automotrices es, por ahora, solo por kilometraje) y guarda el "último
// servicio" (fecha + km) de ese equipo — mismo UPSERT que
// guardarServicioMantenimiento_. Nunca borra nada que ya exista: si la
// regla ya existía con otro intervalo, lo actualiza al de la importación
// (se asume que el listado nuevo es la fuente de verdad más reciente).
async function importarServiciosAutomotrices(code, nombreUsuario, filas) {
  await requierePermisoPanel_(code, nombreUsuario, 'servicios_automotrices', 'capturar');
  filas = Array.isArray(filas) ? filas : [];
  const resultado = { success: true, guardados: 0, reglasCreadas: 0, reglasActualizadas: 0, errores: [] };
  const reglaCache = {}; // "modeloId::TIPO" -> reglaId, para no repetir trabajo dentro de la misma importación

  for (const fila of filas) {
    const descripcionFila = (fila && (fila.unidad || fila.codigoUnidad)) || JSON.stringify(fila);
    try {
      const codigoUnidad = ((fila && fila.codigoUnidad) || '').toString().trim();
      const tipoServicio = ((fila && fila.tipoServicio) || '').toString().trim().toUpperCase();
      const ultimoKm = (!fila || fila.ultimoKm === '' || fila.ultimoKm === undefined || fila.ultimoKm === null)
        ? null : Number(fila.ultimoKm);
      const fechaUltimo = (fila && fila.fechaUltimo) || null;
      const periodicidad = Number(fila && fila.periodicidad);

      if (!codigoUnidad) { resultado.errores.push({ fila: descripcionFila, error: 'Falta el equipo.' }); continue; }
      if (!tipoServicio) { resultado.errores.push({ fila: descripcionFila, error: 'Falta el tipo de servicio.' }); continue; }
      if (!periodicidad || periodicidad <= 0) { resultado.errores.push({ fila: descripcionFila, error: 'La periodicidad (en km) no es válida.' }); continue; }

      const [maquinas] = await pool.query('SELECT modelo_id, usa_gasolina FROM maquinaria WHERE codigo_unidad = ?', [codigoUnidad]);
      if (maquinas.length === 0) { resultado.errores.push({ fila: descripcionFila, error: 'No se encontró el equipo ' + codigoUnidad + '.' }); continue; }
      if (!maquinas[0].usa_gasolina) { resultado.errores.push({ fila: descripcionFila, error: codigoUnidad + ' no está marcado como automotriz en Catálogo.' }); continue; }
      const modeloId = maquinas[0].modelo_id;
      if (!modeloId) { resultado.errores.push({ fila: descripcionFila, error: codigoUnidad + ' no tiene marca/modelo asignado en Catálogo — asígnaselo primero.' }); continue; }

      const cacheKey = modeloId + '::' + tipoServicio;
      let reglaId = reglaCache[cacheKey];
      if (!reglaId) {
        const [tipos] = await pool.query('SELECT id FROM tipos_preventivo WHERE nombre = ?', [tipoServicio]);
        let tipoPreventivoId;
        if (tipos.length === 0) {
          const [insTipo] = await pool.query('INSERT INTO tipos_preventivo (nombre) VALUES (?)', [tipoServicio]);
          tipoPreventivoId = insTipo.insertId;
        } else {
          tipoPreventivoId = tipos[0].id;
        }

        const [reglas] = await pool.query(
          'SELECT id, intervalo, tipo_periodicidad, activo FROM mantenimiento_reglas WHERE modelo_id = ? AND tipo_preventivo_id = ?',
          [modeloId, tipoPreventivoId]
        );
        if (reglas.length === 0) {
          const [insRegla] = await pool.query(
            `INSERT INTO mantenimiento_reglas (modelo_id, tipo_preventivo_id, nombre_servicio, tipo_periodicidad, intervalo, activo)
             VALUES (?, ?, ?, 'kilometros', ?, 1)`,
            [modeloId, tipoPreventivoId, tipoServicio, periodicidad]
          );
          reglaId = insRegla.insertId;
          resultado.reglasCreadas++;
        } else {
          reglaId = reglas[0].id;
          const cambia = Number(reglas[0].intervalo) !== periodicidad || reglas[0].tipo_periodicidad !== 'kilometros' || !reglas[0].activo;
          if (cambia) {
            await pool.query(
              'UPDATE mantenimiento_reglas SET intervalo = ?, tipo_periodicidad = ?, activo = 1 WHERE id = ?',
              [periodicidad, 'kilometros', reglaId]
            );
            resultado.reglasActualizadas++;
          }
        }
        reglaCache[cacheKey] = reglaId;
      }

      await pool.query(
        `INSERT INTO mantenimiento_servicios (regla_id, codigo_unidad, ultima_lectura, ultima_fecha)
         VALUES (?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE ultima_lectura = VALUES(ultima_lectura), ultima_fecha = VALUES(ultima_fecha)`,
        [reglaId, codigoUnidad, ultimoKm, fechaUltimo]
      );
      resultado.guardados++;
    } catch (err) {
      resultado.errores.push({ fila: descripcionFila, error: err.toString() });
    }
  }

  return resultado;
}

// ---------------------------------------------------------------
// Refacciones: catálogo maestro (pestaña "Refacciones")
// ---------------------------------------------------------------

async function getRefacciones(code, nombreUsuario) {
  await requierePermisoPanel_(code, nombreUsuario, 'refacciones', 'visualizar');
  const [rows] = await pool.query(`
    SELECT r.id AS Id, r.codigo AS Codigo, r.no_parte AS NoParte, r.descripcion AS Descripcion,
           r.precio AS Precio, r.proveedor AS ProveedorTexto, r.proveedor_id AS ProveedorId,
           p.nombre AS ProveedorNombre, r.categoria_id AS CategoriaId, c.nombre AS CategoriaNombre,
           r.marca_id AS MarcaId, mr.nombre AS MarcaNombre
    FROM refacciones r
    LEFT JOIN proveedores p ON p.id = r.proveedor_id
    LEFT JOIN categorias_refacciones c ON c.id = r.categoria_id
    LEFT JOIN marcas_refacciones mr ON mr.id = r.marca_id
    ORDER BY r.descripcion
  `);
  const [modelosRows] = await pool.query(`
    SELECT rm.refaccion_id AS RefaccionId, m.id AS ModeloId, m.nombre AS ModeloNombre
    FROM refacciones_modelos rm
    JOIN modelos_refacciones m ON m.id = rm.modelo_id
    ORDER BY m.nombre
  `);
  const modelosPorRefaccion = {};
  modelosRows.forEach((mr) => {
    if (!modelosPorRefaccion[mr.RefaccionId]) modelosPorRefaccion[mr.RefaccionId] = [];
    modelosPorRefaccion[mr.RefaccionId].push({ Id: mr.ModeloId, Nombre: mr.ModeloNombre });
  });
  return rows.map((r) => {
    const modelos = modelosPorRefaccion[r.Id] || [];
    return {
      Id: r.Id,
      Codigo: r.Codigo || '',
      NoParte: r.NoParte || '',
      Descripcion: r.Descripcion,
      Precio: r.Precio !== null && r.Precio !== undefined ? Number(r.Precio) : null,
      ProveedorId: r.ProveedorId || null,
      // Nombre a mostrar: el del catálogo de proveedores si está ligado,
      // si no, el texto libre que se haya capturado antes de ese catálogo.
      Proveedor: r.ProveedorNombre || r.ProveedorTexto || '',
      CategoriaId: r.CategoriaId || null,
      Categoria: r.CategoriaNombre || '',
      MarcaId: r.MarcaId || null,
      Marca: r.MarcaNombre || '',
      ModeloIds: modelos.map((m) => m.Id),
      Modelos: modelos.map((m) => m.Nombre).join(', '),
    };
  });
}

async function guardarRefaccion(code, nombreUsuario, id, data) {
  await requierePermisoPanel_(code, nombreUsuario, 'refacciones', 'capturar');
  data = data || {};
  try {
    const descripcion = (data.descripcion || '').toString().trim();
    if (!descripcion) return { success: false, error: 'Escribe la descripción de la refacción.' };
    const noParte = (data.noParte || '').toString().trim() || null;
    const precio = (data.precio === '' || data.precio === undefined || data.precio === null)
      ? null : Number(data.precio);
    const proveedorId = (data.proveedorId === '' || data.proveedorId === undefined || data.proveedorId === null)
      ? null : Number(data.proveedorId);
    const categoriaId = (data.categoriaId === '' || data.categoriaId === undefined || data.categoriaId === null)
      ? null : Number(data.categoriaId);
    const marcaId = (data.marcaId === '' || data.marcaId === undefined || data.marcaId === null)
      ? null : Number(data.marcaId);
    // Solo se guardan modelos que de verdad pertenecen a la marca elegida
    // (por si el frontend manda algo desfasado, p.ej. se cambió de marca
    // sin refrescar la selección de modelos).
    let modeloIds = Array.isArray(data.modeloIds) ? data.modeloIds.map(Number).filter((n) => !isNaN(n)) : [];
    if (marcaId && modeloIds.length > 0) {
      const [modelosValidos] = await pool.query(
        'SELECT id FROM modelos_refacciones WHERE marca_id = ? AND id IN (?)',
        [marcaId, modeloIds]
      );
      const validos = new Set(modelosValidos.map((m) => m.id));
      modeloIds = modeloIds.filter((mid) => validos.has(mid));
    } else if (!marcaId) {
      modeloIds = [];
    }

    let refaccionId;
    if (id) {
      // El código (REF-00001...) nunca se reasigna: se ignora aquí aunque
      // venga en data, se conserva el que ya tenía.
      await pool.query(
        'UPDATE refacciones SET no_parte=?, descripcion=?, precio=?, proveedor_id=?, categoria_id=?, marca_id=? WHERE id=?',
        [noParte, descripcion, precio, proveedorId, categoriaId, marcaId, id]
      );
      refaccionId = Number(id);
    } else {
      // Refacción nueva: se le asigna un código consecutivo (REF-00001...)
      // que ya nunca cambia, para poder identificarla sin depender del
      // "No. de parte" (que es texto libre de la marca y puede repetirse).
      const codigo = await siguienteFolio_(pool, 'refaccion', 'REF', 5);
      const [result] = await pool.query(
        'INSERT INTO refacciones (codigo, no_parte, descripcion, precio, proveedor_id, categoria_id, marca_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [codigo, noParte, descripcion, precio, proveedorId, categoriaId, marcaId]
      );
      refaccionId = result.insertId;
    }

    // Sincroniza los modelos compatibles: se borran los que ya no aplican
    // y se insertan los nuevos (más simple y sin duda alguna que calcular
    // la diferencia exacta, y esta tabla nunca es grande por refacción).
    await pool.query('DELETE FROM refacciones_modelos WHERE refaccion_id = ?', [refaccionId]);
    if (modeloIds.length > 0) {
      const values = modeloIds.map((mid) => [refaccionId, mid]);
      await pool.query('INSERT INTO refacciones_modelos (refaccion_id, modelo_id) VALUES ?', [values]);
    }

    return { success: true, id: refaccionId };
  } catch (err) {
    return { success: false, error: err.toString() };
  }
}

async function eliminarRefaccion(code, nombreUsuario, id) {
  await requierePermisoPanel_(code, nombreUsuario, 'refacciones', 'capturar');
  await pool.query('DELETE FROM mantenimiento_regla_refacciones WHERE refaccion_id = ?', [id]);
  await pool.query('DELETE FROM solicitud_cotizacion_items WHERE refaccion_id = ?', [id]);
  await pool.query('DELETE FROM refacciones_modelos WHERE refaccion_id = ?', [id]);
  // Las órdenes que ya tenían esta refacción marcada como necesaria no
  // pierden el dato: se conserva como texto libre (con la descripción que
  // tenía) en vez de quedar huérfanas apuntando a un id que ya no existe.
  await pool.query(
    `UPDATE reportes_refacciones_necesarias n
     JOIN refacciones r ON r.id = n.refaccion_id
     SET n.texto_libre = r.descripcion, n.refaccion_id = NULL
     WHERE n.refaccion_id = ?`,
    [id]
  );
  await pool.query('DELETE FROM refacciones WHERE id = ?', [id]);
  return { success: true };
}

// ---------------------------------------------------------------
// Insumos: bitácora de lo que van pidiendo los encargados de campo
// (herramienta, material, fertilizante, etc.), capturada por la capturista
// del Panel — pestaña "Insumos". El insumo se elige del mismo catálogo de
// Refacciones (para no duplicar catálogos), pero la descripción/código se
// GUARDAN COMO COPIA (insumo_descripcion/insumo_codigo) en el momento de
// capturar/editar, en vez de solo el id — así, si esa refacción se edita o
// se elimina después del catálogo (ver eliminarRefaccion arriba), el
// historial de Insumos ya capturado no cambia ni queda huérfano.
// Cada solicitud queda "pendiente" hasta que alguien la marca como
// "entregada" (marcarInsumoEntregado/marcarInsumoPendiente), y se elimina
// con borrado suave (eliminado/eliminado_por/eliminado_en), igual que las
// cargas de diesel (ver eliminarCargaDiesel/restaurarCargaDiesel arriba),
// para poder restaurarla si se eliminó por error.
// Catálogo (solo id/descripción/código) para llenar el selector de "Insumo"
// del modal de captura. Es una copia liviana de getRefacciones que exige
// el permiso de "insumos" en vez del de "refacciones" — para que una
// capturista con acceso a Insumos pero SIN acceso a la pestaña Refacciones
// igual pueda elegir el insumo del catálogo al capturar una solicitud.
async function getCatalogoInsumos(code, nombreUsuario) {
  await requierePermisoPanel_(code, nombreUsuario, 'insumos', 'visualizar');
  const [rows] = await pool.query(
    `SELECT id AS Id, descripcion AS Descripcion, COALESCE(codigo, no_parte) AS Codigo
     FROM refacciones
     ORDER BY descripcion`
  );
  return normalizaFilas(rows);
}

async function getInsumos(code, nombreUsuario, incluirEliminados) {
  await requierePermisoPanel_(code, nombreUsuario, 'insumos', 'visualizar');
  const [rows] = await pool.query(
    `SELECT id AS Id, folio AS Folio, refaccion_id AS RefaccionId,
            insumo_descripcion AS Insumo, insumo_codigo AS InsumoCodigo,
            cantidad AS Cantidad, huerta AS Huerta, encargado AS Encargado, comentario AS Comentario,
            precio_unitario AS PrecioUnitario,
            estatus AS Estatus, capturado_por AS CapturadoPor,
            autorizado_por AS AutorizadoPor, autorizado_en AS AutorizadoEn,
            entregado_por AS EntregadoPor, entregado_en AS EntregadoEn,
            modificado_por AS ModificadoPor, modificado_en AS ModificadoEn,
            eliminado AS Eliminado, eliminado_por AS EliminadoPor, eliminado_en AS EliminadoEn,
            creado_en AS CreadoEn
     FROM insumos_solicitados
     ` + (incluirEliminados ? '' : 'WHERE eliminado = 0 ') + `
     ORDER BY id DESC`
  );
  return normalizaFilas(rows);
}

async function guardarInsumo(code, nombreUsuario, id, data) {
  await requierePermisoPanel_(code, nombreUsuario, 'insumos', 'capturar');
  data = data || {};
  try {
    const refaccionId = data.refaccionId ? Number(data.refaccionId) : null;
    if (!refaccionId) return { success: false, error: 'Elige qué insumo se pidió.' };
    const cantidad = Number(data.cantidad);
    if (!cantidad || Number.isNaN(cantidad) || cantidad <= 0) return { success: false, error: 'La cantidad debe ser un número mayor a 0.' };
    const huerta = (data.huerta || '').toString().trim();
    if (!huerta) return { success: false, error: 'Elige la huerta.' };
    const encargado = (data.encargado || '').toString().trim();
    if (!encargado) return { success: false, error: 'Escribe quién lo pidió.' };
    const comentario = (data.comentario || '').toString().trim() || null;
    // Precio unitario de la pieza: opcional aquí (se puede capturar desde ya
    // si ya se conoce, o dejar vacío y llenarlo después al Autorizar — ver
    // marcarInsumoAutorizado más abajo, que SÍ lo exige). Editar este campo
    // desde este modal no cambia el estatus/autorización de la solicitud.
    let precioUnitario = null;
    if (data.precioUnitario !== undefined && data.precioUnitario !== null && data.precioUnitario !== '') {
      precioUnitario = Number(data.precioUnitario);
      if (Number.isNaN(precioUnitario) || precioUnitario < 0) {
        return { success: false, error: 'El precio unitario debe ser un número válido.' };
      }
    }

    const [refRows] = await pool.query(
      'SELECT descripcion, COALESCE(codigo, no_parte) AS codigo FROM refacciones WHERE id = ?',
      [refaccionId]
    );
    if (!refRows.length) return { success: false, error: 'No se encontró ese insumo en el catálogo de Refacciones.' };
    const insumoDescripcion = refRows[0].descripcion;
    const insumoCodigo = refRows[0].codigo || null;

    let insumoId;
    if (id) {
      await pool.query(
        `UPDATE insumos_solicitados
         SET refaccion_id = ?, insumo_descripcion = ?, insumo_codigo = ?, cantidad = ?, huerta = ?, encargado = ?, comentario = ?, precio_unitario = ?,
             modificado_por = ?, modificado_en = NOW()
         WHERE id = ?`,
        [refaccionId, insumoDescripcion, insumoCodigo, cantidad, huerta, encargado, comentario, precioUnitario, nombreUsuario, id]
      );
      insumoId = Number(id);
      await registrarAuditoria_('insumos_solicitados', insumoId, 'editar', nombreUsuario, insumoDescripcion + ' x' + cantidad + ' — ' + huerta);
    } else {
      const folio = await siguienteFolio_(pool, 'insumo', 'INS', 5);
      const [result] = await pool.query(
        `INSERT INTO insumos_solicitados
           (folio, refaccion_id, insumo_descripcion, insumo_codigo, cantidad, huerta, encargado, comentario, precio_unitario, estatus, capturado_por)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pendiente', ?)`,
        [folio, refaccionId, insumoDescripcion, insumoCodigo, cantidad, huerta, encargado, comentario, precioUnitario, nombreUsuario]
      );
      insumoId = result.insertId;
      await registrarAuditoria_('insumos_solicitados', insumoId, 'crear', nombreUsuario, insumoDescripcion + ' x' + cantidad + ' — ' + huerta);
    }
    return { success: true, id: insumoId };
  } catch (err) {
    return { success: false, error: err.toString() };
  }
}

// Autorizar una solicitud (nuevo paso opcional entre "pendiente" y
// "entregado"): alguien con acceso de captura a Insumos revisa la solicitud,
// le pone precio unitario a la pieza y la autoriza — queda registrado quién
// y cuándo (autorizado_por/autorizado_en), igual que entregado_por/en. Solo
// se puede autorizar desde "pendiente" (no tiene caso "re-autorizar" una que
// ya se autorizó o ya se entregó; si el precio estaba mal, se corrige desde
// el modal de Editar, que no toca el estatus). El precio es obligatorio
// aquí a propósito — autorizar sin precio no tendría sentido; si se quiere
// capturar el precio sin autorizar todavía, se hace desde Editar.
async function marcarInsumoAutorizado(code, nombreUsuario, id, precioUnitario) {
  await requierePermisoPanel_(code, nombreUsuario, 'insumos', 'capturar');
  try {
    const idNum = Number(id);
    if (!idNum) return { success: false, error: 'Falta el identificador de la solicitud.' };
    const precio = Number(precioUnitario);
    if (precioUnitario === undefined || precioUnitario === null || precioUnitario === '' || Number.isNaN(precio) || precio < 0) {
      return { success: false, error: 'Captura el precio unitario de la pieza para autorizar.' };
    }
    const [rows] = await pool.query('SELECT id, folio, estatus FROM insumos_solicitados WHERE id = ? AND eliminado = 0', [idNum]);
    if (!rows.length) return { success: false, error: 'No se encontró esa solicitud.' };
    if (rows[0].estatus !== 'pendiente') return { success: false, error: 'Solo se puede autorizar una solicitud que esté pendiente.' };
    await pool.query(
      "UPDATE insumos_solicitados SET estatus = 'autorizado', precio_unitario = ?, autorizado_por = ?, autorizado_en = NOW() WHERE id = ?",
      [precio, nombreUsuario, idNum]
    );
    await registrarAuditoria_('insumos_solicitados', idNum, 'editar', nombreUsuario, rows[0].folio + ' — autorizado a $' + precio.toFixed(2) + ' por pieza');
    return { success: true };
  } catch (err) {
    return { success: false, error: err.toString() };
  }
}

async function marcarInsumoEntregado(code, nombreUsuario, id) {
  await requierePermisoPanel_(code, nombreUsuario, 'insumos', 'capturar');
  try {
    const idNum = Number(id);
    if (!idNum) return { success: false, error: 'Falta el identificador de la solicitud.' };
    const [rows] = await pool.query('SELECT id, folio, estatus FROM insumos_solicitados WHERE id = ? AND eliminado = 0', [idNum]);
    if (!rows.length) return { success: false, error: 'No se encontró esa solicitud.' };
    if (rows[0].estatus === 'entregado') return { success: false, error: 'Esa solicitud ya estaba marcada como entregada.' };
    await pool.query(
      "UPDATE insumos_solicitados SET estatus = 'entregado', entregado_por = ?, entregado_en = NOW() WHERE id = ?",
      [nombreUsuario, idNum]
    );
    await registrarAuditoria_('insumos_solicitados', idNum, 'editar', nombreUsuario, rows[0].folio + ' — marcado como entregado');
    return { success: true };
  } catch (err) {
    return { success: false, error: err.toString() };
  }
}

// Revierte a "pendiente" desde cualquier otro estatus (autorizado o
// entregado) — limpia entregado_por/en si venía de entregado, pero
// DEJA intactos autorizado_por/autorizado_en/precio_unitario aunque venga
// de "autorizado": sirve como bitácora de que en algún momento sí se
// autorizó (y con qué precio), aunque ahora la solicitud vuelva a quedar
// pendiente (por ejemplo, si hay que revisarla de nuevo).
async function marcarInsumoPendiente(code, nombreUsuario, id) {
  await requierePermisoPanel_(code, nombreUsuario, 'insumos', 'capturar');
  try {
    const idNum = Number(id);
    if (!idNum) return { success: false, error: 'Falta el identificador de la solicitud.' };
    const [rows] = await pool.query('SELECT id, folio, estatus FROM insumos_solicitados WHERE id = ? AND eliminado = 0', [idNum]);
    if (!rows.length) return { success: false, error: 'No se encontró esa solicitud.' };
    if (rows[0].estatus === 'pendiente') return { success: false, error: 'Esa solicitud ya estaba pendiente.' };
    await pool.query(
      "UPDATE insumos_solicitados SET estatus = 'pendiente', entregado_por = NULL, entregado_en = NULL WHERE id = ?",
      [idNum]
    );
    await registrarAuditoria_('insumos_solicitados', idNum, 'editar', nombreUsuario, rows[0].folio + ' — marcado como pendiente');
    return { success: true };
  } catch (err) {
    return { success: false, error: err.toString() };
  }
}

async function eliminarInsumo(code, nombreUsuario, id) {
  await requierePermisoPanel_(code, nombreUsuario, 'insumos', 'capturar');
  try {
    const idNum = Number(id);
    if (!idNum) return { success: false, error: 'Falta el identificador de la solicitud.' };
    const [rows] = await pool.query('SELECT id, folio, eliminado FROM insumos_solicitados WHERE id = ?', [idNum]);
    if (!rows.length) return { success: false, error: 'No se encontró esa solicitud.' };
    if (rows[0].eliminado) return { success: false, error: 'Esa solicitud ya estaba eliminada.' };
    const eliminadoPor = (nombreUsuario || '').toString().trim() || null;
    await pool.query(
      'UPDATE insumos_solicitados SET eliminado = 1, eliminado_por = ?, eliminado_en = NOW() WHERE id = ?',
      [eliminadoPor, idNum]
    );
    await registrarAuditoria_('insumos_solicitados', idNum, 'eliminar', nombreUsuario, rows[0].folio);
    return { success: true };
  } catch (err) {
    return { success: false, error: err.toString() };
  }
}

async function restaurarInsumo(code, nombreUsuario, id) {
  await requierePermisoPanel_(code, nombreUsuario, 'insumos', 'capturar');
  try {
    const idNum = Number(id);
    if (!idNum) return { success: false, error: 'Falta el identificador de la solicitud.' };
    const [rows] = await pool.query('SELECT id, folio, eliminado FROM insumos_solicitados WHERE id = ?', [idNum]);
    if (!rows.length) return { success: false, error: 'No se encontró esa solicitud.' };
    if (!rows[0].eliminado) return { success: false, error: 'Esa solicitud no estaba eliminada.' };
    await pool.query('UPDATE insumos_solicitados SET eliminado = 0, eliminado_por = NULL, eliminado_en = NULL WHERE id = ?', [idNum]);
    await registrarAuditoria_('insumos_solicitados', idNum, 'restaurar', nombreUsuario, rows[0].folio);
    return { success: true };
  } catch (err) {
    return { success: false, error: err.toString() };
  }
}

// ---------------------------------------------------------------
// Refacciones NECESARIAS por orden (columna "Refaccionamiento" del Panel y
// de Taller): qué piezas hacen falta para atender una orden en particular.
// Se captura desde el Panel O desde Taller (mecánicos) — mismo criterio de
// permisos que actualizarOrden/editarOrden (requiereAccesoOrdenes_) — por
// texto escrito, por dictado (ya convertido a texto en el navegador, con el
// reconocimiento de voz de Chrome) o por foto. En los tres casos el texto
// (o la foto) se manda a interpretarRefaccionesTexto/Foto, que le pide a la
// IA que separe lo mencionado en piezas y las compare contra el catálogo ya
// dado de alta (ver getRefacciones). Lo que la IA regresa NO se guarda
// solo: el capturista lo revisa/corrige y confirma con
// guardarRefaccionesNecesarias. Si una pieza detectada no corresponde a
// ninguna ya dada de alta, se guarda como texto libre pendiente de
// catalogar; desde el Panel se puede dar de alta ahí mismo (ver
// guardarRefaccion) y volver a guardar la lista ya con el id ligado.
// ---------------------------------------------------------------

function promptInterpretarRefacciones_(listaCatalogoTexto) {
  return (
    'Te voy a dar un texto (escrito o dictado por un mecánico) que describe qué refacciones/piezas se ' +
    'necesitan para reparar una máquina agrícola. Sepáralo en una lista de piezas distintas y regresa ' +
    'ÚNICAMENTE un arreglo JSON (sin texto antes ni después, sin marcar código) con un objeto por cada ' +
    'pieza mencionada. Cada objeto debe tener EXACTAMENTE estas llaves:\n\n' +
    '- "texto": la pieza tal cual se entiende del texto original (ej. "filtro de aceite", "banda de ventilador"), ' +
    'corta y clara, sin relleno.\n' +
    '- "cantidad": el número de piezas si se menciona (ej. "dos filtros" -> 2), o null si no se menciona.\n' +
    '- "refaccionId": el número que aparece justo después de "ID " en el catálogo de abajo, para la refacción ya ' +
    'dada de alta que mejor corresponda a esa pieza, o null si ninguna corresponde con razonable seguridad ' +
    '(mejor null que una coincidencia dudosa). OJO: la descripción de una refacción puede empezar con un número ' +
    'de parte (por ejemplo "106225 FILTRO DE AIRE...") — ese número NO es el "refaccionId", el "refaccionId" es ' +
    'ÚNICAMENTE el número que sigue a "ID " al inicio de esa línea del catálogo.\n\n' +
    'Catálogo de refacciones ya dadas de alta (una por línea, formato "ID <numero>: <descripción> — No. de parte: <no. de parte>"):\n' +
    listaCatalogoTexto +
    '\n\nResponde SOLO con el arreglo JSON, nada más.'
  );
}

async function catalogoRefaccionesParaPrompt_() {
  const [rows] = await pool.query('SELECT id, descripcion, no_parte FROM refacciones ORDER BY descripcion');
  const texto =
    rows.length === 0
      ? '(todavía no hay ninguna refacción dada de alta en el catálogo)'
      : rows.map((r) => 'ID ' + r.id + ': ' + r.descripcion + (r.no_parte ? ' — No. de parte: ' + r.no_parte : '')).join('\n');
  return { rows, texto };
}

// Normaliza texto para comparaciones tolerantes a mayúsculas/acentos/espacios
// (mismo criterio simple en ambos lados: minúsculas, sin acentos, un solo
// espacio entre palabras).
function normalizarTextoComparable_(s) {
  return (s || '')
    .toString()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

// Si la IA no encontró (o se equivocó de) refaccionId, intenta un respaldo
// local: buscar en el catálogo una refacción cuya descripción o no. de parte
// coincida, exacta o casi exacta, con el texto detectado. Es intencionalmente
// conservador (solo actúa si hay una única coincidencia clara) para no
// vincular piezas por error — ante la duda, se deja pendiente de catalogar
// como antes.
function buscarCoincidenciaLocal_(texto, rows) {
  const norm = normalizarTextoComparable_(texto);
  if (!norm) return null;

  const exactas = rows.filter((r) => {
    const desc = normalizarTextoComparable_(r.descripcion);
    const parte = normalizarTextoComparable_(r.no_parte);
    return desc === norm || (parte && parte === norm);
  });
  if (exactas.length === 1) return exactas[0].id;
  if (exactas.length > 1) return null; // ambiguo, mejor no adivinar

  // Coincidencia parcial: el texto detectado aparece completo dentro de la
  // descripción del catálogo (o viceversa), y es suficientemente específico
  // (evita que palabras cortas/genéricas como "filtro" liguen de más).
  if (norm.length >= 6) {
    const parciales = rows.filter((r) => {
      const desc = normalizarTextoComparable_(r.descripcion);
      return desc && (desc.indexOf(norm) !== -1 || norm.indexOf(desc) !== -1);
    });
    if (parciales.length === 1) return parciales[0].id;
  }
  return null;
}

function normalizarItemsInterpretados_(itemsCrudos, rows) {
  if (!Array.isArray(itemsCrudos)) return [];
  const idsValidos = new Set(rows.map((r) => r.id));
  return itemsCrudos
    .map((it) => {
      it = it || {};
      const texto = (it.texto || '').toString().trim();
      if (!texto) return null;
      const cantidad = it.cantidad === null || it.cantidad === undefined || it.cantidad === '' ? null : Number(it.cantidad);
      let refaccionId = it.refaccionId === null || it.refaccionId === undefined || it.refaccionId === '' ? null : Number(it.refaccionId);
      if (refaccionId !== null && (isNaN(refaccionId) || !idsValidos.has(refaccionId))) refaccionId = null;
      if (refaccionId === null) refaccionId = buscarCoincidenciaLocal_(texto, rows);
      return {
        texto,
        // Si no se menciona cuántas piezas se necesitan, se asume 1 (mismo
        // criterio que la captura manual y el guardado final).
        cantidad: cantidad !== null && !isNaN(cantidad) && cantidad > 0 ? cantidad : 1,
        refaccionId,
      };
    })
    .filter(Boolean);
}

async function interpretarRefaccionesTexto(code, nombreUsuario, orden, texto) {
  await requiereAccesoOrdenSeccionPorFolio_(code, nombreUsuario, orden, 'capturar');
  const textoLimpio = (texto || '').toString().trim();
  if (!textoLimpio) return { success: false, error: 'No se recibió ningún texto.' };

  const { rows, texto: listaCatalogoTexto } = await catalogoRefaccionesParaPrompt_();
  const prompt = promptInterpretarRefacciones_(listaCatalogoTexto) + '\n\nTexto a interpretar:\n' + textoLimpio;

  const textoRespuesta = await preguntarleAClaudeTexto_(prompt);
  const items = normalizarItemsInterpretados_(extraerJson_(textoRespuesta), rows);
  if (items.length === 0) {
    return { success: false, error: 'No se detectó ninguna refacción en el texto. Intenta ser más específico.' };
  }
  return { success: true, items };
}

async function interpretarRefaccionesFoto(code, nombreUsuario, orden, fotoDataUrl) {
  await requiereAccesoOrdenSeccionPorFolio_(code, nombreUsuario, orden, 'capturar');
  if (!fotoDataUrl) return { success: false, error: 'No se recibió ninguna foto.' };

  const { rows, texto: listaCatalogoTexto } = await catalogoRefaccionesParaPrompt_();
  const prompt =
    'Esta es una foto (una nota escrita a mano, la etiqueta de una pieza, o la pieza misma) que muestra qué ' +
    'refacciones/piezas se necesitan para reparar una máquina agrícola. ' +
    promptInterpretarRefacciones_(listaCatalogoTexto);

  const textoRespuesta = await preguntarleAClaudeSobreImagen_(fotoDataUrl, prompt);
  const items = normalizarItemsInterpretados_(extraerJson_(textoRespuesta), rows);
  if (items.length === 0) {
    return { success: false, error: 'No se detectó ninguna refacción en la foto. Verifica que se vea clara, e inténtalo de nuevo.' };
  }
  return { success: true, items };
}

// Lo que ya se guardó para la orden, más — solo si todavía no hay nada
// guardado Y la orden viene de una regla de Mantenimiento preventivo — las
// refacciones que esa regla trae asociadas (mantenimiento_regla_refacciones),
// como sugerencia ya precargada para ese equipo y ese preventivo: el
// capturista las ve listas en el modal y decide si las deja, las quita o
// agrega más; no se guardan solas hasta que él confirme con
// guardarRefaccionesNecesarias.
async function getRefaccionesNecesarias(code, nombreUsuario, orden) {
  await requiereAccesoOrdenSeccionPorFolio_(code, nombreUsuario, orden, 'visualizar');

  const [guardadas] = await pool.query(
    `SELECT n.id AS Id, n.refaccion_id AS RefaccionId, n.texto_libre AS TextoLibre, n.cantidad AS Cantidad,
            n.origen AS Origen, n.capturado_por AS CapturadoPor,
            n.entregado AS Entregado, n.entregado_por AS EntregadoPor, n.entregado_en AS EntregadoEn,
            r.no_parte AS RefaccionNoParte, r.descripcion AS RefaccionDescripcion
     FROM reportes_refacciones_necesarias n
     LEFT JOIN refacciones r ON r.id = n.refaccion_id
     WHERE n.orden = ?
     ORDER BY n.id`,
    [orden]
  );

  // Mismo formato "No. de parte - Descripción" que se usa en todo el resto
  // del Panel (catálogo de Refacciones, selects de refacción, etc.) cuando
  // la pieza sí está ligada al catálogo — así también se ve el no. de
  // parte en la lista de "piezas", no solo la descripción.
  const items = guardadas.map((n) => ({
    id: n.Id,
    refaccionId: n.RefaccionId || null,
    texto: n.RefaccionId ? ((n.RefaccionNoParte ? n.RefaccionNoParte + ' - ' : '') + n.RefaccionDescripcion) : (n.TextoLibre || ''),
    cantidad: n.Cantidad !== null && n.Cantidad !== undefined ? Number(n.Cantidad) : null,
    origen: n.Origen || '',
    capturadoPor: n.CapturadoPor || '',
    entregado: !!n.Entregado,
    entregadoPor: n.EntregadoPor || '',
    entregadoEn: n.EntregadoEn || null,
  }));

  let sugeridas = [];
  if (items.length === 0) {
    const [reglaRows] = await pool.query('SELECT regla_id FROM mantenimiento_ordenes WHERE orden = ?', [orden]);
    if (reglaRows.length > 0) {
      const [refRows] = await pool.query(
        `SELECT r.id AS RefaccionId, r.no_parte AS NoParte, r.descripcion AS Descripcion, mrr.cantidad AS Cantidad
         FROM mantenimiento_regla_refacciones mrr
         JOIN refacciones r ON r.id = mrr.refaccion_id
         WHERE mrr.regla_id = ?
         ORDER BY r.descripcion`,
        [reglaRows[0].regla_id]
      );
      sugeridas = refRows.map((r) => ({
        refaccionId: r.RefaccionId,
        texto: (r.NoParte ? r.NoParte + ' - ' : '') + r.Descripcion,
        cantidad: r.Cantidad !== null && r.Cantidad !== undefined ? Number(r.Cantidad) : 1,
        origen: 'preventivo',
      }));

      const [reglaAceite] = await pool.query('SELECT aceite_litros FROM mantenimiento_reglas WHERE id = ?', [reglaRows[0].regla_id]);
      if (reglaAceite.length > 0 && reglaAceite[0].aceite_litros) {
        sugeridas.push({
          refaccionId: null,
          texto: 'Aceite',
          cantidad: Number(reglaAceite[0].aceite_litros),
          origen: 'preventivo',
        });
      }
    }
  }

  return { items, sugeridas };
}

// Reemplaza la lista completa de refacciones necesarias de una orden (más
// simple y sin ambigüedad que calcular la diferencia exacta contra lo que
// ya había — mismo criterio que refacciones_modelos en guardarRefaccion).
async function guardarRefaccionesNecesarias(code, nombreUsuario, orden, items) {
  const [ordenRows] = await pool.query('SELECT orden, es_soldadura, es_automotriz, es_llantas, es_terceros FROM reportes WHERE orden = ?', [orden]);
  if (ordenRows.length === 0) return { success: false, error: 'No se encontró la orden ' + orden + '.' };
  await requiereAccesoOrdenes_(code, nombreUsuario, 'capturar', permisoDeSeccionOrden_(seccionDeFila_(ordenRows[0])));
  items = Array.isArray(items) ? items : [];

  const capturadoPor = (nombreUsuario || '').toString().trim() || null;
  const limpios = items
    .map((it) => {
      it = it || {};
      const refaccionId =
        it.refaccionId === null || it.refaccionId === undefined || it.refaccionId === '' ? null : Number(it.refaccionId);
      const textoLibre = refaccionId ? null : (it.texto || '').toString().trim() || null;
      if (!refaccionId && !textoLibre) return null;
      const cantidad = it.cantidad === null || it.cantidad === undefined || it.cantidad === '' ? null : Number(it.cantidad);
      const origen = (it.origen || 'manual').toString().trim().slice(0, 20);
      // Si no se capturó cantidad (o llegó inválida) se guarda como 1 — nunca
      // en blanco, para no perder piezas al sumar cantidades después (ver
      // el acumulado de refaccionamiento por orden).
      const cantidadFinal = cantidad !== null && !isNaN(cantidad) && cantidad > 0 ? cantidad : 1;
      // El cliente manda de vuelta lo que ya traía cargado de getRefaccionesNecesarias
      // (incluyendo si ya estaba marcada "Entregado" — ver marcarRefaccionNecesariaEntregada/
      // Pendiente más abajo) para que no se pierda al reemplazar toda la lista.
      const entregado = it.entregado ? 1 : 0;
      const entregadoPor = entregado ? ((it.entregadoPor || '').toString().trim() || null) : null;
      const entregadoEn = entregado && it.entregadoEn ? new Date(it.entregadoEn) : null;
      return [orden, refaccionId, textoLibre, cantidadFinal, origen, capturadoPor, entregado, entregadoPor, entregadoEn];
    })
    .filter(Boolean);

  await pool.query('DELETE FROM reportes_refacciones_necesarias WHERE orden = ?', [orden]);
  if (limpios.length > 0) {
    await pool.query(
      'INSERT INTO reportes_refacciones_necesarias (orden, refaccion_id, texto_libre, cantidad, origen, capturado_por, entregado, entregado_por, entregado_en) VALUES ?',
      [limpios]
    );
  }

  await agregarObservacionOrden_(
    orden,
    (capturadoPor || 'Alguien') +
      ' actualizó la lista de refacciones necesarias (' +
      limpios.length +
      (limpios.length === 1 ? ' pieza).' : ' piezas).')
  );

  return { success: true, cantidad: limpios.length };
}

// Costo total de la reparación (columna reportes.costo_reparacion) —
// capturado desde el mismo modal de Refaccionamiento, junto al listado de
// piezas necesarias de arriba (no lo reemplaza, son cosas independientes).
// Pensado sobre todo para Llantas y Ponches / Reparaciones con terceros,
// pero no se restringe por sección: cualquier orden puede tener un costo.
async function guardarCostoReparacion(code, nombreUsuario, orden, costo) {
  const [ordenRows] = await pool.query('SELECT orden, es_soldadura, es_automotriz, es_llantas, es_terceros FROM reportes WHERE orden = ?', [orden]);
  if (ordenRows.length === 0) return { success: false, error: 'No se encontró la orden ' + orden + '.' };
  await requiereAccesoOrdenes_(code, nombreUsuario, 'capturar', permisoDeSeccionOrden_(seccionDeFila_(ordenRows[0])));

  let costoFinal = null;
  if (costo !== null && costo !== undefined && costo !== '') {
    const costoNum = Number(costo);
    if (isNaN(costoNum) || costoNum < 0) return { success: false, error: 'El costo debe ser un número de 0 o más.' };
    costoFinal = costoNum;
  }

  await pool.query('UPDATE reportes SET costo_reparacion = ? WHERE orden = ?', [costoFinal, orden]);
  await agregarObservacionOrden_(
    orden,
    (nombreUsuario || 'Alguien') + ' ' + (costoFinal === null ? 'quitó el costo de la reparación.' : 'capturó el costo de la reparación: $' + costoFinal.toFixed(2) + '.')
  );
  return { success: true };
}

// Marca/quita la marca de "Entregado" de UNA pieza ya guardada en la lista
// de refacciones necesarias de una orden (columna Refaccionamiento). Es
// independiente de guardarRefaccionesNecesarias (que reemplaza la lista
// completa) — actúa de una vez sobre ese renglón, mismo criterio que
// marcarInsumoEntregado/marcarInsumoPendiente en Insumos, para no obligar a
// abrir "Guardar lista" solo para marcar una pieza como entregada.
async function marcarRefaccionNecesariaEntregada(code, nombreUsuario, id) {
  const idNum = Number(id);
  if (!idNum) return { success: false, error: 'Falta el identificador de la pieza.' };
  const [rows] = await pool.query('SELECT id, orden FROM reportes_refacciones_necesarias WHERE id = ?', [idNum]);
  if (!rows.length) return { success: false, error: 'No se encontró esa pieza.' };
  await requiereAccesoOrdenSeccionPorFolio_(code, nombreUsuario, rows[0].orden, 'capturar');
  await pool.query(
    'UPDATE reportes_refacciones_necesarias SET entregado = 1, entregado_por = ?, entregado_en = NOW() WHERE id = ?',
    [nombreUsuario, idNum]
  );
  await agregarObservacionOrden_(rows[0].orden, (nombreUsuario || 'Alguien') + ' marcó una pieza de refaccionamiento como entregada.');
  return { success: true };
}

async function marcarRefaccionNecesariaPendiente(code, nombreUsuario, id) {
  const idNum = Number(id);
  if (!idNum) return { success: false, error: 'Falta el identificador de la pieza.' };
  const [rows] = await pool.query('SELECT id, orden FROM reportes_refacciones_necesarias WHERE id = ?', [idNum]);
  if (!rows.length) return { success: false, error: 'No se encontró esa pieza.' };
  await requiereAccesoOrdenSeccionPorFolio_(code, nombreUsuario, rows[0].orden, 'capturar');
  await pool.query(
    'UPDATE reportes_refacciones_necesarias SET entregado = 0, entregado_por = NULL, entregado_en = NULL WHERE id = ?',
    [idNum]
  );
  await agregarObservacionOrden_(rows[0].orden, (nombreUsuario || 'Alguien') + ' quitó la marca de entregado de una pieza de refaccionamiento.');
  return { success: true };
}

// ---------------------------------------------------------------
// Categorías de refacciones (apartado dentro de la pestaña "Refacciones").
// El selector de aceite en Mantenimiento se guía por la categoría llamada
// exactamente "Aceite" (ver getRefaccionesPorCategoria_ más abajo si se
// llegara a necesitar en otro lado; por ahora el filtro vive en el
// frontend, igual que ya pasaba con el heurístico anterior).
// ---------------------------------------------------------------

async function getCategorias(code, nombreUsuario) {
  await requierePermisoPanel_(code, nombreUsuario, 'refacciones', 'visualizar');
  const [rows] = await pool.query(`
    SELECT id AS Id, nombre AS Nombre
    FROM categorias_refacciones
    ORDER BY nombre
  `);
  return rows.map((r) => ({ Id: r.Id, Nombre: r.Nombre }));
}

async function guardarCategoria(code, nombreUsuario, id, data) {
  await requierePermisoPanel_(code, nombreUsuario, 'refacciones', 'capturar');
  data = data || {};
  try {
    const nombre = (data.nombre || '').toString().trim();
    if (!nombre) return { success: false, error: 'Escribe el nombre de la categoría.' };

    if (id) {
      await pool.query('UPDATE categorias_refacciones SET nombre=? WHERE id=?', [nombre, id]);
      return { success: true, id: Number(id) };
    }

    const [result] = await pool.query('INSERT INTO categorias_refacciones (nombre) VALUES (?)', [nombre]);
    return { success: true, id: result.insertId };
  } catch (err) {
    // Nombre duplicado (UNIQUE KEY uq_categoria_nombre) u otro error de datos.
    if (err && err.code === 'ER_DUP_ENTRY') {
      return { success: false, error: 'Ya existe una categoría con ese nombre.' };
    }
    return { success: false, error: err.toString() };
  }
}

async function eliminarCategoria(code, nombreUsuario, id) {
  await requierePermisoPanel_(code, nombreUsuario, 'refacciones', 'capturar');
  await pool.query('UPDATE refacciones SET categoria_id = NULL WHERE categoria_id = ?', [id]);
  await pool.query('DELETE FROM categorias_refacciones WHERE id = ?', [id]);
  return { success: true };
}

// ---------------------------------------------------------------
// Marcas y modelos compatibles de refacciones (apartado dentro de la
// pestaña "Refacciones"). Cada refacción tiene una marca y puede ser
// compatible con varios modelos de esa marca (ver getRefacciones/
// guardarRefaccion, que leen y escriben refacciones.marca_id y la tabla
// refacciones_modelos).
// ---------------------------------------------------------------

// ---------------------------------------------------------------
// Catálogos simples de Huertas, Departamentos y Tipos de unidad (pestaña
// Catálogo → "Catálogos"). Antes eran listas fijas en el código del Panel
// (el arreglo HUERTAS, los botones CAMPO/COSECHA/..., el texto libre de
// "Tipo de unidad") — ahora viven en su propia tabla para que se puedan
// dar de alta/editar/borrar sin tener que pedirle a un programador que
// toque el código cada vez (como pasó con TALLER/CARIGEN/LIMONES).
//
// Huerta/Departamento/TipoUnidad se SIGUEN guardando como texto libre en
// maquinaria/movimientos_maquinaria/diesel/diesel_entregas — estas tablas
// solo alimentan los desplegables. No hay llave foránea hacia ellas, así
// que "eliminar" un valor del catálogo nunca borra ni desliga datos ya
// capturados con ese valor; solo deja de aparecer como opción para
// capturas nuevas.
// ---------------------------------------------------------------
const PESTANAS_CATALOGO_OPERATIVO_ = ['maquinaria', 'catalogo'];

function fabricaCatalogoSimple_(tabla, etiqueta) {
  return {
    async get(code, nombreUsuario) {
      await requierePermisoPanel_(code, nombreUsuario, PESTANAS_CATALOGO_OPERATIVO_, 'visualizar');
      const [rows] = await pool.query('SELECT id AS Id, nombre AS Nombre FROM ' + tabla + ' ORDER BY nombre');
      return rows.map((r) => ({ Id: r.Id, Nombre: r.Nombre }));
    },
    async guardar(code, nombreUsuario, id, data) {
      await requierePermisoPanel_(code, nombreUsuario, PESTANAS_CATALOGO_OPERATIVO_, 'capturar');
      data = data || {};
      try {
        const nombre = (data.nombre || '').toString().trim();
        if (!nombre) return { success: false, error: 'Escribe el nombre de ' + etiqueta + '.' };
        if (id) {
          await pool.query('UPDATE ' + tabla + ' SET nombre=? WHERE id=?', [nombre, id]);
          return { success: true, id: Number(id) };
        }
        const [result] = await pool.query('INSERT INTO ' + tabla + ' (nombre) VALUES (?)', [nombre]);
        return { success: true, id: result.insertId };
      } catch (err) {
        if (err && err.code === 'ER_DUP_ENTRY') {
          return { success: false, error: 'Ya existe ' + etiqueta + ' con ese nombre.' };
        }
        return { success: false, error: err.toString() };
      }
    },
    async eliminar(code, nombreUsuario, id) {
      await requierePermisoPanel_(code, nombreUsuario, PESTANAS_CATALOGO_OPERATIVO_, 'capturar');
      await pool.query('DELETE FROM ' + tabla + ' WHERE id = ?', [id]);
      return { success: true };
    },
  };
}

const catalogoHuertas_ = fabricaCatalogoSimple_('huertas', 'la huerta');
const catalogoDepartamentos_ = fabricaCatalogoSimple_('departamentos', 'el departamento');
const catalogoTiposUnidad_ = fabricaCatalogoSimple_('tipos_unidad', 'el tipo de unidad');
const catalogoEmpresas_ = fabricaCatalogoSimple_('empresas', 'la empresa');
const catalogoProveedoresCombustible_ = fabricaCatalogoSimple_('proveedores_combustible', 'el proveedor');
// Operadores: igual patrón que Departamentos/Tipos de unidad — alimenta el
// desplegable de "Operador" al capturar diesel (diesel.operador) y el de
// "Operador asignado" en el catálogo de Maquinaria (maquinaria.operador_asignado).
const catalogoOperadores_ = fabricaCatalogoSimple_('operadores', 'el operador');

// Huertas ya NO es un catálogo simple puro — además de nombre, se le puede
// asignar una Empresa y un Proveedor (de los catálogos de abajo), guardados
// como empresa_id/proveedor_id (relación entre catálogos, igual que
// modelos_refacciones.marca_id) — así que get/guardar tienen su propia
// implementación en vez de usar fabricaCatalogoSimple_ (eliminar sí la
// sigue usando, no cambia).
async function getHuertasCatalogo(code, nombreUsuario) {
  await requierePermisoPanel_(code, nombreUsuario, PESTANAS_CATALOGO_OPERATIVO_, 'visualizar');
  const [rows] = await pool.query(`
    SELECT h.id AS Id, h.nombre AS Nombre, h.empresa_id AS EmpresaId, e.nombre AS EmpresaNombre,
           h.proveedor_id AS ProveedorId, p.nombre AS ProveedorNombre, h.mapa_url AS MapaUrl
    FROM huertas h
    LEFT JOIN empresas e ON e.id = h.empresa_id
    LEFT JOIN proveedores_combustible p ON p.id = h.proveedor_id
    ORDER BY h.nombre
  `);
  return rows.map((r) => ({
    Id: r.Id,
    Nombre: r.Nombre,
    EmpresaId: r.EmpresaId,
    EmpresaNombre: r.EmpresaNombre,
    ProveedorId: r.ProveedorId,
    ProveedorNombre: r.ProveedorNombre,
    MapaUrl: r.MapaUrl,
  }));
}

async function guardarHuerta(code, nombreUsuario, id, data) {
  await requierePermisoPanel_(code, nombreUsuario, PESTANAS_CATALOGO_OPERATIVO_, 'capturar');
  data = data || {};
  try {
    const nombre = (data.nombre || '').toString().trim();
    if (!nombre) return { success: false, error: 'Escribe el nombre de la huerta.' };
    // Empresa/Proveedor son opcionales — no todas las huertas necesitan
    // tener una asignada.
    const empresaId = (data.empresaId === '' || data.empresaId === undefined || data.empresaId === null)
      ? null : Number(data.empresaId);
    const proveedorId = (data.proveedorId === '' || data.proveedorId === undefined || data.proveedorId === null)
      ? null : Number(data.proveedorId);
    if (id) {
      await pool.query('UPDATE huertas SET nombre=?, empresa_id=?, proveedor_id=? WHERE id=?', [nombre, empresaId, proveedorId, id]);
      return { success: true, id: Number(id) };
    }
    const [result] = await pool.query(
      'INSERT INTO huertas (nombre, empresa_id, proveedor_id) VALUES (?, ?, ?)',
      [nombre, empresaId, proveedorId]
    );
    return { success: true, id: result.insertId };
  } catch (err) {
    if (err && err.code === 'ER_DUP_ENTRY') {
      return { success: false, error: 'Ya existe la huerta con ese nombre.' };
    }
    return { success: false, error: err.toString() };
  }
}

async function eliminarHuerta(code, nombreUsuario, id) { return catalogoHuertas_.eliminar(code, nombreUsuario, id); }

// ---------------------------------------------------------------
// Avance de huerta: pestaña nueva en el celular (Index.html) donde el
// operador marca, en vivo sobre un mapa, su recorrido por la huerta. Ver
// el comentario largo en db/schema.sql (junto a "ALTER TABLE huertas ADD
// COLUMN mapa_url") para el flujo completo (subir mapa -> calibrar ->
// iniciar/terminar avance).
// ---------------------------------------------------------------

// Sube/reemplaza la imagen del mapa de una huerta (acción del Panel,
// Catálogo → Huertas). Upsert por nombre: si la huerta todavía no existe
// como fila en el catálogo (puede pasar -- las 14 huertas del celular son
// una lista fija en el HTML, no siempre dadas de alta aquí), se crea. Subir
// una imagen nueva SIEMPRE borra la calibración anterior (mapa_cal1_*/
// mapa_cal2_*) -- una calibración vieja ya no tiene sentido sobre una
// imagen distinta, y dejarla puesta pintaría los puntos en el lugar
// equivocado sin que nadie se diera cuenta.
async function guardarImagenMapaHuerta(code, nombreUsuario, huerta, imagenDataUrl) {
  await requierePermisoPanel_(code, nombreUsuario, 'avance_huerta', 'capturar');
  const nombreHuerta = (huerta || '').toString().trim();
  if (!nombreHuerta) return { success: false, error: 'Falta indicar la huerta.' };
  if (!imagenDataUrl) return { success: false, error: 'Falta la imagen del mapa.' };
  try {
    const mapaUrl = await guardarArchivo_(imagenDataUrl);
    await pool.query(
      `INSERT INTO huertas (nombre, mapa_url)
       VALUES (?, ?)
       ON DUPLICATE KEY UPDATE
         mapa_url = VALUES(mapa_url),
         mapa_cal1_x = NULL, mapa_cal1_y = NULL, mapa_cal1_lat = NULL, mapa_cal1_lng = NULL,
         mapa_cal2_x = NULL, mapa_cal2_y = NULL, mapa_cal2_lat = NULL, mapa_cal2_lng = NULL`,
      [nombreHuerta, mapaUrl]
    );
    return { success: true, mapaUrl };
  } catch (err) {
    return { success: false, error: err.toString() };
  }
}

// Abierta (sin permiso especial): la usan tanto Index.html (para saber qué
// mostrar en la pestaña Avance de huerta) como el Panel (para el visor).
async function getMapaHuerta(huerta) {
  const nombreHuerta = (huerta || '').toString().trim();
  if (!nombreHuerta) return { mapaUrl: null, calibrado: false };
  const [rows] = await pool.query(
    'SELECT mapa_url, mapa_cal1_x, mapa_cal1_y, mapa_cal1_lat, mapa_cal1_lng, mapa_cal2_x, mapa_cal2_y, mapa_cal2_lat, mapa_cal2_lng FROM huertas WHERE LOWER(TRIM(nombre)) = LOWER(TRIM(?))',
    [nombreHuerta]
  );
  if (rows.length === 0 || !rows[0].mapa_url) return { mapaUrl: null, calibrado: false };
  const r = rows[0];
  const calibrado = [r.mapa_cal1_x, r.mapa_cal1_y, r.mapa_cal1_lat, r.mapa_cal1_lng, r.mapa_cal2_x, r.mapa_cal2_y, r.mapa_cal2_lat, r.mapa_cal2_lng]
    .every((v) => v !== null && v !== undefined);
  return {
    mapaUrl: r.mapa_url,
    calibrado,
    cal1: calibrado ? { x: Number(r.mapa_cal1_x), y: Number(r.mapa_cal1_y), lat: Number(r.mapa_cal1_lat), lng: Number(r.mapa_cal1_lng) } : null,
    cal2: calibrado ? { x: Number(r.mapa_cal2_x), y: Number(r.mapa_cal2_y), lat: Number(r.mapa_cal2_lat), lng: Number(r.mapa_cal2_lng) } : null,
  };
}

// Calibración (desde el celular, caminando a los 2 puntos -- ver
// requierePermisoAvanceHuerta_ más arriba). cal1/cal2: {x, y, lat, lng},
// con x/y como fracción (0-1) del ANCHO de la imagen para los dos ejes
// (ver comentario en schema.sql). Se valida que los 2 puntos no queden
// prácticamente en el mismo lugar (ni en la imagen ni en GPS real) -- con
// 2 puntos iguales no se puede calcular ninguna transformación.
async function guardarCalibracionMapaHuerta(nombreUsuario, huerta, cal1, cal2) {
  await requierePermisoAvanceHuerta_(nombreUsuario, 'capturar');
  const nombreHuerta = (huerta || '').toString().trim();
  if (!nombreHuerta) return { success: false, error: 'Falta indicar la huerta.' };
  const numeros = [cal1 && cal1.x, cal1 && cal1.y, cal1 && cal1.lat, cal1 && cal1.lng, cal2 && cal2.x, cal2 && cal2.y, cal2 && cal2.lat, cal2 && cal2.lng];
  if (numeros.some((v) => typeof v !== 'number' || Number.isNaN(v))) {
    return { success: false, error: 'Faltan datos de los 2 puntos de calibración.' };
  }
  const distanciaPixeles = Math.hypot(cal2.x - cal1.x, cal2.y - cal1.y);
  const distanciaGpsGrados = Math.hypot(cal2.lat - cal1.lat, cal2.lng - cal1.lng);
  if (distanciaPixeles < 0.02) {
    return { success: false, error: 'Los 2 puntos que marcaste en la imagen están casi en el mismo lugar. Elige 2 puntos bien separados.' };
  }
  if (distanciaGpsGrados < 0.00005) {
    return { success: false, error: 'Los 2 puntos de GPS capturados están casi en el mismo lugar. Camina a un punto bien separado del otro antes de capturar.' };
  }
  const [rows] = await pool.query('SELECT mapa_url FROM huertas WHERE LOWER(TRIM(nombre)) = LOWER(TRIM(?))', [nombreHuerta]);
  if (rows.length === 0 || !rows[0].mapa_url) {
    return { success: false, error: 'Esta huerta todavía no tiene un mapa subido. Pide que lo suban primero desde el Panel (Catálogo → Huertas).' };
  }
  await pool.query(
    `UPDATE huertas SET
       mapa_cal1_x = ?, mapa_cal1_y = ?, mapa_cal1_lat = ?, mapa_cal1_lng = ?,
       mapa_cal2_x = ?, mapa_cal2_y = ?, mapa_cal2_lat = ?, mapa_cal2_lng = ?
     WHERE LOWER(TRIM(nombre)) = LOWER(TRIM(?))`,
    [cal1.x, cal1.y, cal1.lat, cal1.lng, cal2.x, cal2.y, cal2.lat, cal2.lng, nombreHuerta]
  );
  return { success: true };
}

// A partir de aquí, las 4 funciones del recorrido en sí (iniciar/agregar
// punto/terminar/consultar) son abiertas -- mismo nivel de confianza que
// submitReporte: basta con haber iniciado sesión en el celular, sin pedir
// ningún permiso de Panel. Cualquier operador con acceso a esa huerta para
// Reportar puede marcar su propio avance ahí.
// La versión vieja de la pantalla de Avance del celular hacía elegir
// "CUADRO 30 — CANALERA" (cuadro + actividad) en vez de solo la actividad
// ("CANALERA"). Un celular que abre la app SIN señal en la huerta carga la
// copia guardada (ver public/sw.js) y puede seguir mandando ese formato
// viejo -- y los recorridos ya guardados así salían como opciones aparte
// en el filtro "Actividad" del mapa del Panel (petición de Carlos,
// oct-2026). Esto deja siempre solo la actividad, al guardar y al leer.
function normalizarTrabajoAvance_(trabajo) {
  const t = (trabajo === null || trabajo === undefined) ? '' : trabajo.toString().trim();
  if (!t) return null;
  const m = t.match(/^CUADRO\s+.+?\s+[—–]\s+(.+)$/i); // solo guion largo, el que usaba la app vieja
  return (m ? m[1].trim() : t) || null;
}

// ¿El recorrido es de ESTA actividad? (oct-2026, Carlos: "me marca completa
// la canalera en el cuadro 05 cuando viendo en el avance de canalera no
// aparece completado ese cuadro"). Antes cualquier recorrido -- una PRIMERA
// RASTRA, un DESVARE -- sumaba pasadas a TODAS las actividades pendientes
// del cuadro por el que pasaba. Ahora un recorrido solo cuenta para la
// actividad que el operador eligió al iniciarlo (sin importar mayúsculas ni
// el "CUADRO X —" de la app vieja). Un recorrido sin actividad no cuenta
// para ninguna.
function mismoTrabajoAvance_(trabajoRecorrido, trabajoActividad) {
  const a = normalizarTrabajoAvance_(trabajoRecorrido);
  const b = normalizarTrabajoAvance_(trabajoActividad);
  return !!a && !!b && a.toLowerCase() === b.toLowerCase();
}

async function iniciarAvance(huerta, nombre, trabajo, porcentaje, codigoUnidad) {
  const nombreHuerta = (huerta || '').toString().trim();
  const nombrePersona = (nombre || '').toString().trim();
  if (!nombreHuerta) return { success: false, error: 'Falta indicar la huerta.' };
  if (!nombrePersona) return { success: false, error: 'Falta indicar quién reporta.' };
  const porcentajeNum = (porcentaje === '' || porcentaje === undefined || porcentaje === null) ? null : Number(porcentaje);
  if (porcentajeNum !== null && (Number.isNaN(porcentajeNum) || porcentajeNum < 0 || porcentajeNum > 100)) {
    return { success: false, error: 'El porcentaje debe ser un número entre 0 y 100.' };
  }
  // codigoUnidad: con qué equipo (tractor) se hace este recorrido -- se usa
  // para saber si debe acreditarle avance a una actividad planificada con
  // un equipo específico (ver marcarCuadrosCompletadosPorPunto_). Queda
  // opcional a nivel servidor (el celular ya lo pide como obligatorio en
  // esta pantalla, pero una versión vieja de la app que no lo mande no debe
  // tronar).
  try {
    const trabajoNorm = normalizarTrabajoAvance_(trabajo);
    const unidad = (codigoUnidad || '').toString().trim() || null;
    // El celular reintenta solo si no le llegó la respuesta (señal débil).
    // Si el primer intento SÍ llegó y se guardó, no se crea un segundo
    // registro: se regresa el mismo avance abierto hace menos de 3 minutos
    // por la misma persona, con la misma actividad y equipo, y sin puntos.
    const [abiertos] = await pool.query(
      `SELECT a.id FROM avance_huerta a
        WHERE a.huerta = ? AND a.nombre = ? AND a.fecha_fin IS NULL
          AND a.trabajo <=> ? AND a.codigo_unidad <=> ?
          AND a.fecha_inicio >= NOW() - INTERVAL ${AVANCE_REINTENTO_MINUTOS} MINUTE
          AND NOT EXISTS (SELECT 1 FROM avance_huerta_puntos p WHERE p.avance_id = a.id)
        ORDER BY a.id DESC LIMIT 1`,
      [nombreHuerta, nombrePersona, trabajoNorm, unidad]
    );
    if (abiertos.length > 0) return { success: true, avanceId: abiertos[0].id, reutilizado: true };
    const [result] = await pool.query(
      'INSERT INTO avance_huerta (huerta, nombre, trabajo, porcentaje, fecha_inicio, codigo_unidad) VALUES (?, ?, ?, ?, NOW(), ?)',
      [nombreHuerta, nombrePersona, trabajoNorm, porcentajeNum, unidad]
    );
    avisos.avisarRecorrido_('inicio', result.insertId); // por fuera: no frena la respuesta
    return { success: true, avanceId: result.insertId };
  } catch (err) {
    console.error('[iniciarAvance] huerta=' + nombreHuerta + ' nombre=' + nombrePersona + ':', err.message);
    return { success: false, error: err.toString() };
  }
}
const AVANCE_REINTENTO_MINUTOS = 3;

// Se llama repetidamente (cada vez que el celular capta una posición
// nueva) mientras el registro esté abierto. Si el registro ya no existe o
// ya se cerró (alguien le dio "Terminar" desde otra pestaña, poco común
// pero posible), regresa success:false EN VEZ de lanzar error -- esto se
// llama en silencio desde un watchPosition en segundo plano, y no tiene
// sentido tronar ni mostrarle nada a media faena por esto.
async function agregarPuntoAvance(avanceId, lat, lng) {
  const id = Number(avanceId);
  if (!id || typeof lat !== 'number' || typeof lng !== 'number' || Number.isNaN(lat) || Number.isNaN(lng)) {
    return { success: false, error: 'Datos de ubicación inválidos.' };
  }
  const [rows] = await pool.query('SELECT huerta, fecha_fin, nombre, codigo_unidad, trabajo FROM avance_huerta WHERE id = ?', [id]);
  if (rows.length === 0 || rows[0].fecha_fin !== null) {
    return { success: false, error: 'Este registro de avance ya no está abierto.' };
  }
  await pool.query('INSERT INTO avance_huerta_puntos (avance_id, lat, lng, capturado_en) VALUES (?, ?, ?, NOW())', [id, lat, lng]);
  // Detección automática de cuadros completados (ver comentario junto a
  // marcarCuadrosCompletadosPorPunto_ más abajo) -- envuelta en try/catch
  // a propósito: si esto fallara por cualquier motivo, NUNCA debe tirar el
  // guardado del punto GPS en sí, que es lo importante de esta llamada.
  let actividadesCompletadas = [];
  try {
    actividadesCompletadas = await marcarCuadrosCompletadosPorPunto_(rows[0].huerta, id, lat, lng, rows[0].nombre, rows[0].codigo_unidad, Date.now(), rows[0].trabajo);
  } catch (err) {
    // Se deja constancia en el log del servidor (Render > Logs): si esto
    // falla, el avance de los cuadros deja de subir aunque el punto sí se
    // guarde -- p.ej. si faltó correr actualizar_estructura_nube.bat.
    console.error('[avance cuadros] No se pudo acreditar avance del punto (avance_id=' + id + '):', err.message);
    actividadesCompletadas = [];
  }
  return { success: true, actividadesCompletadas };
}

// ------------------------------------------------------------------
// Modo SIN SEÑAL (oct-2026, petición de Carlos: "que funcione completamente
// sin señal y cuando agarre datos se actualice"). El celular arma cada
// recorrido por su cuenta (idLocal) y guarda cada punto GPS con su hora y
// un número consecutivo (s). Cuando hay señal manda lo pendiente aquí, en
// tandas; lo puede mandar la página o el servicio nativo de Android (los
// dos a la vez sin problema): un candado por recorrido (GET_LOCK) y
// ultimo_seq evitan duplicados. Los puntos se guardan con la hora en que
// se tomaron (no la hora en que llegaron) y se les acredita el avance de
// cuadros igual que en vivo (marcarCuadrosCompletadosPorPunto_).
//   sesion = { idLocal, huerta, nombre, trabajo, porcentaje, codigoUnidad, fechaInicio (ms), fechaFin (ms|null) }
//   puntos = [{ s, lat, lng, t (ms) }]
// Abierta (sin clave), igual que iniciarAvance/agregarPuntoAvance.
const AVANCE_SYNC_MAX_PUNTOS = 2000;
function segundosDeMs_(ms) {
  const n = Number(ms);
  // Hora del celular razonable: de 2020 a mañana. Si no, se usa la del servidor.
  if (!Number.isFinite(n) || n < 1577836800000 || n > Date.now() + 86400000) return null;
  return n / 1000;
}
async function sincronizarAvance(sesion, puntos) {
  const s = sesion || {};
  const idLocal = (s.idLocal || '').toString().trim();
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(idLocal)) return { success: false, error: 'Falta el identificador del recorrido.' };
  const huerta = (s.huerta || '').toString().trim();
  const nombre = (s.nombre || '').toString().trim();
  if (!huerta || !nombre) return { success: false, error: 'Falta la huerta o quién hizo el recorrido.' };
  const lista = Array.isArray(puntos) ? puntos : [];
  if (lista.length > AVANCE_SYNC_MAX_PUNTOS) return { success: false, error: 'Demasiados puntos en un solo envío.' };
  const porcentajeNum = (s.porcentaje === '' || s.porcentaje === undefined || s.porcentaje === null) ? null : Number(s.porcentaje);
  const porcentaje = (porcentajeNum !== null && Number.isFinite(porcentajeNum) && porcentajeNum >= 0 && porcentajeNum <= 100) ? porcentajeNum : null;
  const con = await pool.getConnection();
  const candado = 'avance_sync_' + idLocal;
  let conCandado = false;
  try {
    const [[lk]] = await con.query('SELECT GET_LOCK(?, 20) AS ok', [candado]);
    if (!lk || Number(lk.ok) !== 1) return { success: false, error: 'El recorrido se está guardando desde otro envío; se reintenta solo.' };
    conCandado = true;
    const leer = () => pool.query('SELECT id, huerta, nombre, codigo_unidad, trabajo, fecha_fin, ultimo_seq FROM avance_huerta WHERE id_local = ?', [idLocal]);
    let avisoInicio = false;
    let avisoFin = false;
    let [filas] = await leer();
    if (filas.length === 0) {
      await pool.query(
        'INSERT INTO avance_huerta (huerta, nombre, trabajo, porcentaje, fecha_inicio, codigo_unidad, id_local, ultimo_seq) VALUES (?, ?, ?, ?, COALESCE(FROM_UNIXTIME(?), NOW()), ?, ?, 0)',
        [huerta, nombre, normalizarTrabajoAvance_(s.trabajo), porcentaje, segundosDeMs_(s.fechaInicio), (s.codigoUnidad || '').toString().trim() || null, idLocal]
      );
      [filas] = await leer();
      avisoInicio = true;
    }
    const av = filas[0];
    let ultimo = Number(av.ultimo_seq) || 0;
    const completadas = [];
    const ordenados = lista.slice().sort((a, b) => Number(a && a.s) - Number(b && b.s));
    for (const p of ordenados) {
      const seq = Number(p && p.s);
      if (!Number.isInteger(seq) || seq <= ultimo) continue; // ya se había guardado
      const lat = Number(p.lat);
      const lng = Number(p.lng);
      if (Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180) {
        await pool.query(
          'INSERT INTO avance_huerta_puntos (avance_id, lat, lng, capturado_en) VALUES (?, ?, ?, COALESCE(FROM_UNIXTIME(?), NOW()))',
          [av.id, lat, lng, segundosDeMs_(p.t)]
        );
        try {
          const tSeg = segundosDeMs_(p.t);
          const nuevas = await marcarCuadrosCompletadosPorPunto_(av.huerta, av.id, lat, lng, av.nombre, av.codigo_unidad, tSeg === null ? Date.now() : tSeg * 1000, av.trabajo);
          completadas.push(...nuevas);
        } catch (err) {
          console.error('[sincronizarAvance] No se pudo acreditar avance (avance_id=' + av.id + '):', err.message);
        }
      }
      ultimo = seq;
      await pool.query('UPDATE avance_huerta SET ultimo_seq = ? WHERE id = ?', [ultimo, av.id]);
    }
    if (porcentaje !== null) await pool.query('UPDATE avance_huerta SET porcentaje = ? WHERE id = ?', [porcentaje, av.id]);
    let terminado = av.fecha_fin !== null;
    if (s.fechaFin && !terminado) {
      const [upd] = await pool.query('UPDATE avance_huerta SET fecha_fin = COALESCE(FROM_UNIXTIME(?), NOW()) WHERE id = ? AND fecha_fin IS NULL', [segundosDeMs_(s.fechaFin), av.id]);
      terminado = true;
      avisoFin = !!(upd && upd.affectedRows);
    }
    // Avisos (Telegram / notificación del Panel): por fuera, en orden, sin frenar el envío.
    if (avisoInicio || avisoFin) {
      avisos.avisarRecorrido_([avisoInicio && 'inicio', avisoFin && 'fin'].filter(Boolean), av.id);
    }
    return { success: true, avanceId: av.id, ultimoSeq: ultimo, terminado, actividadesCompletadas: completadas };
  } catch (err) {
    console.error('[sincronizarAvance] idLocal=' + idLocal + ':', err.message);
    return { success: false, error: err.toString() };
  } finally {
    if (conCandado) { try { await con.query('SELECT RELEASE_LOCK(?)', [candado]); } catch (e) { /* se libera solo al cerrar */ } }
    con.release();
  }
}

async function terminarAvance(avanceId) {
  const id = Number(avanceId);
  if (!id) return { success: false, error: 'Falta indicar qué registro terminar.' };
  const [upd] = await pool.query('UPDATE avance_huerta SET fecha_fin = NOW() WHERE id = ? AND fecha_fin IS NULL', [id]);
  if (upd && upd.affectedRows) avisos.avisarRecorrido_('fin', id); // solo la primera vez que se cierra
  return { success: true };
}

// El celular la llama al entrar a "Avance Huerta" (ver avanceReanudarSiHayAbierto_
// en Index.html) para saber si ESE operador ya tiene un registro abierto
// para esa huerta -- por ejemplo porque el celular bloqueó la pantalla por
// inactividad, o Android/iOS mató la página a medio registrar -- y así
// retomarlo en el mismo avanceId en vez de dejarlo huérfano (sin
// fecha_fin, acumulando para siempre sin que nadie lo note) o arriesgarse
// a que el operador inicie uno nuevo encimado sin darse cuenta. Abierta
// (mismo criterio que el resto del recorrido en sí).
async function getAvanceAbierto(huerta, nombre) {
  const nombreHuerta = (huerta || '').toString().trim();
  const nombrePersona = (nombre || '').toString().trim();
  if (!nombreHuerta || !nombrePersona) return { existe: false };
  const [sesiones] = await pool.query(
    `SELECT id, trabajo, porcentaje, fecha_inicio FROM avance_huerta
     WHERE LOWER(TRIM(huerta)) = LOWER(TRIM(?)) AND LOWER(TRIM(nombre)) = LOWER(TRIM(?)) AND fecha_fin IS NULL
     ORDER BY fecha_inicio DESC LIMIT 1`,
    [nombreHuerta, nombrePersona]
  );
  if (sesiones.length === 0) return { existe: false };
  const sesion = sesiones[0];
  const [puntos] = await pool.query(
    'SELECT lat, lng, capturado_en FROM avance_huerta_puntos WHERE avance_id = ? ORDER BY capturado_en, id',
    [sesion.id]
  );
  return {
    existe: true,
    avanceId: sesion.id,
    trabajo: normalizarTrabajoAvance_(sesion.trabajo),
    porcentaje: sesion.porcentaje !== null ? Number(sesion.porcentaje) : null,
    fechaInicio: sesion.fecha_inicio,
    puntos: filtrarSaltosGps_(puntos.map((p) => ({ lat: Number(p.lat), lng: Number(p.lng), t: new Date(p.capturado_en).getTime() })))
      .map((p) => ({ lat: p.lat, lng: p.lng })),
  };
}

// Todo el histórico de una huerta, agrupado por registro (cada registro es
// un trazo independiente -- nunca se conecta con una línea el final de un
// registro con el inicio de otro, aunque hayan sido el mismo día). Sin
// límite/paginación a propósito: es la cantidad de puntos de GPS de una
// sola huerta, que para el uso real de este sistema se mantiene chica.
async function getAvanceHuerta(huerta) {
  const nombreHuerta = (huerta || '').toString().trim();
  if (!nombreHuerta) return [];
  const [sesiones] = await pool.query(
    'SELECT id, nombre, trabajo, porcentaje, fecha_inicio, fecha_fin, codigo_unidad FROM avance_huerta WHERE LOWER(TRIM(huerta)) = LOWER(TRIM(?)) ORDER BY fecha_inicio',
    [nombreHuerta]
  );
  if (sesiones.length === 0) return [];
  const ids = sesiones.map((s) => s.id);
  const [puntos] = await pool.query(
    'SELECT avance_id, lat, lng, capturado_en FROM avance_huerta_puntos WHERE avance_id IN (?) ORDER BY capturado_en',
    [ids]
  );
  const puntosPorSesion = {};
  puntos.forEach((p) => {
    if (!puntosPorSesion[p.avance_id]) puntosPorSesion[p.avance_id] = [];
    puntosPorSesion[p.avance_id].push({ lat: Number(p.lat), lng: Number(p.lng), t: new Date(p.capturado_en).getTime() });
  });
  // ultimoPuntoEn: hora del último punto bueno de cada recorrido -- el Panel
  // lo usa para el ícono del tractor ("en curso" vs. "sin datos desde...").
  const ultimoPuntoPorSesion = {};
  Object.keys(puntosPorSesion).forEach((k) => {
    const limpios = filtrarSaltosGps_(puntosPorSesion[k]);
    if (limpios.length) ultimoPuntoPorSesion[k] = new Date(limpios[limpios.length - 1].t);
    puntosPorSesion[k] = limpios.map((p) => ({ lat: p.lat, lng: p.lng }));
  });
  // codigoUnidad/equipoUnidad: petición de Carlos -- quiere saber con QUÉ
  // equipo (tractor) se hizo cada recorrido cuando hay varios en la misma
  // huerta, para distinguirlos en el mapa de "Avance Huerta". Mismo join
  // con maquinaria que ya usa getRecorridosPorFecha.
  const codigos = Array.from(new Set(sesiones.map((s) => s.codigo_unidad).filter(Boolean)));
  let equiposPorCodigo = {};
  if (codigos.length > 0) {
    const [maquinas] = await pool.query('SELECT codigo_unidad, unidad FROM maquinaria WHERE codigo_unidad IN (?)', [codigos]);
    maquinas.forEach((m) => { equiposPorCodigo[m.codigo_unidad] = m.unidad; });
  }
  return sesiones.map((s) => ({
    avanceId: s.id,
    nombre: s.nombre,
    trabajo: normalizarTrabajoAvance_(s.trabajo),
    porcentaje: s.porcentaje !== null ? Number(s.porcentaje) : null,
    fechaInicio: s.fecha_inicio,
    fechaFin: s.fecha_fin,
    codigoUnidad: s.codigo_unidad || null,
    equipoUnidad: s.codigo_unidad ? (equiposPorCodigo[s.codigo_unidad] || null) : null,
    puntos: puntosPorSesion[s.id] || [],
    ultimoPuntoEn: ultimoPuntoPorSesion[s.id] || null,
  }));
}

// Recorridos de UN día específico, con el detalle de tiempo de cada punto
// -- a diferencia de getAvanceHuerta (todo el histórico, sin horas, para
// el mapa-foto de "avance acumulado"), esto es para la nueva pantalla de
// "Ver recorrido": Carlos elige una fecha, ve la lista de quién trabajó
// ese día (para escoger a cuáles ver, puede elegir varios a la vez) y
// arrastra una barra de tiempo que va revelando el trazo de cada uno
// hasta esa hora -- por eso cada punto va con su capturado_en real, y no
// solo lat/lng como en getAvanceHuerta. Pide permiso de Panel porque,
// a diferencia de getAvanceHuerta (de la vista de solo-lectura que ya
// existía), esto es una pantalla nueva.
async function getRecorridosPorFecha(code, nombreUsuario, huerta, fecha) {
  await requierePermisoPanel_(code, nombreUsuario, 'avance_huerta', 'visualizar');
  const nombreHuerta = (huerta || '').toString().trim();
  const fechaTexto = (fecha || '').toString().trim(); // 'YYYY-MM-DD'
  if (!nombreHuerta || !fechaTexto) return [];
  const [sesiones] = await pool.query(
    `SELECT id, nombre, trabajo, codigo_unidad, fecha_inicio, fecha_fin FROM avance_huerta
     WHERE LOWER(TRIM(huerta)) = LOWER(TRIM(?)) AND DATE(fecha_inicio) = ?
     ORDER BY fecha_inicio`,
    [nombreHuerta, fechaTexto]
  );
  if (sesiones.length === 0) return [];
  const ids = sesiones.map((s) => s.id);
  const [puntos] = await pool.query(
    'SELECT avance_id, lat, lng, capturado_en FROM avance_huerta_puntos WHERE avance_id IN (?) ORDER BY avance_id, capturado_en, id',
    [ids]
  );
  const codigos = Array.from(new Set(sesiones.map((s) => s.codigo_unidad).filter(Boolean)));
  let equiposPorCodigo = {};
  if (codigos.length > 0) {
    const [maquinas] = await pool.query('SELECT codigo_unidad, unidad FROM maquinaria WHERE codigo_unidad IN (?)', [codigos]);
    maquinas.forEach((m) => { equiposPorCodigo[m.codigo_unidad] = m.unidad; });
  }
  const puntosPorSesion = {};
  puntos.forEach((p) => {
    if (!puntosPorSesion[p.avance_id]) puntosPorSesion[p.avance_id] = [];
    puntosPorSesion[p.avance_id].push({ lat: Number(p.lat), lng: Number(p.lng), capturadoEn: p.capturado_en });
  });
  Object.keys(puntosPorSesion).forEach((k) => { puntosPorSesion[k] = filtrarSaltosGps_(puntosPorSesion[k]); });
  return sesiones.map((s) => ({
    avanceId: s.id,
    nombre: s.nombre,
    trabajo: normalizarTrabajoAvance_(s.trabajo),
    codigoUnidad: s.codigo_unidad,
    equipoUnidad: s.codigo_unidad ? (equiposPorCodigo[s.codigo_unidad] || s.codigo_unidad) : null,
    fechaInicio: s.fecha_inicio,
    fechaFin: s.fecha_fin,
    puntos: puntosPorSesion[s.id] || [],
  }));
}

// ------------------------------------------------------------
// Avance por RANGO de fechas y horas + RALENTÍ (petición de Carlos,
// oct-2026): "si estoy viendo hoy a las 5 pm, quiero ver cuánto avanzó de
// las 7 am a las 12 pm", también para varios días seguidos, y saber
// cuánto tiempo estuvo el tractor detenido (ralentí = prendido pero sin
// avanzar; para nosotros: el tractor no avanza).
//
// El celular solo guarda un punto cuando el tractor se movió >= 3 m, así
// que estando parado no llegan puntos (o llegan unos pocos por el
// "bailoteo" del GPS). Una PARADA es cuando el tractor se queda dentro de
// RALENTI_RADIO_METROS de un punto durante al menos los minutos que elija
// Carlos (editable en el Panel); dura desde ese punto hasta el primer
// punto que ya salió del radio (o hasta que se terminó el recorrido). No
// se sabe si el motor estaba prendido: es "no avanzó con el recorrido
// abierto". Un hueco largo SIN quedarse en el mismo lugar (se movió pero no
// llegaron puntos, p.ej. sin señal) no es ralentí: se cuenta aparte como
// "sin señal".
//
// ventanas: [[inicioMs, finMs], ...] en milisegundos absolutos -- el Panel
// las arma con la hora LOCAL de Carlos (p.ej. 7:00-12:00 de cada día del
// rango), así no importa en qué zona horaria corra el servidor.
const RALENTI_RADIO_METROS = 25;
const RALENTI_VELOCIDAD_MAX = 0.3; // m/s -- por debajo de esto, entre 2 puntos, "no avanzó"
const RALENTI_MINUTOS_DEFAULT = 2;
const HUECO_SIN_SENAL_MS = 10 * 60 * 1000; // un hueco > 10 min moviéndose = sin señal, no "en movimiento"

function validarVentanasRango_(ventanas) {
  if (!Array.isArray(ventanas) || ventanas.length === 0) return null;
  if (ventanas.length > 62) return null;
  const limpias = [];
  for (const v of ventanas) {
    if (!Array.isArray(v) || v.length !== 2) return null;
    const a = Number(v[0]);
    const b = Number(v[1]);
    if (!Number.isFinite(a) || !Number.isFinite(b) || b <= a || b - a > 25 * 3600 * 1000) return null;
    limpias.push([a, b]);
  }
  limpias.sort((x, y) => x[0] - y[0]);
  if (limpias[limpias.length - 1][1] - limpias[0][0] > 63 * 24 * 3600 * 1000) return null;
  return limpias;
}

function minutosRalentiValidos_(m) {
  const n = Number(m);
  if (!Number.isFinite(n) || n <= 0) return RALENTI_MINUTOS_DEFAULT;
  return Math.min(240, Math.max(0.5, n));
}

// Cálculo puro (sin base de datos), para poder probarlo aparte.
// sesiones: [{avanceId, nombre, trabajo, codigoUnidad, equipoUnidad,
//             fechaInicio, fechaFin, puntos:[{lat, lng, t (ms)}]}]
// cuadros: [{id, nombre, poligono, surcos}]
// ahoraMs: para un recorrido todavía abierto, hasta cuándo puede durar
// una parada al final.
function calcularResumenRango_(sesiones, cuadros, ventanas, minutosRalenti, ahoraMs) {
  const umbralMs = minutosRalentiValidos_(minutosRalenti) * 60 * 1000;
  const grupos = {};
  const orden = [];
  const sesionesSalida = [];
  const cuadrosValidos = (cuadros || []).map((c) => ({ ...c, poligono: parsearPoligono_(c.poligono) }))
    .filter((c) => c.poligono.length >= 3);

  for (const ses of sesiones || []) {
    // Por equipo; si el recorrido no tiene equipo asignado, por operador
    // (así se acumula entre varios recorridos/días de la misma persona).
    const clave = ses.codigoUnidad ? ('equipo:' + ses.codigoUnidad)
      : (ses.nombre ? ('operador:' + ses.nombre) : ('sesion:' + ses.avanceId));
    if (!grupos[clave]) {
      grupos[clave] = {
        clave, codigoUnidad: ses.codigoUnidad || null, equipoUnidad: ses.equipoUnidad || null,
        nombres: [], trabajos: [], avanceIds: [], metros: 0, movimientoMs: 0, ralentiMs: 0, sinSenalMs: 0,
        paradas: [], pasadasPorCuadro: {},
      };
      orden.push(clave);
    }
    const g = grupos[clave];
    if (ses.nombre && !g.nombres.includes(ses.nombre)) g.nombres.push(ses.nombre);
    if (ses.trabajo && !g.trabajos.includes(ses.trabajo)) g.trabajos.push(ses.trabajo);
    g.avanceIds.push(ses.avanceId);
    const todos = filtrarSaltosGps_((ses.puntos || []).filter((p) => Number.isFinite(p.t)).sort((a, b) => a.t - b.t));
    const finSesionMs = ses.fechaFin ? new Date(ses.fechaFin).getTime() : ahoraMs;
    const puntosSalida = [];

    for (const [va, vb] of ventanas) {
      const pts = todos.filter((p) => p.t >= va && p.t <= vb);
      if (pts.length === 0) continue;
      pts.forEach((p) => puntosSalida.push(p));
      // Distancia y pasadas: en tramos de >= 15 m (igual que el avance de
      // los cuadros), para que el bailoteo del GPS no infle los km.
      for (const [pa, pb] of tramosDeRecorrido_(pts)) {
        g.metros += distanciaMetros_(pa, pb);
        for (const c of cuadrosValidos) {
          const tr = avanceDeTramo_(pa, pb, c.poligono, c.direccion_surcos);
          if (tr.pasadas > 0) g.pasadasPorCuadro[c.id] = (g.pasadasPorCuadro[c.id] || 0) + tr.pasadas;
        }
      }
      // Paradas (ralentí). Cada par de puntos seguidos se clasifica:
      // - "parado": se desplazó <= RALENTI_RADIO_METROS a menos de
      //   RALENTI_VELOCIDAD_MAX (el GPS "bailando" con el tractor quieto
      //   manda puntos a pocos metros, minutos de diferencia);
      // - "sin señal": hueco > 10 min y SÍ apareció en otro lado;
      // - "en movimiento": todo lo demás.
      // Una racha de pares "parado" seguidos (sin alejarse más de
      // RALENTI_RADIO_METROS de donde empezó) que dura al menos el mínimo de
      // minutos elegido es UNA parada; las más cortas (vueltas, maniobras)
      // cuentan como movimiento. Si el recorrido se cerró (o sigue abierto)
      // con el tractor quieto en su último punto, ese tiempo final también
      // cuenta.
      const finVentanaSesion = Math.min(vb, Number.isFinite(finSesionMs) ? finSesionMs : vb);
      const serie = pts.slice();
      const ultimo = serie[serie.length - 1];
      if (finVentanaSesion > ultimo.t) serie.push({ lat: ultimo.lat, lng: ultimo.lng, t: finVentanaSesion, virtual: true });
      let racha = null; // {inicioIdx, finIdx}
      const cerrarRacha = () => {
        if (!racha) return;
        const a = serie[racha.inicioIdx];
        const b = serie[racha.finIdx];
        const dur = b.t - a.t;
        if (dur >= umbralMs) {
          g.paradas.push({ lat: a.lat, lng: a.lng, inicio: a.t, fin: b.t, minutos: Math.round((dur / 60000) * 10) / 10 });
          g.ralentiMs += dur;
        } else {
          g.movimientoMs += dur;
        }
        racha = null;
      };
      for (let k = 1; k < serie.length; k++) {
        const a = serie[k - 1];
        const b = serie[k];
        const dt = b.t - a.t;
        if (dt <= 0) continue;
        const d = distanciaMetros_(a, b);
        const parado = d <= RALENTI_RADIO_METROS && d / (dt / 1000) < RALENTI_VELOCIDAD_MAX
          && (!racha || distanciaMetros_(serie[racha.inicioIdx], b) <= RALENTI_RADIO_METROS);
        if (parado) {
          if (!racha) racha = { inicioIdx: k - 1, finIdx: k };
          else racha.finIdx = k;
          continue;
        }
        cerrarRacha();
        if (b.virtual) continue;
        if (dt > HUECO_SIN_SENAL_MS) g.sinSenalMs += dt;
        else g.movimientoMs += dt;
      }
      cerrarRacha();
    }
    sesionesSalida.push({ ...ses, puntos: puntosSalida.map((p) => ({ lat: p.lat, lng: p.lng, capturadoEn: new Date(p.t) })) });
  }

  const nombreCuadro = {};
  const surcosCuadro = {};
  cuadrosValidos.forEach((c) => { nombreCuadro[c.id] = c.nombre; surcosCuadro[c.id] = c.surcos; });
  const resultadoGrupos = orden.map((clave) => {
    const g = grupos[clave];
    const cuadrosLista = Object.keys(g.pasadasPorCuadro).map((id) => {
      const pasadas = g.pasadasPorCuadro[id];
      const surcos = surcosCuadro[id] === null || surcosCuadro[id] === undefined ? null : Number(surcosCuadro[id]);
      return {
        cuadroId: Number(id), cuadro: nombreCuadro[id], surcos,
        pasadas: Math.round(pasadas * 100) / 100,
        porcentaje: surcos ? Math.round(Math.min(100, (pasadas / surcos) * 100) * 100) / 100 : null,
      };
    }).filter((c) => c.pasadas >= 0.01)
      .sort((a, b) => String(a.cuadro).localeCompare(String(b.cuadro), 'es', { numeric: true }));
    return {
      clave: g.clave, codigoUnidad: g.codigoUnidad, equipoUnidad: g.equipoUnidad,
      nombres: g.nombres, trabajos: g.trabajos, avanceIds: g.avanceIds,
      km: Math.round((g.metros / 1000) * 100) / 100,
      minutosMovimiento: Math.round(g.movimientoMs / 60000),
      minutosRalenti: Math.round(g.ralentiMs / 60000),
      minutosSinSenal: Math.round(g.sinSenalMs / 60000),
      paradas: g.paradas.sort((a, b) => a.inicio - b.inicio),
      cuadros: cuadrosLista,
    };
  });
  return { grupos: resultadoGrupos, sesiones: sesionesSalida, minutosRalenti: minutosRalentiValidos_(minutosRalenti) };
}

// Acción del Panel. filtros (opcional): {operador, trabajo} -- los mismos
// filtros "Operador"/"Actividad" del mapa de Avance de huerta.
async function getAvancePorRango(code, nombreUsuario, huerta, ventanas, minutosRalenti, filtros) {
  await requierePermisoPanel_(code, nombreUsuario, 'avance_huerta', 'visualizar');
  const nombreHuerta = (huerta || '').toString().trim();
  if (!nombreHuerta) return { success: false, error: 'Falta indicar la huerta.' };
  const vs = validarVentanasRango_(ventanas);
  if (!vs) return { success: false, error: 'El rango de fechas/horas no es válido (máximo 62 días, y la hora "hasta" debe ser después de la hora "desde").' };
  const desde = new Date(vs[0][0]);
  const hasta = new Date(vs[vs.length - 1][1]);
  const [sesiones] = await pool.query(
    `SELECT id, nombre, trabajo, codigo_unidad, fecha_inicio, fecha_fin FROM avance_huerta
     WHERE LOWER(TRIM(huerta)) = LOWER(TRIM(?)) AND fecha_inicio <= ? AND (fecha_fin IS NULL OR fecha_fin >= ?)
     ORDER BY fecha_inicio, id`,
    [nombreHuerta, hasta, desde]
  );
  const f = filtros || {};
  const operador = (f.operador || '').toString().trim();
  const trabajo = normalizarTrabajoAvance_(f.trabajo);
  const equipo = (f.equipo || '').toString().trim(); // codigo_unidad (filtro "Tractor" del Panel)
  const elegidas = sesiones.filter((x) => (!operador || x.nombre === operador)
    && (!trabajo || normalizarTrabajoAvance_(x.trabajo) === trabajo)
    && (!equipo || x.codigo_unidad === equipo));
  const [cuadros] = await pool.query(
    'SELECT id, nombre, poligono, surcos, direccion_surcos FROM huerta_cuadros WHERE LOWER(TRIM(huerta)) = LOWER(TRIM(?))',
    [nombreHuerta]
  );
  if (elegidas.length === 0) return { success: true, grupos: [], sesiones: [], minutosRalenti: minutosRalentiValidos_(minutosRalenti) };
  const ids = elegidas.map((x) => x.id);
  const [puntos] = await pool.query(
    'SELECT avance_id, lat, lng, capturado_en FROM avance_huerta_puntos WHERE avance_id IN (?) AND capturado_en BETWEEN ? AND ? ORDER BY avance_id, capturado_en, id',
    [ids, desde, hasta]
  );
  const codigos = Array.from(new Set(elegidas.map((x) => x.codigo_unidad).filter(Boolean)));
  const equipos = {};
  if (codigos.length) {
    const [maq] = await pool.query('SELECT codigo_unidad, unidad FROM maquinaria WHERE codigo_unidad IN (?)', [codigos]);
    maq.forEach((m) => { equipos[m.codigo_unidad] = m.unidad; });
  }
  const porSesion = {};
  puntos.forEach((p) => {
    if (!porSesion[p.avance_id]) porSesion[p.avance_id] = [];
    porSesion[p.avance_id].push({ lat: Number(p.lat), lng: Number(p.lng), t: new Date(p.capturado_en).getTime() });
  });
  const datos = elegidas.map((x) => ({
    avanceId: x.id, nombre: x.nombre, trabajo: normalizarTrabajoAvance_(x.trabajo),
    codigoUnidad: x.codigo_unidad, equipoUnidad: x.codigo_unidad ? (equipos[x.codigo_unidad] || x.codigo_unidad) : null,
    fechaInicio: x.fecha_inicio, fechaFin: x.fecha_fin, puntos: porSesion[x.id] || [],
  })).filter((x) => x.puntos.length > 0);
  const r = calcularResumenRango_(datos, cuadros, vs, minutosRalenti, Date.now());
  return { success: true, ...r };
}

// Borra TODO el historial de avance (avance_huerta + sus puntos de GPS) de
// UNA huerta -- petición de Carlos: algunos recorridos viejos quedaron con
// puntos de GPS muy alejados del mapa real (un brinco del GPS, una prueba,
// o un recorrido hecho antes de calibrar bien), y al dibujarse se ven como
// líneas larguísimas cruzando toda la foto. En vez de poder borrar
// recorrido por recorrido (no hay esa pantalla todavía), esto limpia de un
// jalón para empezar de cero. NO toca cuadros ni actividades (huerta_cuadros/
// huerta_actividades) -- solo el historial de recorridos en sí.
async function eliminarHistoricoAvanceHuerta(code, nombreUsuario, huerta) {
  await requierePermisoPanel_(code, nombreUsuario, 'avance_huerta', 'capturar');
  const nombreHuerta = (huerta || '').toString().trim();
  if (!nombreHuerta) return { success: false, error: 'Falta indicar la huerta.' };
  await pool.query(
    'DELETE FROM avance_huerta_puntos WHERE avance_id IN (SELECT id FROM avance_huerta WHERE LOWER(TRIM(huerta)) = LOWER(TRIM(?)))',
    [nombreHuerta]
  );
  const [result] = await pool.query('DELETE FROM avance_huerta WHERE LOWER(TRIM(huerta)) = LOWER(TRIM(?))', [nombreHuerta]);
  return { success: true, borrados: result.affectedRows };
}

// ------------------------------------------------------------
// Cuadros (lotes numerados) y actividades planeadas por cuadro — ver
// comentario en db/schema.sql (huerta_cuadros/huerta_actividades) para el
// diseño completo. Resumen: desde el Panel, Carlos dibuja el contorno de
// cada cuadro sobre un mapa de Google real (satelital), no sobre la foto
// subida -- queda guardado como un polígono en coordenadas GPS reales. Le
// asigna actividades ("trabajo") a cada cuadro. Cada actividad se marca
// sola como completada en cuanto el recorrido GPS del operador (el mismo
// de avance_huerta_puntos, sin cambiar nada de cómo se captura) ENTRA al
// polígono de ese cuadro -- sin que el operador toque nada. También se
// revisa el histórico ya guardado al crear la actividad, por si el
// operador ya había pasado por ahí antes.
//
// Como el polígono ya viene en GPS real (directo de Google Maps), la
// detección NO necesita la calibración de la foto para nada -- compara la
// posición del operador contra el polígono directamente. La calibración
// de la foto (mapa_cal1_*/mapa_cal2_*) solo se sigue usando para DIBUJAR
// el contorno del cuadro ENCIMA de la foto (proyectando cada vértice del
// polígono a un pixel con gpsAPosicionEnMapa_) -- eso lo hace el cliente
// (Panel.html/Index.html), no el servidor.
const CUADRO_TOLERANCIA_BORDE_METROS = 15; // margen por la imprecisión típica del GPS de un celular
// Margen al comparar avance_metros contra lo esperado para dar por
// completada una actividad por surcos -- sin esto, 2 cantidades calculadas
// por separado (una ya redondeada a centímetros en la base de datos, la
// otra recalculada al vuelo con trigonometría) que en teoría deberían
// coincidir exactamente al llegar al 100% pueden quedar una fracción de
// milímetro por debajo solo por redondeo, y la actividad nunca se
// terminaría de completar sola.
const SURCOS_TOLERANCIA_METROS = 0.1;

function aMetrosLocal_(origen, p) {
  const metrosPorGradoLat = 111320;
  const metrosPorGradoLng = 111320 * Math.cos((origen.lat * Math.PI) / 180);
  return { x: (p.lng - origen.lng) * metrosPorGradoLng, y: (p.lat - origen.lat) * metrosPorGradoLat };
}

// Ray casting clásico (par/impar de cruces) -- funciona para cualquier
// polígono simple, incluyendo formas no convexas (como una "L").
function puntoDentroDePoligono_(punto, poligono) {
  if (!poligono || poligono.length < 3) return false;
  const origen = poligono[0];
  const p = aMetrosLocal_(origen, punto);
  const verts = poligono.map((v) => aMetrosLocal_(origen, v));
  let dentro = false;
  for (let i = 0, j = verts.length - 1; i < verts.length; j = i++) {
    const vi = verts[i];
    const vj = verts[j];
    const cruza = (vi.y > p.y) !== (vj.y > p.y)
      && p.x < ((vj.x - vi.x) * (p.y - vi.y)) / (vj.y - vi.y) + vi.x;
    if (cruza) dentro = !dentro;
  }
  return dentro;
}

function distanciaPuntoASegmentoMetros_(punto, a, b) {
  const origen = a;
  const p = aMetrosLocal_(origen, punto);
  const A = { x: 0, y: 0 };
  const B = aMetrosLocal_(origen, b);
  const dx = B.x - A.x;
  const dy = B.y - A.y;
  const largo2 = dx * dx + dy * dy;
  let t = largo2 < 1e-9 ? 0 : ((p.x - A.x) * dx + (p.y - A.y) * dy) / largo2;
  t = Math.max(0, Math.min(1, t));
  const cx = A.x + t * dx;
  const cy = A.y + t * dy;
  return Math.sqrt((p.x - cx) * (p.x - cx) + (p.y - cy) * (p.y - cy));
}

function distanciaPuntoAPoligonoMetros_(punto, poligono) {
  let min = Infinity;
  for (let i = 0, j = poligono.length - 1; i < poligono.length; j = i++) {
    const d = distanciaPuntoASegmentoMetros_(punto, poligono[j], poligono[i]);
    if (d < min) min = d;
  }
  return min;
}

// "Cubre" el cuadro si el punto cae dentro del polígono, o está a menos de
// CUADRO_TOLERANCIA_BORDE_METROS de su borde.
function cubreCuadro_(punto, poligono) {
  if (puntoDentroDePoligono_(punto, poligono)) return true;
  return distanciaPuntoAPoligonoMetros_(punto, poligono) <= CUADRO_TOLERANCIA_BORDE_METROS;
}

// Margen CHICO, solo para ACREDITAR metros de avance (ver
// dentroParaAvance_). Petición de Carlos (oct-2026): con el margen grande
// de CUADRO_TOLERANCIA_BORDE_METROS (15 m), ir circulando por el CAMINO
// que corre junto a un cuadro (o entre 2 cuadros) contaba como si se
// hubiera trabajado dentro -- y a veces para los 2 cuadros a la vez -- y
// cuadros que solo se habían cruzado por una orilla aparecían
// "Completado". Ahora solo cuenta lo que queda DENTRO del contorno
// dibujado (ver avanceDeTramo_), con un margen de 1.5 m solo para un
// recorrido que va pegado por fuera de la orilla. Se probó con 3 m, pero
// con el error normal del GPS (±2.5 m) ir por un camino a 4 m de la orilla
// todavía sumaba ~1/3 de pasada; con 1.5 m ya no suma nada.
const CUADRO_TOLERANCIA_AVANCE_METROS = 1.5;

function dentroParaAvance_(punto, poligono) {
  if (puntoDentroDePoligono_(punto, poligono)) return true;
  return distanciaPuntoAPoligonoMetros_(punto, poligono) <= CUADRO_TOLERANCIA_AVANCE_METROS;
}

// Distancia GPS real (en metros) entre 2 puntos cualesquiera -- a
// diferencia de distanciaPuntoASegmentoMetros_ (que mide contra un
// SEGMENTO, para la tolerancia de borde), esta es la línea recta entre 2
// puntos sueltos, usada para medir cuánto avanzó el operador de un punto
// de su recorrido al siguiente.
function distanciaMetros_(a, b) {
  const p = aMetrosLocal_(a, b);
  return Math.sqrt(p.x * p.x + p.y * p.y);
}

// ------------------------------------------------------------
// Avance por PASADAS (oct-2026) -- petición de Carlos: en el CUADRO 22
// (33 surcos) llevaba 4 atravesadas y el Panel decía 100%; lo correcto es
// 4 / 33 = 12.12%. Antes el largo de "un surco" se ESTIMABA con el lado
// más largo del polígono, pero en muchos cuadros los surcos corren a lo
// ANCHO (por el lado corto), y además metros sueltos no dicen cuántas
// atravesadas son. Ahora cada tramo del recorrido se convierte
// directamente en "fracción de pasada":
//
//    pasada del tramo = metros del tramo DENTRO del cuadro
//                       / largo del cuadro, de orilla a orilla, en la
//                         MISMA dirección en que va el tractor
//
// Así una atravesada completa vale 1 sin importar hacia dónde corran los
// surcos ni si el cuadro es un trapecio (se mide la cuerda justo por donde
// pasa), media atravesada vale 0.5, y un tramo de lado (vueltas en la
// cabecera, el GPS "bailando" con el tractor parado) casi no suma, porque
// a lo ancho el cuadro es mucho más largo. El tramo se RECORTA contra el
// contorno: entrar o salir del cuadro cuenta solo la parte de adentro (no
// se pierde el pedazo entre el último punto de afuera y el primero de
// adentro), y lo que va por el camino de afuera no cuenta. Si los 2
// puntos están dentro del margen de error del GPS
// (CUADRO_TOLERANCIA_AVANCE_METROS), el tramo cuenta completo.
function puntoDentroLocal_(p, verts) {
  let dentro = false;
  for (let i = 0, j = verts.length - 1; i < verts.length; j = i++) {
    const vi = verts[i];
    const vj = verts[j];
    const cruza = (vi.y > p.y) !== (vj.y > p.y)
      && p.x < ((vj.x - vi.x) * (p.y - vi.y)) / (vj.y - vi.y) + vi.x;
    if (cruza) dentro = !dentro;
  }
  return dentro;
}

// ------------------------------------------------------------
// DIRECCIÓN de los surcos (petición de Carlos, oct-2026): "hay que
// habilitar la dirección para la que van los surcos y hacia esa dirección
// tiene que ir el avance del tractor". Carlos traza en el Panel una línea
// sobre una hilera del cuadro; se guarda como RUMBO (grados desde el
// norte, en el sentido del reloj, 0 a 180 -- un surco no tiene "ida" ni
// "vuelta": 10° y 190° son la misma dirección). Si el cuadro tiene
// dirección, un tramo del recorrido SOLO cuenta como avance si va a lo
// largo de los surcos, con hasta SURCOS_TOLERANCIA_GRADOS de desviación
// (en cualquiera de los 2 sentidos); cruces de lado, diagonales y vueltas
// en la cabecera ya no suman. Con tramos de 15 m (ver
// AVANCE_TRAMO_MINIMO_METROS), 20° no pierde avance real ni con ±3 m de
// error del GPS (probado en tests/unitarias/test_direccion_surcos.js). Sin
// dirección capturada, el cuadro sigue como antes.
const SURCOS_TOLERANCIA_GRADOS = 20;

// Rumbo de a hacia b, normalizado a [0, 180).
function rumboTramo_(a, b) {
  const p = aMetrosLocal_(a, b); // x = este, y = norte
  if (Math.abs(p.x) < 1e-9 && Math.abs(p.y) < 1e-9) return null;
  const grados = (Math.atan2(p.x, p.y) * 180) / Math.PI; // 0 = norte, 90 = este
  return ((grados % 180) + 180) % 180;
}

// Diferencia entre 2 rumbos de surco, de 0 a 90 grados.
function diferenciaRumbos_(r1, r2) {
  const d = Math.abs(Number(r1) - Number(r2)) % 180;
  return Math.min(d, 180 - d);
}

function direccionValida_(d) {
  if (d === null || d === undefined || d === '') return null;
  const n = Number(d);
  return Number.isFinite(n) ? ((n % 180) + 180) % 180 : null;
}

// Regresa { metros, pasadas } de UN tramo (de a a b) respecto a un cuadro.
// direccionSurcos (opcional): rumbo de los surcos de ese cuadro; si el
// tramo no va a lo largo de ellos, no cuenta como avance.
function avanceDeTramo_(a, b, poligono, direccionSurcos) {
  const cero = { metros: 0, pasadas: 0 };
  if (!a || !b || !poligono || poligono.length < 3) return cero;
  const dirSurcos = direccionValida_(direccionSurcos);
  if (dirSurcos !== null) {
    const rumbo = rumboTramo_(a, b);
    if (rumbo === null || diferenciaRumbos_(rumbo, dirSurcos) > SURCOS_TOLERANCIA_GRADOS) return cero;
  }
  const origen = poligono[0];
  const verts = poligono.map((v) => aMetrosLocal_(origen, v));
  const A = aMetrosLocal_(origen, a);
  const B = aMetrosLocal_(origen, b);
  const dx = B.x - A.x;
  const dy = B.y - A.y;
  const largo = Math.sqrt(dx * dx + dy * dy);
  if (largo < 0.01) return cero;

  // Pedazos de una recta paralela a A->B (corrida `desplazamiento` metros
  // de lado) que quedan DENTRO del cuadro, como intervalos [t0, t1] (t = 0
  // en A, 1 en B). Cada pedazo es una cuerda de orilla a orilla.
  const nx = -dy / largo;
  const ny = dx / largo;
  function pedazosDeRecta(desplazamiento) {
    const ax = A.x + nx * desplazamiento;
    const ay = A.y + ny * desplazamiento;
    const ts = [];
    for (let i = 0; i < verts.length; i++) {
      const P = verts[i];
      const Q = verts[(i + 1) % verts.length];
      const ex = Q.x - P.x;
      const ey = Q.y - P.y;
      const den = dx * ey - dy * ex;
      if (Math.abs(den) < 1e-12) continue; // lado paralelo al tramo
      const t = ((P.x - ax) * ey - (P.y - ay) * ex) / den;
      const u = ((P.x - ax) * dy - (P.y - ay) * dx) / den;
      if (u >= -1e-9 && u <= 1 + 1e-9) ts.push(t);
    }
    ts.sort((x, y) => x - y);
    const res = [];
    for (let i = 0; i + 1 < ts.length; i++) {
      if (ts[i + 1] - ts[i] < 1e-9) continue;
      const tm = (ts[i] + ts[i + 1]) / 2;
      if (puntoDentroLocal_({ x: ax + tm * dx, y: ay + tm * dy }, verts)) res.push([ts[i], ts[i + 1]]);
    }
    return res;
  }
  const pedazos = pedazosDeRecta(0);
  let fraccionDentro = 0;
  for (const pz of pedazos) fraccionDentro += Math.max(0, Math.min(1, pz[1]) - Math.max(0, pz[0]));
  // Largo del cuadro de orilla a orilla en la dirección del tramo. NO se
  // toma solo la recta exacta del tramo: en el último surco, pegado a la
  // orilla, el GPS hace que el tramo cruce la orilla en un ángulo muy
  // cerrado y esa recta "ve" el cuadro cortísimo (cada tramo contaba como
  // casi una pasada entera). Se mide también en rectas paralelas hasta
  // CUERDA_DESPLAZAMIENTO_METROS hacia cada lado y se toma la más larga
  // que pase a la altura del tramo -- en un trapecio, 10 m de lado cambian
  // la cuerda apenas unos centímetros.
  let cuerda = null;
  for (let d = -CUERDA_DESPLAZAMIENTO_METROS; d <= CUERDA_DESPLAZAMIENTO_METROS + 1e-9; d += 2.5) {
    for (const pz of pedazosDeRecta(d)) {
      if (pz[1] > 0 && pz[0] < 1) { // atraviesa el cuadro a la altura del tramo
        const c = (pz[1] - pz[0]) * largo;
        if (cuerda === null || c > cuerda) cuerda = c;
      }
    }
  }
  let metros = fraccionDentro * largo;
  // ¿Va directo hacia el cuadro (entra a él muy poco después o salió de
  // él muy poco antes)? Entonces es la entrada/salida desde el camino y lo
  // de afuera NO cuenta; la parte de adentro ya la cuenta el tramo de al lado.
  const entrandoOSaliendo = pedazos.some((pz) => pz[1] >= -0.5 && pz[0] <= 1.5);
  if (metros <= 0 && !entrandoOSaliendo) {
    // El tramo NO entra al contorno dibujado. Solo cuenta si va pegado a
    // la orilla, dentro del margen de error del GPS (p.ej. el último surco
    // con el GPS marcando 2 m afuera): se mide qué parte del tramo queda a
    // <= CUADRO_TOLERANCIA_AVANCE_METROS del borde, en pedacitos de ~1 m.
    // Primero un descarte rápido por "caja" para no hacer esto con cuadros
    // lejanos.
    const m = CUADRO_TOLERANCIA_AVANCE_METROS;
    let minX = Infinity; let maxX = -Infinity; let minY = Infinity; let maxY = -Infinity;
    verts.forEach((v) => { minX = Math.min(minX, v.x); maxX = Math.max(maxX, v.x); minY = Math.min(minY, v.y); maxY = Math.max(maxY, v.y); });
    if (Math.max(A.x, B.x) < minX - m || Math.min(A.x, B.x) > maxX + m
      || Math.max(A.y, B.y) < minY - m || Math.min(A.y, B.y) > maxY + m) return cero;
    const n = Math.min(200, Math.max(1, Math.ceil(largo)));
    let cerca = 0;
    for (let k = 0; k < n; k++) {
      const t = (k + 0.5) / n;
      const pt = { lat: a.lat + (b.lat - a.lat) * t, lng: a.lng + (b.lng - a.lng) * t };
      if (distanciaPuntoAPoligonoMetros_(pt, poligono) <= m) cerca++;
    }
    metros = (cerca / n) * largo;
  }
  if (metros <= 0) return cero;
  if (cuerda === null) {
    // Ninguna recta cercana atraviesa el cuadro a la altura del tramo: se
    // usa el largo total del cuadro en esa dirección.
    const ux = dx / largo;
    const uy = dy / largo;
    let min = Infinity;
    let max = -Infinity;
    verts.forEach((v) => { const pr = v.x * ux + v.y * uy; if (pr < min) min = pr; if (pr > max) max = pr; });
    cuerda = max - min;
  }
  if (!(cuerda > 0)) return cero;
  return { metros, pasadas: Math.min(1, metros / cuerda) };
}

// Pasadas que hacen falta para completar una actividad: ceil(surcos /
// cada cuántos surcos cuenta una pasada). null = el cuadro no tiene
// surcos capturados (no se puede medir; no se completa sola).
// "Cada cuántos surcos" de una actividad: 1 = cada surco, 2 = cada 2
// surcos (implemento que cubre 2 de una pasada)... y desde oct-2026 también
// 0.5 = hay que pasar 2 VECES por cada surco (petición de Carlos). Se
// acepta en pasos de 0.5 (0.5, 1, 1.5, 2...), de 0.5 a 50; cualquier otra
// cosa se redondea al 0.5 más cercano, y lo inválido/vacío vale 1. La
// columna es DECIMAL en la base, y mysql2 la regresa como texto -- por eso
// siempre se pasa por aquí antes de usarla.
function intervaloSurcosValido_(valor) {
  const n = Number(valor);
  if (!Number.isFinite(n) || n <= 0) return 1;
  return Math.min(50, Math.max(0.5, Math.round(n * 2) / 2));
}

function pasadasNecesarias_(surcos, intervaloSurcos) {
  const n = Number(surcos);
  if (!n || n <= 0) return null;
  const intervalo = intervaloSurcosValido_(intervaloSurcos);
  return Math.ceil(n / intervalo);
}
// Cuándo se da por COMPLETADA una actividad: cuando le falta menos del 2%
// de las pasadas necesarias, con un máximo de media pasada (p.ej. 33
// surcos -> a partir de 32.5). Sin este margen, una actividad trabajada
// completa podía quedarse para siempre en 98-99%: en el surco pegado a la
// orilla parte del recorrido cae fuera del contorno por el error del GPS
// y ese surco cuenta ~0.9 en vez de 1.
function margenCompletado_(necesarias) {
  return Math.min(0.5, Math.max(0.01, necesarias * 0.02));
}
// Ver avanceDeTramo_ (cómo se mide el largo del cuadro junto a la orilla).
const CUERDA_DESPLAZAMIENTO_METROS = 10;
// El avance se mide en tramos de al menos 15 m (desde el "ancla" del
// recorrido), no entre cada par de puntos seguidos: el celular manda un
// punto cada 3 m y, con el error normal del GPS (±3-5 m), sumar esos
// tramitos en zigzag inflaba el avance (4 atravesadas llegaban a contar
// como 5-8). Con tramos de 15 m el error se promedia y 4 atravesadas dan
// 4 pasadas (probado con ±5 m de error, ver tests/unitarias/test_avance_pasadas.js).
const AVANCE_TRAMO_MINIMO_METROS = 15;

// Parte una lista ORDENADA de puntos de un recorrido en los tramos que
// realmente se miden (ancla -> primer punto a >= AVANCE_TRAMO_MINIMO_METROS,
// y así sucesivamente) -- la misma regla que se aplica en vivo punto por
// punto en marcarCuadrosCompletadosPorPunto_. Regresa [[a, b], ...].
// ------------------------------------------------------------
// Saltos del GPS (oct-2026, Carlos: "731.86 km" en 2 h 34 min de
// movimiento -- imposible para un tractor). El celular, además del GPS,
// usaba la ubicación "de red" (antenas/WiFi), que puede caer a cientos de
// metros (p.ej. en las bodegas): el recorrido brincaba ida y vuelta cada
// pocos segundos e inflaba km, pasadas, ralentí y "sin señal". Esto quita
// esos puntos ANTES de cualquier cálculo o dibujo:
//  - "pico": un punto que se aleja > SALTO_GPS_MIN_METROS del anterior y
//    del siguiente, cuando el anterior y el siguiente están cerca entre sí
//    (ida y vuelta);
//  - "demasiado rápido": implica más de VELOCIDAD_MAX_TRACTOR_MS desde el
//    último punto bueno. Si de verdad se movió (p.ej. después de un hueco
//    sin señal), en cuanto llegan PUNTOS_PARA_REUBICAR puntos seguidos
//    coherentes entre sí, se aceptan.
// Sirve con o sin hora (t en ms, Date o capturadoEn); sin hora solo aplica
// la regla de "pico".
const SALTO_GPS_MIN_METROS = 40;
const VELOCIDAD_MAX_TRACTOR_MS = 15; // 54 km/h
const PUNTOS_PARA_REUBICAR = 3;
function tiempoPuntoMs_(p) {
  const v = p.t !== undefined ? p.t : p.capturadoEn;
  if (v === undefined || v === null) return null;
  const n = v instanceof Date ? v.getTime() : (typeof v === 'number' ? v : new Date(v).getTime());
  return Number.isFinite(n) ? n : null;
}
function demasiadoRapido_(a, b) {
  const ta = tiempoPuntoMs_(a);
  const tb = tiempoPuntoMs_(b);
  if (ta === null || tb === null) return false;
  const d = distanciaMetros_(a, b);
  if (d <= SALTO_GPS_MIN_METROS) return false;
  const dt = (tb - ta) / 1000;
  return dt <= 0 ? true : d / dt > VELOCIDAD_MAX_TRACTOR_MS;
}
function filtrarSaltosGps_(puntos) {
  const pts = (puntos || []).filter((p) => p && Number.isFinite(Number(p.lat)) && Number.isFinite(Number(p.lng)));
  const buenos = [];
  let dudosos = [];
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    if (!buenos.length) { buenos.push(p); continue; }
    const prev = buenos[buenos.length - 1];
    const sig = pts[i + 1];
    const dPrev = distanciaMetros_(prev, p);
    if (sig) {
      const dSig = distanciaMetros_(p, sig);
      if (dPrev > SALTO_GPS_MIN_METROS && dSig > SALTO_GPS_MIN_METROS && distanciaMetros_(prev, sig) < 0.5 * Math.min(dPrev, dSig)) continue; // pico
    }
    if (demasiadoRapido_(prev, p)) {
      if (dudosos.length && demasiadoRapido_(dudosos[dudosos.length - 1], p)) dudosos = [];
      dudosos.push(p);
      if (dudosos.length >= PUNTOS_PARA_REUBICAR) { dudosos.forEach((x) => buenos.push(x)); dudosos = []; }
      continue;
    }
    dudosos = [];
    buenos.push(p);
  }
  return buenos;
}

function tramosDeRecorrido_(puntos) {
  const tramos = [];
  let ancla = null;
  for (const p of puntos || []) {
    if (!ancla) { ancla = p; continue; }
    if (distanciaMetros_(ancla, p) >= AVANCE_TRAMO_MINIMO_METROS) {
      tramos.push([ancla, p]);
      ancla = p;
    }
  }
  return tramos;
}

// ------------------------------------------------------------
// Avance por surcos -- petición explícita de Carlos: "si en el cuadro 02
// fueran 10 surcos y avanzo la mitad de uno llevaría un avance del 5%" en
// vez del criterio binario de antes (pendiente/completado solo con pasar
// por cualquier parte del cuadro). huerta_cuadros.surcos es el número de
// surcos REALES de ese lote (una sola vez, es una propiedad física del
// cuadro, no de la actividad). huerta_actividades.intervalo_surcos es
// cada cuántos surcos cuenta esa actividad EN PARTICULAR como una pasada
// (1 = surco por surco, 2 = cada dos surcos -- p.ej. un implemento ancho
// que cubre 2 surcos de una pasada).
//
// La longitud de "un surco" se ESTIMA sola, sin que Carlos tenga que
// medir nada: se toma el LADO más largo del polígono que ya dibujó en
// Google Maps (entre 2 vértices consecutivos, no cualquier par) -- para un
// cuadro razonablemente rectangular, ese lado largo es justo la distancia
// de punta a punta de un surco que corre a lo largo del lote. Se usa el
// lado más largo y no la diagonal entre 2 vértices cualesquiera (que sería
// más larga y sobreestimaría el surco) precisamente porque la diagonal no
// es un recorrido real que el operador vaya a hacer.
//
// Si un cuadro NO tiene surcos capturados (NULL), se mantiene el
// comportamiento binario de siempre: cualquier punto dentro del polígono
// completa de inmediato sus actividades pendientes.
function calcularLargoPoligonoMetros_(poligono) {
  if (!poligono || poligono.length < 2) return 0;
  const origen = poligono[0];
  const verts = poligono.map((v) => aMetrosLocal_(origen, v));
  let max = 0;
  for (let i = 0; i < verts.length; i++) {
    const a = verts[i];
    const b = verts[(i + 1) % verts.length];
    const dx = a.x - b.x;
    const dy = a.y - b.y;
    const d = Math.sqrt(dx * dx + dy * dy);
    if (d > max) max = d;
  }
  return max;
}

// null = "este cuadro no tiene surcos capturados todavía -- usar el
// criterio binario de antes en vez de un %".
function calcularDistanciaTotalEsperadaMetros_(poligono, surcos, intervaloSurcos) {
  const n = Number(surcos);
  if (!n || n <= 0) return null;
  const intervalo = intervaloSurcosValido_(intervaloSurcos);
  const pasadas = Math.ceil(n / intervalo);
  const largo = calcularLargoPoligonoMetros_(poligono);
  return pasadas * largo;
}

// Valida que sea un arreglo de al menos 3 puntos {lat,lng} numéricos.
function poligonoValido_(poligono) {
  if (!Array.isArray(poligono) || poligono.length < 3) return false;
  return poligono.every((p) => p && typeof p.lat === 'number' && typeof p.lng === 'number'
    && !Number.isNaN(p.lat) && !Number.isNaN(p.lng)
    && p.lat >= -90 && p.lat <= 90 && p.lng >= -180 && p.lng <= 180);
}

// Acción del Panel (guardar el polígono de un cuadro, dibujado en el mapa
// de Google). Nombre único por huerta (ver UNIQUE KEY en schema.sql) -- si
// Carlos vuelve a guardar el mismo nombre, se actualiza su forma en vez de
// duplicarlo (permite redibujar/corregir un cuadro ya marcado).
async function guardarCuadroHuerta(code, nombreUsuario, huerta, nombre, poligono) {
  await requierePermisoPanel_(code, nombreUsuario, 'avance_huerta', 'capturar');
  const nombreHuerta = (huerta || '').toString().trim();
  const nombreCuadro = (nombre || '').toString().trim();
  if (!nombreHuerta) return { success: false, error: 'Falta indicar la huerta.' };
  if (!nombreCuadro) return { success: false, error: 'Falta el nombre del cuadro.' };
  if (!poligonoValido_(poligono)) return { success: false, error: 'El contorno dibujado no es válido -- dibuja el cuadro con al menos 3 puntos.' };
  try {
    const poligonoJson = JSON.stringify(poligono.map((p) => ({ lat: p.lat, lng: p.lng })));
    const [result] = await pool.query(
      `INSERT INTO huerta_cuadros (huerta, nombre, poligono)
       VALUES (?, ?, ?)
       ON DUPLICATE KEY UPDATE poligono = VALUES(poligono)`,
      [nombreHuerta, nombreCuadro, poligonoJson]
    );
    return { success: true, id: result.insertId };
  } catch (err) {
    return { success: false, error: err.toString() };
  }
}

// Borra el cuadro y, con él, cualquier actividad que ya se le hubiera
// asignado (sin llave foránea que lo haga solo -- se borra explícito aquí
// para no dejar actividades huérfanas apuntando a un cuadro que ya no
// existe).
async function eliminarCuadroHuerta(code, nombreUsuario, cuadroId) {
  await requierePermisoPanel_(code, nombreUsuario, 'avance_huerta', 'capturar');
  const id = Number(cuadroId);
  if (!id) return { success: false, error: 'Falta indicar qué cuadro borrar.' };
  await pool.query('DELETE FROM huerta_actividades WHERE cuadro_id = ?', [id]);
  await pool.query('DELETE FROM huerta_cuadros WHERE id = ?', [id]);
  return { success: true };
}

// Acción del Panel: define (o quita) cuántos surcos REALES tiene un
// cuadro -- separada de guardarCuadroHuerta a propósito, para no
// arriesgar el contorno ya dibujado solo por ajustar este número. null/''
// = "quitar el dato" (ese cuadro vuelve al criterio binario de antes). El
// % de cualquier actividad pendiente de este cuadro depende de este
// número, así que se reevalúan de inmediato por si el cambio ya las deja
// en 100% (p.ej. si Carlos corrige el número de surcos hacia abajo).
async function actualizarSurcosCuadro(code, nombreUsuario, cuadroId, surcos) {
  await requierePermisoPanel_(code, nombreUsuario, 'avance_huerta', 'capturar');
  const id = Number(cuadroId);
  if (!id) return { success: false, error: 'Falta indicar qué cuadro.' };
  let surcosNum = null;
  if (surcos !== null && surcos !== undefined && surcos !== '') {
    surcosNum = Math.round(Number(surcos));
    if (!Number.isFinite(surcosNum) || surcosNum <= 0) {
      return { success: false, error: 'El número de surcos debe ser un entero mayor a 0 (o déjalo vacío para quitarlo).' };
    }
  }
  const [cuadros] = await pool.query('SELECT poligono FROM huerta_cuadros WHERE id = ?', [id]);
  if (cuadros.length === 0) return { success: false, error: 'Ese cuadro ya no existe.' };
  await pool.query('UPDATE huerta_cuadros SET surcos = ? WHERE id = ?', [surcosNum, id]);
  const [actividades] = await pool.query(
    `SELECT id, intervalo_surcos, avance_pasadas FROM huerta_actividades WHERE cuadro_id = ? AND estado = 'pendiente'`,
    [id]
  );
  for (const act of actividades) {
    const necesarias = pasadasNecesarias_(surcosNum, act.intervalo_surcos);
    const pasadas = Number(act.avance_pasadas) || 0;
    if (necesarias !== null && pasadas >= necesarias - margenCompletado_(necesarias)) {
      await pool.query(
        `UPDATE huerta_actividades SET estado = 'completado', completado_en = NOW() WHERE id = ?`,
        [act.id]
      );
    }
  }
  return { success: true, surcos: surcosNum };
}

// Acción del Panel: guarda (o quita) la DIRECCIÓN de los surcos de un
// cuadro a partir de la línea que Carlos trazó sobre una hilera (2 puntos
// {lat,lng}). puntoA/puntoB = null -> quita la dirección (el cuadro vuelve
// a contar avance en cualquier dirección). Como cambia qué recorridos
// cuentan, recalcula de inmediato el avance de las actividades de ESE
// cuadro con el historial de GPS (puede regresar a pendiente una
// actividad que se había completado con cruces de lado).
async function guardarDireccionSurcosCuadro(code, nombreUsuario, cuadroId, puntoA, puntoB) {
  await requierePermisoPanel_(code, nombreUsuario, 'avance_huerta', 'capturar');
  const id = Number(cuadroId);
  if (!id) return { success: false, error: 'Falta indicar qué cuadro.' };
  const [cuadros] = await pool.query('SELECT id FROM huerta_cuadros WHERE id = ?', [id]);
  if (cuadros.length === 0) return { success: false, error: 'Ese cuadro ya no existe.' };
  let direccion = null;
  if (puntoA || puntoB) {
    if (!poligonoValido_([puntoA, puntoB, puntoA])) return { success: false, error: 'La línea trazada no es válida.' };
    if (distanciaMetros_(puntoA, puntoB) < 5) return { success: false, error: 'La línea es muy corta: trázala de un extremo a otro de una hilera (al menos 5 m).' };
    direccion = Math.round(rumboTramo_(puntoA, puntoB) * 100) / 100;
  }
  await pool.query('UPDATE huerta_cuadros SET direccion_surcos = ? WHERE id = ?', [direccion, id]);
  const cambios = await recalcularAvanceActividadesHuerta_(true, { cuadroId: id });
  return { success: true, direccionSurcos: direccion, actividadesRecalculadas: cambios.length };
}

// mysql2 regresa una columna JSON ya parseada a JS en la mayoría de los
// casos, pero según la versión/driver puede llegar como texto -- esta
// función cubre los dos casos sin tronar.
function parsearPoligono_(valor) {
  if (Array.isArray(valor)) return valor;
  if (typeof valor === 'string') {
    try { return JSON.parse(valor); } catch (e) { return []; }
  }
  return [];
}

// Abierta (sin permiso especial) -- la usan tanto el Panel (para dibujar/
// listar cuadros y asignar actividades) como el celular (para mostrar, de
// solo lectura, el contorno de los cuadros sobre su propio mapa).
async function getCuadrosHuerta(huerta) {
  const nombreHuerta = (huerta || '').toString().trim();
  if (!nombreHuerta) return [];
  const [rows] = await pool.query(
    'SELECT id, nombre, poligono, surcos, direccion_surcos FROM huerta_cuadros WHERE LOWER(TRIM(huerta)) = LOWER(TRIM(?)) ORDER BY nombre',
    [nombreHuerta]
  );
  return rows.map((r) => ({
    id: r.id, nombre: r.nombre, poligono: parsearPoligono_(r.poligono), surcos: r.surcos,
    direccionSurcos: direccionValida_(r.direccion_surcos),
  }));
}

// ------------------------------------------------------------
// Catálogo de actividades de Avance Huerta (ver actividades_catalogo en
// db/schema.sql) -- Carlos da de alta la actividad UNA VEZ (trabajo + cada
// cuántos surcos) y después la asigna a los cuadros que quiera, de un
// jalón (ver asignarActividadCatalogoACuadros más abajo), sin tener que
// volver a escribir el trabajo ni el intervalo por cada cuadro.
// ------------------------------------------------------------

async function getActividadesCatalogo(code, nombreUsuario, huerta) {
  await requierePermisoPanel_(code, nombreUsuario, 'avance_huerta', 'visualizar');
  const nombreHuerta = (huerta || '').toString().trim();
  if (!nombreHuerta) return [];
  const [rows] = await pool.query(
    'SELECT id, trabajo, intervalo_surcos, creado_por, creado_en FROM actividades_catalogo WHERE LOWER(TRIM(huerta)) = LOWER(TRIM(?)) ORDER BY trabajo',
    [nombreHuerta]
  );
  return rows.map((r) => ({
    id: r.id,
    trabajo: r.trabajo,
    intervaloSurcos: intervaloSurcosValido_(r.intervalo_surcos),
    creadoPor: r.creado_por,
    creadoEn: r.creado_en,
  }));
}

// id vacío/ausente = crear una actividad nueva en el catálogo; con id,
// edita la que ya existía (cambia trabajo/intervalo para asignaciones
// FUTURAS -- no toca las filas de huerta_actividades que ya se habían
// creado con el valor anterior, igual que cualquier catálogo simple de
// este sistema).
async function guardarActividadCatalogo(code, nombreUsuario, id, huerta, trabajo, intervaloSurcos) {
  await requierePermisoPanel_(code, nombreUsuario, 'avance_huerta', 'capturar');
  const nombreHuerta = (huerta || '').toString().trim();
  const trabajoTexto = (trabajo || '').toString().trim();
  const intervalo = intervaloSurcosValido_(intervaloSurcos);
  if (!nombreHuerta) return { success: false, error: 'Falta indicar la huerta.' };
  if (!trabajoTexto) return { success: false, error: 'Falta describir la actividad.' };
  try {
    const idNum = Number(id) || null;
    if (idNum) {
      await pool.query(
        'UPDATE actividades_catalogo SET trabajo = ?, intervalo_surcos = ? WHERE id = ? AND LOWER(TRIM(huerta)) = LOWER(TRIM(?))',
        [trabajoTexto, intervalo, idNum, nombreHuerta]
      );
      return { success: true, id: idNum };
    }
    const [result] = await pool.query(
      'INSERT INTO actividades_catalogo (huerta, trabajo, intervalo_surcos, creado_por) VALUES (?, ?, ?, ?)',
      [nombreHuerta, trabajoTexto, intervalo, (nombreUsuario || '').toString().trim() || null]
    );
    return { success: true, id: result.insertId };
  } catch (err) {
    return { success: false, error: err.toString() };
  }
}

async function eliminarActividadCatalogo(code, nombreUsuario, id) {
  await requierePermisoPanel_(code, nombreUsuario, 'avance_huerta', 'capturar');
  const idNum = Number(id);
  if (!idNum) return { success: false, error: 'Falta indicar qué actividad del catálogo borrar.' };
  // No borra las asignaciones (huerta_actividades) que ya se hubieran
  // hecho con esta actividad -- solo deja de estar disponible para
  // asignar de nuevo; cada cuadro sigue viendo lo que ya tenía.
  await pool.query('DELETE FROM actividades_catalogo WHERE id = ?', [idNum]);
  return { success: true };
}

// Catálogo de equipos/implementos/operadores para el paso "Detalle de
// trabajo" al planificar una actividad (ver asignarActividadCatalogoACuadros
// más abajo) -- a propósito pide solo permiso de 'avance_huerta' (no
// 'maquinaria'/'catalogo', como getMaquinaria/getUsuariosOperadoresApp),
// para que alguien con acceso nada más a Avance Huerta pueda planificar
// trabajo sin que le haga falta también permiso sobre el Catálogo completo.
// ------------------------------------------------------------
// Equipos para Avance de huerta -- petición de Carlos (oct-2026): "para
// seleccionar los equipos para el avance huerta sea únicamente tractores y
// retroexcavadora". Se decide con el TIPO DE UNIDAD capturado en
// Maquinaria (maquinaria.tipo_unidad: "Tractor", "Retro",
// "Retroexcavadora"... sin importar mayúsculas). Protección: si NINGÚN
// equipo tiene todavía tipo Tractor/Retro capturado, se regresa la lista
// de antes (todo lo que no es implemento) para no dejar a nadie sin poder
// iniciar su recorrido -- `filtradoPorTipo` dice cuál de los 2 casos fue.
function esEquipoAvanceHuerta_(tipoUnidad) {
  return /tractor|retro/i.test((tipoUnidad || '').toString());
}

async function equiposAvanceHuerta_() {
  const [rows] = await pool.query(
    'SELECT codigo_unidad AS CodigoUnidad, unidad AS Unidad, tipo_unidad AS TipoUnidad, color_mapa AS ColorMapa FROM maquinaria ORDER BY unidad'
  );
  const porTipo = rows.filter((r) => esEquipoAvanceHuerta_(r.TipoUnidad));
  const filtradoPorTipo = porTipo.length > 0;
  const lista = filtradoPorTipo ? porTipo : rows.filter((r) => !esImplemento_(r.Unidad));
  const colores = {};
  rows.forEach((r) => { if (colorMapaValido_(r.ColorMapa)) colores[r.CodigoUnidad] = r.ColorMapa.toLowerCase(); });
  return {
    filtradoPorTipo,
    equipos: lista.map((r) => ({ codigo: r.CodigoUnidad, unidad: r.Unidad, tipo: r.TipoUnidad || null })),
    colores,
    implementos: rows.filter((r) => esImplemento_(r.Unidad)).map((r) => ({ codigo: r.CodigoUnidad, unidad: r.Unidad })),
  };
}

// Abierta (sin permiso especial, solo lectura): la usan el celular (para
// ofrecer solo tractores/retros al iniciar un recorrido) y el Panel (para
// los colores de cada equipo en el mapa).
async function getEquiposAvanceHuerta() {
  const r = await equiposAvanceHuerta_();
  return { filtradoPorTipo: r.filtradoPorTipo, equipos: r.equipos, colores: r.colores };
}

// Colores de cada equipo en el mapa de Avance de huerta -- petición de
// Carlos (oct-2026): "poder cambiarles los colores al traslado, esos que se
// asignen conforme el tractor". Se guarda en maquinaria.color_mapa
// ('#rrggbb'), así todos los que ven el Panel ven el mismo color. null =
// quitar el color propio (vuelve al automático).
function colorMapaValido_(c) {
  return typeof c === 'string' && /^#[0-9a-f]{6}$/i.test(c.trim());
}

async function guardarColorEquipoMapa(code, nombreUsuario, codigoUnidad, color) {
  await requierePermisoPanel_(code, nombreUsuario, 'avance_huerta', 'capturar');
  const codigo = (codigoUnidad || '').toString().trim();
  if (!codigo) return { success: false, error: 'Falta indicar el equipo.' };
  let valor = null;
  if (color !== null && color !== undefined && color !== '') {
    if (!colorMapaValido_(color)) return { success: false, error: 'El color no es válido (debe ser como #1f6fd6).' };
    valor = color.trim().toLowerCase();
  }
  const [res] = await pool.query('UPDATE maquinaria SET color_mapa = ? WHERE codigo_unidad = ?', [valor, codigo]);
  if (!res.affectedRows) return { success: false, error: 'Ese equipo ya no existe en Maquinaria.' };
  return { success: true, color: valor };
}

async function getRecursosParaAvanceHuerta(code, nombreUsuario) {
  await requierePermisoPanel_(code, nombreUsuario, 'avance_huerta', 'visualizar');
  const r = await equiposAvanceHuerta_();
  const equipos = r.equipos.map((e) => ({ codigo: e.codigo, unidad: e.unidad }));
  const implementos = r.implementos;
  const [usuarios] = await pool.query('SELECT nombre, modulos FROM usuarios ORDER BY nombre');
  const operadores = usuarios.filter((u) => u.nombre && tieneAccesoModulo_(u.modulos, 'Reportar')).map((u) => u.nombre);
  return { equipos, implementos, operadores, equiposFiltradosPorTipo: r.filtradoPorTipo };
}

// Crea, para CADA cuadro en cuadroIds, una fila de huerta_actividades a
// partir de una actividad ya dada de alta en el catálogo -- mismo criterio
// de avance histórico ya cubierto que guardarActividadHuerta (si el
// operador ya había recorrido ese cuadro antes de asignarla, la actividad
// nace con ese avance ya contado, o de una vez "completada" si ya
// alcanza). Un cuadro que ya tuviera ESA MISMA actividad del catálogo
// asignada se ignora (se cuenta en "omitidas"), para poder reintentar o
// agregar más cuadros después sin duplicar por error.
async function asignarActividadCatalogoACuadros(code, nombreUsuario, huerta, actividadCatalogoId, cuadroIds, equipoCodigo, implementoCodigo, operadorNombre) {
  await requierePermisoPanel_(code, nombreUsuario, 'avance_huerta', 'capturar');
  const nombreHuerta = (huerta || '').toString().trim();
  const catalogoId = Number(actividadCatalogoId);
  const lista = Array.isArray(cuadroIds) ? Array.from(new Set(cuadroIds.map((c) => Number(c)).filter(Boolean))) : [];
  // "Detalle de trabajo" (petición de Carlos, al estilo del planificador de
  // John Deere): equipo/implemento/operador quedan OPCIONALES -- si se
  // dejan vacíos, el avance de la actividad se sigue acreditando con
  // cualquier recorrido, igual que antes (ver marcarCuadrosCompletadosPorPunto_).
  const equipo = (equipoCodigo || '').toString().trim() || null;
  const implemento = (implementoCodigo || '').toString().trim() || null;
  const operador = (operadorNombre || '').toString().trim() || null;
  if (!nombreHuerta) return { success: false, error: 'Falta indicar la huerta.' };
  if (!catalogoId) return { success: false, error: 'Falta indicar qué actividad del catálogo asignar.' };
  if (!lista.length) return { success: false, error: 'Selecciona al menos un cuadro.' };
  const [catalogo] = await pool.query(
    'SELECT trabajo, intervalo_surcos FROM actividades_catalogo WHERE id = ? AND LOWER(TRIM(huerta)) = LOWER(TRIM(?))',
    [catalogoId, nombreHuerta]
  );
  if (catalogo.length === 0) return { success: false, error: 'Esa actividad ya no existe en el catálogo.' };
  const trabajo = catalogo[0].trabajo;
  const intervalo = intervaloSurcosValido_(catalogo[0].intervalo_surcos);

  const [yaAsignados] = await pool.query(
    'SELECT cuadro_id FROM huerta_actividades WHERE actividad_catalogo_id = ? AND cuadro_id IN (?)',
    [catalogoId, lista]
  );
  const yaAsignadosSet = new Set(yaAsignados.map((r) => r.cuadro_id));

  let creadas = 0;
  let omitidas = 0;
  const errores = [];
  for (const idCuadro of lista) {
    if (yaAsignadosSet.has(idCuadro)) { omitidas++; continue; }
    const [cuadros] = await pool.query('SELECT poligono, surcos FROM huerta_cuadros WHERE id = ?', [idCuadro]);
    if (cuadros.length === 0) { errores.push('Un cuadro seleccionado ya no existe.'); continue; }
    try {
      const [result] = await pool.query(
        'INSERT INTO huerta_actividades (huerta, cuadro_id, trabajo, creado_por, intervalo_surcos, actividad_catalogo_id, equipo_codigo, implemento_codigo, operador_nombre) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [nombreHuerta, idCuadro, trabajo, (nombreUsuario || '').toString().trim() || null, intervalo, catalogoId, equipo, implemento, operador]
      );
      // A propósito YA NO se revisa el histórico de recorridos de la
      // huerta para "adelantar" el avance de esta actividad -- petición de
      // Carlos: antes, si CUALQUIER recorrido viejo (de otra actividad, o
      // de hace tiempo) había tocado el cuadro, nacía "completada" sola,
      // lo cual confundía (cuadros marcados completados que en realidad
      // nadie había trabajado para ESTA actividad). Ahora toda actividad
      // nueva nace "pendiente" en 0, y solo avanza con los recorridos que
      // se hagan DE AQUÍ EN ADELANTE (ver marcarCuadrosCompletadosPorPunto_).
      creadas++;
    } catch (err) {
      errores.push(err.toString());
    }
  }
  return { success: true, creadas, omitidas, errores };
}

// Acción del Panel (asignar una actividad/trabajo a un cuadro ya
// dibujado, con cada cuántos surcos cuenta como una pasada para ESA
// actividad -- ver comentario junto a calcularDistanciaTotalEsperadaMetros_
// más arriba). Se deja esta función de un solo cuadro por compatibilidad;
// el flujo nuevo desde el Panel es por el catálogo (asignarActividadCatalogoACuadros).
// Nace "pendiente" en 0 -- a propósito YA NO revisa el histórico de
// recorridos viejos de la huerta para adelantar el avance (ver el
// comentario junto a "creadas++" en asignarActividadCatalogoACuadros,
// mismo motivo: petición de Carlos, le confundía que una actividad recién
// creada apareciera "completada" sola por un recorrido de otra actividad
// o de hace tiempo).
async function guardarActividadHuerta(code, nombreUsuario, huerta, cuadroId, trabajo, intervaloSurcos) {
  await requierePermisoPanel_(code, nombreUsuario, 'avance_huerta', 'capturar');
  const nombreHuerta = (huerta || '').toString().trim();
  const idCuadro = Number(cuadroId);
  const trabajoTexto = (trabajo || '').toString().trim();
  const intervalo = intervaloSurcosValido_(intervaloSurcos);
  if (!nombreHuerta) return { success: false, error: 'Falta indicar la huerta.' };
  if (!idCuadro) return { success: false, error: 'Falta indicar a qué cuadro corresponde.' };
  if (!trabajoTexto) return { success: false, error: 'Falta describir la actividad.' };
  const [cuadros] = await pool.query('SELECT poligono, surcos FROM huerta_cuadros WHERE id = ?', [idCuadro]);
  if (cuadros.length === 0) return { success: false, error: 'Ese cuadro ya no existe.' };
  try {
    const [result] = await pool.query(
      'INSERT INTO huerta_actividades (huerta, cuadro_id, trabajo, creado_por, intervalo_surcos) VALUES (?, ?, ?, ?, ?)',
      [nombreHuerta, idCuadro, trabajoTexto, (nombreUsuario || '').toString().trim() || null, intervalo]
    );
    return { success: true, id: result.insertId, completadaDeInmediato: false };
  } catch (err) {
    return { success: false, error: err.toString() };
  }
}

async function eliminarActividadHuerta(code, nombreUsuario, actividadId) {
  await requierePermisoPanel_(code, nombreUsuario, 'avance_huerta', 'capturar');
  const id = Number(actividadId);
  if (!id) return { success: false, error: 'Falta indicar qué actividad borrar.' };
  await pool.query('DELETE FROM huerta_actividades WHERE id = ?', [id]);
  return { success: true };
}

// Abierta (sin permiso especial) -- la usan tanto el Panel como el celular
// (de solo lectura, para que el operador vea qué se le pidió y cómo va).
// porcentaje/avanceMetros/distanciaTotalEsperada se calculan al vuelo
// (nunca quedan "viejos" si Carlos luego cambia el número de surcos del
// cuadro). distanciaTotalEsperada es null cuando ese cuadro no tiene
// surcos capturados -- ahí porcentaje se queda en 0 o 100 (el criterio
// binario de siempre, por estado).
async function getActividadesHuerta(huerta) {
  const nombreHuerta = (huerta || '').toString().trim();
  if (!nombreHuerta) return [];
  const [rows] = await pool.query(
    `SELECT a.id, a.cuadro_id, c.nombre AS cuadroNombre, c.poligono AS cuadroPoligono, c.surcos AS cuadroSurcos,
            a.trabajo, a.estado, a.intervalo_surcos, a.avance_metros, a.avance_pasadas, a.creado_en, a.completado_en, a.actividad_catalogo_id,
            a.equipo_codigo, me.unidad AS equipoUnidad,
            a.implemento_codigo, mi.unidad AS implementoUnidad,
            a.operador_nombre
     FROM huerta_actividades a
     JOIN huerta_cuadros c ON c.id = a.cuadro_id
     LEFT JOIN maquinaria me ON me.codigo_unidad = a.equipo_codigo
     LEFT JOIN maquinaria mi ON mi.codigo_unidad = a.implemento_codigo
     WHERE LOWER(TRIM(a.huerta)) = LOWER(TRIM(?))
     ORDER BY c.nombre, a.creado_en`,
    [nombreHuerta]
  );
  return rows.map((r) => {
    const poligono = parsearPoligono_(r.cuadroPoligono);
    const esperado = calcularDistanciaTotalEsperadaMetros_(poligono, r.cuadroSurcos, r.intervalo_surcos);
    const avanceMetros = Number(r.avance_metros) || 0;
    const necesarias = pasadasNecesarias_(r.cuadroSurcos, r.intervalo_surcos);
    const pasadas = Number(r.avance_pasadas) || 0;
    // % = pasadas hechas / pasadas necesarias (p.ej. 4 de 33 = 12.12%),
    // con 2 decimales.
    const porcentaje = r.estado === 'completado'
      ? 100
      : (necesarias ? Math.max(0, Math.min(100, (pasadas / necesarias) * 100)) : 0);
    return {
      id: r.id,
      cuadroId: r.cuadro_id,
      cuadroNombre: r.cuadroNombre,
      trabajo: r.trabajo,
      estado: r.estado,
      // true = el cuadro no tiene surcos capturados: su avance no se puede
      // medir en % y la actividad no se completa sola (ver
      // marcarCuadrosCompletadosPorPunto_) hasta que se capturen.
      sinSurcos: necesarias === null,
      surcos: r.cuadroSurcos,
      intervaloSurcos: intervaloSurcosValido_(r.intervalo_surcos),
      avanceMetros,
      distanciaTotalEsperada: esperado,
      pasadas: Math.round(pasadas * 100) / 100,
      pasadasNecesarias: necesarias,
      porcentaje: Math.round(porcentaje * 100) / 100,
      creadoEn: r.creado_en,
      completadoEn: r.completado_en,
      actividadCatalogoId: r.actividad_catalogo_id,
      equipoCodigo: r.equipo_codigo,
      equipoUnidad: r.equipoUnidad,
      implementoCodigo: r.implemento_codigo,
      implementoUnidad: r.implementoUnidad,
      operadorNombre: r.operador_nombre,
    };
  });
}

// asignado = lo que quedó capturado en la actividad (equipo_codigo u
// operador_nombre); real = lo que trae ESTE recorrido (avance_huerta
// codigo_unidad/nombre). Si la actividad no pidió nada en especial
// (asignado vacío), siempre coincide -- así el comportamiento de siempre
// (cualquier recorrido cuenta) se mantiene para toda actividad sin
// equipo/operador asignado.
function coincideConAsignado_(asignado, real) {
  const a = (asignado || '').toString().trim().toLowerCase();
  if (!a) return true;
  const r = (real || '').toString().trim().toLowerCase();
  return a === r;
}

// Se llama desde agregarPuntoAvance después de guardar cada punto nuevo
// del recorrido (ver abajo) -- SIN que el operador haga nada. Solo revisa
// los cuadros de esa huerta que todavía tengan alguna actividad pendiente
// (evita trabajo de más sobre cuadros ya completados o sin actividades).
// Por cada cuadro que el punto nuevo cubre, mide el tramo recorrido DENTRO
// de él (contra el punto anterior de ESTA MISMA sesión, si también lo
// cubría -- así no se cuenta de golpe la entrada desde fuera como avance
// sobre los surcos) y lo suma al avance_metros de cada actividad pendiente
// de ese cuadro; si con eso ya alcanza lo esperado (o el cuadro no tiene
// surcos capturados, el criterio binario de siempre) la marca completada.
// Regresa la lista de actividades que se acaban de completar con este
// punto, para que el celular pueda, si quiere, avisarle algo al operador.
//
// avanceNombre/avanceEquipo: quién y con qué equipo se está haciendo ESTE
// recorrido (avance_huerta.nombre/.codigo_unidad). Petición de Carlos: si
// una actividad quedó planificada con un equipo y/o un operador específico
// (huerta_actividades.equipo_codigo/.operador_nombre, ver "Detalle de
// trabajo" en el Panel), su avance SOLO debe subir cuando coincide con lo
// asignado -- si la actividad no tiene equipo y/o operador asignado, ese
// lado no filtra (sigue contando cualquiera, como siempre). Ver
// coincideConAsignado_ más abajo.
async function marcarCuadrosCompletadosPorPunto_(huerta, avanceId, lat, lng, avanceNombre, avanceEquipo, tPuntoMs, avanceTrabajo) {
  const actual = { lat, lng };
  const [cuadros] = await pool.query(
    `SELECT c.id, c.nombre AS cuadroNombre, c.poligono, c.surcos, c.direccion_surcos FROM huerta_cuadros c
     WHERE LOWER(TRIM(c.huerta)) = LOWER(TRIM(?))
       AND EXISTS (SELECT 1 FROM huerta_actividades a WHERE a.cuadro_id = c.id AND a.estado = 'pendiente')`,
    [huerta]
  );
  // El tramo se mide desde el "ancla" del recorrido (avance_huerta.ancla_*),
  // no desde el punto inmediato anterior: ver AVANCE_TRAMO_MINIMO_METROS.
  const [anclas] = await pool.query('SELECT ancla_lat, ancla_lng, ancla_en FROM avance_huerta WHERE id = ?', [avanceId]);
  const anterior = (anclas.length && anclas[0].ancla_lat !== null)
    ? { lat: Number(anclas[0].ancla_lat), lng: Number(anclas[0].ancla_lng) }
    : null;
  const tPunto = Number.isFinite(Number(tPuntoMs)) ? new Date(Number(tPuntoMs)) : new Date();
  const completadas = [];
  const moverAncla = () => pool.query('UPDATE avance_huerta SET ancla_lat = ?, ancla_lng = ?, ancla_en = ? WHERE id = ?', [lat, lng, tPunto, avanceId]);
  if (!anterior) {
    // Primer punto de la sesión: queda como ancla, todavía no hay tramo.
    await moverAncla();
    return completadas;
  }
  const distancia = distanciaMetros_(anterior, actual);
  if (distancia < AVANCE_TRAMO_MINIMO_METROS) {
    // Sigue cerca del ancla: solo se actualiza CUÁNDO se vio ahí por última
    // vez (para medir bien la velocidad de un brinco; ver abajo).
    await pool.query('UPDATE avance_huerta SET ancla_en = ? WHERE id = ? AND (ancla_en IS NULL OR ancla_en < ?)', [tPunto, avanceId, tPunto]);
    return completadas;
  }
  // Brinco del GPS (oct-2026: el CUADRO 05, junto a las bodegas, se marcó
  // "Completado" con los brincos ida y vuelta de la ubicación "de red"): un
  // tramo que implicaría ir a más de VELOCIDAD_MAX_TRACTOR_MS NO suma avance.
  // Mismo criterio que filtrarSaltosGps_ (que no se puede usar aquí porque
  // se calcula punto por punto). Si el ancla es reciente (< 60 s) se ignora
  // el punto y el ancla se queda en el último punto bueno; si ya pasó más
  // tiempo (de verdad se movió, p.ej. tras un hueco sin señal), solo se
  // reubica el ancla, sin acreditar ese tramo.
  const anclaEn = anclas[0].ancla_en ? new Date(anclas[0].ancla_en) : null;
  if (anclaEn && distancia > SALTO_GPS_MIN_METROS) {
    const dt = (tPunto.getTime() - anclaEn.getTime()) / 1000;
    if (dt <= 0 || distancia / dt > VELOCIDAD_MAX_TRACTOR_MS) {
      if (dt < 60) return completadas;
      await moverAncla();
      return completadas;
    }
  }
  await moverAncla();
  if (cuadros.length === 0) return completadas;
  for (const c of cuadros) {
    const poligono = parsearPoligono_(c.poligono);
    // Ver avanceDeTramo_: solo la parte del tramo DENTRO del cuadro, en
    // fracción de pasada (atravesada completa = 1).
    const tramo = avanceDeTramo_(anterior, actual, poligono, c.direccion_surcos);
    if (tramo.pasadas <= 0) continue;
    const [actividades] = await pool.query(
      `SELECT id, trabajo, intervalo_surcos, avance_metros, avance_pasadas, equipo_codigo, operador_nombre FROM huerta_actividades WHERE cuadro_id = ? AND estado = 'pendiente'`,
      [c.id]
    );
    for (const act of actividades) {
      if (!mismoTrabajoAvance_(avanceTrabajo, act.trabajo)) continue; // solo la actividad de ESTE recorrido
      if (!coincideConAsignado_(act.equipo_codigo, avanceEquipo) || !coincideConAsignado_(act.operador_nombre, avanceNombre)) continue;
      const necesarias = pasadasNecesarias_(c.surcos, act.intervalo_surcos);
      const nuevasPasadas = (Number(act.avance_pasadas) || 0) + tramo.pasadas;
      const nuevosMetros = (Number(act.avance_metros) || 0) + tramo.metros;
      // Cuadro SIN surcos capturados (necesarias === null): ya NO se
      // completa solo con pasar por él (petición de Carlos, oct-2026). Se
      // queda pendiente, pero las pasadas SÍ se siguen sumando, para que en
      // cuanto Carlos capture sus surcos (actualizarSurcosCuadro) el %
      // refleje lo que ya se trabajó.
      const completado = necesarias !== null && nuevasPasadas >= necesarias - margenCompletado_(necesarias);
      if (completado) {
        await pool.query(
          `UPDATE huerta_actividades SET estado = 'completado', completado_en = NOW(), avance_id = ?, avance_metros = ?, avance_pasadas = ? WHERE id = ?`,
          [avanceId, nuevosMetros, Math.min(nuevasPasadas, necesarias), act.id]
        );
        completadas.push({ id: act.id, cuadroNombre: c.cuadroNombre, trabajo: act.trabajo });
      } else {
        await pool.query('UPDATE huerta_actividades SET avance_metros = ?, avance_pasadas = ? WHERE id = ?', [nuevosMetros, nuevasPasadas, act.id]);
      }
    }
  }
  return completadas;
}

// ------------------------------------------------------------
// Recalcula DESDE CERO el avance de las actividades de cuadros, a partir
// del histórico de GPS ya guardado (avance_huerta_puntos), con las reglas
// actuales de marcarCuadrosCompletadosPorPunto_ (margen chico de borde,
// cuadros sin surcos ya no se completan solos). Petición de Carlos
// (oct-2026): corregir las actividades que quedaron "Completado" con la
// regla vieja solo por haber pasado por la orilla del cuadro.
//
// Por cada actividad: toma solo los recorridos de ESA huerta que
// coincidan con el equipo/operador asignado (si tiene), y de cada uno solo
// los puntos capturados DESDE que se creó la actividad (igual que en vivo:
// nada de "adelantar" con recorridos de antes). Suma metros con
// avanceDeTramo_ (pasadas) en orden cronológico; si llega a las pasadas
// necesarias, la marca completada con la hora del punto en que lo alcanzó.
//
// aplicar = false -> NO cambia nada, solo regresa la lista de cambios que
// HARÍA (para revisarlos antes). aplicar = true -> además los guarda.
// Termina en "_" a propósito: no se expone por HTTP (ver server.js); solo
// la usa el script recalcular_avance_cuadros_nube.js.
// opciones.cuadroId (opcional): solo las actividades de ese cuadro (lo usa
// guardarDireccionSurcosCuadro para recalcular en cuanto cambia la
// dirección de sus surcos).
async function recalcularAvanceActividadesHuerta_(aplicar, opciones) {
  const soloCuadro = opciones && Number(opciones.cuadroId) ? Number(opciones.cuadroId) : null;
  const [acts] = await pool.query(
    `SELECT a.id, a.huerta, a.trabajo, a.estado, a.creado_en, a.completado_en, a.intervalo_surcos, a.avance_metros, a.avance_pasadas,
            a.equipo_codigo, a.operador_nombre, c.nombre AS cuadroNombre, c.poligono, c.surcos, c.direccion_surcos
     FROM huerta_actividades a JOIN huerta_cuadros c ON c.id = a.cuadro_id
     ${soloCuadro ? 'WHERE c.id = ?' : ''}
     ORDER BY a.huerta, c.nombre, a.id`,
    soloCuadro ? [soloCuadro] : []
  );
  const sesionesPorHuerta = {};
  async function sesionesDe_(huerta) {
    const clave = (huerta || '').toString().trim().toLowerCase();
    if (sesionesPorHuerta[clave]) return sesionesPorHuerta[clave];
    const [sesiones] = await pool.query(
      'SELECT id, nombre, codigo_unidad, trabajo, fecha_inicio FROM avance_huerta WHERE LOWER(TRIM(huerta)) = ? ORDER BY fecha_inicio, id',
      [clave]
    );
    const ids = sesiones.map((x) => x.id);
    const puntosPorSesion = {};
    if (ids.length) {
      const [puntos] = await pool.query(
        'SELECT avance_id, lat, lng, capturado_en FROM avance_huerta_puntos WHERE avance_id IN (?) ORDER BY avance_id, capturado_en, id',
        [ids]
      );
      puntos.forEach((p) => {
        if (!puntosPorSesion[p.avance_id]) puntosPorSesion[p.avance_id] = [];
        puntosPorSesion[p.avance_id].push({ lat: Number(p.lat), lng: Number(p.lng), t: new Date(p.capturado_en) });
      });
    }
    sesionesPorHuerta[clave] = sesiones.map((x) => ({ ...x, puntos: filtrarSaltosGps_(puntosPorSesion[x.id] || []) }));
    return sesionesPorHuerta[clave];
  }

  const cambios = [];
  for (const a of acts) {
    const poligono = parsearPoligono_(a.poligono);
    const necesarias = pasadasNecesarias_(a.surcos, a.intervalo_surcos);
    const desde = new Date(a.creado_en);
    const sesiones = await sesionesDe_(a.huerta);
    let pasadas = 0;
    let metros = 0;
    let completadoEn = null;
    let avanceIdCompleto = null;
    for (const ses of sesiones) {
      if (completadoEn) break;
      if (!mismoTrabajoAvance_(ses.trabajo, a.trabajo)) continue; // solo recorridos de ESTA actividad
      if (!coincideConAsignado_(a.equipo_codigo, ses.codigo_unidad) || !coincideConAsignado_(a.operador_nombre, ses.nombre)) continue;
      for (const [pa, pb] of tramosDeRecorrido_(ses.puntos)) {
        if (pb.t < desde) continue;
        const tramo = avanceDeTramo_(pa, pb, poligono, a.direccion_surcos);
        if (tramo.pasadas <= 0) continue;
        pasadas += tramo.pasadas;
        metros += tramo.metros;
        if (necesarias !== null && pasadas >= necesarias - margenCompletado_(necesarias)) {
          completadoEn = pb.t;
          avanceIdCompleto = ses.id;
          break;
        }
      }
    }
    const nuevoEstado = completadoEn ? 'completado' : 'pendiente';
    const nuevasPasadas = Math.round((completadoEn ? Math.min(pasadas, necesarias) : pasadas) * 10000) / 10000;
    const nuevosMetros = Math.round(metros * 100) / 100;
    const pasadasAntes = Number(a.avance_pasadas) || 0;
    // Una actividad que YA estaba completada y lo sigue estando se deja
    // tal cual (no se le mueve la fecha de completado).
    if (a.estado === 'completado' && nuevoEstado === 'completado') continue;
    if (a.estado === nuevoEstado && Math.abs(pasadasAntes - nuevasPasadas) < 0.001) continue;
    const pct = necesarias ? Math.round(Math.max(0, Math.min(100, (nuevasPasadas / necesarias) * 100)) * 100) / 100 : null;
    cambios.push({
      id: a.id, huerta: a.huerta, cuadro: a.cuadroNombre, trabajo: a.trabajo,
      estadoAntes: a.estado, estadoDespues: nuevoEstado,
      pasadasDespues: Math.round(nuevasPasadas * 100) / 100, pasadasNecesarias: necesarias,
      porcentajeDespues: pct, sinSurcos: necesarias === null,
    });
    if (aplicar) {
      if (nuevoEstado === 'completado') {
        await pool.query(
          `UPDATE huerta_actividades SET estado = 'completado', completado_en = ?, avance_id = ?, avance_metros = ?, avance_pasadas = ? WHERE id = ?`,
          [completadoEn, avanceIdCompleto, nuevosMetros, nuevasPasadas, a.id]
        );
      } else {
        await pool.query(
          `UPDATE huerta_actividades SET estado = 'pendiente', completado_en = NULL, avance_id = NULL, avance_metros = ?, avance_pasadas = ? WHERE id = ?`,
          [nuevosMetros, nuevasPasadas, a.id]
        );
      }
    }
  }
  return cambios;
}

async function getDepartamentosCatalogo(code, nombreUsuario) { return catalogoDepartamentos_.get(code, nombreUsuario); }
async function guardarDepartamento(code, nombreUsuario, id, data) { return catalogoDepartamentos_.guardar(code, nombreUsuario, id, data); }
async function eliminarDepartamento(code, nombreUsuario, id) { return catalogoDepartamentos_.eliminar(code, nombreUsuario, id); }

// Tipos de unidad ya NO es un catálogo simple puro — además de nombre,
// lleva una Categoría ('agricola' | 'automotriz' | sin asignar) que usa
// clasificarReporteAutomatico_ (ver arriba) para decidir solo, sin
// preguntarle nada a quien reporta desde el celular, si un reporte nuevo
// de un equipo con ese tipo de unidad es Agrícola o Automotriz — así que
// get/guardar tienen su propia implementación en vez de usar
// fabricaCatalogoSimple_ (eliminar sí la sigue usando, no cambia).
async function getTiposUnidad(code, nombreUsuario) {
  await requierePermisoPanel_(code, nombreUsuario, PESTANAS_CATALOGO_OPERATIVO_, 'visualizar');
  const [rows] = await pool.query('SELECT id AS Id, nombre AS Nombre, categoria AS Categoria FROM tipos_unidad ORDER BY nombre');
  return rows.map((r) => ({ Id: r.Id, Nombre: r.Nombre, Categoria: r.Categoria || '' }));
}

async function guardarTipoUnidad(code, nombreUsuario, id, data) {
  await requierePermisoPanel_(code, nombreUsuario, PESTANAS_CATALOGO_OPERATIVO_, 'capturar');
  data = data || {};
  try {
    const nombre = (data.nombre || '').toString().trim();
    if (!nombre) return { success: false, error: 'Escribe el nombre de el tipo de unidad.' };
    const categoriaTxt = (data.categoria || '').toString().trim().toLowerCase();
    const categoria = (categoriaTxt === 'agricola' || categoriaTxt === 'automotriz') ? categoriaTxt : null;
    if (id) {
      await pool.query('UPDATE tipos_unidad SET nombre=?, categoria=? WHERE id=?', [nombre, categoria, id]);
      return { success: true, id: Number(id) };
    }
    const [result] = await pool.query('INSERT INTO tipos_unidad (nombre, categoria) VALUES (?, ?)', [nombre, categoria]);
    return { success: true, id: result.insertId };
  } catch (err) {
    if (err && err.code === 'ER_DUP_ENTRY') {
      return { success: false, error: 'Ya existe el tipo de unidad con ese nombre.' };
    }
    return { success: false, error: err.toString() };
  }
}

async function eliminarTipoUnidad(code, nombreUsuario, id) { return catalogoTiposUnidad_.eliminar(code, nombreUsuario, id); }

// Operadores ya NO es un catálogo simple puro — además de nombre, trae
// dirección/teléfono (datos de contacto) y a qué flotilla pertenece
// ('AGRICOLA' | 'VEHICULAR', ver db/schema.sql) — así que get/guardar
// tienen su propia implementación en vez de usar fabricaCatalogoSimple_
// (mismo patrón que Huertas con empresa/proveedor; eliminar sí la sigue
// usando, no cambia).
async function getOperadoresCatalogo(code, nombreUsuario) {
  await requierePermisoPanel_(code, nombreUsuario, PESTANAS_CATALOGO_OPERATIVO_, 'visualizar');
  const [rows] = await pool.query(
    'SELECT id AS Id, nombre AS Nombre, direccion AS Direccion, telefono AS Telefono, flotilla AS Flotilla FROM operadores ORDER BY nombre'
  );
  return rows;
}

async function guardarOperador(code, nombreUsuario, id, data) {
  await requierePermisoPanel_(code, nombreUsuario, PESTANAS_CATALOGO_OPERATIVO_, 'capturar');
  data = data || {};
  try {
    const nombre = (data.nombre || '').toString().trim();
    if (!nombre) return { success: false, error: 'Escribe el nombre del operador.' };
    const direccion = (data.direccion || '').toString().trim() || null;
    const telefono = (data.telefono || '').toString().trim() || null;
    const flotillasValidas = ['AGRICOLA', 'VEHICULAR'];
    const flotilla =
      data.flotilla && flotillasValidas.indexOf(String(data.flotilla).toUpperCase()) !== -1
        ? String(data.flotilla).toUpperCase()
        : null;
    if (id) {
      await pool.query('UPDATE operadores SET nombre=?, direccion=?, telefono=?, flotilla=? WHERE id=?', [nombre, direccion, telefono, flotilla, id]);
      return { success: true, id: Number(id) };
    }
    const [result] = await pool.query(
      'INSERT INTO operadores (nombre, direccion, telefono, flotilla) VALUES (?, ?, ?, ?)',
      [nombre, direccion, telefono, flotilla]
    );
    return { success: true, id: result.insertId };
  } catch (err) {
    if (err && err.code === 'ER_DUP_ENTRY') {
      return { success: false, error: 'Ya existe un operador con ese nombre.' };
    }
    return { success: false, error: err.toString() };
  }
}

async function eliminarOperador(code, nombreUsuario, id) { return catalogoOperadores_.eliminar(code, nombreUsuario, id); }

async function getEmpresasCatalogo(code, nombreUsuario) { return catalogoEmpresas_.get(code, nombreUsuario); }
async function guardarEmpresa(code, nombreUsuario, id, data) { return catalogoEmpresas_.guardar(code, nombreUsuario, id, data); }
async function eliminarEmpresa(code, nombreUsuario, id) { return catalogoEmpresas_.eliminar(code, nombreUsuario, id); }

async function getProveedoresCombustibleCatalogo(code, nombreUsuario) { return catalogoProveedoresCombustible_.get(code, nombreUsuario); }
async function guardarProveedorCombustible(code, nombreUsuario, id, data) { return catalogoProveedoresCombustible_.guardar(code, nombreUsuario, id, data); }
async function eliminarProveedorCombustible(code, nombreUsuario, id) { return catalogoProveedoresCombustible_.eliminar(code, nombreUsuario, id); }

// El catálogo de marcas/modelos lo administra la pestaña Refacciones, y
// también se puede administrar desde Catálogo y Maquinaria (para elegir o
// dar de alta la marca/modelo de un equipo, y para el "+" del modal de
// equipo) — mismo permiso para las tres.
const PESTANAS_CATALOGO_MARCAS_ = ['refacciones', 'maquinaria', 'catalogo', 'servicios_automotrices'];

async function getMarcas(code, nombreUsuario) {
  await requierePermisoPanel_(code, nombreUsuario, PESTANAS_CATALOGO_MARCAS_, 'visualizar');
  const [rows] = await pool.query('SELECT id AS Id, nombre AS Nombre FROM marcas_refacciones ORDER BY nombre');
  return rows.map((r) => ({ Id: r.Id, Nombre: r.Nombre }));
}

async function guardarMarca(code, nombreUsuario, id, data) {
  await requierePermisoPanel_(code, nombreUsuario, PESTANAS_CATALOGO_MARCAS_, 'capturar');
  data = data || {};
  try {
    const nombre = (data.nombre || '').toString().trim();
    if (!nombre) return { success: false, error: 'Escribe el nombre de la marca.' };

    if (id) {
      await pool.query('UPDATE marcas_refacciones SET nombre=? WHERE id=?', [nombre, id]);
      return { success: true, id: Number(id) };
    }

    const [result] = await pool.query('INSERT INTO marcas_refacciones (nombre) VALUES (?)', [nombre]);
    return { success: true, id: result.insertId };
  } catch (err) {
    if (err && err.code === 'ER_DUP_ENTRY') {
      return { success: false, error: 'Ya existe una marca con ese nombre.' };
    }
    return { success: false, error: err.toString() };
  }
}

async function eliminarMarca(code, nombreUsuario, id) {
  await requierePermisoPanel_(code, nombreUsuario, PESTANAS_CATALOGO_MARCAS_, 'capturar');
  const [modelos] = await pool.query('SELECT id FROM modelos_refacciones WHERE marca_id = ?', [id]);
  const modeloIds = modelos.map((m) => m.id);
  if (modeloIds.length > 0) {
    await pool.query('DELETE FROM refacciones_modelos WHERE modelo_id IN (?)', [modeloIds]);
  }
  await pool.query('DELETE FROM modelos_refacciones WHERE marca_id = ?', [id]);
  await pool.query('UPDATE refacciones SET marca_id = NULL WHERE marca_id = ?', [id]);
  await pool.query('DELETE FROM marcas_refacciones WHERE id = ?', [id]);
  return { success: true };
}

async function getModelos(code, nombreUsuario) {
  await requierePermisoPanel_(code, nombreUsuario, PESTANAS_CATALOGO_MARCAS_, 'visualizar');
  // EsAutomotriz: si ALGÚN equipo de este modelo tiene usa_gasolina = 1
  // (mismo criterio que Combustible Automotriz) — lo usa la pestaña
  // "Servicios Automotrices" para mostrar en su selector de modelo solo
  // los modelos de vehículos, y Preventivos Agrícolas para lo contrario
  // (ver pobladoSelectoresModeloMnt_/pobladoSelectoresModeloAuto_ en
  // Panel.html). No cambia nada para quien ya usaba este listado tal cual.
  const [rows] = await pool.query(`
    SELECT m.id AS Id, m.marca_id AS MarcaId, m.nombre AS Nombre,
      EXISTS(SELECT 1 FROM maquinaria mm WHERE mm.modelo_id = m.id AND mm.usa_gasolina = 1) AS EsAutomotriz
    FROM modelos_refacciones m
    ORDER BY m.nombre
  `);
  return rows.map((r) => ({ Id: r.Id, MarcaId: r.MarcaId, Nombre: r.Nombre, EsAutomotriz: !!r.EsAutomotriz }));
}

async function guardarModelo(code, nombreUsuario, id, data) {
  await requierePermisoPanel_(code, nombreUsuario, PESTANAS_CATALOGO_MARCAS_, 'capturar');
  data = data || {};
  try {
    const nombre = (data.nombre || '').toString().trim();
    if (!nombre) return { success: false, error: 'Escribe el nombre del modelo.' };
    const marcaId = (data.marcaId === '' || data.marcaId === undefined || data.marcaId === null)
      ? null : Number(data.marcaId);
    if (!marcaId) return { success: false, error: 'Elige a qué marca pertenece este modelo.' };

    if (id) {
      await pool.query('UPDATE modelos_refacciones SET marca_id=?, nombre=? WHERE id=?', [marcaId, nombre, id]);
      return { success: true, id: Number(id) };
    }

    const [result] = await pool.query(
      'INSERT INTO modelos_refacciones (marca_id, nombre) VALUES (?, ?)',
      [marcaId, nombre]
    );
    return { success: true, id: result.insertId };
  } catch (err) {
    if (err && err.code === 'ER_DUP_ENTRY') {
      return { success: false, error: 'Esa marca ya tiene un modelo con ese nombre.' };
    }
    return { success: false, error: err.toString() };
  }
}

async function eliminarModelo(code, nombreUsuario, id) {
  await requierePermisoPanel_(code, nombreUsuario, PESTANAS_CATALOGO_MARCAS_, 'capturar');
  await pool.query('DELETE FROM refacciones_modelos WHERE modelo_id = ?', [id]);
  await pool.query('DELETE FROM modelos_refacciones WHERE id = ?', [id]);
  return { success: true };
}

// ---------------------------------------------------------------
// Proveedores: catálogo de contacto (dentro de la pestaña "Refacciones")
// ---------------------------------------------------------------

async function getProveedores(code, nombreUsuario) {
  // También lo usa el selector de "Atendió" en Llantas y Ponches /
  // Reparaciones con terceros (ver abrirModalEditarOrden en Panel.html), no
  // solo la pestaña Refacciones — por eso acepta cualquiera de los tres
  // permisos.
  await requierePermisoPanel_(code, nombreUsuario, ['refacciones', 'ordenes_llantas', 'ordenes_terceros'], 'visualizar');
  const [rows] = await pool.query(`
    SELECT id AS Id, nombre AS Nombre, correo AS Correo, telefono AS Telefono,
           contacto AS Contacto, marcas AS Marcas, notas AS Notas
    FROM proveedores
    ORDER BY nombre
  `);
  const [contactosRows] = await pool.query(`
    SELECT id AS Id, proveedor_id AS ProveedorId, nombre AS Nombre, correo AS Correo,
           telefono AS Telefono, notas AS Notas
    FROM proveedor_contactos
    ORDER BY nombre
  `);
  const contactosPorProveedor = {};
  contactosRows.forEach((c) => {
    if (!contactosPorProveedor[c.ProveedorId]) contactosPorProveedor[c.ProveedorId] = [];
    contactosPorProveedor[c.ProveedorId].push({
      Id: c.Id,
      Nombre: c.Nombre || '',
      Correo: c.Correo || '',
      Telefono: c.Telefono || '',
      Notas: c.Notas || '',
    });
  });
  return rows.map((r) => ({
    Id: r.Id,
    Nombre: r.Nombre,
    Correo: r.Correo || '',
    Telefono: r.Telefono || '',
    Contacto: r.Contacto || '',
    Marcas: r.Marcas || '',
    Notas: r.Notas || '',
    Contactos: contactosPorProveedor[r.Id] || [],
  }));
}

async function guardarProveedor(code, nombreUsuario, id, data) {
  await requierePermisoPanel_(code, nombreUsuario, 'refacciones', 'capturar');
  data = data || {};
  try {
    const nombre = (data.nombre || '').toString().trim();
    if (!nombre) return { success: false, error: 'Escribe el nombre del proveedor.' };
    const correo = (data.correo || '').toString().trim() || null;
    const telefono = (data.telefono || '').toString().trim() || null;
    const contacto = (data.contacto || '').toString().trim() || null;
    const marcas = (data.marcas || '').toString().trim() || null;
    const notas = (data.notas || '').toString().trim() || null;
    // Contactos adicionales: [{ nombre, correo, telefono, notas }, ...]
    const contactos = Array.isArray(data.contactos) ? data.contactos : [];

    let proveedorId = id ? Number(id) : null;

    if (proveedorId) {
      await pool.query(
        'UPDATE proveedores SET nombre=?, correo=?, telefono=?, contacto=?, marcas=?, notas=? WHERE id=?',
        [nombre, correo, telefono, contacto, marcas, notas, proveedorId]
      );
    } else {
      const [result] = await pool.query(
        'INSERT INTO proveedores (nombre, correo, telefono, contacto, marcas, notas) VALUES (?, ?, ?, ?, ?, ?)',
        [nombre, correo, telefono, contacto, marcas, notas]
      );
      proveedorId = result.insertId;
    }

    // Reemplaza por completo los contactos adicionales (borra y vuelve a
    // insertar), igual que la asignación de refacciones a una regla.
    await pool.query('DELETE FROM proveedor_contactos WHERE proveedor_id = ?', [proveedorId]);
    for (const c of contactos) {
      const cNombre = (c.nombre || '').toString().trim() || null;
      const cCorreo = (c.correo || '').toString().trim() || null;
      const cTelefono = (c.telefono || '').toString().trim() || null;
      const cNotas = (c.notas || '').toString().trim() || null;
      if (!cNombre && !cCorreo && !cTelefono) continue;
      await pool.query(
        'INSERT INTO proveedor_contactos (proveedor_id, nombre, correo, telefono, notas) VALUES (?, ?, ?, ?, ?)',
        [proveedorId, cNombre, cCorreo, cTelefono, cNotas]
      );
    }

    return { success: true, id: proveedorId };
  } catch (err) {
    return { success: false, error: err.toString() };
  }
}

async function eliminarProveedor(code, nombreUsuario, id) {
  await requierePermisoPanel_(code, nombreUsuario, 'refacciones', 'capturar');
  await pool.query('UPDATE refacciones SET proveedor_id = NULL WHERE proveedor_id = ?', [id]);
  await pool.query('DELETE FROM proveedor_contactos WHERE proveedor_id = ?', [id]);
  const [solicitudes] = await pool.query('SELECT id FROM solicitudes_cotizacion WHERE proveedor_id = ?', [id]);
  for (const s of solicitudes) {
    await pool.query('DELETE FROM solicitud_cotizacion_items WHERE solicitud_id = ?', [s.id]);
  }
  await pool.query('DELETE FROM solicitudes_cotizacion WHERE proveedor_id = ?', [id]);
  await pool.query('DELETE FROM proveedores WHERE id = ?', [id]);
  return { success: true };
}

// Pública: sin clave de acceso — el frontend la usa para saber con qué
// dirección armar los enlaces /cotizar que se comparten fuera de esta
// computadora (ver PUBLIC_BASE_URL en el .env). Si no está configurada,
// el frontend cae de regreso a window.location.origin.
async function getConfigPublico() {
  return { baseUrl: (process.env.PUBLIC_BASE_URL || '').toString().trim().replace(/\/+$/, '') || null };
}

// ---------------------------------------------------------------
// Configuración general: días y tipo (todas/preventivos/correctivos) del
// letrero de "Reportadas... sin fecha de atención" en Órdenes, guardados
// como tabla clave/valor (configuracion_general) para poder agregar más
// ajustes globales después sin otra migración. Cualquiera que vea
// Órdenes puede CONSULTAR el valor vigente (se necesita para dibujar el
// letrero); solo quien tiene "capturar" en Catálogo o Maquinaria puede
// CAMBIARLO — mismo permiso que el resto de los catálogos simples, para
// que no cualquiera lo pueda editar desde la tabla principal. Quién puede
// VER el letrero en sí (aparte del valor de días/tipo) es otro control,
// por persona, en usuarios.ver_letrero_ord_pend (ver validarUsuario y
// guardarUsuario).
// ---------------------------------------------------------------
const ORD_PEND_ATENCION_DIAS_DEFECTO_ = 5;
const ORD_PEND_ATENCION_TIPO_DEFECTO_ = 'todas';
const ORD_PEND_ATENCION_TIPOS_VALIDOS_ = ['todas', 'preventivos', 'correctivos'];

async function getOrdPendAtencionDias(code, nombreUsuario) {
  // El letrero solo muestra órdenes de la sección principal (ver
  // renderOrdenesSinAtencionReciente_ en el cliente), pero esta función se
  // llama en cuanto se abre la pestaña Órdenes sin importar qué sección(es)
  // tenga el usuario -- por eso basta con 'visualizar' en cualquiera de las
  // tres, para no tronar la pestaña a quien solo tiene Soldadura/Automotriz.
  await requierePermisoPanel_(code, nombreUsuario, ['ordenes', 'ordenes_soldadura', 'ordenes_automotriz', 'ordenes_llantas', 'ordenes_terceros'], 'visualizar');
  const [rows] = await pool.query(
    "SELECT clave, valor FROM configuracion_general WHERE clave IN ('ord_pend_atencion_dias', 'ord_pend_atencion_tipo')"
  );
  let diasRaw = null;
  let tipoRaw = null;
  rows.forEach((r) => {
    if (r.clave === 'ord_pend_atencion_dias') diasRaw = r.valor;
    if (r.clave === 'ord_pend_atencion_tipo') tipoRaw = r.valor;
  });
  const n = parseInt(diasRaw, 10);
  const tipo = (tipoRaw || '').toString();
  return {
    dias: (!isNaN(n) && n >= 1) ? n : ORD_PEND_ATENCION_DIAS_DEFECTO_,
    tipo: ORD_PEND_ATENCION_TIPOS_VALIDOS_.includes(tipo) ? tipo : ORD_PEND_ATENCION_TIPO_DEFECTO_,
  };
}

async function guardarOrdPendAtencionDias(code, nombreUsuario, dias, tipo) {
  await requierePermisoPanel_(code, nombreUsuario, PESTANAS_CATALOGO_OPERATIVO_, 'capturar');
  const n = parseInt(dias, 10);
  if (isNaN(n) || n < 1 || n > 90) {
    return { success: false, error: 'El número de días debe ser un entero entre 1 y 90.' };
  }
  const tipoLimpio = ORD_PEND_ATENCION_TIPOS_VALIDOS_.includes(tipo) ? tipo : ORD_PEND_ATENCION_TIPO_DEFECTO_;
  await pool.query(
    `INSERT INTO configuracion_general (clave, valor, modificado_por)
     VALUES ('ord_pend_atencion_dias', ?, ?), ('ord_pend_atencion_tipo', ?, ?)
     ON DUPLICATE KEY UPDATE valor = VALUES(valor), modificado_por = VALUES(modificado_por)`,
    [String(n), nombreUsuario, tipoLimpio, nombreUsuario]
  );
  return { success: true, dias: n, tipo: tipoLimpio };
}

// ---------------------------------------------------------------
// Solicitudes de cotización: pedirle a un proveedor que cotice una lista
// de refacciones mediante un enlace público (sin clave de acceso), que
// abre public/Cotizacion.html vía /cotizar?token=...
// ---------------------------------------------------------------

async function crearSolicitudCotizacion(code, nombreUsuario, data) {
  await requierePermisoPanel_(code, nombreUsuario, 'refacciones', 'capturar');
  data = data || {};
  try {
    const proveedorId = Number(data.proveedorId);
    const items = Array.isArray(data.items) ? data.items : [];
    const nombreSolicito = (data.nombreSolicito || '').toString().trim();
    const orden = (data.orden || '').toString().trim();

    if (!orden) return { success: false, error: 'Selecciona la orden de trabajo relacionada.' };
    if (!proveedorId) return { success: false, error: 'Selecciona el proveedor.' };
    if (!nombreSolicito) return { success: false, error: 'Escribe quién genera la solicitud.' };
    if (items.length === 0) return { success: false, error: 'Selecciona al menos una refacción para cotizar.' };

    const [proveedores] = await pool.query('SELECT id FROM proveedores WHERE id = ?', [proveedorId]);
    if (proveedores.length === 0) return { success: false, error: 'No se encontró el proveedor.' };

    const [ordenes] = await pool.query('SELECT orden FROM reportes WHERE orden = ?', [orden]);
    if (ordenes.length === 0) return { success: false, error: 'No se encontró esa orden de trabajo.' };

    const mensaje = (data.mensaje || '').toString().trim() || null;
    const folio = await siguienteFolio_(pool, 'cotizacion', 'COT', 5);
    const token = crypto.randomBytes(24).toString('hex');

    const [result] = await pool.query(
      `INSERT INTO solicitudes_cotizacion (folio, token, proveedor_id, mensaje, nombre_solicito, orden)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [folio, token, proveedorId, mensaje, nombreSolicito, orden]
    );
    const solicitudId = result.insertId;

    for (const it of items) {
      const refaccionId = Number(it.refaccionId);
      const cantidad = Number(it.cantidad) || 1;
      if (!refaccionId) continue;
      await pool.query(
        'INSERT INTO solicitud_cotizacion_items (solicitud_id, refaccion_id, cantidad) VALUES (?, ?, ?)',
        [solicitudId, refaccionId, cantidad]
      );
    }

    return { success: true, id: solicitudId, folio, token };
  } catch (err) {
    return { success: false, error: err.toString() };
  }
}

// Staff: igual que crearSolicitudCotizacion, pero agrupa automáticamente los
// items por proveedor y genera UNA solicitud (folio/token/liga propios) por
// cada proveedor distinto involucrado, en una sola llamada. Cada item de
// data.items debe traer { refaccionId, cantidad, proveedorId }. Si varias
// piezas comparten el mismo proveedorId, se mandan juntas en una sola
// solicitud para ese proveedor.
async function crearSolicitudesCotizacion(code, nombreUsuario, data) {
  await requierePermisoPanel_(code, nombreUsuario, 'refacciones', 'capturar');
  data = data || {};
  try {
    const items = Array.isArray(data.items) ? data.items : [];
    const nombreSolicito = (data.nombreSolicito || '').toString().trim();
    const orden = (data.orden || '').toString().trim();

    if (!orden) return { success: false, error: 'Selecciona la orden de trabajo relacionada.' };
    if (!nombreSolicito) return { success: false, error: 'Escribe quién genera la solicitud.' };
    if (items.length === 0) return { success: false, error: 'Selecciona al menos una refacción para cotizar.' };

    const [ordenes] = await pool.query('SELECT orden FROM reportes WHERE orden = ?', [orden]);
    if (ordenes.length === 0) return { success: false, error: 'No se encontró esa orden de trabajo.' };

    // Agrupa por proveedorId, validando que cada item traiga uno.
    const grupos = new Map(); // proveedorId -> [items]
    for (const it of items) {
      const refaccionId = Number(it.refaccionId);
      if (!refaccionId) continue;
      const proveedorId = Number(it.proveedorId);
      if (!proveedorId) {
        return { success: false, error: 'Falta asignar proveedor a una o más refacciones antes de generar la solicitud.' };
      }
      const cantidad = Number(it.cantidad) || 1;
      if (!grupos.has(proveedorId)) grupos.set(proveedorId, []);
      grupos.get(proveedorId).push({ refaccionId, cantidad });
    }
    if (grupos.size === 0) return { success: false, error: 'Selecciona al menos una refacción para cotizar.' };

    const proveedorIds = Array.from(grupos.keys());
    const [proveedoresRows] = await pool.query(
      `SELECT id, nombre FROM proveedores WHERE id IN (${proveedorIds.map(() => '?').join(',')})`,
      proveedorIds
    );
    const proveedoresPorId = new Map(proveedoresRows.map((p) => [p.id, p.nombre]));
    for (const pid of proveedorIds) {
      if (!proveedoresPorId.has(pid)) return { success: false, error: 'No se encontró uno de los proveedores seleccionados.' };
    }

    const mensaje = (data.mensaje || '').toString().trim() || null;
    const solicitudesCreadas = [];

    for (const [proveedorId, itemsGrupo] of grupos.entries()) {
      const folio = await siguienteFolio_(pool, 'cotizacion', 'COT', 5);
      const token = crypto.randomBytes(24).toString('hex');

      const [result] = await pool.query(
        `INSERT INTO solicitudes_cotizacion (folio, token, proveedor_id, mensaje, nombre_solicito, orden)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [folio, token, proveedorId, mensaje, nombreSolicito, orden]
      );
      const solicitudId = result.insertId;

      for (const it of itemsGrupo) {
        await pool.query(
          'INSERT INTO solicitud_cotizacion_items (solicitud_id, refaccion_id, cantidad) VALUES (?, ?, ?)',
          [solicitudId, it.refaccionId, it.cantidad]
        );
      }

      solicitudesCreadas.push({
        id: solicitudId,
        folio,
        token,
        proveedorId,
        proveedorNombre: proveedoresPorId.get(proveedorId) || '',
        cantidadPiezas: itemsGrupo.length,
      });
    }

    return { success: true, solicitudes: solicitudesCreadas };
  } catch (err) {
    return { success: false, error: err.toString() };
  }
}

// Staff: cancela una solicitud de cotización — ya no se le puede cotizar
// (el enlace público avisa que fue cancelada y responderCotizacion la
// rechaza), pero las respuestas que ya haya recibido se conservan, se
// siguen viendo en el detalle. No borra nada.
async function cancelarSolicitudCotizacion(code, nombreUsuario, id) {
  await requierePermisoPanel_(code, nombreUsuario, 'refacciones', 'capturar');
  try {
    const [rows] = await pool.query('SELECT id FROM solicitudes_cotizacion WHERE id = ?', [id]);
    if (rows.length === 0) return { success: false, error: 'No se encontró la solicitud.' };
    await pool.query("UPDATE solicitudes_cotizacion SET estado = 'cancelada' WHERE id = ?", [id]);
    return { success: true };
  } catch (err) {
    return { success: false, error: err.toString() };
  }
}

// Staff: revierte una cancelación (por si se canceló por error). El enlace
// público vuelve a aceptar cotizaciones. El estado al que regresa depende
// de si ya había respuestas recibidas antes de cancelarla.
async function reactivarSolicitudCotizacion(code, nombreUsuario, id) {
  await requierePermisoPanel_(code, nombreUsuario, 'refacciones', 'capturar');
  try {
    const [rows] = await pool.query('SELECT id FROM solicitudes_cotizacion WHERE id = ?', [id]);
    if (rows.length === 0) return { success: false, error: 'No se encontró la solicitud.' };
    const [[{ n }]] = await pool.query(
      'SELECT COUNT(*) AS n FROM solicitud_cotizacion_respuestas WHERE solicitud_id = ?',
      [id]
    );
    const nuevoEstado = Number(n) > 0 ? 'respondida' : 'pendiente';
    await pool.query('UPDATE solicitudes_cotizacion SET estado = ? WHERE id = ?', [nuevoEstado, id]);
    return { success: true, estado: nuevoEstado };
  } catch (err) {
    return { success: false, error: err.toString() };
  }
}

async function getSolicitudesCotizacion(code, nombreUsuario) {
  await requierePermisoPanel_(code, nombreUsuario, 'refacciones', 'visualizar');
  const [solicitudes] = await pool.query(`
    SELECT s.id AS Id, s.folio AS Folio, s.token AS Token, s.estado AS Estado,
           s.mensaje AS Mensaje, s.nombre_solicito AS NombreSolicito, s.creado_en AS CreadoEn,
           s.orden AS Orden, rep.unidad AS OrdenUnidad, rep.codigo_unidad AS OrdenCodigoUnidad,
           rep.descripcion AS OrdenDescripcion,
           p.id AS ProveedorId, p.nombre AS ProveedorNombre, p.correo AS ProveedorCorreo
    FROM solicitudes_cotizacion s
    INNER JOIN proveedores p ON p.id = s.proveedor_id
    LEFT JOIN reportes rep ON rep.orden = s.orden
    ORDER BY s.id DESC
  `);
  // Lo pedido (sin precio — el precio ahora vive por respuesta, ver abajo).
  const [items] = await pool.query(`
    SELECT sci.id AS ItemId, sci.solicitud_id AS SolicitudId, sci.cantidad AS Cantidad,
           ref.id AS RefaccionId, ref.codigo AS Codigo, ref.no_parte AS NoParte, ref.descripcion AS Descripcion
    FROM solicitud_cotizacion_items sci
    INNER JOIN refacciones ref ON ref.id = sci.refaccion_id
    ORDER BY ref.descripcion
  `);
  // Cada respuesta es un envío independiente (puede haber varias por
  // solicitud — una por cada persona que cotizó — sin que se pisen entre sí).
  const [respuestas] = await pool.query(`
    SELECT r.id AS RespuestaId, r.solicitud_id AS SolicitudId, r.nombre_responde AS NombreResponde,
           r.comentario AS Comentario, r.pdf_url AS PdfUrl, r.pdf_nombre AS PdfNombre,
           r.descuento_pct AS DescuentoPct, r.creado_en AS CreadoEn
    FROM solicitud_cotizacion_respuestas r
    ORDER BY r.creado_en ASC
  `);
  const [respuestaItems] = await pool.query(`
    SELECT ri.id AS RespuestaItemId, ri.respuesta_id AS RespuestaId, ri.item_id AS ItemId,
           ri.precio_cotizado AS PrecioCotizado, ri.iva_pct AS IvaPct, ri.fecha_entrega AS FechaEntrega,
           ri.comentario AS Comentario, ri.autorizado AS Autorizado
    FROM solicitud_cotizacion_respuesta_items ri
  `);

  const itemsPorSolicitud = {};
  items.forEach((it) => {
    if (!itemsPorSolicitud[it.SolicitudId]) itemsPorSolicitud[it.SolicitudId] = [];
    itemsPorSolicitud[it.SolicitudId].push({
      ItemId: it.ItemId,
      RefaccionId: it.RefaccionId,
      Codigo: it.Codigo || '',
      NoParte: it.NoParte || '',
      Descripcion: it.Descripcion,
      Cantidad: Number(it.Cantidad),
    });
  });

  const itemsPorRespuesta = {};
  respuestaItems.forEach((ri) => {
    if (!itemsPorRespuesta[ri.RespuestaId]) itemsPorRespuesta[ri.RespuestaId] = [];
    itemsPorRespuesta[ri.RespuestaId].push({
      RespuestaItemId: ri.RespuestaItemId,
      ItemId: ri.ItemId,
      PrecioCotizado: ri.PrecioCotizado !== null && ri.PrecioCotizado !== undefined ? Number(ri.PrecioCotizado) : null,
      IvaPct: ri.IvaPct !== null && ri.IvaPct !== undefined ? Number(ri.IvaPct) : null,
      FechaEntrega: fechaSoloOrNull(ri.FechaEntrega),
      Comentario: ri.Comentario || '',
      Autorizado: !!ri.Autorizado,
    });
  });

  const respuestasPorSolicitud = {};
  respuestas.forEach((r) => {
    if (!respuestasPorSolicitud[r.SolicitudId]) respuestasPorSolicitud[r.SolicitudId] = [];
    const descuentoPct = r.DescuentoPct !== null && r.DescuentoPct !== undefined ? Number(r.DescuentoPct) : null;
    const itemsRespuesta = (itemsPorRespuesta[r.RespuestaId] || []).map((ri) => {
      const { PrecioConDescuento, PrecioTotal } = calcularPreciosCotizados(ri.PrecioCotizado, descuentoPct, ri.IvaPct);
      return { ...ri, PrecioConDescuento, PrecioTotal };
    });
    respuestasPorSolicitud[r.SolicitudId].push({
      RespuestaId: r.RespuestaId,
      NombreResponde: r.NombreResponde || '',
      Comentario: r.Comentario || '',
      PdfUrl: r.PdfUrl || '',
      PdfNombre: r.PdfNombre || '',
      DescuentoPct: descuentoPct,
      CreadoEn: isoOrNull(r.CreadoEn),
      Items: itemsRespuesta,
    });
  });

  return solicitudes.map((s) => ({
    Id: s.Id,
    Folio: s.Folio,
    Token: s.Token,
    Estado: s.Estado,
    Mensaje: s.Mensaje || '',
    NombreSolicito: s.NombreSolicito || '',
    CreadoEn: isoOrNull(s.CreadoEn),
    Orden: s.Orden || '',
    OrdenUnidad: s.OrdenUnidad || s.OrdenCodigoUnidad || '',
    OrdenDescripcion: s.OrdenDescripcion || '',
    ProveedorId: s.ProveedorId,
    ProveedorNombre: s.ProveedorNombre,
    ProveedorCorreo: s.ProveedorCorreo || '',
    Items: itemsPorSolicitud[s.Id] || [],
    Respuestas: respuestasPorSolicitud[s.Id] || [],
  }));
}

// Pública: sin clave de acceso — la abre el proveedor con el enlace que se
// le comparte (/cotizar?token=...). No trae precios de otras respuestas
// (para no influir a quien está por cotizar) — solo cuántas respuestas ya
// se recibieron, como referencia.
async function getSolicitudCotizacionPublica(token) {
  const [solicitudes] = await pool.query(`
    SELECT s.id AS Id, s.folio AS Folio, s.estado AS Estado, s.mensaje AS Mensaje,
           p.nombre AS ProveedorNombre, p.contacto AS ProveedorContacto
    FROM solicitudes_cotizacion s
    INNER JOIN proveedores p ON p.id = s.proveedor_id
    WHERE s.token = ?
  `, [token]);
  if (solicitudes.length === 0) {
    throw new Error('Este enlace de cotización no es válido o ya no existe.');
  }
  const s = solicitudes[0];
  const [items] = await pool.query(`
    SELECT sci.id AS ItemId, sci.cantidad AS Cantidad,
           ref.codigo AS Codigo, ref.no_parte AS NoParte, ref.descripcion AS Descripcion
    FROM solicitud_cotizacion_items sci
    INNER JOIN refacciones ref ON ref.id = sci.refaccion_id
    WHERE sci.solicitud_id = ?
    ORDER BY ref.descripcion
  `, [s.Id]);
  const [[{ RespuestasCount }]] = await pool.query(
    'SELECT COUNT(*) AS RespuestasCount FROM solicitud_cotizacion_respuestas WHERE solicitud_id = ?',
    [s.Id]
  );
  return {
    Folio: s.Folio,
    Estado: s.Estado,
    Mensaje: s.Mensaje || '',
    ProveedorNombre: s.ProveedorNombre,
    ProveedorContacto: s.ProveedorContacto || '',
    RespuestasCount: Number(RespuestasCount) || 0,
    Items: items.map((it) => ({
      ItemId: it.ItemId,
      Codigo: it.Codigo || '',
      NoParte: it.NoParte || '',
      Descripcion: it.Descripcion,
      Cantidad: Number(it.Cantidad),
    })),
  };
}

// Pública: sin clave de acceso — el proveedor manda su cotización. Cada
// envío crea una respuesta NUEVA (nunca sobreescribe la de otra persona),
// para poder mandarle la misma solicitud a varios contactos/proveedores y
// que cada quien cargue su propio precio.
async function responderCotizacion(token, data) {
  data = data || {};
  try {
    const [solicitudes] = await pool.query('SELECT id, estado FROM solicitudes_cotizacion WHERE token = ?', [token]);
    if (solicitudes.length === 0) return { success: false, error: 'Este enlace de cotización no es válido o ya no existe.' };
    const solicitudId = solicitudes[0].id;
    if (solicitudes[0].estado === 'cancelada') {
      return { success: false, error: 'Esta solicitud fue cancelada y ya no acepta cotizaciones.' };
    }

    const nombreResponde = (data.nombreResponde || '').toString().trim();
    if (!nombreResponde) return { success: false, error: 'Escribe tu nombre antes de enviar la cotización.' };
    const items = Array.isArray(data.items) ? data.items : [];
    if (items.length === 0) return { success: false, error: 'No hay refacciones que cotizar.' };

    let pdfUrl = null;
    let pdfNombre = null;
    if (data.pdfBase64) {
      if (!/^data:application\/pdf;base64,/.test(data.pdfBase64)) {
        return { success: false, error: 'El archivo adjunto de la cotización debe ser un PDF.' };
      }
      pdfUrl = await guardarArchivo_(data.pdfBase64);
      pdfNombre = (data.pdfNombre || '').toString().trim() || 'cotizacion.pdf';
    }

    // Descuento (%): un solo valor para toda la cotización de este proveedor.
    let descuentoPct = null;
    if (data.descuentoPct !== '' && data.descuentoPct !== undefined && data.descuentoPct !== null) {
      const d = Number(data.descuentoPct);
      if (!isNaN(d) && d >= 0 && d <= 100) descuentoPct = d;
    }

    const comentarioGeneral = (data.comentario || '').toString().trim() || null;
    const [result] = await pool.query(
      `INSERT INTO solicitud_cotizacion_respuestas (solicitud_id, nombre_responde, comentario, pdf_url, pdf_nombre, descuento_pct)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [solicitudId, nombreResponde, comentarioGeneral, pdfUrl, pdfNombre, descuentoPct]
    );
    const respuestaId = result.insertId;

    for (const it of items) {
      const itemId = Number(it.itemId);
      if (!itemId) continue;
      // Confirma que ese item sí pertenece a esta solicitud (para que nadie
      // pueda mandar precios de otra solicitud con un itemId inventado).
      const [chk] = await pool.query(
        'SELECT id FROM solicitud_cotizacion_items WHERE id = ? AND solicitud_id = ?',
        [itemId, solicitudId]
      );
      if (chk.length === 0) continue;
      const precio = (it.precio === '' || it.precio === undefined || it.precio === null) ? null : Number(it.precio);
      const fechaEntrega = (it.fechaEntrega || '').toString().trim() || null;
      const comentario = (it.comentario || '').toString().trim() || null;
      // IVA (%): este sí lo captura el proveedor pieza por pieza.
      let ivaPct = null;
      if (it.ivaPct !== '' && it.ivaPct !== undefined && it.ivaPct !== null) {
        const iv = Number(it.ivaPct);
        if (!isNaN(iv) && iv >= 0 && iv <= 100) ivaPct = iv;
      }
      await pool.query(
        `INSERT INTO solicitud_cotizacion_respuesta_items (respuesta_id, item_id, precio_cotizado, iva_pct, fecha_entrega, comentario)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [respuestaId, itemId, precio, ivaPct, fechaEntrega, comentario]
      );
    }

    await pool.query(
      "UPDATE solicitudes_cotizacion SET estado='respondida' WHERE id = ? AND estado <> 'respondida'",
      [solicitudId]
    );

    return { success: true };
  } catch (err) {
    return { success: false, error: err.toString() };
  }
}

// Staff: copia los precios de UNA respuesta específica (una de posiblemente
// varias, si más de una persona cotizó) al catálogo de refacciones — solo
// para los items que sí trajeron precio.
async function aplicarPreciosCotizacion(code, nombreUsuario, respuestaId) {
  await requierePermisoPanel_(code, nombreUsuario, 'refacciones', 'capturar');
  try {
    const [items] = await pool.query(
      `SELECT sci.refaccion_id AS RefaccionId, ri.precio_cotizado AS PrecioCotizado
       FROM solicitud_cotizacion_respuesta_items ri
       INNER JOIN solicitud_cotizacion_items sci ON sci.id = ri.item_id
       WHERE ri.respuesta_id = ? AND ri.precio_cotizado IS NOT NULL`,
      [respuestaId]
    );
    for (const it of items) {
      await pool.query('UPDATE refacciones SET precio = ? WHERE id = ?', [it.PrecioCotizado, it.RefaccionId]);
    }
    return { success: true, actualizadas: items.length };
  } catch (err) {
    return { success: false, error: err.toString() };
  }
}

// Staff: marca (o quita) la respuesta de un proveedor como la autorizada
// para UNA pieza específica dentro de la solicitud — a diferencia de
// aplicarPreciosCotizacion (que aplica TODA una respuesta de un jalón), esto
// permite tomar, pieza por pieza, la cotización que más convenga de entre
// las distintas respuestas recibidas, aunque sean de proveedores distintos.
// Solo puede haber UNA fila autorizada por pieza dentro de una misma
// solicitud: antes de marcar la nueva, se desmarcan las demás respuestas que
// también hayan cotizado esa misma pieza. Al autorizar, se copia al
// catálogo de refacciones el precio YA CON DESCUENTO (sin IVA, que es un
// impuesto y no parte del costo de referencia), como precio de referencia.
async function autorizarPrecioItem(code, nombreUsuario, respuestaItemId) {
  await requierePermisoPanel_(code, nombreUsuario, 'refacciones', 'capturar');
  try {
    const [rows] = await pool.query(
      `SELECT ri.id AS RespuestaItemId, ri.item_id AS ItemId, ri.precio_cotizado AS PrecioCotizado,
              ri.autorizado AS Autorizado, r.solicitud_id AS SolicitudId, r.descuento_pct AS DescuentoPct,
              sci.refaccion_id AS RefaccionId
       FROM solicitud_cotizacion_respuesta_items ri
       INNER JOIN solicitud_cotizacion_respuestas r ON r.id = ri.respuesta_id
       INNER JOIN solicitud_cotizacion_items sci ON sci.id = ri.item_id
       WHERE ri.id = ?`,
      [respuestaItemId]
    );
    if (rows.length === 0) return { success: false, error: 'No se encontró esa cotización.' };
    const row = rows[0];

    if (row.Autorizado) {
      // Ya estaba autorizada: solo se quita la marca (no revierte el precio
      // que ya se copió al catálogo — eso se corrige a mano si hace falta).
      await pool.query('UPDATE solicitud_cotizacion_respuesta_items SET autorizado = 0 WHERE id = ?', [respuestaItemId]);
      return { success: true, autorizado: false };
    }

    if (row.PrecioCotizado === null || row.PrecioCotizado === undefined) {
      return { success: false, error: 'Esta respuesta no trae precio para esta pieza.' };
    }

    // Desmarca cualquier otra respuesta que también haya cotizado esta misma
    // pieza dentro de la misma solicitud, para que solo quede una autorizada.
    await pool.query(
      `UPDATE solicitud_cotizacion_respuesta_items ri
       INNER JOIN solicitud_cotizacion_respuestas r ON r.id = ri.respuesta_id
       SET ri.autorizado = 0
       WHERE ri.item_id = ? AND r.solicitud_id = ?`,
      [row.ItemId, row.SolicitudId]
    );
    await pool.query('UPDATE solicitud_cotizacion_respuesta_items SET autorizado = 1 WHERE id = ?', [respuestaItemId]);

    const { PrecioConDescuento } = calcularPreciosCotizados(Number(row.PrecioCotizado), row.DescuentoPct, null);
    await pool.query('UPDATE refacciones SET precio = ? WHERE id = ?', [PrecioConDescuento, row.RefaccionId]);

    return { success: true, autorizado: true, precioAplicado: PrecioConDescuento };
  } catch (err) {
    return { success: false, error: err.toString() };
  }
}

async function actualizarLecturaManual(code, nombreUsuario, codigoUnidad, lectura) {
  await requierePermisoPanel_(code, nombreUsuario, 'mantenimiento', 'capturar');
  try {
    if (lectura === '' || lectura === undefined || lectura === null || isNaN(Number(lectura))) {
      return { success: false, error: 'Captura una lectura numérica válida.' };
    }
    await pool.query(
      'UPDATE maquinaria SET lectura_manual = ?, lectura_manual_fecha = CURDATE() WHERE codigo_unidad = ?',
      [Number(lectura), codigoUnidad]
    );
    await cancelarOrdenesPreventivasYaNoVencidas_(codigoUnidad, nombreUsuario);
    return { success: true };
  } catch (err) {
    return { success: false, error: err.toString() };
  }
}

// Genera una orden de trabajo (pestaña Órdenes/Taller) a partir de una
// regla de mantenimiento preventivo, para UN equipo en particular. Antes
// las reglas eran por equipo y `codigoUnidad` no hacía falta (se sacaba de
// la propia regla); ahora una regla aplica a todo un modelo, así que hay
// que decir explícitamente para cuál equipo se está generando la orden
// (se valida que sea del modelo de la regla). Para reglas antiguas (ya
// desactivadas, sin modelo_id) se sigue aceptando el codigoUnidad de la
// propia regla como respaldo, por compatibilidad.
async function generarOrdenMantenimiento(code, nombreUsuario, reglaId, codigoUnidad, data) {
  await requierePermisoPanel_(code, nombreUsuario, 'mantenimiento', 'capturar');
  const huertasRestringidas = await obtenerHuertasRestringidasUsuario_(nombreUsuario);
  if (huertasRestringidas) {
    // Esto genera directo una orden en `reportes` (pestaña Órdenes), así que
    // debe respetar la misma restricción de huertas que crearOrdenPanel — si
    // no, un usuario restringido podría saltársela generando la orden desde
    // Preventivos en vez de crearla a mano. codigoUnidadResuelto replica el
    // respaldo de crearOrdenDesdeRegla_ para reglas antiguas sin modelo_id.
    let codigoUnidadResuelto = (codigoUnidad || '').toString().trim() || null;
    if (!codigoUnidadResuelto) {
      const [reglas] = await pool.query('SELECT codigo_unidad FROM mantenimiento_reglas WHERE id = ?', [reglaId]);
      if (reglas.length > 0) codigoUnidadResuelto = reglas[0].codigo_unidad || null;
    }
    const ubicMap = await getUbicacionesActuales_();
    const huertaEquipo = codigoUnidadResuelto ? (ubicMap[codigoUnidadResuelto] || '') : '';
    if (!huertaPermitida_(huertasRestringidas, huertaEquipo)) {
      return { success: false, error: 'Tu usuario no tiene acceso a este equipo (huerta ' + (huertaEquipo || 'sin huerta') + ').' };
    }
  }
  return crearOrdenDesdeRegla_(reglaId, codigoUnidad, data);
}

// Mismo botón "Generar orden" pero desde Servicios Automotrices — mismo
// núcleo (crearOrdenDesdeRegla_ ya marca es_automotriz=1 solo, ver arriba),
// solo cambia el permiso que se exige.
async function generarOrdenServicioAutomotriz(code, nombreUsuario, reglaId, codigoUnidad, data) {
  await requierePermisoPanel_(code, nombreUsuario, 'servicios_automotrices', 'capturar');
  const huertasRestringidas = await obtenerHuertasRestringidasUsuario_(nombreUsuario);
  if (huertasRestringidas) {
    let codigoUnidadResuelto = (codigoUnidad || '').toString().trim() || null;
    if (!codigoUnidadResuelto) {
      const [reglas] = await pool.query('SELECT codigo_unidad FROM mantenimiento_reglas WHERE id = ?', [reglaId]);
      if (reglas.length > 0) codigoUnidadResuelto = reglas[0].codigo_unidad || null;
    }
    const ubicMap = await getUbicacionesActuales_();
    const huertaEquipo = codigoUnidadResuelto ? (ubicMap[codigoUnidadResuelto] || '') : '';
    if (!huertaPermitida_(huertasRestringidas, huertaEquipo)) {
      return { success: false, error: 'Tu usuario no tiene acceso a este equipo (huerta ' + (huertaEquipo || 'sin huerta') + ').' };
    }
  }
  return crearOrdenDesdeRegla_(reglaId, codigoUnidad, data);
}

// Núcleo de generarOrdenMantenimiento, sin el chequeo de permiso — lo usa
// tanto la ruta manual (botón "Generar orden" del Panel, ya autenticada más
// arriba) como el job automático (revisarYGenerarOrdenesPreventivasAutomaticas_,
// que no tiene una sesión de usuario real detrás).
async function crearOrdenDesdeRegla_(reglaId, codigoUnidad, data) {
  data = data || {};
  try {
    if (!data.nombre) return { success: false, error: 'Escribe quién genera la orden.' };

    const [reglas] = await pool.query('SELECT * FROM mantenimiento_reglas WHERE id = ?', [reglaId]);
    if (reglas.length === 0) return { success: false, error: 'No se encontró la regla de mantenimiento.' };
    const regla = reglas[0];

    codigoUnidad = (codigoUnidad || '').toString().trim() || null;
    if (regla.modelo_id) {
      if (!codigoUnidad) return { success: false, error: 'Selecciona el equipo para el que se genera la orden.' };
      const [maquinas] = await pool.query('SELECT modelo_id FROM maquinaria WHERE codigo_unidad = ?', [codigoUnidad]);
      if (maquinas.length === 0) return { success: false, error: 'No se encontró el equipo.' };
      if (maquinas[0].modelo_id !== regla.modelo_id) {
        return { success: false, error: 'Ese equipo no es del modelo de esta regla.' };
      }
    } else if (!codigoUnidad) {
      codigoUnidad = regla.codigo_unidad || null; // regla antigua (por equipo)
    }
    if (!codigoUnidad) return { success: false, error: 'No se pudo determinar el equipo de esta orden.' };

    const [maquinasLabel] = await pool.query('SELECT unidad, usa_gasolina FROM maquinaria WHERE codigo_unidad = ?', [codigoUnidad]);
    const unidadLabel = maquinasLabel.length > 0 ? maquinasLabel[0].unidad : codigoUnidad;
    // Las órdenes generadas desde una regla de un equipo automotriz
    // (usa_gasolina = 1, el mismo criterio que Combustible Automotriz y
    // Servicios Automotrices) se marcan como "Es trabajo Automotriz" para
    // que aparezcan en el apartado de Automotriz de Órdenes, igual que si
    // alguien hubiera marcado esa casilla a mano — así Carlos las ve ahí,
    // no mezcladas con la tabla principal (que es la de huertas/agrícola).
    const esAutomotriz = maquinasLabel.length > 0 && !!maquinasLabel[0].usa_gasolina;

    const ubicMap = await getUbicacionesActuales_();
    const huerta = ubicMap[codigoUnidad] || '';

    const [asignadas] = await pool.query(
      `SELECT ref.id AS RefaccionId, mrr.cantidad AS Cantidad, ref.no_parte AS NoParte, ref.descripcion AS Descripcion
       FROM mantenimiento_regla_refacciones mrr
       INNER JOIN refacciones ref ON ref.id = mrr.refaccion_id
       WHERE mrr.regla_id = ?
       ORDER BY ref.descripcion`,
      [reglaId]
    );

    // Las refacciones de la regla ya NO se listan en la descripción — se
    // guardan directamente como "piezas" (reportes_refacciones_necesarias)
    // más abajo, para que se vean y se cuenten ahí (botón "+ piezas") en
    // lugar de quedar como texto suelto en la descripción de la orden.
    // "Preventivo <servicio>" (antes "Mantenimiento preventivo: <servicio>")
    // — más corto para que se alcance a leer en la columna Descripción de
    // la tabla de Órdenes sin tener que abrir la orden. Si el nombre del
    // servicio ya empieza con "Preventivo" (varias reglas ya se capturan
    // así, p. ej. "PREVENTIVO SISTEMA HIDRÁULICO"), no se vuelve a anteponer
    // para no duplicarlo ("Preventivo PREVENTIVO...").
    const nombreServicio = (regla.nombre_servicio || '').toString();
    const yaDicePreventivo = /^preventivo\b/i.test(nombreServicio.trim());
    let descripcion = yaDicePreventivo ? nombreServicio : ('Preventivo ' + nombreServicio);
    if (regla.refacciones) descripcion += '\nNotas adicionales: ' + regla.refacciones;
    if (regla.aceite_litros) descripcion += '\nAceite: ' + regla.aceite_litros + ' L';
    if (data.comentario) descripcion += '\nComentario: ' + data.comentario;

    const orden = await siguienteFolio_(pool, 'orden', 'OF', 5);
    await pool.query(
      `INSERT INTO reportes (orden, codigo_unidad, unidad, huerta, descripcion, nombre, fecha, es_automotriz)
       VALUES (?, ?, ?, ?, ?, ?, NOW(), ?)`,
      [orden, codigoUnidad, unidadLabel, huerta, descripcion, data.nombre, esAutomotriz ? 1 : 0]
    );

    const lecturaGeneracion = (data.lecturaActual === '' || data.lecturaActual === undefined || data.lecturaActual === null)
      ? null : Number(data.lecturaActual);
    await pool.query(
      'INSERT INTO mantenimiento_ordenes (regla_id, orden, lectura_generacion, codigo_unidad) VALUES (?, ?, ?, ?)',
      [reglaId, orden, lecturaGeneracion, codigoUnidad]
    );

    const filas = asignadas.map((a) => [orden, a.RefaccionId, null, Number(a.Cantidad) || 1, 'preventivo', null]);
    // El aceite también se guarda como una "pieza" más (texto libre, sin
    // ligar a un no. de parte del catálogo de Refacciones — no es una
    // refacción ahí), con la cantidad en litros, para que se vea y se
    // cuente junto con las demás en el botón "+ piezas".
    if (regla.aceite_litros) {
      filas.push([orden, null, 'Aceite', Number(regla.aceite_litros), 'preventivo', null]);
    }
    if (filas.length > 0) {
      const capturadoPor = (data.nombre || '').toString().trim() || null;
      filas.forEach((f) => { f[5] = capturadoPor; });
      await pool.query(
        'INSERT INTO reportes_refacciones_necesarias (orden, refaccion_id, texto_libre, cantidad, origen, capturado_por) VALUES ?',
        [filas]
      );
    }

    return { success: true, orden };
  } catch (err) {
    return { success: false, error: err.toString() };
  }
}

// Umbral (en horas u kilómetros restantes) a partir del cual se genera la
// orden de trabajo sola, sin que nadie la capture a mano desde el Panel.
const AUTO_ORDEN_UMBRAL_RESTANTE = 20;

// Único lugar que decide "¿este servicio justifica una orden automática
// abierta?" — lo usan tanto la generación (candidatos) como la cancelación
// (yaNoVencidos, que es exactamente lo contrario de esto) para que nunca
// queden desalineadas. Solo aplica a horas/kilómetros (los preventivos por
// tiempo no se generan ni se cancelan solos). OJO: cuando SinLineaBase es
// true o Restante es null (no hay con qué comparar — p. ej. se borró la
// única carga de diesel que traía la lectura, sin dejar una nueva en su
// lugar) esto cuenta como "NO justifica la orden": si ya no se puede
// confirmar que sigue vencido, tampoco hay por qué dejar la orden abierta.
function estaVencidoOProximo_(s) {
  if (s.TipoPeriodicidad !== 'horas' && s.TipoPeriodicidad !== 'kilometros') return false;
  if (s.SinLineaBase) return false;
  if (s.Restante === null || s.Restante === undefined) return false;
  return s.Restante <= AUTO_ORDEN_UMBRAL_RESTANTE;
}

// Job en segundo plano (ver server.js): recorre todos los "servicios" (cada
// combinación regla activa × equipo de su modelo) y, para los de tipo
// horas/kilómetros que ya estén a AUTO_ORDEN_UMBRAL_RESTANTE o menos de su
// próximo servicio, genera la orden de trabajo automáticamente — salvo que
// ese equipo ya tenga una orden ABIERTA (sin fecha_salida) generada por esa
// misma regla, para no duplicar. Pensado para llamarse periódicamente
// (setInterval) y también al arrancar el servidor.
async function revisarYGenerarOrdenesPreventivasAutomaticas_() {
  const generadas = [];
  try {
    const servicios = await obtenerServiciosMantenimiento_();

    // Antes de generar nuevas, cancela las que ya no tienen razón de ser:
    // equipos que tenían una orden abierta (automática o generada a mano)
    // pero cuya lectura ya no los marca como vencidos/próximos a vencer —
    // típicamente porque se corrigió una lectura mal capturada DESPUÉS de
    // que ya se había generado la orden. Esto corre en cada revisión
    // periódica (cada 30 min y al arrancar), así que no depende de que la
    // corrección se haga con esta misma revisión encendida — basta con que
    // el servidor se reinicie o pase el intervalo para que se autolimpie,
    // además del aviso inmediato que ya dan editarCargaDiesel/
    // eliminarCargaDiesel/actualizarLecturaManual (ver
    // cancelarOrdenesPreventivasYaNoVencidas_ abajo).
    const yaNoVencidos = servicios.filter((s) =>
      (s.TipoPeriodicidad === 'horas' || s.TipoPeriodicidad === 'kilometros')
      && !estaVencidoOProximo_(s)
    );
    await cancelarOrdenesDeServicios_(yaNoVencidos, 'Sistema (automático)');

    const candidatos = servicios.filter(estaVencidoOProximo_);

    for (const s of candidatos) {
      try {
        const [abiertas] = await pool.query(
          `SELECT mo.orden
           FROM mantenimiento_ordenes mo
           INNER JOIN reportes rep ON rep.orden = mo.orden
           WHERE mo.regla_id = ? AND mo.codigo_unidad = ? AND rep.fecha_salida IS NULL
           LIMIT 1`,
          [s.ReglaId, s.CodigoUnidad]
        );
        if (abiertas.length > 0) continue; // ya hay una orden pendiente para esta regla+equipo

        const unidad = s.TipoPeriodicidad === 'horas' ? 'horas' : 'km';
        const comentario = s.Restante <= 0
          ? `Generada automáticamente: el servicio ya está vencido (${s.Restante} ${unidad}).`
          : `Generada automáticamente: quedan ${s.Restante} ${unidad} para el próximo servicio.`;

        const resultado = await crearOrdenDesdeRegla_(s.ReglaId, s.CodigoUnidad, {
          nombre: 'Sistema (automático)',
          comentario,
          lecturaActual: s.LecturaActual,
        });

        if (resultado && resultado.success) {
          generadas.push({ orden: resultado.orden, unidad: s.Unidad, servicio: s.NombreServicio, restante: s.Restante });
        } else {
          console.error('[preventivo-auto] No se pudo generar orden para regla', s.ReglaId, 'equipo', s.CodigoUnidad, ':', resultado && resultado.error);
        }
      } catch (errItem) {
        console.error('[preventivo-auto] Error revisando regla', s.ReglaId, 'equipo', s.CodigoUnidad, ':', errItem);
      }
    }
  } catch (err) {
    console.error('[preventivo-auto] Error general en la revisión automática:', err);
  }

  if (generadas.length > 0) {
    console.log(`[preventivo-auto] Se generaron ${generadas.length} orden(es) automáticamente:`, generadas);
  }
  return generadas;
}

// Núcleo compartido: recibe una lista de "servicios" (ver
// obtenerServiciosMantenimiento_) que YA SE DETERMINÓ que no están
// vencidos ni próximos a vencer, y cancela (borra, igual que eliminarOrden)
// cualquier orden de trabajo ABIERTA (sin fecha de salida) ligada a cada
// combinación regla+equipo — generada sola por el sistema o a mano con el
// botón "Generar orden". Lo usan tanto la revisión periódica (para TODOS
// los equipos) como la cancelación puntual tras corregir una lectura (para
// un solo equipo) — ver las dos funciones de abajo.
async function cancelarOrdenesDeServicios_(serviciosYaNoVencidos, nombreUsuario) {
  for (const s of serviciosYaNoVencidos) {
    try {
      const [abiertas] = await pool.query(
        `SELECT rep.orden, rep.unidad, rep.descripcion
         FROM mantenimiento_ordenes mo
         INNER JOIN reportes rep ON rep.orden = mo.orden
         WHERE mo.regla_id = ? AND mo.codigo_unidad = ? AND rep.fecha_salida IS NULL`,
        [s.ReglaId, s.CodigoUnidad]
      );
      for (const o of abiertas) {
        await pool.query('DELETE FROM mantenimiento_ordenes WHERE orden = ?', [o.orden]);
        await pool.query('DELETE FROM reportes WHERE orden = ?', [o.orden]);
        await registrarAuditoria_(
          'reportes', o.orden, 'auto-cancelar',
          nombreUsuario || 'Sistema (automático)',
          (o.unidad || '') + ' — se canceló sola: la lectura ya no marca este servicio como vencido ni próximo a vencer.'
        );
        console.log(`[preventivo-auto] Orden ${o.orden} (${o.unidad}) cancelada sola: ya no está vencida.`);
      }
    } catch (errItem) {
      console.error('[preventivo-auto] Error cancelando órdenes de regla', s.ReglaId, 'equipo', s.CodigoUnidad, ':', errItem);
    }
  }
}

// Cuando se corrige la "lectura actual" de un equipo (se edita o se borra
// una carga de diesel con lectura, o se actualiza la lectura manual) puede
// que un servicio que estaba vencido o a punto de vencer ya NO lo esté —
// por ejemplo, si la lectura mal capturada había disparado la generación
// automática de una orden y luego se corrigió. Esto da el aviso INMEDIATO
// (sin esperar a la revisión periódica de cada 30 min — ver
// revisarYGenerarOrdenesPreventivasAutomaticas_ arriba, que hace la misma
// limpieza pero para TODOS los equipos, como red de seguridad). Se llama
// después de editarCargaDiesel, eliminarCargaDiesel y
// actualizarLecturaManual — cualquier acción que pueda cambiar la lectura
// actual de un equipo.
async function cancelarOrdenesPreventivasYaNoVencidas_(codigoUnidad, nombreUsuario) {
  if (!codigoUnidad) return;
  try {
    const servicios = await obtenerServiciosMantenimiento_();
    const yaNoVencidos = servicios.filter((s) =>
      s.CodigoUnidad === codigoUnidad
      && (s.TipoPeriodicidad === 'horas' || s.TipoPeriodicidad === 'kilometros')
      && !estaVencidoOProximo_(s)
    );
    if (yaNoVencidos.length === 0) return;
    await cancelarOrdenesDeServicios_(yaNoVencidos, nombreUsuario);
  } catch (err) {
    console.error('[preventivo-auto] Error cancelando órdenes ya no vencidas para', codigoUnidad, ':', err);
  }
}

// Abierta (sin clave): solo regresa la versión de la pantalla del celular
// -- ver server/versionApp.js y appRevisarVersion_ en public/Index.html.
function getVersionApp() {
  return { version: require('./versionApp').versionActual() };
}


// ------------------------------------------------------------
// Avisos de recorridos (ver server/avisos.js). Activar los avisos en SU
// equipo: cualquiera que ve Avance Huerta. Configurar el Telegram del
// negocio: quien puede capturar en Avance Huerta.
async function getConfigAvisos(code, nombreUsuario) {
  await requierePermisoPanel_(code, nombreUsuario, 'avance_huerta', 'visualizar');
  return avisos.getConfigAvisos_(nombreUsuario);
}
async function guardarSuscripcionAvisos(code, nombreUsuario, suscripcion, dispositivo) {
  await requierePermisoPanel_(code, nombreUsuario, 'avance_huerta', 'visualizar');
  return avisos.guardarSuscripcionPush_(nombreUsuario, suscripcion, dispositivo);
}
async function quitarSuscripcionAvisos(code, nombreUsuario, endpoint) {
  await requierePermisoPanel_(code, nombreUsuario, 'avance_huerta', 'visualizar');
  return avisos.quitarSuscripcionPush_(endpoint);
}
async function probarAvisoEquipo(code, nombreUsuario, endpoint) {
  await requierePermisoPanel_(code, nombreUsuario, 'avance_huerta', 'visualizar');
  return avisos.probarAvisoPush_(nombreUsuario, endpoint);
}
async function guardarTelegramToken(code, nombreUsuario, token) {
  await requierePermisoPanel_(code, nombreUsuario, 'avance_huerta', 'capturar');
  const r = await avisos.guardarTelegramToken_(token);
  if (r.success) await registrarAuditoria_('configuracion', 'telegram', 'editar', nombreUsuario, 'Bot de avisos: @' + r.bot);
  return r;
}
async function buscarChatsTelegram(code, nombreUsuario) {
  await requierePermisoPanel_(code, nombreUsuario, 'avance_huerta', 'capturar');
  return avisos.buscarChatsTelegram_();
}
async function guardarTelegramChat(code, nombreUsuario, chatId, nombre) {
  await requierePermisoPanel_(code, nombreUsuario, 'avance_huerta', 'capturar');
  const r = await avisos.guardarTelegramChat_(chatId, nombre);
  if (r.success) await registrarAuditoria_('configuracion', 'telegram', 'editar', nombreUsuario, 'Avisos de recorridos a: ' + (nombre || chatId));
  return r;
}
async function probarAvisoTelegram(code, nombreUsuario) {
  await requierePermisoPanel_(code, nombreUsuario, 'avance_huerta', 'visualizar');
  return avisos.probarAvisoTelegram_();
}
async function quitarTelegram(code, nombreUsuario) {
  await requierePermisoPanel_(code, nombreUsuario, 'avance_huerta', 'capturar');
  const r = await avisos.quitarTelegram_();
  await registrarAuditoria_('configuracion', 'telegram', 'eliminar', nombreUsuario, 'Se quitaron los avisos por Telegram');
  return r;
}
avisos.configurarUtilRecorrido_({ filtrarSaltosGps_, tramosDeRecorrido_, distanciaMetros_ });

module.exports = {
  getConfigAvisos,
  guardarSuscripcionAvisos,
  quitarSuscripcionAvisos,
  probarAvisoEquipo,
  guardarTelegramToken,
  buscarChatsTelegram,
  guardarTelegramChat,
  probarAvisoTelegram,
  quitarTelegram,
  getVersionApp,
  getSemanas,
  guardarSemana,
  eliminarSemana,
  getIndicadorCumplimientoSemanal,
  calcularIndicadorCumplimiento_,
  registrarProgramacionOrden_,
  fechaYmd_,
  sincronizarAvance,
  segundosDeMs_,
  submitReporte,
  crearOrdenPanel,
  getReportes,
  getReportesTaller,
  actualizarOrden,
  marcarOrdenEnProceso,
  editarOrden,
  eliminarOrden,
  getMisOrdenes,
  guardarVistoBueno,
  submitDiesel,
  getCargasDiesel,
  crearCargaDieselPanel,
  editarCargaDiesel,
  eliminarCargaDiesel,
  restaurarCargaDiesel,
  leerBitacoraDiesel,
  guardarCargasDieselLote,
  getCombustibleAutomotriz,
  crearCargaGasolinaPanel,
  editarCargaGasolina,
  eliminarCargaGasolina,
  restaurarCargaGasolina,
  leerTicketsGasolina,
  guardarCargasGasolinaLote,
  getHuertaPorUsuario,
  getNombresUsuarios,
  validarUsuario,
  getUsuarios,
  guardarUsuario,
  eliminarUsuario,
  getUbicacionesUnidades,
  submitMovimientoSalida,
  getMovimientosDeUsuario,
  confirmarLlegadaMovimiento,
  getMovimientosHistorial,
  crearMovimientoPanel,
  editarMovimiento,
  eliminarMovimiento,
  getMaquinaria,
  getUsuariosOperadoresApp,
  guardarMaquinaria,
  eliminarMaquinaria,
  getResumenHuertas,
  submitDieselEntrega,
  getDieselEntregas,
  editarDieselEntrega,
  eliminarDieselEntrega,
  restaurarDieselEntrega,
  getDieselDisponiblePorHuerta,
  getReporteDieselCombinado,
  getReporteCombustibleGeneral,
  getRendimientoMaquinaria,
  guardarRendimientoMaquinaria,
  getUnidadesDieselPermitidas,
  getTiposPreventivo,
  guardarTipoPreventivo,
  eliminarTipoPreventivo,
  getReglasMantenimiento,
  guardarReglaMantenimiento,
  eliminarReglaMantenimiento,
  getServiciosMantenimiento,
  guardarServicioMantenimiento,
  getReglasServiciosAutomotrices,
  guardarReglaServicioAutomotriz,
  eliminarReglaServicioAutomotriz,
  getServiciosAutomotrices,
  guardarServicioAutomotriz,
  getEquiposAutomotrices,
  importarServiciosAutomotrices,
  actualizarLecturaManual,
  getRefacciones,
  guardarRefaccion,
  eliminarRefaccion,
  getCatalogoInsumos,
  getInsumos,
  guardarInsumo,
  marcarInsumoAutorizado,
  marcarInsumoEntregado,
  marcarInsumoPendiente,
  eliminarInsumo,
  restaurarInsumo,
  interpretarRefaccionesTexto,
  interpretarRefaccionesFoto,
  getRefaccionesNecesarias,
  guardarRefaccionesNecesarias,
  guardarCostoReparacion,
  marcarRefaccionNecesariaEntregada,
  marcarRefaccionNecesariaPendiente,
  getCategorias,
  guardarCategoria,
  eliminarCategoria,
  getMarcas,
  guardarMarca,
  eliminarMarca,
  getModelos,
  guardarModelo,
  eliminarModelo,
  getHuertasCatalogo,
  guardarHuerta,
  eliminarHuerta,
  guardarImagenMapaHuerta,
  getMapaHuerta,
  guardarCalibracionMapaHuerta,
  iniciarAvance,
  agregarPuntoAvance,
  terminarAvance,
  getAvanceAbierto,
  getAvanceHuerta,
  getRecorridosPorFecha,
  eliminarHistoricoAvanceHuerta,
  guardarCuadroHuerta,
  eliminarCuadroHuerta,
  actualizarSurcosCuadro,
  getCuadrosHuerta,
  guardarActividadHuerta,
  eliminarActividadHuerta,
  getActividadesHuerta,
  getActividadesCatalogo,
  guardarActividadCatalogo,
  eliminarActividadCatalogo,
  getRecursosParaAvanceHuerta,
  asignarActividadCatalogoACuadros,
  getDepartamentosCatalogo,
  guardarDepartamento,
  eliminarDepartamento,
  getOperadoresCatalogo,
  guardarOperador,
  eliminarOperador,
  getTiposUnidad,
  guardarTipoUnidad,
  eliminarTipoUnidad,
  getEmpresasCatalogo,
  guardarEmpresa,
  eliminarEmpresa,
  getProveedoresCombustibleCatalogo,
  guardarProveedorCombustible,
  eliminarProveedorCombustible,
  generarOrdenMantenimiento,
  generarOrdenServicioAutomotriz,
  revisarYGenerarOrdenesPreventivasAutomaticas_,
  recalcularAvanceActividadesHuerta_,
  dentroParaAvance_,
  avanceDeTramo_,
  pasadasNecesarias_,
  tramosDeRecorrido_,
  mismoTrabajoAvance_,
  filtrarSaltosGps_,
  margenCompletado_,
  normalizarTrabajoAvance_,
  getEquiposAvanceHuerta,
  guardarColorEquipoMapa,
  esEquipoAvanceHuerta_,
  intervaloSurcosValido_,
  guardarDireccionSurcosCuadro,
  rumboTramo_,
  diferenciaRumbos_,
  getAvancePorRango,
  calcularResumenRango_,
  validarVentanasRango_,
  getProveedores,
  guardarProveedor,
  eliminarProveedor,
  crearSolicitudCotizacion,
  crearSolicitudesCotizacion,
  getSolicitudesCotizacion,
  getSolicitudCotizacionPublica,
  responderCotizacion,
  aplicarPreciosCotizacion,
  autorizarPrecioItem,
  cancelarSolicitudCotizacion,
  reactivarSolicitudCotizacion,
  getConfigPublico,
  getOrdPendAtencionDias,
  guardarOrdPendAtencionDias,
};
