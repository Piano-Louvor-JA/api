-- Histórico / rankings de telemetria (api/.planning/telemetria-historico).
-- Agregado diário por dimensão; IP nunca entra aqui.
-- Idempotente: o runner reaplica as migrations a cada boot.
CREATE TABLE IF NOT EXISTS device_presence_daily (
  day       TEXT NOT NULL,
  dim       TEXT NOT NULL,
  key_norm  TEXT NOT NULL,
  label     TEXT NOT NULL,
  devices   INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, dim, key_norm)
);

CREATE INDEX IF NOT EXISTS idx_device_presence_daily_day
  ON device_presence_daily (day);

CREATE INDEX IF NOT EXISTS idx_device_presence_daily_dim_day
  ON device_presence_daily (dim, day);
