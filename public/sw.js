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
