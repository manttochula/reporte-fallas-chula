// Versión de la pantalla del celular -- la usan:
//  - server/scripts/prepararAppAndroid.js, al empaquetarla en el APK
//    (queda como window.APP_VERSION);
//  - getVersionApp() en handlers.js, para que la app empaquetada sepa si
//    el sitio ya tiene una versión más nueva y avise al operador.
// Es el SHA-1 (12 caracteres) de lo que va dentro del APK: Index.html y,
// desde nov-2026, también Taller.html y catalogoPartes.js (la app trae
// Taller adentro). Cambia con cualquier cambio en cualquiera de ellos.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const RUTA_INDEX = path.join(__dirname, '..', 'public', 'Index.html');
const RUTA_TALLER = path.join(__dirname, '..', 'public', 'Taller.html');
const RUTA_CATALOGO_PARTES = path.join(__dirname, '..', 'public', 'catalogoPartes.js');
const RUTAS_APP = [RUTA_INDEX, RUTA_TALLER, RUTA_CATALOGO_PARTES];

// contenido: un Buffer/texto, o un arreglo de ellos (en el orden de RUTAS_APP).
function versionDeContenido(contenido) {
  const h = crypto.createHash('sha1');
  (Array.isArray(contenido) ? contenido : [contenido]).forEach((c) => h.update(c));
  return h.digest('hex').slice(0, 12);
}

function contenidoApp() {
  return RUTAS_APP.map((r) => fs.readFileSync(r));
}

let versionCache = null;
function versionActual() {
  if (versionCache === null) versionCache = versionDeContenido(contenidoApp());
  return versionCache;
}

module.exports = { versionDeContenido, versionActual, contenidoApp, RUTA_INDEX, RUTA_TALLER, RUTA_CATALOGO_PARTES, RUTAS_APP };
