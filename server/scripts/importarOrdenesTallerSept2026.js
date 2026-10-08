// Da de alta el listado de 38 fallas/pendientes de Taller que mandó Carlos
// (archivo SUBIR11.xlsx, versión corregida) como nuevas órdenes abiertas en
// "reportes", una por cada renglón del listado.
//
// Qué hace, paso a paso:
//   1) Para cada renglón, busca el código de unidad en tu catálogo de
//      maquinaria (pestaña Catálogo) y usa el nombre de unidad que ya
//      tienes ahí (no el texto de la columna "Unidad" del Excel, que en
//      algún renglón venía con un texto raro/pegado de otro sistema) — así
//      la orden queda ligada correctamente a la ficha de esa unidad. Si el
//      código no se encuentra en tu catálogo, usa el texto del Excel tal
//      cual y lo avisa al final, por si el código está mal capturado.
//   2) Normaliza el nombre de huerta "LA AURORA" (como venía en 3 renglones
//      del Excel) a "AURORA", que es como está dado de alta esa huerta en
//      el sistema.
//   3) Usa "Taller" como quien reportó (nombre), porque este listado se
//      armó internamente en Taller y ya no trae una columna de reportante
//      individual — así me lo confirmaste.
//   4) Antes de crear cada orden, revisa si YA existe una orden ABIERTA
//      (sin fecha de salida) para esa misma unidad con una descripción
//      igual o muy parecida (sin importar mayúsculas/espacios) — si ya
//      existe, NO la duplica, solo lo avisa. Esto hace que el script se
//      pueda volver a correr sin miedo a duplicar todo.
//   5) Las fechas de "atención" que sí traía el Excel se capturan tal
//      cual (así la orden ya se ve "En proceso" en vez de "Pendiente");
//      ninguna de las 38 trae fecha de salida, así que todas quedan
//      abiertas.
//
// Cómo correrlo (en tu computadora, en la carpeta del proyecto, con el
// servidor apagado o encendido, cualquiera de los dos está bien):
//   node server/scripts/importarOrdenesTallerSept2026.js
//
require('dotenv').config();
const pool = require('../db');
const { siguienteFolio_ } = require('../helpers');

const NOMBRE_REPORTA = 'Taller';

// El Excel trae "LA AURORA"; en el sistema esa huerta está dada de alta
// como "AURORA" (ver HUERTAS en public/Panel.html y public/Movimientos.html).
const HUERTA_NORMALIZADA = {
  'LA AURORA': 'AURORA',
};

// Listado tal cual viene en SUBIR11.xlsx (versión corregida que mandó
// Carlos): CodigoUnidad, Unidad (texto del Excel — ver punto 1 arriba),
// Huerta, Descripcion, FechaReporte, FechaAtencion, FechaSalida.
const FILAS = [
  { codigoUnidad: '9138', unidadHoja: 'IA037-TURBINA PB.07', huerta: 'TALLER', descripcion: 'REVISION GENERAL', fechaReporte: '2026-03-27', fechaAtencion: null, fechaSalida: null },
  { codigoUnidad: '9423', unidadHoja: 'AF-729 L3800 KUBOTA', huerta: 'TALLER', descripcion: 'HOUSING FISURADO', fechaReporte: '2026-05-29', fechaAtencion: null, fechaSalida: null },
  { codigoUnidad: '9315', unidadHoja: 'AF-001-5065E JD', huerta: 'TALLER', descripcion: 'REVISION DE CLUTCH', fechaReporte: '2026-06-15', fechaAtencion: null, fechaSalida: null },
  { codigoUnidad: '622', unidadHoja: 'AF523-5075 JD', huerta: 'SAN JOACHIN', descripcion: 'REVISION DE CLUTCH', fechaReporte: '2026-06-24', fechaAtencion: null, fechaSalida: null },
  { codigoUnidad: '517', unidadHoja: 'AF517-416D CAT', huerta: 'MATA CAZUELA', descripcion: 'REPARACION ALTERNADOR', fechaReporte: '2026-09-10', fechaAtencion: '2026-09-14', fechaSalida: null },
  { codigoUnidad: '9316', unidadHoja: 'AF003-L3800 KUBOTA', huerta: 'PASO LIMON', descripcion: 'CAMBIO DE BANDA ROTA', fechaReporte: '2026-09-11', fechaAtencion: '2026-09-14', fechaSalida: null },
  { codigoUnidad: '1351', unidadHoja: 'IA351 CHAPEADORA.19', huerta: 'TALLER', descripcion: 'FLECHA DAÑADA', fechaReporte: '2026-07-29', fechaAtencion: null, fechaSalida: null },
  { codigoUnidad: '9137', unidadHoja: 'IA036-TURBINA PB.06', huerta: 'RANCHO NUEVO', descripcion: 'PERDIDA DE PRESION', fechaReporte: '2026-09-08', fechaAtencion: '2026-09-14', fechaSalida: null },
  { codigoUnidad: '9222', unidadHoja: 'AF-017-9540 KUBOTA', huerta: 'MATA CAZUELA', descripcion: 'FUGA DE ACEITE', fechaReporte: '2026-06-26', fechaAtencion: '2026-09-14', fechaSalida: null },
  { codigoUnidad: '9373', unidadHoja: 'IA151 REM CAJON', huerta: 'LA CRUZ', descripcion: 'ESTRUCTURA DESOLDADA', fechaReporte: '2026-08-21', fechaAtencion: null, fechaSalida: null },
  { codigoUnidad: '9314', unidadHoja: 'AF-034-L3800 KUBOTA', huerta: 'TALLER', descripcion: 'PALANCA DE VELOCIDADES', fechaReporte: '2026-07-14', fechaAtencion: '2026-09-14', fechaSalida: null },
  { codigoUnidad: '431', unidadHoja: 'AF431-7610 NW', huerta: 'TALLER', descripcion: 'REVISION DIRECCION, FUGA DE ACEITE', fechaReporte: '2026-08-29', fechaAtencion: '2026-09-14', fechaSalida: null },
  { codigoUnidad: '543', unidadHoja: 'AF543-3320 JD', huerta: 'GUADALUPE', descripcion: 'NO FUNCIONA EL HOROMETRO', fechaReporte: '2026-08-22', fechaAtencion: '2026-09-15', fechaSalida: null },
  { codigoUnidad: '555', unidadHoja: 'AF555-5303 JD', huerta: 'GUADALUPE', descripcion: 'FUGA DE COMBUSTIBLE EN MANGUERA', fechaReporte: '2026-08-26', fechaAtencion: '2026-09-15', fechaSalida: null },
  { codigoUnidad: '9362', unidadHoja: 'IA113-NIVELADORA 4', huerta: 'NIDO DE AGUILA', descripcion: 'CONEXIONES HIDRAULICAS', fechaReporte: '2026-08-29', fechaAtencion: null, fechaSalida: null },
  { codigoUnidad: '513', unidadHoja: 'AF513-3320 JD', huerta: 'PASO LIMON', descripcion: 'SISTEMA DE FRENOS', fechaReporte: '2026-08-31', fechaAtencion: null, fechaSalida: null },
  { codigoUnidad: '9422', unidadHoja: 'AF-728 L3800 KUBOTA', huerta: 'LA AURORA', descripcion: 'REVISION DE LUCES', fechaReporte: '2026-09-07', fechaAtencion: '2026-09-15', fechaSalida: null },
  { codigoUnidad: '9631', unidadHoja: 'IA376 REMVOLTEO', huerta: 'RANCHO NUEVO', descripcion: 'SOLDAR FISURAS EN SOPORTES', fechaReporte: '2026-08-31', fechaAtencion: null, fechaSalida: null },
  { codigoUnidad: '588', unidadHoja: 'AF588-3036 JD', huerta: 'MATA DE GALLO', descripcion: 'REPARACION DE BASE DE ASIENTO', fechaReporte: '2026-09-07', fechaAtencion: null, fechaSalida: null },
  { codigoUnidad: '9229', unidadHoja: 'AF029-7040 KUBOTA', huerta: 'NIDO DE AGUILA', descripcion: 'REVISIOM DE TERMINAL DE DIRECCION, ANTICONGELANTE', fechaReporte: '2026-09-07', fechaAtencion: null, fechaSalida: null },
  { codigoUnidad: '9324', unidadHoja: 'IA013-ASPERSORA  H-1', huerta: 'LA AURORA', descripcion: 'INSTALACION DE FAROS AUXILIARES', fechaReporte: '2026-09-10', fechaAtencion: '2026-09-15', fechaSalida: null },
  { codigoUnidad: '9422', unidadHoja: 'AF-728-L3800 KUBOTA', huerta: 'LA AURORA', descripcion: 'SERVICIO MOTOR// HIDRAULICO', fechaReporte: '2026-09-11', fechaAtencion: '2026-09-15', fechaSalida: null },
  { codigoUnidad: '9171', unidadHoja: 'FMG-02-L3800 KUBOTA', huerta: 'PASO LIMON', descripcion: 'BASE DESOLDADA', fechaReporte: '2026-09-08', fechaAtencion: null, fechaSalida: null },
  { codigoUnidad: '9318', unidadHoja: 'ECO:AF032-L3800 KUBOTA 2022 KUBOTA UP LC', huerta: 'LA CRUZ', descripcion: 'SERVICIO MOTOR', fechaReporte: '2026-09-11', fechaAtencion: '2026-09-15', fechaSalida: null },
  { codigoUnidad: '9318', unidadHoja: 'AF032-L3800 KUBOTA', huerta: 'LA CRUZ', descripcion: 'CAMBIO DE LLANTA TRASERA', fechaReporte: '2026-09-08', fechaAtencion: null, fechaSalida: null },
  { codigoUnidad: '9229', unidadHoja: 'AF029-7040 KUBOTA', huerta: 'NIDO DE AGUILA', descripcion: 'REVISION DE MARCHA', fechaReporte: '2026-07-30', fechaAtencion: '2026-09-15', fechaSalida: null },
  { codigoUnidad: '9130', unidadHoja: 'IA024-TURBINA JC-01', huerta: 'NIDO DE AGUILA', descripcion: 'SOPORTE DE BANDA', fechaReporte: '2026-09-10', fechaAtencion: '2026-09-15', fechaSalida: null },
  { codigoUnidad: '9223', unidadHoja: 'AF030-L3800 KUBOTA', huerta: 'SAN JOACHIN', descripcion: 'RETEN DE MANDO DELANTERO', fechaReporte: '2026-09-09', fechaAtencion: '2026-09-15', fechaSalida: null },
  { codigoUnidad: '9421', unidadHoja: 'AF-727 L3800 KUBOTA', huerta: 'SANTA EULALIA', descripcion: 'INSTALACION DE FAROS AUXILIARES, REVISION DE LUCES, NO TIENE PESAS', fechaReporte: '2026-08-31', fechaAtencion: '2026-09-15', fechaSalida: null },
  { codigoUnidad: '9330', unidadHoja: 'AI027-TURBINA JC-04', huerta: 'NIDO DE AGUILA', descripcion: 'CAMBIO DE LLANTAS', fechaReporte: '2026-09-10', fechaAtencion: null, fechaSalida: null },
  { codigoUnidad: '9340', unidadHoja: 'IA056-CHAPEADORA.13', huerta: 'LA CRUZ', descripcion: 'CRUCETAS DAÑADAS', fechaReporte: '2026-09-10', fechaAtencion: null, fechaSalida: null },
  { codigoUnidad: '9415', unidadHoja: 'AF731-6603 JD', huerta: 'TALLER', descripcion: 'SISTEMA HIDRAULICO', fechaReporte: '2026-08-24', fechaAtencion: '2026-09-16', fechaSalida: null },
  { codigoUnidad: '9196', unidadHoja: 'AF641-L3800 KUBOTA', huerta: 'MATA DE GALLO', descripcion: 'SERVICIO MOTOR// HIDRAULICO', fechaReporte: '2026-09-11', fechaAtencion: '2026-09-16', fechaSalida: null },
  { codigoUnidad: '9191', unidadHoja: 'AF640-L3800 KUBOTA', huerta: 'RANCHO NUEVO', descripcion: 'SERVICIO MOTOR// HIDRAULICO', fechaReporte: '2026-09-11', fechaAtencion: '2026-09-17', fechaSalida: null },
  { codigoUnidad: '9570', unidadHoja: 'MTTO. ELECTRICO', huerta: 'RANCHO NUEVO', descripcion: 'HABILITAR COMPACTADORA DE PAPEL', fechaReporte: '2026-08-17', fechaAtencion: '2026-09-17', fechaSalida: null },
  { codigoUnidad: '511', unidadHoja: 'AF511-6115 JD', huerta: 'ALMA LUCIA', descripcion: 'SERVICIO MOTOR', fechaReporte: '2026-09-11', fechaAtencion: '2026-09-17', fechaSalida: null },
  { codigoUnidad: '9222', unidadHoja: 'AF017-9540 KUBOTA', huerta: 'MATA CAZUELA', descripcion: 'SERVICIO MOTOR', fechaReporte: '2026-09-11', fechaAtencion: '2026-09-17', fechaSalida: null },
];

function normalizarTexto_(s) {
  return (s || '').toString().trim().replace(/\s+/g, ' ').toUpperCase();
}

async function obtenerUnidadCatalogo_(codigoUnidad) {
  const [rows] = await pool.query('SELECT unidad FROM maquinaria WHERE codigo_unidad = ? LIMIT 1', [codigoUnidad]);
  return rows.length > 0 ? rows[0].unidad : null;
}

// Busca, entre las órdenes ABIERTAS (sin fecha_salida) de esa misma unidad,
// si ya hay una con una descripción igual o muy parecida — para no
// duplicar algo que ya se había capturado (a mano, o en una corrida
// anterior de este mismo script).
async function buscarOrdenAbiertaParecida_(codigoUnidad, descripcion) {
  const [rows] = await pool.query(
    'SELECT orden, descripcion FROM reportes WHERE codigo_unidad = ? AND fecha_salida IS NULL',
    [codigoUnidad]
  );
  const descNorm = normalizarTexto_(descripcion);
  return rows.find((r) => normalizarTexto_(r.descripcion) === descNorm) || null;
}

async function main() {
  let creadas = 0;
  let saltadas = 0;
  const avisosUnidadNoEncontrada = new Set();

  for (const fila of FILAS) {
    const huerta = HUERTA_NORMALIZADA[fila.huerta] || fila.huerta;

    const unidadCatalogo = await obtenerUnidadCatalogo_(fila.codigoUnidad);
    if (!unidadCatalogo) {
      avisosUnidadNoEncontrada.add(
        `AVISO: no se encontró la unidad con código "${fila.codigoUnidad}" en tu catálogo de maquinaria — se usó el texto del listado ("${fila.unidadHoja}") tal cual. Revisa si el código está bien.`
      );
    }
    const unidadLabel = unidadCatalogo || fila.unidadHoja;

    const existente = await buscarOrdenAbiertaParecida_(fila.codigoUnidad, fila.descripcion);
    if (existente) {
      console.log(`SALTADA — ${unidadLabel} (${fila.codigoUnidad}): "${fila.descripcion}" ya existe como orden abierta ${existente.orden}. No se duplica.`);
      saltadas++;
      continue;
    }

    const orden = await siguienteFolio_(pool, 'orden', 'OF', 5);
    await pool.query(
      `INSERT INTO reportes (orden, codigo_unidad, unidad, huerta, descripcion, nombre, fecha, fecha_atencion, fecha_salida)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        orden,
        fila.codigoUnidad,
        unidadLabel,
        huerta,
        fila.descripcion,
        NOMBRE_REPORTA,
        fila.fechaReporte + ' 00:00:00',
        fila.fechaAtencion,
        fila.fechaSalida,
      ]
    );
    console.log(`CREADA ${orden} — ${unidadLabel} (${huerta}) — "${fila.descripcion}"${fila.fechaAtencion ? ' — En proceso desde ' + fila.fechaAtencion : ' — Pendiente'}`);
    creadas++;
  }

  console.log('');
  if (avisosUnidadNoEncontrada.size > 0) {
    console.log('--- Avisos ---');
    avisosUnidadNoEncontrada.forEach((a) => console.log(a));
    console.log('');
  }
  console.log(`Listo: ${creadas} órdenes creadas, ${saltadas} saltadas por ya existir abiertas.`);
  await pool.end();
}

main().catch((err) => {
  console.error('Error:', err);
  process.exit(1);
});
