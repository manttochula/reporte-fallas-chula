# Sistema de Reporte de Fallas — versión local (Node.js + MySQL)

Esta es la migración del sistema de "Reporte de Fallas" que antes vivía en
Google Apps Script + Google Sheets, para que corra en tu computadora usando
la misma base técnica que ya se usa en el área comercial: **MySQL** como
base de datos, **Node.js** como orquestador, y el mismo **frontend en
HTML + JavaScript** de siempre (casi no cambió).

Esta versión está pensada para **desarrollo y pruebas en tu equipo**. Una
vez que la valides, se puede decidir junto con IT dónde queda alojada de
forma permanente (servidor local, VPN, nube, etc.) — ver la nota al final.

## Qué cambió y qué seguidas siendo lo mismo

| Antes (Apps Script) | Ahora (local) |
|---|---|
| Google Sheets como base de datos | MySQL 8 (base de datos `reporte_fallas`) |
| Funciones en Codigo.gs | API en Node.js (carpeta `server/`) |
| `google.script.run` | `fetch()` a `http://localhost:3000/api/...` (el HTML no cambió; solo se agregó un pequeño "traductor" al inicio de cada archivo) |
| Fotos en Google Drive | Fotos en la carpeta `uploads/` de tu computadora |
| Login usuario/contraseña en texto plano | Contraseñas guardadas con hash (bcrypt) — nadie, ni siquiera abriendo la base de datos, puede leerlas |
| Los 4 módulos (Reportar, Historial, Taller, Panel) | Los mismos 4 módulos, con la misma interfaz |

Los íconos de acceso directo que apuntaban a GitHub Pages **no aplican a
esta versión local** (apuntaban a la URL pública de Apps Script). Cuando
se decida dónde queda la versión definitiva, se generan de nuevo apuntando
a esa nueva dirección.

## 1. Requisitos (una sola vez)

1. **Node.js** (versión 18 o más reciente): [https://nodejs.org](https://nodejs.org) — instala la versión "LTS". El instalador de Windows es el de siempre, "Siguiente, Siguiente, Instalar".
2. **MySQL Community Server 8**: [https://dev.mysql.com/downloads/installer/](https://dev.mysql.com/downloads/installer/) — descarga el "MySQL Installer for Windows". Durante la instalación:
   - Elige "Server only" (o "Developer Default" si también quieres MySQL Workbench, recomendable para ver las tablas de forma visual).
   - Cuando te pida una contraseña para el usuario `root`, anótala — la vas a necesitar en el paso 2 de abajo.

## 2. Preparar el proyecto

1. Descomprime esta carpeta en tu computadora, por ejemplo en `C:\ReporteFallas`.
2. Abre **PowerShell** (o símbolo del sistema) dentro de esa carpeta (botón derecho → "Abrir en Terminal", o `cd C:\ReporteFallas`).
3. Copia `.env.example` a un archivo nuevo llamado `.env`:
   ```
   copy .env.example .env
   ```
4. Abre `.env` con el Bloc de notas y pon la contraseña de MySQL que elegiste al instalar (`DB_PASSWORD=...`). Los demás valores puedes dejarlos igual.
5. Crea la base de datos y las tablas (te va a pedir la contraseña de MySQL):
   ```
   mysql -u root -p < db\schema.sql
   ```
   (Si `mysql` no se reconoce como comando, agrega la carpeta `bin` de tu instalación de MySQL, normalmente `C:\Program Files\MySQL\MySQL Server 8.0\bin`, a la variable de entorno PATH de Windows — o simplemente usa MySQL Workbench: abre `db/schema.sql` ahí y ejecútalo con el botón de rayo ⚡.)
6. Instala las dependencias del proyecto:
   ```
   npm install
   ```

## 3. Iniciar el sistema

```
npm start
```

Vas a ver un mensaje con las 4 direcciones. Ábrelas en Chrome:

- Reportar: http://localhost:3000/
- Historial: http://localhost:3000/historial
- Taller: http://localhost:3000/taller
- Panel: http://localhost:3000/panel

Para detenerlo, regresa a la ventana de PowerShell y presiona `Ctrl + C`.
Cada vez que quieras volver a usar el sistema, abre PowerShell en la
carpeta del proyecto y corre `npm start` de nuevo (no hace falta repetir
la instalación).

## 4. Dar de alta el primer usuario

Igual que antes, el Panel se abre con la clave de acceso **Operacion**
(la misma que usa Taller). No hay usuarios cargados todavía, así que:

1. Entra a http://localhost:3000/panel y escribe la clave `Operacion`.
2. Ve a la pestaña **Usuarios** y da de alta a cada persona: nombre,
   huerta, contraseña y a qué módulos tiene acceso (Reportar, Taller,
   Panel...). Esto es exactamente el mismo formulario que ya conocías.

Si prefieres no capturar a mano a todo el personal, puedes migrar los
usuarios que ya tenías en el Google Sheet — ver el siguiente punto.

## 5. Migrar la información que ya existe en Google Sheets (opcional)

Si quieres traer los usuarios, reportes y cargas de diesel que ya están
en el Google Sheet original:

1. Abre el Google Sheet → en cada pestaña (Usuarios, Reportes, Diesel):
   **Archivo → Descargar → Valores separados por comas (.csv)**
2. Guarda esos archivos como `usuarios.csv`, `reportes.csv` y
   `diesel.csv` dentro de la carpeta `server/scripts/` de este proyecto.
3. Corre, en este orden (usuarios primero, porque reportes y diesel no
   dependen de ellos pero es buen orden lógico):
   ```
   npm run import:usuarios
   npm run import:reportes
   npm run import:diesel
   ```

Nota: las fotos que ya estaban en Google Drive se importan como enlaces
(siguen abriendo desde Drive); no se vuelven a descargar. Las fotos
nuevas que captures desde este sistema local sí se guardan en la carpeta
`uploads/` de tu computadora.

## 6. Ubicación de los datos en tu computadora

- Base de datos: dentro de MySQL, en la base `reporte_fallas` (la
  administra el propio MySQL Server, no es una carpeta que tengas que
  tocar a mano).
- Fotos/videos nuevos: carpeta `uploads/` dentro de este proyecto.
- Configuración (contraseña de MySQL, claves de acceso): archivo `.env`.

Como esto corre en tu computadora, el sistema solo está disponible
mientras tu equipo esté encendido y con `npm start` corriendo, y solo se
puede abrir desde tu misma computadora (`http://localhost:3000`). Para
que el personal de campo lo use desde su celular vamos a necesitar
moverlo a un servidor accesible por la red — este montaje local es el
paso previo para probar que todo funciona antes de dar ese salto.

## 7. Estructura del proyecto

```
reporte-fallas-local/
├── db/
│   └── schema.sql              Tablas de MySQL
├── server/
│   ├── server.js                Servidor Express (equivalente a doGet/doPost)
│   ├── db.js                    Conexión a MySQL
│   ├── handlers.js              Las 14 funciones que antes vivían en Codigo.gs
│   ├── helpers.js                Folios consecutivos, guardar fotos, control de acceso
│   └── scripts/                  Scripts de migración desde el Google Sheet
├── public/
│   ├── Index.html                Módulo Reportar (con la pestaña Cargar Diesel)
│   ├── Historial.html
│   ├── Taller.html
│   └── Panel.html
├── uploads/                      Fotos/videos capturados desde este sistema
├── .env.example / .env
└── package.json
```

Cada función en `server/handlers.js` tiene el mismo nombre y hace
exactamente lo mismo que su equivalente en el `Codigo.gs` original, para
que sea fácil comparar una con otra si algo no cuadra.
