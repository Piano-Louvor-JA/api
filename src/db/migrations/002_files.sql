CREATE TABLE IF NOT EXISTS files (
  id_file INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT,
  path TEXT,
  type TEXT DEFAULT 'image',
  url TEXT,
  size INTEGER DEFAULT 0,
  dir TEXT,
  file_name TEXT,
  duration TEXT,
  version INTEGER,
  image_position INTEGER
);
