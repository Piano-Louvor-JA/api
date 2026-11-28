#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""SPEC-v2 F-v2-api (dados) — empacota multi-versão em data/json_db/.

Por idioma afetado: adiciona os capítulos das versões novas ao
{lang}_bible_chapters.tar.gz EXISTENTE (v1 intocado), concatena livros no
{lang}_bible_book.json (v1 primeiro), N itens no {lang}_bible_version.json
(v1 em [0]), regenera {lang}_bible_catalog.sha256. Também gera a migration
041 (bible_versions + bible_books das novas versões) e atualiza o
bible_multilingue-clean (fixtures dos testes).

Falha alto se: contagem de membros divergir do report; KJV Gn 1 não
contiver o texto esperado; marker eBible em qualquer membro novo.
"""
from __future__ import annotations

import hashlib
import io
import json
import re
import sys
import tarfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

from translations import V2_BY_LANG, V2_TRANSLATIONS  # noqa: E402

from ebible_to_piano import BOOK_ABBR, BOOK_COLOR, CHAPTERS, BOOK_NAMES_FALLBACK, _section, _kw  # noqa: E402

ROOT = HERE.parents[1]
CACHE = HERE / "out" / "bible_cache"
REPORTS = HERE / "out" / "reports"
MIGR = ROOT / "src/db/migrations"
TARGETS = [ROOT / "data/json_db/bible_multilingue", ROOT / "data/json_db/bible_multilingue-clean"]

MARKER_RE = re.compile(r'\|strong="|\\\+w|\\k\s')

KJV_GN1_V1 = "In the beginning God created the heaven and the earth."


def fail(msg: str) -> None:
    print(f"✗ {msg}", file=sys.stderr)
    sys.exit(1)


def sha256(p: Path) -> str:
    h = hashlib.sha256()
    with open(p, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def load_v1_books(out_dir: Path, lang: str) -> list[dict]:
    return json.loads((out_dir / f"{lang}_bible_book.json").read_text())


def v2_report(t) -> dict:
    return json.loads((REPORTS / f"v2_{t.lang}_{t.id_bible_version}_report.json").read_text())


def new_books_json(t, rep: dict) -> list[dict]:
    """66 livros com ids 2000+..., nomes reais do \\toc1 (report books_detail)."""
    detail = {b["book"]: b for b in rep["books_detail"]}
    out = []
    for book in range(1, 67):
        id_book = t.id_book_base + book - 1
        d = detail.get(book, {})
        out.append({
            "id_bible_book": id_book,
            "name": d.get("name") or BOOK_NAMES_FALLBACK[book],
            "abbreviation": BOOK_ABBR[book],
            "chapters": d.get("chapters", CHAPTERS[book]),
            "book_number": book,
        })
    return out


def rebuild_tar(out_dir: Path, lang: str, v2s: list) -> None:
    """Reescreve {lang}_bible_chapters.tar.gz = membros v1 + membros v2."""
    tar_path = out_dir / f"{lang}_bible_chapters.tar.gz"
    old = tarfile.open(tar_path)
    old_members = {m.name: old.extractfile(m).read() for m in old.getmembers() if m.name.endswith(".json")}
    old.close()
    # idempotência (AC1): remove membros de versões v2 de execução anterior
    v2_prefixes = tuple(f"bible_{t.id_bible_version}_" for t in V2_TRANSLATIONS)
    old_members = {n: d for n, d in old_members.items() if not n.startswith(v2_prefixes)}
    new_entries: dict[str, bytes] = {}
    for t in v2s:
        rep = v2_report(t)
        detail = {b["book"]: b for b in rep["books_detail"]}
        for book in range(1, 67):
            for ch in range(1, detail[book]["chapters"] + 1):
                n = f"bible_{t.id_bible_version}_{t.id_book_base + book - 1}_{ch}.json"
                p = CACHE / n
                if not p.exists():
                    fail(f"{lang}: faltando {n}")
                data = p.read_bytes()
                if MARKER_RE.search(data.decode("utf-8")):
                    fail(f"marker eBible em {n} (AC4)")
                new_entries[n] = data
    overlap = set(old_members) & set(new_entries)
    if overlap:
        fail(f"{lang}: sobreposição de membros {sorted(overlap)[:3]}")
    if lang == "en":
        gn1 = json.loads(new_entries["bible_201_2100_1.json"])
        if gn1.get("1") != KJV_GN1_V1:
            fail("KJV Gn 1:1 com texto inesperado")
    with tarfile.open(tar_path, "w:gz") as tf:
        for name, data in {**old_members, **new_entries}.items():
            info = tarfile.TarInfo(name)
            info.size = len(data)
            tf.addfile(info, io.BytesIO(data))


def write_catalogs(out_dir: Path, lang: str, v2s: list) -> None:
    v2_ids = {t.id_bible_version for t in V2_TRANSLATIONS}
    v1_books = [b for b in load_v1_books(out_dir, lang)
                if int(b["id_bible_book"]) < 2000 or int(b["id_bible_book"]) > 3399]
    v1_versions = [v for v in json.loads((out_dir / f"{lang}_bible_version.json").read_text())
                   if int(v["id_bible_version"]) not in v2_ids]
    books = list(v1_books)
    versions = list(v1_versions)
    for t in v2s:
        rep = v2_report(t)
        books += new_books_json(t, rep)
        versions.append({"id_bible_version": t.id_bible_version,
                         "name": t.name, "abbreviation": t.abbreviation})
    (out_dir / f"{lang}_bible_book.json").write_text(
        json.dumps(books, ensure_ascii=False, separators=(",", ":")), "utf-8")
    (out_dir / f"{lang}_bible_version.json").write_text(
        json.dumps(versions, ensure_ascii=False, separators=(",", ":")), "utf-8")
    lines = []
    for f in [out_dir / f"{lang}_bible_chapters.tar.gz",
              out_dir / f"{lang}_bible_book.json",
              out_dir / f"{lang}_bible_version.json"]:
        lines.append(f"{sha256(f)}  {f.name}")
    (out_dir / f"{lang}_bible_catalog.sha256").write_text("\n".join(lines) + "\n", "utf-8")


def build_migration() -> str:
    lines = [
        "-- 041_bible_v2_multi_version.sql",
        "-- Gerado por scripts/ebible-to-piano/ebible_to_piano_v2.py — NÃO editar à mão.",
        "-- SPEC-v2 §4.1: ids 200-213, id_bible_book = 2000 + idx*100 + (book-1).",
        "-- Idempotente (INSERT OR IGNORE).",
        "",
        "INSERT OR IGNORE INTO bible_versions (id_version, name, language, abbreviation) VALUES",
    ]
    vrows = [f"  ({t.id_bible_version}, '{t.name}', '{t.lang}', '{t.abbreviation}')" for t in V2_TRANSLATIONS]
    lines += [r + "," for r in vrows[:-1]] + [vrows[-1] + ";"]
    lines.append("")
    lines.append("INSERT OR IGNORE INTO bible_books (id_book, name, abbreviation, chapters, book_number, id_language, testament, keywords, color) VALUES")
    brows = []
    for t in V2_TRANSLATIONS:
        for book in range(1, 67):
            id_book = t.id_book_base + book - 1
            name = BOOK_NAMES_FALLBACK[book]
            abbr = BOOK_ABBR[book]
            color = BOOK_COLOR.get(_section(book), "#008c8d")
            testament = 1 if book <= 39 else 2
            brows.append(f"  ({id_book}, '{name.replace(chr(39), chr(39)*2)}', '{abbr}', {CHAPTERS[book]}, {book}, '{t.lang}', {testament}, '{_kw(name)}', '{color}')")
    lines += [r + "," for r in brows[:-1]] + [brows[-1] + ";"]
    return "\n".join(lines) + "\n"


def main() -> int:
    sql = build_migration()
    (MIGR / "041_bible_v2_multi_version.sql").write_text(sql, encoding="utf-8", newline="\n")
    print("✓ migration 041_bible_v2_multi_version.sql")
    for lang, v2s in sorted(V2_BY_LANG.items()):
        for out_dir in TARGETS:
            rebuild_tar(out_dir, lang, v2s)
            write_catalogs(out_dir, lang, v2s)
            print(f"✓ {lang} ({out_dir.name}): {len(v1_count(out_dir, lang)) + sum(66 for _ in v2s)} livros, "
                  f"{len(json.loads((out_dir / f'{lang}_bible_version.json').read_text()))} versões")
    print("✓ catálogos + tarballs v2 prontos (bible_multilingue e -clean)")
    return 0


def v1_count(out_dir: Path, lang: str) -> list:
    return json.loads((out_dir / f"{lang}_bible_book.json").read_text())[:66]


if __name__ == "__main__":
    raise SystemExit(main())
