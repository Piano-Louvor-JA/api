-- 027_bible_es_catalog.sql
-- Catálogo da Bíblia em espanhol espelhado do mirror oficial
-- (api.louvorja.com.br) — issue Piano-louvor-JA/api#76.
-- Gerado por scripts/mirror-bible-es.ts — NÃO editar à mão;
-- regenere com: npx tsx scripts/mirror-bible-es.ts
-- Idempotente (INSERT OR IGNORE). Livros ES = ids 67..132;
-- versões ES = 10 (RV), 11 (RVA), 12 (SEV), language='es'.

INSERT OR IGNORE INTO languages (id_language, name) VALUES ('es', 'Espanhol');

-- Versões (bible_versions.id_version é TEXT: '10' != 10 do PT)
INSERT OR IGNORE INTO bible_versions (id_version, name, language, abbreviation) VALUES
  (10, 'Reina-Valera', 'es', 'RV'),
  (11, 'Reino-Valera 1989', 'es', 'RVA'),
  (12, 'Las Sagradas Escrituras', 'es', 'SEV');

-- Livros (ids 67..132 = bloco ES do ecossistema LouvorJA)
INSERT OR IGNORE INTO bible_books (id_book, name, abbreviation, chapters, book_number, id_language, testament, keywords, color) VALUES
  (67, 'Génesis', 'Gn', 50, 1, 'es', 1, 'genesis', '#01a2d9'),
  (68, 'Éxodo', 'Ex', 40, 2, 'es', 1, 'exodo', '#01a2d9'),
  (69, 'Levítico', 'Lv', 27, 3, 'es', 1, 'levitico', '#01a2d9'),
  (70, 'Números', 'Nm', 36, 4, 'es', 1, 'numeros', '#01a2d9'),
  (71, 'Deuteronomio', 'Dt', 34, 5, 'es', 1, 'deuteronomio', '#01a2d9'),
  (72, 'Josué', 'Js', 24, 6, 'es', 1, 'josue', '#85b000'),
  (73, 'Jueces', 'Jz', 21, 7, 'es', 1, 'jueces', '#85b000'),
  (74, 'Rut', 'Rt', 4, 8, 'es', 1, 'rut', '#85b000'),
  (75, 'I Samuel', '1Sm', 31, 9, 'es', 1, 'i samuel', '#85b000'),
  (76, 'II Samuel', '2Sm', 24, 10, 'es', 1, 'ii samuel', '#85b000'),
  (77, 'I Reyes', '1Re', 22, 11, 'es', 1, 'i reyes', '#85b000'),
  (78, 'II Reyes', '2Re', 25, 12, 'es', 1, 'ii reyes', '#85b000'),
  (79, 'I Crónicas', '1Cr', 29, 13, 'es', 1, 'i cronicas', '#85b000'),
  (80, 'II Crónicas', '2Cr', 36, 14, 'es', 1, 'ii cronicas', '#85b000'),
  (81, 'Esdras', 'Esd', 10, 15, 'es', 1, 'esdras', '#85b000'),
  (82, 'Nehemías', 'Neh', 13, 16, 'es', 1, 'nehemias', '#85b000'),
  (83, 'Ester', 'Est', 10, 17, 'es', 1, 'ester', '#85b000'),
  (84, 'Job', 'Job', 42, 18, 'es', 1, 'job', '#e18dff'),
  (85, 'Salmos', 'Sal', 150, 19, 'es', 1, 'salmos', '#e18dff'),
  (86, 'Proverbios', 'Prov', 31, 20, 'es', 1, 'proverbios', '#e18dff'),
  (87, 'Eclesiastés', 'Ecl', 12, 21, 'es', 1, 'eclesiastes', '#e18dff'),
  (88, 'Cantares', 'Cant', 8, 22, 'es', 1, 'cantares canticos', '#e18dff'),
  (89, 'Isaías', 'Is', 66, 23, 'es', 1, 'isaias', '#ff403f'),
  (90, 'Jeremías', 'Jer', 52, 24, 'es', 1, 'jeremias', '#ff403f'),
  (91, 'Lamentaciones', 'Lam', 5, 25, 'es', 1, 'lamentaciones', '#ff403f'),
  (92, 'Ezequiel', 'Ez', 48, 26, 'es', 1, 'ezequiel', '#ff403f'),
  (93, 'Daniel', 'Dn', 12, 27, 'es', 1, 'daniel', '#ff403f'),
  (94, 'Oseas', 'Os', 14, 28, 'es', 1, 'oseas', '#b18500'),
  (95, 'Joel', 'Jl', 3, 29, 'es', 1, 'joel', '#b18500'),
  (96, 'Amós', 'Am', 9, 30, 'es', 1, 'amos', '#b18500'),
  (97, 'Abdías', 'Abd', 1, 31, 'es', 1, 'abdias', '#b18500'),
  (98, 'Jonás', 'Jon', 4, 32, 'es', 1, 'jonas', '#b18500'),
  (99, 'Miqueas', 'Miq', 7, 33, 'es', 1, 'miqueas', '#b18500'),
  (100, 'Nahúm', 'Nah', 3, 34, 'es', 1, 'nahum', '#b18500'),
  (101, 'Habacuc', 'Hab', 3, 35, 'es', 1, 'habacuc', '#b18500'),
  (102, 'Sofonías', 'Sof', 3, 36, 'es', 1, 'sofonias', '#b18500'),
  (103, 'Hageo', 'Hag', 2, 37, 'es', 1, 'hageo', '#b18500'),
  (104, 'Zacarías', 'Zac', 14, 38, 'es', 1, 'zacarias', '#b18500'),
  (105, 'Malaquías', 'Mal', 4, 39, 'es', 1, 'malaquias', '#b18500'),
  (106, 'Mateo', 'Mt', 28, 40, 'es', 2, 'mateo', '#008c8d'),
  (107, 'Marcos', 'Mc', 16, 41, 'es', 2, 'marcos', '#008c8d'),
  (108, 'Lucas', 'Lc', 24, 42, 'es', 2, 'lucas', '#008c8d'),
  (109, 'Juan', 'Jn', 21, 43, 'es', 2, 'juan', '#008c8d'),
  (110, 'Hechos', 'Hch', 28, 44, 'es', 2, 'hechos', '#b265ff'),
  (111, 'Romanos', 'Rom', 16, 45, 'es', 2, 'romanos', '#ff6766'),
  (112, 'I Corintios', '1Co', 16, 46, 'es', 2, 'i corintios', '#ff6766'),
  (113, 'II Corintios', '2Co', 13, 47, 'es', 2, 'ii corintios', '#ff6766'),
  (114, 'Gálatas', 'Gal', 6, 48, 'es', 2, 'galatas', '#ff6766'),
  (115, 'Efesios', 'Ef', 6, 49, 'es', 2, 'efesios', '#ff6766'),
  (116, 'Filipenses', 'Fil', 4, 50, 'es', 2, 'filipenses', '#ff6766'),
  (117, 'Colosenses', 'Col', 4, 51, 'es', 2, 'colosenses', '#ff6766'),
  (118, 'I Tesalonicenses', '1Tes', 5, 52, 'es', 2, 'i tesalonicenses', '#ff6766'),
  (119, 'II Tesalonicenses', '2Tes', 3, 53, 'es', 2, 'ii tesalonicenses', '#ff6766'),
  (120, 'I Timoteo', '1Tim', 6, 54, 'es', 2, 'i timoteo', '#ff6766'),
  (121, 'II Timoteo', '2Tim', 4, 55, 'es', 2, 'ii timoteo', '#ff6766'),
  (122, 'Tito', 'Tit', 3, 56, 'es', 2, 'tito', '#ff6766'),
  (123, 'Filemón', 'Flm', 1, 57, 'es', 2, 'filemon', '#ff6766'),
  (124, 'Hebreos', 'Heb', 13, 58, 'es', 2, 'hebreos', '#7497ff'),
  (125, 'Santiago', 'Stg', 5, 59, 'es', 2, 'santiago', '#7497ff'),
  (126, 'I Pedro', '1Pe', 5, 60, 'es', 2, 'i pedro', '#7497ff'),
  (127, 'II Pedro', '2Pe', 3, 61, 'es', 2, 'ii pedro', '#7497ff'),
  (128, 'I Juan', '1Jn', 5, 62, 'es', 2, 'i juan', '#7497ff'),
  (129, 'II Juan', '2Jn', 1, 63, 'es', 2, 'ii juan', '#7497ff'),
  (130, 'III Juan', '3Jn', 1, 64, 'es', 2, 'iii juan', '#7497ff'),
  (131, 'Judas', 'Jud', 1, 65, 'es', 2, 'judas', '#7497ff'),
  (132, 'Apocalipsis', 'Ap', 22, 66, 'es', 2, 'apocalipsis', '#ffd140');
