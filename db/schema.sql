-- ============================================================
-- Sistema de Reporte de Fallas — esquema MySQL (versión local)
-- Equivalente a las hojas "Reportes", "Usuarios" y "Diesel" del
-- Google Sheet original.
--
-- Uso:
--   mysql -u root -p < schema.sql
-- (o, dentro de MySQL Workbench / consola: `source schema.sql;`)
-- ============================================================

CREATE DATABASE IF NOT EXISTS reporte_fallas
  CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

USE reporte_fallas;

-- ------------------------------------------------------------
-- Reportes de falla + su seguimiento en Taller
-- (equivalente a la hoja "Reportes")
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS reportes (
  id                          INT AUTO_INCREMENT PRIMARY KEY,
  orden                       VARCHAR(20)  NOT NULL UNIQUE,      -- Folio, ej. OF-00001
  codigo_unidad               VARCHAR(50)  NOT NULL,
  unidad                      VARCHAR(255) NOT NULL,
  huerta                      VARCHAR(255) NOT NULL,
  descripcion                 TEXT         NOT NULL,
  nombre                      VARCHAR(255) NOT NULL,             -- quien reportó
  fecha                       DATETIME     NOT NULL,
  foto_url                    VARCHAR(500) DEFAULT NULL,
  descripcion_audio_url       VARCHAR(500) DEFAULT NULL,         -- histórico; el frontend actual ya no envía audio
  trabajo_realizado           TEXT         DEFAULT NULL,
  trabajo_realizado_audio_url VARCHAR(500) DEFAULT NULL,         -- histórico; el frontend actual ya no envía audio
  fecha_atencion               DATE        DEFAULT NULL,
  fecha_salida                 DATE        DEFAULT NULL,
  refaccionamiento             VARCHAR(255) DEFAULT NULL,
  atendio_por                  VARCHAR(255) DEFAULT NULL,        -- usuario de Taller que cerró la orden
  evidencia_url                 VARCHAR(500) DEFAULT NULL,       -- foto/video que sube Taller al cerrar
  visto_bueno                   VARCHAR(10) DEFAULT NULL,        -- 'Si' o NULL
  comentario_reportante          TEXT       DEFAULT NULL,
  creado_en                    TIMESTAMP    DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_reportes_nombre (nombre),
  INDEX idx_reportes_huerta (huerta)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Permite corregir una orden desde el Panel (ver editarOrden en
-- server/handlers.js) — huerta, descripción, fechas, etc. — y también deja
-- que un movimiento de maquinaria confirmado actualice automáticamente la
-- huerta de una orden abierta para esa misma unidad (ver
-- sincronizarUbicacionOrdenesAbiertas_). modificado_por/modificado_en
-- registran quién y cuándo, igual que en diesel/movimientos_maquinaria;
-- observaciones_staff guarda un historial (una línea por cambio, con fecha)
-- de cada corrección manual o automática que se le hizo a la orden.
SET @col_exists = (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE table_schema = DATABASE() AND table_name = 'reportes' AND column_name = 'modificado_por'
);
SET @sql_alter = IF(@col_exists = 0,
  'ALTER TABLE reportes ADD COLUMN modificado_por VARCHAR(255) DEFAULT NULL',
  'SELECT 1');
PREPARE stmt_alter FROM @sql_alter;
EXECUTE stmt_alter;
DEALLOCATE PREPARE stmt_alter;

SET @col_exists = (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE table_schema = DATABASE() AND table_name = 'reportes' AND column_name = 'modificado_en'
);
SET @sql_alter = IF(@col_exists = 0,
  'ALTER TABLE reportes ADD COLUMN modificado_en TIMESTAMP NULL DEFAULT NULL',
  'SELECT 1');
PREPARE stmt_alter FROM @sql_alter;
EXECUTE stmt_alter;
DEALLOCATE PREPARE stmt_alter;

SET @col_exists = (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE table_schema = DATABASE() AND table_name = 'reportes' AND column_name = 'observaciones_staff'
);
SET @sql_alter = IF(@col_exists = 0,
  'ALTER TABLE reportes ADD COLUMN observaciones_staff TEXT DEFAULT NULL',
  'SELECT 1');
PREPARE stmt_alter FROM @sql_alter;
EXECUTE stmt_alter;
DEALLOCATE PREPARE stmt_alter;

-- dias_atencion: estimado (en días) de cuánto tardará la reparación. Es
-- opcional, aplica solo a algunas órdenes, y se captura solo desde el Panel
-- (Órdenes → Editar orden), independiente de si la orden ya se cerró. Si
-- queda vacío se entiende que la reparación es en el mismo día.
SET @col_exists = (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE table_schema = DATABASE() AND table_name = 'reportes' AND column_name = 'dias_atencion'
);
SET @sql_alter = IF(@col_exists = 0,
  'ALTER TABLE reportes ADD COLUMN dias_atencion INT DEFAULT NULL',
  'SELECT 1');
PREPARE stmt_alter FROM @sql_alter;
EXECUTE stmt_alter;
DEALLOCATE PREPARE stmt_alter;

-- es_soldadura: marca que la orden es trabajo para el Área de Soldadura.
-- Se puede marcar al reportar la falla (Index.html) o después, desde el
-- Panel (Órdenes → Editar orden). Alimenta el apartado "Soldadura" que se
-- muestra debajo de la tabla principal de Órdenes en el Panel.
SET @col_exists = (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE table_schema = DATABASE() AND table_name = 'reportes' AND column_name = 'es_soldadura'
);
SET @sql_alter = IF(@col_exists = 0,
  'ALTER TABLE reportes ADD COLUMN es_soldadura TINYINT(1) NOT NULL DEFAULT 0',
  'SELECT 1');
PREPARE stmt_alter FROM @sql_alter;
EXECUTE stmt_alter;
DEALLOCATE PREPARE stmt_alter;

-- es_automotriz: igual que es_soldadura, pero marca que la orden es trabajo
-- para el área Automotriz (camionetas, camiones, autobuses, motos, etc.).
-- Es independiente de es_soldadura (una orden puede tener las dos marcas a
-- la vez, p.ej. un trabajo de soldadura en una camioneta) — ver
-- filtrarOrdenes_ en Panel.html para la regla de en qué apartado se lista
-- cuando ambas están marcadas.
SET @col_exists = (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE table_schema = DATABASE() AND table_name = 'reportes' AND column_name = 'es_automotriz'
);
SET @sql_alter = IF(@col_exists = 0,
  'ALTER TABLE reportes ADD COLUMN es_automotriz TINYINT(1) NOT NULL DEFAULT 0',
  'SELECT 1');
PREPARE stmt_alter FROM @sql_alter;
EXECUTE stmt_alter;
DEALLOCATE PREPARE stmt_alter;

-- en_proceso_sin_fecha: permite marcar una orden como "En proceso" desde el
-- Panel SIN todavía asignarle una Fecha de atención — para que el jefe de
-- taller la vea de inmediato en su lista de "En proceso" (ver estadoDe() en
-- Panel.html/Taller.html) y la oficina le asigne la fecha real después,
-- cuando la tenga. En cuanto se le asigna una Fecha de atención de verdad
-- (por cualquiera de los flujos existentes: fila de la tabla, letrero de
-- avisos, o el modal de edición), esta bandera se vuelve a poner en 0 — ver
-- actualizarOrden/editarOrden en server/handlers.js.
SET @col_exists = (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE table_schema = DATABASE() AND table_name = 'reportes' AND column_name = 'en_proceso_sin_fecha'
);
SET @sql_alter = IF(@col_exists = 0,
  'ALTER TABLE reportes ADD COLUMN en_proceso_sin_fecha TINYINT(1) NOT NULL DEFAULT 0',
  'SELECT 1');
PREPARE stmt_alter FROM @sql_alter;
EXECUTE stmt_alter;
DEALLOCATE PREPARE stmt_alter;

-- ------------------------------------------------------------
-- Usuarios y control de acceso por módulo (RBAC básico)
-- (equivalente a la hoja "Usuarios")
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS usuarios (
  id            INT AUTO_INCREMENT PRIMARY KEY,
  nombre        VARCHAR(255) NOT NULL UNIQUE,
  huerta        VARCHAR(255) DEFAULT NULL,
  password_hash VARCHAR(255) DEFAULT NULL,   -- hash bcrypt; NUNCA texto plano
  modulos       VARCHAR(255) DEFAULT NULL,   -- lista separada por comas: Reportar,Taller,Panel,Historial
  creado_en     TIMESTAMP DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ------------------------------------------------------------
-- Cargas de diesel
-- (equivalente a la hoja "Diesel")
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS diesel (
  id                INT AUTO_INCREMENT PRIMARY KEY,
  folio             VARCHAR(20)  NOT NULL UNIQUE,   -- ej. DSL-00001
  codigo_unidad     VARCHAR(50)  NOT NULL,
  unidad            VARCHAR(255) NOT NULL,
  huerta            VARCHAR(255) NOT NULL,
  litros            DECIMAL(10,2) NOT NULL,
  lectura           DECIMAL(12,2) DEFAULT NULL,
  nombre            VARCHAR(255) NOT NULL,          -- quien cargó
  fecha             DATETIME     NOT NULL,
  codigo_implemento VARCHAR(50)  DEFAULT NULL,
  implemento        VARCHAR(255) DEFAULT NULL,
  creado_en         TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_diesel_huerta (huerta)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ------------------------------------------------------------
-- Movimientos de maquinaria entre huertas
-- Flujo: quien tiene el equipo asignado (en su huerta) reporta la SALIDA
-- hacia la huerta destino; el encargado de esa huerta destino confirma la
-- LLEGADA. La "ubicación actual" de un equipo es la huerta_destino del
-- movimiento CONFIRMADO más reciente para ese código de unidad (ver
-- getUbicacionesUnidades en server/handlers.js).
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS movimientos_maquinaria (
  id                  INT AUTO_INCREMENT PRIMARY KEY,
  folio               VARCHAR(20)  NOT NULL UNIQUE,     -- ej. MOV-00001
  codigo_unidad       VARCHAR(50)  NOT NULL,
  unidad              VARCHAR(255) NOT NULL,
  huerta_origen       VARCHAR(255) NOT NULL,
  huerta_destino      VARCHAR(255) NOT NULL,
  usuario_salida      VARCHAR(255) NOT NULL,
  fecha_salida        DATETIME     NOT NULL,
  comentario_salida   TEXT         DEFAULT NULL,
  usuario_llegada     VARCHAR(255) DEFAULT NULL,
  fecha_llegada       DATETIME     DEFAULT NULL,
  comentario_llegada  TEXT         DEFAULT NULL,
  estado              VARCHAR(20)  NOT NULL DEFAULT 'pendiente', -- 'pendiente' | 'confirmado'
  foto_salida_url     VARCHAR(500) DEFAULT NULL,
  foto_llegada_url    VARCHAR(500) DEFAULT NULL,
  creado_en           TIMESTAMP    DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_mov_codigo (codigo_unidad),
  INDEX idx_mov_destino (huerta_destino, estado)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ------------------------------------------------------------
-- Catálogo de maquinaria: departamento (CAMPO/COSECHA/PREPARACION),
-- datos de ficha técnica (marca/modelo/año/color/serie/tipo) y notas
-- manuales. La ubicación actual de cada unidad NO se guarda aquí — se
-- sigue derivando de movimientos_maquinaria (ver getUbicacionesUnidades
-- / getMaquinaria en server/handlers.js), para no tener dos fuentes de
-- verdad sobre "dónde está" un equipo.
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS maquinaria (
  id             INT AUTO_INCREMENT PRIMARY KEY,
  codigo_unidad  VARCHAR(50)  NOT NULL UNIQUE,
  unidad         VARCHAR(255) NOT NULL,
  departamento   VARCHAR(20)  DEFAULT NULL,   -- 'CAMPO' | 'COSECHA' | 'PREPARACION' | NULL
  marca          VARCHAR(100) DEFAULT NULL,
  modelo         VARCHAR(100) DEFAULT NULL,
  anio           VARCHAR(10)  DEFAULT NULL,
  color          VARCHAR(50)  DEFAULT NULL,
  serie          VARCHAR(100) DEFAULT NULL,
  placa          VARCHAR(50)  DEFAULT NULL,   -- placa vehicular (autos/camionetas/camiones), va después de serie
  tipo_unidad    VARCHAR(50)  DEFAULT NULL,   -- ej. 'Tractor', 'Retro', 'Implemento'...
  observaciones  TEXT         DEFAULT NULL,   -- nota manual; se sustituye por la falla
                                               -- abierta en Taller cuando el equipo está
                                               -- en mantenimiento (ver getMaquinaria)
  creado_en      TIMESTAMP    DEFAULT CURRENT_TIMESTAMP,
  actualizado_en TIMESTAMP    DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_maquinaria_departamento (departamento)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- color_mapa (oct-2026): color ('#rrggbb') con el que se dibuja el
-- recorrido de ese equipo en el mapa de Avance de huerta, elegido por
-- Carlos desde el Panel. NULL = color automático.
SET @col_exists = (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE table_schema = DATABASE() AND table_name = 'maquinaria' AND column_name = 'color_mapa'
);
SET @sql_alter = IF(@col_exists = 0,
  'ALTER TABLE maquinaria ADD COLUMN color_mapa VARCHAR(7) NULL',
  'SELECT 1');
PREPARE stmt_alter FROM @sql_alter;
EXECUTE stmt_alter;
DEALLOCATE PREPARE stmt_alter;

-- ------------------------------------------------------------
-- Diesel entregado a cada huerta (a granel, por el encargado de diesel),
-- para poder calcular cuánto le queda disponible a cada huerta:
--   disponible = SUM(diesel_entregas.litros) - SUM(diesel.litros)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS diesel_entregas (
  id          INT AUTO_INCREMENT PRIMARY KEY,
  folio       VARCHAR(20)  NOT NULL UNIQUE,   -- ej. ENT-00001
  huerta      VARCHAR(255) NOT NULL,
  litros      DECIMAL(10,2) NOT NULL,
  nombre      VARCHAR(255) NOT NULL,          -- quien registra la entrega
  fecha       DATETIME     NOT NULL,
  comentario  TEXT         DEFAULT NULL,
  creado_en   TIMESTAMP    DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_entregas_huerta (huerta)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Costo de la entrega a granel (opcional — no siempre se conoce el precio
-- al momento de entregar). Mismo patrón que combustible_automotriz:
-- precio_litro + total, el total se recalcula solo si se manda vacío
-- (ver submitDieselEntrega/editarDieselEntrega en server/handlers.js).
SET @col_exists = (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE table_schema = DATABASE() AND table_name = 'diesel_entregas' AND column_name = 'precio_litro'
);
SET @sql_alter = IF(@col_exists = 0,
  'ALTER TABLE diesel_entregas ADD COLUMN precio_litro DECIMAL(10,2) DEFAULT NULL',
  'SELECT 1');
PREPARE stmt_alter FROM @sql_alter;
EXECUTE stmt_alter;
DEALLOCATE PREPARE stmt_alter;

SET @col_exists = (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE table_schema = DATABASE() AND table_name = 'diesel_entregas' AND column_name = 'total'
);
SET @sql_alter = IF(@col_exists = 0,
  'ALTER TABLE diesel_entregas ADD COLUMN total DECIMAL(12,2) DEFAULT NULL',
  'SELECT 1');
PREPARE stmt_alter FROM @sql_alter;
EXECUTE stmt_alter;
DEALLOCATE PREPARE stmt_alter;

-- ------------------------------------------------------------
-- Mantenimiento preventivo: reglas de servicio por equipo (pestaña
-- "Mantenimiento"). Cada equipo puede tener varias reglas (cambio de
-- aceite cada 250 horas, revisión general cada 6 meses, etc.). El
-- "próximo servicio" se calcula en server/handlers.js a partir de
-- ultima_lectura/ultima_fecha + intervalo, comparado contra la lectura
-- actual del equipo (ver getReglasMantenimiento). No se actualiza aquí
-- por trigger: se recalcula solo cuando Taller cierra la orden generada
-- (ver actualizarOrden + tabla mantenimiento_ordenes).
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS mantenimiento_reglas (
  id                INT AUTO_INCREMENT PRIMARY KEY,
  codigo_unidad     VARCHAR(50)  NOT NULL,
  nombre_servicio   VARCHAR(255) NOT NULL,
  tipo_periodicidad VARCHAR(20)  NOT NULL,        -- 'horas' | 'kilometros' | 'tiempo'
  intervalo         DECIMAL(10,2) NOT NULL,       -- horas u km si aplica; MESES si tipo_periodicidad='tiempo'
  ultima_lectura    DECIMAL(12,2) DEFAULT NULL,   -- horómetro/odómetro en el último servicio (horas/kilometros)
  ultima_fecha      DATE          DEFAULT NULL,   -- fecha del último servicio (siempre relevante; obligatoria para 'tiempo')
  refacciones       TEXT          DEFAULT NULL,   -- descripción libre de refacciones y cantidades
  aceite_litros     DECIMAL(10,2) DEFAULT NULL,   -- litros de aceite que ocupa este servicio
  activo            TINYINT(1)    NOT NULL DEFAULT 1,
  creado_en         TIMESTAMP     DEFAULT CURRENT_TIMESTAMP,
  actualizado_en    TIMESTAMP     DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_mant_reglas_codigo (codigo_unidad)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Liga cada orden generada desde una regla de mantenimiento con esa regla,
-- para que al cerrarse la orden en Taller se actualice automáticamente el
-- último registro (ultima_lectura/ultima_fecha) de la regla.
CREATE TABLE IF NOT EXISTS mantenimiento_ordenes (
  id                  INT AUTO_INCREMENT PRIMARY KEY,
  regla_id            INT         NOT NULL,
  orden               VARCHAR(20) NOT NULL UNIQUE,   -- folio en `reportes`, ej. OF-00001
  lectura_generacion  DECIMAL(12,2) DEFAULT NULL,    -- lectura del equipo al momento de generar la orden
  creado_en           TIMESTAMP   DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_mant_ordenes_regla (regla_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Lectura (horómetro/kilometraje) con la que Taller cierra el servicio —
-- distinta de lectura_generacion (la que tenía el equipo cuando se generó
-- la orden, que puede quedar vieja si pasa tiempo entre que se genera la
-- orden y que el servicio se hace de verdad). Al cerrar la orden en Taller
-- (ver actualizarOrden en server/handlers.js), esta es la lectura que
-- manda para actualizar mantenimiento_reglas.ultima_lectura; si Taller no
-- la captura, se sigue usando lectura_generacion como respaldo.
SET @col_exists = (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE table_schema = DATABASE() AND table_name = 'mantenimiento_ordenes' AND column_name = 'lectura_cierre'
);
SET @sql_alter = IF(@col_exists = 0,
  'ALTER TABLE mantenimiento_ordenes ADD COLUMN lectura_cierre DECIMAL(12,2) DEFAULT NULL',
  'SELECT 1');
PREPARE stmt_alter FROM @sql_alter;
EXECUTE stmt_alter;
DEALLOCATE PREPARE stmt_alter;

-- Lectura actual capturada manualmente por equipo (además de la que se
-- obtiene automáticamente de la última carga de diesel), para equipos que
-- no cargan diesel seguido o cuando se quiere corregir el dato a mano.
-- ADD COLUMN condicional (compatible con MySQL 8 y MariaDB, para que
-- schema.sql se pueda volver a correr sin error si la columna ya existe).
SET @col_exists = (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE table_schema = DATABASE() AND table_name = 'maquinaria' AND column_name = 'lectura_manual'
);
SET @sql_alter = IF(@col_exists = 0,
  'ALTER TABLE maquinaria ADD COLUMN lectura_manual DECIMAL(12,2) DEFAULT NULL',
  'SELECT 1');
PREPARE stmt_alter FROM @sql_alter;
EXECUTE stmt_alter;
DEALLOCATE PREPARE stmt_alter;

SET @col_exists = (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE table_schema = DATABASE() AND table_name = 'maquinaria' AND column_name = 'lectura_manual_fecha'
);
SET @sql_alter = IF(@col_exists = 0,
  'ALTER TABLE maquinaria ADD COLUMN lectura_manual_fecha DATE DEFAULT NULL',
  'SELECT 1');
PREPARE stmt_alter FROM @sql_alter;
EXECUTE stmt_alter;
DEALLOCATE PREPARE stmt_alter;

-- ------------------------------------------------------------
-- Refacciones: catálogo maestro de partes (pestaña "Refacciones") y su
-- asignación N:M a reglas de mantenimiento (con cantidad por asignación).
-- El precio y el proveedor son opcionales. Esta asignación estructurada
-- complementa al viejo campo de texto libre `mantenimiento_reglas.refacciones`,
-- que se conserva como "Notas adicionales" (no se elimina para no perder
-- datos ya capturados).
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS refacciones (
  id             INT AUTO_INCREMENT PRIMARY KEY,
  no_parte       VARCHAR(100) DEFAULT NULL,
  descripcion    VARCHAR(255) NOT NULL,
  precio         DECIMAL(10,2) DEFAULT NULL,
  proveedor      VARCHAR(150) DEFAULT NULL,
  creado_en      TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  actualizado_en TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS mantenimiento_regla_refacciones (
  id           INT AUTO_INCREMENT PRIMARY KEY,
  regla_id     INT NOT NULL,
  refaccion_id INT NOT NULL,
  cantidad     DECIMAL(10,2) NOT NULL DEFAULT 1,
  INDEX idx_mrr_regla (regla_id),
  INDEX idx_mrr_refaccion (refaccion_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ------------------------------------------------------------
-- Refacciones NECESARIAS por orden (columna "Refaccionamiento" del Panel):
-- qué piezas hacen falta para atender una orden en particular. Se captura
-- desde el Panel o desde Taller (mecánicos) escribiendo, dictando o
-- tomando una foto — un texto libre que la IA interpreta y compara contra
-- el catálogo de `refacciones`. Cada renglón queda ligado a una refacción
-- ya dada de alta (refaccion_id) o, si todavía no existe en el catálogo,
-- como texto libre pendiente de catalogar (texto_libre). "orden" no lleva
-- FK (mismo criterio que mantenimiento_ordenes.orden): es la clave de
-- negocio de `reportes`, no su PK numérica.
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS reportes_refacciones_necesarias (
  id             INT AUTO_INCREMENT PRIMARY KEY,
  orden          VARCHAR(20)  NOT NULL,
  refaccion_id   INT          DEFAULT NULL,
  texto_libre    VARCHAR(255) DEFAULT NULL,
  cantidad       DECIMAL(10,2) DEFAULT NULL,
  origen         VARCHAR(20)  DEFAULT NULL,   -- 'texto' | 'foto' | 'dictado' | 'preventivo' | 'manual'
  capturado_por  VARCHAR(255) DEFAULT NULL,
  creado_en      TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_rrn_orden (orden),
  INDEX idx_rrn_refaccion (refaccion_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Marca si esa pieza ya se entregó/recogió para la orden (independiente de
-- si ya está ligada al catálogo de Refacciones — ver "vinculada" en el
-- modal "refnec-" de Panel.html). Se guarda quién y cuándo, igual que
-- insumos_solicitados.entregado_por/entregado_en.
SET @col_exists = (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE table_schema = DATABASE() AND table_name = 'reportes_refacciones_necesarias' AND column_name = 'entregado'
);
SET @sql_alter = IF(@col_exists = 0,
  'ALTER TABLE reportes_refacciones_necesarias ADD COLUMN entregado TINYINT(1) NOT NULL DEFAULT 0',
  'SELECT 1');
PREPARE stmt_alter FROM @sql_alter;
EXECUTE stmt_alter;
DEALLOCATE PREPARE stmt_alter;

SET @col_exists = (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE table_schema = DATABASE() AND table_name = 'reportes_refacciones_necesarias' AND column_name = 'entregado_por'
);
SET @sql_alter = IF(@col_exists = 0,
  'ALTER TABLE reportes_refacciones_necesarias ADD COLUMN entregado_por VARCHAR(255) DEFAULT NULL',
  'SELECT 1');
PREPARE stmt_alter FROM @sql_alter;
EXECUTE stmt_alter;
DEALLOCATE PREPARE stmt_alter;

SET @col_exists = (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE table_schema = DATABASE() AND table_name = 'reportes_refacciones_necesarias' AND column_name = 'entregado_en'
);
SET @sql_alter = IF(@col_exists = 0,
  'ALTER TABLE reportes_refacciones_necesarias ADD COLUMN entregado_en DATETIME DEFAULT NULL',
  'SELECT 1');
PREPARE stmt_alter FROM @sql_alter;
EXECUTE stmt_alter;
DEALLOCATE PREPARE stmt_alter;

-- ------------------------------------------------------------
-- Proveedores: catálogo de proveedores de refacciones, con sus datos de
-- contacto (para poder escribirles por correo o teléfono). Cada refacción
-- se puede ligar a un proveedor de este catálogo (ver refacciones.proveedor_id
-- más abajo); el viejo campo de texto libre `refacciones.proveedor` se
-- conserva como respaldo para lo ya capturado antes de este catálogo.
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS proveedores (
  id             INT AUTO_INCREMENT PRIMARY KEY,
  nombre         VARCHAR(255) NOT NULL,
  correo         VARCHAR(255) DEFAULT NULL,
  telefono       VARCHAR(50)  DEFAULT NULL,
  contacto       VARCHAR(255) DEFAULT NULL,   -- persona de contacto en la empresa
  marcas         VARCHAR(255) DEFAULT NULL,   -- marcas de producto que maneja
  notas          TEXT         DEFAULT NULL,   -- dirección u otra nota libre
  creado_en      TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  actualizado_en TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Liga cada refacción a un proveedor del catálogo de arriba (ADD COLUMN
-- condicional, mismo patrón que maquinaria.lectura_manual, para que
-- schema.sql se pueda volver a correr sin error si la columna ya existe).
SET @col_exists = (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE table_schema = DATABASE() AND table_name = 'refacciones' AND column_name = 'proveedor_id'
);
SET @sql_alter = IF(@col_exists = 0,
  'ALTER TABLE refacciones ADD COLUMN proveedor_id INT DEFAULT NULL',
  'SELECT 1');
PREPARE stmt_alter FROM @sql_alter;
EXECUTE stmt_alter;
DEALLOCATE PREPARE stmt_alter;

-- ------------------------------------------------------------
-- Código interno secuencial de cada refacción (REF-00001, REF-00002...),
-- para identificarla sin depender del "No. de parte" de la marca (que es
-- opcional, texto libre y puede repetirse entre proveedores). Se asigna
-- una sola vez, al crear la refacción (ver server/handlers.js:
-- guardarRefaccion) — nunca se reasigna ni se edita a mano. Las
-- refacciones que ya existían antes de esta columna reciben su código
-- en un backfill al final de este archivo (después de que exista la
-- tabla `contadores`).
-- ------------------------------------------------------------
SET @col_exists = (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE table_schema = DATABASE() AND table_name = 'refacciones' AND column_name = 'codigo'
);
SET @sql_alter = IF(@col_exists = 0,
  'ALTER TABLE refacciones ADD COLUMN codigo VARCHAR(20) DEFAULT NULL',
  'SELECT 1');
PREPARE stmt_alter FROM @sql_alter;
EXECUTE stmt_alter;
DEALLOCATE PREPARE stmt_alter;

SET @idx_exists = (
  SELECT COUNT(*) FROM information_schema.STATISTICS
  WHERE table_schema = DATABASE() AND table_name = 'refacciones' AND index_name = 'idx_refacciones_codigo'
);
SET @sql_idx = IF(@idx_exists = 0,
  'CREATE UNIQUE INDEX idx_refacciones_codigo ON refacciones (codigo)',
  'SELECT 1');
PREPARE stmt_idx FROM @sql_idx;
EXECUTE stmt_idx;
DEALLOCATE PREPARE stmt_idx;

-- ------------------------------------------------------------
-- Categorías de refacciones: agrupan el catálogo (por ejemplo "Aceite",
-- "Filtros", "Llantas"...), administradas desde un apartado dentro de la
-- pestaña "Refacciones". El selector de aceite en Mantenimiento usa la
-- categoría "Aceite" para saber qué refacciones ofrecer, en vez del
-- heurístico anterior (descripción que empieza con "ACEITE").
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS categorias_refacciones (
  id             INT AUTO_INCREMENT PRIMARY KEY,
  nombre         VARCHAR(100) NOT NULL,
  creado_en      TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_categoria_nombre (nombre)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Liga cada refacción a una categoría del catálogo de arriba (ADD COLUMN
-- condicional, mismo patrón que refacciones.proveedor_id).
SET @col_exists = (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE table_schema = DATABASE() AND table_name = 'refacciones' AND column_name = 'categoria_id'
);
SET @sql_alter = IF(@col_exists = 0,
  'ALTER TABLE refacciones ADD COLUMN categoria_id INT DEFAULT NULL',
  'SELECT 1');
PREPARE stmt_alter FROM @sql_alter;
EXECUTE stmt_alter;
DEALLOCATE PREPARE stmt_alter;

-- Da de alta automáticamente la categoría "Aceite" (si no existe todavía)
-- para que el selector de aceite en Mantenimiento tenga algo que ofrecer
-- desde el primer momento, sin que haya que crearla a mano.
INSERT INTO categorias_refacciones (nombre)
SELECT 'Aceite' WHERE NOT EXISTS (SELECT 1 FROM categorias_refacciones WHERE nombre = 'Aceite');

-- Backfill: a las refacciones cuya descripción ya empezaba con "ACEITE"
-- (el heurístico que se usaba antes de que existieran las categorías) se
-- les asigna automáticamente la categoría "Aceite" recién creada, para
-- que el selector de aceite en Mantenimiento no se quede vacío justo
-- después de esta actualización. Solo toca refacciones sin categoría
-- todavía, así que correr esto varias veces es seguro.
UPDATE refacciones r
JOIN categorias_refacciones c ON c.nombre = 'Aceite'
SET r.categoria_id = c.id
WHERE r.categoria_id IS NULL AND UPPER(TRIM(r.descripcion)) LIKE 'ACEITE%';

-- ------------------------------------------------------------
-- Marca y modelos compatibles de cada refacción (pestaña Refacciones):
-- cada refacción tiene UNA marca (ej. "JOHN DEERE") y puede ser compatible
-- con VARIOS modelos de esa marca (ej. "5415", "5615", "5725" — el mismo
-- filtro suele servir para varios modelos). "marcas_refacciones" y
-- "modelos_refacciones" son catálogos administrados desde un apartado
-- dentro de la pestaña "Refacciones" (igual que categorías/proveedores);
-- "refacciones_modelos" es la liga muchos-a-muchos entre una refacción y
-- los modelos con los que es compatible.
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS marcas_refacciones (
  id             INT AUTO_INCREMENT PRIMARY KEY,
  nombre         VARCHAR(100) NOT NULL,
  creado_en      TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_marca_nombre (nombre)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS modelos_refacciones (
  id             INT AUTO_INCREMENT PRIMARY KEY,
  marca_id       INT NOT NULL,
  nombre         VARCHAR(100) NOT NULL,
  creado_en      TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_modelo_marca_nombre (marca_id, nombre),
  INDEX idx_modelos_marca (marca_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Liga cada refacción a una marca del catálogo de arriba (ADD COLUMN
-- condicional, mismo patrón que refacciones.categoria_id).
SET @col_exists = (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE table_schema = DATABASE() AND table_name = 'refacciones' AND column_name = 'marca_id'
);
SET @sql_alter = IF(@col_exists = 0,
  'ALTER TABLE refacciones ADD COLUMN marca_id INT DEFAULT NULL',
  'SELECT 1');
PREPARE stmt_alter FROM @sql_alter;
EXECUTE stmt_alter;
DEALLOCATE PREPARE stmt_alter;

CREATE TABLE IF NOT EXISTS refacciones_modelos (
  id           INT AUTO_INCREMENT PRIMARY KEY,
  refaccion_id INT NOT NULL,
  modelo_id    INT NOT NULL,
  UNIQUE KEY uq_refaccion_modelo (refaccion_id, modelo_id),
  INDEX idx_refmod_refaccion (refaccion_id),
  INDEX idx_refmod_modelo (modelo_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ------------------------------------------------------------
-- Marca y modelo de cada equipo (pestañas "Maquinaria"/"Catálogo"): se
-- ligan al mismo catálogo de marcas/modelos de arriba (marcas_refacciones/
-- modelos_refacciones), para poder elegirlos desde un selector en vez de
-- escribirlos a mano cada vez, igual que en Refacciones. Las columnas de
-- texto libre "marca"/"modelo" que ya existían se conservan tal cual
-- (quedan como respaldo de lo que ya se había capturado; ya no se
-- vuelven a escribir desde el Panel una vez que el equipo tiene
-- marca_id/modelo_id).
-- ------------------------------------------------------------
SET @col_exists = (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE table_schema = DATABASE() AND table_name = 'maquinaria' AND column_name = 'marca_id'
);
SET @sql_alter = IF(@col_exists = 0,
  'ALTER TABLE maquinaria ADD COLUMN marca_id INT DEFAULT NULL',
  'SELECT 1');
PREPARE stmt_alter FROM @sql_alter;
EXECUTE stmt_alter;
DEALLOCATE PREPARE stmt_alter;

SET @col_exists = (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE table_schema = DATABASE() AND table_name = 'maquinaria' AND column_name = 'modelo_id'
);
SET @sql_alter = IF(@col_exists = 0,
  'ALTER TABLE maquinaria ADD COLUMN modelo_id INT DEFAULT NULL',
  'SELECT 1');
PREPARE stmt_alter FROM @sql_alter;
EXECUTE stmt_alter;
DEALLOCATE PREPARE stmt_alter;

-- Backfill: a cada equipo que ya tenía marca/modelo en texto libre y
-- todavía no está ligado al catálogo (marca_id NULL) se le busca -o se le
-- da de alta- la marca/modelo correspondiente en el catálogo y se liga
-- automáticamente. Nunca se toca un equipo que ya tenga marca_id (para no
-- pisar una edición manual posterior desde el Panel), así que correr esto
-- varias veces es seguro. La comparación es sin distinguir mayúsculas ni
-- espacios, y las marcas/modelos nuevos se dan de alta en mayúsculas para
-- mantener la misma convención que ya trae el catálogo (JOHN DEERE,
-- KUBOTA, FORD...).
INSERT IGNORE INTO marcas_refacciones (nombre)
SELECT DISTINCT UPPER(TRIM(m.marca))
FROM maquinaria m
WHERE m.marca IS NOT NULL AND TRIM(m.marca) <> '' AND m.marca_id IS NULL;

UPDATE maquinaria m
JOIN marcas_refacciones mr ON UPPER(mr.nombre) = UPPER(TRIM(m.marca))
SET m.marca_id = mr.id
WHERE m.marca IS NOT NULL AND TRIM(m.marca) <> '' AND m.marca_id IS NULL;

INSERT IGNORE INTO modelos_refacciones (marca_id, nombre)
SELECT DISTINCT m.marca_id, UPPER(TRIM(m.modelo))
FROM maquinaria m
WHERE m.marca_id IS NOT NULL AND m.modelo IS NOT NULL AND TRIM(m.modelo) <> '' AND m.modelo_id IS NULL;

UPDATE maquinaria m
JOIN modelos_refacciones mo ON mo.marca_id = m.marca_id AND UPPER(mo.nombre) = UPPER(TRIM(m.modelo))
SET m.modelo_id = mo.id
WHERE m.marca_id IS NOT NULL AND m.modelo IS NOT NULL AND TRIM(m.modelo) <> '' AND m.modelo_id IS NULL;

-- ------------------------------------------------------------
-- Contactos adicionales de un proveedor (además del contacto principal
-- que ya trae `proveedores.contacto`/`correo`), para poder mandarle una
-- solicitud de cotización a más de una persona del mismo proveedor.
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS proveedor_contactos (
  id           INT AUTO_INCREMENT PRIMARY KEY,
  proveedor_id INT NOT NULL,
  nombre       VARCHAR(255) DEFAULT NULL,
  correo       VARCHAR(255) DEFAULT NULL,
  telefono     VARCHAR(50)  DEFAULT NULL,
  notas        VARCHAR(255) DEFAULT NULL,
  creado_en    TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_prov_contactos_proveedor (proveedor_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ------------------------------------------------------------
-- Solicitudes de cotización: cuando se le pide a un proveedor que cotice
-- una lista de refacciones. Cada solicitud tiene un folio y un token único
-- para armar un enlace público (sin clave de acceso, pensado para
-- compartirse por correo) donde el proveedor ve las refacciones pedidas y
-- responde con su precio (ver server/handlers.js: getSolicitudCotizacionPublica
-- / responderCotizacion, y public/Cotizacion.html). El precio cotizado NO
-- se copia solo al catálogo — Taller lo revisa y decide aplicarlo (ver
-- aplicarPreciosCotizacion).
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS solicitudes_cotizacion (
  id                   INT AUTO_INCREMENT PRIMARY KEY,
  folio                VARCHAR(20)  NOT NULL UNIQUE,   -- ej. COT-00001
  token                VARCHAR(64)  NOT NULL UNIQUE,
  proveedor_id         INT          NOT NULL,
  mensaje              TEXT         DEFAULT NULL,      -- instrucciones para el proveedor
  estado               VARCHAR(20)  NOT NULL DEFAULT 'pendiente', -- 'pendiente' | 'respondida'
  nombre_solicito      VARCHAR(255) DEFAULT NULL,       -- quién generó la solicitud
  respuesta_nombre     VARCHAR(255) DEFAULT NULL,       -- quién respondió del lado del proveedor
  respuesta_comentario TEXT         DEFAULT NULL,
  creado_en            TIMESTAMP    DEFAULT CURRENT_TIMESTAMP,
  respondido_en        TIMESTAMP    NULL DEFAULT NULL,
  INDEX idx_sol_cot_proveedor (proveedor_id),
  INDEX idx_sol_cot_token (token)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Orden de trabajo (reportes.orden, ej. OF-00001) para la que se piden estas
-- refacciones — toda solicitud de cotización NUEVA debe traer una (se
-- valida en server/handlers.js: crearSolicitudCotizacion). Las solicitudes
-- que ya existían antes de esta columna se quedan con orden = NULL (no hay
-- forma de adivinar a cuál orden pertenecían) y se siguen viendo igual,
-- solo que sin ese dato. ADD COLUMN condicional para poder volver a correr
-- este archivo sin error si la columna ya existe.
SET @col_exists = (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE table_schema = DATABASE() AND table_name = 'solicitudes_cotizacion' AND column_name = 'orden'
);
SET @sql_alter = IF(@col_exists = 0,
  'ALTER TABLE solicitudes_cotizacion ADD COLUMN orden VARCHAR(20) DEFAULT NULL',
  'SELECT 1');
PREPARE stmt_alter FROM @sql_alter;
EXECUTE stmt_alter;
DEALLOCATE PREPARE stmt_alter;

SET @idx_exists = (
  SELECT COUNT(*) FROM information_schema.STATISTICS
  WHERE table_schema = DATABASE() AND table_name = 'solicitudes_cotizacion' AND index_name = 'idx_sol_cot_orden'
);
SET @sql_idx = IF(@idx_exists = 0,
  'CREATE INDEX idx_sol_cot_orden ON solicitudes_cotizacion (orden)',
  'SELECT 1');
PREPARE stmt_idx FROM @sql_idx;
EXECUTE stmt_idx;
DEALLOCATE PREPARE stmt_idx;

CREATE TABLE IF NOT EXISTS solicitud_cotizacion_items (
  id              INT AUTO_INCREMENT PRIMARY KEY,
  solicitud_id    INT NOT NULL,
  refaccion_id    INT NOT NULL,
  cantidad        DECIMAL(10,2) NOT NULL DEFAULT 1,
  precio_cotizado DECIMAL(10,2) DEFAULT NULL,  -- histórico: ya no se escribe aquí (ver solicitud_cotizacion_respuesta_items)
  comentario      VARCHAR(255) DEFAULT NULL,   -- histórico: ídem
  INDEX idx_sci_solicitud (solicitud_id),
  INDEX idx_sci_refaccion (refaccion_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ------------------------------------------------------------
-- Respuestas de cotización: cada vez que alguien manda su cotización desde
-- el enlace público de una solicitud, se crea UNA respuesta nueva (nunca se
-- sobreescribe la de otra persona) — así, si le pides a más de un contacto
-- del mismo proveedor (o a varios proveedores) que cotice el mismo enlace,
-- cada quien puede cargar su propio precio sin pisar el de los demás. Cada
-- respuesta puede traer, opcionalmente, un PDF adjunto con la cotización
-- formal de quien respondió (ver server/handlers.js: responderCotizacion).
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS solicitud_cotizacion_respuestas (
  id              INT AUTO_INCREMENT PRIMARY KEY,
  solicitud_id    INT NOT NULL,
  nombre_responde VARCHAR(255) NOT NULL,
  comentario      TEXT DEFAULT NULL,
  pdf_url         VARCHAR(500) DEFAULT NULL,
  pdf_nombre      VARCHAR(255) DEFAULT NULL,
  origen          VARCHAR(20)  DEFAULT NULL,  -- 'migrado_legado' para las creadas por el backfill de abajo; NULL para respuestas nuevas
  creado_en       TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_scr_solicitud (solicitud_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Precio y fecha de entrega que dio ESA respuesta para CADA pieza pedida
-- (item_id apunta a solicitud_cotizacion_items, que es la lista de lo
-- pedido, compartida entre todas las respuestas de una misma solicitud).
CREATE TABLE IF NOT EXISTS solicitud_cotizacion_respuesta_items (
  id              INT AUTO_INCREMENT PRIMARY KEY,
  respuesta_id    INT NOT NULL,
  item_id         INT NOT NULL,
  precio_cotizado DECIMAL(10,2) DEFAULT NULL,
  fecha_entrega   DATE DEFAULT NULL,
  comentario      VARCHAR(255) DEFAULT NULL,
  INDEX idx_scri_respuesta (respuesta_id),
  INDEX idx_scri_item (item_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Descuento (%) que ofrece el proveedor sobre TODA su cotización (un solo
-- valor por respuesta, no por pieza). IVA (%), en cambio, sí lo captura el
-- proveedor pieza por pieza (puede variar de una refacción a otra). Y
-- "autorizado" marca, para cada pieza pedida, cuál de las respuestas (de
-- entre las que la cotizaron) es la que se tomó como ganadora — nunca hay
-- más de una fila autorizada por pieza dentro de la misma solicitud (eso lo
-- garantiza server/handlers.js: autorizarPrecioItem, no una restricción de
-- la base de datos). ADD COLUMN condicional para poder volver a correr este
-- archivo sin error si las columnas ya existen.
SET @col_exists = (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE table_schema = DATABASE() AND table_name = 'solicitud_cotizacion_respuestas' AND column_name = 'descuento_pct'
);
SET @sql_alter = IF(@col_exists = 0,
  'ALTER TABLE solicitud_cotizacion_respuestas ADD COLUMN descuento_pct DECIMAL(5,2) DEFAULT NULL',
  'SELECT 1');
PREPARE stmt_alter FROM @sql_alter;
EXECUTE stmt_alter;
DEALLOCATE PREPARE stmt_alter;

SET @col_exists = (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE table_schema = DATABASE() AND table_name = 'solicitud_cotizacion_respuesta_items' AND column_name = 'iva_pct'
);
SET @sql_alter = IF(@col_exists = 0,
  'ALTER TABLE solicitud_cotizacion_respuesta_items ADD COLUMN iva_pct DECIMAL(5,2) DEFAULT NULL',
  'SELECT 1');
PREPARE stmt_alter FROM @sql_alter;
EXECUTE stmt_alter;
DEALLOCATE PREPARE stmt_alter;

SET @col_exists = (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE table_schema = DATABASE() AND table_name = 'solicitud_cotizacion_respuesta_items' AND column_name = 'autorizado'
);
SET @sql_alter = IF(@col_exists = 0,
  'ALTER TABLE solicitud_cotizacion_respuesta_items ADD COLUMN autorizado TINYINT(1) NOT NULL DEFAULT 0',
  'SELECT 1');
PREPARE stmt_alter FROM @sql_alter;
EXECUTE stmt_alter;
DEALLOCATE PREPARE stmt_alter;

-- ------------------------------------------------------------
-- Contadores de folio consecutivo
-- (equivalente a PropertiesService: lastOrderNum / lastDieselNum)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS contadores (
  nombre  VARCHAR(50) PRIMARY KEY,
  ultimo  INT NOT NULL DEFAULT 0
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

INSERT INTO contadores (nombre, ultimo) VALUES ('orden', 0)
  ON DUPLICATE KEY UPDATE nombre = nombre;
INSERT INTO contadores (nombre, ultimo) VALUES ('diesel', 0)
  ON DUPLICATE KEY UPDATE nombre = nombre;
INSERT INTO contadores (nombre, ultimo) VALUES ('movimiento', 0)
  ON DUPLICATE KEY UPDATE nombre = nombre;
INSERT INTO contadores (nombre, ultimo) VALUES ('entrega', 0)
  ON DUPLICATE KEY UPDATE nombre = nombre;
INSERT INTO contadores (nombre, ultimo) VALUES ('cotizacion', 0)
  ON DUPLICATE KEY UPDATE nombre = nombre;

-- ------------------------------------------------------------
-- Backfill de refacciones.codigo: a las refacciones que ya existían antes
-- de esta columna se les asigna un código en orden de alta (REF-00001,
-- REF-00002...). Seguro de volver a correr: solo toca las que sigan con
-- codigo NULL, y deja el contador 'refaccion' en al menos el total ya
-- asignado para que los códigos nuevos no choquen con estos.
-- ------------------------------------------------------------
SET @seq := (SELECT COUNT(*) FROM refacciones WHERE codigo IS NOT NULL);
UPDATE refacciones SET codigo = CONCAT('REF-', LPAD(@seq := @seq + 1, 5, '0'))
  WHERE codigo IS NULL
  ORDER BY id;

SET @total_refacciones := (SELECT COUNT(*) FROM refacciones);
INSERT INTO contadores (nombre, ultimo) VALUES ('refaccion', @total_refacciones)
  ON DUPLICATE KEY UPDATE ultimo = GREATEST(ultimo, @total_refacciones);

-- ------------------------------------------------------------
-- Backfill de solicitud_cotizacion_respuestas: las solicitudes que ya
-- estaban "respondida" antes de que existiera esta tabla (cuando solo se
-- guardaba UNA respuesta por solicitud, directo en solicitudes_cotizacion /
-- solicitud_cotizacion_items) migran esa respuesta a una fila normal aquí,
-- marcada con origen='migrado_legado' — no se pierde ninguna cotización ya
-- recibida. Seguro de volver a correr: la primera consulta solo crea una
-- respuesta 'migrado_legado' por solicitud si todavía no existe una, y la
-- segunda solo copia los items que todavía no se hayan copiado para esa
-- respuesta específica.
-- ------------------------------------------------------------
INSERT INTO solicitud_cotizacion_respuestas (solicitud_id, nombre_responde, comentario, origen, creado_en)
SELECT s.id, COALESCE(NULLIF(TRIM(s.respuesta_nombre), ''), 'Proveedor'), s.respuesta_comentario, 'migrado_legado',
       COALESCE(s.respondido_en, s.creado_en)
FROM solicitudes_cotizacion s
WHERE s.estado = 'respondida'
  AND NOT EXISTS (
    SELECT 1 FROM solicitud_cotizacion_respuestas r
    WHERE r.solicitud_id = s.id AND r.origen = 'migrado_legado'
  );

INSERT INTO solicitud_cotizacion_respuesta_items (respuesta_id, item_id, precio_cotizado, comentario)
SELECT r.id, sci.id, sci.precio_cotizado, sci.comentario
FROM solicitud_cotizacion_respuestas r
INNER JOIN solicitud_cotizacion_items sci ON sci.solicitud_id = r.solicitud_id
WHERE r.origen = 'migrado_legado'
  AND NOT EXISTS (
    SELECT 1 FROM solicitud_cotizacion_respuesta_items ri
    WHERE ri.respuesta_id = r.id AND ri.item_id = sci.id
  );

-- ------------------------------------------------------------
-- Auditoría de ediciones desde el Panel: quién y cuándo corrigió una
-- carga de diesel o un movimiento de maquinaria ya capturados (ver
-- editarCargaDiesel / editarMovimiento en server/handlers.js). NULL
-- mientras el registro no se haya editado nunca. ADD COLUMN condicional,
-- mismo patrón que el resto de este archivo.
-- ------------------------------------------------------------
SET @col_exists = (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE table_schema = DATABASE() AND table_name = 'diesel' AND column_name = 'modificado_por'
);
SET @sql_alter = IF(@col_exists = 0,
  'ALTER TABLE diesel ADD COLUMN modificado_por VARCHAR(255) DEFAULT NULL',
  'SELECT 1');
PREPARE stmt_alter FROM @sql_alter;
EXECUTE stmt_alter;
DEALLOCATE PREPARE stmt_alter;

SET @col_exists = (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE table_schema = DATABASE() AND table_name = 'diesel' AND column_name = 'modificado_en'
);
SET @sql_alter = IF(@col_exists = 0,
  'ALTER TABLE diesel ADD COLUMN modificado_en DATETIME DEFAULT NULL',
  'SELECT 1');
PREPARE stmt_alter FROM @sql_alter;
EXECUTE stmt_alter;
DEALLOCATE PREPARE stmt_alter;

SET @col_exists = (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE table_schema = DATABASE() AND table_name = 'movimientos_maquinaria' AND column_name = 'modificado_por'
);
SET @sql_alter = IF(@col_exists = 0,
  'ALTER TABLE movimientos_maquinaria ADD COLUMN modificado_por VARCHAR(255) DEFAULT NULL',
  'SELECT 1');
PREPARE stmt_alter FROM @sql_alter;
EXECUTE stmt_alter;
DEALLOCATE PREPARE stmt_alter;

SET @col_exists = (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE table_schema = DATABASE() AND table_name = 'movimientos_maquinaria' AND column_name = 'modificado_en'
);
SET @sql_alter = IF(@col_exists = 0,
  'ALTER TABLE movimientos_maquinaria ADD COLUMN modificado_en DATETIME DEFAULT NULL',
  'SELECT 1');
PREPARE stmt_alter FROM @sql_alter;
EXECUTE stmt_alter;
DEALLOCATE PREPARE stmt_alter;

-- Foto opcional del equipo, tanto al registrar la salida como al confirmar
-- la llegada (ver submitMovimientoSalida/confirmarLlegadaMovimiento en
-- server/handlers.js). Se guarda igual que el resto de fotos del sistema,
-- con guardarArchivoLocal_() en server/helpers.js.
SET @col_exists = (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE table_schema = DATABASE() AND table_name = 'movimientos_maquinaria' AND column_name = 'foto_salida_url'
);
SET @sql_alter = IF(@col_exists = 0,
  'ALTER TABLE movimientos_maquinaria ADD COLUMN foto_salida_url VARCHAR(500) DEFAULT NULL',
  'SELECT 1');
PREPARE stmt_alter FROM @sql_alter;
EXECUTE stmt_alter;
DEALLOCATE PREPARE stmt_alter;

SET @col_exists = (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE table_schema = DATABASE() AND table_name = 'movimientos_maquinaria' AND column_name = 'foto_llegada_url'
);
SET @sql_alter = IF(@col_exists = 0,
  'ALTER TABLE movimientos_maquinaria ADD COLUMN foto_llegada_url VARCHAR(500) DEFAULT NULL',
  'SELECT 1');
PREPARE stmt_alter FROM @sql_alter;
EXECUTE stmt_alter;
DEALLOCATE PREPARE stmt_alter;

-- Mismo par modificado_por/modificado_en, ahora para diesel_entregas
-- (editarDieselEntrega en server/handlers.js), para poder editar/eliminar
-- una entrega de diesel a huerta desde el Panel.
SET @col_exists = (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE table_schema = DATABASE() AND table_name = 'diesel_entregas' AND column_name = 'modificado_por'
);
SET @sql_alter = IF(@col_exists = 0,
  'ALTER TABLE diesel_entregas ADD COLUMN modificado_por VARCHAR(255) DEFAULT NULL',
  'SELECT 1');
PREPARE stmt_alter FROM @sql_alter;
EXECUTE stmt_alter;
DEALLOCATE PREPARE stmt_alter;

SET @col_exists = (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE table_schema = DATABASE() AND table_name = 'diesel_entregas' AND column_name = 'modificado_en'
);
SET @sql_alter = IF(@col_exists = 0,
  'ALTER TABLE diesel_entregas ADD COLUMN modificado_en DATETIME DEFAULT NULL',
  'SELECT 1');
PREPARE stmt_alter FROM @sql_alter;
EXECUTE stmt_alter;
DEALLOCATE PREPARE stmt_alter;

-- ------------------------------------------------------------
-- Eliminación suave (soft delete) de capturas de diesel/combustible
-- agrícola: en vez de borrar la fila para siempre, eliminarCargaDiesel /
-- eliminarDieselEntrega (server/handlers.js) marcan eliminado=1 y guardan
-- quién y cuándo. getCargasDiesel/getDieselEntregas solo regresan las
-- activas (eliminado=0) salvo que se pida incluirEliminados=true (checkbox
-- "Mostrar eliminados" en el Panel), y restaurarCargaDiesel/
-- restaurarDieselEntrega revierten el borrado. Mismo par
-- eliminado_por/eliminado_en para las dos tablas, ADD COLUMN condicional
-- como el resto de este archivo.
-- ------------------------------------------------------------
SET @col_exists = (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE table_schema = DATABASE() AND table_name = 'diesel' AND column_name = 'eliminado'
);
SET @sql_alter = IF(@col_exists = 0,
  'ALTER TABLE diesel ADD COLUMN eliminado TINYINT(1) NOT NULL DEFAULT 0',
  'SELECT 1');
PREPARE stmt_alter FROM @sql_alter;
EXECUTE stmt_alter;
DEALLOCATE PREPARE stmt_alter;

SET @col_exists = (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE table_schema = DATABASE() AND table_name = 'diesel' AND column_name = 'eliminado_por'
);
SET @sql_alter = IF(@col_exists = 0,
  'ALTER TABLE diesel ADD COLUMN eliminado_por VARCHAR(255) DEFAULT NULL',
  'SELECT 1');
PREPARE stmt_alter FROM @sql_alter;
EXECUTE stmt_alter;
DEALLOCATE PREPARE stmt_alter;

SET @col_exists = (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE table_schema = DATABASE() AND table_name = 'diesel' AND column_name = 'eliminado_en'
);
SET @sql_alter = IF(@col_exists = 0,
  'ALTER TABLE diesel ADD COLUMN eliminado_en DATETIME DEFAULT NULL',
  'SELECT 1');
PREPARE stmt_alter FROM @sql_alter;
EXECUTE stmt_alter;
DEALLOCATE PREPARE stmt_alter;

SET @col_exists = (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE table_schema = DATABASE() AND table_name = 'diesel_entregas' AND column_name = 'eliminado'
);
SET @sql_alter = IF(@col_exists = 0,
  'ALTER TABLE diesel_entregas ADD COLUMN eliminado TINYINT(1) NOT NULL DEFAULT 0',
  'SELECT 1');
PREPARE stmt_alter FROM @sql_alter;
EXECUTE stmt_alter;
DEALLOCATE PREPARE stmt_alter;

SET @col_exists = (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE table_schema = DATABASE() AND table_name = 'diesel_entregas' AND column_name = 'eliminado_por'
);
SET @sql_alter = IF(@col_exists = 0,
  'ALTER TABLE diesel_entregas ADD COLUMN eliminado_por VARCHAR(255) DEFAULT NULL',
  'SELECT 1');
PREPARE stmt_alter FROM @sql_alter;
EXECUTE stmt_alter;
DEALLOCATE PREPARE stmt_alter;

SET @col_exists = (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE table_schema = DATABASE() AND table_name = 'diesel_entregas' AND column_name = 'eliminado_en'
);
SET @sql_alter = IF(@col_exists = 0,
  'ALTER TABLE diesel_entregas ADD COLUMN eliminado_en DATETIME DEFAULT NULL',
  'SELECT 1');
PREPARE stmt_alter FROM @sql_alter;
EXECUTE stmt_alter;
DEALLOCATE PREPARE stmt_alter;

-- ------------------------------------------------------------
-- Permisos del Panel por pestaña (ver requierePermisoPanel_ en
-- server/handlers.js). Guarda un JSON tipo:
--   {"ordenes":"capturar","diesel":"visualizar","usuarios":null,...}
-- Las llaves son: ordenes, diesel, movimientos, maquinaria, catalogo,
-- mantenimiento, refacciones, usuarios. Un valor "capturar" incluye poder
-- ver, capturar/editar Y eliminar en esa pestaña; "visualizar" solo deja
-- ver; si la pestaña no aparece (o su valor es null) esa persona no ve
-- esa pestaña del Panel para nada. Esto es independiente de la columna
-- `modulos` (que sigue controlando el acceso a Reportar/Taller/
-- Movimientos/Panel como apps completas — panel_permisos solo aplica
-- una vez que ya se entró al Panel).
SET @col_exists = (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE table_schema = DATABASE() AND table_name = 'usuarios' AND column_name = 'panel_permisos'
);
SET @sql_alter = IF(@col_exists = 0,
  'ALTER TABLE usuarios ADD COLUMN panel_permisos TEXT DEFAULT NULL',
  'SELECT 1');
PREPARE stmt_alter FROM @sql_alter;
EXECUTE stmt_alter;
DEALLOCATE PREPARE stmt_alter;

-- A quien YA tenía acceso al módulo "Panel" antes de que existiera este
-- control por pestaña, se le da capturar en las 8 pestañas de una vez
-- (para no cortarle el acceso a nadie de golpe al instalar esto) — pero
-- SOLO si todavía no tiene nada configurado en panel_permisos, para no
-- pisar ajustes que ya se hayan hecho a mano si este script se vuelve a
-- correr después.
UPDATE usuarios
SET panel_permisos = '{"ordenes":"capturar","diesel":"capturar","combustible_automotriz":"capturar","movimientos":"capturar","maquinaria":"capturar","catalogo":"capturar","mantenimiento":"capturar","refacciones":"capturar","usuarios":"capturar"}'
WHERE panel_permisos IS NULL
  AND FIND_IN_SET('Panel', REPLACE(modulos, ' ', '')) > 0;

-- Para quien YA tenía panel_permisos configurado desde antes de que
-- existiera "combustible_automotriz" (por eso no entró en el UPDATE de
-- arriba, que solo aplica cuando panel_permisos IS NULL), se le agrega el
-- permiso "capturar" para esta pestaña nueva, sin tocar el resto de lo que
-- ya tenía configurado.
UPDATE usuarios
SET panel_permisos = JSON_SET(panel_permisos, '$.combustible_automotriz', 'capturar')
WHERE panel_permisos IS NOT NULL
  AND JSON_VALID(panel_permisos)
  AND JSON_EXTRACT(panel_permisos, '$.combustible_automotriz') IS NULL;

-- ------------------------------------------------------------
-- Restricción opcional, por usuario, de qué huertas puede ver/editar en la
-- pestaña "Órdenes" del Panel (ver obtenerHuertasRestringidasOrdenes_ en
-- server/handlers.js). Guarda un JSON tipo ["LA CRUZ","NIDO DE AGUILA"].
-- NULL o un arreglo vacío significa "sin restricción": ve las órdenes de
-- todas las huertas, que es el comportamiento de siempre — por eso esto no
-- afecta a nadie que no se configure explícitamente desde la pestaña
-- Usuarios del Panel. Es independiente de `huerta` (esa es la huerta "de
-- origen" de la persona, usada en Reportar/Movimientos; aquí puede ser una
-- lista de varias huertas, usada solo para filtrar Órdenes).
SET @col_exists = (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE table_schema = DATABASE() AND table_name = 'usuarios' AND column_name = 'huertas_ordenes'
);
SET @sql_alter = IF(@col_exists = 0,
  'ALTER TABLE usuarios ADD COLUMN huertas_ordenes TEXT DEFAULT NULL',
  'SELECT 1');
PREPARE stmt_alter FROM @sql_alter;
EXECUTE stmt_alter;
DEALLOCATE PREPARE stmt_alter;

-- ------------------------------------------------------------
-- Restricción opcional, por usuario, de si ve o no el letrero de Órdenes
-- "Reportadas... sin fecha de atención" (ver renderOrdenesSinAtencionReciente_
-- en Panel.html). Se configura por persona desde la pestaña Usuarios del
-- Panel (checkbox "Puede ver el letrero..."). DEFAULT 1 a propósito: nadie
-- pierde la visibilidad que ya tenía antes de que existiera este control —
-- hay que desmarcarlo explícitamente para ocultárselo a alguien.
SET @col_exists = (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE table_schema = DATABASE() AND table_name = 'usuarios' AND column_name = 'ver_letrero_ord_pend'
);
SET @sql_alter = IF(@col_exists = 0,
  'ALTER TABLE usuarios ADD COLUMN ver_letrero_ord_pend TINYINT(1) NOT NULL DEFAULT 1',
  'SELECT 1');
PREPARE stmt_alter FROM @sql_alter;
EXECUTE stmt_alter;
DEALLOCATE PREPARE stmt_alter;

-- ------------------------------------------------------------
-- Varias huertas opcionales por usuario, solo para el formulario Reportar
-- (Index.html) — ver getHuertaPorUsuario/validarUsuario en
-- server/handlers.js. Guarda un JSON tipo ["LA CRUZ","AURORA"]. NULL o un
-- arreglo vacío significa "usa la huerta única de siempre" (columna
-- `huerta`, la que también usan Movimientos/Diesel) — por eso esto no
-- afecta a nadie que no se configure explícitamente desde Usuarios. Si
-- tiene 2+ huertas, Reportar le muestra el desplegable de Huerta
-- restringido a esas (y deja que la persona elija cuál aplica cada vez, en
-- vez de asignarle una fija).
SET @col_exists = (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE table_schema = DATABASE() AND table_name = 'usuarios' AND column_name = 'huertas_reportar'
);
SET @sql_alter = IF(@col_exists = 0,
  'ALTER TABLE usuarios ADD COLUMN huertas_reportar TEXT DEFAULT NULL',
  'SELECT 1');
PREPARE stmt_alter FROM @sql_alter;
EXECUTE stmt_alter;
DEALLOCATE PREPARE stmt_alter;

-- ------------------------------------------------------------
-- Si esta persona ve, al capturar un reporte en Reportar (Index.html), las
-- casillas opcionales "Es trabajo para el Área de Soldadura" / "Es trabajo
-- Automotriz" (ver validarUsuario/getHuertaPorUsuario en
-- server/handlers.js). DEFAULT 0 a propósito: son casillas que solo le
-- sirven a quien de verdad reporta ese tipo de trabajo, así que hay que
-- activarlas a propósito por persona desde Usuarios, en vez de mostrárselas
-- a todo mundo como antes.
SET @col_exists = (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE table_schema = DATABASE() AND table_name = 'usuarios' AND column_name = 've_casilla_soldadura'
);
SET @sql_alter = IF(@col_exists = 0,
  'ALTER TABLE usuarios ADD COLUMN ve_casilla_soldadura TINYINT(1) NOT NULL DEFAULT 0',
  'SELECT 1');
PREPARE stmt_alter FROM @sql_alter;
EXECUTE stmt_alter;
DEALLOCATE PREPARE stmt_alter;

SET @col_exists = (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE table_schema = DATABASE() AND table_name = 'usuarios' AND column_name = 've_casilla_automotriz'
);
SET @sql_alter = IF(@col_exists = 0,
  'ALTER TABLE usuarios ADD COLUMN ve_casilla_automotriz TINYINT(1) NOT NULL DEFAULT 0',
  'SELECT 1');
PREPARE stmt_alter FROM @sql_alter;
EXECUTE stmt_alter;
DEALLOCATE PREPARE stmt_alter;

-- ------------------------------------------------------------
-- Qué cuadros de la pestaña Diesel (Combustible Agrícola) del Panel ve
-- cada persona — Diesel por huerta, por departamento, restante por huerta,
-- entregado a huertas, la tabla general de cargas, Notificaciones y
-- Rendimiento/horas máximas (ver DZ_CUADROS en Panel.html). Es un permiso
-- que asigna el admin desde Usuarios (como huertas_ordenes/huertas_reportar
-- de arriba), no algo que cada quien elige por su cuenta. Guarda un JSON
-- con los ids de los cuadros que esa persona NO debe ver, por ejemplo
-- ["dz-notif-container","dz-rendimiento-container"]. NULL o un arreglo
-- vacío significa "los ve todos" — así que a nadie que no se configure
-- explícitamente desde Usuarios se le oculta nada.
SET @col_exists = (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE table_schema = DATABASE() AND table_name = 'usuarios' AND column_name = 'diesel_cuadros_ocultos'
);
SET @sql_alter = IF(@col_exists = 0,
  'ALTER TABLE usuarios ADD COLUMN diesel_cuadros_ocultos TEXT DEFAULT NULL',
  'SELECT 1');
PREPARE stmt_alter FROM @sql_alter;
EXECUTE stmt_alter;
DEALLOCATE PREPARE stmt_alter;

-- ------------------------------------------------------------
-- Bitácora de auditoría: quién capturó, editó o eliminó cada orden,
-- carga de diesel o movimiento de maquinaria desde el Panel — sobrevive
-- aunque el registro original se borre (por eso es una tabla aparte, no
-- una columna más de reportes/diesel/movimientos_maquinaria).
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS auditoria (
  id           INT AUTO_INCREMENT PRIMARY KEY,
  tabla        VARCHAR(50)  NOT NULL,   -- 'reportes' | 'diesel' | 'movimientos_maquinaria'
  registro     VARCHAR(50)  NOT NULL,   -- folio/orden o id del registro afectado
  accion       VARCHAR(20)  NOT NULL,   -- 'capturar' | 'editar' | 'eliminar'
  usuario      VARCHAR(255) NOT NULL,
  detalle      TEXT         DEFAULT NULL,
  creado_en    TIMESTAMP    DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_auditoria_tabla_registro (tabla, registro),
  INDEX idx_auditoria_usuario (usuario),
  INDEX idx_auditoria_creado_en (creado_en)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ------------------------------------------------------------
-- Rendimiento aceptable (litros por hora de labor) por equipo, para poder
-- marcar en rojo en la pestaña Diesel las capturas cuyo rendimiento salió
-- muy por encima de lo esperado para ese equipo (ver getCargasDiesel /
-- getRendimientoMaquinaria / guardarRendimientoMaquinaria en
-- server/handlers.js). NULL mientras nadie haya configurado un límite
-- para ese equipo (no se marca nada en rojo en ese caso).
-- ------------------------------------------------------------
SET @col_exists = (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE table_schema = DATABASE() AND table_name = 'maquinaria' AND column_name = 'rendimiento_max'
);
SET @sql_alter = IF(@col_exists = 0,
  'ALTER TABLE maquinaria ADD COLUMN rendimiento_max DECIMAL(10,2) DEFAULT NULL',
  'SELECT 1');
PREPARE stmt_alter FROM @sql_alter;
EXECUTE stmt_alter;
DEALLOCATE PREPARE stmt_alter;

-- ------------------------------------------------------------
-- Horas máximas de labor aceptables ENTRE CARGAS, por equipo — mismo criterio
-- que rendimiento_max de arriba, pero comparado contra HorasLabor (la
-- diferencia entre la lectura actual y la anterior) en vez del rendimiento.
-- Pedido por Carlos junto con la tabla de notificaciones de la pestaña
-- Diesel (ver getCargasDiesel / getRendimientoMaquinaria /
-- guardarRendimientoMaquinaria en server/handlers.js). NULL = sin límite
-- configurado para ese equipo.
-- ------------------------------------------------------------
SET @col_exists = (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE table_schema = DATABASE() AND table_name = 'maquinaria' AND column_name = 'horas_max'
);
SET @sql_alter = IF(@col_exists = 0,
  'ALTER TABLE maquinaria ADD COLUMN horas_max DECIMAL(10,2) DEFAULT NULL',
  'SELECT 1');
PREPARE stmt_alter FROM @sql_alter;
EXECUTE stmt_alter;
DEALLOCATE PREPARE stmt_alter;

-- ------------------------------------------------------------
-- "Funciona con diesel": marca qué equipos del catálogo son tractores/retros
-- que sí se cargan con diesel. Es el limitante de qué unidades aparecen para
-- capturar diesel, tanto en el Panel (pestaña Diesel) como en la captura de
-- campo (Index.html) — ver poblarSelectsDiesel() en Panel.html y
-- getUnidadesDieselPermitidas() en server/handlers.js. Empieza en 0/false
-- para todo el catálogo existente; hay que marcarlo manualmente equipo por
-- equipo desde el Catálogo.
-- ------------------------------------------------------------
SET @col_exists = (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE table_schema = DATABASE() AND table_name = 'maquinaria' AND column_name = 'usa_diesel'
);
SET @sql_alter = IF(@col_exists = 0,
  'ALTER TABLE maquinaria ADD COLUMN usa_diesel TINYINT(1) NOT NULL DEFAULT 0',
  'SELECT 1');
PREPARE stmt_alter FROM @sql_alter;
EXECUTE stmt_alter;
DEALLOCATE PREPARE stmt_alter;

-- ------------------------------------------------------------
-- "Usa gasolina": el equivalente a usa_diesel pero para vehículos
-- automotrices (autos/camionetas), que se cargan por separado en la
-- pestaña "Combustible Automotriz" — ver getUnidadesGasolinaPermitidas_ y
-- combustible_automotriz en server/handlers.js. Empieza en 0/false para
-- todo el catálogo existente; se marca manualmente equipo por equipo
-- desde el Catálogo.
-- ------------------------------------------------------------
SET @col_exists = (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE table_schema = DATABASE() AND table_name = 'maquinaria' AND column_name = 'usa_gasolina'
);
SET @sql_alter = IF(@col_exists = 0,
  'ALTER TABLE maquinaria ADD COLUMN usa_gasolina TINYINT(1) NOT NULL DEFAULT 0',
  'SELECT 1');
PREPARE stmt_alter FROM @sql_alter;
EXECUTE stmt_alter;
DEALLOCATE PREPARE stmt_alter;

-- ------------------------------------------------------------
-- "Tipo de combustible" del equipo, para cuando usa_gasolina = 1: algunos
-- vehículos que se capturan en Combustible Automotriz en realidad cargan
-- diesel, no gasolina (por ejemplo camionetas/tortones diesel que antes se
-- hubieran tenido que capturar mezclados con los tractores en Combustible
-- Agrícola). 'gasolina' es el default para no cambiarle nada a lo que ya
-- estaba capturado — se marca equipo por equipo desde el Catálogo. Cada
-- carga de combustible_automotriz copia este valor al guardarse (ver
-- crearCargaGasolinaPanel/editarCargaGasolina/guardarCargasGasolinaLote en
-- server/handlers.js), para que quede registrado en la carga aunque el
-- catálogo cambie después.
-- ------------------------------------------------------------
SET @col_exists = (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE table_schema = DATABASE() AND table_name = 'maquinaria' AND column_name = 'combustible_automotriz_tipo'
);
SET @sql_alter = IF(@col_exists = 0,
  'ALTER TABLE maquinaria ADD COLUMN combustible_automotriz_tipo VARCHAR(10) NOT NULL DEFAULT ''gasolina''',
  'SELECT 1');
PREPARE stmt_alter FROM @sql_alter;
EXECUTE stmt_alter;
DEALLOCATE PREPARE stmt_alter;

-- ------------------------------------------------------------
-- "Placa" (placa vehicular): campo de texto libre para autos/camionetas/
-- camiones, va después de "Serie" tanto en el catálogo (formulario y
-- tabla) como aquí en la tabla. Ver server/scripts/importDatosCamionetas.js
-- para el llenado inicial desde el Excel que Carlos mandó.
-- ------------------------------------------------------------
SET @col_exists = (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE table_schema = DATABASE() AND table_name = 'maquinaria' AND column_name = 'placa'
);
SET @sql_alter = IF(@col_exists = 0,
  'ALTER TABLE maquinaria ADD COLUMN placa VARCHAR(50) DEFAULT NULL AFTER serie',
  'SELECT 1');
PREPARE stmt_alter FROM @sql_alter;
EXECUTE stmt_alter;
DEALLOCATE PREPARE stmt_alter;

-- ------------------------------------------------------------
-- Combustible Automotriz (pestaña aparte de "Combustible Agrícola"/diesel):
-- cargas de gasolina a vehículos automotrices (autos/camionetas), leídas
-- desde la foto del ticket que da la gasolinera. A diferencia de diesel:
--   - no maneja implemento (los autos no llevan implemento).
--   - no pide huerta: el vehículo (y su Departamento, que sale del
--     catálogo por JOIN, igual que en diesel) es suficiente.
--   - sí guarda precio_litro y total, porque el ticket los trae impresos
--     (diesel no los captura porque la bitácora en papel no los trae).
-- "lectura" es el odómetro (en KM, a diferencia del horómetro de diesel).
-- Mismo patrón de borrado suave (eliminado/eliminado_por/eliminado_en) y
-- auditoría (modificado_por/modificado_en) que diesel, desde el arranque,
-- para no tener que ir agregándolos después por ALTER TABLE.
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS combustible_automotriz (
  id               INT AUTO_INCREMENT PRIMARY KEY,
  folio            VARCHAR(20)   NOT NULL UNIQUE,   -- ej. GAS-00001
  codigo_unidad    VARCHAR(50)   NOT NULL,
  unidad           VARCHAR(255)  NOT NULL,
  litros           DECIMAL(10,3) NOT NULL,
  precio_litro     DECIMAL(10,2) DEFAULT NULL,
  total            DECIMAL(10,2) DEFAULT NULL,
  lectura          DECIMAL(12,2) DEFAULT NULL,       -- odómetro, en KM
  nombre           VARCHAR(255)  NOT NULL,           -- quien cargó
  fecha            DATETIME      NOT NULL,
  modificado_por   VARCHAR(255)  DEFAULT NULL,
  modificado_en    DATETIME      DEFAULT NULL,
  eliminado        TINYINT(1)    NOT NULL DEFAULT 0,
  eliminado_por    VARCHAR(255)  DEFAULT NULL,
  eliminado_en     DATETIME      DEFAULT NULL,
  creado_en        TIMESTAMP     DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_ca_codigo_unidad (codigo_unidad)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ------------------------------------------------------------
-- "Tipo de combustible" de cada carga ('gasolina' | 'diesel') — para las
-- unidades automotrices que en realidad cargan diesel (ver
-- maquinaria.combustible_automotriz_tipo, arriba). Se copia del catálogo al
-- guardar la carga, no se recalcula después. 'gasolina' es el default para
-- que todo lo ya capturado (de antes de este cambio) se siga viendo igual.
-- ------------------------------------------------------------
SET @col_exists = (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE table_schema = DATABASE() AND table_name = 'combustible_automotriz' AND column_name = 'tipo_combustible'
);
SET @sql_alter = IF(@col_exists = 0,
  'ALTER TABLE combustible_automotriz ADD COLUMN tipo_combustible VARCHAR(10) NOT NULL DEFAULT ''gasolina''',
  'SELECT 1');
PREPARE stmt_alter FROM @sql_alter;
EXECUTE stmt_alter;
DEALLOCATE PREPARE stmt_alter;

-- ------------------------------------------------------------
-- PREVENTIVOS AGRICOLAS (antes pestaña "Mantenimiento"): las reglas de
-- servicio preventivo pasan de ser por EQUIPO a ser por MODELO — todos los
-- equipos de un mismo modelo (mismo modelos_refacciones.id) comparten la
-- misma regla: mismos filtros, mismos litros de aceite, mismo intervalo en
-- horas. "tipos_preventivo" es el catálogo de tipos de servicio (por ahora
-- PREVENTIVO MOTOR / PREVENTIVO HIDRAULICO, administrable para agregar más
-- después, igual que categorias_refacciones/marcas_refacciones).
--
-- El historial de "último servicio" (fecha + horómetro) de cada EQUIPO ya
-- no vive en la regla (que ahora es compartida por todo un modelo) sino en
-- "mantenimiento_servicios": una fila por cada combinación (regla, equipo)
-- a la que se le da seguimiento. getServiciosMantenimiento (ver
-- server/handlers.js) arma la lista completa cruzando cada regla activa
-- con cada equipo de ese modelo (maquinaria.modelo_id), y esta tabla solo
-- guarda el estado de las que ya tienen algún historial capturado —no hace
-- falta pre-crear una fila por cada combinación posible.
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS tipos_preventivo (
  id             INT AUTO_INCREMENT PRIMARY KEY,
  nombre         VARCHAR(100) NOT NULL,
  creado_en      TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_tipo_preventivo_nombre (nombre)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

INSERT INTO tipos_preventivo (nombre)
SELECT 'PREVENTIVO MOTOR' WHERE NOT EXISTS (SELECT 1 FROM tipos_preventivo WHERE nombre = 'PREVENTIVO MOTOR');
INSERT INTO tipos_preventivo (nombre)
SELECT 'PREVENTIVO HIDRAULICO' WHERE NOT EXISTS (SELECT 1 FROM tipos_preventivo WHERE nombre = 'PREVENTIVO HIDRAULICO');

-- mantenimiento_reglas: se agregan modelo_id/tipo_preventivo_id (una regla
-- nueva siempre es por modelo) y codigo_unidad —que antes era obligatoria
-- porque cada regla era de un solo equipo— se vuelve opcional. Las reglas
-- viejas por equipo se conservan tal cual (con su codigo_unidad, sin
-- modelo_id) y se desactivan más abajo, no se borran: así no se pierden
-- las órdenes que ya se generaron desde ellas.
SET @col_exists = (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE table_schema = DATABASE() AND table_name = 'mantenimiento_reglas' AND column_name = 'modelo_id'
);
SET @sql_alter = IF(@col_exists = 0,
  'ALTER TABLE mantenimiento_reglas ADD COLUMN modelo_id INT DEFAULT NULL',
  'SELECT 1');
PREPARE stmt_alter FROM @sql_alter;
EXECUTE stmt_alter;
DEALLOCATE PREPARE stmt_alter;

SET @col_exists = (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE table_schema = DATABASE() AND table_name = 'mantenimiento_reglas' AND column_name = 'tipo_preventivo_id'
);
SET @sql_alter = IF(@col_exists = 0,
  'ALTER TABLE mantenimiento_reglas ADD COLUMN tipo_preventivo_id INT DEFAULT NULL',
  'SELECT 1');
PREPARE stmt_alter FROM @sql_alter;
EXECUTE stmt_alter;
DEALLOCATE PREPARE stmt_alter;

-- MODIFY COLUMN no falla si se vuelve a correr (a diferencia de ADD
-- COLUMN), así que no necesita el patrón condicional de arriba.
ALTER TABLE mantenimiento_reglas MODIFY COLUMN codigo_unidad VARCHAR(50) DEFAULT NULL;

SET @idx_exists = (
  SELECT COUNT(*) FROM information_schema.STATISTICS
  WHERE table_schema = DATABASE() AND table_name = 'mantenimiento_reglas' AND index_name = 'uq_regla_modelo_tipo'
);
SET @sql_idx = IF(@idx_exists = 0,
  'CREATE UNIQUE INDEX uq_regla_modelo_tipo ON mantenimiento_reglas (modelo_id, tipo_preventivo_id)',
  'SELECT 1');
PREPARE stmt_idx FROM @sql_idx;
EXECUTE stmt_idx;
DEALLOCATE PREPARE stmt_idx;

-- Reglas viejas por equipo (las que ya estaban capturadas antes de este
-- cambio): se desactivan para que de aquí en adelante solo operen las
-- reglas nuevas por modelo. No se borran (quedan de respaldo/consulta), y
-- si alguien las reactiva a mano más tarde, volver a correr schema.sql no
-- las vuelve a desactivar (el WHERE de abajo ya no las alcanza).
UPDATE mantenimiento_reglas
SET activo = 0
WHERE modelo_id IS NULL AND codigo_unidad IS NOT NULL AND activo = 1;

-- mantenimiento_ordenes necesita saber para qué EQUIPO se generó cada
-- orden: antes se sabía indirectamente por la regla (porque cada regla
-- era de un solo equipo); ahora una regla es de un modelo completo y
-- aplica a varios equipos, así que hace falta guardarlo aparte.
SET @col_exists = (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE table_schema = DATABASE() AND table_name = 'mantenimiento_ordenes' AND column_name = 'codigo_unidad'
);
SET @sql_alter = IF(@col_exists = 0,
  'ALTER TABLE mantenimiento_ordenes ADD COLUMN codigo_unidad VARCHAR(50) DEFAULT NULL',
  'SELECT 1');
PREPARE stmt_alter FROM @sql_alter;
EXECUTE stmt_alter;
DEALLOCATE PREPARE stmt_alter;

-- Backfill: en las órdenes que ya existían (generadas cuando la regla
-- todavía era por equipo) el equipo se puede saber a partir de la regla
-- vieja, que sí tenía codigo_unidad. Solo toca las que quedaron sin
-- llenar, así que correr esto varias veces es seguro.
UPDATE mantenimiento_ordenes mo
JOIN mantenimiento_reglas mr ON mr.id = mo.regla_id
SET mo.codigo_unidad = mr.codigo_unidad
WHERE mo.codigo_unidad IS NULL AND mr.codigo_unidad IS NOT NULL;

-- Historial de "último servicio" por EQUIPO. intervalo_override: por si
-- ESTE equipo en particular necesita un intervalo distinto al estándar de
-- su modelo (ej. primer servicio de motor a las 50 horas en vez de las
-- 250 de costumbre) — si es NULL se usa el intervalo de la regla.
CREATE TABLE IF NOT EXISTS mantenimiento_servicios (
  id                 INT AUTO_INCREMENT PRIMARY KEY,
  regla_id           INT NOT NULL,
  codigo_unidad      VARCHAR(50) NOT NULL,
  intervalo_override DECIMAL(10,2) DEFAULT NULL,
  ultima_lectura     DECIMAL(12,2) DEFAULT NULL,
  ultima_fecha       DATE DEFAULT NULL,
  creado_en          TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  actualizado_en     TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_servicio_regla_equipo (regla_id, codigo_unidad),
  INDEX idx_servicios_codigo (codigo_unidad)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ------------------------------------------------------------
-- SERVICIOS AUTOMOTRICES: pedido por Carlos, funciona "igual que
-- Preventivos Agrícolas" pero para vehículos automotrices (camionetas,
-- camiones, autobuses, motos — los que tienen maquinaria.usa_gasolina = 1,
-- el mismo criterio que ya separa Combustible Agrícola de Combustible
-- Automotriz). NO necesita tablas nuevas: mantenimiento_reglas /
-- mantenimiento_servicios / tipos_preventivo ya son genéricas (tipo_
-- periodicidad ya soporta 'kilometros', no solo 'horas') — "Servicios
-- Automotrices" es, en el fondo, el MISMO motor que Preventivos Agrícolas,
-- nada más que la pestaña filtra las reglas/equipos a los automotrices (ver
-- obtenerReglasMantenimiento_/obtenerServiciosMantenimiento_ en
-- server/handlers.js) y usa su propio permiso ('servicios_automotrices',
-- abajo) para poder dárselo a alguien sin darle Preventivos Agrícolas.
--
-- Se precargan los dos tipos de servicio que trae el primer listado que
-- mandó Carlos (SERVICIOS_1.xlsx) — administrable después desde Catálogo o
-- desde el "+ Tipo de preventivo" de la propia pestaña, igual que los tipos
-- agrícolas (PREVENTIVO MOTOR/HIDRAULICO).
-- ------------------------------------------------------------
INSERT INTO tipos_preventivo (nombre)
SELECT 'SERVICIO AGENCIA' WHERE NOT EXISTS (SELECT 1 FROM tipos_preventivo WHERE nombre = 'SERVICIO AGENCIA');
INSERT INTO tipos_preventivo (nombre)
SELECT 'CAMBIO DE ACEITE Y FILTROS' WHERE NOT EXISTS (SELECT 1 FROM tipos_preventivo WHERE nombre = 'CAMBIO DE ACEITE Y FILTROS');

-- A quien ya tenía panel_permisos configurado (ya usa el Panel) se le
-- agrega "capturar" para la pestaña nueva, igual que se hizo cuando se
-- agregó combustible_automotriz/insumos — así no hay que ir a Usuarios a
-- dar de alta el permiso uno por uno para que el Panel no se vea "roto"
-- (pestaña sin acceso) a quien ya podía ver Preventivos Agrícolas. A quien
-- se le quiera quitar, se hace desde Usuarios como cualquier otro permiso.
UPDATE usuarios
SET panel_permisos = JSON_SET(panel_permisos, '$.servicios_automotrices', 'capturar')
WHERE panel_permisos IS NOT NULL
  AND JSON_VALID(panel_permisos)
  AND JSON_EXTRACT(panel_permisos, '$.servicios_automotrices') IS NULL;

-- Permisos independientes por sección de la pestaña Órdenes: hasta ahora
-- "ordenes" controlaba las tres tablas (Agrícola, Soldadura y Automotriz) a
-- la vez. A partir de aquí "ordenes" sigue siendo el de Agrícola/principal,
-- y se agregan "ordenes_soldadura"/"ordenes_automotriz" para poder darle a
-- cada usuario un nivel distinto en cada sección (ej. solo visualizar en
-- Soldadura pero capturar en Agrícola). A quien ya tenía "ordenes"
-- configurado se le COPIA ese mismo nivel a los dos permisos nuevos (no se
-- le da "capturar" a fuerzas, como en los backfills anteriores) para que
-- nadie pierda ni gane acceso de golpe: sigue viendo/editando las tres
-- secciones igual que antes, hasta que alguien le ajuste cada una por su
-- cuenta desde Usuarios.
UPDATE usuarios
SET panel_permisos = JSON_SET(panel_permisos, '$.ordenes_soldadura', JSON_EXTRACT(panel_permisos, '$.ordenes'))
WHERE panel_permisos IS NOT NULL
  AND JSON_VALID(panel_permisos)
  AND JSON_EXTRACT(panel_permisos, '$.ordenes') IS NOT NULL
  AND JSON_EXTRACT(panel_permisos, '$.ordenes_soldadura') IS NULL;

UPDATE usuarios
SET panel_permisos = JSON_SET(panel_permisos, '$.ordenes_automotriz', JSON_EXTRACT(panel_permisos, '$.ordenes'))
WHERE panel_permisos IS NOT NULL
  AND JSON_VALID(panel_permisos)
  AND JSON_EXTRACT(panel_permisos, '$.ordenes') IS NOT NULL
  AND JSON_EXTRACT(panel_permisos, '$.ordenes_automotriz') IS NULL;

-- Mismo patrón que arriba, para las 2 secciones nuevas de Órdenes:
-- "Llantas y Ponches" ("ordenes_llantas") y "Reparaciones con terceros"
-- ("ordenes_terceros"). A quien ya tenía "ordenes" configurado se le copia
-- ese mismo nivel, para que no pierda ni gane acceso de golpe.
UPDATE usuarios
SET panel_permisos = JSON_SET(panel_permisos, '$.ordenes_llantas', JSON_EXTRACT(panel_permisos, '$.ordenes'))
WHERE panel_permisos IS NOT NULL
  AND JSON_VALID(panel_permisos)
  AND JSON_EXTRACT(panel_permisos, '$.ordenes') IS NOT NULL
  AND JSON_EXTRACT(panel_permisos, '$.ordenes_llantas') IS NULL;

UPDATE usuarios
SET panel_permisos = JSON_SET(panel_permisos, '$.ordenes_terceros', JSON_EXTRACT(panel_permisos, '$.ordenes'))
WHERE panel_permisos IS NOT NULL
  AND JSON_VALID(panel_permisos)
  AND JSON_EXTRACT(panel_permisos, '$.ordenes') IS NOT NULL
  AND JSON_EXTRACT(panel_permisos, '$.ordenes_terceros') IS NULL;

-- ------------------------------------------------------------
-- Huertas EXTRA por usuario, además de su huerta única de siempre
-- (columna `huerta`) — ver huertasEfectivasDeFila_/datosReportarUsuario_/
-- getMovimientosDeUsuario/confirmarLlegadaMovimiento/submitMovimientoSalida
-- en server/handlers.js. Guarda un JSON tipo ["LA CRUZ","AURORA"]. NULL o
-- un arreglo vacío significa "sigue teniendo solo su huerta de siempre",
-- igual que antes de este cambio — por eso esto no afecta a nadie que no
-- se configure explícitamente desde Usuarios. A diferencia de
-- huertas_reportar (que solo afecta el desplegable del formulario
-- Reportar), si esta persona queda con 2 o más huertas en total (la única
-- + estas), eso también cambia: qué equipo ve en los selectores de
-- Reportar y Diesel (antes filtrado solo por su huerta única), de qué
-- huertas ve "llegadas pendientes" en Movimientos (antes solo la suya), y
-- que al "Registrar salida" en Movimientos tenga que elegir desde cuál de
-- sus huertas sale (antes era siempre la única).
SET @col_exists = (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE table_schema = DATABASE() AND table_name = 'usuarios' AND column_name = 'huertas_adicionales'
);
SET @sql_alter = IF(@col_exists = 0,
  'ALTER TABLE usuarios ADD COLUMN huertas_adicionales TEXT DEFAULT NULL',
  'SELECT 1');
PREPARE stmt_alter FROM @sql_alter;
EXECUTE stmt_alter;
DEALLOCATE PREPARE stmt_alter;

-- ------------------------------------------------------------
-- Catálogos simples que antes vivían "quemados" en el código del Panel
-- (el arreglo HUERTAS, los botones CAMPO/COSECHA/..., el texto libre de
-- "Tipo de unidad"): ahora se pueden dar de alta/editar/borrar desde la
-- pestaña Catálogo, sin tener que tocar el código cada vez que se abre
-- una huerta nueva o se necesita un departamento nuevo (como TALLER,
-- CARIGEN o LIMONES, que se agregaron a mano justo antes de esto).
--
-- Huerta/Departamento/TipoUnidad se SIGUEN guardando como texto libre en
-- maquinaria/movimientos_maquinaria/diesel/diesel_entregas (igual que
-- antes) — estas tablas solo son la lista de opciones válidas que
-- alimenta los desplegables; no hay llave foránea, así que borrar un
-- valor del catálogo nunca borra ni desliga los datos ya capturados con
-- ese valor.
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS huertas (
  id        INT AUTO_INCREMENT PRIMARY KEY,
  nombre    VARCHAR(100) NOT NULL UNIQUE,
  creado_en TIMESTAMP DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS departamentos (
  id        INT AUTO_INCREMENT PRIMARY KEY,
  nombre    VARCHAR(50) NOT NULL UNIQUE,
  creado_en TIMESTAMP DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS tipos_unidad (
  id        INT AUTO_INCREMENT PRIMARY KEY,
  nombre    VARCHAR(50) NOT NULL UNIQUE,
  creado_en TIMESTAMP DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Precarga con lo que ya se tenía: la lista fija que usaba el Panel, más
-- cualquier valor que ya esté realmente en uso en los datos capturados
-- (por si alguien escribió algo que no estaba en esa lista). INSERT
-- IGNORE hace que correr esto de nuevo no truene ni duplique nada.
INSERT IGNORE INTO huertas (nombre) VALUES
  ('ALMA LUCIA'),('AURORA'),('BRILLANTE'),('GUADALUPE'),('LA CRUZ'),
  ('MATA CAZUELA'),('MATA DE GALLO'),('NIDO DE AGUILA'),('ORGANITO'),
  ('PASO LIMON'),('RANCHO NUEVO'),('SAN CENOVIO'),('SAN JOACHIN'),
  ('SANTA EULALIA'),('TALLER'),('INVERNADERO');
INSERT IGNORE INTO huertas (nombre)
  SELECT DISTINCT UPPER(TRIM(huerta_destino)) FROM movimientos_maquinaria
  WHERE huerta_destino IS NOT NULL AND TRIM(huerta_destino) <> '';
INSERT IGNORE INTO huertas (nombre)
  SELECT DISTINCT UPPER(TRIM(huerta_origen)) FROM movimientos_maquinaria
  WHERE huerta_origen IS NOT NULL AND TRIM(huerta_origen) <> '';
INSERT IGNORE INTO huertas (nombre)
  SELECT DISTINCT UPPER(TRIM(huerta)) FROM diesel
  WHERE huerta IS NOT NULL AND TRIM(huerta) <> '';
INSERT IGNORE INTO huertas (nombre)
  SELECT DISTINCT UPPER(TRIM(huerta)) FROM diesel_entregas
  WHERE huerta IS NOT NULL AND TRIM(huerta) <> '';

INSERT IGNORE INTO departamentos (nombre) VALUES
  ('CAMPO'),('COSECHA'),('PREPARACION'),('TALLER'),('CARIGEN'),('LIMONES');
INSERT IGNORE INTO departamentos (nombre)
  SELECT DISTINCT UPPER(TRIM(departamento)) FROM maquinaria
  WHERE departamento IS NOT NULL AND TRIM(departamento) <> '';

INSERT IGNORE INTO tipos_unidad (nombre)
  SELECT DISTINCT TRIM(tipo_unidad) FROM maquinaria
  WHERE tipo_unidad IS NOT NULL AND TRIM(tipo_unidad) <> '';
INSERT IGNORE INTO tipos_unidad (nombre) VALUES
  ('Tractor'),('Implemento'),('Retro');

-- ------------------------------------------------------------
-- Empresa / Proveedor (de combustible): dos catálogos simples más, mismo
-- molde que huertas/departamentos/tipos_unidad de arriba. Pedido por
-- Carlos para: (a) poder asignarle a cada Huerta una Empresa y un
-- Proveedor (huertas.empresa_id/proveedor_id — aquí SÍ es una relación
-- entre dos catálogos, así que se guarda como ID, igual que
-- modelos_refacciones.marca_id, no como texto libre), y (b) capturar
-- Empresa/Proveedor en cada carga de Combustible Automotriz
-- (combustible_automotriz.empresa/proveedor — aquí sí se guarda como
-- TEXTO libre copiado al momento de capturar, igual que huerta/
-- departamento/implemento en diesel, para que el histórico no cambie si
-- luego se edita o borra el catálogo).
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS empresas (
  id        INT AUTO_INCREMENT PRIMARY KEY,
  nombre    VARCHAR(150) NOT NULL UNIQUE,
  creado_en TIMESTAMP DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS proveedores_combustible (
  id        INT AUTO_INCREMENT PRIMARY KEY,
  nombre    VARCHAR(150) NOT NULL UNIQUE,
  creado_en TIMESTAMP DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Se precargan con el único valor que se ha usado hasta ahora (lo que pidió
-- Carlos), para que ya salgan listos en los desplegables sin tener que
-- darlos de alta a mano.
INSERT IGNORE INTO empresas (nombre) VALUES ('CHULA BRAND MEXICO, S. DE P.R. DE R.L. DE C.V.');
INSERT IGNORE INTO proveedores_combustible (nombre) VALUES ('COMBUSTIBLES DE LA CUENCA DEL PAPALOAPAN');

-- huertas.empresa_id / proveedor_id: opcionales (no todas las huertas
-- necesitan tener una asignada desde el día uno).
SET @col_exists = (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE table_schema = DATABASE() AND table_name = 'huertas' AND column_name = 'empresa_id'
);
SET @sql_alter = IF(@col_exists = 0,
  'ALTER TABLE huertas ADD COLUMN empresa_id INT DEFAULT NULL',
  'SELECT 1');
PREPARE stmt_alter FROM @sql_alter;
EXECUTE stmt_alter;
DEALLOCATE PREPARE stmt_alter;

SET @col_exists = (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE table_schema = DATABASE() AND table_name = 'huertas' AND column_name = 'proveedor_id'
);
SET @sql_alter = IF(@col_exists = 0,
  'ALTER TABLE huertas ADD COLUMN proveedor_id INT DEFAULT NULL',
  'SELECT 1');
PREPARE stmt_alter FROM @sql_alter;
EXECUTE stmt_alter;
DEALLOCATE PREPARE stmt_alter;

-- combustible_automotriz.empresa / proveedor (texto libre, ver comentario
-- de arriba).
SET @col_exists = (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE table_schema = DATABASE() AND table_name = 'combustible_automotriz' AND column_name = 'empresa'
);
SET @sql_alter = IF(@col_exists = 0,
  'ALTER TABLE combustible_automotriz ADD COLUMN empresa VARCHAR(150) DEFAULT NULL',
  'SELECT 1');
PREPARE stmt_alter FROM @sql_alter;
EXECUTE stmt_alter;
DEALLOCATE PREPARE stmt_alter;

SET @col_exists = (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE table_schema = DATABASE() AND table_name = 'combustible_automotriz' AND column_name = 'proveedor'
);
SET @sql_alter = IF(@col_exists = 0,
  'ALTER TABLE combustible_automotriz ADD COLUMN proveedor VARCHAR(150) DEFAULT NULL',
  'SELECT 1');
PREPARE stmt_alter FROM @sql_alter;
EXECUTE stmt_alter;
DEALLOCATE PREPARE stmt_alter;

-- Backfill: pedido explícito de Carlos — todo lo que ya está capturado en
-- Combustible Automotriz (de antes de este cambio) es de esta empresa y
-- este proveedor. Solo llena lo que esté vacío, así que correr esto de
-- nuevo (o dejarlo correr en cada arranque) es seguro y no pisa un valor
-- que ya se haya capturado distinto a mano después.
UPDATE combustible_automotriz
SET empresa = 'CHULA BRAND MEXICO, S. DE P.R. DE R.L. DE C.V.'
WHERE empresa IS NULL OR TRIM(empresa) = '';
UPDATE combustible_automotriz
SET proveedor = 'COMBUSTIBLES DE LA CUENCA DEL PAPALOAPAN'
WHERE proveedor IS NULL OR TRIM(proveedor) = '';

-- ------------------------------------------------------------
-- Insumos: pestaña "Insumos" del Panel — bitácora de lo que van pidiendo
-- los encargados de campo (herramienta, material, fertilizante, etc.),
-- capturada por la capturista. El insumo se elige del catálogo de
-- Refacciones (refaccion_id), pero la descripción y el código se GUARDAN
-- COMO COPIA (insumo_descripcion/insumo_codigo) al momento de capturar o
-- editar, para que el historial no cambie ni quede huérfano si esa
-- refacción se edita o se elimina después del catálogo.
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS insumos_solicitados (
  id                 INT AUTO_INCREMENT PRIMARY KEY,
  folio              VARCHAR(20)  NOT NULL,
  refaccion_id       INT          DEFAULT NULL,
  insumo_descripcion VARCHAR(255) NOT NULL,
  insumo_codigo      VARCHAR(50)  DEFAULT NULL,
  cantidad           DECIMAL(10,2) NOT NULL,
  huerta             VARCHAR(255) NOT NULL,
  encargado          VARCHAR(255) NOT NULL,
  comentario         TEXT DEFAULT NULL,
  estatus            VARCHAR(20) NOT NULL DEFAULT 'pendiente',
  capturado_por      VARCHAR(255) NOT NULL,
  entregado_por      VARCHAR(255) DEFAULT NULL,
  entregado_en       DATETIME DEFAULT NULL,
  modificado_por     VARCHAR(255) DEFAULT NULL,
  modificado_en      DATETIME DEFAULT NULL,
  eliminado          TINYINT(1) NOT NULL DEFAULT 0,
  eliminado_por      VARCHAR(255) DEFAULT NULL,
  eliminado_en       DATETIME DEFAULT NULL,
  creado_en          TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY folio (folio),
  KEY idx_insumos_huerta (huerta),
  KEY idx_insumos_estatus (estatus)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

INSERT INTO contadores (nombre, ultimo) VALUES ('insumo', 0)
  ON DUPLICATE KEY UPDATE nombre = nombre;

-- ------------------------------------------------------------
-- Autorizar + precio por pieza en Insumos (ver marcarInsumoAutorizado en
-- server/handlers.js): nuevo paso opcional "autorizado" entre "pendiente" y
-- "entregado" del estatus de siempre (columna ya existente, sin cambios de
-- tipo — solo empieza a admitir también el valor 'autorizado'), con su
-- propio registro de quién y cuándo, igual que entregado_por/entregado_en.
-- precio_unitario es editable desde el modal normal en cualquier momento
-- (no solo al autorizar), por si ya se sabe el precio desde que se captura
-- la solicitud o hay que corregirlo después.
SET @col_exists = (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE table_schema = DATABASE() AND table_name = 'insumos_solicitados' AND column_name = 'precio_unitario'
);
SET @sql_alter = IF(@col_exists = 0,
  'ALTER TABLE insumos_solicitados ADD COLUMN precio_unitario DECIMAL(10,2) DEFAULT NULL AFTER comentario',
  'SELECT 1');
PREPARE stmt_alter FROM @sql_alter;
EXECUTE stmt_alter;
DEALLOCATE PREPARE stmt_alter;

SET @col_exists = (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE table_schema = DATABASE() AND table_name = 'insumos_solicitados' AND column_name = 'autorizado_por'
);
SET @sql_alter = IF(@col_exists = 0,
  'ALTER TABLE insumos_solicitados ADD COLUMN autorizado_por VARCHAR(255) DEFAULT NULL AFTER capturado_por',
  'SELECT 1');
PREPARE stmt_alter FROM @sql_alter;
EXECUTE stmt_alter;
DEALLOCATE PREPARE stmt_alter;

SET @col_exists = (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE table_schema = DATABASE() AND table_name = 'insumos_solicitados' AND column_name = 'autorizado_en'
);
SET @sql_alter = IF(@col_exists = 0,
  'ALTER TABLE insumos_solicitados ADD COLUMN autorizado_en DATETIME DEFAULT NULL AFTER autorizado_por',
  'SELECT 1');
PREPARE stmt_alter FROM @sql_alter;
EXECUTE stmt_alter;
DEALLOCATE PREPARE stmt_alter;

-- Igual que se hizo con combustible_automotriz: a quien YA tenía
-- panel_permisos configurado (con acceso al Panel) se le agrega "capturar"
-- para la pestaña nueva "insumos", sin tocar el resto de lo que ya tenía
-- configurado. A quien todavía no tenía panel_permisos (usuarios nuevos
-- después de esto) ya le toca por el UPDATE de arriba con el listado
-- completo de pestañas si aplica, o se le asigna a mano desde Usuarios.
UPDATE usuarios
SET panel_permisos = JSON_SET(panel_permisos, '$.insumos', 'capturar')
WHERE panel_permisos IS NOT NULL
  AND JSON_VALID(panel_permisos)
  AND JSON_EXTRACT(panel_permisos, '$.insumos') IS NULL;

-- ------------------------------------------------------------
-- Configuración general: pares clave/valor para ajustes globales del
-- sistema que antes vivían sueltos en localStorage del navegador (y por
-- lo tanto cualquiera podía cambiar desde su propia sesión, y cada quien
-- veía un valor distinto). Al vivir en el servidor, el valor es el mismo
-- para todos y solo se puede cambiar desde el catálogo correspondiente
-- (mismo permiso que el resto de los catálogos: 'maquinaria' o 'catalogo'
-- en nivel "capturar" — ver PESTANAS_CATALOGO_OPERATIVO_ en handlers.js).
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS configuracion_general (
  clave          VARCHAR(100) NOT NULL PRIMARY KEY,
  valor          TEXT,
  modificado_por VARCHAR(255) DEFAULT NULL,
  modificado_en  TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Valor por defecto del letrero "Reportadas en los últimos N días, sin
-- fecha de atención" de la pestaña Órdenes. INSERT IGNORE: si ya existe
-- (porque alguien ya lo cambió desde Catálogo) no se pisa al re-correr
-- este script.
INSERT IGNORE INTO configuracion_general (clave, valor) VALUES ('ord_pend_atencion_dias', '5');

-- Qué tipo de órdenes muestra ese mismo letrero: 'todas' (por defecto),
-- 'preventivos' (solo las generadas automáticamente desde una regla de
-- Mantenimiento preventivo — ver mantenimiento_ordenes) o 'correctivos'
-- (solo las reportadas por una falla, sin regla de mantenimiento detrás).
INSERT IGNORE INTO configuracion_general (clave, valor) VALUES ('ord_pend_atencion_tipo', 'todas');

-- Backfill: acorta la descripción de las órdenes de Mantenimiento preventivo
-- que ya existían desde antes de que crearOrdenDesdeRegla_ (handlers.js)
-- empezara a generarlas como "Preventivo <servicio>" en vez de
-- "Mantenimiento preventivo: <servicio>" (no cabía completo en la columna
-- Descripción de Órdenes). Solo recorta ese prefijo del inicio, conserva
-- tal cual el resto del texto (notas/aceite/comentario en los renglones de
-- abajo). Solo alcanza a las que todavía tengan el prefijo viejo, así que
-- correr esto varias veces es seguro.
UPDATE reportes
SET descripcion = CONCAT('Preventivo ', SUBSTRING(descripcion, LENGTH('Mantenimiento preventivo: ') + 1))
WHERE descripcion LIKE 'Mantenimiento preventivo: %';

-- Corrige el "Preventivo Preventivo..." que dejó el backfill de arriba en
-- las reglas cuyo nombre_servicio ya empezaba con "Preventivo" (varias
-- reglas se capturan así, p. ej. "PREVENTIVO SISTEMA HIDRÁULICO") — ver el
-- mismo ajuste en crearOrdenDesdeRegla_ (handlers.js), que ya no antepone
-- "Preventivo " cuando el nombre del servicio ya lo trae. descripcion usa
-- collation _ci (case-insensitive), así que el LIKE de abajo alcanza
-- "Preventivo PREVENTIVO...", "Preventivo preventivo...", etc. Solo quita
-- la primera repetición, así que correr esto varias veces es seguro.
UPDATE reportes
SET descripcion = SUBSTRING(descripcion, LENGTH('Preventivo ') + 1)
WHERE descripcion LIKE 'Preventivo Preventivo%';

-- ------------------------------------------------------------
-- Catálogo de Operadores (pestaña Catálogo → Catálogos), mismo patrón que
-- huertas/departamentos/tipos_unidad: solo alimenta desplegables, sin
-- llave foránea, así que borrar un operador del catálogo nunca borra ni
-- desliga nada ya capturado con su nombre.
-- Se usa en dos lugares (texto libre, igual que huerta/departamento):
--   - diesel.operador: quién operaba el equipo en esa carga en particular.
--   - maquinaria.operador_asignado: quién opera normalmente ese equipo.
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS operadores (
  id        INT AUTO_INCREMENT PRIMARY KEY,
  nombre    VARCHAR(100) NOT NULL UNIQUE,
  creado_en TIMESTAMP DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

SET @col_exists = (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE table_schema = DATABASE() AND table_name = 'diesel' AND column_name = 'operador'
);
SET @sql_alter = IF(@col_exists = 0,
  'ALTER TABLE diesel ADD COLUMN operador VARCHAR(255) DEFAULT NULL AFTER nombre',
  'SELECT 1');
PREPARE stmt_alter FROM @sql_alter;
EXECUTE stmt_alter;
DEALLOCATE PREPARE stmt_alter;

SET @col_exists = (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE table_schema = DATABASE() AND table_name = 'maquinaria' AND column_name = 'operador_asignado'
);
SET @sql_alter = IF(@col_exists = 0,
  'ALTER TABLE maquinaria ADD COLUMN operador_asignado VARCHAR(255) DEFAULT NULL',
  'SELECT 1');
PREPARE stmt_alter FROM @sql_alter;
EXECUTE stmt_alter;
DEALLOCATE PREPARE stmt_alter;

-- Datos de contacto del operador (dirección/teléfono) y a qué flotilla
-- pertenece ('AGRICOLA' | 'VEHICULAR') — llegaron después del catálogo
-- base de arriba, al importar el primer listado real de operadores.
SET @col_exists = (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE table_schema = DATABASE() AND table_name = 'operadores' AND column_name = 'direccion'
);
SET @sql_alter = IF(@col_exists = 0,
  'ALTER TABLE operadores ADD COLUMN direccion VARCHAR(255) DEFAULT NULL',
  'SELECT 1');
PREPARE stmt_alter FROM @sql_alter;
EXECUTE stmt_alter;
DEALLOCATE PREPARE stmt_alter;

SET @col_exists = (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE table_schema = DATABASE() AND table_name = 'operadores' AND column_name = 'telefono'
);
SET @sql_alter = IF(@col_exists = 0,
  'ALTER TABLE operadores ADD COLUMN telefono VARCHAR(30) DEFAULT NULL',
  'SELECT 1');
PREPARE stmt_alter FROM @sql_alter;
EXECUTE stmt_alter;
DEALLOCATE PREPARE stmt_alter;

SET @col_exists = (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE table_schema = DATABASE() AND table_name = 'operadores' AND column_name = 'flotilla'
);
SET @sql_alter = IF(@col_exists = 0,
  'ALTER TABLE operadores ADD COLUMN flotilla VARCHAR(20) DEFAULT NULL',
  'SELECT 1');
PREPARE stmt_alter FROM @sql_alter;
EXECUTE stmt_alter;
DEALLOCATE PREPARE stmt_alter;

-- ------------------------------------------------------------
-- Odómetro del equipo al salir y al llegar, en un movimiento (ver
-- submitMovimientoSalida/confirmarLlegadaMovimiento/crearMovimientoPanel/
-- editarMovimiento en server/handlers.js). Ambos opcionales y NULL por
-- defecto — no todo equipo tiene odómetro (implementos, por ejemplo), así
-- que nunca es obligatorio capturarlo. Mismo tipo que `lectura` en diesel
-- (DECIMAL(12,2), kilómetros). Con los dos capturados se puede calcular
-- cuánto recorrió el equipo en ese traslado (KmRecorridos), igual que
-- HorasLabor se calcula en Diesel a partir de dos lecturas consecutivas.
SET @col_exists = (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE table_schema = DATABASE() AND table_name = 'movimientos_maquinaria' AND column_name = 'odometro_salida'
);
SET @sql_alter = IF(@col_exists = 0,
  'ALTER TABLE movimientos_maquinaria ADD COLUMN odometro_salida DECIMAL(12,2) DEFAULT NULL',
  'SELECT 1');
PREPARE stmt_alter FROM @sql_alter;
EXECUTE stmt_alter;
DEALLOCATE PREPARE stmt_alter;

SET @col_exists = (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE table_schema = DATABASE() AND table_name = 'movimientos_maquinaria' AND column_name = 'odometro_llegada'
);
SET @sql_alter = IF(@col_exists = 0,
  'ALTER TABLE movimientos_maquinaria ADD COLUMN odometro_llegada DECIMAL(12,2) DEFAULT NULL',
  'SELECT 1');
PREPARE stmt_alter FROM @sql_alter;
EXECUTE stmt_alter;
DEALLOCATE PREPARE stmt_alter;

-- ------------------------------------------------------------
-- Dos secciones nuevas de la pestaña Órdenes, mismo patrón que
-- es_soldadura/es_automotriz (independientes entre sí, ver seccionDeFila_
-- en server/handlers.js para el orden de prioridad cuando más de una
-- bandera está marcada a la vez):
--   es_llantas:  "Llantas y Ponches" — cualquier equipo, sin restricción.
--   es_terceros: "Reparaciones con terceros" — solo se puede marcar si el
--                equipo (maquinaria.codigo_unidad) tiene admite_terceros=1
--                en el catálogo (ver más abajo), validado también en el
--                servidor en crearOrdenPanel/editarOrden.
-- ------------------------------------------------------------
SET @col_exists = (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE table_schema = DATABASE() AND table_name = 'reportes' AND column_name = 'es_llantas'
);
SET @sql_alter = IF(@col_exists = 0,
  'ALTER TABLE reportes ADD COLUMN es_llantas TINYINT(1) NOT NULL DEFAULT 0',
  'SELECT 1');
PREPARE stmt_alter FROM @sql_alter;
EXECUTE stmt_alter;
DEALLOCATE PREPARE stmt_alter;

SET @col_exists = (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE table_schema = DATABASE() AND table_name = 'reportes' AND column_name = 'es_terceros'
);
SET @sql_alter = IF(@col_exists = 0,
  'ALTER TABLE reportes ADD COLUMN es_terceros TINYINT(1) NOT NULL DEFAULT 0',
  'SELECT 1');
PREPARE stmt_alter FROM @sql_alter;
EXECUTE stmt_alter;
DEALLOCATE PREPARE stmt_alter;

-- Costo de la reparación (monto total que cobró el taller/proveedor),
-- opcional, capturado desde el modal de Refaccionamiento de la orden —
-- junto con el listado de piezas necesarias que ya existía, no lo
-- reemplaza. Pensado sobre todo para Llantas/Terceros, pero no se
-- restringe a nivel de base de datos (cualquier orden podría tenerlo).
SET @col_exists = (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE table_schema = DATABASE() AND table_name = 'reportes' AND column_name = 'costo_reparacion'
);
SET @sql_alter = IF(@col_exists = 0,
  'ALTER TABLE reportes ADD COLUMN costo_reparacion DECIMAL(12,2) DEFAULT NULL',
  'SELECT 1');
PREPARE stmt_alter FROM @sql_alter;
EXECUTE stmt_alter;
DEALLOCATE PREPARE stmt_alter;

-- admite_terceros: marca en el catálogo de equipos (Catálogo) qué unidades
-- pueden usar la categoría de Órdenes "Reparaciones con terceros" — ver
-- es_terceros arriba. 0 por defecto (la mayoría de los equipos no aplica).
SET @col_exists = (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE table_schema = DATABASE() AND table_name = 'maquinaria' AND column_name = 'admite_terceros'
);
SET @sql_alter = IF(@col_exists = 0,
  'ALTER TABLE maquinaria ADD COLUMN admite_terceros TINYINT(1) NOT NULL DEFAULT 0',
  'SELECT 1');
PREPARE stmt_alter FROM @sql_alter;
EXECUTE stmt_alter;
DEALLOCATE PREPARE stmt_alter;

-- categoria (catálogo "Tipos de unidad"): 'agricola' o 'automotriz', NULL si
-- todavía no se clasifica. Se usa para decidir sola, sin pedirle nada a
-- quien reporta desde el celular, si un reporte nuevo es de Agrícola o de
-- Automotriz (ver clasificarReporteAutomatico_ en server/handlers.js) —
-- comparando el texto de maquinaria.tipo_unidad contra el nombre de cada
-- tipo de unidad de este catálogo. Un equipo sin tipo de unidad capturado,
-- o cuyo tipo de unidad todavía no tiene categoría asignada aquí, cae en
-- Agrícola/principal (el comportamiento de siempre), no se queda sin orden.
SET @col_exists = (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE table_schema = DATABASE() AND table_name = 'tipos_unidad' AND column_name = 'categoria'
);
SET @sql_alter = IF(@col_exists = 0,
  'ALTER TABLE tipos_unidad ADD COLUMN categoria VARCHAR(20) DEFAULT NULL',
  'SELECT 1');
PREPARE stmt_alter FROM @sql_alter;
EXECUTE stmt_alter;
DEALLOCATE PREPARE stmt_alter;

-- Primer listado real de operadores (flotilla de vehículos/automotriz),
-- importado del Excel que mandó Carlos. INSERT IGNORE: si ya existe un
-- operador con ese nombre (porque alguien ya lo dio de alta a mano, o por
-- si este script se corre otra vez), no se pisa ni se duplica.
INSERT IGNORE INTO operadores (nombre, direccion, telefono, flotilla) VALUES
  ('JOSE ARMIDA GONZALEZ', 'MATA CAZUELA, S/N, SOLEDAD DE DOBLADO, VERACRUZ, CP 94240', '2851099922', 'VEHICULAR'),
  ('GILBERTO DE JESUS GARZA DELGADO', 'FUENTE VIVA 522, FUENTES DE ANAHUAC, SAN NICOLAS GARZA, NUEVO LEON, CP 66444', '80577399', 'VEHICULAR'),
  ('RENE MORENO ANDRADE', 'LOC. LA PROVIDENCIA S/N, LA PROVIDENCIA, COMAPA, VERACRUZ, CP 94200', '2731002092', 'VEHICULAR'),
  ('JOSE FLORENTINO SOSA MONTERO', 'VISTA HERMOSA NORTE S/N, SOLEDAD DE DOBLADO, VERACRUZ, CP 94240', '2851105753', 'VEHICULAR'),
  ('CARLOS MOTA AGUILAR', 'CONOCIDO S/N MATA CAZUELA, SOLEDAD DE DOBLADO, VERACRUZ, CP 94249', '2299141802', 'VEHICULAR'),
  ('JOSE DE JESUS GAMBOA PEREZ', 'VISTA HERMOSA NORTE S/N, SOLEDAD DE DOBLADO, VERACRUZ, CP 64240', '2851080525', 'VEHICULAR'),
  ('JOSE MANUEL GAMBOA BASILIO', 'DOMICILIO CONOCIDO S/N, LAGUNA BLANCA, SOLEDAD DE DOBLADO, VERACRUZ, CP 94240', '2851112083', 'VEHICULAR'),
  ('GUSTAVO MOLINA GUTIERREZ', 'BENITO JUAREZ S/N, SOLEDAD DE DOBLADO, VERACRUZ, CP 94230', '2731138752', 'VEHICULAR'),
  ('JUAN CARLOS SANDOVAL GONZALEZ', 'AV TEODORO RICON PEÑA # S/N, LOC. PASO LAGARTOS, SOLEDAD DE DOBLADO, VERACRUZ, CP 94240', '2299600279', 'VEHICULAR'),
  ('RUBEN ROSAS MACIAS', 'COLIMA, COLIMA', '3131369649', 'VEHICULAR'),
  ('JAIME FORTOZO USCANGA', 'SAN  CENOBIO, SAN CENOBIO, SOLEDAD DE DOBLADO, VERACRUZ, CP 94240', '2851083903', 'VEHICULAR'),
  ('JUAN CARLOS MOTA HERNANDEZ', 'LOC. MATA CAZUELA S/N, MATA CAZUELA, SOLEDAD DE DOBLADO, VERACRUZ, CP 94249', '2299180214', 'VEHICULAR'),
  ('LUIS DIEGO UREÑA SOLIS', 'VERACRUZ, VERACRUZ, CP 94292', '2292668531', 'VEHICULAR'),
  ('JOSE HERNAN ARMIDA CRUZ', 'VERACRUZ, VERACRUZ, VERACRUZ, CP 91780', NULL, 'VEHICULAR'),
  ('MARCOS ANTONIO MOTA AGUILAR', 'MATACAZUELA S/N, SOLEDAD DE DOBLADO, VERACRUZ, CP 94249', '2291904116', 'VEHICULAR'),
  ('JESUS OCHOA ORTEGA', 'LOC LOMA BONITA S/N, LOC. LOMA BONITA, SOLEDAD DE DOBLADO, VERACRUZ, CP 94240', '2851051311', 'VEHICULAR'),
  ('ADOLFO MARTINEZ LOPEZ', 'VICENTE GUERRERO, VICENTE GUERRERO, TIERRA BLANCA, VERACRUZ, CP 95100', '2741361294', 'VEHICULAR'),
  ('JULIAN RODRIGUEZ CAPISTRAN', 'MATA CAZUELA, MATA CAZUELA, SOLEDAD DE DOBLADO, VERACRUZ, CP 94249', '2293924721', 'VEHICULAR'),
  ('FRANCISCA VELAZQUEZ DOMINGUEZ', 'SOLEDAD DE DOBLADO, VERACRUZ', NULL, 'VEHICULAR'),
  ('CARLOS FRANCISCO CANUL --', 'GEO PINOS, VERACRUZ', NULL, 'VEHICULAR'),
  ('JAVIER ESTRADA MATA', NULL, NULL, 'VEHICULAR'),
  ('JOSE POLICARPIO RODRIGUEZ PAREDES', NULL, NULL, 'VEHICULAR'),
  ('JUVENCIO MORENO GUERRERO', 'LAS ADELITAS 5 B, 20 DE NOVIEMBRE, CORDOBA, VERACRUZ, CP 94487', '2321262831', 'VEHICULAR'),
  ('FRANCISCO HUERTA FLORES', NULL, NULL, 'VEHICULAR'),
  ('ALVARO IBARRA ALARCON', NULL, NULL, 'VEHICULAR'),
  ('OLGA FERNANDEZ SOSA', NULL, NULL, 'VEHICULAR'),
  ('EDDI ACEVEDO GONZAGA', 'LOC CERRO ALTO, CERRO ALTA, COTAXTLA, VERACRUZ, CP 94990', '2781182519', 'VEHICULAR'),
  ('JOSE ALBERTO MARTINEZ ORDOÑEZ', NULL, NULL, 'VEHICULAR'),
  ('MARTIN JIMENEZ GONZALEZ', 'MIRADOR DE SANTA ROSA, SOLEDAD DE DOBLADO, VERACRUZ, CP 94240', NULL, 'VEHICULAR'),
  ('CANDELARIO GONZAGA VAZQUEZ', 'TINAJAS, COTAXTLA, VERACRUZ', NULL, 'VEHICULAR'),
  ('MIGUEL ANGEL SOSA MONTERO', NULL, NULL, 'VEHICULAR'),
  ('JOSE ALEJANDRO JIMENEZ HERNANDEZ', NULL, NULL, 'VEHICULAR'),
  ('VICTOR MANUEL CRUZ MARTINEZ', 'DOS DE ABRIL, SOELDAD DE DOBLADO, VER', '2851088427', 'VEHICULAR'),
  ('JESUS IVAN DE LA HOZ CARMONA', 'PURGA, VER', NULL, 'VEHICULAR'),
  ('AMADOR PALACIOS GARCIA', 'LOMA DEL NACHE, VER', NULL, 'VEHICULAR'),
  ('RODRIGO VAZQUEZ VALLEJOS', 'LOS CARRILES, COTAXTLA, TINAJA, VERACRUZ, CP 94990', '2851634949', 'VEHICULAR'),
  ('KARLA SELENE FORSTALL SOSA', NULL, '2292447411', 'VEHICULAR'),
  ('CARLOS ANTONIO CONTRERAS MEZA', NULL, NULL, 'VEHICULAR'),
  ('RAFAEL MARTINEZ ROSAS', NULL, NULL, 'VEHICULAR'),
  ('LUIS ALBERTO VAZQUEZ ACEVEDO', NULL, NULL, 'VEHICULAR'),
  ('ANDRES ROMERO NAVARRO', NULL, NULL, 'VEHICULAR'),
  ('JHOSMAR FIGUEROA VASQUEZ', NULL, NULL, 'VEHICULAR'),
  ('LAURO RENTERAL RENTERAL', NULL, NULL, 'VEHICULAR'),
  ('MONTSERRAT REYES CORTES', NULL, NULL, 'VEHICULAR'),
  ('SERGIO MARTINEZ ORTIZ', NULL, NULL, 'VEHICULAR'),
  ('LUIS GERARDO RODRIGUEZ ROSAS', NULL, NULL, 'VEHICULAR'),
  ('NANCY HERNANDEZ CAMACHO', NULL, NULL, 'VEHICULAR'),
  ('CINTHIA CECILIA BACAB', NULL, NULL, 'VEHICULAR');

-- ------------------------------------------------------------
-- Avance de huerta: nueva pestaña en el celular (Index.html) donde el
-- operador va marcando, en vivo y sobre un mapa de la huerta, el avance de
-- su recorrido (ver clasificarReporteAutomatico_ más arriba para un
-- comentario de cómo se agregan funciones nuevas -- este es un apartado
-- totalmente nuevo, no una extensión de reportes de fallas).
--
-- Cómo funciona (ver server/handlers.js: guardarImagenMapaHuerta,
-- guardarCalibracionMapaHuerta, iniciarAvance, agregarPuntoAvance,
-- terminarAvance, getAvanceHuerta):
--   1) Carlos sube, desde el Panel (Catálogo → Huertas), una imagen del
--      mapa/croquis de la huerta -- se guarda en huertas.mapa_url.
--   2) Alguien con permiso ("avance_huerta" en capturar) calibra ese mapa
--      desde el celular: camina a 2 puntos reconocibles de la huerta, en
--      cada uno toca ese punto en la imagen Y aprieta un botón para que el
--      celular capture su propia ubicación GPS -- quedan 2 parejas
--      punto-en-imagen ↔ coordenada GPS real (mapa_cal1_*/mapa_cal2_*).
--      Con esas 2 parejas se puede calcular, para cualquier coordenada GPS
--      nueva, en qué punto de la imagen debería pintarse (ver
--      gpsAPosicionEnMapa_ en public/Index.html y public/Panel.html).
--   3) Cualquier operador logueado (mismo nivel de confianza que
--      submitReporte -- sin permiso especial de Panel) puede iniciar un
--      registro de avance (avance_huerta), que mientras esté abierto va
--      acumulando puntos GPS (avance_huerta_puntos) conforme camina con la
--      página abierta y la pantalla encendida.
--   4) El avance pintado se acumula para siempre sobre el mismo mapa de
--      cada huerta (sin botón de reiniciar) -- así se pidió explícitamente.
--
-- mapa_cal1_x/mapa_cal1_y (y cal2) son FRACCIÓN del ANCHO de la imagen (no
-- del alto) para los dos ejes -- a propósito, para que la unidad sea
-- isométrica (un mismo tamaño en X que en Y) sin importar que la imagen no
-- sea cuadrada, que es lo que necesita la transformación de
-- escala+rotación de gpsAPosicionEnMapa_.
-- ------------------------------------------------------------
SET @col_exists = (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE table_schema = DATABASE() AND table_name = 'huertas' AND column_name = 'mapa_url'
);
SET @sql_alter = IF(@col_exists = 0,
  'ALTER TABLE huertas ADD COLUMN mapa_url VARCHAR(500) DEFAULT NULL',
  'SELECT 1');
PREPARE stmt_alter FROM @sql_alter;
EXECUTE stmt_alter;
DEALLOCATE PREPARE stmt_alter;

SET @col_exists = (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE table_schema = DATABASE() AND table_name = 'huertas' AND column_name = 'mapa_cal1_x'
);
SET @sql_alter = IF(@col_exists = 0,
  'ALTER TABLE huertas ADD COLUMN mapa_cal1_x DECIMAL(7,5) DEFAULT NULL, ADD COLUMN mapa_cal1_y DECIMAL(7,5) DEFAULT NULL, ADD COLUMN mapa_cal1_lat DECIMAL(10,7) DEFAULT NULL, ADD COLUMN mapa_cal1_lng DECIMAL(10,7) DEFAULT NULL, ADD COLUMN mapa_cal2_x DECIMAL(7,5) DEFAULT NULL, ADD COLUMN mapa_cal2_y DECIMAL(7,5) DEFAULT NULL, ADD COLUMN mapa_cal2_lat DECIMAL(10,7) DEFAULT NULL, ADD COLUMN mapa_cal2_lng DECIMAL(10,7) DEFAULT NULL',
  'SELECT 1');
PREPARE stmt_alter FROM @sql_alter;
EXECUTE stmt_alter;
DEALLOCATE PREPARE stmt_alter;

-- Un "registro de avance" = desde que un operador aprieta "Iniciar" hasta
-- que aprieta "Terminar" (fecha_fin queda NULL mientras sigue abierto).
CREATE TABLE IF NOT EXISTS avance_huerta (
  id            INT AUTO_INCREMENT PRIMARY KEY,
  huerta        VARCHAR(255) NOT NULL,
  nombre        VARCHAR(255) NOT NULL,
  trabajo       VARCHAR(255) DEFAULT NULL,
  porcentaje    DECIMAL(5,2) DEFAULT NULL,
  fecha_inicio  DATETIME NOT NULL,
  fecha_fin     DATETIME DEFAULT NULL,
  creado_en     TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_avance_huerta_huerta (huerta)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- La trayectoria GPS real de cada registro de avance -- un punto cada vez
-- que el celular reporta una nueva posición mientras el registro está
-- abierto. Sin llave foránea hacia avance_huerta (mismo criterio que el
-- resto del proyecto: no hay FK entre tablas, solo columnas con índice).
CREATE TABLE IF NOT EXISTS avance_huerta_puntos (
  id            INT AUTO_INCREMENT PRIMARY KEY,
  avance_id     INT NOT NULL,
  lat           DECIMAL(10,7) NOT NULL,
  lng           DECIMAL(10,7) NOT NULL,
  capturado_en  DATETIME NOT NULL,
  INDEX idx_avance_puntos_avance (avance_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ancla_lat/ancla_lng (oct-2026): último punto del recorrido desde el que
-- se midió avance en los cuadros. El avance solo se mide cuando el
-- tractor ya se alejó AVANCE_TRAMO_MINIMO_METROS (15 m) de este punto, en
-- vez de entre cada par de puntos seguidos (el celular manda uno cada
-- 3 m), para que el "bailoteo" normal del GPS no infle las pasadas. Ver
-- marcarCuadrosCompletadosPorPunto_ en handlers.js.
SET @col_exists = (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE table_schema = DATABASE() AND table_name = 'avance_huerta' AND column_name = 'ancla_lat'
);
SET @sql_alter = IF(@col_exists = 0,
  'ALTER TABLE avance_huerta ADD COLUMN ancla_lat DECIMAL(10,7) DEFAULT NULL, ADD COLUMN ancla_lng DECIMAL(10,7) DEFAULT NULL',
  'SELECT 1');
PREPARE stmt_alter FROM @sql_alter;
EXECUTE stmt_alter;
DEALLOCATE PREPARE stmt_alter;

-- id_local / ultimo_seq (oct-2026, modo SIN SEÑAL): el celular crea cada
-- recorrido con su propio identificador (id_local) y numera sus puntos
-- GPS (1, 2, 3...). Los manda cuando hay señal con sincronizarAvance
-- (handlers.js); ultimo_seq es el último punto ya guardado, así que si un
-- envío se repite (se cortó la señal a medias) no se duplica nada.
SET @col_exists = (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE table_schema = DATABASE() AND table_name = 'avance_huerta' AND column_name = 'id_local'
);
SET @sql_alter = IF(@col_exists = 0,
  'ALTER TABLE avance_huerta ADD COLUMN id_local VARCHAR(64) DEFAULT NULL, ADD COLUMN ultimo_seq INT NOT NULL DEFAULT 0, ADD UNIQUE INDEX uq_avance_id_local (id_local)',
  'SELECT 1');
PREPARE stmt_alter FROM @sql_alter;
EXECUTE stmt_alter;
DEALLOCATE PREPARE stmt_alter;

-- ------------------------------------------------------------
-- Cuadros (lotes numerados) y actividades planeadas por cuadro
-- ------------------------------------------------------------
-- Un "cuadro" es un lote/parcela real de la huerta (p.ej. "CUADRO 5").
-- Carlos lo dibuja desde el Panel con el mapa de Google (satelital, con
-- zoom) -- NO sobre la foto subida -- marcando el contorno completo del
-- lote con varios clics (un polígono), no solo un punto. El polígono se
-- guarda en GPS real (lat/lng de cada vértice, en el orden en que se
-- dibujó) como JSON: [{"lat":19.1,"lng":-96.1}, ...] -- al venir de Google
-- Maps ya son coordenadas reales, no hace falta ninguna calibración para
-- esto (a diferencia de mapa_cal1_*/mapa_cal2_* de arriba, que es para
-- proyectar GPS sobre la FOTO).
--
-- La detección de "el operador pasó por este cuadro" (ver
-- puntoDentroDePoligono_/marcarCuadrosCompletadosPorPunto_ en
-- server/handlers.js) compara la posición GPS real del operador contra
-- este polígono directamente -- sin pasar por la foto ni su calibración.
-- Para que el operador (y Carlos, en la vista de Avance) vean el contorno
-- del cuadro DIBUJADO ENCIMA de la foto, cada vértice del polígono se
-- proyecta a un pixel de la foto usando la calibración de la huerta (si ya
-- está calibrada) -- ver ahDibujarCuadros_/avanceDibujarCuadros_.
--
-- Sobre cada cuadro, Carlos asigna "actividades" (trabajo pendiente). Una
-- actividad se marca sola como completada -- sin que el operador toque
-- nada -- en cuanto el recorrido GPS que ya se guarda en
-- avance_huerta_puntos entra al polígono del cuadro (o pasa muy cerca de
-- su borde, con margen de tolerancia por la imprecisión normal del GPS de
-- un celular). También se revisa el histórico ya guardado al crear una
-- actividad nueva, por si el operador ya había pasado por ese cuadro antes
-- de que existiera la actividad.
--
-- Sin llaves foráneas (mismo criterio que el resto del proyecto): la
-- relación de huerta_actividades hacia huerta_cuadros es solo la columna
-- cuadro_id, con índice.
CREATE TABLE IF NOT EXISTS huerta_cuadros (
  id          INT AUTO_INCREMENT PRIMARY KEY,
  huerta      VARCHAR(255) NOT NULL,
  nombre      VARCHAR(255) NOT NULL,
  poligono    JSON NOT NULL,
  creado_en   TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_huerta_cuadros_huerta (huerta),
  UNIQUE KEY uq_huerta_cuadros_nombre (huerta, nombre)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Si esta tabla ya se había creado en una versión anterior (con columnas
-- x/y de un solo punto en vez de poligono), se actualiza aquí -- cambio
-- esperado solo en instalaciones donde ya se había probado esa primera
-- versión del marcado de cuadros.
SET @col_exists = (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE table_schema = DATABASE() AND table_name = 'huerta_cuadros' AND column_name = 'x'
);
SET @sql_alter = IF(@col_exists > 0,
  'ALTER TABLE huerta_cuadros ADD COLUMN poligono JSON NULL, DROP COLUMN x, DROP COLUMN y',
  'SELECT 1');
PREPARE stmt_alter FROM @sql_alter;
EXECUTE stmt_alter;
DEALLOCATE PREPARE stmt_alter;
-- poligono pudo haber quedado NULL para filas que ya existían antes de
-- este cambio (cuadros marcados con la versión anterior, de un punto) --
-- se borran: ya no tienen una forma válida que dibujar ni usar para
-- detectar, y Carlos los vuelve a marcar (ahora como polígono) desde el
-- mapa de Google.
DELETE FROM huerta_cuadros WHERE poligono IS NULL;

-- surcos: número REAL de surcos de ese cuadro (opcional). Petición de
-- Carlos: medir qué tanto se ha avanzado DENTRO de un cuadro (p.ej. "la
-- mitad de un surco de 10 = 5%") en vez de marcarlo completado con que el
-- operador pase por cualquier parte. Si queda NULL (no capturado), ese
-- cuadro se sigue comportando exactamente como antes: cualquier punto
-- dentro del polígono completa de inmediato todas sus actividades
-- pendientes. Ver calcularDistanciaTotalEsperadaMetros_ en handlers.js.
SET @col_exists = (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE table_schema = DATABASE() AND table_name = 'huerta_cuadros' AND column_name = 'surcos'
);
SET @sql_alter = IF(@col_exists = 0,
  'ALTER TABLE huerta_cuadros ADD COLUMN surcos INT NULL',
  'SELECT 1');
PREPARE stmt_alter FROM @sql_alter;
EXECUTE stmt_alter;
DEALLOCATE PREPARE stmt_alter;

-- direccion_surcos (oct-2026): rumbo de los surcos del cuadro, en grados
-- desde el norte en el sentido del reloj (0 a 180), a partir de la línea
-- que Carlos traza sobre una hilera en el Panel. Si está capturado, solo
-- cuenta como avance el recorrido que va a lo largo de los surcos (hasta
-- 20° de desviación) -- ver avanceDeTramo_ en handlers.js. NULL = sin
-- dirección (cuenta en cualquier dirección, como antes).
SET @col_exists = (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE table_schema = DATABASE() AND table_name = 'huerta_cuadros' AND column_name = 'direccion_surcos'
);
SET @sql_alter = IF(@col_exists = 0,
  'ALTER TABLE huerta_cuadros ADD COLUMN direccion_surcos DECIMAL(6,2) NULL',
  'SELECT 1');
PREPARE stmt_alter FROM @sql_alter;
EXECUTE stmt_alter;
DEALLOCATE PREPARE stmt_alter;

-- estado: 'pendiente' -> 'completado' (pasa solo, por GPS; ver arriba).
-- avance_id queda NULL hasta que se completa, y entonces guarda a qué
-- registro de avance_huerta (qué recorrido) se le atribuye la completada.
-- intervalo_surcos: cada cuántos surcos del cuadro cuenta esta actividad
-- en particular como "una pasada" (1 = cada surco, 2 = cada dos surcos,
-- etc. -- p.ej. un implemento que abarca 2 surcos a la vez solo necesita
-- la mitad de las pasadas que una actividad que sí requiere pasar surco
-- por surco). avance_metros: cuántos metros lleva recorridos el operador
-- DENTRO del cuadro, acumulados entre todas sus sesiones de avance (se
-- compara contra lo esperado -- ver calcularDistanciaTotalEsperadaMetros_
-- en handlers.js -- para calcular el % y para completarla sola).
CREATE TABLE IF NOT EXISTS huerta_actividades (
  id              INT AUTO_INCREMENT PRIMARY KEY,
  huerta          VARCHAR(255) NOT NULL,
  cuadro_id       INT NOT NULL,
  trabajo         VARCHAR(255) NOT NULL,
  estado          VARCHAR(20) NOT NULL DEFAULT 'pendiente',
  intervalo_surcos DECIMAL(5,2) NOT NULL DEFAULT 1,
  avance_metros   DECIMAL(10,2) NOT NULL DEFAULT 0,
  avance_pasadas  DECIMAL(10,4) NOT NULL DEFAULT 0,
  creado_por      VARCHAR(255) DEFAULT NULL,
  creado_en       TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  completado_en   DATETIME DEFAULT NULL,
  avance_id       INT DEFAULT NULL,
  INDEX idx_huerta_actividades_huerta (huerta),
  INDEX idx_huerta_actividades_cuadro (cuadro_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

SET @col_exists = (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE table_schema = DATABASE() AND table_name = 'huerta_actividades' AND column_name = 'intervalo_surcos'
);
SET @sql_alter = IF(@col_exists = 0,
  'ALTER TABLE huerta_actividades ADD COLUMN intervalo_surcos DECIMAL(5,2) NOT NULL DEFAULT 1',
  'SELECT 1');
PREPARE stmt_alter FROM @sql_alter;
EXECUTE stmt_alter;
DEALLOCATE PREPARE stmt_alter;

SET @col_exists = (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE table_schema = DATABASE() AND table_name = 'huerta_actividades' AND column_name = 'avance_metros'
);
SET @sql_alter = IF(@col_exists = 0,
  'ALTER TABLE huerta_actividades ADD COLUMN avance_metros DECIMAL(10,2) NOT NULL DEFAULT 0',
  'SELECT 1');
PREPARE stmt_alter FROM @sql_alter;
EXECUTE stmt_alter;
DEALLOCATE PREPARE stmt_alter;

-- avance_pasadas (oct-2026): cuántas "atravesadas" lleva la actividad en
-- su cuadro (1 = un surco recorrido de orilla a orilla; ver
-- avanceDeTramo_ en handlers.js). El % es avance_pasadas / pasadas
-- necesarias (surcos / intervalo_surcos) -- p.ej. 4 de 33 = 12.12%.
-- Reemplaza a avance_metros para el % (los metros se siguen guardando
-- solo como referencia).
SET @col_exists = (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE table_schema = DATABASE() AND table_name = 'huerta_actividades' AND column_name = 'avance_pasadas'
);
SET @sql_alter = IF(@col_exists = 0,
  'ALTER TABLE huerta_actividades ADD COLUMN avance_pasadas DECIMAL(10,4) NOT NULL DEFAULT 0',
  'SELECT 1');
PREPARE stmt_alter FROM @sql_alter;
EXECUTE stmt_alter;
DEALLOCATE PREPARE stmt_alter;

-- ------------------------------------------------------------
-- Qué pestañas del celular (Index.html: Reportar/Cargar Diesel/
-- Movimientos/Mis Reportes/Avance Huerta) NO debe ver esta persona. Es un
-- permiso aparte de panel_permisos (ese es solo para el Panel de
-- escritorio) y lo asigna el admin desde Usuarios, igual que
-- diesel_cuadros_ocultos. Guarda un JSON con los ids de las pestañas
-- ocultas, por ejemplo ["diesel","movimientos"] (ids: form/diesel/
-- movimientos/misreportes/avance). NULL o un arreglo vacío significa "las
-- ve todas" -- así que a nadie que no se configure explícitamente desde
-- Usuarios se le oculta nada (se sigue viendo exactamente igual que
-- siempre).
SET @col_exists = (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE table_schema = DATABASE() AND table_name = 'usuarios' AND column_name = 'pestanas_celular_ocultas'
);
SET @sql_alter = IF(@col_exists = 0,
  'ALTER TABLE usuarios ADD COLUMN pestanas_celular_ocultas TEXT DEFAULT NULL',
  'SELECT 1');
PREPARE stmt_alter FROM @sql_alter;
EXECUTE stmt_alter;
DEALLOCATE PREPARE stmt_alter;

-- ------------------------------------------------------------
-- A qué USUARIO de la app (cuenta de Usuarios, no el catálogo libre de
-- Operadores de arriba) está asignado este equipo -- petición de Carlos:
-- que el operador que entra a la app, en cualquier pestaña (Reportar,
-- Cargar Diesel, Movimientos, Avance Huerta), solo pueda elegir el equipo
-- que tiene asignado. Se configura desde Maquinaria (ver
-- getUsuariosOperadoresApp/guardarMaquinaria en server/handlers.js), eligiendo
-- de la lista de personas que ya tienen cuenta para entrar a la app -- a
-- propósito un campo separado de `operador_asignado` (ese es el catálogo
-- libre que ya existía, para Diesel/Taller, y no necesariamente coincide
-- con el nombre de usuario de la app). NULL (nadie asignado a ese equipo,
-- o el operador no tiene ningún equipo con su nombre aquí) significa "sin
-- restricción" -- ve todo el equipo, igual que siempre (ver
-- recomputarUnidadesFiltradas en Index.html).
SET @col_exists = (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE table_schema = DATABASE() AND table_name = 'maquinaria' AND column_name = 'usuario_asignado_app'
);
SET @sql_alter = IF(@col_exists = 0,
  'ALTER TABLE maquinaria ADD COLUMN usuario_asignado_app VARCHAR(255) DEFAULT NULL',
  'SELECT 1');
PREPARE stmt_alter FROM @sql_alter;
EXECUTE stmt_alter;
DEALLOCATE PREPARE stmt_alter;

-- ------------------------------------------------------------
-- Catálogo de actividades de Avance Huerta -- petición de Carlos: en vez
-- de escribir el "trabajo" (y su intervalo de surcos) cada vez que se
-- asigna a un cuadro, se da de alta UNA VEZ en este catálogo (ej. "Poda",
-- cada 2 surcos) y después se asigna, de un jalón, a los cuadros que se
-- quieran -- ver getActividadesCatalogo/guardarActividadCatalogo/
-- asignarActividadCatalogoACuadros en server/handlers.js. El intervalo de
-- surcos vive aquí, en la actividad del catálogo, no por cada cuadro al
-- que se asigna (así lo pidió Carlos).
CREATE TABLE IF NOT EXISTS actividades_catalogo (
  id               INT AUTO_INCREMENT PRIMARY KEY,
  huerta           VARCHAR(255) NOT NULL,
  trabajo          VARCHAR(255) NOT NULL,
  intervalo_surcos DECIMAL(5,2) NOT NULL DEFAULT 1,
  creado_por       VARCHAR(255) DEFAULT NULL,
  creado_en        TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_actividades_catalogo_huerta (huerta)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- "Cada cuántos surcos" acepta medios desde oct-2026 (0.5 = pasar 2 veces
-- por cada surco, petición de Carlos): intervalo_surcos pasa de INT a
-- DECIMAL(5,2) en las 2 tablas que lo usan. Solo cambia el tipo si todavía
-- es entero; los valores que ya existían (1, 2, ...) se quedan igual.
SET @es_entero = (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE table_schema = DATABASE() AND table_name = 'actividades_catalogo' AND column_name = 'intervalo_surcos' AND DATA_TYPE = 'int'
);
SET @sql_alter = IF(@es_entero = 1,
  'ALTER TABLE actividades_catalogo MODIFY COLUMN intervalo_surcos DECIMAL(5,2) NOT NULL DEFAULT 1',
  'SELECT 1');
PREPARE stmt_alter FROM @sql_alter;
EXECUTE stmt_alter;
DEALLOCATE PREPARE stmt_alter;
SET @es_entero = (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE table_schema = DATABASE() AND table_name = 'huerta_actividades' AND column_name = 'intervalo_surcos' AND DATA_TYPE = 'int'
);
SET @sql_alter = IF(@es_entero = 1,
  'ALTER TABLE huerta_actividades MODIFY COLUMN intervalo_surcos DECIMAL(5,2) NOT NULL DEFAULT 1',
  'SELECT 1');
PREPARE stmt_alter FROM @sql_alter;
EXECUTE stmt_alter;
DEALLOCATE PREPARE stmt_alter;

-- De qué actividad del catálogo viene esta fila de huerta_actividades (la
-- asignación concreta a un cuadro). `trabajo`/`intervalo_surcos` en
-- huerta_actividades se quedan como respaldo (se copian del catálogo al
-- momento de asignar, y así sigue funcionando todo lo que ya los lee: el
-- cálculo de avance, la tabla de actividades, etc.) -- NULL = fila vieja,
-- creada antes de que existiera el catálogo (o asignada sin pasar por él),
-- se sigue viendo exactamente igual que siempre.
SET @col_exists = (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE table_schema = DATABASE() AND table_name = 'huerta_actividades' AND column_name = 'actividad_catalogo_id'
);
SET @sql_alter = IF(@col_exists = 0,
  'ALTER TABLE huerta_actividades ADD COLUMN actividad_catalogo_id INT DEFAULT NULL',
  'SELECT 1');
PREPARE stmt_alter FROM @sql_alter;
EXECUTE stmt_alter;
DEALLOCATE PREPARE stmt_alter;

-- ------------------------------------------------------------
-- Planificación de trabajo (huerta_actividades): a qué EQUIPO (tractor),
-- IMPLEMENTO (apero) y OPERADOR se asigna cada actividad -- petición de
-- Carlos, al estilo del planificador de trabajo de John Deere: 1) elige los
-- cuadros, 2) "Detalle de trabajo" con equipo/implemento/operador. Los tres
-- quedan opcionales (NULL = "sin asignar").
--
-- equipo_codigo/operador_nombre SÍ afectan cómo se acredita el avance (ver
-- marcarCuadrosCompletadosPorPunto_ en server/handlers.js): si una
-- actividad tiene equipo y/o operador asignado, su avance SOLO sube cuando
-- el recorrido GPS que lo genera (avance_huerta.codigo_unidad/.nombre, ver
-- abajo) coincide con lo asignado aquí -- si cualquiera de los dos se deja
-- vacío, ese lado no filtra (cuenta cualquier equipo y/o cualquier
-- operador), exactamente igual que el comportamiento de siempre.
-- implemento_codigo es solo informativo, no se usa para filtrar nada.
SET @col_exists = (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE table_schema = DATABASE() AND table_name = 'huerta_actividades' AND column_name = 'equipo_codigo'
);
SET @sql_alter = IF(@col_exists = 0,
  'ALTER TABLE huerta_actividades ADD COLUMN equipo_codigo VARCHAR(50) DEFAULT NULL',
  'SELECT 1');
PREPARE stmt_alter FROM @sql_alter;
EXECUTE stmt_alter;
DEALLOCATE PREPARE stmt_alter;

SET @col_exists = (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE table_schema = DATABASE() AND table_name = 'huerta_actividades' AND column_name = 'implemento_codigo'
);
SET @sql_alter = IF(@col_exists = 0,
  'ALTER TABLE huerta_actividades ADD COLUMN implemento_codigo VARCHAR(50) DEFAULT NULL',
  'SELECT 1');
PREPARE stmt_alter FROM @sql_alter;
EXECUTE stmt_alter;
DEALLOCATE PREPARE stmt_alter;

SET @col_exists = (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE table_schema = DATABASE() AND table_name = 'huerta_actividades' AND column_name = 'operador_nombre'
);
SET @sql_alter = IF(@col_exists = 0,
  'ALTER TABLE huerta_actividades ADD COLUMN operador_nombre VARCHAR(255) DEFAULT NULL',
  'SELECT 1');
PREPARE stmt_alter FROM @sql_alter;
EXECUTE stmt_alter;
DEALLOCATE PREPARE stmt_alter;

-- avance_huerta: con qué EQUIPO (tractor) se hizo este recorrido -- lo
-- elige el operador en su celular al darle "Iniciar" en Avance Huerta,
-- igual que ya elige equipo en Reportar/Cargar Diesel/Movimientos
-- (restringido a los equipos que tenga asignados -- ver
-- maquinaria.usuario_asignado_app). Petición de Carlos: para que una
-- actividad planificada con equipo/operador asignado (ver arriba) solo
-- cuente el avance de ESE equipo, hace falta saber con cuál se hizo cada
-- recorrido. NULL = recorrido de antes de este cambio, o sin equipo
-- elegido -- no afecta el emparejamiento (ver arriba).
SET @col_exists = (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE table_schema = DATABASE() AND table_name = 'avance_huerta' AND column_name = 'codigo_unidad'
);
SET @sql_alter = IF(@col_exists = 0,
  'ALTER TABLE avance_huerta ADD COLUMN codigo_unidad VARCHAR(50) DEFAULT NULL',
  'SELECT 1');
PREPARE stmt_alter FROM @sql_alter;
EXECUTE stmt_alter;
DEALLOCATE PREPARE stmt_alter;

-- ------------------------------------------------------------
-- Indicadores (oct-2026): cumplimiento semanal de órdenes
-- ------------------------------------------------------------
-- Catálogo de semanas de trabajo (petición de Carlos: "guárdamelos en un
-- catálogo para poder agregarte más en un futuro"). Se cargan las 52
-- semanas de 2026 de su archivo "listado semanas.xlsx"; las siguientes se
-- agregan desde el Panel (Indicadores → Catálogo de semanas).
CREATE TABLE IF NOT EXISTS semanas (
  id            INT AUTO_INCREMENT PRIMARY KEY,
  codigo        VARCHAR(20) NOT NULL UNIQUE,   -- ej. S43-2026
  fecha_inicio  DATE NOT NULL,
  fecha_fin     DATE NOT NULL,
  creado_en     TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_semanas_inicio (fecha_inicio)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

INSERT IGNORE INTO semanas (codigo, fecha_inicio, fecha_fin) VALUES
  ('S01-2026', '2025-12-29', '2026-01-04'),
  ('S02-2026', '2026-01-05', '2026-01-11'),
  ('S03-2026', '2026-01-12', '2026-01-18'),
  ('S04-2026', '2026-01-19', '2026-01-25'),
  ('S05-2026', '2026-01-26', '2026-02-01'),
  ('S06-2026', '2026-02-02', '2026-02-08'),
  ('S07-2026', '2026-02-09', '2026-02-15'),
  ('S08-2026', '2026-02-16', '2026-02-22'),
  ('S09-2026', '2026-02-23', '2026-03-01'),
  ('S10-2026', '2026-03-02', '2026-03-08'),
  ('S11-2026', '2026-03-09', '2026-03-15'),
  ('S12-2026', '2026-03-16', '2026-03-22'),
  ('S13-2026', '2026-03-23', '2026-03-29'),
  ('S14-2026', '2026-03-30', '2026-04-05'),
  ('S15-2026', '2026-04-06', '2026-04-12'),
  ('S16-2026', '2026-04-13', '2026-04-19'),
  ('S17-2026', '2026-04-20', '2026-04-26'),
  ('S18-2026', '2026-04-27', '2026-05-03'),
  ('S19-2026', '2026-05-04', '2026-05-10'),
  ('S20-2026', '2026-05-11', '2026-05-17'),
  ('S21-2026', '2026-05-18', '2026-05-24'),
  ('S22-2026', '2026-05-25', '2026-05-31'),
  ('S23-2026', '2026-06-01', '2026-06-07'),
  ('S24-2026', '2026-06-08', '2026-06-14'),
  ('S25-2026', '2026-06-15', '2026-06-21'),
  ('S26-2026', '2026-06-22', '2026-06-28'),
  ('S27-2026', '2026-06-29', '2026-07-05'),
  ('S28-2026', '2026-07-06', '2026-07-12'),
  ('S29-2026', '2026-07-13', '2026-07-19'),
  ('S30-2026', '2026-07-20', '2026-07-26'),
  ('S31-2026', '2026-07-27', '2026-08-02'),
  ('S32-2026', '2026-08-03', '2026-08-09'),
  ('S33-2026', '2026-08-10', '2026-08-16'),
  ('S34-2026', '2026-08-17', '2026-08-23'),
  ('S35-2026', '2026-08-24', '2026-08-30'),
  ('S36-2026', '2026-08-31', '2026-09-06'),
  ('S37-2026', '2026-09-07', '2026-09-13'),
  ('S38-2026', '2026-09-14', '2026-09-20'),
  ('S39-2026', '2026-09-21', '2026-09-27'),
  ('S40-2026', '2026-09-28', '2026-10-04'),
  ('S41-2026', '2026-10-05', '2026-10-11'),
  ('S42-2026', '2026-10-12', '2026-10-18'),
  ('S43-2026', '2026-10-19', '2026-10-25'),
  ('S44-2026', '2026-10-26', '2026-11-01'),
  ('S45-2026', '2026-11-02', '2026-11-08'),
  ('S46-2026', '2026-11-09', '2026-11-15'),
  ('S47-2026', '2026-11-16', '2026-11-22'),
  ('S48-2026', '2026-11-23', '2026-11-29'),
  ('S49-2026', '2026-11-30', '2026-12-06'),
  ('S50-2026', '2026-12-07', '2026-12-13'),
  ('S51-2026', '2026-12-14', '2026-12-20'),
  ('S52-2026', '2026-12-21', '2026-12-27');

-- Historial de PROGRAMACIÓN de cada orden: una fila cada vez que se le
-- pone (o cambia) la Fecha de atención, o se marca "En proceso" para una
-- semana. Con esto el indicador sabe en qué semana(s) se programó cada
-- orden: si se reprograma a otra semana, cuenta en las dos (en la
-- original como no cumplida). Se guarda la FECHA (no la semana), así que
-- si después se agregan semanas al catálogo el indicador las toma solo.
--   origen: 'fecha_atencion' | 'en_proceso' | 'historico' (las que ya
--   tenían Fecha de atención antes de este cambio).
CREATE TABLE IF NOT EXISTS ordenes_programacion (
  id                INT AUTO_INCREMENT PRIMARY KEY,
  orden             VARCHAR(20) NOT NULL,
  fecha_programada  DATE NOT NULL,
  origen            VARCHAR(20) NOT NULL,
  registrado_por    VARCHAR(255) DEFAULT NULL,
  registrado_en     TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_prog_orden (orden),
  INDEX idx_prog_fecha (fecha_programada)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Las órdenes que ya tenían Fecha de atención cuentan en la semana de esa
-- fecha (solo se agrega si la orden todavía no tiene historial).
INSERT INTO ordenes_programacion (orden, fecha_programada, origen)
SELECT r.orden, r.fecha_atencion, 'historico'
  FROM reportes r
 WHERE r.fecha_atencion IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM ordenes_programacion p WHERE p.orden = r.orden);

-- reportes.semana_en_proceso: semana (código del catálogo, ej. S43-2026)
-- en que se planea atender una orden marcada "En proceso" sin Fecha de
-- atención todavía.
SET @col_exists = (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE table_schema = DATABASE() AND table_name = 'reportes' AND column_name = 'semana_en_proceso'
);
SET @sql_alter = IF(@col_exists = 0,
  'ALTER TABLE reportes ADD COLUMN semana_en_proceso VARCHAR(20) DEFAULT NULL',
  'SELECT 1');
PREPARE stmt_alter FROM @sql_alter;
EXECUTE stmt_alter;
DEALLOCATE PREPARE stmt_alter;

-- ------------------------------------------------------------
-- Avisos de recorridos (oct-2026, petición de Carlos: "mándame un aviso
-- cuando inicien y terminen recorrido", por el Panel y por Telegram). Ver
-- server/avisos.js.
-- configuracion: valores sueltos del sistema (clave -> valor). Aquí viven
--   el token del bot de Telegram y el chat a donde avisar (se configuran
--   desde el Panel: Avance Huerta → 🔔 Avisos) y las llaves VAPID de las
--   notificaciones (se generan solas). NUNCA se mandan al navegador
--   (salvo la llave pública VAPID).
-- push_suscripciones: cada computadora/celular que activó "Avisos en este
--   equipo" en el Panel. Si el navegador ya no la acepta (410), se borra sola.
CREATE TABLE IF NOT EXISTS configuracion (
  clave          VARCHAR(64) PRIMARY KEY,
  valor          TEXT,
  actualizado_en TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS push_suscripciones (
  id            INT AUTO_INCREMENT PRIMARY KEY,
  usuario       VARCHAR(255) NOT NULL,
  endpoint      VARCHAR(1000) NOT NULL,
  p256dh        VARCHAR(200) NOT NULL,
  auth          VARCHAR(100) NOT NULL,
  dispositivo   VARCHAR(120) DEFAULT NULL,
  creado_en     TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  ultimo_envio  DATETIME DEFAULT NULL,
  UNIQUE KEY uq_push_endpoint (endpoint(700))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- avance_huerta.ancla_en (oct-2026): hora del punto "ancla" (ver ancla_lat).
-- Sirve para no acreditar avance de cuadros a un brinco del GPS (un tramo
-- que implicaría ir a más de 54 km/h desde el ancla). Ver
-- marcarCuadrosCompletadosPorPunto_ en server/handlers.js.
SET @col_exists = (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE table_schema = DATABASE() AND table_name = 'avance_huerta' AND column_name = 'ancla_en'
);
SET @sql_alter = IF(@col_exists = 0,
  'ALTER TABLE avance_huerta ADD COLUMN ancla_en DATETIME DEFAULT NULL',
  'SELECT 1');
PREPARE stmt_alter FROM @sql_alter;
EXECUTE stmt_alter;
DEALLOCATE PREPARE stmt_alter;

-- ------------------------------------------------------------
-- Indicador de PREPARACIÓN DE TIERRAS (oct-2026). Ver
-- getIndicadorPreparacion en server/handlers.js.
-- reportes.reporte_claro: si el reporte de falla se entendía bien para que
--   el área mecánica fuera preparada (1 = claro, 0 = no claro, NULL = sin
--   revisar). Lo marca Carlos en el Panel (Indicadores).
-- operadores_salario: salario diario de cada operador (por su nombre, igual
--   que en sus recorridos de Avance de huerta) para el costo de mano de obra.
SET @col_exists = (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE table_schema = DATABASE() AND table_name = 'reportes' AND column_name = 'reporte_claro'
);
SET @sql_alter = IF(@col_exists = 0,
  'ALTER TABLE reportes ADD COLUMN reporte_claro TINYINT(1) DEFAULT NULL, ADD COLUMN reporte_claro_por VARCHAR(255) DEFAULT NULL, ADD COLUMN reporte_claro_en DATETIME DEFAULT NULL',
  'SELECT 1');
PREPARE stmt_alter FROM @sql_alter;
EXECUTE stmt_alter;
DEALLOCATE PREPARE stmt_alter;

CREATE TABLE IF NOT EXISTS operadores_salario (
  id              INT AUTO_INCREMENT PRIMARY KEY,
  nombre          VARCHAR(255) NOT NULL UNIQUE,
  salario_diario  DECIMAL(10,2) NOT NULL,
  actualizado_por VARCHAR(255) DEFAULT NULL,
  actualizado_en  TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- refacciones.folio_comercial (oct-2026): el "Código Producto" de CONTPAQi
-- (sistema comercial), para ligar cada refacción con el inventario. Único
-- cuando se captura. Se llenó con importar_refacciones_contpaq.bat.
SET @col_exists = (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE table_schema = DATABASE() AND table_name = 'refacciones' AND column_name = 'folio_comercial'
);
SET @sql_alter = IF(@col_exists = 0,
  'ALTER TABLE refacciones ADD COLUMN folio_comercial VARCHAR(30) DEFAULT NULL',
  'SELECT 1');
PREPARE stmt_alter FROM @sql_alter;
EXECUTE stmt_alter;
DEALLOCATE PREPARE stmt_alter;

SET @idx_exists = (
  SELECT COUNT(*) FROM information_schema.STATISTICS
  WHERE table_schema = DATABASE() AND table_name = 'refacciones' AND index_name = 'idx_refacciones_folio_comercial'
);
SET @sql_idx = IF(@idx_exists = 0,
  'CREATE UNIQUE INDEX idx_refacciones_folio_comercial ON refacciones (folio_comercial)',
  'SELECT 1');
PREPARE stmt_idx FROM @sql_idx;
EXECUTE stmt_idx;
DEALLOCATE PREPARE stmt_idx;

-- ------------------------------------------------------------
-- Catálogos de partes por modelo (oct-2026): el PDF del fabricante (p.ej.
-- Kubota L3800) se sube desde el Panel (Refacciones -> "Catálogos de partes")
-- y se guarda ya leído: secciones (con su dibujo) y la tabla de piezas de
-- cada una. Desde una orden (Panel y Taller) se abre el catálogo del modelo
-- del equipo para escoger piezas, con propuesta de la IA según la falla.
-- completo = 0 mientras se está subiendo (no se muestra hasta terminar).
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS manuales_partes (
  id              INT AUTO_INCREMENT PRIMARY KEY,
  modelo_id       INT NOT NULL,
  nombre_archivo  VARCHAR(255) DEFAULT NULL,
  paginas         INT DEFAULT NULL,
  secciones       INT NOT NULL DEFAULT 0,
  piezas          INT NOT NULL DEFAULT 0,
  completo        TINYINT(1) NOT NULL DEFAULT 0,
  subido_por      VARCHAR(255) DEFAULT NULL,
  creado_en       TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_manuales_partes_modelo (modelo_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS manuales_partes_secciones (
  id          INT AUTO_INCREMENT PRIMARY KEY,
  manual_id   INT NOT NULL,
  orden       INT NOT NULL DEFAULT 0,
  codigo      VARCHAR(20)  DEFAULT NULL,
  titulo      VARCHAR(255) NOT NULL,
  aplica      VARCHAR(100) DEFAULT NULL,
  serie       VARCHAR(100) DEFAULT NULL,
  grupo       VARCHAR(255) DEFAULT NULL,
  imagen_url  VARCHAR(500) DEFAULT NULL,
  INDEX idx_mps_manual (manual_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS manuales_partes_piezas (
  id             INT AUTO_INCREMENT PRIMARY KEY,
  manual_id      INT NOT NULL,
  seccion_id     INT NOT NULL,
  ref            VARCHAR(10)  DEFAULT NULL,
  codigo         VARCHAR(40)  DEFAULT NULL,
  codigo_norm    VARCHAR(40)  DEFAULT NULL,
  descripcion    VARCHAR(255) DEFAULT NULL,
  cantidad       DECIMAL(10,2) DEFAULT NULL,
  serie          VARCHAR(100) DEFAULT NULL,
  observaciones  VARCHAR(255) DEFAULT NULL,
  INDEX idx_mpp_manual (manual_id),
  INDEX idx_mpp_seccion (seccion_id),
  INDEX idx_mpp_codigo (codigo_norm)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ------------------------------------------------------------
-- Varios proveedores por refacción (oct-2026): para cotizarla con más de
-- uno y comparar. refacciones.proveedor_id se queda como el "principal" (el
-- primero de la lista) para lo que ya lo usaba. La línea INSERT IGNORE pasa
-- a esta tabla el proveedor que ya tenía cada refacción (se puede volver a
-- correr sin duplicar).
-- marcas_proveedores: proveedor(es) de una marca (p.ej. SAMEI para KUBOTA):
-- se asignan a todas las refacciones de la marca desde Refacciones -> Marcas
-- y modelos -> "Proveedores", y a las nuevas que se den de alta con ella.
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS refacciones_proveedores (
  id           INT AUTO_INCREMENT PRIMARY KEY,
  refaccion_id INT NOT NULL,
  proveedor_id INT NOT NULL,
  UNIQUE KEY uq_refaccion_proveedor (refaccion_id, proveedor_id),
  INDEX idx_refprov_proveedor (proveedor_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

INSERT IGNORE INTO refacciones_proveedores (refaccion_id, proveedor_id)
SELECT id, proveedor_id FROM refacciones WHERE proveedor_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS marcas_proveedores (
  id           INT AUTO_INCREMENT PRIMARY KEY,
  marca_id     INT NOT NULL,
  proveedor_id INT NOT NULL,
  UNIQUE KEY uq_marca_proveedor (marca_id, proveedor_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ------------------------------------------------------------
-- Varias fotos por orden (oct-2026): la foto/video principal sigue en
-- reportes.foto_url; las adicionales (solo imágenes, máx. 8) aquí. Se
-- agregan al reportar o después desde el Panel/Taller.
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS reportes_fotos (
  id          INT AUTO_INCREMENT PRIMARY KEY,
  orden       VARCHAR(20)  NOT NULL,
  url         VARCHAR(500) NOT NULL,
  origen      VARCHAR(20)  DEFAULT NULL,   -- 'reporte' | 'panel'
  subido_por  VARCHAR(255) DEFAULT NULL,
  creado_en   TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_reportes_fotos_orden (orden)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ------------------------------------------------------------
-- Exportar OC para CONTPAQi Comercial (oct-2026).
-- proveedores.codigo_comercial: código del proveedor EN COMERCIAL (ej. 0283 =
-- SAMEI). Texto, conserva ceros a la izquierda.
-- oc_exportaciones: qué partidas autorizadas (una por respuesta de cotización
-- autorizada) ya se mandaron, para no exportarlas dos veces. tipo = 'oc'
-- (con serie/folio de la OC) o 'gasto_directo' (refacción sin folio comercial).
-- ------------------------------------------------------------
SET @col_exists = (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE table_schema = DATABASE() AND table_name = 'proveedores' AND column_name = 'codigo_comercial'
);
SET @sql_alter = IF(@col_exists = 0,
  'ALTER TABLE proveedores ADD COLUMN codigo_comercial VARCHAR(20) DEFAULT NULL',
  'SELECT 1');
PREPARE stmt_alter FROM @sql_alter;
EXECUTE stmt_alter;
DEALLOCATE PREPARE stmt_alter;

CREATE TABLE IF NOT EXISTS oc_exportaciones (
  id                INT AUTO_INCREMENT PRIMARY KEY,
  respuesta_item_id INT NOT NULL,
  orden             VARCHAR(20)  DEFAULT NULL,
  refaccion_id      INT          DEFAULT NULL,
  proveedor_id      INT          DEFAULT NULL,
  tipo              VARCHAR(20)  NOT NULL,        -- 'oc' | 'gasto_directo'
  serie             VARCHAR(10)  DEFAULT NULL,
  folio             INT          DEFAULT NULL,
  fecha_oc          DATE         DEFAULT NULL,
  cantidad          DECIMAL(10,2) DEFAULT NULL,
  precio            DECIMAL(12,4) DEFAULT NULL,
  exportado_por     VARCHAR(255) DEFAULT NULL,
  exportado_en      TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_oc_export_respuesta_item (respuesta_item_id),
  INDEX idx_oc_export_orden_ref (orden, refaccion_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ------------------------------------------------------------
-- Empresa de cada unidad (oct-2026): a qué empresa se factura lo que se
-- compra para ese equipo. En CONTPAQi Comercial cada empresa es una base
-- de datos aparte, así que "Exportar OC para CONTPAQi" se hace por empresa
-- (cada una con su folio). maquinaria.empresa_id -> empresas.
-- ------------------------------------------------------------
SET @col_exists = (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE table_schema = DATABASE() AND table_name = 'maquinaria' AND column_name = 'empresa_id'
);
SET @sql_alter = IF(@col_exists = 0,
  'ALTER TABLE maquinaria ADD COLUMN empresa_id INT DEFAULT NULL',
  'SELECT 1');
PREPARE stmt_alter FROM @sql_alter;
EXECUTE stmt_alter;
DEALLOCATE PREPARE stmt_alter;

SET @col_exists = (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE table_schema = DATABASE() AND table_name = 'oc_exportaciones' AND column_name = 'empresa_id'
);
SET @sql_alter = IF(@col_exists = 0,
  'ALTER TABLE oc_exportaciones ADD COLUMN empresa_id INT DEFAULT NULL',
  'SELECT 1');
PREPARE stmt_alter FROM @sql_alter;
EXECUTE stmt_alter;
DEALLOCATE PREPARE stmt_alter;

INSERT IGNORE INTO empresas (nombre) VALUES ('CHULA BRAND DEL GOLFO, S. DE P.R. DE R.L. DE C.V.');
INSERT IGNORE INTO empresas (nombre) VALUES ('CHULA BRAND MEXICO, S. DE P.R. DE R.L. DE C.V.');
INSERT IGNORE INTO empresas (nombre) VALUES ('DESARROLLO GENETICO DE PAPAYAS');

-- Carga inicial con el listado que mandó Carlos (28-oct-2026,
-- catalogo_maquinaria.xlsx, 83 unidades). Corre UNA sola vez (marca
-- en configuracion) y solo llena las que no tienen empresa: lo que después
-- se cambie en el Panel no se vuelve a pisar.
SET @carga_empresas_hecha = (SELECT COUNT(*) FROM configuracion WHERE clave = 'carga_empresas_maquinaria_2026_10');
UPDATE maquinaria m
JOIN (
  SELECT 'AF-001-5065E JD' AS unidad, 'CHULA BRAND MEXICO, S. DE P.R. DE R.L. DE C.V.' AS empresa
  UNION ALL SELECT 'AF-003-L3800 KUBOTA', 'CHULA BRAND MEXICO, S. DE P.R. DE R.L. DE C.V.'
  UNION ALL SELECT 'AF-004-L3800 KUBOTA', 'CHULA BRAND MEXICO, S. DE P.R. DE R.L. DE C.V.'
  UNION ALL SELECT 'AF-011-7040 KUBOTA', 'CHULA BRAND DEL GOLFO, S. DE P.R. DE R.L. DE C.V.'
  UNION ALL SELECT 'AF-012-L3800 KUBOTA', 'DESARROLLO GENETICO DE PAPAYAS'
  UNION ALL SELECT 'AF-013-L3800 KUBOTA', 'DESARROLLO GENETICO DE PAPAYAS'
  UNION ALL SELECT 'AF-016-L3800 KUBOTA', 'CHULA BRAND DEL GOLFO, S. DE P.R. DE R.L. DE C.V.'
  UNION ALL SELECT 'AF-017-9540 KUBOTA', 'CHULA BRAND MEXICO, S. DE P.R. DE R.L. DE C.V.'
  UNION ALL SELECT 'AF-023-5100 KUBOTA', 'CHULA BRAND DEL GOLFO, S. DE P.R. DE R.L. DE C.V.'
  UNION ALL SELECT 'AF-026-7040 KUBOTA', 'CHULA BRAND DEL GOLFO, S. DE P.R. DE R.L. DE C.V.'
  UNION ALL SELECT 'AF-027-7040 KUBOTA', 'CHULA BRAND MEXICO, S. DE P.R. DE R.L. DE C.V.'
  UNION ALL SELECT 'AF-028-L3800 KUBOTA', 'CHULA BRAND MEXICO, S. DE P.R. DE R.L. DE C.V.'
  UNION ALL SELECT 'AF-029-7040 KUBOTA', 'CHULA BRAND DEL GOLFO, S. DE P.R. DE R.L. DE C.V.'
  UNION ALL SELECT 'AF-030-L3800 KUBOTA', 'CHULA BRAND MEXICO, S. DE P.R. DE R.L. DE C.V.'
  UNION ALL SELECT 'AF-031-L3800 KUBOTA', 'CHULA BRAND MEXICO, S. DE P.R. DE R.L. DE C.V.'
  UNION ALL SELECT 'AF-032-L3800 KUBOTA', 'CHULA BRAND DEL GOLFO, S. DE P.R. DE R.L. DE C.V.'
  UNION ALL SELECT 'AF-034-L3800 KUBOTA', 'CHULA BRAND MEXICO, S. DE P.R. DE R.L. DE C.V.'
  UNION ALL SELECT 'AF-306-3320 JD', 'CHULA BRAND MEXICO, S. DE P.R. DE R.L. DE C.V.'
  UNION ALL SELECT 'AF-307-3320 JD', 'CHULA BRAND MEXICO, S. DE P.R. DE R.L. DE C.V.'
  UNION ALL SELECT 'AF-311-3320 JD', 'CHULA BRAND MEXICO, S. DE P.R. DE R.L. DE C.V.'
  UNION ALL SELECT 'AF-431-7610 NW', 'CHULA BRAND MEXICO, S. DE P.R. DE R.L. DE C.V.'
  UNION ALL SELECT 'AF-441-6600 FORD', 'CHULA BRAND MEXICO, S. DE P.R. DE R.L. DE C.V.'
  UNION ALL SELECT 'AF-442-6600 FORD', 'CHULA BRAND MEXICO, S. DE P.R. DE R.L. DE C.V.'
  UNION ALL SELECT 'AF-477-5615 JD', 'CHULA BRAND MEXICO, S. DE P.R. DE R.L. DE C.V.'
  UNION ALL SELECT 'AF-478-5615 JD', 'CHULA BRAND MEXICO, S. DE P.R. DE R.L. DE C.V.'
  UNION ALL SELECT 'AF-481-6115 JD', 'CHULA BRAND MEXICO, S. DE P.R. DE R.L. DE C.V.'
  UNION ALL SELECT 'AF-499-5715 JD', 'CHULA BRAND MEXICO, S. DE P.R. DE R.L. DE C.V.'
  UNION ALL SELECT 'AF-511-6115 JD', 'CHULA BRAND MEXICO, S. DE P.R. DE R.L. DE C.V.'
  UNION ALL SELECT 'AF-512-4120 JD', 'CHULA BRAND MEXICO, S. DE P.R. DE R.L. DE C.V.'
  UNION ALL SELECT 'AF-513-3320 JD', 'CHULA BRAND MEXICO, S. DE P.R. DE R.L. DE C.V.'
  UNION ALL SELECT 'AF-517-416D CAT', 'CHULA BRAND MEXICO, S. DE P.R. DE R.L. DE C.V.'
  UNION ALL SELECT 'AF-523-5075 JD', 'CHULA BRAND MEXICO, S. DE P.R. DE R.L. DE C.V.'
  UNION ALL SELECT 'AF-524-6115 JD', 'CHULA BRAND MEXICO, S. DE P.R. DE R.L. DE C.V.'
  UNION ALL SELECT 'AF-525-3320 JD', 'CHULA BRAND MEXICO, S. DE P.R. DE R.L. DE C.V.'
  UNION ALL SELECT 'AF-526-3320 JD', 'CHULA BRAND MEXICO, S. DE P.R. DE R.L. DE C.V.'
  UNION ALL SELECT 'AF-542-3320 JD', 'CHULA BRAND MEXICO, S. DE P.R. DE R.L. DE C.V.'
  UNION ALL SELECT 'AF-543-3320 JD', 'CHULA BRAND MEXICO, S. DE P.R. DE R.L. DE C.V.'
  UNION ALL SELECT 'AF-554-5725 JD', 'CHULA BRAND MEXICO, S. DE P.R. DE R.L. DE C.V.'
  UNION ALL SELECT 'AF-555-5303 JD', 'CHULA BRAND MEXICO, S. DE P.R. DE R.L. DE C.V.'
  UNION ALL SELECT 'AF-571-5415 JD', 'CHULA BRAND MEXICO, S. DE P.R. DE R.L. DE C.V.'
  UNION ALL SELECT 'AF-572-5415 JD', 'CHULA BRAND MEXICO, S. DE P.R. DE R.L. DE C.V.'
  UNION ALL SELECT 'AF-573-5415 JD', 'CHULA BRAND MEXICO, S. DE P.R. DE R.L. DE C.V.'
  UNION ALL SELECT 'AF-574-5415 JD', 'CHULA BRAND MEXICO, S. DE P.R. DE R.L. DE C.V.'
  UNION ALL SELECT 'AF-575-5415 JD', 'CHULA BRAND MEXICO, S. DE P.R. DE R.L. DE C.V.'
  UNION ALL SELECT 'AF-586-3036 JD', 'CHULA BRAND MEXICO, S. DE P.R. DE R.L. DE C.V.'
  UNION ALL SELECT 'AF-587-3036 JD', 'CHULA BRAND MEXICO, S. DE P.R. DE R.L. DE C.V.'
  UNION ALL SELECT 'AF-588-3036 JD', 'CHULA BRAND MEXICO, S. DE P.R. DE R.L. DE C.V.'
  UNION ALL SELECT 'AF-590-3036 JD', 'CHULA BRAND MEXICO, S. DE P.R. DE R.L. DE C.V.'
  UNION ALL SELECT 'AF-597-L3800 KUBOTA', 'CHULA BRAND MEXICO, S. DE P.R. DE R.L. DE C.V.'
  UNION ALL SELECT 'AF-598-L3800 KUBOTA', 'CHULA BRAND MEXICO, S. DE P.R. DE R.L. DE C.V.'
  UNION ALL SELECT 'AF-599-7040 KUBOTA', 'CHULA BRAND MEXICO, S. DE P.R. DE R.L. DE C.V.'
  UNION ALL SELECT 'AF-600-7040 KUBOTA', 'CHULA BRAND MEXICO, S. DE P.R. DE R.L. DE C.V.'
  UNION ALL SELECT 'AF-602-M7040 KUBOTA', 'CHULA BRAND DEL GOLFO, S. DE P.R. DE R.L. DE C.V.'
  UNION ALL SELECT 'AF-624-7040 KUBOTA', 'CHULA BRAND DEL GOLFO, S. DE P.R. DE R.L. DE C.V.'
  UNION ALL SELECT 'AF-625-L3800 KUBOTA', 'CHULA BRAND MEXICO, S. DE P.R. DE R.L. DE C.V.'
  UNION ALL SELECT 'AF-630-L3800 KUBOTA', 'CHULA BRAND MEXICO, S. DE P.R. DE R.L. DE C.V.'
  UNION ALL SELECT 'AF-631-L3800 KUBOTA', 'CHULA BRAND MEXICO, S. DE P.R. DE R.L. DE C.V.'
  UNION ALL SELECT 'AF-632-L3800 KUBOTA', 'CHULA BRAND MEXICO, S. DE P.R. DE R.L. DE C.V.'
  UNION ALL SELECT 'AF-633-L3800 KUBOTA', 'CHULA BRAND MEXICO, S. DE P.R. DE R.L. DE C.V.'
  UNION ALL SELECT 'AF-638-L3800 KUBOTA', 'CHULA BRAND DEL GOLFO, S. DE P.R. DE R.L. DE C.V.'
  UNION ALL SELECT 'AF-639-L3800 KUBOTA', 'CHULA BRAND MEXICO, S. DE P.R. DE R.L. DE C.V.'
  UNION ALL SELECT 'AF-640-L3800 KUBOTA', 'CHULA BRAND MEXICO, S. DE P.R. DE R.L. DE C.V.'
  UNION ALL SELECT 'AF-641-L3800 KUBOTA', 'CHULA BRAND MEXICO, S. DE P.R. DE R.L. DE C.V.'
  UNION ALL SELECT 'AF-642-L3800 KUBOTA', 'CHULA BRAND MEXICO, S. DE P.R. DE R.L. DE C.V.'
  UNION ALL SELECT 'AF-648-6603 JD', 'CHULA BRAND MEXICO, S. DE P.R. DE R.L. DE C.V.'
  UNION ALL SELECT 'AF-719-L3800 KUBOTA', 'CHULA BRAND MEXICO, S. DE P.R. DE R.L. DE C.V.'
  UNION ALL SELECT 'AF-720-L3800 KUBOTA', 'CHULA BRAND MEXICO, S. DE P.R. DE R.L. DE C.V.'
  UNION ALL SELECT 'AF-721-L3800 KUBOTA', 'CHULA BRAND MEXICO, S. DE P.R. DE R.L. DE C.V.'
  UNION ALL SELECT 'AF-722-L3800 KUBOTA', 'CHULA BRAND MEXICO, S. DE P.R. DE R.L. DE C.V.'
  UNION ALL SELECT 'AF-723-L3800 KUBOTA', 'CHULA BRAND MEXICO, S. DE P.R. DE R.L. DE C.V.'
  UNION ALL SELECT 'AF-724-L3800 KUBOTA', 'CHULA BRAND MEXICO, S. DE P.R. DE R.L. DE C.V.'
  UNION ALL SELECT 'AF-725-L3800 KUBOTA', 'CHULA BRAND MEXICO, S. DE P.R. DE R.L. DE C.V.'
  UNION ALL SELECT 'AF-726-L3800 KUBOTA', 'CHULA BRAND MEXICO, S. DE P.R. DE R.L. DE C.V.'
  UNION ALL SELECT 'AF-727-L3800 KUBOTA', 'CHULA BRAND MEXICO, S. DE P.R. DE R.L. DE C.V.'
  UNION ALL SELECT 'AF-728-L3800 KUBOTA', 'CHULA BRAND MEXICO, S. DE P.R. DE R.L. DE C.V.'
  UNION ALL SELECT 'AF-729-L3800 KUBOTA', 'CHULA BRAND MEXICO, S. DE P.R. DE R.L. DE C.V.'
  UNION ALL SELECT 'AF-730-L3800 KUBOTA', 'CHULA BRAND MEXICO, S. DE P.R. DE R.L. DE C.V.'
  UNION ALL SELECT 'AF-731-6603 JD', 'CHULA BRAND MEXICO, S. DE P.R. DE R.L. DE C.V.'
  UNION ALL SELECT 'FMG-01-L3800 KUBOTA', 'CHULA BRAND MEXICO, S. DE P.R. DE R.L. DE C.V.'
  UNION ALL SELECT 'FMG-02-L3800 KUBOTA', 'CHULA BRAND MEXICO, S. DE P.R. DE R.L. DE C.V.'
  UNION ALL SELECT 'FMG-04-L3800 KUBOTA', 'CHULA BRAND MEXICO, S. DE P.R. DE R.L. DE C.V.'
  UNION ALL SELECT 'FMG-05-L3800 KUBOTA', 'CHULA BRAND MEXICO, S. DE P.R. DE R.L. DE C.V.'
  UNION ALL SELECT 'IA 050- GENERADOR LAB', 'CHULA BRAND MEXICO, S. DE P.R. DE R.L. DE C.V.'
) x ON UPPER(TRIM(x.unidad)) = UPPER(TRIM(m.unidad))
JOIN empresas e ON e.nombre = x.empresa
SET m.empresa_id = e.id
WHERE @carga_empresas_hecha = 0 AND m.empresa_id IS NULL;
INSERT IGNORE INTO configuracion (clave, valor) VALUES ('carga_empresas_maquinaria_2026_10', 'hecha');

-- ============================================================
-- Órdenes de compra al proveedor + factura con nota contable (oct-2026).
-- Ver server/ordenCompraProveedor.js y server/handlers.js (generarOcProveedor,
-- subirFacturaOc). Decisiones de Carlos:
--  - Al terminar de autorizar ("Aut") las piezas de un proveedor en una
--    orden, el Panel genera UNA OC por proveedor + orden y abre el correo /
--    WhatsApp ya armado con el enlace (no hay correo desde el servidor).
--  - Folio consecutivo propio POR EMPRESA (serie "mtto" por omisión).
--  - El proveedor sube PDF + XML de su factura por /factura?token=...; al
--    PDF se le agrega la nota contable en la PRIMERA hoja (franja nueva al
--    pie, sin tapar nada). Se guardan la original y la sellada.
--  - Cuenta contable por Tipo de unidad (Tractor -> MTTO TRACTORES
--    59060003000, segmento 29).
-- ============================================================
CREATE TABLE IF NOT EXISTS cuentas_contables (
  id             INT AUTO_INCREMENT PRIMARY KEY,
  nombre         VARCHAR(150) NOT NULL UNIQUE,     -- ej. MTTO TRACTORES
  numero         VARCHAR(40)  DEFAULT NULL,        -- ej. 59060003000
  segmento       VARCHAR(20)  DEFAULT NULL,        -- ej. 29
  descripcion_oc VARCHAR(150) DEFAULT NULL,        -- texto de la columna Descripción en la OC (ej. SERVICIO MTTO. TRACTORES)
  creado_en      TIMESTAMP DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

SET @col_exists = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE table_schema = DATABASE() AND table_name = 'tipos_unidad' AND column_name = 'cuenta_contable_id');
SET @sql_alter = IF(@col_exists = 0, 'ALTER TABLE tipos_unidad ADD COLUMN cuenta_contable_id INT DEFAULT NULL', 'SELECT 1');
PREPARE stmt_alter FROM @sql_alter; EXECUTE stmt_alter; DEALLOCATE PREPARE stmt_alter;

-- Datos fiscales de cada empresa (encabezado de la OC, "Datos de
-- Facturación" y "Empresa a contabilizar" de la nota).
SET @col_exists = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE table_schema = DATABASE() AND table_name = 'empresas' AND column_name = 'siglas');
SET @sql_alter = IF(@col_exists = 0, 'ALTER TABLE empresas ADD COLUMN siglas VARCHAR(20) DEFAULT NULL, ADD COLUMN rfc VARCHAR(20) DEFAULT NULL, ADD COLUMN razon_social VARCHAR(255) DEFAULT NULL, ADD COLUMN domicilio TEXT DEFAULT NULL, ADD COLUMN uso_cfdi VARCHAR(80) DEFAULT NULL, ADD COLUMN autoriza_oc VARCHAR(150) DEFAULT NULL', 'SELECT 1');
PREPARE stmt_alter FROM @sql_alter; EXECUTE stmt_alter; DEALLOCATE PREPARE stmt_alter;

-- RFC y domicilio fiscal del proveedor (salen en la OC).
SET @col_exists = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE table_schema = DATABASE() AND table_name = 'proveedores' AND column_name = 'rfc');
SET @sql_alter = IF(@col_exists = 0, 'ALTER TABLE proveedores ADD COLUMN rfc VARCHAR(20) DEFAULT NULL, ADD COLUMN domicilio TEXT DEFAULT NULL', 'SELECT 1');
PREPARE stmt_alter FROM @sql_alter; EXECUTE stmt_alter; DEALLOCATE PREPARE stmt_alter;

-- Quién dio el "Aut" (sale como Firma en la nota contable).
SET @col_exists = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE table_schema = DATABASE() AND table_name = 'solicitud_cotizacion_respuesta_items' AND column_name = 'autorizado_por');
SET @sql_alter = IF(@col_exists = 0, 'ALTER TABLE solicitud_cotizacion_respuesta_items ADD COLUMN autorizado_por VARCHAR(255) DEFAULT NULL, ADD COLUMN autorizado_en DATETIME DEFAULT NULL', 'SELECT 1');
PREPARE stmt_alter FROM @sql_alter; EXECUTE stmt_alter; DEALLOCATE PREPARE stmt_alter;

CREATE TABLE IF NOT EXISTS ordenes_compra (
  id                  INT AUTO_INCREMENT PRIMARY KEY,
  token               VARCHAR(64)  NOT NULL UNIQUE,     -- enlace público /factura?token=...
  empresa_id          INT          NOT NULL,
  proveedor_id        INT          NOT NULL,
  orden               VARCHAR(20)  DEFAULT NULL,        -- orden de trabajo (OF-00001)
  serie               VARCHAR(10)  NOT NULL,
  folio               INT          NOT NULL,
  fecha               DATE         NOT NULL,
  estado              VARCHAR(20)  NOT NULL DEFAULT 'generada', -- generada | enviada | facturada | cancelada
  -- Copia de los datos al momento de generar (el histórico no cambia si
  -- luego se edita un catálogo).
  cuenta_nombre       VARCHAR(150) DEFAULT NULL,
  cuenta_numero       VARCHAR(40)  DEFAULT NULL,
  segmento            VARCHAR(20)  DEFAULT NULL,
  descripcion_oc      VARCHAR(150) DEFAULT NULL,
  huerta              VARCHAR(150) DEFAULT NULL,
  observacion         VARCHAR(255) DEFAULT NULL,        -- ej. AF-648
  empresa_siglas      VARCHAR(20)  DEFAULT NULL,
  firma               VARCHAR(150) DEFAULT NULL,
  subtotal            DECIMAL(12,2) NOT NULL DEFAULT 0,
  descuento           DECIMAL(12,2) NOT NULL DEFAULT 0,
  iva                 DECIMAL(12,2) NOT NULL DEFAULT 0,
  total               DECIMAL(12,2) NOT NULL DEFAULT 0,
  generado_por        VARCHAR(255) DEFAULT NULL,
  generado_en         TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  enviado_en          DATETIME DEFAULT NULL,
  factura_pdf_url     VARCHAR(500) DEFAULT NULL,        -- la que mandó el proveedor, tal cual
  factura_xml_url     VARCHAR(500) DEFAULT NULL,
  factura_sellada_url VARCHAR(500) DEFAULT NULL,        -- con la nota contable
  factura_uuid        VARCHAR(60)  DEFAULT NULL,
  factura_total       DECIMAL(12,2) DEFAULT NULL,
  factura_avisos      TEXT DEFAULT NULL,                -- diferencias detectadas (RFC, total)
  factura_nombre      VARCHAR(255) DEFAULT NULL,        -- quién la subió
  factura_en          DATETIME DEFAULT NULL,
  cancelado_por       VARCHAR(255) DEFAULT NULL,
  UNIQUE KEY uq_oc_empresa_folio (empresa_id, serie, folio),
  INDEX idx_oc_orden (orden),
  INDEX idx_oc_proveedor (proveedor_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS ordenes_compra_items (
  id                INT AUTO_INCREMENT PRIMARY KEY,
  oc_id             INT NOT NULL,
  respuesta_item_id INT DEFAULT NULL,
  refaccion_id      INT DEFAULT NULL,
  observaciones     VARCHAR(255) DEFAULT NULL,   -- no. de parte + descripción
  cantidad          DECIMAL(10,2) NOT NULL,
  precio            DECIMAL(12,4) NOT NULL,      -- valor unitario (antes de descuento, sin IVA)
  descuento_pct     DECIMAL(5,2) DEFAULT NULL,
  iva_pct           DECIMAL(5,2) DEFAULT NULL,
  importe           DECIMAL(12,2) NOT NULL,
  INDEX idx_oci_oc (oc_id),
  INDEX idx_oci_respuesta (respuesta_item_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Carga inicial (una sola vez): cuenta MTTO TRACTORES para los tipos de
-- unidad que digan "tractor", y datos fiscales de Chula Brand México
-- (tomados de la OC de ejemplo de Carlos). Solo llena lo que esté vacío.
SET @carga_oc_hecha = (SELECT COUNT(*) FROM configuracion WHERE clave = 'carga_cuentas_oc_2026_10');
INSERT IGNORE INTO cuentas_contables (nombre, numero, segmento, descripcion_oc)
  SELECT 'MTTO TRACTORES', '59060003000', '29', 'SERVICIO MTTO. TRACTORES' FROM DUAL WHERE @carga_oc_hecha = 0;
UPDATE tipos_unidad t JOIN cuentas_contables c ON c.nombre = 'MTTO TRACTORES'
  SET t.cuenta_contable_id = c.id
  WHERE @carga_oc_hecha = 0 AND t.cuenta_contable_id IS NULL AND UPPER(t.nombre) LIKE '%TRACTOR%';
UPDATE empresas SET
  siglas = COALESCE(siglas, 'CBM'),
  rfc = COALESCE(rfc, 'GAM9702258Z9'),
  razon_social = COALESCE(razon_social, 'Chula Brand Mexico S. de P.R. de R.L. de C.V.'),
  domicilio = COALESCE(domicilio, 'Rio Rhin Num.309 Int.Altos\nCol.Del Valle Loc. San Pedro Garza Garcia.\nEstado de Nuevo Leon, C.P.66220'),
  uso_cfdi = COALESCE(uso_cfdi, 'Gasto General'),
  autoriza_oc = COALESCE(autoriza_oc, 'ING. JOSE HERNAN ARMIDA CRUZ')
  WHERE @carga_oc_hecha = 0 AND nombre = 'CHULA BRAND MEXICO, S. DE P.R. DE R.L. DE C.V.';
INSERT IGNORE INTO configuracion (clave, valor) VALUES ('carga_cuentas_oc_2026_10', 'hecha');

-- ------------------------------------------------------------
-- Huerta y segmento de la nota/OC POR EMPRESA dentro de cada cuenta
-- contable (oct-2026, pedido de Carlos): ej. MTTO TRACTORES para Chula
-- Brand México -> PRORRATEABLES, segmento 29; para Chula Brand del Golfo
-- -> otra huerta/segmento. Si una empresa no tiene fila aquí, se usa el
-- segmento general de la cuenta y la huerta de la orden.
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS cuentas_contables_empresas (
  id         INT AUTO_INCREMENT PRIMARY KEY,
  cuenta_id  INT NOT NULL,
  empresa_id INT NOT NULL,
  huerta     VARCHAR(150) DEFAULT NULL,
  segmento   VARCHAR(20)  DEFAULT NULL,
  UNIQUE KEY uq_cce (cuenta_id, empresa_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

SET @carga_cce_hecha = (SELECT COUNT(*) FROM configuracion WHERE clave = 'carga_cuentas_empresas_2026_10');
INSERT IGNORE INTO cuentas_contables_empresas (cuenta_id, empresa_id, huerta, segmento)
  SELECT c.id, e.id, 'PRORRATEABLES', '29' FROM cuentas_contables c JOIN empresas e
  WHERE @carga_cce_hecha = 0 AND c.nombre = 'MTTO TRACTORES' AND e.nombre = 'CHULA BRAND MEXICO, S. DE P.R. DE R.L. DE C.V.';
INSERT IGNORE INTO configuracion (clave, valor) VALUES ('carga_cuentas_empresas_2026_10', 'hecha');

-- ------------------------------------------------------------
-- Quién aportó a cada actividad de cuadro (oct-2026, Carlos: "en
-- completado no viene cuántas pasadas hizo ni con qué equipos"): pasadas
-- por recorrido (avance_huerta = equipo + operador). La llena el avance en
-- vivo (marcarCuadrosCompletadosPorPunto_) y el recálculo
-- (recalcularAvanceActividadesHuerta_, recalcular_avance_cuadros_nube.bat).
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS huerta_actividades_aportes (
  actividad_id INT NOT NULL,
  avance_id    INT NOT NULL,
  pasadas      DECIMAL(10,4) NOT NULL DEFAULT 0,
  metros       DECIMAL(12,2) NOT NULL DEFAULT 0,
  primera_en   DATETIME DEFAULT NULL,
  ultima_en    DATETIME DEFAULT NULL,
  PRIMARY KEY (actividad_id, avance_id),
  INDEX idx_haa_avance (avance_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
