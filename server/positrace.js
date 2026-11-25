// ------------------------------------------------------------------
// GPS de PosiTrace (nov-2026, Carlos): PosiTrace manda por correo sus
// informes programados ("Nuevo informe listo: Viajes", de
// soporte@positrace.com) a chulareportesmtto@gmail.com. Este módulo:
//   - lee ese buzón por IMAP (solo lectura; no borra ni marca nada),
//   - guarda cada adjunto (.xlsx/.csv) en gps_archivos (aunque todavía no
//     sepamos leer ese tipo de informe, para reprocesarlo después),
//   - convierte el "Informe de Viajes" en filas de gps_viajes (sin repetir:
//     llave equipo + hora de inicio).
// Credenciales: variables de entorno GPS_CORREO_USUARIO y
// GPS_CORREO_PASSWORD (contraseña de aplicación de Google), que Carlos
// carga en Render. Nunca se escriben en el código ni en la base.
// ------------------------------------------------------------------
const ExcelJS = require('exceljs');
const pool = require('./db');

const REMITENTE = 'positrace.com';
const DIAS_ATRAS = 10; // cuántos días de correo revisa cada vez

function credenciales_() {
  const user = (process.env.GPS_CORREO_USUARIO || '').trim();
  const pass = (process.env.GPS_CORREO_PASSWORD || '').replace(/\s+/g, '');
  return user && pass ? { user, pass } : null;
}

// "11/23/2026 07:21:40 AM" -> "2026-11-23 07:21:40" (hora local de México, como viene)
function fechaHora_(s) {
  if (s instanceof Date) {
    const p = (n) => String(n).padStart(2, '0');
    return s.getUTCFullYear() + '-' + p(s.getUTCMonth() + 1) + '-' + p(s.getUTCDate()) + ' ' + p(s.getUTCHours()) + ':' + p(s.getUTCMinutes()) + ':' + p(s.getUTCSeconds());
  }
  const m = String(s || '').trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([AP]M)?)?$/i);
  if (!m) return null;
  let h = Number(m[4] || 0);
  const ap = (m[7] || '').toUpperCase();
  if (ap === 'PM' && h < 12) h += 12;
  if (ap === 'AM' && h === 12) h = 0;
  const p = (n) => String(n).padStart(2, '0');
  return m[3] + '-' + p(m[1]) + '-' + p(m[2]) + ' ' + p(h) + ':' + p(m[5] || 0) + ':' + p(m[6] || 0);
}
// "4284:48:40" / "00:08:26" -> segundos
function segundos_(s) {
  if (typeof s === 'number') return Math.round(s * 86400); // por si Excel la guarda como fracción de día
  const m = String(s || '').trim().match(/^(\d+):(\d{2})(?::(\d{2}))?$/);
  return m ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3] || 0) : null;
}
function numero_(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(String(v).replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
}
function texto_(v) {
  if (v === null || v === undefined) return '';
  if (typeof v === 'object' && v.richText) return v.richText.map((x) => x.text).join('');
  if (typeof v === 'object' && v.text) return String(v.text);
  return String(v).trim();
}
const sinAcentos_ = (s) => texto_(s).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();

// Código AF dentro del nombre del equipo en PosiTrace ("3005 Jesús AF-31",
// "AF015 SERGIO", "AF739-CINTHIA") -> 31 / 15 / 739. null si no trae.
function numeroAf_(s) {
  const m = texto_(s).toUpperCase().match(/(?:^|[^A-Z0-9])AF\s*-?\s*0*(\d{1,4})(?!\d)/);
  return m ? Number(m[1]) : null;
}

// Lee un .xlsx/.csv de PosiTrace. Regresa { tipo, informeId, fechas, generado, zona, filas:[{col:valor}] }.
async function leerArchivo_(buffer, nombre) {
  const wb = new ExcelJS.Workbook();
  if (/\.csv$/i.test(nombre || '')) {
    const { Readable } = require('stream');
    await wb.csv.read(Readable.from([buffer.toString('utf8')]));
  } else {
    await wb.xlsx.load(buffer);
  }
  const info = {};
  const hojaInfo = wb.worksheets.find((w) => /^info$/i.test(w.name));
  if (hojaInfo) hojaInfo.eachRow((r) => { info[sinAcentos_(r.getCell(1).value)] = texto_(r.getCell(2).value); });
  const hoja = wb.worksheets.find((w) => /^data$/i.test(w.name)) || wb.worksheets[0];
  const filas = [];
  let enc = null;
  hoja.eachRow((r) => {
    const valores = [];
    for (let c = 1; c <= r.cellCount; c++) valores.push(r.getCell(c).value);
    if (!enc) { enc = valores.map(sinAcentos_); return; }
    const o = {};
    enc.forEach((k, i) => { if (k) o[k] = valores[i] instanceof Date ? valores[i] : (valores[i] && typeof valores[i] === 'object' ? texto_(valores[i]) : valores[i]); });
    filas.push(o);
  });
  const tipoTexto = sinAcentos_(info['tipo de informe']);
  let tipo = 'desconocido';
  if (/viaje/.test(tipoTexto) || (enc && enc.includes('hora de inicio') && enc.includes('distancia (km)'))) tipo = 'viajes';
  else if (/geocerca/.test(tipoTexto)) tipo = 'geocercas';
  else if (/parada/.test(tipoTexto)) tipo = 'paradas';
  return { tipo, tipoTexto: info['tipo de informe'] || '', informeId: info['id de informe'] || '', fechas: info['fechas'] || '', generado: info['generado el'] || '', zona: info['huso horario'] || '', encabezados: enc || [], filas };
}

// Filas del "Informe de Viajes" -> objetos para gps_viajes.
function viajesDeFilas_(filas) {
  const out = [];
  filas.forEach((f) => {
    const equipo = texto_(f['equipo']).replace(/\s+/g, ' ').trim();
    const inicio = fechaHora_(f['hora de inicio']);
    if (!equipo || !inicio) return;
    const fin = fechaHora_(f['hora de finalizacion']);
    const coords = texto_(f['ubicacion final']).match(/(-?\d+(?:\.\d+)?)[\s,]+(-?\d+(?:\.\d+)?)/);
    const durSeg = segundos_(f['duracion']);
    const fecha = fechaHora_(f['fecha']);
    // Viaje "raro": 20 h o más, o que empieza días antes de la fecha del renglón
    // (GPS sin señal: PosiTrace lo junta todo en un solo viaje).
    const diasAntes = fecha ? (new Date(fecha.slice(0, 10)) - new Date(inicio.slice(0, 10))) / 86400000 : 0;
    out.push({
      equipo,
      inicio,
      fin,
      km: numero_(f['distancia (km)']),
      duracionSeg: durSeg,
      paradaSeg: segundos_(f['duracion de parada']),
      llegada: texto_(f['punto de llegada / direccion']).slice(0, 500),
      lat: coords ? Number(coords[1]) : null,
      lng: coords ? Number(coords[2]) : null,
      odometro: numero_(f['odometro (km)']),
      horasMotorSeg: segundos_(f['horas del motor']),
      sospechoso: (durSeg !== null && durSeg >= 20 * 3600) || diasAntes >= 1 ? 1 : 0,
    });
  });
  return out;
}

// Liga automática por número AF con Maquinaria (si hay uno solo con ese número).
async function mapaAfMaquinaria_() {
  const [rows] = await pool.query('SELECT codigo_unidad, unidad FROM maquinaria');
  const porNum = {};
  rows.forEach((r) => {
    const n = numeroAf_(r.codigo_unidad) ?? numeroAf_(r.unidad);
    if (n === null) return;
    (porNum[n] = porNum[n] || new Set()).add(r.codigo_unidad);
  });
  const mapa = {};
  Object.keys(porNum).forEach((n) => { if (porNum[n].size === 1) mapa[n] = Array.from(porNum[n])[0]; });
  return mapa;
}

async function guardarViajes_(viajes, archivoId) {
  if (!viajes.length) return { nuevos: 0, total: 0 };
  const equipos = Array.from(new Set(viajes.map((v) => v.equipo)));
  const mapa = await mapaAfMaquinaria_();
  for (const e of equipos) {
    const n = numeroAf_(e);
    const sug = n !== null && mapa[n] ? mapa[n] : null;
    // Si ya existe, solo se completa la liga automática cuando no tiene ninguna.
    await pool.query(
      `INSERT INTO gps_equipos (equipo_gps, codigo_unidad, ligado) VALUES (?, ?, ?)
       ON DUPLICATE KEY UPDATE codigo_unidad = IF(codigo_unidad IS NULL AND ligado <> 'manual', VALUES(codigo_unidad), codigo_unidad),
                               ligado = IF(codigo_unidad IS NULL AND ligado <> 'manual' AND VALUES(codigo_unidad) IS NOT NULL, 'auto', ligado)`,
      [e, sug, sug ? 'auto' : 'sin']
    );
  }
  const [[antes]] = await pool.query('SELECT COUNT(*) n FROM gps_viajes');
  for (let i = 0; i < viajes.length; i += 300) {
    const lote = viajes.slice(i, i + 300);
    await pool.query(
      `INSERT INTO gps_viajes (equipo_gps, inicio, fin, km, duracion_seg, parada_seg, llegada, lat, lng, odometro, horas_motor_seg, sospechoso, archivo_id) VALUES ?
       ON DUPLICATE KEY UPDATE fin = VALUES(fin), km = VALUES(km), duracion_seg = VALUES(duracion_seg), parada_seg = VALUES(parada_seg), llegada = VALUES(llegada),
         lat = VALUES(lat), lng = VALUES(lng), odometro = VALUES(odometro), horas_motor_seg = VALUES(horas_motor_seg), sospechoso = VALUES(sospechoso)`,
      [lote.map((v) => [v.equipo, v.inicio, v.fin, v.km, v.duracionSeg, v.paradaSeg, v.llegada, v.lat, v.lng, v.odometro, v.horasMotorSeg, v.sospechoso, archivoId])]
    );
  }
  const [[despues]] = await pool.query('SELECT COUNT(*) n FROM gps_viajes');
  const nuevos = despues.n - antes.n;
  await pool.query(
    `UPDATE gps_equipos e JOIN (SELECT equipo_gps, MAX(inicio) m FROM gps_viajes WHERE equipo_gps IN (?) GROUP BY equipo_gps) x ON x.equipo_gps = e.equipo_gps SET e.ultimo_viaje = x.m`,
    [equipos]
  );
  return { nuevos: Math.max(0, nuevos), total: viajes.length };
}

// Procesa un archivo ya guardado en gps_archivos (sirve también para reprocesar).
async function procesarArchivo_(archivoId) {
  const [[a]] = await pool.query('SELECT id, nombre, contenido FROM gps_archivos WHERE id = ?', [archivoId]);
  if (!a) throw new Error('No existe el archivo ' + archivoId);
  try {
    const leido = await leerArchivo_(a.contenido, a.nombre);
    let filas = 0, nuevos = 0;
    if (leido.tipo === 'viajes') {
      const r = await guardarViajes_(viajesDeFilas_(leido.filas), a.id);
      filas = r.total; nuevos = r.nuevos;
    }
    await pool.query('UPDATE gps_archivos SET tipo = ?, informe_fechas = ?, filas = ?, procesado = ?, error = NULL WHERE id = ?',
      [leido.tipo, leido.fechas.slice(0, 60), filas || leido.filas.length, leido.tipo === 'viajes' ? 1 : 0, a.id]);
    return { tipo: leido.tipo, filas: filas || leido.filas.length, nuevos };
  } catch (err) {
    await pool.query('UPDATE gps_archivos SET error = ? WHERE id = ?', [String(err.message || err).slice(0, 500), a.id]);
    throw err;
  }
}

// Guarda un adjunto (si no estaba ya) y lo procesa.
async function guardarAdjunto_(messageId, asunto, recibido, nombre, buffer) {
  const [r] = await pool.query(
    'INSERT IGNORE INTO gps_archivos (message_id, asunto, recibido, nombre, contenido) VALUES (?, ?, ?, ?, ?)',
    [messageId.slice(0, 250), (asunto || '').slice(0, 250), recibido, nombre.slice(0, 250), buffer]
  );
  if (!r.insertId) return null; // ya estaba
  return procesarArchivo_(r.insertId);
}

function partesAdjuntas_(nodo, out) {
  out = out || [];
  if (!nodo) return out;
  if (nodo.childNodes) nodo.childNodes.forEach((n) => partesAdjuntas_(n, out));
  const nombre = (nodo.dispositionParameters && nodo.dispositionParameters.filename) || (nodo.parameters && nodo.parameters.name) || '';
  if (nombre && /\.(xlsx|csv)$/i.test(nombre)) out.push({ part: nodo.part || '1', nombre });
  return out;
}

let REVISANDO = false;
async function guardarEstado_(clave, valor) {
  await pool.query('INSERT INTO configuracion (clave, valor) VALUES (?, ?) ON DUPLICATE KEY UPDATE valor = VALUES(valor)', [clave, valor]);
}

// Revisa el buzón. opciones.cliente permite inyectar un IMAP falso en pruebas.
async function revisarCorreoGps(opciones) {
  opciones = opciones || {};
  const cred = credenciales_();
  if (!cred && !opciones.cliente) return { configurado: false };
  if (REVISANDO) return { configurado: true, ocupado: true };
  REVISANDO = true;
  const resumen = { configurado: true, correos: 0, archivos: 0, viajesNuevos: 0, errores: [] };
  let cliente = opciones.cliente;
  try {
    if (!cliente) {
      const { ImapFlow } = require('imapflow');
      cliente = new ImapFlow({ host: 'imap.gmail.com', port: 993, secure: true, auth: cred, logger: false });
    }
    await cliente.connect();
    const lock = await cliente.getMailboxLock('INBOX', { readOnly: true });
    try {
      const desde = new Date(Date.now() - DIAS_ATRAS * 86400000);
      const uids = await cliente.search({ from: REMITENTE, since: desde }, { uid: true });
      if (uids && uids.length) {
        const [ya] = await pool.query('SELECT DISTINCT message_id FROM gps_archivos WHERE recibido >= ?', [desde]);
        const vistos = new Set(ya.map((x) => x.message_id));
        const mensajes = [];
        for await (const m of cliente.fetch(uids, { envelope: true, bodyStructure: true, internalDate: true }, { uid: true })) mensajes.push(m);
        for (const m of mensajes) {
          const messageId = (m.envelope && m.envelope.messageId) || ('uid-' + m.uid);
          if (vistos.has(messageId)) continue;
          resumen.correos++;
          for (const p of partesAdjuntas_(m.bodyStructure)) {
            try {
              const { content } = await cliente.download(m.uid, p.part, { uid: true });
              const trozos = [];
              for await (const t of content) trozos.push(t);
              const r = await guardarAdjunto_(messageId, m.envelope && m.envelope.subject, m.internalDate || new Date(), p.nombre, Buffer.concat(trozos));
              if (r) { resumen.archivos++; resumen.viajesNuevos += r.nuevos || 0; }
            } catch (err) {
              resumen.errores.push(p.nombre + ': ' + (err.message || err));
            }
          }
        }
      }
    } finally {
      lock.release();
    }
    await cliente.logout();
    await guardarEstado_('gps_ultima_revision', new Date().toISOString());
    await guardarEstado_('gps_ultimo_error', resumen.errores.join(' | ').slice(0, 1000));
    return resumen;
  } catch (err) {
    const msg = /auth|credential|login/i.test(String(err.message || err) + String(err.responseText || ''))
      ? 'Gmail no aceptó el usuario o la contraseña de aplicación (revisa GPS_CORREO_USUARIO / GPS_CORREO_PASSWORD en Render).'
      : String(err.message || err);
    await guardarEstado_('gps_ultima_revision', new Date().toISOString()).catch(() => {});
    await guardarEstado_('gps_ultimo_error', msg.slice(0, 1000)).catch(() => {});
    try { if (cliente) await cliente.logout(); } catch (e) { /* nada */ }
    return Object.assign(resumen, { error: msg });
  } finally {
    REVISANDO = false;
  }
}

module.exports = { revisarCorreoGps, leerArchivo_, viajesDeFilas_, guardarAdjunto_, procesarArchivo_, numeroAf_, fechaHora_, segundos_, credenciales_ };
