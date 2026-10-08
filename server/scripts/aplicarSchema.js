// Aplica db/schema.sql directo con Node (sin necesitar el comando "mysql"
// en la terminal, que en algunas instalaciones de Windows no queda en el
// PATH). Hace exactamente lo mismo que correr:
//   mysql -u root -p < db\schema.sql
// pero usando la misma conexión (mysql2) y las mismas credenciales del
// archivo .env que ya usa el servidor.
//
// Se puede correr más de una vez sin problema: schema.sql está escrito
// para no fallar si las tablas/columnas ya existen.
//
// Cómo correrlo (en tu computadora, en la carpeta del proyecto):
//   node server/scripts/aplicarSchema.js
//
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');

async function main() {
  const schemaPath = path.join(__dirname, '..', '..', 'db', 'schema.sql');
  const sql = fs.readFileSync(schemaPath, 'utf8');

  const connection = await mysql.createConnection({
    host: process.env.DB_HOST || 'localhost',
    port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    multipleStatements: true,
  });

  console.log('Aplicando db/schema.sql...');
  await connection.query(sql);
  console.log('Listo. El schema se aplicó sin errores.');
  await connection.end();
}

main().catch((err) => {
  console.error('Error al aplicar el schema:', err.message);
  process.exit(1);
});
