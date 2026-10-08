// Funciones de apoyo: equivalentes a getNextOrderNumber_(), getNextDieselFolio_()
// y tieneAccesoModulo_() del Codigo.gs original.
// (El guardado de fotos/videos — antes aquí como guardarArchivoLocal_ — ahora
// vive en ./storage.js, que sabe guardar tanto en disco local como en la
// nube según esté configurado; ver ese archivo para el detalle.)
require('dotenv').config();

/**
 * Consecutivo atómico usando la tabla `contadores`, equivalente al uso de
 * PropertiesService (lastOrderNum / lastDieselNum) del Codigo.gs original.
 */
async function siguienteFolio_(pool, contador, prefijo, padLength) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    await conn.query('INSERT INTO contadores (nombre, ultimo) VALUES (?, 0) ON DUPLICATE KEY UPDATE nombre = nombre', [contador]);
    const [rows] = await conn.query('SELECT ultimo FROM contadores WHERE nombre = ? FOR UPDATE', [contador]);
    const siguiente = (rows[0] ? rows[0].ultimo : 0) + 1;
    await conn.query('UPDATE contadores SET ultimo = ? WHERE nombre = ?', [siguiente, contador]);
    await conn.commit();
    return prefijo + '-' + String(siguiente).padStart(padLength, '0');
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

/**
 * Regresa true si la cadena de módulos guardada (ej. "Reportar,Taller")
 * incluye el módulo pedido. Idéntico a tieneAccesoModulo_() del Codigo.gs.
 */
function tieneAccesoModulo_(modulosStr, modulo) {
  const mod = (modulo || '').toString().trim().toLowerCase();
  const raw = (modulosStr || '').toString().trim();
  if (!mod) return false;
  if (!raw) return mod === 'reportar';
  const lista = raw
    .split(',')
    .map((m) => m.trim().toLowerCase())
    .filter(Boolean);
  return lista.indexOf(mod) !== -1;
}

function requiereClave_(codeRecibido, codeEsperado) {
  if (codeRecibido !== codeEsperado) {
    throw new Error('Clave de acceso incorrecta.');
  }
}

// Niveles de permiso por pestaña del Panel, de menor a mayor. "capturar"
// incluye todo lo que da "visualizar" (además de poder capturar/editar/
// eliminar), por eso se comparan como números.
const NIVELES_PANEL_ = { visualizar: 1, capturar: 2 };

/**
 * Regresa true si el usuario (según su columna `panel_permisos`, un JSON
 * tipo {"ordenes":"capturar",...} guardado en `usuarios`) tiene al menos
 * el nivel pedido en alguna de las pestañas dadas. `pestanas` puede ser
 * un solo nombre de pestaña o una lista (usar lista cuando una acción del
 * Panel es alcanzable desde más de una pestaña, p.ej. Maquinaria y
 * Catálogo comparten los mismos datos/acciones).
 */
function tienePermisoPanel_(panelPermisosStr, pestanas, nivelRequerido) {
  if (!panelPermisosStr) return false;
  let permisos;
  try {
    permisos = JSON.parse(panelPermisosStr);
  } catch (err) {
    return false;
  }
  const lista = Array.isArray(pestanas) ? pestanas : [pestanas];
  const nivelMin = NIVELES_PANEL_[nivelRequerido];
  if (!nivelMin) return false;
  return lista.some((p) => NIVELES_PANEL_[permisos[p]] >= nivelMin);
}

module.exports = {
  siguienteFolio_,
  tieneAccesoModulo_,
  requiereClave_,
  tienePermisoPanel_,
};
