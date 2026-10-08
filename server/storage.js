// Dónde viven las fotos/videos que la gente adjunta a sus reportes.
//
// En tu computadora (como hasta ahora) se guardan en la carpeta /uploads
// de este proyecto, y Express las sirve directo desde ahí — nada de esto
// cambia si no configuras las variables de nube de abajo.
//
// Si el sistema corre en la nube (Render), la carpeta /uploads NO sirve
// para guardar nada de forma permanente (se borra cada vez que el
// servicio se reinicia o "se duerme"), así que ahí las fotos/videos se
// suben a un almacenamiento aparte en su lugar — pensado justo para esto.
// Se usa Backblaze B2 (gratis hasta 10 GB, sin pedir tarjeta), pero como
// habla el mismo "idioma" (API compatible con S3) que Cloudflare R2 y
// otros, estas mismas variables sirven para cualquiera de los dos. Se
// activa solo si están puestas TODAS estas variables de entorno:
//   S3_BUCKET, S3_ENDPOINT, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY,
//   S3_PUBLIC_BASE_URL
// Sin ellas, todo funciona exactamente igual que siempre (modo local).
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const UPLOADS_DIR = path.join(__dirname, '..', 'uploads');
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });

const S3_BUCKET = process.env.S3_BUCKET;
const S3_ENDPOINT = process.env.S3_ENDPOINT;
const S3_ACCESS_KEY_ID = process.env.S3_ACCESS_KEY_ID;
const S3_SECRET_ACCESS_KEY = process.env.S3_SECRET_ACCESS_KEY;
const S3_PUBLIC_BASE_URL = (process.env.S3_PUBLIC_BASE_URL || '').replace(/\/+$/, '');
const S3_REGION = process.env.S3_REGION || 'auto';

const NUBE_ARCHIVOS_ACTIVA = !!(S3_BUCKET && S3_ENDPOINT && S3_ACCESS_KEY_ID && S3_SECRET_ACCESS_KEY && S3_PUBLIC_BASE_URL);

let s3Client = null;
let PutObjectCommand = null;
let GetObjectCommand = null;
if (NUBE_ARCHIVOS_ACTIVA) {
  // Se carga solo si de verdad se va a usar, para no exigir esta
  // dependencia cuando el sistema corre en modo local.
  const { S3Client, PutObjectCommand: PutCmd, GetObjectCommand: GetCmd } = require('@aws-sdk/client-s3');
  PutObjectCommand = PutCmd;
  GetObjectCommand = GetCmd;
  s3Client = new S3Client({
    region: S3_REGION,
    endpoint: S3_ENDPOINT,
    credentials: { accessKeyId: S3_ACCESS_KEY_ID, secretAccessKey: S3_SECRET_ACCESS_KEY },
  });
}

/**
 * Decodifica un data URL (base64) de foto/video/audio/PDF y lo guarda —
 * en disco (modo local) o en la nube (modo S3). Regresa la URL a guardar
 * en la base de datos, usando el mismo convenio de prefijos que usaba
 * Drive en el sistema original:
 *   - imagen -> "/uploads/archivo.jpg"
 *   - video  -> "VID:/uploads/archivo.mp4"
 *   - audio  -> "AUD:/uploads/archivo.webm"
 *   - pdf (application/pdf) -> "/uploads/archivo.pdf"
 * Esta URL es IDÉNTICA en los dos modos — lo que cambia es nada más
 * dónde vive el archivo de verdad; eso lo resuelve server.js al servir
 * /uploads/* (redirige a la nube si NUBE_ARCHIVOS_ACTIVA).
 */
async function guardarArchivo_(dataUrl) {
  const matches = dataUrl.match(/^data:(image|video|audio|application)\/([\w+.-]+);base64,(.+)$/);
  if (!matches) {
    throw new Error(
      'No se pudo procesar el archivo adjunto (tamaño: ' +
        Math.round((dataUrl.length || 0) / 1024) +
        'KB). Intenta con un archivo más corto.'
    );
  }
  const mediaKind = matches[1];
  const subtype = matches[2];
  const base64 = matches[3];
  const ext = subtype.split(/[+;]/)[0] || (mediaKind === 'video' ? 'mp4' : mediaKind === 'audio' ? 'webm' : 'jpg');
  const filename = 'archivo_' + Date.now() + '_' + crypto.randomBytes(4).toString('hex') + '.' + ext;
  const buffer = Buffer.from(base64, 'base64');

  if (NUBE_ARCHIVOS_ACTIVA) {
    await s3Client.send(
      new PutObjectCommand({
        Bucket: S3_BUCKET,
        Key: filename,
        Body: buffer,
        ContentType: mediaKind + '/' + subtype,
      })
    );
  } else {
    fs.writeFileSync(path.join(UPLOADS_DIR, filename), buffer);
  }

  const url = '/uploads/' + filename;
  if (mediaKind === 'video') return 'VID:' + url;
  if (mediaKind === 'audio') return 'AUD:' + url;
  return url;
}

// Nombre de archivo seguro a partir de una FotoURL ("/uploads/x.jpg" o
// "VID:/uploads/x.mp4") — null si no aplica o si trae algo raro (../..).
function nombreArchivoDesdeUrl_(fotoUrl) {
  if (!fotoUrl) return null;
  const sinPrefijo = fotoUrl.startsWith('VID:') || fotoUrl.startsWith('AUD:') ? fotoUrl.slice(4) : fotoUrl;
  if (!sinPrefijo.startsWith('/uploads/')) return null;
  const nombreArchivo = sinPrefijo.slice('/uploads/'.length);
  if (nombreArchivo.includes('..') || nombreArchivo.includes('/') || nombreArchivo.includes('\\')) return null;
  return nombreArchivo;
}

/**
 * Lee el CONTENIDO de un archivo ya guardado (usado por pdfExport.js para
 * incrustar la foto del reportante en el PDF). Regresa un Buffer, o null
 * si no existe / no aplica (video, audio, o no se encontró).
 */
async function leerArchivoComoBuffer_(fotoUrl) {
  if (!fotoUrl || fotoUrl.startsWith('VID:') || fotoUrl.startsWith('AUD:')) return null;
  const nombreArchivo = nombreArchivoDesdeUrl_(fotoUrl);
  if (!nombreArchivo) return null;

  if (NUBE_ARCHIVOS_ACTIVA) {
    try {
      const respuesta = await s3Client.send(new GetObjectCommand({ Bucket: S3_BUCKET, Key: nombreArchivo }));
      const chunks = [];
      for await (const chunk of respuesta.Body) chunks.push(chunk);
      return Buffer.concat(chunks);
    } catch (err) {
      return null;
    }
  }

  const ruta = path.join(UPLOADS_DIR, nombreArchivo);
  return fs.existsSync(ruta) ? fs.readFileSync(ruta) : null;
}

module.exports = {
  UPLOADS_DIR,
  NUBE_ARCHIVOS_ACTIVA,
  S3_PUBLIC_BASE_URL,
  guardarArchivo_,
  leerArchivoComoBuffer_,
};
