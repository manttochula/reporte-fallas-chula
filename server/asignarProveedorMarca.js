// Asignar un proveedor a TODAS las refacciones de una marca, de una vez
// (oct-2026, Carlos: "las refacciones que tengan marca KUBOTA ponles el
// proveedor SAMEI"). Lo usa asignar_proveedor_marca.bat (en la nube); hace
// lo mismo que el botón del Panel (Marcas -> Editar -> "Proveedores de esta
// marca"): no les quita los proveedores que ya tengan, SAMEI queda de
// principal en las que no tenían ninguno, y se recuerda para las nuevas.

// Busca marcas y proveedores por nombre (sin importar mayúsculas/espacios)
// y cuenta qué pasaría. No cambia nada.
async function planear(pool, marcaTexto, proveedorTexto) {
  const [marcas] = await pool.query(
    "SELECT id, nombre FROM marcas_refacciones WHERE UPPER(REPLACE(nombre, ' ', '')) LIKE CONCAT('%', UPPER(REPLACE(?, ' ', '')), '%') ORDER BY nombre",
    [marcaTexto]
  );
  const [proveedores] = await pool.query(
    "SELECT id, nombre FROM proveedores WHERE UPPER(REPLACE(nombre, ' ', '')) LIKE CONCAT('%', UPPER(REPLACE(?, ' ', '')), '%') ORDER BY nombre",
    [proveedorTexto]
  );
  return { marcas, proveedores };
}

async function contar(pool, marcaIds, proveedorId) {
  if (!marcaIds.length) return { total: 0, yaLoTienen: 0, sinProveedor: 0 };
  const [[c]] = await pool.query(
    `SELECT COUNT(*) AS total,
            SUM(EXISTS(SELECT 1 FROM refacciones_proveedores rp WHERE rp.refaccion_id = r.id AND rp.proveedor_id = ?)) AS ya,
            SUM(r.proveedor_id IS NULL AND NOT EXISTS(SELECT 1 FROM refacciones_proveedores rp2 WHERE rp2.refaccion_id = r.id)) AS sin
     FROM refacciones r WHERE r.marca_id IN (?)`,
    [proveedorId || 0, marcaIds]
  );
  return { total: Number(c.total) || 0, yaLoTienen: Number(c.ya) || 0, sinProveedor: Number(c.sin) || 0 };
}

async function aplicar(pool, marcaIds, proveedorId) {
  let agregadas = 0;
  for (const mId of marcaIds) {
    await pool.query('INSERT IGNORE INTO marcas_proveedores (marca_id, proveedor_id) VALUES (?, ?)', [mId, proveedorId]);
    const [ins] = await pool.query(
      'INSERT IGNORE INTO refacciones_proveedores (refaccion_id, proveedor_id) SELECT id, ? FROM refacciones WHERE marca_id = ?',
      [proveedorId, mId]
    );
    agregadas += ins.affectedRows;
    await pool.query('UPDATE refacciones SET proveedor_id = ? WHERE marca_id = ? AND proveedor_id IS NULL', [proveedorId, mId]);
  }
  return { agregadas };
}

module.exports = { planear, contar, aplicar };
