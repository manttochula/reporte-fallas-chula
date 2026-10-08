// Carga inicial de PREVENTIVOS AGRICOLAS: reglas por modelo (filtros +
// aceite + periodicidad) a partir de "FILTROS Y ACEITES.xlsx", y el
// historial de último servicio por equipo a partir de
// "PREVENTIVOS 18092026.xlsx" (ambos archivos que mandó Carlos).
//
// Qué hace, paso a paso:
//   1) Da de alta (o reutiliza si ya existen, ej. de
//      importarMarcasModelosFiltros.js) cada marca/modelo del catálogo.
//   2) Crea/actualiza una regla de mantenimiento por (modelo, tipo de
//      preventivo) — PREVENTIVO MOTOR y PREVENTIVO HIDRAULICO — con sus
//      filtros (reutilizando refacciones existentes por no_parte, igual
//      que importarMarcasModelosFiltros.js) y litros de aceite. El
//      intervalo (horas) sale de la tabla "PERIODICIDAD DE SERVICIO" del
//      archivo, que es POR MARCA (no por modelo).
//   3) Para cada equipo/tipo del listado de PREVENTIVOS 18092026, busca el
//      equipo vigente en Maquinaria (por el texto de "unidad") y liga su
//      último servicio (fecha + horómetro) a la regla de su modelo, en la
//      tabla mantenimiento_servicios. Prefiere el modelo_id YA asignado al
//      equipo en el catálogo (más confiable) y solo si no lo tiene usa el
//      modelo que se puede adivinar del propio texto del equipo.
//   4) Nunca inventa datos: lo que no se pueda ligar con confianza
//      (equipo no encontrado, modelo ambiguo, o sin regla porque no hay
//      dato de periodicidad) se omite y se reporta al final, para
//      completarlo a mano desde el Panel.
//
// Se puede correr más de una vez sin problema (no duplica reglas ni
// duplica el historial de servicios: usa los mismos "find or create" que
// el resto de los scripts de este proyecto).
//
// Cómo correrlo (en tu computadora, en la carpeta del proyecto):
//   node server/scripts/importarPreventivosAgricolas.js
//
require('dotenv').config();
const pool = require('../db');
const { siguienteFolio_ } = require('../helpers');

// ------------------------------------------------------------------
// Datos extraídos de "FILTROS Y ACEITES.xlsx"
// ------------------------------------------------------------------

// Marca de cada uno de los 18 modelos que trae el archivo. "FORD" está
// como modelo Y como marca porque el archivo no distingue un modelo
// específico de tractor Ford (solo hay un bloque genérico "MODELO FORD").
const MODELO_MARCA = {
  '5415': 'JOHN DEERE', '5615': 'JOHN DEERE', '5725': 'JOHN DEERE',
  '6115D': 'JOHN DEERE', '5303': 'JOHN DEERE', '4120': 'JOHN DEERE',
  '3036-E': 'JOHN DEERE', '5075-E': 'JOHN DEERE', '3320': 'JOHN DEERE',
  '5715': 'JOHN DEERE', '5065-E': 'JOHN DEERE', '6115D AMERICANO': 'JOHN DEERE',
  '6603': 'JOHN DEERE',
  'L3800': 'KUBOTA', 'M7040': 'KUBOTA', 'M9540': 'KUBOTA', 'MX5100': 'KUBOTA',
  'FORD': 'FORD',
};

// El nombre de modelo que trae "FILTROS Y ACEITES.xlsx" (llave de
// MODELO_MARCA/REGLAS_RAW arriba) a veces NO es exactamente el nombre que
// ya existe en el Catálogo real (Maquinaria/modelos_refacciones) — por
// ejemplo, tus equipos ya tenían asignado el modelo "T-3036E", no
// "3036-E". Esto se detectó comparando la corrida real del 19/sep/2026
// contra tu base de datos (diagnosticoPreventivosAgricolas.js): el modelo
// "3036-E" existía por separado (creado antes por
// importarMarcasModelosFiltros.js, sin ningún equipo real asignado a él,
// solo con sus filtros en la tabla refacciones_modelos), mientras que
// "T-3036E" es al que SÍ apuntan tus equipos. Por eso las reglas hay que
// crearlas con el nombre real ("T-3036E"), no con el nombre del Excel.
// Si un modelo no aparece aquí, se usa tal cual la llave de MODELO_MARCA
// (significa que ese nombre coincide exacto con el Catálogo real).
const MODELO_NOMBRE_REAL = {
  '3036-E': 'T-3036E',
  '3320': 'T-3320',
  '4120': 'T-4120',
  '5065-E': 'T-5065E',
  '5075-E': 'T-5075E',
  '5303': 'T-5303',
  '5415': 'T-5415',
  '5615': 'T-5615',
  '5715': 'T-5715',
  '5725': 'T-5725',
  '6115D': 'T-6115',
  '6115D AMERICANO': 'T-6115 AMERICANO',
  '6603': 'T-6603',
  'MX5100': '5100',
};
function nombreRealModelo(modeloExcel) {
  return MODELO_NOMBRE_REAL[modeloExcel] || modeloExcel;
}

// Dos filas de "PREVENTIVOS 18092026.xlsx" traen el nombre del equipo
// escrito un poco distinto a como está en tu Catálogo real (les falta el
// "0" y el guion antes de "L3800"). Se corrige aquí para poder
// encontrarlos en Maquinaria; el resto del reporte sigue mostrando el
// texto original del Excel para que puedas ubicar la fila.
const EQUIPO_ALIAS = {
  'AF-12 L3800 KUBOTA': 'AF-012-L3800 KUBOTA',
  'AF-13 L3800 KUBOTA': 'AF-013-L3800 KUBOTA',
};

// Filtros/refacciones y litros de aceite por (modelo, tipo de preventivo).
// Clave: "MODELO|||TIPO". Mismos no_parte que ya se dieron de alta con
// importarMarcasModelosFiltros.js (se reutilizan por no_parte, no se
// duplican).
const REGLAS_RAW = {
  "5415|||PREVENTIVO MOTOR": {
    "refacciones": [
      {
        "noParte": "RE504836",
        "descripcion": "ACEITE",
        "cantidad": 1
      },
      {
        "noParte": "AT171853",
        "descripcion": "AIRE PRIMARIO",
        "cantidad": 1
      },
      {
        "noParte": "AT171854",
        "descripcion": "AIRE SECUNDARIO",
        "cantidad": 1
      },
      {
        "noParte": "RE60021",
        "descripcion": "COMBUSTIBLE",
        "cantidad": 1
      }
    ],
    "aceite_litros": 10.0
  },
  "5415|||PREVENTIVO HIDRAULICO": {
    "refacciones": [
      {
        "noParte": "RE45864",
        "descripcion": "HIDRAULICO",
        "cantidad": 1
      }
    ],
    "aceite_litros": 40.0
  },
  "5615|||PREVENTIVO MOTOR": {
    "refacciones": [
      {
        "noParte": "RE504836",
        "descripcion": "ACEITE",
        "cantidad": 1
      },
      {
        "noParte": "AT171853",
        "descripcion": "AIRE PRIMARIO",
        "cantidad": 1
      },
      {
        "noParte": "AT171854",
        "descripcion": "AIRE SECUNDARIO",
        "cantidad": 1
      },
      {
        "noParte": "RE60021",
        "descripcion": "COMBUSTIBLE",
        "cantidad": 1
      }
    ],
    "aceite_litros": 10.0
  },
  "5615|||PREVENTIVO HIDRAULICO": {
    "refacciones": [
      {
        "noParte": "RE45864",
        "descripcion": "HIDRAULICO",
        "cantidad": 1
      }
    ],
    "aceite_litros": 40.0
  },
  "5725|||PREVENTIVO MOTOR": {
    "refacciones": [
      {
        "noParte": "RE504836",
        "descripcion": "ACEITE",
        "cantidad": 1
      },
      {
        "noParte": "AT171853",
        "descripcion": "AIRE PRIMARIO",
        "cantidad": 1
      },
      {
        "noParte": "AT171854",
        "descripcion": "AIRE SECUNDARIO",
        "cantidad": 1
      },
      {
        "noParte": "RE60021",
        "descripcion": "COMBUSTIBLE",
        "cantidad": 1
      }
    ],
    "aceite_litros": 10.0
  },
  "5725|||PREVENTIVO HIDRAULICO": {
    "refacciones": [
      {
        "noParte": "RE45864",
        "descripcion": "HIDRAULICO",
        "cantidad": 1
      }
    ],
    "aceite_litros": 40.0
  },
  "L3800|||PREVENTIVO MOTOR": {
    "refacciones": [
      {
        "noParte": "HH1C0-32430",
        "descripcion": "MOTOR",
        "cantidad": 1
      },
      {
        "noParte": "6A320-59930",
        "descripcion": "DIESEL",
        "cantidad": 1
      },
      {
        "noParte": "6A320-59940",
        "descripcion": "O´RING DIESEL",
        "cantidad": 1
      },
      {
        "noParte": "6A320-59950",
        "descripcion": "O´RING DIESEL",
        "cantidad": 1
      },
      {
        "noParte": "TA040-93230",
        "descripcion": "AIRE EXTERIOR",
        "cantidad": 1
      },
      {
        "noParte": "TA040-93220",
        "descripcion": "AIRE INTERIOR",
        "cantidad": 1
      }
    ],
    "aceite_litros": 8.0
  },
  "L3800|||PREVENTIVO HIDRAULICO": {
    "refacciones": [
      {
        "noParte": "HH3A0-82623",
        "descripcion": "HIDRAULICO",
        "cantidad": 1
      }
    ],
    "aceite_litros": 20.0
  },
  "M7040|||PREVENTIVO MOTOR": {
    "refacciones": [
      {
        "noParte": "HH1C0-32430",
        "descripcion": "MOTOR",
        "cantidad": 1
      },
      {
        "noParte": "HH166-43560",
        "descripcion": "DIESEL",
        "cantidad": 1
      },
      {
        "noParte": "1G311-43380",
        "descripcion": "SEDIMENTOR",
        "cantidad": 1
      },
      {
        "noParte": "1G311-43570",
        "descripcion": "O´RING DIESEL",
        "cantidad": 1
      },
      {
        "noParte": "59800-26110",
        "descripcion": "AIRE EXTERIOR",
        "cantidad": 1
      },
      {
        "noParte": "3A111-19130",
        "descripcion": "AIRE INTERIOR",
        "cantidad": 1
      }
    ],
    "aceite_litros": 20.0
  },
  "M7040|||PREVENTIVO HIDRAULICO": {
    "refacciones": [
      {
        "noParte": "HHTA0-37710",
        "descripcion": "HIDRAULICO",
        "cantidad": 2
      }
    ],
    "aceite_litros": 60.0
  },
  "FORD|||PREVENTIVO MOTOR": {
    "refacciones": [
      {
        "noParte": "A-1",
        "descripcion": "MOTOR",
        "cantidad": 1
      },
      {
        "noParte": "F-296",
        "descripcion": "COMBUSTIBLE",
        "cantidad": 1
      }
    ],
    "aceite_litros": null
  },
  "FORD|||PREVENTIVO HIDRAULICO": {
    "refacciones": [
      {
        "noParte": "84518613",
        "descripcion": "HIDRAULICO",
        "cantidad": 1
      }
    ],
    "aceite_litros": null
  },
  "6115D|||PREVENTIVO MOTOR": {
    "refacciones": [
      {
        "noParte": "RE504836",
        "descripcion": "ACEITE",
        "cantidad": 1
      },
      {
        "noParte": "AL150288",
        "descripcion": "AIRE PRIMARIO",
        "cantidad": 1
      },
      {
        "noParte": "AL172780",
        "descripcion": "AIRE SECUNDARIO",
        "cantidad": 1
      },
      {
        "noParte": "RE526557",
        "descripcion": "COMBUSTIBLE",
        "cantidad": 1
      },
      {
        "noParte": "RE541922",
        "descripcion": "COMBUSTIBLE",
        "cantidad": 1
      }
    ],
    "aceite_litros": 15.0
  },
  "6115D|||PREVENTIVO HIDRAULICO": {
    "refacciones": [
      {
        "noParte": "SJ11792",
        "descripcion": "HIDRAULICO",
        "cantidad": 1
      }
    ],
    "aceite_litros": 60.0
  },
  "5303|||PREVENTIVO MOTOR": {
    "refacciones": [
      {
        "noParte": "T19044",
        "descripcion": "ACEITE",
        "cantidad": 1
      },
      {
        "noParte": "RE68048",
        "descripcion": "AIRE PRIMARIO",
        "cantidad": 1
      },
      {
        "noParte": "RE68049",
        "descripcion": "AIRE SECUNDARIO",
        "cantidad": 1
      },
      {
        "noParte": "RE60021",
        "descripcion": "COMBUSTIBLE",
        "cantidad": 1
      }
    ],
    "aceite_litros": 10.0
  },
  "5303|||PREVENTIVO HIDRAULICO": {
    "refacciones": [
      {
        "noParte": "RE45864",
        "descripcion": "HIDRAULICO",
        "cantidad": 1
      }
    ],
    "aceite_litros": 40.0
  },
  "4120|||PREVENTIVO MOTOR": {
    "refacciones": [
      {
        "noParte": "RE519626",
        "descripcion": "ACEITE",
        "cantidad": 1
      },
      {
        "noParte": "AP33330",
        "descripcion": "AIRE PRIMARIO",
        "cantidad": 1
      },
      {
        "noParte": "AP33331",
        "descripcion": "AIRE SECUNDARIO",
        "cantidad": 1
      },
      {
        "noParte": "LVA13038",
        "descripcion": "HIDRAULICO",
        "cantidad": 1
      }
    ],
    "aceite_litros": 8.0
  },
  "4120|||PREVENTIVO HIDRAULICO": {
    "refacciones": [
      {
        "noParte": "RE508202",
        "descripcion": "COMBUSTIBLE",
        "cantidad": 1
      }
    ],
    "aceite_litros": 40.0
  },
  "M9540|||PREVENTIVO MOTOR": {
    "refacciones": [
      {
        "noParte": "HH1C0-32430",
        "descripcion": "MOTOR",
        "cantidad": 1
      },
      {
        "noParte": "HH166-43560",
        "descripcion": "DIESEL",
        "cantidad": 1
      },
      {
        "noParte": "1G311-43380",
        "descripcion": "SEDIMENTOR",
        "cantidad": 1
      },
      {
        "noParte": "1G311-43570",
        "descripcion": "O´RING DIESEL",
        "cantidad": 1
      },
      {
        "noParte": "59700-26112",
        "descripcion": "AIRE EXTERIOR",
        "cantidad": 1
      },
      {
        "noParte": "55231-26150",
        "descripcion": "AIRE INTERIOR",
        "cantidad": 1
      },
      {
        "noParte": "6A671-75090",
        "descripcion": "AIRE CABINA",
        "cantidad": 2
      }
    ],
    "aceite_litros": 20.0
  },
  "M9540|||PREVENTIVO HIDRAULICO": {
    "refacciones": [
      {
        "noParte": "HHTA0-37710",
        "descripcion": "HIDRAULICO",
        "cantidad": 2
      }
    ],
    "aceite_litros": 60.0
  },
  "MX5100|||PREVENTIVO MOTOR": {
    "refacciones": [
      {
        "noParte": "HH1C0-32430",
        "descripcion": "MOTOR",
        "cantidad": 1
      },
      {
        "noParte": "15521-43160",
        "descripcion": "DIESEL",
        "cantidad": 1
      },
      {
        "noParte": "04811-50650",
        "descripcion": "O´RING DIESEL",
        "cantidad": 1
      },
      {
        "noParte": "04816-00160",
        "descripcion": "O´RING DIESEL",
        "cantidad": 1
      },
      {
        "noParte": "R1401-42270",
        "descripcion": "AIRE EXTERIOR",
        "cantidad": 1
      },
      {
        "noParte": "R2401-42280",
        "descripcion": "AIRE INTERIOR",
        "cantidad": 1
      }
    ],
    "aceite_litros": 8.0
  },
  "MX5100|||PREVENTIVO HIDRAULICO": {
    "refacciones": [
      {
        "noParte": "HHTA0-37710",
        "descripcion": "HIDRAULICO",
        "cantidad": 1
      }
    ],
    "aceite_litros": 20.0
  },
  "3036-E|||PREVENTIVO MOTOR": {
    "refacciones": [
      {
        "noParte": "M806419",
        "descripcion": "ACEITE",
        "cantidad": 1
      },
      {
        "noParte": "M131802",
        "descripcion": "AIRE PRIMARIO",
        "cantidad": 1
      },
      {
        "noParte": "M131803",
        "descripcion": "AIRE SECUNDARIO",
        "cantidad": 1
      },
      {
        "noParte": "MIU800645",
        "descripcion": "COMBUSTIBLE",
        "cantidad": 1
      }
    ],
    "aceite_litros": 5.0
  },
  "3036-E|||PREVENTIVO HIDRAULICO": {
    "refacciones": [
      {
        "noParte": "LVA14703",
        "descripcion": "HIDRAULICO",
        "cantidad": 1
      }
    ],
    "aceite_litros": 18.0
  },
  "5075-E|||PREVENTIVO MOTOR": {
    "refacciones": [
      {
        "noParte": "RE282286",
        "descripcion": "AIRE PRIMARIO",
        "cantidad": 1
      },
      {
        "noParte": "RE45864",
        "descripcion": "HIDRAULICO",
        "cantidad": 1
      },
      {
        "noParte": "RE519626",
        "descripcion": "ACEITE",
        "cantidad": 1
      },
      {
        "noParte": "RE60021",
        "descripcion": "COMBUSTIBLE",
        "cantidad": 1
      }
    ],
    "aceite_litros": 10.0
  },
  "5075-E|||PREVENTIVO HIDRAULICO": {
    "refacciones": [
      {
        "noParte": "RE282287",
        "descripcion": "AIRE SECUNDARIO",
        "cantidad": 1
      }
    ],
    "aceite_litros": 40.0
  },
  "3320|||PREVENTIVO MOTOR": {
    "refacciones": [
      {
        "noParte": "M806419",
        "descripcion": "ACEITE",
        "cantidad": 1
      },
      {
        "noParte": "RE68048",
        "descripcion": "AIRE PRIMARIO",
        "cantidad": 1
      },
      {
        "noParte": "RE68049",
        "descripcion": "AIRE SECUNDARIO",
        "cantidad": 1
      },
      {
        "noParte": "MIU800645",
        "descripcion": "COMBUSTIBLE",
        "cantidad": 1
      }
    ],
    "aceite_litros": 5.0
  },
  "3320|||PREVENTIVO HIDRAULICO": {
    "refacciones": [
      {
        "noParte": "LVA13065",
        "descripcion": "HIDRAULICO",
        "cantidad": 1
      }
    ],
    "aceite_litros": 40.0
  },
  "5065-E|||PREVENTIVO MOTOR": {
    "refacciones": [
      {
        "noParte": "RE60021",
        "descripcion": "COMBUSTIBLE",
        "cantidad": 1
      },
      {
        "noParte": "SU29301",
        "descripcion": "AIRE SECUNDARIO",
        "cantidad": 1
      },
      {
        "noParte": "RE519626",
        "descripcion": "MOTOR",
        "cantidad": 1
      },
      {
        "noParte": "RE45864",
        "descripcion": "HIDRAULICO",
        "cantidad": 1
      }
    ],
    "aceite_litros": 10.0
  },
  "5065-E|||PREVENTIVO HIDRAULICO": {
    "refacciones": [
      {
        "noParte": "SU29300",
        "descripcion": "AIRE PRIMARIO",
        "cantidad": 1
      }
    ],
    "aceite_litros": 40.0
  },
  "6115D AMERICANO|||PREVENTIVO MOTOR": {
    "refacciones": [
      {
        "noParte": "RE504836",
        "descripcion": "ACEITE",
        "cantidad": 1
      },
      {
        "noParte": "SU20768",
        "descripcion": "AIRE PRIMARIO",
        "cantidad": 1
      },
      {
        "noParte": "RE253519",
        "descripcion": "AIRE SECUNDARIO",
        "cantidad": 1
      },
      {
        "noParte": "RE544391",
        "descripcion": "COMBUSTIBLE",
        "cantidad": 1
      },
      {
        "noParte": "RE544394",
        "descripcion": "COMBUSTIBLE",
        "cantidad": 1
      }
    ],
    "aceite_litros": 15.0
  },
  "6115D AMERICANO|||PREVENTIVO HIDRAULICO": {
    "refacciones": [
      {
        "noParte": "SJ11792",
        "descripcion": "HIDRAULICO",
        "cantidad": 1
      }
    ],
    "aceite_litros": 60.0
  },
  "5715|||PREVENTIVO MOTOR": {
    "refacciones": [
      {
        "noParte": "RE45864",
        "descripcion": "HIDRAULICO",
        "cantidad": 1
      },
      {
        "noParte": "AT171854",
        "descripcion": "AIRE SECUNDARIO",
        "cantidad": 1
      },
      {
        "noParte": "RE60021",
        "descripcion": "COMBUSTIBLE",
        "cantidad": 1
      },
      {
        "noParte": "RE504836",
        "descripcion": "ACEITE",
        "cantidad": 1
      }
    ],
    "aceite_litros": 10.0
  },
  "5715|||PREVENTIVO HIDRAULICO": {
    "refacciones": [
      {
        "noParte": "AT171853",
        "descripcion": "AIRE PRIMARIO",
        "cantidad": 1
      }
    ],
    "aceite_litros": 40.0
  },
  "6603|||PREVENTIVO MOTOR": {
    "refacciones": [
      {
        "noParte": "RE504836",
        "descripcion": "MOTOR",
        "cantidad": 1
      },
      {
        "noParte": "RE62419",
        "descripcion": "COMBUSTIBLE",
        "cantidad": 1
      },
      {
        "noParte": "SJ11792",
        "descripcion": "HIDRAULICO",
        "cantidad": 1
      },
      {
        "noParte": "SU20768",
        "descripcion": "AIRE PRIMARIO",
        "cantidad": 1
      },
      {
        "noParte": "RE253519",
        "descripcion": "AIRE SECUNDARIO",
        "cantidad": 1
      }
    ],
    "aceite_litros": 22.0
  },
  "6603|||PREVENTIVO HIDRAULICO": {
    "refacciones": [
      {
        "noParte": "RE509208",
        "descripcion": "COMBUSTIBLE",
        "cantidad": 1
      }
    ],
    "aceite_litros": 60.0
  }
};

// Intervalo (horas) por MARCA y tipo de preventivo — tabla "PERIODICIDAD
// DE SERVICIO" del archivo. OJO: no trae dato para FORD (no hay ninguna
// fila para esa marca en esa tabla) — se reporta al final, hay que
// completarlo a mano una vez que Carlos tenga el dato.
const PERIODICIDAD = {
  "JOHN DEERE|||PREVENTIVO MOTOR": 300,
  "JOHN DEERE|||PREVENTIVO HIDRAULICO": 800,
  "KUBOTA|||PREVENTIVO MOTOR": 250,
  "KUBOTA|||PREVENTIVO HIDRAULICO": 500
};

// Excepciones de intervalo por EQUIPO específico (no por modelo): un
// equipo en particular necesita un intervalo distinto al estándar de su
// modelo. Clave: "EQUIPO (tal cual en el archivo)|||TIPO".
const INTERVALO_OVERRIDE = {
  // AF-13 L3800 KUBOTA: motor prácticamente nuevo, primer servicio a las
  // 50 horas (rodaje) en vez de las 250 horas estándar de Kubota.
  'AF-13 L3800 KUBOTA|||PREVENTIVO MOTOR': 50,
};

// Equipos que no tienen NINGÚN dato de filtros/aceite en "FILTROS Y
// ACEITES.xlsx" (modelo nuevo que no estaba en ese archivo), pero SÍ
// aparecen en "PREVENTIVOS 18092026.xlsx" con su propio historial. Para
// estos se crea una regla "cascarón" (solo con el intervalo que se ve en
// su propio historial) y se deja claramente marcada para completar
// filtros/aceite a mano después. Clave: nombre de equipo tal cual en el
// archivo -> { marca, modelo }.
const EQUIPOS_MODELO_NUEVO = {
  'AF517-416D CAT': { marca: 'CAT', modelo: '416D' },
};

// ------------------------------------------------------------------
// Datos extraídos de "PREVENTIVOS 18092026.xlsx": último servicio
// (fecha + horómetro) de cada equipo. A propósito NO se importa la
// columna "SIGUIENTE MANTENIMIENTO" del archivo: el sistema la calcula
// solo (fecha/horómetro del último servicio + intervalo de la regla),
// que es justo lo que pidió Carlos, y así no se arrastran las 5
// inconsistencias que traía esa columna en el archivo original.
// ------------------------------------------------------------------
const SERVICIOS_RAW = [
  {
    "tipo": "PREVENTIVO MOTOR",
    "equipo": "AF011-7040 KUBOTA",
    "periodicidadExcel": 250,
    "fecha": "2026-05-18",
    "ultimo": 4026
  },
  {
    "tipo": "PREVENTIVO HIDRAULICO",
    "equipo": "AF011-7040 KUBOTA",
    "periodicidadExcel": 500,
    "fecha": "2026-02-25",
    "ultimo": 3831
  },
  {
    "tipo": "PREVENTIVO MOTOR",
    "equipo": "AF306-3320 JD",
    "periodicidadExcel": 300,
    "fecha": "2023-09-01",
    "ultimo": 750
  },
  {
    "tipo": "PREVENTIVO HIDRAULICO",
    "equipo": "AF306-3320 JD",
    "periodicidadExcel": 800,
    "fecha": "2023-09-01",
    "ultimo": 770
  },
  {
    "tipo": "PREVENTIVO MOTOR",
    "equipo": "AF-307-3320 JD",
    "periodicidadExcel": 300,
    "fecha": "2026-03-28",
    "ultimo": 389
  },
  {
    "tipo": "PREVENTIVO HIDRAULICO",
    "equipo": "AF-307-3320 JD",
    "periodicidadExcel": 800,
    "fecha": "2026-03-07",
    "ultimo": 321
  },
  {
    "tipo": "PREVENTIVO MOTOR",
    "equipo": "AF311-3320 JD",
    "periodicidadExcel": 300,
    "fecha": "2026-09-03",
    "ultimo": 5435
  },
  {
    "tipo": "PREVENTIVO HIDRAULICO",
    "equipo": "AF311-3320 JD",
    "periodicidadExcel": 800,
    "fecha": "2026-09-03",
    "ultimo": 5435
  },
  {
    "tipo": "PREVENTIVO MOTOR",
    "equipo": "AF477-5615 JD",
    "periodicidadExcel": 300,
    "fecha": "2026-01-29",
    "ultimo": 16119
  },
  {
    "tipo": "PREVENTIVO HIDRAULICO",
    "equipo": "AF477-5615 JD",
    "periodicidadExcel": 800,
    "fecha": "2026-03-05",
    "ultimo": 16137
  },
  {
    "tipo": "PREVENTIVO MOTOR",
    "equipo": "AF478-5615 JD",
    "periodicidadExcel": 300,
    "fecha": "2026-09-02",
    "ultimo": 14881
  },
  {
    "tipo": "PREVENTIVO HIDRAULICO",
    "equipo": "AF478-5615 JD",
    "periodicidadExcel": 800,
    "fecha": "2025-03-21",
    "ultimo": 14012
  },
  {
    "tipo": "PREVENTIVO MOTOR",
    "equipo": "AF481-6115 JD",
    "periodicidadExcel": 300,
    "fecha": "2026-08-24",
    "ultimo": 22577
  },
  {
    "tipo": "PREVENTIVO HIDRAULICO",
    "equipo": "AF481-6115 JD",
    "periodicidadExcel": 800,
    "fecha": "2026-07-07",
    "ultimo": 22380
  },
  {
    "tipo": "PREVENTIVO MOTOR",
    "equipo": "AF499-5715 JD",
    "periodicidadExcel": 300,
    "fecha": "2026-03-11",
    "ultimo": 2368
  },
  {
    "tipo": "PREVENTIVO HIDRAULICO",
    "equipo": "AF499-5715 JD",
    "periodicidadExcel": 800,
    "fecha": "2026-02-25",
    "ultimo": 2477
  },
  {
    "tipo": "PREVENTIVO MOTOR",
    "equipo": "AF511-6115 JD",
    "periodicidadExcel": 300,
    "fecha": "2026-09-17",
    "ultimo": 20385
  },
  {
    "tipo": "PREVENTIVO HIDRAULICO",
    "equipo": "AF511-6115 JD",
    "periodicidadExcel": 800,
    "fecha": "2026-07-20",
    "ultimo": 20046
  },
  {
    "tipo": "PREVENTIVO MOTOR",
    "equipo": "AF513-3320 JD",
    "periodicidadExcel": 300,
    "fecha": "2026-09-11",
    "ultimo": 1077
  },
  {
    "tipo": "PREVENTIVO HIDRAULICO",
    "equipo": "AF513-3320 JD",
    "periodicidadExcel": 800,
    "fecha": "2025-04-08",
    "ultimo": 524
  },
  {
    "tipo": "PREVENTIVO MOTOR",
    "equipo": "AF517-416D CAT",
    "periodicidadExcel": 300,
    "fecha": "2026-04-16",
    "ultimo": 17419
  },
  {
    "tipo": "PREVENTIVO HIDRAULICO",
    "equipo": "AF517-416D CAT",
    "periodicidadExcel": 800,
    "fecha": "2026-04-16",
    "ultimo": 17419
  },
  {
    "tipo": "PREVENTIVO MOTOR",
    "equipo": "AF525-3320 JD",
    "periodicidadExcel": 300,
    "fecha": "2026-05-11",
    "ultimo": 1103
  },
  {
    "tipo": "PREVENTIVO HIDRAULICO",
    "equipo": "AF525-3320 JD",
    "periodicidadExcel": 800,
    "fecha": "2026-03-24",
    "ultimo": 1081
  },
  {
    "tipo": "PREVENTIVO MOTOR",
    "equipo": "AF-542-3320 JD",
    "periodicidadExcel": 300,
    "fecha": "2026-07-30",
    "ultimo": 9317
  },
  {
    "tipo": "PREVENTIVO HIDRAULICO",
    "equipo": "AF-542-3320 JD",
    "periodicidadExcel": 800,
    "fecha": "2026-01-14",
    "ultimo": 8908
  },
  {
    "tipo": "PREVENTIVO MOTOR",
    "equipo": "AF543-3320 JD",
    "periodicidadExcel": 300,
    "fecha": "2026-03-11",
    "ultimo": 10315
  },
  {
    "tipo": "PREVENTIVO HIDRAULICO",
    "equipo": "AF543-3320 JD",
    "periodicidadExcel": 800,
    "fecha": "2026-03-11",
    "ultimo": 10315
  },
  {
    "tipo": "PREVENTIVO MOTOR",
    "equipo": "AF-554-5725 JD",
    "periodicidadExcel": 300,
    "fecha": "2026-08-28",
    "ultimo": 1328
  },
  {
    "tipo": "PREVENTIVO HIDRAULICO",
    "equipo": "AF-554-5725 JD",
    "periodicidadExcel": 800,
    "fecha": "2026-07-17",
    "ultimo": 1049
  },
  {
    "tipo": "PREVENTIVO MOTOR",
    "equipo": "AF555-5303 JD",
    "periodicidadExcel": 300,
    "fecha": "2026-09-16",
    "ultimo": 3074
  },
  {
    "tipo": "PREVENTIVO HIDRAULICO",
    "equipo": "AF555-5303 JD",
    "periodicidadExcel": 800,
    "fecha": "2026-05-19",
    "ultimo": 2857
  },
  {
    "tipo": "PREVENTIVO MOTOR",
    "equipo": "AF571-5415 JD",
    "periodicidadExcel": 300,
    "fecha": "2026-06-10",
    "ultimo": 4875
  },
  {
    "tipo": "PREVENTIVO HIDRAULICO",
    "equipo": "AF571-5415 JD",
    "periodicidadExcel": 800,
    "fecha": "2025-12-23",
    "ultimo": 4704
  },
  {
    "tipo": "PREVENTIVO MOTOR",
    "equipo": "AF572-5415 JD",
    "periodicidadExcel": 300,
    "fecha": "2026-09-28",
    "ultimo": 10391
  },
  {
    "tipo": "PREVENTIVO HIDRAULICO",
    "equipo": "AF572-5415 JD",
    "periodicidadExcel": 800,
    "fecha": "2026-08-15",
    "ultimo": 10312
  },
  {
    "tipo": "PREVENTIVO MOTOR",
    "equipo": "AF573-5415 JD",
    "periodicidadExcel": 300,
    "fecha": "2026-06-16",
    "ultimo": 5374
  },
  {
    "tipo": "PREVENTIVO HIDRAULICO",
    "equipo": "AF573-5415 JD",
    "periodicidadExcel": 800,
    "fecha": "2026-03-27",
    "ultimo": 5236
  },
  {
    "tipo": "PREVENTIVO MOTOR",
    "equipo": "AF574-5415 JD",
    "periodicidadExcel": 300,
    "fecha": "2026-08-25",
    "ultimo": 9852
  },
  {
    "tipo": "PREVENTIVO HIDRAULICO",
    "equipo": "AF574-5415 JD",
    "periodicidadExcel": 800,
    "fecha": "2025-03-25",
    "ultimo": 9410
  },
  {
    "tipo": "PREVENTIVO MOTOR",
    "equipo": "AF575-5415 JD",
    "periodicidadExcel": 300,
    "fecha": "2026-08-13",
    "ultimo": 6089
  },
  {
    "tipo": "PREVENTIVO HIDRAULICO",
    "equipo": "AF575-5415 JD",
    "periodicidadExcel": 800,
    "fecha": "2026-03-26",
    "ultimo": 5575
  },
  {
    "tipo": "PREVENTIVO MOTOR",
    "equipo": "AF586-3036 JD",
    "periodicidadExcel": 300,
    "fecha": "2023-09-13",
    "ultimo": 229
  },
  {
    "tipo": "PREVENTIVO HIDRAULICO",
    "equipo": "AF586-3036 JD",
    "periodicidadExcel": 800,
    "fecha": "2023-09-13",
    "ultimo": 229
  },
  {
    "tipo": "PREVENTIVO MOTOR",
    "equipo": "AF-587-3036 JD",
    "periodicidadExcel": 300,
    "fecha": "2026-06-16",
    "ultimo": 1940
  },
  {
    "tipo": "PREVENTIVO HIDRAULICO",
    "equipo": "AF-587-3036 JD",
    "periodicidadExcel": 800,
    "fecha": "2025-10-31",
    "ultimo": 1641
  },
  {
    "tipo": "PREVENTIVO MOTOR",
    "equipo": "AF588-3036 JD",
    "periodicidadExcel": 300,
    "fecha": "2026-08-28",
    "ultimo": 1134
  },
  {
    "tipo": "PREVENTIVO HIDRAULICO",
    "equipo": "AF588-3036 JD",
    "periodicidadExcel": 800,
    "fecha": "2025-11-01",
    "ultimo": 782
  },
  {
    "tipo": "PREVENTIVO MOTOR",
    "equipo": "AF-590-3036 JD",
    "periodicidadExcel": 300,
    "fecha": "2026-07-16",
    "ultimo": 1953
  },
  {
    "tipo": "PREVENTIVO HIDRAULICO",
    "equipo": "AF-590-3036 JD",
    "periodicidadExcel": 800,
    "fecha": "2026-03-07",
    "ultimo": 1514
  },
  {
    "tipo": "PREVENTIVO MOTOR",
    "equipo": "AF523-5075 JD",
    "periodicidadExcel": 300,
    "fecha": null,
    "ultimo": 0
  },
  {
    "tipo": "PREVENTIVO HIDRAULICO",
    "equipo": "AF523-5075 JD",
    "periodicidadExcel": 800,
    "fecha": null,
    "ultimo": 0
  },
  {
    "tipo": "PREVENTIVO MOTOR",
    "equipo": "AF526-3320 JD",
    "periodicidadExcel": 300,
    "fecha": "2025-04-07",
    "ultimo": 7500
  },
  {
    "tipo": "PREVENTIVO HIDRAULICO",
    "equipo": "AF526-3320 JD",
    "periodicidadExcel": 800,
    "fecha": "2025-04-07",
    "ultimo": 7500
  },
  {
    "tipo": "PREVENTIVO MOTOR",
    "equipo": "AF598-L3800 KUBOTA",
    "periodicidadExcel": 250,
    "fecha": "2026-06-22",
    "ultimo": 3625
  },
  {
    "tipo": "PREVENTIVO HIDRAULICO",
    "equipo": "AF598-L3800 KUBOTA",
    "periodicidadExcel": 500,
    "fecha": null,
    "ultimo": 3553
  },
  {
    "tipo": "PREVENTIVO MOTOR",
    "equipo": "AF633-L3800 KUBOTA",
    "periodicidadExcel": 250,
    "fecha": "2026-08-14",
    "ultimo": 2748
  },
  {
    "tipo": "PREVENTIVO HIDRAULICO",
    "equipo": "AF633-L3800 KUBOTA",
    "periodicidadExcel": 500,
    "fecha": "2026-08-14",
    "ultimo": 2748
  },
  {
    "tipo": "PREVENTIVO MOTOR",
    "equipo": "AF624-7040 KUBOTA",
    "periodicidadExcel": 250,
    "fecha": "2026-08-14",
    "ultimo": 7138
  },
  {
    "tipo": "PREVENTIVO HIDRAULICO",
    "equipo": "AF624-7040 KUBOTA",
    "periodicidadExcel": 500,
    "fecha": "2026-08-14",
    "ultimo": 7138
  },
  {
    "tipo": "PREVENTIVO MOTOR",
    "equipo": "AF625-L3800 KUBOTA",
    "periodicidadExcel": 250,
    "fecha": "2026-06-01",
    "ultimo": 4156
  },
  {
    "tipo": "PREVENTIVO HIDRAULICO",
    "equipo": "AF625-L3800 KUBOTA",
    "periodicidadExcel": 500,
    "fecha": "2026-06-19",
    "ultimo": 4193
  },
  {
    "tipo": "PREVENTIVO MOTOR",
    "equipo": "FMG-01-L3800 KUBOTA",
    "periodicidadExcel": 250,
    "fecha": "2026-07-24",
    "ultimo": 3903
  },
  {
    "tipo": "PREVENTIVO HIDRAULICO",
    "equipo": "FMG-01-L3800 KUBOTA",
    "periodicidadExcel": 500,
    "fecha": "2026-07-24",
    "ultimo": 3903
  },
  {
    "tipo": "PREVENTIVO MOTOR",
    "equipo": "FMG-02-L3800 KUBOTA",
    "periodicidadExcel": 250,
    "fecha": "2026-08-24",
    "ultimo": 5114
  },
  {
    "tipo": "PREVENTIVO HIDRAULICO",
    "equipo": "FMG-02-L3800 KUBOTA",
    "periodicidadExcel": 500,
    "fecha": "2026-08-24",
    "ultimo": 5114
  },
  {
    "tipo": "PREVENTIVO MOTOR",
    "equipo": "FMG-04-L3800 KUBOTA",
    "periodicidadExcel": 250,
    "fecha": "2026-04-25",
    "ultimo": 2710
  },
  {
    "tipo": "PREVENTIVO HIDRAULICO",
    "equipo": "FMG-04-L3800 KUBOTA",
    "periodicidadExcel": 500,
    "fecha": "2026-08-25",
    "ultimo": 2876
  },
  {
    "tipo": "PREVENTIVO MOTOR",
    "equipo": "FMG-05-L3800 KUBOTA",
    "periodicidadExcel": 250,
    "fecha": "2026-06-05",
    "ultimo": 4018
  },
  {
    "tipo": "PREVENTIVO HIDRAULICO",
    "equipo": "FMG-05-L3800 KUBOTA",
    "periodicidadExcel": 500,
    "fecha": "2026-01-30",
    "ultimo": 3700
  },
  {
    "tipo": "PREVENTIVO MOTOR",
    "equipo": "AF630-L3800 KUBOTA",
    "periodicidadExcel": 250,
    "fecha": "2026-05-23",
    "ultimo": 2781
  },
  {
    "tipo": "PREVENTIVO HIDRAULICO",
    "equipo": "AF630-L3800 KUBOTA",
    "periodicidadExcel": 500,
    "fecha": "2025-12-23",
    "ultimo": 2398
  },
  {
    "tipo": "PREVENTIVO MOTOR",
    "equipo": "AF-631-L3800 KUBOTA",
    "periodicidadExcel": 250,
    "fecha": "2026-05-14",
    "ultimo": 3814
  },
  {
    "tipo": "PREVENTIVO HIDRAULICO",
    "equipo": "AF-631-L3800 KUBOTA",
    "periodicidadExcel": 500,
    "fecha": "2026-02-25",
    "ultimo": 3631
  },
  {
    "tipo": "PREVENTIVO MOTOR",
    "equipo": "AF632-L3800 KUBOTA",
    "periodicidadExcel": 300,
    "fecha": "2026-06-20",
    "ultimo": 2819
  },
  {
    "tipo": "PREVENTIVO HIDRAULICO",
    "equipo": "AF632-L3800 KUBOTA",
    "periodicidadExcel": 500,
    "fecha": "2026-08-28",
    "ultimo": 2987
  },
  {
    "tipo": "PREVENTIVO MOTOR",
    "equipo": "AF-638-L3800 KUBOTA",
    "periodicidadExcel": 250,
    "fecha": "2026-01-02",
    "ultimo": 5191
  },
  {
    "tipo": "PREVENTIVO HIDRAULICO",
    "equipo": "AF-638-L3800 KUBOTA",
    "periodicidadExcel": 500,
    "fecha": "2026-01-02",
    "ultimo": 5191
  },
  {
    "tipo": "PREVENTIVO MOTOR",
    "equipo": "AF639-L3800 KUBOTA",
    "periodicidadExcel": 250,
    "fecha": "2026-02-25",
    "ultimo": 2294
  },
  {
    "tipo": "PREVENTIVO HIDRAULICO",
    "equipo": "AF639-L3800 KUBOTA",
    "periodicidadExcel": 500,
    "fecha": "2026-02-25",
    "ultimo": 2294
  },
  {
    "tipo": "PREVENTIVO MOTOR",
    "equipo": "AF640-L3800 KUBOTA",
    "periodicidadExcel": 250,
    "fecha": "2026-09-16",
    "ultimo": 2596
  },
  {
    "tipo": "PREVENTIVO HIDRAULICO",
    "equipo": "AF640-L3800 KUBOTA",
    "periodicidadExcel": 500,
    "fecha": "2026-09-16",
    "ultimo": 2596
  },
  {
    "tipo": "PREVENTIVO MOTOR",
    "equipo": "AF641-L3800 KUBOTA",
    "periodicidadExcel": 250,
    "fecha": "2026-09-17",
    "ultimo": 2289
  },
  {
    "tipo": "PREVENTIVO HIDRAULICO",
    "equipo": "AF641-L3800 KUBOTA",
    "periodicidadExcel": 500,
    "fecha": "2026-09-17",
    "ultimo": 2289
  },
  {
    "tipo": "PREVENTIVO MOTOR",
    "equipo": "AF642-L3800 KUBOTA",
    "periodicidadExcel": 250,
    "fecha": "2026-02-25",
    "ultimo": 2414
  },
  {
    "tipo": "PREVENTIVO HIDRAULICO",
    "equipo": "AF642-L3800 KUBOTA",
    "periodicidadExcel": 500,
    "fecha": "2025-12-24",
    "ultimo": 2121
  },
  {
    "tipo": "PREVENTIVO MOTOR",
    "equipo": "AF648-6603 JD",
    "periodicidadExcel": 300,
    "fecha": "2026-09-08",
    "ultimo": 7067
  },
  {
    "tipo": "PREVENTIVO HIDRAULICO",
    "equipo": "AF648-6603 JD",
    "periodicidadExcel": 800,
    "fecha": "2026-07-14",
    "ultimo": 6733
  },
  {
    "tipo": "PREVENTIVO MOTOR",
    "equipo": "AF597-L3800 KUBOTA",
    "periodicidadExcel": 250,
    "fecha": "2026-04-11",
    "ultimo": -200
  },
  {
    "tipo": "PREVENTIVO HIDRAULICO",
    "equipo": "AF597-L3800 KUBOTA",
    "periodicidadExcel": 500,
    "fecha": "2026-01-30",
    "ultimo": -200
  },
  {
    "tipo": "PREVENTIVO MOTOR",
    "equipo": "AF004-L3800 KUBOTA",
    "periodicidadExcel": 250,
    "fecha": "2026-07-15",
    "ultimo": 4274
  },
  {
    "tipo": "PREVENTIVO HIDRAULICO",
    "equipo": "AF004-L3800 KUBOTA",
    "periodicidadExcel": 500,
    "fecha": "2026-08-24",
    "ultimo": 4389
  },
  {
    "tipo": "PREVENTIVO MOTOR",
    "equipo": "AF-017-9540 KUBOTA",
    "periodicidadExcel": 250,
    "fecha": "2026-09-11",
    "ultimo": 6321
  },
  {
    "tipo": "PREVENTIVO HIDRAULICO",
    "equipo": "AF-017-9540 KUBOTA",
    "periodicidadExcel": 500,
    "fecha": "2026-08-06",
    "ultimo": 6152
  },
  {
    "tipo": "PREVENTIVO MOTOR",
    "equipo": "AF030-L3800 KUBOTA",
    "periodicidadExcel": 250,
    "fecha": "2026-06-19",
    "ultimo": 2540
  },
  {
    "tipo": "PREVENTIVO HIDRAULICO",
    "equipo": "AF030-L3800 KUBOTA",
    "periodicidadExcel": 500,
    "fecha": "2026-05-17",
    "ultimo": 2451
  },
  {
    "tipo": "PREVENTIVO MOTOR",
    "equipo": "AF027-7040 KUBOTA",
    "periodicidadExcel": 250,
    "fecha": "2026-01-27",
    "ultimo": 0
  },
  {
    "tipo": "PREVENTIVO HIDRAULICO",
    "equipo": "AF027-7040 KUBOTA",
    "periodicidadExcel": 500,
    "fecha": "2026-01-27",
    "ultimo": 3373
  },
  {
    "tipo": "PREVENTIVO MOTOR",
    "equipo": "AF029-7040 KUBOTA",
    "periodicidadExcel": 250,
    "fecha": "2026-08-14",
    "ultimo": 6111
  },
  {
    "tipo": "PREVENTIVO HIDRAULICO",
    "equipo": "AF029-7040 KUBOTA",
    "periodicidadExcel": 500,
    "fecha": "2026-08-14",
    "ultimo": 6111
  },
  {
    "tipo": "PREVENTIVO MOTOR",
    "equipo": "AF026-7040 KUBOTA",
    "periodicidadExcel": 250,
    "fecha": "2026-08-10",
    "ultimo": 5565
  },
  {
    "tipo": "PREVENTIVO HIDRAULICO",
    "equipo": "AF026-7040 KUBOTA",
    "periodicidadExcel": 500,
    "fecha": "2026-08-14",
    "ultimo": 5603
  },
  {
    "tipo": "PREVENTIVO MOTOR",
    "equipo": "AF-028-L3800 KUBOTA",
    "periodicidadExcel": 250,
    "fecha": "2026-06-13",
    "ultimo": 3298
  },
  {
    "tipo": "PREVENTIVO HIDRAULICO",
    "equipo": "AF-028-L3800 KUBOTA",
    "periodicidadExcel": 500,
    "fecha": "2025-11-25",
    "ultimo": 3087
  },
  {
    "tipo": "PREVENTIVO MOTOR",
    "equipo": "AF016-L3800 KUBOTA",
    "periodicidadExcel": 250,
    "fecha": "2026-08-12",
    "ultimo": 2982
  },
  {
    "tipo": "PREVENTIVO HIDRAULICO",
    "equipo": "AF016-L3800 KUBOTA",
    "periodicidadExcel": 500,
    "fecha": "2026-04-27",
    "ultimo": 2828
  },
  {
    "tipo": "PREVENTIVO MOTOR",
    "equipo": "AF023-5100 KUBOTA",
    "periodicidadExcel": 250,
    "fecha": "2026-03-09",
    "ultimo": 4211
  },
  {
    "tipo": "PREVENTIVO HIDRAULICO",
    "equipo": "AF023-5100 KUBOTA",
    "periodicidadExcel": 500,
    "fecha": "2026-03-14",
    "ultimo": 4213
  },
  {
    "tipo": "PREVENTIVO MOTOR",
    "equipo": "AF-034-L3800 KUBOTA",
    "periodicidadExcel": 250,
    "fecha": "2026-06-19",
    "ultimo": 2851
  },
  {
    "tipo": "PREVENTIVO HIDRAULICO",
    "equipo": "AF-034-L3800 KUBOTA",
    "periodicidadExcel": 500,
    "fecha": "2026-03-10",
    "ultimo": 2675
  },
  {
    "tipo": "PREVENTIVO MOTOR",
    "equipo": "AF-001-5065E JD",
    "periodicidadExcel": 300,
    "fecha": "2026-03-11",
    "ultimo": 4150
  },
  {
    "tipo": "PREVENTIVO HIDRAULICO",
    "equipo": "AF-001-5065E JD",
    "periodicidadExcel": 800,
    "fecha": "2026-03-11",
    "ultimo": 4150
  },
  {
    "tipo": "PREVENTIVO MOTOR",
    "equipo": "AF003-L3800 KUBOTA",
    "periodicidadExcel": 250,
    "fecha": "2026-08-05",
    "ultimo": 2765
  },
  {
    "tipo": "PREVENTIVO HIDRAULICO",
    "equipo": "AF003-L3800 KUBOTA",
    "periodicidadExcel": 500,
    "fecha": "2026-08-05",
    "ultimo": 2765
  },
  {
    "tipo": "PREVENTIVO MOTOR",
    "equipo": "AF-031-L3800 KUBOTA",
    "periodicidadExcel": 250,
    "fecha": "2026-04-16",
    "ultimo": 3303
  },
  {
    "tipo": "PREVENTIVO HIDRAULICO",
    "equipo": "AF-031-L3800 KUBOTA",
    "periodicidadExcel": 500,
    "fecha": "2025-12-24",
    "ultimo": 3184
  },
  {
    "tipo": "PREVENTIVO MOTOR",
    "equipo": "AF032-L3800 KUBOTA",
    "periodicidadExcel": 250,
    "fecha": "2026-09-15",
    "ultimo": 3493
  },
  {
    "tipo": "PREVENTIVO HIDRAULICO",
    "equipo": "AF032-L3800 KUBOTA",
    "periodicidadExcel": 500,
    "fecha": "2026-06-30",
    "ultimo": 3321
  },
  {
    "tipo": "PREVENTIVO MOTOR",
    "equipo": "AF-600-7040 KUBOTA",
    "periodicidadExcel": 250,
    "fecha": "2026-04-27",
    "ultimo": 5926
  },
  {
    "tipo": "PREVENTIVO HIDRAULICO",
    "equipo": "AF-600-7040 KUBOTA",
    "periodicidadExcel": 500,
    "fecha": "2026-04-27",
    "ultimo": 5926
  },
  {
    "tipo": "PREVENTIVO MOTOR",
    "equipo": "AF602-M7040 KUBOTA",
    "periodicidadExcel": 250,
    "fecha": "2026-08-08",
    "ultimo": 8880
  },
  {
    "tipo": "PREVENTIVO HIDRAULICO",
    "equipo": "AF602-M7040 KUBOTA",
    "periodicidadExcel": 500,
    "fecha": "2026-08-17",
    "ultimo": 8895
  },
  {
    "tipo": "PREVENTIVO MOTOR",
    "equipo": "AF-719 L3800 KUBOTA",
    "periodicidadExcel": 250,
    "fecha": "2026-05-11",
    "ultimo": 1250
  },
  {
    "tipo": "PREVENTIVO HIDRAULICO",
    "equipo": "AF-719 L3800 KUBOTA",
    "periodicidadExcel": 500,
    "fecha": "2025-12-03",
    "ultimo": 1026
  },
  {
    "tipo": "PREVENTIVO MOTOR",
    "equipo": "AF-720 L3800 KUBOTA",
    "periodicidadExcel": 250,
    "fecha": "2026-07-14",
    "ultimo": 1500
  },
  {
    "tipo": "PREVENTIVO HIDRAULICO",
    "equipo": "AF-720 L3800 KUBOTA",
    "periodicidadExcel": 500,
    "fecha": "2026-07-14",
    "ultimo": 1500
  },
  {
    "tipo": "PREVENTIVO MOTOR",
    "equipo": "AF-721-L3800 KUBOTA",
    "periodicidadExcel": 250,
    "fecha": "2026-08-31",
    "ultimo": 1750
  },
  {
    "tipo": "PREVENTIVO HIDRAULICO",
    "equipo": "AF-721-L3800 KUBOTA",
    "periodicidadExcel": 500,
    "fecha": "2026-05-30",
    "ultimo": 1500
  },
  {
    "tipo": "PREVENTIVO MOTOR",
    "equipo": "AF731-6603 JD",
    "periodicidadExcel": 300,
    "fecha": "2026-08-12",
    "ultimo": 2981
  },
  {
    "tipo": "PREVENTIVO HIDRAULICO",
    "equipo": "AF731-6603 JD",
    "periodicidadExcel": 800,
    "fecha": "2026-08-12",
    "ultimo": 2981
  },
  {
    "tipo": "PREVENTIVO MOTOR",
    "equipo": "AF-723 L3800 KUBOTA",
    "periodicidadExcel": 250,
    "fecha": "2026-09-18",
    "ultimo": 1726
  },
  {
    "tipo": "PREVENTIVO HIDRAULICO",
    "equipo": "AF-723 L3800 KUBOTA",
    "periodicidadExcel": 500,
    "fecha": "2026-07-14",
    "ultimo": 1500
  },
  {
    "tipo": "PREVENTIVO MOTOR",
    "equipo": "AF-725-L3800 KUBOTA",
    "periodicidadExcel": 250,
    "fecha": "2026-08-05",
    "ultimo": 1500
  },
  {
    "tipo": "PREVENTIVO HIDRAULICO",
    "equipo": "AF-725-L3800 KUBOTA",
    "periodicidadExcel": 500,
    "fecha": "2026-08-05",
    "ultimo": 1500
  },
  {
    "tipo": "PREVENTIVO MOTOR",
    "equipo": "AF-724 L3800 KUBOTA",
    "periodicidadExcel": 250,
    "fecha": "2026-07-14",
    "ultimo": 1000
  },
  {
    "tipo": "PREVENTIVO HIDRAULICO",
    "equipo": "AF-724 L3800 KUBOTA",
    "periodicidadExcel": 500,
    "fecha": "2026-07-14",
    "ultimo": 1000
  },
  {
    "tipo": "PREVENTIVO MOTOR",
    "equipo": "AF-726 L3800 KUBOTA",
    "periodicidadExcel": 250,
    "fecha": "2026-09-18",
    "ultimo": 1968
  },
  {
    "tipo": "PREVENTIVO HIDRAULICO",
    "equipo": "AF-726 L3800 KUBOTA",
    "periodicidadExcel": 500,
    "fecha": "2026-09-18",
    "ultimo": 1968
  },
  {
    "tipo": "PREVENTIVO MOTOR",
    "equipo": "AF-722 L3800 KUBOTA",
    "periodicidadExcel": 250,
    "fecha": "2026-06-10",
    "ultimo": 1250
  },
  {
    "tipo": "PREVENTIVO HIDRAULICO",
    "equipo": "AF-722 L3800 KUBOTA",
    "periodicidadExcel": 500,
    "fecha": "2026-03-20",
    "ultimo": 1000
  },
  {
    "tipo": "PREVENTIVO MOTOR",
    "equipo": "AF-727 L3800 KUBOTA",
    "periodicidadExcel": 250,
    "fecha": "2026-08-06",
    "ultimo": 1250
  },
  {
    "tipo": "PREVENTIVO HIDRAULICO",
    "equipo": "AF-727 L3800 KUBOTA",
    "periodicidadExcel": 500,
    "fecha": "2026-03-20",
    "ultimo": 1000
  },
  {
    "tipo": "PREVENTIVO MOTOR",
    "equipo": "AF-728 L3800 KUBOTA",
    "periodicidadExcel": 250,
    "fecha": "2026-09-15",
    "ultimo": 1571
  },
  {
    "tipo": "PREVENTIVO HIDRAULICO",
    "equipo": "AF-728 L3800 KUBOTA",
    "periodicidadExcel": 500,
    "fecha": "2026-09-15",
    "ultimo": 1571
  },
  {
    "tipo": "PREVENTIVO MOTOR",
    "equipo": "AF-729 L3800 KUBOTA",
    "periodicidadExcel": 250,
    "fecha": "2026-05-11",
    "ultimo": 1250
  },
  {
    "tipo": "PREVENTIVO HIDRAULICO",
    "equipo": "AF-729 L3800 KUBOTA",
    "periodicidadExcel": 500,
    "fecha": "2026-01-26",
    "ultimo": 960
  },
  {
    "tipo": "PREVENTIVO MOTOR",
    "equipo": "AF-730 L3800 KUBOTA",
    "periodicidadExcel": 250,
    "fecha": "2026-08-05",
    "ultimo": 1750
  },
  {
    "tipo": "PREVENTIVO HIDRAULICO",
    "equipo": "AF-730 L3800 KUBOTA",
    "periodicidadExcel": 500,
    "fecha": "2026-07-07",
    "ultimo": 1661
  },
  {
    "tipo": "PREVENTIVO MOTOR",
    "equipo": "AF-12 L3800 KUBOTA",
    "periodicidadExcel": 250,
    "fecha": "2026-09-11",
    "ultimo": 50
  },
  {
    "tipo": "PREVENTIVO HIDRAULICO",
    "equipo": "AF-12 L3800 KUBOTA",
    "periodicidadExcel": 500,
    "fecha": null,
    "ultimo": 0
  },
  {
    "tipo": "PREVENTIVO MOTOR",
    "equipo": "AF-13 L3800 KUBOTA",
    "periodicidadExcel": 50,
    "fecha": null,
    "ultimo": 0
  },
  {
    "tipo": "PREVENTIVO HIDRAULICO",
    "equipo": "AF-13 L3800 KUBOTA",
    "periodicidadExcel": 500,
    "fecha": null,
    "ultimo": 0
  }
];

// ------------------------------------------------------------------
// Utilidades de texto (para adivinar el modelo a partir del texto del
// equipo, SOLO como respaldo cuando el equipo no tiene modelo_id
// asignado todavía en Maquinaria/Catálogo).
// ------------------------------------------------------------------
function norm(s) {
  return (s || '').toString().trim().toUpperCase();
}
function normSinEspacios(s) {
  return norm(s).replace(/[\s-]/g, '');
}
function soloDigitos(s) {
  return norm(s).replace(/\D/g, '');
}
function extraerTokenModelo(equipoTexto) {
  let s = norm(equipoTexto);
  s = s.replace(/\s+(JD|KUBOTA|CAT|FORD|JOHN\s*DEERE)\s*$/i, '');
  const parts = s.split(/[\s-]+/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : s;
}

const MODELOS_CONOCIDOS = Object.keys(MODELO_MARCA);
const MODELOS_NORM = new Map(MODELOS_CONOCIDOS.map((m) => [normSinEspacios(m), m]));
const MODELOS_POR_DIGITOS = new Map();
MODELOS_CONOCIDOS.forEach((m) => {
  const d = soloDigitos(m);
  if (!d) return;
  if (!MODELOS_POR_DIGITOS.has(d)) MODELOS_POR_DIGITOS.set(d, []);
  MODELOS_POR_DIGITOS.get(d).push(m);
});

// Regresa { modelo, motivo } o null si no se pudo adivinar con confianza
// (ambiguo o sin match). `motivo` es solo para el reporte final.
function adivinarModeloPorTexto(equipoTexto) {
  const core = extraerTokenModelo(equipoTexto);
  const coreN = normSinEspacios(core);
  if (MODELOS_NORM.has(coreN)) {
    return { modelo: MODELOS_NORM.get(coreN), motivo: 'texto (match exacto: "' + core + '")' };
  }
  const coreD = soloDigitos(core);
  if (coreD && MODELOS_POR_DIGITOS.has(coreD)) {
    const cands = MODELOS_POR_DIGITOS.get(coreD);
    if (cands.length === 1) {
      return { modelo: cands[0], motivo: 'texto (match por número: "' + core + '" -> ' + cands[0] + ')' };
    }
    return null; // ambiguo
  }
  return null;
}

// ------------------------------------------------------------------
// Find-or-create (mismo patrón que importarMarcasModelosFiltros.js)
// ------------------------------------------------------------------
async function obtenerOCrearMarca(nombre, cache) {
  if (cache.has(nombre)) return cache.get(nombre);
  const [existentes] = await pool.query('SELECT id FROM marcas_refacciones WHERE nombre = ? LIMIT 1', [nombre]);
  if (existentes.length > 0) {
    cache.set(nombre, existentes[0].id);
    return existentes[0].id;
  }
  const [result] = await pool.query('INSERT INTO marcas_refacciones (nombre) VALUES (?)', [nombre]);
  console.log('Marca creada: "' + nombre + '" (id ' + result.insertId + ').');
  cache.set(nombre, result.insertId);
  return result.insertId;
}

async function obtenerOCrearModelo(marcaId, nombre, cache) {
  const key = marcaId + '|' + nombre;
  if (cache.has(key)) return cache.get(key);
  const [existentes] = await pool.query(
    'SELECT id FROM modelos_refacciones WHERE marca_id = ? AND nombre = ? LIMIT 1',
    [marcaId, nombre]
  );
  if (existentes.length > 0) {
    cache.set(key, existentes[0].id);
    return existentes[0].id;
  }
  const [result] = await pool.query(
    'INSERT INTO modelos_refacciones (marca_id, nombre) VALUES (?, ?)',
    [marcaId, nombre]
  );
  console.log('  Modelo creado: "' + nombre + '" (id ' + result.insertId + ').');
  cache.set(key, result.insertId);
  return result.insertId;
}

async function obtenerOCrearRefaccion(noParte, descripcion, marcaId) {
  const [existentes] = await pool.query(
    'SELECT id, descripcion, marca_id FROM refacciones WHERE LOWER(TRIM(no_parte)) = LOWER(TRIM(?)) LIMIT 1',
    [noParte]
  );
  if (existentes.length > 0) {
    const ex = existentes[0];
    if (ex.marca_id !== marcaId) {
      await pool.query('UPDATE refacciones SET marca_id = ? WHERE id = ?', [marcaId, ex.id]);
    }
    return ex.id;
  }
  const codigo = await siguienteFolio_(pool, 'refaccion', 'REF', 5);
  const [result] = await pool.query(
    'INSERT INTO refacciones (codigo, no_parte, descripcion, precio, proveedor_id, categoria_id, marca_id) VALUES (?, ?, ?, NULL, NULL, NULL, ?)',
    [codigo, noParte, descripcion, marcaId]
  );
  console.log('  Refacción creada: ' + codigo + ' — "' + noParte + '" — "' + descripcion + '" (id ' + result.insertId + ').');
  return result.insertId;
}

async function obtenerOCrearTipoPreventivo(nombre, cache) {
  if (cache.has(nombre)) return cache.get(nombre);
  const [existentes] = await pool.query('SELECT id FROM tipos_preventivo WHERE nombre = ? LIMIT 1', [nombre]);
  if (existentes.length === 0) {
    throw new Error('No existe el tipo de preventivo "' + nombre + '" — corre primero server/scripts/aplicarSchema.js.');
  }
  cache.set(nombre, existentes[0].id);
  return existentes[0].id;
}

// Crea o actualiza la regla (modelo_id, tipo_preventivo_id) y sincroniza
// sus refacciones asignadas. Regresa el id de la regla.
async function guardarRegla(modeloId, tipoPreventivoId, nombreServicio, intervalo, aceiteLitros, refacciones) {
  const [existentes] = await pool.query(
    'SELECT id FROM mantenimiento_reglas WHERE modelo_id = ? AND tipo_preventivo_id = ? LIMIT 1',
    [modeloId, tipoPreventivoId]
  );
  let reglaId;
  if (existentes.length > 0) {
    reglaId = existentes[0].id;
    await pool.query(
      `UPDATE mantenimiento_reglas
       SET nombre_servicio=?, tipo_periodicidad='horas', intervalo=?, aceite_litros=?, activo=1
       WHERE id=?`,
      [nombreServicio, intervalo, aceiteLitros, reglaId]
    );
  } else {
    const [result] = await pool.query(
      `INSERT INTO mantenimiento_reglas
        (codigo_unidad, modelo_id, tipo_preventivo_id, nombre_servicio, tipo_periodicidad, intervalo, aceite_litros, activo)
       VALUES (NULL, ?, ?, ?, 'horas', ?, ?, 1)`,
      [modeloId, tipoPreventivoId, nombreServicio, intervalo, aceiteLitros]
    );
    reglaId = result.insertId;
    console.log('  Regla creada (id ' + reglaId + ').');
  }

  await pool.query('DELETE FROM mantenimiento_regla_refacciones WHERE regla_id = ?', [reglaId]);
  for (const r of refacciones) {
    await pool.query(
      'INSERT INTO mantenimiento_regla_refacciones (regla_id, refaccion_id, cantidad) VALUES (?, ?, ?)',
      [reglaId, r.refaccionId, r.cantidad]
    );
  }
  return reglaId;
}

async function main() {
  const marcaCache = new Map();
  const modeloCache = new Map();
  const tipoCache = new Map();
  // reglasPorModeloTipo: "modeloId|||tipoNombre" -> { reglaId, modeloId }
  const reglasPorModeloTipo = new Map();
  const avisos = [];

  console.log('--- 1) Marcas, modelos y reglas por modelo (FILTROS Y ACEITES.xlsx) ---');
  for (const modelo of Object.keys(MODELO_MARCA)) {
    const marcaNombre = MODELO_MARCA[modelo];
    const marcaId = await obtenerOCrearMarca(marcaNombre, marcaCache);
    const modeloId = await obtenerOCrearModelo(marcaId, nombreRealModelo(modelo), modeloCache);

    for (const tipoNombre of ['PREVENTIVO MOTOR', 'PREVENTIVO HIDRAULICO']) {
      const tipoPreventivoId = await obtenerOCrearTipoPreventivo(tipoNombre, tipoCache);
      const intervalo = PERIODICIDAD[marcaNombre + '|||' + tipoNombre];
      const datos = REGLAS_RAW[modelo + '|||' + tipoNombre] || { refacciones: [], aceite_litros: null };

      if (!intervalo) {
        avisos.push(
          'SIN INTERVALO: ' + marcaNombre + ' ' + modelo + ' — ' + tipoNombre +
          ' no tiene periodicidad en el archivo (tabla "PERIODICIDAD DE SERVICIO" no trae dato para ' +
          marcaNombre + '). No se creó la regla; los filtros que sí venían en el archivo son: ' +
          (datos.refacciones.map((r) => r.noParte + ' (' + r.descripcion + ')').join(', ') || 'ninguno') +
          (datos.aceite_litros ? '; aceite: ' + datos.aceite_litros + ' L' : '') +
          '. Complétalo a mano desde el Panel (Preventivos Agrícolas > Reglas) cuando tengas el dato.'
        );
        continue;
      }

      const refacciones = [];
      for (const r of datos.refacciones) {
        const id = await obtenerOCrearRefaccion(r.noParte, r.descripcion, marcaId);
        refacciones.push({ refaccionId: id, cantidad: Number(r.cantidad) || 1 });
      }

      const reglaId = await guardarRegla(modeloId, tipoPreventivoId, tipoNombre, intervalo, datos.aceite_litros, refacciones);
      reglasPorModeloTipo.set(modeloId + '|||' + tipoNombre, reglaId);
      console.log('  ' + marcaNombre + ' ' + modelo + ' — ' + tipoNombre + ': intervalo ' + intervalo + 'h, ' + refacciones.length + ' refaccion(es)' + (datos.aceite_litros ? ', aceite ' + datos.aceite_litros + 'L' : '') + '.');
    }
  }

  console.log('');
  console.log('--- 2) Modelos nuevos sin datos de filtros/aceite (solo aparecen en PREVENTIVOS 18092026.xlsx) ---');
  for (const equipoTexto of Object.keys(EQUIPOS_MODELO_NUEVO)) {
    const { marca: marcaNombre, modelo } = EQUIPOS_MODELO_NUEVO[equipoTexto];
    const marcaId = await obtenerOCrearMarca(marcaNombre, marcaCache);
    const modeloId = await obtenerOCrearModelo(marcaId, modelo, modeloCache);
    for (const fila of SERVICIOS_RAW.filter((f) => f.equipo === equipoTexto)) {
      const tipoPreventivoId = await obtenerOCrearTipoPreventivo(fila.tipo, tipoCache);
      const key = modeloId + '|||' + fila.tipo;
      if (reglasPorModeloTipo.has(key)) continue;
      const reglaId = await guardarRegla(modeloId, tipoPreventivoId, fila.tipo, fila.periodicidadExcel, null, []);
      reglasPorModeloTipo.set(key, reglaId);
      avisos.push(
        'REGLA INCOMPLETA: ' + marcaNombre + ' ' + modelo + ' (equipo ' + equipoTexto + ') — ' + fila.tipo +
        ': se creó la regla con intervalo ' + fila.periodicidadExcel + 'h (tomado de su propio historial), ' +
        'pero "FILTROS Y ACEITES.xlsx" no traía ningún dato de filtros/aceite para este modelo. ' +
        'Complétalo a mano desde el Panel (Preventivos Agrícolas > Reglas).'
      );
      console.log('  ' + marcaNombre + ' ' + modelo + ' — ' + fila.tipo + ': intervalo ' + fila.periodicidadExcel + 'h (cascarón, sin filtros/aceite).');
    }
  }

  console.log('');
  console.log('--- 3) Historial de servicios por equipo (PREVENTIVOS 18092026.xlsx) ---');
  const [maquinaria] = await pool.query('SELECT codigo_unidad AS CodigoUnidad, unidad AS Unidad, modelo_id AS ModeloId FROM maquinaria');
  const maquinariaPorUnidadNorm = new Map();
  maquinaria.forEach((m) => {
    if (m.Unidad) maquinariaPorUnidadNorm.set(normSinEspacios(m.Unidad), m);
  });

  // OJO IMPORTANTE: la pestaña "Servicios" del Panel solo muestra un
  // equipo si ese equipo YA tiene marca/modelo asignados en Maquinaria/
  // Catálogo (así sabe a qué regla de modelo pertenece — ver
  // getServiciosMantenimiento en handlers.js). Si un equipo se resuelve
  // aquí por texto (no porque ya tuviera modelo_id), se le asigna ese
  // mismo marca/modelo en Maquinaria de una vez: si no, el historial que
  // se importa quedaría "guardado" pero invisible en la pestaña Servicios
  // hasta que alguien lo vinculara a mano después.
  const yaVinculados = new Set();
  let ligados = 0;
  let omitidos = 0;
  let equiposVinculados = 0;
  for (const fila of SERVICIOS_RAW) {
    const textoEquipoBusqueda = EQUIPO_ALIAS[fila.equipo] || fila.equipo;
    const equipo = maquinariaPorUnidadNorm.get(normSinEspacios(textoEquipoBusqueda));
    if (!equipo) {
      avisos.push('OMITIDO (equipo no encontrado en Maquinaria): "' + fila.equipo + '" — ' + fila.tipo + '.');
      omitidos++;
      continue;
    }

    let modeloId = null;
    let marcaIdResuelta = null;
    let origenModelo = '';
    if (equipo.ModeloId) {
      modeloId = equipo.ModeloId;
      origenModelo = 'modelo_id ya asignado en Catálogo';
    } else if (EQUIPOS_MODELO_NUEVO[fila.equipo]) {
      // Caso conocido (ver EQUIPOS_MODELO_NUEVO arriba): equipo sin
      // modelo_id todavía, pero su modelo/marca ya se identificaron a mano
      // porque no estaban en ningún catálogo previo.
      const { marca: marcaNombre, modelo: modeloNombre } = EQUIPOS_MODELO_NUEVO[fila.equipo];
      marcaIdResuelta = marcaCache.get(marcaNombre);
      modeloId = marcaIdResuelta ? modeloCache.get(marcaIdResuelta + '|' + modeloNombre) : null;
      origenModelo = 'modelo nuevo identificado a mano (' + marcaNombre + ' ' + modeloNombre + ')';
    } else {
      const adivinado = adivinarModeloPorTexto(fila.equipo);
      if (!adivinado) {
        avisos.push(
          'OMITIDO (sin modelo_id en Catálogo y no se pudo adivinar el modelo por el texto, o es ambiguo): "' +
          fila.equipo + '" — ' + fila.tipo + '.'
        );
        omitidos++;
        continue;
      }
      const marcaNombre = MODELO_MARCA[adivinado.modelo];
      marcaIdResuelta = marcaCache.get(marcaNombre);
      modeloId = marcaIdResuelta ? modeloCache.get(marcaIdResuelta + '|' + nombreRealModelo(adivinado.modelo)) : null;
      origenModelo = adivinado.motivo;
    }

    if (!modeloId) {
      avisos.push('OMITIDO (no se pudo determinar el modelo en el catálogo): "' + fila.equipo + '" — ' + fila.tipo + '.');
      omitidos++;
      continue;
    }

    const reglaId = reglasPorModeloTipo.get(modeloId + '|||' + fila.tipo);
    if (!reglaId) {
      avisos.push(
        'OMITIDO (el modelo de este equipo no tiene regla creada, normalmente porque falta el dato de intervalo — ver avisos arriba): "' +
        fila.equipo + '" — ' + fila.tipo + '.'
      );
      omitidos++;
      continue;
    }

    // Si el modelo se resolvió por texto (no porque el equipo ya tuviera
    // modelo_id en Catálogo), lo vincula ahora — una sola vez por equipo,
    // aunque tenga 2 filas (motor + hidráulico) — para que aparezca en la
    // pestaña Servicios.
    if (!equipo.ModeloId && !yaVinculados.has(equipo.CodigoUnidad)) {
      await pool.query('UPDATE maquinaria SET marca_id = ?, modelo_id = ? WHERE codigo_unidad = ?', [marcaIdResuelta, modeloId, equipo.CodigoUnidad]);
      yaVinculados.add(equipo.CodigoUnidad);
      equiposVinculados++;
      avisos.push(
        'VINCULADO EN CATÁLOGO: "' + fila.equipo + '" (' + equipo.CodigoUnidad + ') no tenía marca/modelo asignados en Maquinaria — se le asignaron automáticamente (' + origenModelo + ') para que aparezca en la pestaña Servicios. Verifícalo desde Maquinaria/Catálogo si quieres confirmarlo.'
      );
    }

    const overrideKey = fila.equipo + '|||' + fila.tipo;
    const intervaloOverride = Object.prototype.hasOwnProperty.call(INTERVALO_OVERRIDE, overrideKey) ? INTERVALO_OVERRIDE[overrideKey] : null;

    await pool.query(
      `INSERT INTO mantenimiento_servicios (regla_id, codigo_unidad, ultima_lectura, ultima_fecha, intervalo_override)
       VALUES (?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
        ultima_lectura = VALUES(ultima_lectura), ultima_fecha = VALUES(ultima_fecha),
        intervalo_override = VALUES(intervalo_override)`,
      [reglaId, equipo.CodigoUnidad, fila.ultimo, fila.fecha, intervaloOverride]
    );
    ligados++;
    console.log('  ' + fila.equipo + ' (' + equipo.CodigoUnidad + ') — ' + fila.tipo + ': último ' + fila.ultimo + 'h el ' + fila.fecha + (intervaloOverride ? ' [intervalo propio: ' + intervaloOverride + 'h]' : '') + ' [' + origenModelo + '].');
  }

  console.log('');
  console.log('=== RESUMEN ===');
  console.log('Servicios ligados correctamente: ' + ligados + ' de ' + SERVICIOS_RAW.length);
  console.log('Equipos vinculados automáticamente en Catálogo (no tenían marca/modelo): ' + equiposVinculados);
  console.log('Omitidos (necesitan revisión manual): ' + omitidos);
  if (avisos.length > 0) {
    console.log('');
    console.log('=== AVISOS (revisar y completar a mano desde el Panel) ===');
    avisos.forEach((a, i) => console.log((i + 1) + '. ' + a));
  }

  await pool.end();
}

main().catch((err) => {
  console.error('Error:', err);
  process.exit(1);
});
