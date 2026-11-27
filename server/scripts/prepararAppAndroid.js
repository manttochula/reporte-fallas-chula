// Empaqueta la pantalla del celular (public/Index.html) DENTRO de la app de
// Android, en www/index.html -- petición de Carlos (oct-2026): con señal
// débil, la app (que antes abría el sitio en vivo desde Render) mostraba
// "Página web no disponible -- net::ERR_TIMED_OUT" al abrirla, incluso la
// primera vez recién instalada. Así la pantalla abre al instante sin
// señal; solo los datos (y guardar) van al servidor.
//
// Lo corre solo GitHub Actions antes de compilar el APK
// (.github/workflows/build-apk.yml). También se puede correr a mano:
//   node server/scripts/prepararAppAndroid.js
// Opcional: APP_SERVIDOR=https://otro-sitio.onrender.com para otro servidor.
const fs = require('fs');
const path = require('path');
const { versionDeContenido, contenidoApp, RUTA_INDEX, RUTA_TALLER, RUTA_CATALOGO_PARTES } = require('../versionApp');

const SERVIDOR_POR_DEFECTO = 'https://reporte-fallas-chula.onrender.com';
const RUTA_SALIDA = path.join(__dirname, '..', '..', 'www', 'index.html');
// Nov-2026 (Carlos: "la aplicación de taller volverla una app offline, tipo
// como la de los operadores"): Taller también va dentro del APK, como
// www/taller.html (con su catálogo de partes), y se abre desde la app.
const RUTA_SALIDA_TALLER = path.join(__dirname, '..', '..', 'www', 'taller.html');
const RUTA_SALIDA_CATALOGO = path.join(__dirname, '..', '..', 'www', 'catalogoPartes.js');

// contenidoIndex: la página a empaquetar (Index.html o Taller.html).
// version (opcional): la de toda la app; si no se da, la de esta página sola.
function prepararHtml(contenidoIndex, servidor, version) {
  const html = contenidoIndex.toString('utf8');
  version = version || versionDeContenido(contenidoIndex);
  const srv = (servidor || SERVIDOR_POR_DEFECTO).replace(/\/+$/, '');
  // https siempre; http solo para pruebas en la misma computadora.
  const valido = /^https:\/\/[^\s'"<>\\]+$/.test(srv) || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(srv);
  if (!valido) throw new Error('APP_SERVIDOR inválido: ' + srv);
  const marcaHead = /<head>/i;
  if (!marcaHead.test(html)) throw new Error('No se encontró <head> en Index.html');
  const config = '<head>\n<script>window.APP_SERVIDOR = ' + JSON.stringify(srv) + '; window.APP_VERSION = ' + JSON.stringify(version) + ';</script>';
  return {
    version,
    html: html
      .replace(marcaHead, config)
      // El manifiesto es para "instalar" el sitio web; dentro del APK no aplica (y daría 404).
      .replace(/<link rel="manifest"[^>]*>\s*/i, ''),
  };
}

// ---- Actualización de la pantalla SIN APK (nov-2026, Carlos) ----
// www/index.html y www/taller.html ya no son la pantalla: son un "arranque"
// chiquito que, si la app ya bajó de Render una versión más nueva de la
// pantalla (guardada en el celular, Cache Storage 'app-paquete'), abre esa;
// si no, la que trae el APK (www/app-index.html / www/app-taller.html). Se
// escribe con document.write en la MISMA ventana, así el puente nativo de
// Capacitor (GPS en segundo plano) sigue ahí. Si la versión bajada falla al
// abrir 3 veces seguidas, o no encuentra el puente nativo, se borra y se usa
// la del APK.
function arranque(pagina, servidor, version, build) {
  const srv = (servidor || SERVIDOR_POR_DEFECTO).replace(/\/+$/, '');
  return `<!DOCTYPE html>
<html lang="es"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Reporte de Fallas</title>
<style>body{margin:0;background:#141414;color:#EDECE7;font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;}</style>
</head><body><div id="arranque">Abriendo...</div>
<script>
window.APP_SERVIDOR = ${JSON.stringify(srv)};
window.APP_VERSION_BASE = ${JSON.stringify(version)};
window.APP_BUILD = ${JSON.stringify(build)};
window.APP_PAGINA = ${JSON.stringify(pagina)};
(function(){
  var CACHE = 'app-paquete', PAG = window.APP_PAGINA;
  var LOCAL = PAG === 'taller' ? 'app-taller.html' : 'app-index.html';
  function abrir(html, dePaquete){
    window.__appPaqueteActivo = !!dePaquete;
    document.open(); document.write(html); document.close();
  }
  function leerMeta(c){ return c.match('/__paquete/meta').then(function(r){ return r ? r.json() : null; }).catch(function(){ return null; }); }
  function guardarMeta(c, m){ return c.put('/__paquete/meta', new Response(JSON.stringify(m), { headers: { 'Content-Type': 'application/json' } })); }
  // La pantalla llama esto cuando ya cargó bien (reinicia el contador de fallas).
  window.__appPaqueteOk = function(){
    if(!window.__appPaqueteActivo || !window.caches) return;
    caches.open(CACHE).then(function(c){ return leerMeta(c).then(function(m){ if(m && m.intentos){ m.intentos = 0; return guardarMeta(c, m); } }); }).catch(function(){});
  };
  // La pantalla bajada no sirve aquí: se borra y se vuelve a la del APK.
  window.__appPaqueteMalo = function(){
    if(!window.caches) return Promise.resolve();
    return caches.delete(CACHE).catch(function(){});
  };
  function local(){ return fetch(LOCAL).then(function(r){ return r.text(); }).then(function(h){ abrir(h, false); }); }
  if(!window.caches){ local(); return; }
  caches.open(CACHE).then(function(c){
    return leerMeta(c).then(function(m){
      if(!m || m.base !== window.APP_VERSION_BASE || m.version === window.APP_VERSION_BASE || (m.intentos || 0) >= 3) {
        if(m && (m.base !== window.APP_VERSION_BASE || (m.intentos || 0) >= 3)) caches.delete(CACHE);
        return local();
      }
      return c.match('/__paquete/' + PAG).then(function(r){
        if(!r) return local();
        m.intentos = (m.intentos || 0) + 1;
        return guardarMeta(c, m).then(function(){ return r.text(); }).then(function(h){ abrir(h, true); });
      });
    });
  }).catch(function(){ local(); });
})();
</script></body></html>`;
}

// Lo que la app baja de Render para actualizarse sin APK: las dos pantallas
// ya preparadas (Taller con su catálogo de partes adentro, porque el
// catalogoPartes.js del APK puede ser más viejo).
function paqueteApp(servidor) {
  const app = prepararApp(servidor);
  const catalogo = app.catalogo.toString('utf8');
  if (/<\/script/i.test(catalogo)) throw new Error('catalogoPartes.js no se puede poner dentro del HTML');
  const taller = app.taller.replace(/<script src="\/?catalogoPartes\.js"><\/script>/, function () { return '<script>\n' + catalogo + '\n</script>'; });
  if (taller === app.taller) throw new Error('No encontré <script src="/catalogoPartes.js"> en Taller.html');
  return { version: app.version, index: app.index, taller };
}

// Arma los 3 archivos de www/ con la misma versión (la de toda la app).
function prepararApp(servidor) {
  const version = versionDeContenido(contenidoApp());
  return {
    version,
    index: prepararHtml(fs.readFileSync(RUTA_INDEX), servidor, version).html,
    taller: prepararHtml(fs.readFileSync(RUTA_TALLER), servidor, version).html,
    catalogo: fs.readFileSync(RUTA_CATALOGO_PARTES),
  };
}

// Escribe www/: las pantallas del APK (app-index.html, app-taller.html), su
// catálogo y los arranques (index.html, taller.html).
function escribirWww(dir, servidor, build) {
  const app = prepararApp(servidor);
  build = build || new Date().toISOString();
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'app-index.html'), app.index);
  fs.writeFileSync(path.join(dir, 'app-taller.html'), app.taller);
  fs.writeFileSync(path.join(dir, 'catalogoPartes.js'), app.catalogo);
  fs.writeFileSync(path.join(dir, 'index.html'), arranque('index', servidor, app.version, build));
  fs.writeFileSync(path.join(dir, 'taller.html'), arranque('taller', servidor, app.version, build));
  return app;
}

if (require.main === module) {
  const app = escribirWww(path.dirname(RUTA_SALIDA), process.env.APP_SERVIDOR);
  console.log('www/ lista: arranques index.html/taller.html + app-index.html, app-taller.html y catalogoPartes.js (versión ' + app.version + ', ' + Math.round((app.index.length + app.taller.length) / 1024) + ' KB).');
}

module.exports = { prepararHtml, prepararApp, paqueteApp, arranque, escribirWww, SERVIDOR_POR_DEFECTO };
