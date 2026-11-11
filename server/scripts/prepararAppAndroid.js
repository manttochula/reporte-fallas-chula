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

if (require.main === module) {
  const app = prepararApp(process.env.APP_SERVIDOR);
  fs.mkdirSync(path.dirname(RUTA_SALIDA), { recursive: true });
  fs.writeFileSync(RUTA_SALIDA, app.index);
  fs.writeFileSync(RUTA_SALIDA_TALLER, app.taller);
  fs.writeFileSync(RUTA_SALIDA_CATALOGO, app.catalogo);
  console.log('www/index.html, www/taller.html y www/catalogoPartes.js listos (versión ' + app.version + ', ' + Math.round((app.index.length + app.taller.length) / 1024) + ' KB).');
}

module.exports = { prepararHtml, prepararApp, SERVIDOR_POR_DEFECTO };
