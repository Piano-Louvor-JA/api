# -*- coding: utf-8 -*-
"""Testes — sem rede (unit). PLAN §5 TDD: testes ANTES do parser."""
from __future__ import annotations

import json
import sys
from pathlib import Path

HERE = Path(__file__).parent
sys.path.insert(0, str(HERE))

import ebible_to_piano as etp  # noqa: E402
from translations import TRANSLATIONS, BY_LANG, LANGUAGEM_NAMES  # noqa: E402


# ---------- translations table ----------

def test_15_translations():
    assert len(TRANSLATIONS) == 15


def test_unique_ids_no_collision():  # G3
    ids = [t.id_bible_version for t in TRANSLATIONS]
    assert len(ids) == len(set(ids))
    occupied = set(range(1, 10)) | {13} | {10, 11, 12}
    for t in TRANSLATIONS:
        assert t.id_bible_version not in occupied or t.lang in ("pt", "es"), t.lang


def test_new_ids_are_100_112():
    new = sorted(t.id_bible_version for t in TRANSLATIONS if t.lang not in ("pt", "es"))
    assert new == list(range(100, 113))


def test_new_book_ranges_200_1057():  # ADR-03
    new = [t for t in TRANSLATIONS if t.lang not in ("pt", "es")]
    bases = sorted(t.id_book_base for t in new)
    assert bases == list(range(200, 1058, 66))
    # pt/es usam blocos legacy (1-66 / 67-132) → sem overlap
    for t in new:
        for book in range(1, 67):
            assert t.id_book_base + book - 1 not in set(range(1, 133))


def test_book_id_formula():
    t = BY_LANG["ru"]
    assert t.id_book_base + 42 == 374  # livro 43 (João) → id_book 374


def test_every_version_has_license_and_url():  # G4
    for t in TRANSLATIONS:
        assert t.license and t.source_url and t.attribution


def test_hi_uses_fetchbible():  # ADR-01
    assert BY_LANG["hi"].ebible_code is None
    assert "{book}" in BY_LANG["hi"].book_url_template


def test_languages_names_cover_13():
    assert len(LANGUAGEM_NAMES) == 13


# ---------- USFM parser ----------

FIXTURE = (HERE / "fixtures" / "minimal.usfm").read_text(encoding="utf-8")


def test_parse_book_id():
    assert etp.parse_usfm(FIXTURE)["id"] == "GEN"


def test_parse_toc1():
    assert etp.parse_usfm(FIXTURE)["toc1"] == "Gênesis"


def test_parse_chapters_shape():
    chapters = etp.parse_usfm(FIXTURE)["chapters"]
    assert list(chapters.keys()) == ["1", "2"]


def test_parse_verses_shape():  # G2: Record<verse:string, texto>
    ch1 = etp.parse_usfm(FIXTURE)["chapters"]["1"]
    assert ch1 == {"1": "No princípio criou Deus os céus e a terra.",
                   "2": "E a terra era sem forma e vazia; e havia trevas sobre a face do abismo.",
                   "5": "E chamou Deus à luz Dia, e às trevas chamou Noite."}


def test_sanitization_strips_markers_and_whitespace():
    ch1 = etp.parse_usfm(FIXTURE)["chapters"]["1"]
    assert "\\p" not in ch1["5"]
    assert "  " not in ch1["5"] and ch1["5"] == ch1["5"].strip()


def test_crlf_bom_tolerant():
    raw = "\ufeff\\id GEN\r\n\\c 1\r\n\\v 1 A.\r\n".replace("A.", "No princípio.")
    assert etp.parse_usfm(raw)["chapters"]["1"] == {"1": "No princípio."}


def test_verse_regex_number_only():
    raw = "\\id GEN\n\\c 1\n\\v 2b E a terra.\n"
    ch = etp.parse_usfm(raw)["chapters"]["1"]
    assert list(ch.keys()) == ["2"]


# ---------- book codes / mapping ----------

def test_usfm_code_to_book_number():
    assert etp.usfm_code_to_book("GEN") == 1
    assert etp.usfm_code_to_book("JHN") == 43
    assert etp.usfm_code_to_book("REV") == 66
    assert etp.usfm_code_to_book("XXX") is None


def test_66_book_codes_present():
    assert len(etp.USFM_BOOK_CODES) == 66
    assert len(set(etp.USFM_BOOK_CODES.values())) == 66


# ---------- output files ----------

def test_chapter_filename():
    t = BY_LANG["ru"]
    assert etp.chapter_path("out", t, 43, 3).name == "bible_102_374_3.json"


def test_write_chapter_json_roundtrip(tmp_path):  # G5 UTF-8
    t = BY_LANG["ru"]
    verses = {"1": "В начале"}
    p = etp.write_chapter(tmp_path, t, 1, 1, verses)
    raw = p.read_bytes()
    assert not raw.startswith(b"\xef\xbb\xbf")
    back = json.loads(raw.decode("utf-8"))
    assert back == verses


# ---------- SQL migration ----------

def test_migration_sql_contains_insert_or_ignore():
    sql = etp.build_migration([BY_LANG["ru"]])
    assert "INSERT OR IGNORE" in sql


def test_migration_idempotent(tmp_path):  # G6 — requires sqlite3 CLI
    import shutil, sqlite3, subprocess
    if not shutil.which("sqlite3"):
        return
    db = tmp_path / "t.db"
    con = sqlite3.connect(db)
    con.executescript("""
      CREATE TABLE languages (id_language TEXT PRIMARY KEY, name TEXT);
      CREATE TABLE bible_versions (id_version TEXT PRIMARY KEY, name TEXT, language TEXT, abbreviation TEXT);
      CREATE TABLE bible_books (id_book INTEGER PRIMARY KEY, name TEXT, abbreviation TEXT, chapters INTEGER, book_number INTEGER, id_language TEXT, testament INTEGER, keywords TEXT, color TEXT);
    """)
    con.commit(); con.close()
    sql = etp.build_migration([BY_LANG["ru"]])
    f = tmp_path / "m.sql"; f.write_text(sql, encoding="utf-8")
    for _ in range(2):  # 2× sem erro
        r = subprocess.run(["sqlite3", str(db), ".read " + str(f)], capture_output=True, text=True)
        assert r.returncode == 0, r.stderr
    con = sqlite3.connect(db)
    assert con.execute("SELECT COUNT(*) FROM bible_books WHERE id_language='ru'").fetchone()[0] == 66
    con.close()


def test_migration_book_rows_use_adr03():
    sql = etp.build_migration([BY_LANG["ru"]])
    assert "(332, " in sql  # Gênesis ru = 332 + book_number(1) - 1
