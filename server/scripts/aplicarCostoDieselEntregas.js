// Aplica un precio por litro (y su total) a las entregas de diesel a
// huertas ya registradas, dentro de un rango de fechas — para cuando se
// captura la entrega primero y el precio se sabe después (como con el
// listado de DIESEL ENTREGADO A HUERTAS que ya se importó).
//
// Por default aplica $27.00/L a las entregas del 14 al 19 de septiembre de
// 2026 (lo que pidió Carlos), pero se puede usar para cualquier otro rango
// o precio con banderas:
//
//   node server/scripts/aplicarCostoDieselEntregas.js
//     (solo revisa qué haría, no guarda nada)
//   node server/scripts/aplicarCostoDieselEntregas.js --aplicar
//     (ya aplica el precio de verdad)
//   node server/scripts/aplicarCostoDieselEntregas.js --desde=2026-10-01 --hasta=2026-10-05 --precio=28 --aplicar
//     (mismo script, para otro rango/precio)
//
// Es seguro correrlo más de una vez: cada corrida SOBREESCRIBE el precio y
// el total de las entregas que caigan en el rango dado (no las duplica, no
// toca litros/huerta/fecha/comentario). Si una entrega ya tenía un precio
// distinto, se reemplaza por el nuevo.

require('dotenv').config();
const pool = require('../db');

function argValue(name, def) {
  const arg = process.argv.find((a) => a.startsWith('--' + name + '='));
  return arg ? arg.slice(('--' + name + '=').length) : def;
}

const APLICAR = process.argv.includes('--aplicar');
const DESDE = argValue('desde', '2026-09-14');
const HASTA = argValue('hasta', '2026-09-19');
const PRECIO = parseFloat(argValue('precio', '27'));

async function main() {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(DESDE) || !/^\d{4}-\d{2}-\d{2}$/.test(HASTA)) {
    console.error('--desde y --hasta deben ir en formato AAAA-MM-DD.');
    process.exit(1);
  }
  if (Number.isNaN(PRECIO) || PRECIO <= 0) {
    console.error('--precio debe ser un número mayor a 0.');
    process.exit(1);
  }

  const [rows] = await pool.query(
    `SELECT id, folio, huerta, litros, precio_litro, total, fecha
     FROM diesel_entregas
     WHERE eliminado = 0 AND fecha >= ? AND fecha <= ?
     ORDER BY fecha, id`,
    [DESDE + ' 00:00:00', HASTA + ' 23:59:59']
  );

  if (rows.length === 0) {
    console.log('No hay entregas de diesel a huertas entre ' + DESDE + ' y ' + HASTA + '. No hay nada que hacer.');
    process.exit(0);
  }

  console.log(
    'Entregas entre ' + DESDE + ' y ' + HASTA + ' (precio a aplicar: $' + PRECIO.toFixed(2) + '/L):\n'
  );
  let totalLitros = 0;
  rows.forEach((r) => {
    const litros = Number(r.litros) || 0;
    const totalNuevo = Math.round(litros * PRECIO * 100) / 100;
    totalLitros += litros;
    const antes =
      r.precio_litro !== null
        ? ` (antes: $${Number(r.precio_litro).toFixed(2)}/L → $${Number(r.total).toFixed(2)})`
        : ' (sin costo capturado todavía)';
    console.log(
      '  ' + r.folio + ' — ' + r.huerta + ' — ' + litros + ' L — nuevo total: $' + totalNuevo.toFixed(2) + antes
    );
  });
  console.log(
    '\nTotal: ' + rows.length + ' entregas, ' + totalLitros.toFixed(2) + ' L, costo total nuevo: $' +
    (totalLitros * PRECIO).toFixed(2)
  );

  if (!APLICAR) {
    console.log('\nEsto fue solo un ENSAYO, no se guardó nada. Si se ve bien, corre de nuevo agregando --aplicar.');
    process.exit(0);
  }

  for (const r of rows) {
    const litros = Number(r.litros) || 0;
    const total = Math.round(litros * PRECIO * 100) / 100;
    await pool.query('UPDATE diesel_entregas SET precio_litro = ?, total = ? WHERE id = ?', [PRECIO, total, r.id]);
  }
  console.log('\nListo — se actualizó el costo de ' + rows.length + ' entregas.');
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
