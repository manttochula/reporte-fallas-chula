// Integración con la API de Anthropic (Claude) para leer, usando visión, la
// foto de una bitácora de diesel llenada a mano y devolver los datos como
// JSON. Se usa desde leerBitacoraDiesel() en handlers.js.
//
// Requiere que el administrador configure su PROPIA llave de API en el
// archivo .env del proyecto:
//
//   ANTHROPIC_API_KEY=sk-ant-...
//
// Esa llave se obtiene en https://console.anthropic.com (Anthropic no es la
// misma empresa dueña de este código; es el proveedor de la IA). Tiene un
// costo pequeño (unos cuantos centavos de dólar) por cada foto que se
// procese. Opcionalmente se puede fijar qué modelo usar con:
//
//   ANTHROPIC_MODEL=claude-sonnet-5
//
// Si no se configura ANTHROPIC_MODEL se usa un valor por default; si ese
// modelo llegara a dejar de estar disponible (la API responde 404), el
// mensaje de error indica cómo cambiarlo.
require('dotenv').config();

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || '';
const ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-5';
const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';

// Leer una foto de bitácora (varios renglones escritos a mano) le toma a la
// IA bastante más que un texto corto, y a eso hay que sumarle lo que tarde
// la computadora en SUBIR la imagen si la conexión a internet es lenta. 30
// segundos se quedaba corto y tronaba con "se agotó el tiempo de espera" en
// cargas que en realidad solo iban lentas, no bloqueadas — se subió a 90,
// pero con max_tokens más alto (ver más abajo, necesario para que no se
// corte "pensando" antes de escribir la respuesta en fotos con varios
// renglones) la IA también tarda más en generar la respuesta completa, así
// que 90 s se volvió a quedar corto — se sube a 180 (3 min).
const ANTHROPIC_TIMEOUT_MS = 180000;

/**
 * Envía un arreglo de "content blocks" (mezcla de bloques de imagen y texto,
 * en el formato que espera la API de Mensajes de Anthropic) a Claude y
 * regresa el texto de la respuesta. Es el motor común detrás de
 * preguntarleAClaudeSobreImagen_ (imagen + texto) y preguntarleAClaudeTexto_
 * (solo texto) — mismo manejo de errores para ambas.
 */
async function _llamarClaude(contentBlocks, mensajeFaltaLlave) {
  if (!ANTHROPIC_API_KEY) {
    throw new Error(
      'No se configuró la llave de IA en el servidor (falta ANTHROPIC_API_KEY en el archivo .env). ' +
        'Se obtiene en console.anthropic.com y hay que agregarla al .env del proyecto para poder usar ' +
        (mensajeFaltaLlave || 'esta función de IA.')
    );
  }
  if (typeof fetch !== 'function') {
    throw new Error(
      'Esta versión de Node.js no tiene la función fetch integrada, así que no se puede usar la lectura ' +
        'automática por IA. Se necesita Node.js 18 o más reciente.'
    );
  }

  let resp;
  try {
    resp = await fetch(ANTHROPIC_API_URL, {
      method: 'POST',
      signal: AbortSignal.timeout(ANTHROPIC_TIMEOUT_MS),
      headers: {
        'content-type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: ANTHROPIC_MODEL,
        // El modelo configurado "piensa" antes de escribir la respuesta
        // final, y sin límite puede tardarse bastante en fotos con varios
        // renglones (llegó a gastarse el max_tokens original solo pensando,
        // sin llegar a escribir el JSON). El modelo actual ya NO acepta la
        // forma vieja de acotar eso (thinking.type: "enabled" +
        // budget_tokens) — responde con error 400 pidiendo thinking.type:
        // "adaptive" en su lugar, donde el modelo decide solo cuándo vale la
        // pena pensar, y output_config.effort controla qué tanto ("low" =
        // prioriza velocidad, salta el pensamiento incluso en tareas que sí
        // lo necesitan; "high" = piensa más seguido y más profundo). Se
        // probó "low" para la lectura de bitácoras (por velocidad), pero
        // resultó que SÍ hace falta algo de razonamiento para relacionar lo
        // que dice la bitácora (a veces solo un número corto a mano) contra
        // la lista de equipos conocidos — con "low" la IA dejaba de intentar
        // esa comparación y regresaba la unidad en blanco en casi todos los
        // renglones. "medium" balancea velocidad con ese razonamiento.
        thinking: { type: 'adaptive' },
        output_config: { effort: 'medium' },
        max_tokens: 12000,
        messages: [
          {
            role: 'user',
            content: contentBlocks,
          },
        ],
      }),
    });
  } catch (err) {
    // err.message casi siempre es el genérico "fetch failed" de Node; el
    // motivo real (certificado TLS no confiable, proxy corporativo, DNS,
    // tiempo agotado, etc.) viene en err.cause. Lo agregamos al mensaje para
    // poder diagnosticar sin tener que ver los logs del servidor.
    let causaTexto = '';
    if (err && err.cause) {
      const c = err.cause;
      causaTexto = ' — causa: ' + (c.code ? c.code + ': ' : '') + (c.message || String(c));
    } else if (err && err.name === 'TimeoutError') {
      causaTexto =
        ' — causa: se agotó el tiempo de espera (' + Math.round(ANTHROPIC_TIMEOUT_MS / 1000) + ' s) sin respuesta. ' +
        'Si tu internet es lento, sobre todo para SUBIR fotos, puede que solo haya ido lento, no bloqueado — intenta de nuevo, y si sigue pasando revisa tu conexión.';
    } else if (err && err.message) {
      causaTexto = ' — causa: ' + err.message;
    }
    throw new Error(
      'No se pudo conectar con el servicio de IA. Revisa que esta computadora tenga acceso a internet, y que ' +
        'ningún antivirus/firewall/proxy esté bloqueando o interceptando el tráfico HTTPS hacia api.anthropic.com. (' +
        (err && err.message) +
        causaTexto +
        ')'
    );
  }

  if (!resp.ok) {
    let detalle = '';
    try {
      const body = await resp.json();
      detalle = (body && body.error && body.error.message) || '';
    } catch (e) {
      /* ignorar, no venía JSON */
    }
    if (resp.status === 401) {
      throw new Error('La llave de IA (ANTHROPIC_API_KEY) configurada en el .env no es válida.');
    }
    if (resp.status === 404) {
      throw new Error(
        'El modelo de IA configurado ("' +
          ANTHROPIC_MODEL +
          '") no está disponible para esa llave. Se puede cambiar agregando ANTHROPIC_MODEL=... en el .env. ' +
          detalle
      );
    }
    if (resp.status === 429) {
      throw new Error('Se alcanzó el límite de uso de la IA por ahora. Intenta de nuevo en unos minutos.');
    }
    throw new Error('El servicio de IA respondió con un error (' + resp.status + '). ' + detalle);
  }

  const json = await resp.json();

  // A veces un proxy/antivirus que intercepta el tráfico HTTPS deja pasar
  // un 200 pero con un cuerpo que ya no es el de la API de Anthropic (por
  // ejemplo, su propia página de error envuelta en JSON) — este chequeo
  // agarra ese caso con un mensaje más claro que "no regresó texto".
  if (json && json.error) {
    throw new Error(
      'El servicio de IA respondió sin error HTTP pero con un error adentro: ' +
        (json.error.message || JSON.stringify(json.error)) +
        '. Si esta computadora usa un proxy/antivirus que inspecciona el tráfico HTTPS, puede estar alterando la respuesta — pruébalo con esa protección desactivada temporalmente.'
    );
  }

  const bloques = Array.isArray(json.content) ? json.content : [];
  const textoCompleto = bloques
    .filter((b) => b && b.type === 'text' && b.text)
    .map((b) => b.text)
    .join('\n');

  if (!textoCompleto) {
    // Diagnóstico: por qué no vino texto (se detuvo por otra razón, vino
    // vacío, el proxy alteró la respuesta, etc.) — se agrega al mensaje en
    // vez de solo decir "no regresó texto", para poder ubicar la causa sin
    // tener que ver los logs del servidor.
    const tiposBloques = bloques.map((b) => (b && b.type) || '?').join(', ') || 'ninguno';
    const motivo = json.stop_reason ? ' (stop_reason: ' + json.stop_reason + ')' : '';
    if (json.stop_reason === 'max_tokens' && tiposBloques.indexOf('text') === -1) {
      // Ya se identificó esta causa una vez: el modelo "piensa" antes de
      // escribir la respuesta y ese pensamiento también cuenta contra
      // max_tokens — si se corta ahí, nunca llega a escribir el texto
      // final. Se subió max_tokens para dejarle espacio de sobra; si
      // vuelve a pasar es que la foto necesitó todavía más.
      throw new Error(
        'La IA se quedó "pensando" y se le acabó el espacio de respuesta antes de escribir el resultado' + motivo + '. ' +
          'Ya se le dio más espacio (max_tokens) para que esto no pase, pero si sigue ocurriendo, prueba con una foto ' +
          'más chica o con menos renglones a la vez (por ejemplo, la mitad de la hoja).'
      );
    }
    throw new Error(
      'La IA respondió pero sin texto legible' + motivo + '. Bloques recibidos: ' + tiposBloques + '. ' +
        'Si esto se repite, puede que un proxy/antivirus de esta computadora esté alterando el tráfico HTTPS hacia api.anthropic.com, ' +
        'o que la foto no se haya podido interpretar — intenta con otra foto más clara y, si sigue igual, revisa esa protección de red.'
    );
  }
  return textoCompleto;
}

/**
 * Envía una imagen (data URL en base64) más instrucciones de texto a Claude
 * y regresa el texto de la respuesta. Lanza errores con mensajes en español
 * pensados para mostrarse directamente al capturista en el Panel.
 */
async function preguntarleAClaudeSobreImagen_(dataUrl, promptTexto) {
  const matches = (dataUrl || '').match(/^data:(image\/[\w+.-]+);base64,(.+)$/);
  if (!matches) {
    throw new Error('La foto no se pudo procesar (el formato de la imagen no se reconoció).');
  }
  const mediaType = matches[1];
  const base64 = matches[2];
  return _llamarClaude(
    [
      { type: 'image', source: { type: 'base64', media_type: mediaType, data: base64 } },
      { type: 'text', text: promptTexto },
    ],
    'la lectura automática de bitácoras/refacciones por foto.'
  );
}

/**
 * Envía VARIAS imágenes (data URLs en base64) en un solo mensaje a Claude,
 * cada una precedida por una etiqueta de texto "Foto #N:" para que la IA
 * pueda relacionar cada renglón de su respuesta con la foto de la que la
 * sacó, más las instrucciones de texto al final. Se usa para leer de un
 * jalón varias fotos de tickets de gasolina — ver leerTicketsGasolina en
 * server/handlers.js. Ojo: cada FOTO puede traer un solo ticket o varios
 * juntos (por ejemplo, una foto de la mesa con varios tickets uno junto a
 * otro) — por eso se etiqueta como "Foto #N", no "Ticket #N": la relación
 * entre fotos y tickets no es necesariamente 1 a 1. Mismos mensajes de
 * error en español que preguntarleAClaudeSobreImagen_.
 */
async function preguntarleAClaudeSobreImagenes_(dataUrls, promptTexto) {
  if (!Array.isArray(dataUrls) || dataUrls.length === 0) {
    throw new Error('No se recibió ninguna foto.');
  }
  const bloques = [];
  dataUrls.forEach((dataUrl, i) => {
    const matches = (dataUrl || '').match(/^data:(image\/[\w+.-]+);base64,(.+)$/);
    if (!matches) {
      throw new Error('La foto #' + (i + 1) + ' no se pudo procesar (el formato de la imagen no se reconoció).');
    }
    bloques.push({ type: 'text', text: 'Foto #' + (i + 1) + ':' });
    bloques.push({ type: 'image', source: { type: 'base64', media_type: matches[1], data: matches[2] } });
  });
  bloques.push({ type: 'text', text: promptTexto });
  return _llamarClaude(bloques, 'la lectura automática de tickets de gasolina.');
}

/**
 * Envía solo texto (sin imagen) a Claude y regresa el texto de la
 * respuesta. Se usa para interpretar texto escrito o dictado (por ejemplo,
 * "necesito una banda de ventilador y dos filtros de aceite") y convertirlo
 * en una lista estructurada — ver interpretarRefaccionesTexto en handlers.js.
 */
async function preguntarleAClaudeTexto_(promptTexto) {
  return _llamarClaude([{ type: 'text', text: promptTexto }], 'la interpretación automática de texto.');
}

/**
 * Extrae el primer arreglo/objeto JSON válido de un texto de respuesta que
 * puede venir envuelto en ```json ... ``` o con texto alrededor.
 */
function extraerJson_(texto) {
  let limpio = (texto || '').trim();
  const cercaBacktick = limpio.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (cercaBacktick) limpio = cercaBacktick[1].trim();

  const primerCorchete = limpio.indexOf('[');
  const primerLlave = limpio.indexOf('{');
  let ini = -1;
  if (primerCorchete !== -1 && (primerLlave === -1 || primerCorchete < primerLlave)) ini = primerCorchete;
  else ini = primerLlave;
  if (ini === -1) throw new Error('La IA no regresó datos en un formato reconocible.');

  const cierreEsperado = limpio[ini] === '[' ? ']' : '}';
  const fin = limpio.lastIndexOf(cierreEsperado);
  if (fin === -1 || fin < ini) throw new Error('La IA no regresó datos en un formato reconocible.');

  const jsonTexto = limpio.slice(ini, fin + 1);
  try {
    return JSON.parse(jsonTexto);
  } catch (err) {
    throw new Error('No se pudo interpretar la respuesta de la IA como datos válidos.');
  }
}

module.exports = {
  preguntarleAClaudeSobreImagen_,
  preguntarleAClaudeSobreImagenes_,
  preguntarleAClaudeTexto_,
  extraerJson_,
};
