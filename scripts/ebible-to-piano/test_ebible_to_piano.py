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


# ---------- F1: strong= interlinear (QA t_dbd7397c, PR #308) ----------

def test_clean_strips_strong_attributes():
    """F1: \\w Word|strong="H8064"\\w* vira 'Word' — sem resíduo strong=."""
    raw = r'\w In|strong="H8064"\w* \w the|strong="H1254"\w* beginning'
    assert etp._clean(raw) == "In the beginning"


def test_parse_usfm_real_engwebp_fixture_no_strong():
    """F1: fixture USFM real do engwebp (Gn1) não serve strong= em nenhum verso."""
    raw = (HERE / "fixtures" / "engwebp_gen1_strong.usfm").read_text("utf-8")
    parsed = etp.parse_usfm(raw)
    text = " ".join(parsed["chapters"]["1"].values())
    assert "strong=" not in text
    assert "|" not in text
    assert "In the beginning God created" in text


# ---------- F2: catálogo chapters = conteúdo real (ko 1Pe, QA t_dbd7397c) ----------

def test_package_book_json_uses_real_chapters(monkeypatch, tmp_path):
    """F2: {lang}_bible_book.json deve declarar chapters do CONTEÚDO real (report),
    não do cânon — ko 1Pe upstream truncado: 4, não 5."""
    import package_bible_multilingue as pkg
    from pathlib import Path as P

    # ko 1Pe: id_bible_book 853, book_number 60; report diz 4 capítulos
    # books_detail de ko_report.json (T0, real): 60 -> chapters 4
    rep = {"books": 66, "chapters": 1188, "verses": 30000,
           "translation": "Korean Bible", "abbreviation": "ko",
           "books_detail": [
        {"book": 1, "name": "창세기", "chapters": 50, "verses": 1533, "sha256": "x"},
        {"book": 60, "name": "베드로전서", "chapters": 4, "verses": 80, "sha256": "y"},
    ]}

    class FakeP:
        def __init__(self, base): self.base = base
        def __truediv__(self, other): return FakeP(str(self) + "/" + str(other))
        def __str__(self): return self.base
        def read_text(self, *a, **k): return ""
        def write_text(self, *a, **k): pass
        def mkdir(self, *a, **k): pass
        def exists(self): return True
        def __getattr__(self, name): return FakeP(str(self))

    src = {}
    def fake_write(path, content):
        src[str(path)] = content

    import json as _json
    # isola: só o book.json de ko interessa
    captured = {}
    orig = pkg.json.dumps

    # roda a lógica de livro real com o mínimo: monkeypatch langs/reports/caches
    monkeypatch.setattr(pkg, "LANGS", ["ko"])
    monkeypatch.setattr(pkg, "REPORTS", FakeP("reports"))
    monkeypatch.setattr(pkg, "OUT", FakeP("out"))
    monkeypatch.setattr(pkg, "CACHE", FakeP("cache"))
    monkeypatch.setattr(pkg, "ROOT", FakeP("root"))

    def fake_loads(s):
        return rep
    monkeypatch.setattr(pkg.json, "loads", fake_loads)

    def fake_extract(migration, lang):
        return [{"id_bible_book": 794, "name": "창세기", "abbreviation": "Gn",
                 "chapters": 50, "book_number": 1},
                {"id_bible_book": 853, "name": "베드로전서", "abbreviation": "1Pe",
                 "chapters": 5, "book_number": 60}]
    monkeypatch.setattr(pkg, "extract_books", fake_extract)

    # stub sha256/tarfile p/ não tocar disco
    monkeypatch.setattr(pkg, "sha256", lambda p: "0" * 64)
    import tarfile as _tar
    class _TI:  # t_1fb85696: tar determinístico usa gettarinfo+addfile
        mtime = 0; uid = 0; gid = 0; uname = ""; gname = ""
    class _TF:
        def __enter__(self): return self
        def __exit__(self, *a): return False
        def add(self, *a, **k): pass
        def gettarinfo(self, *a, **k): return _TI()
        def addfile(self, *a, **k): pass
    monkeypatch.setattr(_tar, "open", lambda *a, **k: _TF())

    def fake_dump(obj, *a, **k):
        # captura somente o book.json (lista de dicts com id_bible_book)
        if isinstance(obj, list) and obj and isinstance(obj[0], dict) and "id_bible_book" in obj[0]:
            captured["books"] = obj
        return "[]"
    monkeypatch.setattr(pkg.json, "dumps", fake_dump)

    # report tem só 2 livros, mas o código exige 66 — stub dos checks de contagem
    checks = []
    def fake_fail(msg): checks.append(msg)
    monkeypatch.setattr(pkg, "fail", fake_fail)
    # cache existe=True para todo arquivo esperado
    pkg.main()
    # contagem de livros divergente é esperado no stub (66 != 2), mas não interessa aqui

    books = captured["books"]
    p1 = [b for b in books if b["book_number"] == 60][0]
    assert p1["chapters"] == 4, f"ko 1Pe deve declarar 4 (real), veio {p1['chapters']}"
    gn = [b for b in books if b["book_number"] == 1][0]
    assert gn["chapters"] == 50


# ---------- Footnote/cross-ref ABERTA (reviewer t_8dbd1429, rework) ----------

def test_parse_usfm_open_footnote_discarded():
    """Footnote \\f + ... aberta (sem \\f*) deve sair INTEIRA, sem vazar texto."""
    raw = "\\id GEN\n\\c 1\n\\v 1 Alpha \\f + \\ft note"
    parsed = etp.parse_usfm(raw)
    assert parsed["chapters"] == {"1": {"1": "Alpha"}}, parsed["chapters"]


def test_parse_usfm_open_footnote_stops_at_next_verse():
    """Footnote aberta descarta até o próximo \\v — não engole o verso seguinte."""
    raw = "\\id GEN\n\\c 1\n\\v 1 Alpha \\f + \\ft nota aberta\n\\v 2 Beta"
    parsed = etp.parse_usfm(raw)
    assert parsed["chapters"] == {"1": {"1": "Alpha", "2": "Beta"}}, parsed["chapters"]


def test_parse_usfm_open_footnote_stops_at_next_chapter():
    """Footnote aberta descarta até o próximo \\c — capítulo seguinte intacto."""
    raw = "\\id GEN\n\\c 1\n\\v 1 Alpha \\f + \\ft nota\n\\c 2\n\\v 1 Beta"
    parsed = etp.parse_usfm(raw)
    assert parsed["chapters"] == {"1": {"1": "Alpha"}, "2": {"1": "Beta"}}, parsed["chapters"]


def test_parse_usfm_open_crossref_discarded():
    """Cross-ref \\x ... aberta (sem \\x*) também não vaza conteúdo."""
    raw = "\\id GEN\n\\c 1\n\\v 1 Alpha \\xo 1.1 \\xt ref aberta"
    parsed = etp.parse_usfm(raw)
    assert parsed["chapters"] == {"1": {"1": "Alpha"}}, parsed["chapters"]


# ---------- Marcadores +w/+add escapando do _clean (rework: bible_100_241_12) ----------

def test_clean_strips_plus_w_markers():
    """Marcadores \\\\+w word\\\\+w* (wordlist) não podem sobreviver ao _clean."""
    raw = "\\+w Prends\\+w* \\+w courage\\+w* !"
    assert etp._clean(raw, "fr") == "Prends courage !"

def test_parse_usfm_luke12_no_plus_w():
    """Verso real en (Luke 12:2) não pode conter '\\\\+w' no texto servido."""
    parsed = etp.parse_usfm("\\id LUK\n\\c 12\n\\v 2 \\+w But\\+w* \\+w there\\+w* \\+w is\\+w* nothing covered up.")
    assert parsed["chapters"]["12"]["2"] == "But there is nothing covered up."


# ---------- Espaçamento sujo pós-remoção de \+w (t_1fb85696, engwebp en) ----------

def test_clean_collapses_leftover_double_spaces():
    raw = "\\+w The\\+w* \\+w Book\\+w* of the Wars."
    assert etp._clean(raw) == "The Book of the Wars."


def test_clean_removes_space_before_punctuation():
    raw = "\\+w The\\+w* Wars of the LORD , “Vaheb in Suphah"
    assert etp._clean(raw) == "The Wars of the LORD, \u201cVaheb in Suphah"


def test_clean_removes_space_before_period():
    raw = "even Jacob . Selah ."
    assert etp._clean(raw) == "even Jacob. Selah."


def test_clean_closes_apostrophe_s():
    raw = "\\+w God\\+w* \u2019s mouth"
    assert etp._clean(raw) == "God\u2019s mouth"


def test_clean_closes_apostrophe_nt():
    raw = "do n \u2019t"
    assert etp._clean(raw) == "do n\u2019t"


def test_clean_preserves_quote_apostrophes():
    raw = "he said \u2019 quote \u2019 ends"
    assert etp._clean(raw) == "he said \u2019 quote \u2019 ends"


def test_clean_removes_space_before_close_bracket_and_guillemet():
    raw = "(word ) and \u00bb end"
    assert etp._clean(raw) == "(word) and \u00bb end"


def test_clean_preserves_fr_nbsp():
    raw = "Il dit\u00a0: \u00ab Bonjour \u00bb"
    assert etp._clean(raw) == "Il dit\u00a0: \u00ab Bonjour \u00bb"
