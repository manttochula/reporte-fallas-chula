// Conexión a MySQL (equivalente a SpreadsheetApp.openById(SHEET_ID) del Codigo.gs original).
require('dotenv').config();
const mysql = require('mysql2/promise');

// SSL es opcional y solo se activa si se configura explícitamente — en tu
// computadora, sin estas variables, la conexión sigue exactamente igual que
// siempre (sin SSL, hacia el MySQL local). Para una base de datos en la nube
// (como Aiven, que SÍ exige SSL) se activa poniendo DB_SSL=true, y si el
// proveedor da un certificado CA propio, se pega su contenido completo (el
// archivo .pem) en DB_SSL_CA para validarlo de forma estricta.
let sslConfig;
if (process.env.DB_SSL_CA) {
  sslConfig = { ca: process.env.DB_SSL_CA, rejectUnauthorized: true };
} else if (String(process.env.DB_SSL || '').toLowerCase() === 'true') {
  sslConfig = { rejectUnauthorized: false };
}

const pool = mysql.createPool({
  host: process.env.DB_HOST || 'localhost',
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'reporte_fallas',
  waitForConnections: true,
  connectionLimit: 10,
  dateStrings: false,
  ...(sslConfig ? { ssl: sslConfig } : {}),
});

module.exports = pool;
