// Versión de la pantalla del celular (public/Index.html) -- la usan:
//  - server/scripts/prepararAppAndroid.js, al empaquetarla en el APK
//    (queda como window.APP_VERSION);
//  - getVersionApp() en handlers.js, para que la app empaquetada sepa si
//    el sitio ya tiene una versión más nueva y avise al operador.
// Es el SHA-1 del archivo (12 caracteres): cambia con cualquier cambio.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const RUTA_INDEX = path.join(__dirname, '..', 'public', 'Index.html');

function versionDeContenido(contenido) {
  return crypto.createHash('sha1').update(contenido).digest('hex').slice(0, 12);
}

let versionCache = null;
function versionActual() {
  if (versionCache === null) versionCache = versionDeContenido(fs.readFileSync(RUTA_INDEX));
  return versionCache;
}

module.exports = { versionDeContenido, versionActual, RUTA_INDEX };
