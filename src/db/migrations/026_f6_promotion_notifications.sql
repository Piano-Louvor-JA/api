-- 026_f6_promotion_notifications.sql
-- F6: promoção ao acervo oficial + créditos + notificações + eventos sazonais.
-- Idempotente (IF NOT EXISTS em tudo — lição api#88).

-- Evento sazonal com multiplicador de pontos (ex.: SDA Hymnal 2x).
CREATE TABLE IF NOT EXISTS seasonal_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  description TEXT,
  multiplier REAL NOT NULL DEFAULT 2.0 CHECK (multiplier >= 1.0),
  starts_at DATETIME NOT NULL,
  ends_at DATETIME NOT NULL,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1))
);

-- Autoria permanente: faixa custom promovida ao acervo oficial.
-- official_music_id (custom_musics) aponta pro hino oficial;
-- promotion registra quem criou, quando e quem curou.
CREATE TABLE IF NOT EXISTS official_promotions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  custom_music_id INTEGER NOT NULL REFERENCES custom_musics(id_music),
  official_music_id INTEGER NOT NULL,
  author_user_id INTEGER REFERENCES custom_users(id_user),
  promoted_by_user_id INTEGER REFERENCES custom_users(id_user),
  points_awarded INTEGER NOT NULL DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (official_music_id)
);
CREATE INDEX IF NOT EXISTS idx_promotions_author ON official_promotions(author_user_id);

-- Notificações in-app/e-mail do autor (F6.4).
CREATE TABLE IF NOT EXISTS user_notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES custom_users(id_user),
  type TEXT NOT NULL CHECK (type IN ('collection_published','curation_approved','curation_rejected','music_promoted','badge_granted')),
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  email_sent INTEGER NOT NULL DEFAULT 0,
  read_at DATETIME,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_notifications_user ON user_notifications(user_id, read_at);
