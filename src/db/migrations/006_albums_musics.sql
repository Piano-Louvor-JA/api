CREATE TABLE IF NOT EXISTS albums_musics (
  id_album INTEGER NOT NULL,
  id_music INTEGER NOT NULL,
  track INTEGER,
  id_language TEXT,
  PRIMARY KEY (id_album, id_music),
  FOREIGN KEY (id_album) REFERENCES albums(id_album),
  FOREIGN KEY (id_music) REFERENCES musics(id_music)
);
