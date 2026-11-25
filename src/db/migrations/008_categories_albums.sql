CREATE TABLE IF NOT EXISTS categories_albums (
  id_category INTEGER NOT NULL,
  id_album INTEGER NOT NULL,
  name TEXT,
  "order" INTEGER,
  id_language TEXT,
  PRIMARY KEY (id_category, id_album),
  FOREIGN KEY (id_category) REFERENCES categories(id_category),
  FOREIGN KEY (id_album) REFERENCES albums(id_album)
);
