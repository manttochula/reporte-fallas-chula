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
