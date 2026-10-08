-- Agrega (o actualiza) el usuario CACM con acceso al módulo "Panel" y
-- contraseña "12345". Seguro de correr más de una vez: si el usuario ya
-- existe, solo actualiza su contraseña y le agrega el módulo "Panel" sin
-- quitarle los módulos que ya tuviera.

USE reporte_fallas;

INSERT INTO usuarios (nombre, huerta, password_hash, modulos)
VALUES ('CACM', NULL, '$2a$10$8vmC9c.YNabLcqlPfSi/6uKrUuhEPyw1cge8RTvoWhC2AGtCBQw8W', 'Panel')
ON DUPLICATE KEY UPDATE
  password_hash = VALUES(password_hash),
  modulos = CASE
    WHEN modulos IS NULL OR modulos = '' THEN 'Panel'
    WHEN FIND_IN_SET('Panel', modulos) > 0 THEN modulos
    ELSE CONCAT(modulos, ',Panel')
  END;
