#!/usr/bin/env python3
"""Empacota bible_cache do ebible-to-piano em data/json_db/bible_multilingue/.

Por idioma: {lang}_bible_chapters.tar.gz (JSONs bible_{v}_{b}_{c}.json),
{lang}_bible_book.json, {lang}_bible_version.json, {lang}_bible_catalog.sha256,
{lang}_report.json. Falha alto se contagem de arquivos divergir do report.
"""
import hashlib
import json
import re
import sys
import tarfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]  # worktree root (scripts/ebible-to-piano/..2)
CACHE = ROOT / "scripts/ebible-to-piano/out/bible_cache"
REPORTS = ROOT / "scripts/ebible-to-piano/out/reports"
OUT = ROOT / "data/json_db/bible_multilingue"

LANGS = ["pt", "es", "en", "fr", "ru", "uk", "it", "nl", "pl", "tr", "ja", "ko", "zh", "ar", "hi"]
# id_version por idioma (translations.py do T0)
VER = {"pt": 99, "es": 98, "en": 100, "fr": 101, "ru": 102, "uk": 103, "it": 104,
       "nl": 105, "pl": 106, "tr": 107, "ja": 108, "ko": 109, "zh": 110, "ar": 111, "hi": 112}
BOOK_BASE = {"pt": 132, "es": 67, "en": 200, "fr": 266, "ru": 332, "uk": 398, "it": 464,
             "nl": 530, "pl": 596, "tr": 662, "ja": 728, "ko": 794, "zh": 860, "ar": 926, "hi": 992}


def fail(msg: str) -> None:
    print(f"✗ {msg}", file=sys.stderr)
    sys.exit(1)


def sha256(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def extract_books(migration: str, lang: str) -> list[dict]:
    rows = []
    pat = re.compile(
        r"^\s*\((\d+),\s*'(?:[^']|'')*',\s*'[^']*',\s*(\d+),\s*(\d+),\s*'" + lang + r"',",
    )
    for line in migration.splitlines():
        m = pat.match(line)
        if m:
            id_book, chapters, book_number = int(m.group(1)), int(m.group(2)), int(m.group(3))
            # extrai name/abbr via split simples (colunas 2 e 3)
            parts = [p.strip() for p in line.strip().strip(",").split(",")]
            name = parts[1].strip("'")
            abbr = parts[2].strip("'")
            rows.append({"id_bible_book": id_book, "name": name, "abbreviation": abbr,
                         "chapters": chapters, "book_number": book_number})
    return sorted(rows, key=lambda r: r["book_number"])


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    # A migration do repo (040) NÃO contém pt/es (legados via 009/027); o
    # gerador emite out/migrations/028 com TODOS os 15 idiomas — é a fonte
    # de ids/nomes do packaging. (rework t_838c6ee4: packaging falhava com
    # "pt: 0 livros no migration" porque lia o 040 do repo.)
    migration = (Path(__file__).parent / "out" / "migrations" / "028_bible_multilingue.sql").read_text()
    manifest = {}
    for lang in LANGS:
        rep_path = REPORTS / f"{lang}_report.json"
        rep = json.loads(rep_path.read_text())
        books = extract_books(migration, lang)
        if len(books) != 66:
            fail(f"{lang}: {len(books)} livros no migration (esperado 66)")
        if rep["books"] != 66:
            fail(f"{lang}: report diz {rep['books']} livros")

        # coleta arquivos do cache
        v = VER[lang]
        base = BOOK_BASE[lang]
        # nomes reais do USFM (\toc1) via report — migration usa fallback pt
        rep_books = {b["book"]: b for b in rep["books_detail"]}
        for b in books:
            rb = rep_books.get(b["book_number"])
            if rb and rb.get("name"):
                b["name"] = rb["name"]

        names, total = [], 0
        # capítulos reais por livro: report (ko 1Pe truncado upstream — WARN T0).
        rep_ch = {b["book"]: b["chapters"] for b in rep["books_detail"]}
        for b in books:
            real = rep_ch.get(b["book_number"], b["chapters"])
            # F2 (QA t_dbd7397c/PR #308): o catálogo declara o CONTEÚDO REAL
            # (maior capítulo presente no tar), não o cânon — ko 1Pe: 4, não 5.
            b["chapters"] = real
            for ch in range(1, real + 1):
                n = f"bible_{v}_{b['id_bible_book']}_{ch}.json"
                p = CACHE / n
                if not p.exists():
                    fail(f"{lang}: faltando {n}")
                names.append(n)
                total += 1
        expected = rep["chapters"]
        if total != expected:
            fail(f"{lang}: {total} arquivos != report {expected} capítulos")
        if total != rep["chapters"] and not (lang == "ko" and total == rep["chapters"]):
            fail(f"{lang}: {total} != report chapters {rep['chapters']}")

        tar_path = OUT / f"{lang}_bible_chapters.tar.gz"
        # t_1fb85696: tar determinístico (mtime=0) — regen não deve alterar o sha256
        # de idiomas cujo conteúdo não mudou (zh/ru/ar/... byte-idênticos).
        with tarfile.open(tar_path, "w:gz") as tf:
            for n in names:
                ti = tf.gettarinfo(CACHE / n, arcname=n)
                ti.mtime = 0
                ti.uid = ti.gid = 0
                ti.uname = ti.gname = ""
                with open(CACHE / n, "rb") as fh:
                    tf.addfile(ti, fh)

        # catálogos no shape json_db (compatível com /json_db/{lang}_bible_book)
        (OUT / f"{lang}_bible_book.json").write_text(
            json.dumps(books, ensure_ascii=False, separators=(",", ":")), "utf-8")
        version = [{"id_bible_version": v, "name": rep["translation"],
                    "abbreviation": rep["abbreviation"]}]
        (OUT / f"{lang}_bible_version.json").write_text(
            json.dumps(version, ensure_ascii=False, separators=(",", ":")), "utf-8")

        lines = []
        for f in [tar_path, OUT / f"{lang}_bible_book.json", OUT / f"{lang}_bible_version.json"]:
            lines.append(f"{sha256(f)}  {f.name}")
        (OUT / f"{lang}_bible_catalog.sha256").write_text("\n".join(lines) + "\n", "utf-8")
        # report copiado para auditoria
        (OUT / f"{lang}_report.json").write_text(rep_path.read_text(), "utf-8")

        manifest[lang] = {"id_bible_version": v, "books": 66, "chapters": total,
                          "verses": rep["verses"], "tar": tar_path.name,
                          "sha256": sha256(tar_path)}
        print(f"✓ {lang}: 66 livros, {total} capítulos, {rep['verses']} versos")

    (OUT / "catalog.json").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2), "utf-8")
    print(f"✓ manifest: {OUT/'catalog.json'}")


if __name__ == "__main__":
    main()
