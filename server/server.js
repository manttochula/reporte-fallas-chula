// Servidor local: sustituye a Apps Script (doGet/doPost + google.script.run).
// Sirve el frontend estático (carpeta /public) y expone un endpoint genérico
// POST /api/:fn que despacha hacia server/handlers.js — el mismo patrón de
// "llamar una función por nombre con una lista de argumentos" que usaba
// google.script.run, para que el frontend casi no tuviera que cambiar.
require('dotenv').config();
const path = require('path');
const express = require('express');
const handlers = require('./handlers');
const { UPLOADS_DIR, NUBE_ARCHIVOS_ACTIVA, S3_PUBLIC_BASE_URL } = require('./storage');
const { construirLibroExcel } = require('./excelExport');
const { construirPdfOrdenes, construirPdfReporteSimple } = require('./pdfExport');
const { construirPdfIndicadores, construirExcelIndicadores } = require('./indicadoresExport');

const app = express();
const PORT = process.env.PORT || 3000;
// Misma clave del Panel que ya usa requierePermisoPanel_ en handlers.js
// (TALLER_ACCESS_CODE) — se repite aquí porque handlers.js no la exporta,
// para no tener que exponer una constante interna solo para este uso.
const TALLER_ACCESS_CODE = process.env.TALLER_ACCESS_CODE || 'Operacion';

// Las fotos van como base64 dentro del JSON (igual que en el sistema
// original), así que el body puede pesar varios MB.
app.use(express.json({ limit: '25mb' }));

// App de Android con la pantalla empaquetada (ver
// server/scripts/prepararAppAndroid.js): la página corre en
// https://localhost dentro del celular y llama a este servidor desde
// otro origen, así que:
//  - se le da permiso (CORS) SOLO a esos orígenes de la app;
//  - se acepta el cuerpo como text/plain (así el WebView no hace la
//    pregunta previa OPTIONS: una sola ida y vuelta con señal débil).
const ORIGENES_APP = new Set(['https://localhost', 'http://localhost', 'capacitor://localhost']);
app.use('/api', (req, res, next) => {
  const origen = req.headers.origin;
  if (origen && ORIGENES_APP.has(origen)) {
    res.set('Access-Control-Allow-Origin', origen);
    res.set('Vary', 'Origin');
    res.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.set('Access-Control-Allow-Headers', 'Content-Type');
    res.set('Access-Control-Max-Age', '86400');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
  }
  next();
});
app.use('/api', express.text({ type: 'text/plain', limit: '25mb' }));

// Fotos/videos: en tu computadora se sirven directo desde la carpeta
// /uploads (igual que siempre); si el sistema está configurado para
// guardarlas en la nube (ver server/storage.js), en vez de eso se
// redirige a la dirección pública del archivo ahí.
if (NUBE_ARCHIVOS_ACTIVA) {
  app.get('/uploads/:filename', (req, res) => {
    res.redirect(302, S3_PUBLIC_BASE_URL + '/' + encodeURIComponent(req.params.filename));
  });
} else {
  app.use('/uploads', express.static(UPLOADS_DIR));
}

// Los 4 módulos (Index/Historial/Taller/Panel.html) y sus assets.
app.use(express.static(path.join(__dirname, '..', 'public')));

// Alias amigables, equivalentes a las rutas ?vista=... del doGet original.
app.get('/', (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'Index.html')));
app.get('/historial', (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'Historial.html')));
app.get('/taller', (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'Taller.html')));
app.get('/panel', (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'Panel.html')));
app.get('/movimientos', (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'Movimientos.html')));
// Página pública (sin clave de acceso) para que un proveedor responda una
// solicitud de cotización, vía /cotizar?token=... (ver server/handlers.js:
// getSolicitudCotizacionPublica / responderCotizacion).
app.get('/cotizar', (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'Cotizacion.html')));

// --- Despachador genérico de "RPC" -----------------------------------
// El frontend llama, por ejemplo: google.script.run.withSuccessHandler(cb)
// .submitReporte(record) — el shim de compatibilidad (ver public/*.html)
// traduce eso a: POST /api/submitReporte  { "args": [record] }
app.post('/api/:fn', async (req, res) => {
  // Las funciones que terminan en "_" son helpers internos (convención de
  // este proyecto, ver server/handlers.js) — nunca se exponen por HTTP,
  // aunque estén en module.exports para que otro módulo del servidor
  // (p.ej. el job automático de preventivos) pueda llamarlas directamente.
  if (req.params.fn.endsWith('_')) {
    return res.status(404).json({ error: 'Función no encontrada: ' + req.params.fn });
  }
  const fn = handlers[req.params.fn];
  if (typeof fn !== 'function') {
    return res.status(404).json({ error: 'Función no encontrada: ' + req.params.fn });
  }
  let cuerpo = req.body;
  if (typeof cuerpo === 'string') { // viene de la app empaquetada como text/plain
    try { cuerpo = JSON.parse(cuerpo); } catch (e) { return res.status(400).json({ error: 'Cuerpo inválido.' }); }
  }
  const args = Array.isArray(cuerpo && cuerpo.args) ? cuerpo.args : [];
  try {
    const resultado = await fn(...args);
    res.json(resultado === undefined ? null : resultado);
  } catch (err) {
    // Equivalente a cuando una función de Codigo.gs hacía "throw new Error(...)":
    // en Apps Script eso dispara withFailureHandler; aquí, una respuesta no-2xx
    // hace que el shim del frontend llame al mismo failure handler.
    res.status(400).json({ error: err.message || String(err) });
  }
});

// --- Exportar a Excel (.xlsx) con formato ------------------------------
// A diferencia de /api/:fn (que siempre regresa JSON), esta ruta regresa
// directamente el archivo .xlsx binario, así que va aparte. El Panel ya
// arma del lado del cliente exactamente los mismos datos filtrados que
// antes exportaba a CSV (ver Panel.html, cada botón "*-export" y
// descargarComoExcel_) — aquí solo se les da formato (colores, encabezados,
// totales en negritas) y se regresan como archivo — ver
// server/excelExport.js. Solo pide la misma clave compartida del Panel
// (no un permiso por pestaña) porque no vuelve a consultar la base de
// datos: nada más da formato a datos que el cliente ya tenía permiso de
// ver cuando los pidió originalmente.
app.post('/export/excel', async (req, res) => {
  try {
    const { code, titulo, subtitulo, secciones } = req.body || {};
    if (code !== TALLER_ACCESS_CODE) {
      return res.status(401).json({ error: 'Clave de acceso incorrecta.' });
    }
    if (!Array.isArray(secciones) || secciones.length === 0) {
      return res.status(400).json({ error: 'No hay datos para exportar.' });
    }
    const buffer = await construirLibroExcel({ titulo, subtitulo, secciones });
    const nombreArchivo = (titulo || 'reporte')
      .toString()
      .normalize('NFD').replace(/[̀-ͯ]/g, '') // sin acentos, para que el nombre de archivo sea simple
      .replace(/[^a-zA-Z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .toLowerCase()
      .slice(0, 80) || 'reporte';
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="' + nombreArchivo + '.xlsx"');
    res.send(Buffer.from(buffer));
  } catch (err) {
    console.error('[export/excel] Falló la generación del Excel:', err);
    res.status(400).json({ error: err.message || String(err) });
  }
});

// --- Reporte de órdenes en PDF -----------------------------------------
// Mismo criterio que /export/excel (arriba): el Panel ya arma del lado del
// cliente las órdenes filtradas y, por cada una, sus piezas ya confirmadas
// (getRefaccionesNecesarias); aquí solo se les da formato de reporte y se
// incrusta la foto del reportante, leyéndola directo de /uploads (ver
// server/pdfExport.js) — no vuelve a consultar la base de datos.
app.post('/export/pdf', async (req, res) => {
  try {
    const { code, titulo, subtitulo, ordenes, etiquetaUbicacion } = req.body || {};
    if (code !== TALLER_ACCESS_CODE) {
      return res.status(401).json({ error: 'Clave de acceso incorrecta.' });
    }
    if (!Array.isArray(ordenes) || ordenes.length === 0) {
      return res.status(400).json({ error: 'No hay órdenes para exportar.' });
    }
    const buffer = await construirPdfOrdenes({ titulo, subtitulo, ordenes, etiquetaUbicacion });
    const nombreArchivo = (titulo || 'reporte')
      .toString()
      .normalize('NFD').replace(/[̀-ͯ]/g, '')
      .replace(/[^a-zA-Z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .toLowerCase()
      .slice(0, 80) || 'reporte';
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'attachment; filename="' + nombreArchivo + '.pdf"');
    res.send(buffer);
  } catch (err) {
    console.error('[export/pdf] Falló la generación del PDF:', err);
    res.status(400).json({ error: err.message || String(err) });
  }
});

// --- Reporte "simple" en PDF, agrupado por secciones ---------------------
// Mismo criterio que /export/pdf (arriba) y /export/excel: el Panel ya armó
// del lado del cliente las secciones (por ejemplo, una por huerta, con las
// órdenes "En proceso" de cada una) — aquí solo se les da formato de tabla
// compacta y se regresan como PDF. Pensado para reportes que se mandan a un
// grupo (ver construirPdfReporteSimple en server/pdfExport.js), a
// diferencia de /export/pdf que es el reporte detallado de órdenes (con
// foto y piezas).
app.post('/export/pdf-simple', async (req, res) => {
  try {
    const { code, titulo, subtitulo, secciones } = req.body || {};
    if (code !== TALLER_ACCESS_CODE) {
      return res.status(401).json({ error: 'Clave de acceso incorrecta.' });
    }
    if (!Array.isArray(secciones) || secciones.length === 0) {
      return res.status(400).json({ error: 'No hay datos para exportar.' });
    }
    const buffer = await construirPdfReporteSimple({ titulo, subtitulo, secciones });
    const nombreArchivo = (titulo || 'reporte')
      .toString()
      .normalize('NFD').replace(/[̀-ͯ]/g, '')
      .replace(/[^a-zA-Z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .toLowerCase()
      .slice(0, 80) || 'reporte';
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'attachment; filename="' + nombreArchivo + '.pdf"');
    res.send(buffer);
  } catch (err) {
    console.error('[export/pdf-simple] Falló la generación del PDF:', err);
    res.status(400).json({ error: err.message || String(err) });
  }
});

// Indicadores (Panel → Indicadores → Exportar PDF / Excel): mismo diseño
// que se ve en el Panel. El Panel manda el "modelo" ya armado (ver
// indModeloExportacion_ en public/Panel.html y server/indicadoresExport.js).
app.post('/export/indicadores/:formato', async (req, res) => {
  try {
    const { code, modelo, nombreArchivo } = req.body || {};
    if (code !== TALLER_ACCESS_CODE) return res.status(401).json({ error: 'Clave de acceso incorrecta.' });
    if (!modelo || !Array.isArray(modelo.semanas)) return res.status(400).json({ error: 'No hay datos para exportar.' });
    const nombre = (nombreArchivo || 'indicador_cumplimiento').toString().replace(/[^a-zA-Z0-9_-]+/g, '_').slice(0, 100) || 'indicador_cumplimiento';
    if (req.params.formato === 'pdf') {
      const buffer = await construirPdfIndicadores(modelo);
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', 'attachment; filename="' + nombre + '.pdf"');
      return res.send(buffer);
    }
    if (req.params.formato === 'excel') {
      const buffer = await construirExcelIndicadores(modelo);
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', 'attachment; filename="' + nombre + '.xlsx"');
      return res.send(Buffer.from(buffer));
    }
    return res.status(404).json({ error: 'Formato no soportado.' });
  } catch (err) {
    console.error('[export/indicadores] Falló la exportación:', err);
    res.status(400).json({ error: err.message || String(err) });
  }
});

app.listen(PORT, () => {
  console.log('');
  console.log('  Sistema de Reporte de Fallas — servidor local');
  console.log('  ------------------------------------------------');
  console.log('  Reportar :  http://localhost:' + PORT + '/');
  console.log('  Historial:  http://localhost:' + PORT + '/historial');
  console.log('  Taller   :  http://localhost:' + PORT + '/taller');
  console.log('  Panel    :  http://localhost:' + PORT + '/panel');
  console.log('  Movim.   :  http://localhost:' + PORT + '/movimientos');
  console.log('  Cotizar  :  http://localhost:' + PORT + '/cotizar?token=... (se genera desde el Panel)');
  console.log('');

  // Preventivos: revisa cada equipo/regla y genera solas las órdenes de
  // trabajo de los que ya estén a 20 horas/km o menos de su próximo
  // servicio (ver revisarYGenerarOrdenesPreventivasAutomaticas_ en
  // handlers.js). Se corre una vez al arrancar y luego cada 30 minutos.
  const INTERVALO_REVISION_PREVENTIVOS_MS = 30 * 60 * 1000;
  handlers.revisarYGenerarOrdenesPreventivasAutomaticas_().catch((err) => {
    console.error('[preventivo-auto] Falló la revisión inicial:', err);
  });
  setInterval(() => {
    handlers.revisarYGenerarOrdenesPreventivasAutomaticas_().catch((err) => {
      console.error('[preventivo-auto] Falló la revisión periódica:', err);
    });
  }, INTERVALO_REVISION_PREVENTIVOS_MS);
});
