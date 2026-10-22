// Service Worker para la pantalla "Reportar" (Index.html, ruta "/") — deja
// que esta pantalla cargue aunque no haya señal en absoluto al abrirla,
// guardando una copia de la página (y de lo necesario para "instalarla"
// como ícono en la pantalla de inicio) la primera vez que se abre con señal.
// A propósito NO cachea nada más (ni /panel, ni /api/*, ni /uploads/*,
// ni fuentes externas): cualquier otra ruta pasa de largo tal cual, para
// no afectar el resto del sistema (Panel, Taller, Movimientos, etc.).
//
// La cola de reportes capturados sin señal (IndexedDB) vive del lado de
// Index.html (ver offlineEncolarReporte_/offlineIntentarEnviarPendientes_
// ahí mismo), no aquí — este archivo solo resuelve que la PÁGINA (y el
// manifiesto/ícono con que se instala) carguen sin señal; una vez cargada,
// el resto (encolar y reintentar el envío) lo hace el propio Index.html
// con IndexedDB + fetch normal.
const CACHE_NOMBRE = 'reportar-shell-v4';
// Librerías y tipografías de otros sitios que usa el Panel (no cambian:
// llevan la versión en la dirección). Se guardan la primera vez y después
// se usan de la copia, para que el Panel se vea igual sin internet.
const CACHE_EXTERNOS = 'externos-v1';
const EXTERNOS_PERMITIDOS = [
  'https://cdn.jsdelivr.net/npm/xlsx@',
  'https://fonts.googleapis.com/',
  'https://fonts.gstatic.com/',
];

// Con señal muy débil (p.ej. 339 B/s) el servidor NO falla: la descarga se
// queda colgada, y antes el celular esperaba hasta que Android mostraba
// "Página web no disponible -- net::ERR_TIMED_OUT" (oct-2026), aunque ya
// hubiera una copia guardada. Ahora, si en ESPERA_RED_MS no llegó la
// página y hay copia guardada, se abre la copia; la descarga sigue en
// segundo plano y actualiza la copia para la próxima vez.
const ESPERA_RED_MS = 5000;

// La página en sí, más el manifiesto y los íconos que usa el celular para
// "instalarla" en la pantalla de inicio — para que abrir ese ícono
// funcione aunque no haya señal, no solo la página desde el navegador.
// Panel (oct-2026): también se guarda para abrirlo sin internet en la
// computadora (ver la capa "Panel SIN INTERNET" en Panel.html).
const RUTAS_SHELL = ['/', '/icons/reportar.webmanifest', '/icons/reportar-icon-192.png', '/icons/reportar-icon-512.png',
  '/panel', '/icons/panel.webmanifest', '/icons/icon-192.png', '/icons/icon-512.png'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NOMBRE).then((cache) =>
      Promise.all(RUTAS_SHELL.map((ruta) => cache.add(ruta).catch(() => {})))
    )
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((nombres) =>
      Promise.all(
        nombres
          .filter((nombre) => nombre !== CACHE_NOMBRE && nombre !== CACHE_EXTERNOS)
          .map((nombre) => caches.delete(nombre))
      )
    )
  );
  self.clients.claim();
});

// La página pide "asegúrate de tener la copia" (Panel/Index al cargar). Si
// al instalarse el Service Worker el servidor estaba despertando (Render
// gratis) o lento, la copia no se guardó y sin internet no abría nada
// (oct-2026: "quité el internet, cerré y volví a abrir" -> ERR_NAME_NOT_RESOLVED).
// Contesta si ya está guardada, para mostrar "Disponible sin internet".
self.addEventListener('message', (event) => {
  const datos = event.data || {};
  if (datos.tipo !== 'asegurar-copia') return;
  const ruta = RUTAS_SHELL.includes(datos.ruta) ? datos.ruta : null;
  const puerto = event.ports && event.ports[0];
  event.waitUntil(completarCopia_(ruta).then((lista) => { if (puerto) puerto.postMessage({ lista }); }));
});

async function completarCopia_(rutaPrincipal) {
  const cache = await caches.open(CACHE_NOMBRE);
  await Promise.all(RUTAS_SHELL.map(async (ruta) => {
    if (await cache.match(ruta)) return;
    try {
      const r = await fetch(ruta, { cache: 'no-store' });
      if (r && r.ok) await cache.put(ruta, r);
    } catch (e) { /* sin internet: se intenta la próxima vez */ }
  }));
  return rutaPrincipal ? !!(await cache.match(rutaPrincipal)) : true;
}

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Solo nos metemos con la página "/" y lo que necesita para instalarse
  // (manifiesto e íconos). Todo lo demás (Panel, API, uploads, fuentes,
  // etc.) sigue su camino normal, sin pasar por este Service Worker — así
  // nunca interfiere con el resto del sistema.
  if (event.request.method === 'GET' && EXTERNOS_PERMITIDOS.some((p) => event.request.url.startsWith(p))) {
    event.respondWith(responderExterno_(event.request));
    return;
  }
  if (event.request.method !== 'GET' || url.origin !== self.location.origin || !RUTAS_SHELL.includes(url.pathname)) {
    return;
  }

  event.respondWith(responderPagina_(event, url));
});

async function responderPagina_(event, url) {
  const guardada = await caches.match(url.pathname);
  const deRed = fetch(event.request).then((respuesta) => {
    // Solo se guarda una respuesta BUENA: antes, si Render contestaba un
    // error (502 mientras reinicia), esa página de error reemplazaba la
    // copia buena y luego sin señal se abría el error.
    if (respuesta && respuesta.ok) {
      const copia = respuesta.clone();
      caches.open(CACHE_NOMBRE).then((cache) => cache.put(url.pathname, copia));
      return respuesta;
    }
    return guardada || respuesta;
  });
  if (!guardada) return deRed; // primera vez: no hay de otra más que esperar a la red
  event.waitUntil(deRed.catch(() => {})); // que la copia se actualice aunque ya se haya mostrado la guardada
  return Promise.race([
    deRed.catch(() => guardada),
    new Promise((resolver) => setTimeout(() => resolver(guardada), ESPERA_RED_MS)),
  ]);
}

// Externos: primero la copia guardada; si no hay, se descarga y se guarda.
async function responderExterno_(request) {
  const cache = await caches.open(CACHE_EXTERNOS);
  const guardada = await cache.match(request);
  if (guardada) return guardada;
  const respuesta = await fetch(request);
  if (respuesta && (respuesta.ok || respuesta.type === 'opaque')) cache.put(request, respuesta.clone());
  return respuesta;
}

// ---------------------------------------------------------------
// Avisos de recorridos (oct-2026): el servidor manda un aviso cuando un
// operador inicia o termina un recorrido (ver server/avisos.js). Llega
// aquí aunque el Panel esté cerrado y se muestra como notificación; al
// tocarla se abre (o se enfoca) el Panel en Avance Huerta.
self.addEventListener('push', (event) => {
  let datos = {};
  try { datos = event.data ? event.data.json() : {}; } catch (e) { datos = { cuerpo: event.data ? event.data.text() : '' }; }
  const titulo = datos.titulo || 'Aviso de recorrido';
  event.waitUntil(self.registration.showNotification(titulo, {
    body: datos.cuerpo || '',
    tag: datos.tag || undefined,
    icon: '/icons/icon-192.png',
    badge: '/icons/icon-192.png',
    data: { url: datos.url || '/panel' },
  }));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const destino = new URL((event.notification.data && event.notification.data.url) || '/panel', self.location.origin).href;
  event.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((ventanas) => {
    const panel = ventanas.find((v) => new URL(v.url).pathname === '/panel');
    if (panel) {
      panel.postMessage({ tipo: 'abrir-pestana', pestana: 'avancehuerta' });
      return panel.focus();
    }
    return self.clients.openWindow(destino);
  }));
});
