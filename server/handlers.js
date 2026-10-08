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
// agrícola) — ver combustible_automotriz en schema.sql.
const PESTANAS_PANEL = ['ordenes', 'diesel', 'combustible_automotriz', 'movimientos', 'maquinaria', 'catalogo', 'mantenimiento', 'refacciones', 'insumos', 'usuarios'];

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
async function requiereAccesoOrdenes_(code, nombreUsuario, nivelPanelRequerido) {
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
    await requierePermisoPanel_(code, nombre, 'ordenes', nivelPanelRequerido);
  } else {
    requiereClave_(code, TALLER_ACCESS_CODE);
  }
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
    reportes.en_proceso_sin_fecha                       AS EnProcesoSinFecha,
    (SELECT COUNT(*) FROM reportes_refacciones_necesarias rrn WHERE rrn.orden = reportes.orden) AS RefaccionesNecesariasCount,
    (SELECT COUNT(*) FROM reportes_refacciones_necesarias rrn WHERE rrn.orden = reportes.orden AND rrn.entregado = 1) AS RefaccionesEntregadasCount,
    mo.regla_id                          AS ReglaMantenimientoId,
    mo.lectura_generacion                AS LecturaGeneracion,
    mo.lectura_cierre                    AS LecturaCierre,
    mr.tipo_periodicidad                 AS TipoPeriodicidadRegla,
    m.departamento                       AS Departamento,
    m.operador_asignado                  AS OperadorAsignado
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
    usuario_llegada     AS UsuarioLlegada,
    fecha_llegada       AS FechaLlegada,
    comentario_llegada  AS ComentarioLlegada,
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

async function submitReporte(data) {
  data = data || {};
  try {
    let fotoUrl = '';
    if (data.foto) fotoUrl = await guardarArchivo_(data.foto);
    let descripcionAudioUrl = '';
    if (data.descripcionAudio) descripcionAudioUrl = await guardarArchivo_(data.descripcionAudio);

    const orden = await siguienteFolio_(pool, 'orden', 'OF', 5);
    const esSoldadura = data.esSoldadura ? 1 : 0;
    const esAutomotriz = data.esAutomotriz ? 1 : 0;
    await pool.query(
      `INSERT INTO reportes
        (orden, codigo_unidad, unidad, huerta, descripcion, nombre, fecha, foto_url, descripcion_audio_url, es_soldadura, es_automotriz)
       VALUES (?, ?, ?, ?, ?, ?, NOW(), ?, ?, ?, ?)`,
      [orden, data.unidad || '', data.unidadLabel || '', data.huerta || '', data.descripcion || '', data.nombre || '', fotoUrl || null, descripcionAudioUrl || null, esSoldadura, esAutomotriz]
    );

    return { success: true, orden, fotoUrl, descripcionAudioUrl };
  } catch (err) {
    return { success: false, error: err.toString() };
  }
}

// Staff: crea una orden directamente desde el Panel (pestaña Órdenes →
// "Nueva orden"), sin pasar por el formulario "Reportar" del celular. A
// diferencia de submitReporte, aquí la foto es opcional (el Panel es de
// escritorio, no siempre hay una foto a la mano) y la fecha del reporte la
// elige quien la captura en vez de tomarse siempre como "ahora".
async function crearOrdenPanel(code, nombreUsuario, data) {
  await requierePermisoPanel_(code, nombreUsuario, 'ordenes', 'capturar');
  data = data || {};
  try {
    const codigoUnidad = (data.unidad || '').toString().trim();
    const unidadLabel = (data.unidadLabel || '').toString().trim();
    const huerta = (data.huerta || '').toString().trim();
    const descripcion = (data.descripcion || '').toString().trim();
    const nombre = (data.nombre || '').toString().trim();
    const fecha = normalizarFechaLocal_(data.fecha);
    const esSoldadura = data.esSoldadura ? 1 : 0;
    const esAutomotriz = data.esAutomotriz ? 1 : 0;

    if (!codigoUnidad || !unidadLabel) return { success: false, error: 'Selecciona la unidad.' };
    if (!huerta) return { success: false, error: 'Selecciona la huerta.' };
    const huertasRestringidas = await obtenerHuertasRestringidasUsuario_(nombreUsuario);
    if (!huertaPermitida_(huertasRestringidas, huerta)) {
      return { success: false, error: 'Tu usuario no tiene acceso a crear órdenes en la huerta ' + huerta + '.' };
    }
    if (!descripcion) return { success: false, error: 'Escribe la descripción.' };
    if (!nombre) return { success: false, error: 'Escribe quién reportó.' };
    if (!fecha) return { success: false, error: 'Selecciona la fecha del reporte.' };

    let fotoUrl = '';
    if (data.foto) fotoUrl = await guardarArchivo_(data.foto);

    const orden = await siguienteFolio_(pool, 'orden', 'OF', 5);
    await pool.query(
      `INSERT INTO reportes
        (orden, codigo_unidad, unidad, huerta, descripcion, nombre, fecha, foto_url, es_soldadura, es_automotriz)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [orden, codigoUnidad, unidadLabel, huerta, descripcion, nombre, fecha, fotoUrl || null, esSoldadura, esAutomotriz]
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
  await requiereAccesoOrdenes_(code, nombreUsuario, 'visualizar');
  const huertasRestringidas = await obtenerHuertasRestringidasUsuario_(nombreUsuario);
  const [rows] = huertasRestringidas
    ? await pool.query(REPORTE_SELECT + ' WHERE UPPER(TRIM(reportes.huerta)) IN (?) ORDER BY reportes.id DESC', [huertasRestringidas])
    : await pool.query(REPORTE_SELECT + ' ORDER BY reportes.id DESC');
  return normalizaFilas(rows);
}

async function actualizarOrden(code, nombreUsuario, orden, campos) {
  await requiereAccesoOrdenes_(code, nombreUsuario, 'capturar');
  campos = campos || {};
  try {
    const [existe] = await pool.query('SELECT id, unidad, descripcion, huerta FROM reportes WHERE orden = ?', [orden]);
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
async function marcarOrdenEnProceso(code, nombreUsuario, orden) {
  await requierePermisoPanel_(code, nombreUsuario, 'ordenes', 'capturar');
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
    await pool.query('UPDATE reportes SET en_proceso_sin_fecha = 1 WHERE orden = ?', [orden]);
    await agregarObservacionOrden_(
      orden,
      'Marcada "En proceso" (todavía sin Fecha de atención) por ' + (nombreUsuario || 'alguien del Panel') + '.'
    );
    await registrarAuditoria_('reportes', orden, 'marcar-en-proceso', nombreUsuario, (rows[0].unidad || '') + ' — ' + (rows[0].descripcion || ''));
    return { success: true };
  } catch (err) {
    return { success: false, error: err.toString() };
  }
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
  await requierePermisoPanel_(code, nombreUsuario, 'ordenes', 'capturar');
  data = data || {};
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
    const nota = (data.nota || '').toString().trim();

    if (!huerta) return { success: false, error: 'Selecciona la huerta.' };
    if (!descripcion) return { success: false, error: 'Escribe la descripción.' };
    if (!nombre) return { success: false, error: 'Escribe quién reportó.' };
    if (!fecha) return { success: false, error: 'Selecciona la fecha del reporte.' };

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
        refaccionamiento = ?, atendio_por = ?, trabajo_realizado = ?, visto_bueno = ?, dias_atencion = ?, es_soldadura = ?, es_automotriz = ?, en_proceso_sin_fecha = ?, modificado_por = ?, modificado_en = NOW()
       WHERE orden = ?`,
      [huerta, descripcion, nombre, fecha, fechaAtencion, fechaSalida, refaccionamiento, atendioPor, trabajoRealizado, vistoBueno, diasAtencion, esSoldadura, esAutomotriz, enProcesoSinFecha, modificadoPor, orden]
    );

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
  await requierePermisoPanel_(code, nombreUsuario, 'ordenes', 'capturar');
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
    const [rows] = await pool.query('SELECT id, unidad FROM combustible_automotriz WHERE id = ?', [idNum]);
    if (rows.length === 0) return { success: false, error: 'No se encontró esa carga de gasolina.' };

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
    const [rows] = await pool.query('SELECT id, unidad, litros, eliminado FROM combustible_automotriz WHERE id = ?', [idNum]);
    if (rows.length === 0) return { success: false, error: 'No se encontró esa carga de gasolina.' };
    if (rows[0].eliminado) return { success: false, error: 'Esa carga ya estaba eliminada.' };
    const eliminadoPor = (nombreUsuario || '').toString().trim() || null;
    await pool.query(
      'UPDATE combustible_automotriz SET eliminado = 1, eliminado_por = ?, eliminado_en = NOW() WHERE id = ?',
      [eliminadoPor, idNum]
    );
    await registrarAuditoria_('combustible_automotriz', idNum, 'eliminar', nombreUsuario, (rows[0].unidad || '') + ' — ' + rows[0].litros + ' L');
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
function datosReportarUsuario_(usuario) {
  let huertasReportar = [];
  try {
    const lista = usuario.huertas_reportar ? JSON.parse(usuario.huertas_reportar) : [];
    if (Array.isArray(lista)) huertasReportar = lista.map((h) => (h || '').toString().trim()).filter(Boolean);
  } catch (err) {
    huertasReportar = [];
  }
  return {
    huerta: usuario.huerta || '',
    huertasReportar,
    veCasillaSoldadura: !!usuario.ve_casilla_soldadura,
    veCasillaAutomotriz: !!usuario.ve_casilla_automotriz,
  };
}

async function getHuertaPorUsuario(nombre) {
  if (!nombre) return datosReportarUsuario_({});
  const [rows] = await pool.query(
    'SELECT huerta, huertas_reportar, ve_casilla_soldadura, ve_casilla_automotriz FROM usuarios WHERE LOWER(TRIM(nombre)) = LOWER(TRIM(?))',
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
  const resultado = { success: true, ...datosReportarUsuario_(usuario) };
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
  const [rows] = await pool.query('SELECT nombre, huerta, password_hash, modulos, panel_permisos, huertas_ordenes, ver_letrero_ord_pend, huertas_reportar, ve_casilla_soldadura, ve_casilla_automotriz FROM usuarios ORDER BY nombre');
  return rows
    .filter((r) => r.nombre)
    .map((r) => ({
      Nombre: r.nombre,
      Huerta: r.huerta || '',
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
async function guardarUsuario(code, nombreUsuario, nombre, huerta, password, modulos, panelPermisos, huertasOrdenes, veLetreroOrdPend, huertasReportar, veCasillaSoldadura, veCasillaAutomotriz) {
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
  try {
    const [existe] = await pool.query('SELECT id, password_hash FROM usuarios WHERE LOWER(TRIM(nombre)) = LOWER(TRIM(?))', [nombre]);
    if (existe.length === 0) {
      if (!password) return { success: false, error: 'Asigna una contraseña al crear un usuario nuevo.' };
      const hash = await bcrypt.hash(String(password), 10);
      await pool.query(
        'INSERT INTO usuarios (nombre, huerta, password_hash, modulos, panel_permisos, huertas_ordenes, ver_letrero_ord_pend, huertas_reportar, ve_casilla_soldadura, ve_casilla_automotriz) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [nombre, huerta || '', hash, modulosStr, panelPermisosStr, huertasOrdenesStr, veLetreroOrdPendInt, huertasReportarStr, veCasillaSoldaduraInt, veCasillaAutomotrizInt]
      );
    } else {
      if (password) {
        const hash = await bcrypt.hash(String(password), 10);
        await pool.query(
          'UPDATE usuarios SET huerta = ?, password_hash = ?, modulos = ?, panel_permisos = ?, huertas_ordenes = ?, ver_letrero_ord_pend = ?, huertas_reportar = ?, ve_casilla_soldadura = ?, ve_casilla_automotriz = ? WHERE id = ?',
          [huerta || '', hash, modulosStr, panelPermisosStr, huertasOrdenesStr, veLetreroOrdPendInt, huertasReportarStr, veCasillaSoldaduraInt, veCasillaAutomotrizInt, existe[0].id]
        );
      } else {
        await pool.query(
          'UPDATE usuarios SET huerta = ?, modulos = ?, panel_permisos = ?, huertas_ordenes = ?, ver_letrero_ord_pend = ?, huertas_reportar = ?, ve_casilla_soldadura = ?, ve_casilla_automotriz = ? WHERE id = ?',
          [huerta || '', modulosStr, panelPermisosStr, huertasOrdenesStr, veLetreroOrdPendInt, huertasReportarStr, veCasillaSoldaduraInt, veCasillaAutomotrizInt, existe[0].id]
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

    const [urows] = await pool.query('SELECT huerta FROM usuarios WHERE LOWER(TRIM(nombre)) = LOWER(TRIM(?))', [nombre]);
    const huertaOrigen = (urows[0] && urows[0].huerta) || '';
    if (!huertaOrigen) return { success: false, error: 'Tu usuario no tiene una huerta asignada. Pídele al Panel que te la configure.' };
    if (huertaOrigen.trim().toLowerCase() === data.huertaDestino.trim().toLowerCase()) {
      return { success: false, error: 'La huerta de destino debe ser diferente a tu huerta.' };
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

    const folio = await siguienteFolio_(pool, 'movimiento', 'MOV', 5);
    await pool.query(
      `INSERT INTO movimientos_maquinaria
        (folio, codigo_unidad, unidad, huerta_origen, huerta_destino, usuario_salida, fecha_salida, comentario_salida, estado, foto_salida_url)
       VALUES (?, ?, ?, ?, ?, ?, NOW(), ?, 'pendiente', ?)`,
      [folio, data.unidad, data.unidadLabel || '', huertaOrigen, data.huertaDestino, nombre, data.comentario || null, fotoSalidaUrl || null]
    );
    return { success: true, folio, fotoUrl: fotoSalidaUrl };
  } catch (err) {
    return { success: false, error: err.toString() };
  }
}

// Para la pantalla del módulo Movimientos: lo que le falta confirmar a la
// huerta del usuario (llegadas pendientes) y sus propias salidas recientes.
async function getMovimientosDeUsuario(nombre) {
  if (!nombre) return { huerta: '', pendientesLlegada: [], misSalidas: [] };
  const [urows] = await pool.query('SELECT huerta FROM usuarios WHERE LOWER(TRIM(nombre)) = LOWER(TRIM(?))', [nombre]);
  const huerta = (urows[0] && urows[0].huerta) || '';
  const [pendientes] = await pool.query(
    MOVIMIENTO_SELECT + " WHERE estado = 'pendiente' AND LOWER(TRIM(huerta_destino)) = LOWER(TRIM(?)) ORDER BY id DESC",
    [huerta]
  );
  const [misSalidas] = await pool.query(
    MOVIMIENTO_SELECT + ' WHERE LOWER(TRIM(usuario_salida)) = LOWER(TRIM(?)) ORDER BY id DESC LIMIT 20',
    [nombre]
  );
  return { huerta, pendientesLlegada: normalizaFilas(pendientes), misSalidas: normalizaFilas(misSalidas) };
}

async function confirmarLlegadaMovimiento(folio, nombre, comentario, foto) {
  try {
    if (!folio || !nombre) return { success: false, error: 'Faltan datos para confirmar la llegada.' };
    const [rows] = await pool.query('SELECT * FROM movimientos_maquinaria WHERE folio = ?', [folio]);
    if (!rows.length) return { success: false, error: 'No se encontró ese movimiento.' };
    const mov = rows[0];
    if (mov.estado === 'confirmado') return { success: false, error: 'Este movimiento ya había sido confirmado.' };

    const [urows] = await pool.query('SELECT huerta FROM usuarios WHERE LOWER(TRIM(nombre)) = LOWER(TRIM(?))', [nombre]);
    const huertaUsuario = ((urows[0] && urows[0].huerta) || '').trim().toLowerCase();
    if (huertaUsuario !== (mov.huerta_destino || '').trim().toLowerCase()) {
      return { success: false, error: 'Solo alguien de ' + mov.huerta_destino + ' puede confirmar esta llegada.' };
    }

    let fotoLlegadaUrl = '';
    if (foto) fotoLlegadaUrl = await guardarArchivo_(foto);

    await pool.query(
      "UPDATE movimientos_maquinaria SET estado = 'confirmado', usuario_llegada = ?, fecha_llegada = NOW(), comentario_llegada = ?, foto_llegada_url = ? WHERE folio = ?",
      [nombre, comentario || null, fotoLlegadaUrl || null, folio]
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
    const usuarioLlegada = (data.usuarioLlegada || '').toString().trim() || null;
    const fechaLlegada = normalizarFechaLocal_(data.fechaLlegada);
    const comentarioLlegada = (data.comentarioLlegada || '').toString().trim() || null;
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
        (folio, codigo_unidad, unidad, huerta_origen, huerta_destino, usuario_salida, fecha_salida, comentario_salida,
         usuario_llegada, fecha_llegada, comentario_llegada, estado)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [folio, codigoUnidad, unidadFinal, huertaOrigen, huertaDestino, usuarioSalida, fechaSalida, comentarioSalida,
        usuarioLlegada, fechaLlegada, comentarioLlegada, estado]
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
    const usuarioLlegada = (data.usuarioLlegada || '').toString().trim() || null;
    const fechaLlegada = normalizarFechaLocal_(data.fechaLlegada);
    const comentarioLlegada = (data.comentarioLlegada || '').toString().trim() || null;
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
        comentario_salida = ?, usuario_llegada = ?, fecha_llegada = ?, comentario_llegada = ?, estado = ?,
        modificado_por = ?, modificado_en = NOW()
       WHERE id = ?`,
      [huertaOrigen, huertaDestino, usuarioSalida, fechaSalida, comentarioSalida, usuarioLlegada, fechaLlegada, comentarioLlegada, estado, modificadoPor, idNum]
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
    m.operador_asignado AS OperadorAsignado
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

    await pool.query(
      `INSERT INTO maquinaria
        (codigo_unidad, unidad, departamento, marca_id, modelo_id, anio, color, serie, placa, tipo_unidad, observaciones, usa_diesel, usa_gasolina, combustible_automotriz_tipo, operador_asignado)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
        unidad = VALUES(unidad), departamento = VALUES(departamento), marca_id = VALUES(marca_id),
        modelo_id = VALUES(modelo_id), anio = VALUES(anio), color = VALUES(color), serie = VALUES(serie),
        placa = VALUES(placa), tipo_unidad = VALUES(tipo_unidad), observaciones = VALUES(observaciones),
        usa_diesel = VALUES(usa_diesel), usa_gasolina = VALUES(usa_gasolina),
        combustible_automotriz_tipo = VALUES(combustible_automotriz_tipo),
        operador_asignado = VALUES(operador_asignado)`,
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
// diesel con lectura capturada, o la lectura manual si es más reciente
// (ver también getMaquinaria/getReglasMantenimiento originalmente).
async function getLecturasActualesPorEquipo_() {
  // Antes esto comparaba por MAX(fecha) y hacía JOIN contra esa fecha: si
  // una unidad tenía dos cargas de diesel con la MISMA fecha (algo normal —
  // "fecha" es un DATETIME, pero varias capturas quedan a medianoche
  // cuando se editan a mano o vienen de un campo de solo fecha), el JOIN
  // podía regresar ambas filas empatadas y cuál "ganaba" en el mapa final
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

  const [maquinas] = await pool.query(
    'SELECT codigo_unidad AS CodigoUnidad, lectura_manual AS LecturaManual, lectura_manual_fecha AS LecturaManualFecha FROM maquinaria'
  );

  const map = {};
  maquinas.forEach((m) => {
    const codigo = m.CodigoUnidad;
    const auto = dieselMap[codigo] || null;
    const manualLectura = m.LecturaManual !== null && m.LecturaManual !== undefined ? Number(m.LecturaManual) : null;
    const manualFecha = m.LecturaManualFecha ? new Date(m.LecturaManualFecha) : null;

    let lecturaActual = null;
    let lecturaActualFecha = null;
    let lecturaActualOrigen = null;
    if (auto && manualLectura !== null && manualFecha) {
      if (manualFecha.getTime() >= new Date(auto.fecha).getTime()) {
        lecturaActual = manualLectura; lecturaActualFecha = manualFecha; lecturaActualOrigen = 'manual';
      } else {
        lecturaActual = auto.lectura; lecturaActualFecha = new Date(auto.fecha); lecturaActualOrigen = 'diesel';
      }
    } else if (auto) {
      lecturaActual = auto.lectura; lecturaActualFecha = new Date(auto.fecha); lecturaActualOrigen = 'diesel';
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
const PESTANAS_CATALOGO_TIPO_PREVENTIVO_ = ['mantenimiento', 'catalogo'];

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
async function getReglasMantenimiento(code, nombreUsuario) {
  await requierePermisoPanel_(code, nombreUsuario, 'mantenimiento', 'visualizar');

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
      r.activo            AS Activo
    FROM mantenimiento_reglas r
    LEFT JOIN modelos_refacciones mo ON mo.id = r.modelo_id
    LEFT JOIN marcas_refacciones mc ON mc.id = mo.marca_id
    LEFT JOIN tipos_preventivo tp ON tp.id = r.tipo_preventivo_id
    WHERE r.modelo_id IS NOT NULL
    ORDER BY mc.nombre, mo.nombre, tp.nombre
  `);

  const asignadasPorRegla = await getRefaccionesAsignadasPorRegla_();

  return reglas.map((r) => ({
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
  }));
}

async function guardarReglaMantenimiento(code, nombreUsuario, id, data) {
  await requierePermisoPanel_(code, nombreUsuario, 'mantenimiento', 'capturar');
  data = data || {};
  try {
    const modeloId = (data.modeloId === '' || data.modeloId === undefined || data.modeloId === null)
      ? null : Number(data.modeloId);
    const tipoPreventivoId = (data.tipoPreventivoId === '' || data.tipoPreventivoId === undefined || data.tipoPreventivoId === null)
      ? null : Number(data.tipoPreventivoId);
    const tipo = (data.tipoPeriodicidad || 'horas').toString().trim();
    const intervalo = Number(data.intervalo);

    if (!modeloId) return { success: false, error: 'Selecciona el modelo.' };
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
  const servicios = await obtenerServiciosMantenimiento_();
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

// Misma consulta que getServiciosMantenimiento, sin el chequeo de permiso,
// para uso interno (p.ej. el job automático que revisa si hay que generar
// una orden). No exportar directamente: siempre pasar por una función que
// sí valide permiso cuando la llame el frontend.
async function obtenerServiciosMantenimiento_() {
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

  return filas.map((r) => {
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
}

// Captura/edita a mano el "último servicio" (fecha + horómetro) de un
// equipo para una regla en particular, y opcionalmente un intervalo propio
// para ese equipo (intervaloOverride) distinto al estándar del modelo.
async function guardarServicioMantenimiento(code, nombreUsuario, reglaId, codigoUnidad, data) {
  await requierePermisoPanel_(code, nombreUsuario, 'mantenimiento', 'capturar');
  data = data || {};
  try {
    if (!reglaId) return { success: false, error: 'Falta la regla.' };
    codigoUnidad = (codigoUnidad || '').toString().trim();
    if (!codigoUnidad) return { success: false, error: 'Falta el equipo.' };

    const [reglas] = await pool.query('SELECT modelo_id FROM mantenimiento_reglas WHERE id = ?', [reglaId]);
    if (reglas.length === 0) return { success: false, error: 'No se encontró la regla de mantenimiento.' };
    const [maquinas] = await pool.query('SELECT modelo_id FROM maquinaria WHERE codigo_unidad = ?', [codigoUnidad]);
    if (maquinas.length === 0) return { success: false, error: 'No se encontró el equipo.' };
    if (!reglas[0].modelo_id || reglas[0].modelo_id !== maquinas[0].modelo_id) {
      return { success: false, error: 'Ese equipo no es del modelo de esta regla.' };
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
  await requiereAccesoOrdenes_(code, nombreUsuario, 'capturar');
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
  await requiereAccesoOrdenes_(code, nombreUsuario, 'capturar');
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
  await requiereAccesoOrdenes_(code, nombreUsuario, 'visualizar');

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
  await requiereAccesoOrdenes_(code, nombreUsuario, 'capturar');
  items = Array.isArray(items) ? items : [];

  const [ordenRows] = await pool.query('SELECT orden FROM reportes WHERE orden = ?', [orden]);
  if (ordenRows.length === 0) return { success: false, error: 'No se encontró la orden ' + orden + '.' };

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

// Marca/quita la marca de "Entregado" de UNA pieza ya guardada en la lista
// de refacciones necesarias de una orden (columna Refaccionamiento). Es
// independiente de guardarRefaccionesNecesarias (que reemplaza la lista
// completa) — actúa de una vez sobre ese renglón, mismo criterio que
// marcarInsumoEntregado/marcarInsumoPendiente en Insumos, para no obligar a
// abrir "Guardar lista" solo para marcar una pieza como entregada.
async function marcarRefaccionNecesariaEntregada(code, nombreUsuario, id) {
  await requiereAccesoOrdenes_(code, nombreUsuario, 'capturar');
  const idNum = Number(id);
  if (!idNum) return { success: false, error: 'Falta el identificador de la pieza.' };
  const [rows] = await pool.query('SELECT id, orden FROM reportes_refacciones_necesarias WHERE id = ?', [idNum]);
  if (!rows.length) return { success: false, error: 'No se encontró esa pieza.' };
  await pool.query(
    'UPDATE reportes_refacciones_necesarias SET entregado = 1, entregado_por = ?, entregado_en = NOW() WHERE id = ?',
    [nombreUsuario, idNum]
  );
  await agregarObservacionOrden_(rows[0].orden, (nombreUsuario || 'Alguien') + ' marcó una pieza de refaccionamiento como entregada.');
  return { success: true };
}

async function marcarRefaccionNecesariaPendiente(code, nombreUsuario, id) {
  await requiereAccesoOrdenes_(code, nombreUsuario, 'capturar');
  const idNum = Number(id);
  if (!idNum) return { success: false, error: 'Falta el identificador de la pieza.' };
  const [rows] = await pool.query('SELECT id, orden FROM reportes_refacciones_necesarias WHERE id = ?', [idNum]);
  if (!rows.length) return { success: false, error: 'No se encontró esa pieza.' };
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
           h.proveedor_id AS ProveedorId, p.nombre AS ProveedorNombre
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

async function getDepartamentosCatalogo(code, nombreUsuario) { return catalogoDepartamentos_.get(code, nombreUsuario); }
async function guardarDepartamento(code, nombreUsuario, id, data) { return catalogoDepartamentos_.guardar(code, nombreUsuario, id, data); }
async function eliminarDepartamento(code, nombreUsuario, id) { return catalogoDepartamentos_.eliminar(code, nombreUsuario, id); }

async function getTiposUnidad(code, nombreUsuario) { return catalogoTiposUnidad_.get(code, nombreUsuario); }
async function guardarTipoUnidad(code, nombreUsuario, id, data) { return catalogoTiposUnidad_.guardar(code, nombreUsuario, id, data); }
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
const PESTANAS_CATALOGO_MARCAS_ = ['refacciones', 'maquinaria', 'catalogo'];

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
  const [rows] = await pool.query(`
    SELECT m.id AS Id, m.marca_id AS MarcaId, m.nombre AS Nombre
    FROM modelos_refacciones m
    ORDER BY m.nombre
  `);
  return rows.map((r) => ({ Id: r.Id, MarcaId: r.MarcaId, Nombre: r.Nombre }));
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
  await requierePermisoPanel_(code, nombreUsuario, 'refacciones', 'visualizar');
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
  await requierePermisoPanel_(code, nombreUsuario, 'ordenes', 'visualizar');
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

    const [maquinasLabel] = await pool.query('SELECT unidad FROM maquinaria WHERE codigo_unidad = ?', [codigoUnidad]);
    const unidadLabel = maquinasLabel.length > 0 ? maquinasLabel[0].unidad : codigoUnidad;

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
      `INSERT INTO reportes (orden, codigo_unidad, unidad, huerta, descripcion, nombre, fecha)
       VALUES (?, ?, ?, ?, ?, ?, NOW())`,
      [orden, codigoUnidad, unidadLabel, huerta, descripcion, data.nombre]
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

module.exports = {
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
  revisarYGenerarOrdenesPreventivasAutomaticas_,
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
