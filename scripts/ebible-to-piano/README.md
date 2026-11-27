# Bíblia Multilíngue — 15 idiomas (json_db)

Ingestão dos dados eBible.org (script `ebible_to_piano.py`, T0) na API:
catálogos + capítulos por idioma, servidos pelos endpoints compat.

## Componentes

- `ebible_to_piano.py` — download USFM eBible.org → JSONs `bible_{v}_{b}_{c}.json`
  + migration + reports sha256 (T0, card t_a0945ef3)
- `package_bible_multilingue.py` — empacota `out/bible_cache` em
  `data/json_db/bible_multilingue/`: tarball por idioma + `{lang}_bible_book.json`
  + `{lang}_bible_version.json` + `{lang}_bible_catalog.sha256` + report + manifest
- `real_names_038.py` — regenera `src/db/migrations/038_bible_multilingue.sql`
  com nomes reais (`\toc1` do USFM) em vez do fallback pt
- `ingest-bible-multilingue.sh` — deploy no servidor: valida checksums, extrai
  capítulos para `data/bible_cache/`, restart (migrations no boot), valida endpoints

## Endpoints (compat, já consumidos pelo app por locale)

- `GET /json_db/{lang}_bible_book` — 66 livros (DB, migration 038)
- `GET /json_db/{lang}_bible_version` — versão própria por idioma
- `GET /json_db/bible_{version}_{book}_{chapter}` — capítulo (cache local primeiro,
  proxy upstream como fallback)
- `GET /json_db` — manifest com os 15 idiomas

Idiomas: pt, es, en, fr, ru, uk, it, nl, pl, tr, ja, ko, zh, ar, hi.

## Regenerar tudo (idempotente)

```bash
python3 scripts/ebible-to-piano/ebible_to_piano.py            # download + parse
cp scripts/ebible-to-piano/out/migrations/028_bible_multilingue.sql \
   src/db/migrations/038_bible_multilingue.sql
python3 scripts/ebible-to-piano/real_names_038.py             # nomes reais na migration
python3 scripts/ebible-to-piano/package_bible_multilingue.py  # tarballs + checksums + manifest
```

## Deploy (staging)

```bash
# no servidor, no checkout da API:
bash scripts/ebible-to-piano/ingest-bible-multilingue.sh
```

## Warnings conhecidos

- ko 1Pedro: upstream eBible truncado (4 capítulos ≠ cânon 5) — sha256 no report
  detecta re-publicação; catalog.json marca `chapters: 1188`.
- hi João 3: 35 versos (IRV versification).
