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
const CACHE_NOMBRE = 'reportar-shell-v3';

// La página en sí, más el manifiesto y los íconos que usa el celular para
// "instalarla" en la pantalla de inicio — para que abrir ese ícono
// funcione aunque no haya señal, no solo la página desde el navegador.
const RUTAS_SHELL = ['/', '/icons/reportar.webmanifest', '/icons/reportar-icon-192.png', '/icons/reportar-icon-512.png'];

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
          .filter((nombre) => nombre !== CACHE_NOMBRE)
          .map((nombre) => caches.delete(nombre))
      )
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Solo nos metemos con la página "/" y lo que necesita para instalarse
  // (manifiesto e íconos). Todo lo demás (Panel, API, uploads, fuentes,
  // etc.) sigue su camino normal, sin pasar por este Service Worker — así
  // nunca interfiere con el resto del sistema.
  if (event.request.method !== 'GET' || url.origin !== self.location.origin || !RUTAS_SHELL.includes(url.pathname)) {
    return;
  }

  event.respondWith(
    fetch(event.request)
      .then((respuesta) => {
        // Con señal: siempre se usa la versión que manda el servidor (para
        // no quedarse pegado en una versión vieja de la app), y de paso se
        // refresca la copia guardada para la próxima vez que no haya señal.
        const copia = respuesta.clone();
        caches.open(CACHE_NOMBRE).then((cache) => cache.put(url.pathname, copia));
        return respuesta;
      })
      .catch(() => caches.match(url.pathname))
  );
});
