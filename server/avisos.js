// ============================================================
// Avisos de recorridos (oct-2026, petición de Carlos: "mándame un aviso
// cuando inicien y terminen recorrido", por el Panel y por Telegram).
//
// Cuando un operador INICIA o TERMINA un recorrido de Avance de huerta
// (en vivo, o después, cuando el celular sin señal manda lo que guardó),
// se avisa:
//  - por TELEGRAM, al chat (persona o grupo) que se configuró desde el
//    Panel (Avance Huerta → 🔔 Avisos). El token del bot se guarda solo en
//    la base de datos (tabla configuracion) y nunca se regresa al navegador;
//  - con NOTIFICACIÓN del Panel (Web Push) a cada computadora/celular que
//    activó "Avisos en este equipo". Llega aunque el Panel esté cerrado.
//    Las llaves VAPID se generan solas la primera vez y se guardan en
//    configuracion (la privada nunca sale del servidor).
//
// El cifrado de Web Push (RFC 8291, aes128gcm) y la firma VAPID (RFC 8292,
// ES256) se hacen con el módulo crypto de Node -- sin dependencias nuevas.
//
// Los avisos NUNCA frenan ni tumban el guardado del recorrido: se mandan
// por fuera (avisarRecorrido_ no lanza errores) y si Telegram o el
// servicio de notificaciones fallan, solo se registra en el log.
// ============================================================
const crypto = require('crypto');
const pool = require('./db');

const ZONA_AVISOS = 'America/Mexico_City';
const AVISO_TARDE_MS = 10 * 60 * 1000; // más de 10 min después: "llegó tarde (sin señal)"
const TELEGRAM_API = () => (process.env.TELEGRAM_API_BASE || 'https://api.telegram.org').replace(/\/+$/, '');
const VAPID_SUJETO = 'mailto:avisos@chulabrand.com';

// ---------- configuración ----------
async function leerConfig_(clave) {
  const [rows] = await pool.query('SELECT valor FROM configuracion WHERE clave = ?', [clave]);
  return rows.length ? rows[0].valor : null;
}
async function guardarConfig_(clave, valor) {
  if (valor === null || valor === undefined) {
    await pool.query('DELETE FROM configuracion WHERE clave = ?', [clave]);
    return;
  }
  await pool.query(
    'INSERT INTO configuracion (clave, valor) VALUES (?, ?) ON DUPLICATE KEY UPDATE valor = VALUES(valor)',
    [clave, String(valor)]
  );
}

// ---------- base64url ----------
function b64u_(buf) { return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }
function deB64u_(txt) { return Buffer.from(String(txt || '').replace(/-/g, '+').replace(/_/g, '/'), 'base64'); }

// ---------- VAPID ----------
let vapidCache_ = null;
function generarVapid_() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const jwkPub = publicKey.export({ format: 'jwk' });
  const jwkPriv = privateKey.export({ format: 'jwk' });
  const publica = Buffer.concat([Buffer.from([4]), deB64u_(jwkPub.x), deB64u_(jwkPub.y)]);
  return { publica: b64u_(publica), privada: jwkPriv.d };
}
async function clavesVapid_() {
  if (vapidCache_) return vapidCache_;
  let publica = await leerConfig_('vapid_publica');
  let privada = await leerConfig_('vapid_privada');
  if (!publica || !privada) {
    const nuevas = generarVapid_();
    // INSERT IGNORE: si dos peticiones las generan a la vez, se queda la primera.
    await pool.query("INSERT IGNORE INTO configuracion (clave, valor) VALUES ('vapid_publica', ?), ('vapid_privada', ?)", [nuevas.publica, nuevas.privada]);
    publica = await leerConfig_('vapid_publica');
    privada = await leerConfig_('vapid_privada');
  }
  vapidCache_ = { publica, privada };
  return vapidCache_;
}
function firmarVapid_(endpoint, claves, ahoraMs) {
  const aud = new URL(endpoint).origin;
  const encabezado = b64u_(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
  const datos = b64u_(JSON.stringify({ aud, exp: Math.floor((ahoraMs || Date.now()) / 1000) + 12 * 3600, sub: VAPID_SUJETO }));
  const pub = deB64u_(claves.publica);
  const llave = crypto.createPrivateKey({
    key: { kty: 'EC', crv: 'P-256', x: b64u_(pub.subarray(1, 33)), y: b64u_(pub.subarray(33, 65)), d: claves.privada },
    format: 'jwk',
  });
  const firma = crypto.sign('sha256', Buffer.from(encabezado + '.' + datos), { key: llave, dsaEncoding: 'ieee-p1363' });
  return encabezado + '.' + datos + '.' + b64u_(firma);
}

// ---------- cifrado Web Push (RFC 8291, aes128gcm) ----------
function hmac_(llave, datos) { return crypto.createHmac('sha256', llave).update(datos).digest(); }
function cifrarPush_(contenido, p256dh, auth, opciones) {
  const uaPublica = deB64u_(p256dh);
  const secreto = deB64u_(auth);
  if (uaPublica.length !== 65 || secreto.length < 16) throw new Error('Suscripción de notificaciones inválida.');
  const ecdh = crypto.createECDH('prime256v1');
  if (opciones && opciones.privadaServidor) ecdh.setPrivateKey(opciones.privadaServidor);
  else ecdh.generateKeys();
  const asPublica = ecdh.getPublicKey();
  const compartido = ecdh.computeSecret(uaPublica);
  const prkKey = hmac_(secreto, compartido);
  const ikm = hmac_(prkKey, Buffer.concat([Buffer.from('WebPush: info\0'), uaPublica, asPublica, Buffer.from([1])]));
  const sal = (opciones && opciones.sal) || crypto.randomBytes(16);
  const prk = hmac_(sal, ikm);
  const cek = hmac_(prk, Buffer.concat([Buffer.from('Content-Encoding: aes128gcm\0'), Buffer.from([1])])).subarray(0, 16);
  const nonce = hmac_(prk, Buffer.concat([Buffer.from('Content-Encoding: nonce\0'), Buffer.from([1])])).subarray(0, 12);
  const cifrador = crypto.createCipheriv('aes-128-gcm', cek, nonce);
  const texto = Buffer.concat([Buffer.from(contenido), Buffer.from([2])]);
  const cifrado = Buffer.concat([cifrador.update(texto), cifrador.final(), cifrador.getAuthTag()]);
  const rs = Buffer.alloc(4);
  rs.writeUInt32BE(4096, 0);
  return Buffer.concat([sal, rs, Buffer.from([asPublica.length]), asPublica, cifrado]);
}

async function enviarPush_(sub, datos) {
  const claves = await clavesVapid_();
  const cuerpo = cifrarPush_(JSON.stringify(datos), sub.p256dh, sub.auth);
  const res = await fetch(sub.endpoint, {
    method: 'POST',
    headers: {
      TTL: '86400',
      Urgency: 'high',
      'Content-Encoding': 'aes128gcm',
      'Content-Type': 'application/octet-stream',
      Authorization: 'vapid t=' + firmarVapid_(sub.endpoint, claves) + ', k=' + claves.publica,
    },
    body: cuerpo,
  });
  if (res.status === 404 || res.status === 410) {
    // El navegador ya no tiene esa suscripción (desinstalaron, borraron datos...).
    await pool.query('DELETE FROM push_suscripciones WHERE endpoint = ?', [sub.endpoint]);
    return { ok: false, borrada: true, status: res.status };
  }
  if (!res.ok) return { ok: false, status: res.status };
  await pool.query('UPDATE push_suscripciones SET ultimo_envio = NOW() WHERE endpoint = ?', [sub.endpoint]);
  return { ok: true, status: res.status };
}

// ---------- Telegram ----------
async function telegram_(token, metodo, datos) {
  const res = await fetch(TELEGRAM_API() + '/bot' + token + '/' + metodo, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(datos || {}),
  });
  const json = await res.json().catch(() => null);
  if (!json || json.ok !== true) {
    const e = new Error((json && json.description) || ('Telegram respondió ' + res.status));
    e.status = res.status;
    throw e;
  }
  return json.result;
}
function escHtml_(t) { return String(t === null || t === undefined ? '' : t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

// ---------- texto del aviso ----------
function fechaHora_(fecha) {
  const d = fecha instanceof Date ? fecha : new Date(fecha);
  if (Number.isNaN(d.getTime())) return '';
  const hora = d.toLocaleTimeString('es-MX', { timeZone: ZONA_AVISOS, hour: 'numeric', minute: '2-digit', hour12: true });
  const dia = d.toLocaleDateString('es-MX', { timeZone: ZONA_AVISOS, day: '2-digit', month: '2-digit', year: 'numeric' });
  return { hora, dia };
}
function duracion_(ms) {
  const min = Math.max(0, Math.round(ms / 60000));
  const h = Math.floor(min / 60);
  const m = min % 60;
  return h ? (h + ' h ' + m + ' min') : (m + ' min');
}
// d = { tipo, operador, equipo, huerta, actividad, inicio, fin, km, tarde }
function armarAviso_(d) {
  const ini = fechaHora_(d.inicio);
  const fin = d.fin ? fechaHora_(d.fin) : null;
  const equipo = d.equipo || 'Sin equipo';
  const titulo = d.tipo === 'fin' ? 'Terminó recorrido' : 'Inició recorrido';
  const lineas = [];
  lineas.push(['Operador', d.operador]);
  lineas.push(['Equipo', equipo]);
  lineas.push(['Huerta', d.huerta]);
  if (d.actividad) lineas.push(['Actividad', d.actividad]);
  if (d.tipo === 'fin') {
    lineas.push(['Horario', ini.hora + ' a ' + fin.hora + (ini.dia !== fin.dia ? ' (' + fin.dia + ')' : '')]);
    lineas.push(['Duración', duracion_(new Date(d.fin) - new Date(d.inicio))]);
    if (d.km !== null && d.km !== undefined) lineas.push(['Recorrido', d.km.toFixed(2) + ' km']);
  } else {
    lineas.push(['Hora', ini.hora + ' (' + ini.dia + ')']);
  }
  const nota = d.tarde ? 'Avisado tarde: el celular estaba sin señal.' : '';
  const icono = d.tipo === 'fin' ? '⏹' : '▶️';
  const telegram = icono + ' <b>' + titulo + '</b>\n'
    + lineas.map(([k, v]) => k + ': <b>' + escHtml_(v) + '</b>').join('\n')
    + (nota ? '\n<i>' + escHtml_(nota) + '</i>' : '');
  const push = {
    titulo: icono + ' ' + titulo + ' · ' + (d.operador || ''),
    cuerpo: lineas.filter(([k]) => k !== 'Operador').map(([k, v]) => k + ': ' + v).join('\n') + (nota ? '\n' + nota : ''),
    url: '/panel?pestana=avancehuerta',
    tag: 'recorrido-' + (d.avanceId || '') + '-' + d.tipo,
  };
  return { telegram, push };
}

// Distancia sin los brincos del GPS (ver filtrarSaltosGps_ en handlers.js).
let utilRecorrido_ = null; // { filtrarSaltosGps_, tramosDeRecorrido_, distanciaMetros_ } -- lo pone handlers.js
function configurarUtilRecorrido_(u) { utilRecorrido_ = u; }

async function datosRecorrido_(avanceId) {
  const [rows] = await pool.query(
    `SELECT a.id, a.huerta, a.nombre, a.trabajo, a.codigo_unidad, a.fecha_inicio, a.fecha_fin, m.unidad
       FROM avance_huerta a LEFT JOIN maquinaria m ON m.codigo_unidad = a.codigo_unidad
      WHERE a.id = ? LIMIT 1`,
    [avanceId]
  );
  if (!rows.length) return null;
  const a = rows[0];
  let km = null;
  if (a.fecha_fin && utilRecorrido_) {
    const [pts] = await pool.query('SELECT lat, lng, capturado_en FROM avance_huerta_puntos WHERE avance_id = ? ORDER BY capturado_en, id', [avanceId]);
    const limpios = utilRecorrido_.filtrarSaltosGps_(pts.map((p) => ({ lat: Number(p.lat), lng: Number(p.lng), t: new Date(p.capturado_en).getTime() })));
    let metros = 0;
    for (const [p1, p2] of utilRecorrido_.tramosDeRecorrido_(limpios)) metros += utilRecorrido_.distanciaMetros_(p1, p2);
    km = Math.round(metros / 10) / 100;
  }
  return {
    avanceId: a.id,
    operador: a.nombre,
    equipo: a.unidad || a.codigo_unidad || null,
    huerta: a.huerta,
    actividad: a.trabajo || null,
    inicio: a.fecha_inicio,
    fin: a.fecha_fin,
    km,
  };
}

// ---------- envío ----------
const enCurso_ = new Set();
// Para las pruebas: espera a que terminen los avisos que van en camino.
function esperarAvisos_() { return Promise.all(Array.from(enCurso_)); }

async function enviarATodos_(aviso) {
  const resultado = { telegram: null, push: [] };
  const token = await leerConfig_('telegram_token');
  const chat = await leerConfig_('telegram_chat_id');
  if (token && chat) {
    try {
      await telegram_(token, 'sendMessage', { chat_id: chat, text: aviso.telegram, parse_mode: 'HTML', disable_web_page_preview: true });
      resultado.telegram = 'ok';
    } catch (err) {
      resultado.telegram = 'error';
      console.error('[avisos] Telegram:', err.message);
    }
  }
  const [subs] = await pool.query('SELECT endpoint, p256dh, auth FROM push_suscripciones');
  for (const s of subs) {
    try {
      resultado.push.push(await enviarPush_(s, aviso.push));
    } catch (err) {
      resultado.push.push({ ok: false, error: err.message });
      console.error('[avisos] Notificación:', err.message);
    }
  }
  return resultado;
}

// tipo: 'inicio' | 'fin' | ['inicio', 'fin'] (en ese orden, p.ej. cuando un
// recorrido hecho sin señal llega completo de una vez). No lanza errores y
// no hay que esperarla.
function avisarRecorrido_(tipo, avanceId) {
  const tipos = Array.isArray(tipo) ? tipo : [tipo];
  const p = (async () => {
    const resultados = [];
    for (const t of tipos) {
      try {
        const d = await datosRecorrido_(avanceId);
        if (!d) break;
        const momento = t === 'fin' ? d.fin : d.inicio;
        d.tipo = t;
        d.tarde = momento ? (Date.now() - new Date(momento).getTime() > AVISO_TARDE_MS) : false;
        resultados.push(await enviarATodos_(armarAviso_(d)));
      } catch (err) {
        console.error('[avisos] No se pudo avisar ' + t + ' del recorrido ' + avanceId + ':', err.message);
      }
    }
    return tipos.length === 1 ? (resultados[0] || null) : resultados;
  })();
  enCurso_.add(p);
  p.finally(() => enCurso_.delete(p));
  return p;
}

// ---------- acciones del Panel (los permisos los revisa handlers.js) ----------
async function getConfigAvisos_(nombreUsuario) {
  const claves = await clavesVapid_();
  const token = await leerConfig_('telegram_token');
  const [[cuenta]] = await pool.query('SELECT COUNT(*) AS n FROM push_suscripciones');
  return {
    success: true,
    vapidPublica: claves.publica,
    equiposConAvisos: Number(cuenta.n) || 0,
    telegram: {
      tieneToken: !!token,
      bot: await leerConfig_('telegram_bot'),
      chatId: await leerConfig_('telegram_chat_id'),
      chatNombre: await leerConfig_('telegram_chat_nombre'),
    },
  };
}

function validarSuscripcion_(sub) {
  const s = sub || {};
  const endpoint = (s.endpoint || '').toString();
  const keys = s.keys || {};
  if (!/^https:\/\//.test(endpoint) && !(process.env.AVISOS_PERMITIR_HTTP === '1' && /^http:\/\//.test(endpoint))) return null;
  if (endpoint.length > 1000) return null;
  try {
    if (deB64u_(keys.p256dh).length !== 65 || deB64u_(keys.auth).length < 16) return null;
  } catch (e) { return null; }
  return { endpoint, p256dh: String(keys.p256dh), auth: String(keys.auth) };
}
async function guardarSuscripcionPush_(nombreUsuario, sub, dispositivo) {
  const s = validarSuscripcion_(sub);
  if (!s) return { success: false, error: 'El navegador no entregó una suscripción válida para notificaciones.' };
  await pool.query(
    `INSERT INTO push_suscripciones (usuario, endpoint, p256dh, auth, dispositivo) VALUES (?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE usuario = VALUES(usuario), p256dh = VALUES(p256dh), auth = VALUES(auth), dispositivo = VALUES(dispositivo)`,
    [nombreUsuario, s.endpoint, s.p256dh, s.auth, (dispositivo || '').toString().slice(0, 120) || null]
  );
  return { success: true };
}
async function quitarSuscripcionPush_(endpoint) {
  await pool.query('DELETE FROM push_suscripciones WHERE endpoint = ?', [(endpoint || '').toString()]);
  return { success: true };
}
async function probarAvisoPush_(nombreUsuario, endpoint) {
  const [rows] = await pool.query('SELECT endpoint, p256dh, auth FROM push_suscripciones WHERE endpoint = ?', [(endpoint || '').toString()]);
  if (!rows.length) return { success: false, error: 'Este equipo no tiene los avisos activados.' };
  const r = await enviarPush_(rows[0], {
    titulo: '🔔 Prueba de avisos de recorridos',
    cuerpo: 'Así te va a llegar el aviso cuando un operador inicie o termine un recorrido.',
    url: '/panel?pestana=avancehuerta',
    tag: 'prueba-avisos',
  });
  if (!r.ok) return { success: false, error: r.borrada ? 'El navegador ya no acepta avisos en este equipo; vuelve a activarlos.' : 'El servicio de notificaciones respondió ' + r.status + '.' };
  return { success: true };
}

function limpiarToken_(t) { return (t || '').toString().trim().replace(/^bot/i, ''); }
async function guardarTelegramToken_(token) {
  const t = limpiarToken_(token);
  if (!/^\d{5,}:[A-Za-z0-9_-]{20,}$/.test(t)) return { success: false, error: 'Ese no parece un token de bot de Telegram (se ve como 123456789:AAH...).' };
  let yo;
  try {
    yo = await telegram_(t, 'getMe');
  } catch (err) {
    return { success: false, error: 'Telegram no aceptó ese token: ' + err.message };
  }
  await guardarConfig_('telegram_token', t);
  await guardarConfig_('telegram_bot', yo.username || yo.first_name || '');
  await guardarConfig_('telegram_chat_id', null);
  await guardarConfig_('telegram_chat_nombre', null);
  return { success: true, bot: yo.username || yo.first_name || '' };
}
function nombreChat_(c) {
  if (!c) return '';
  if (c.title) return c.title;
  return [c.first_name, c.last_name].filter(Boolean).join(' ') || (c.username ? '@' + c.username : String(c.id));
}
async function buscarChatsTelegram_() {
  const token = await leerConfig_('telegram_token');
  if (!token) return { success: false, error: 'Primero guarda el token del bot.' };
  let updates;
  try {
    updates = await telegram_(token, 'getUpdates', { limit: 100, allowed_updates: ['message', 'my_chat_member', 'channel_post'] });
  } catch (err) {
    return { success: false, error: 'No se pudo consultar Telegram: ' + err.message };
  }
  const chats = new Map();
  (updates || []).forEach((u) => {
    const c = (u.message && u.message.chat) || (u.my_chat_member && u.my_chat_member.chat) || (u.channel_post && u.channel_post.chat);
    if (c && c.id !== undefined) chats.set(String(c.id), { id: String(c.id), nombre: nombreChat_(c), tipo: c.type === 'private' ? 'persona' : 'grupo' });
  });
  return { success: true, chats: Array.from(chats.values()) };
}
async function guardarTelegramChat_(chatId, nombre) {
  const token = await leerConfig_('telegram_token');
  if (!token) return { success: false, error: 'Primero guarda el token del bot.' };
  const id = (chatId || '').toString().trim();
  if (!/^-?\d{1,20}$/.test(id)) return { success: false, error: 'Chat de Telegram inválido.' };
  try {
    await telegram_(token, 'sendMessage', { chat_id: id, text: '✅ Listo: aquí van a llegar los avisos de cuando un operador inicie o termine un recorrido.' });
  } catch (err) {
    return { success: false, error: 'No se pudo escribir en ese chat: ' + err.message };
  }
  await guardarConfig_('telegram_chat_id', id);
  await guardarConfig_('telegram_chat_nombre', (nombre || '').toString().slice(0, 120) || id);
  return { success: true };
}
async function probarAvisoTelegram_() {
  const token = await leerConfig_('telegram_token');
  const chat = await leerConfig_('telegram_chat_id');
  if (!token || !chat) return { success: false, error: 'Telegram todavía no está configurado.' };
  try {
    await telegram_(token, 'sendMessage', { chat_id: chat, text: '🔔 Prueba: así te va a llegar el aviso cuando un operador inicie o termine un recorrido.' });
  } catch (err) {
    return { success: false, error: 'Telegram respondió: ' + err.message };
  }
  return { success: true };
}
async function quitarTelegram_() {
  for (const k of ['telegram_token', 'telegram_bot', 'telegram_chat_id', 'telegram_chat_nombre']) await guardarConfig_(k, null);
  return { success: true };
}

module.exports = {
  avisarRecorrido_,
  esperarAvisos_,
  configurarUtilRecorrido_,
  armarAviso_,
  cifrarPush_,
  firmarVapid_,
  generarVapid_,
  getConfigAvisos_,
  guardarSuscripcionPush_,
  quitarSuscripcionPush_,
  probarAvisoPush_,
  guardarTelegramToken_,
  buscarChatsTelegram_,
  guardarTelegramChat_,
  probarAvisoTelegram_,
  quitarTelegram_,
  _reiniciarCache: () => { vapidCache_ = null; },
};
