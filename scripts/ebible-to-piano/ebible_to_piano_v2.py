#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""SPEC-v2 F-v2-pipeline — processa as versões extras (V2_TRANSLATIONS).

Gera out/bible_cache/bible_{200+idx}_{2000+idx*100+b}_{ch}.json +
reports/v2_{lang}_{code}_report.json por versão + assert de colisão de
id_bible_book contra TODOS os {lang}_bible_book.json atuais (v1) e entre
as novas. Cache de zips em cache/ (gitignored, mesmo download do v1:
GET com UA de navegador).
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from ebible_to_piano import process_translation  # noqa: E402
from translations import V2_BY_LANG, V2_TRANSLATIONS  # noqa: E402

HERE = Path(__file__).resolve().parent
OUT = HERE / "out"
CACHE = HERE / "cache"
JSON_DB = HERE.parents[1] / "data" / "json_db"
JSON_DB_MULTI = JSON_DB / "bible_multilingue"


def fail(msg: str) -> None:
    print(f"✗ {msg}", file=sys.stderr)
    sys.exit(1)


def existing_book_ids() -> set[int]:
    ids: set[int] = set()
    for d in (JSON_DB, JSON_DB_MULTI):
        for p in sorted(d.glob("*_bible_book.json")):
            try:
                for b in json.loads(p.read_text()):
                    ids.add(int(b["id_bible_book"]))
            except Exception as e:  # noqa: BLE001
                fail(f"não pude ler {p}: {e}")
    return ids


def main() -> int:
    reports: list[dict] = []
    for t in V2_TRANSLATIONS:
        print(f"[v2 {t.lang}] {t.name} (id {t.id_bible_version}) ...", flush=True)
        rep = process_translation(t, OUT, CACHE)
        rep["v2"] = True
        rep["license"] = "public domain"
        reports.append(rep)
        status = "OK" if not rep["problems"] else "PROBLEMS"
        print(f"[v2 {t.lang}] {status}: {rep['books']} livros, {rep['chapters']} caps, {rep['verses']} versos")

    (OUT / "reports").mkdir(parents=True, exist_ok=True)
    for rep in reports:
        p = OUT / "reports" / f"v2_{rep['lang']}_{rep['id_bible_version']}_report.json"
        p.write_text(json.dumps(rep, ensure_ascii=False, indent=2), encoding="utf-8", newline="\n")

    # SPEC §4.1: assert de colisão — novos ids não podem existir em nenhum
    # catálogo atual, nem se repetir entre novas versões.
    existing = existing_book_ids()
    seen: set[int] = set()
    for t in V2_TRANSLATIONS:
        for book in range(1, 67):
            id_book = t.id_book_base + book - 1
            if id_book in existing:
                fail(f"colisão: id_bible_book {id_book} já existe (v1)")
            if id_book in seen:
                fail(f"colisão: id_bible_book {id_book} duplicado entre versões v2")
            seen.add(id_book)
    print(f"✓ assert colisão id_bible_book verde ({len(seen)} novos ids, {len(existing)} existentes)")

    failures = [r["lang"] for r in reports if r["problems"]]
    if failures:
        print(f"GATE FAIL: {failures}", file=sys.stderr)
        return 1
    manifest = {
        str(t.id_bible_version): {"lang": t.lang, "code": t.ebible_code,
                                  "books": next(r for r in reports if r["id_bible_version"] == t.id_bible_version)["books"]}
        for t in V2_TRANSLATIONS
    }
    (OUT / "v2_manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"✓ v2_manifest: {OUT/'v2_manifest.json'}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
