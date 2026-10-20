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
const { versionDeContenido, RUTA_INDEX } = require('../versionApp');

const SERVIDOR_POR_DEFECTO = 'https://reporte-fallas-chula.onrender.com';
const RUTA_SALIDA = path.join(__dirname, '..', '..', 'www', 'index.html');

function prepararHtml(contenidoIndex, servidor) {
  const html = contenidoIndex.toString('utf8');
  const version = versionDeContenido(contenidoIndex);
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

if (require.main === module) {
  const contenido = fs.readFileSync(RUTA_INDEX);
  const { html, version } = prepararHtml(contenido, process.env.APP_SERVIDOR);
  fs.mkdirSync(path.dirname(RUTA_SALIDA), { recursive: true });
  fs.writeFileSync(RUTA_SALIDA, html);
  console.log('www/index.html listo (versión ' + version + ', ' + Math.round(html.length / 1024) + ' KB).');
}

module.exports = { prepararHtml, SERVIDOR_POR_DEFECTO };
