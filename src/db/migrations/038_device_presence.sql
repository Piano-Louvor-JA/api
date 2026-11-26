-- Telemetria de dispositivos online (app/.planning/telemetria-dispositivos).
-- Um registro por instalação (install_id = UUID anônimo gerado no cliente).
-- IP NÃO é gravado (LGPD): só cidade/UF/país resolvidos no heartbeat.
-- Idempotente: o runner reaplica as migrations a cada boot.
CREATE TABLE IF NOT EXISTS device_presence (
  install_id   TEXT PRIMARY KEY,
  platform     TEXT NOT NULL,
  app_version  TEXT,
  os_name      TEXT,
  os_release   TEXT,
  os_arch      TEXT,
  locale       TEXT,
  timezone     TEXT,
  district     TEXT,
  church       TEXT,
  city         TEXT,
  region       TEXT,
  country      TEXT,
  partner_id   INTEGER,
  first_seen   TEXT NOT NULL,
  last_seen    TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_device_presence_last_seen
  ON device_presence (last_seen);
