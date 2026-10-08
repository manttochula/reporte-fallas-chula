// Generador genérico de reportes en Excel (.xlsx) con el mismo estilo
// visual del Panel (mismo color ámbar de acento, encabezados marcados,
// filas de total en negritas) — pedido por Carlos porque el .csv plano que
// ya se exportaba no tenía buena presentación.
//
// Diseño: en vez de que cada botón "Exportar" (Órdenes, Reporte de diesel,
// Combustible Automotriz, Movimientos, Catálogo, etc.) tenga su propia
// lógica de generación de Excel en el servidor, el CLIENTE arma la misma
// estructura de datos que ya arma hoy para el CSV (ver Panel.html, cada
// "*-export"), pero en vez de convertirla a texto CSV la manda tal cual
// (columnas + filas + fila de total opcional) a exportarExcel() de abajo,
// que construye el libro ya con el formato. Así toda la lógica de permisos
// y de filtrado sigue siendo la que YA existe y ya está probada del lado
// del cliente (getReporteDieselFiltrado, getCAFiltered, etc.) — este
// módulo solo se encarga de la presentación.
const ExcelJS = require('exceljs');

// Mismos colores que usa el Panel (ver <style> de Panel.html: --amber,
// --amber-dim, --bg, --text) — en formato ARGB que pide exceljs.
const COLOR_AMBER = 'FFE8871E';
const COLOR_AMBER_DIM = 'FF7A4A17';
const COLOR_AMBER_SOFT = 'FFFBE7CE'; // tinte suave del ámbar, para fondos de fila de total
const COLOR_TEXTO_OSCURO = 'FF1C1E1F'; // --bg del Panel, se usa como texto sobre fondo ámbar
const COLOR_BORDE = 'FFD9D9D9';
const COLOR_GRIS_TEXTO = 'FF6B6B6B';
const COLOR_FILA_PAR = 'FFF7F7F7';
// Mismo rojo que usa el Panel para resaltar filas fuera de límite (ver
// --danger y .dz-rend-alto en Panel.html) — para que una fila marcada con
// `__resaltar: true` en sus datos (por ejemplo, rendimiento u horas de
// labor por encima del máximo configurado) se exporte a Excel con el mismo
// color que ya se ve en pantalla, en vez de perder esa señal al exportar.
const COLOR_DANGER = 'FFC24B3F';
const COLOR_DANGER_SOFT = 'FFF6E5E4';

// Ancho máximo razonable de columna (en "caracteres", unidad de ExcelJS)
// para que una columna con texto muy largo no se salga de control.
const ANCHO_MAX_COLUMNA = 60;

function anchoColumna_(ancho){
  return Math.min(Math.max(Number(ancho) || 12, 8), ANCHO_MAX_COLUMNA);
}

// Escribe una fila de datos normal (o de total) en la posición `filaExcel`,
// respetando el tipo de cada columna: si el valor es null/undefined se dice
// "—" (igual que en pantalla) en vez de dejar la celda con un 0 falso;
// si la columna trae numFmt se escribe como número real (para que Excel
// pueda sumar/filtrar), si no, como texto.
function escribirFila_(ws, filaExcel, columnas, datos, esTotal){
  const resaltar = !esTotal && !!(datos && datos.__resaltar);
  columnas.forEach(function(col, i){
    const celda = ws.getCell(filaExcel, i + 1);
    const valor = datos ? datos[col.key] : undefined;
    if(valor === null || valor === undefined || valor === ''){
      // En una fila de TOTAL, una columna sin valor (por ejemplo, la
      // columna donde normalmente iría el conteo) se deja en blanco — es
      // el equivalente al colspan de la etiqueta "TOTAL..." en pantalla.
      // En una fila de datos normal, una columna numérica sin valor sí
      // dice "—" (mismo criterio que fmtMoneda_ en el Panel: "sin costo
      // capturado" es distinto de "$0.00").
      celda.value = esTotal ? '' : (col.numFmt ? '—' : '');
    } else if(col.numFmt && typeof valor === 'number'){
      celda.value = valor;
      celda.numFmt = col.numFmt;
    } else {
      celda.value = valor;
    }
    celda.alignment = { vertical: 'middle', horizontal: col.align || (col.numFmt ? 'right' : 'left'), wrapText: !!col.wrap };
    celda.border = {
      top: { style: 'thin', color: { argb: COLOR_BORDE } },
      bottom: { style: 'thin', color: { argb: COLOR_BORDE } },
      left: { style: 'thin', color: { argb: COLOR_BORDE } },
      right: { style: 'thin', color: { argb: COLOR_BORDE } },
    };
    if(esTotal){
      celda.font = { bold: true };
      celda.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: COLOR_AMBER_SOFT } };
      celda.border.top = { style: 'medium', color: { argb: COLOR_AMBER_DIM } };
    } else if(resaltar){
      celda.font = { bold: true, color: { argb: COLOR_DANGER } };
      celda.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: COLOR_DANGER_SOFT } };
    }
  });
}

// Construye UNA sección dentro de la hoja (título de sección + encabezados
// de columna + filas + fila de total opcional) empezando en `filaInicio`.
// Regresa la fila donde terminó, para que la siguiente sección continúe
// después de un renglón en blanco.
function escribirSeccion_(ws, filaInicio, seccion, numColumnasHoja){
  let fila = filaInicio;
  const columnas = seccion.columnas;

  if(seccion.titulo){
    ws.mergeCells(fila, 1, fila, numColumnasHoja);
    const celdaTitulo = ws.getCell(fila, 1);
    celdaTitulo.value = seccion.titulo;
    celdaTitulo.font = { bold: true, size: 12, color: { argb: COLOR_AMBER_DIM } };
    celdaTitulo.alignment = { vertical: 'middle' };
    fila += 1;
  }

  // Encabezados de columna: fondo ámbar (igual acento que usa el Panel en
  // pestañas activas y títulos), texto oscuro en negritas.
  columnas.forEach(function(col, i){
    const celda = ws.getCell(fila, i + 1);
    celda.value = col.header;
    celda.font = { bold: true, color: { argb: COLOR_TEXTO_OSCURO } };
    celda.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: COLOR_AMBER } };
    celda.alignment = { vertical: 'middle', horizontal: col.align || (col.numFmt ? 'right' : 'left') };
    celda.border = {
      top: { style: 'thin', color: { argb: COLOR_BORDE } },
      bottom: { style: 'thin', color: { argb: COLOR_BORDE } },
      left: { style: 'thin', color: { argb: COLOR_BORDE } },
      right: { style: 'thin', color: { argb: COLOR_BORDE } },
    };
  });
  const filaEncabezados = fila;
  fila += 1;

  const filas = seccion.filas || [];
  if(filas.length === 0 && seccion.mensajeVacio){
    ws.mergeCells(fila, 1, fila, numColumnasHoja);
    const celdaVacia = ws.getCell(fila, 1);
    celdaVacia.value = seccion.mensajeVacio;
    celdaVacia.font = { italic: true, color: { argb: COLOR_GRIS_TEXTO } };
    fila += 1;
  } else {
    filas.forEach(function(datos, idx){
      escribirFila_(ws, fila, columnas, datos, false);
      if(idx % 2 === 1){
        columnas.forEach(function(col, i){
          const celda = ws.getCell(fila, i + 1);
          if(!celda.fill){
            celda.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: COLOR_FILA_PAR } };
          }
        });
      }
      fila += 1;
    });
  }

  if(seccion.filaTotal){
    escribirFila_(ws, fila, columnas, seccion.filaTotal, true);
    fila += 1;
  }

  if(seccion.autoFiltro && filas.length > 0){
    ws.autoFilter = {
      from: { row: filaEncabezados, column: 1 },
      to: { row: filaEncabezados, column: columnas.length },
    };
    ws.views = [{ state: 'frozen', ySplit: filaEncabezados }];
  }

  return fila;
}

// titulo: nombre del reporte (se ve arriba de todo, en grande).
// subtitulo: rango de fechas + filtros activos + "Generado el ...".
// secciones: arreglo de { titulo?, columnas: [{header,key,width,numFmt,align}],
//   filas: [ {key: valor, ...} ], filaTotal?: {...}, mensajeVacio?, autoFiltro? }.
// Regresa un Buffer con el .xlsx listo para mandar como descarga.
async function construirLibroExcel({ titulo, subtitulo, secciones }){
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Sistema de Reporte de Fallas';
  wb.created = new Date();
  const ws = wb.addWorksheet((titulo || 'Reporte').slice(0, 31).replace(/[\\/*?:[\]]/g, ' '));

  const numColumnas = secciones.reduce(function(max, s){ return Math.max(max, s.columnas.length); }, 1);

  // Ancho de cada columna: el máximo que pida cualquier sección para esa
  // posición (las distintas secciones de un mismo reporte pueden tener
  // columnas distintas, apiladas una debajo de otra en la misma hoja).
  const anchos = new Array(numColumnas).fill(10);
  secciones.forEach(function(s){
    s.columnas.forEach(function(col, i){ anchos[i] = Math.max(anchos[i], anchoColumna_(col.width)); });
  });
  anchos.forEach(function(a, i){ ws.getColumn(i + 1).width = a; });

  let fila = 1;
  if(titulo){
    ws.mergeCells(fila, 1, fila, numColumnas);
    const celda = ws.getCell(fila, 1);
    celda.value = titulo;
    celda.font = { bold: true, size: 14, color: { argb: COLOR_TEXTO_OSCURO } };
    fila += 1;
  }
  if(subtitulo){
    ws.mergeCells(fila, 1, fila, numColumnas);
    const celda = ws.getCell(fila, 1);
    celda.value = subtitulo;
    celda.font = { italic: true, size: 10, color: { argb: COLOR_GRIS_TEXTO } };
    fila += 1;
  }
  if(titulo || subtitulo) fila += 1; // renglón en blanco antes de la primera sección

  secciones.forEach(function(seccion, idx){
    fila = escribirSeccion_(ws, fila, seccion, numColumnas);
    if(idx < secciones.length - 1) fila += 1; // renglón en blanco entre secciones
  });

  return wb.xlsx.writeBuffer();
}

module.exports = { construirLibroExcel };
