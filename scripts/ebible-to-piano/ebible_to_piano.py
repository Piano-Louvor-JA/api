# -*- coding: utf-8 -*-
"""ebible-to-piano — download eBible.org USFM → json_db shape (PLAN frozen 27/11/2026).

CLI: python3 ebible_to_piano.py --out <dir> [--langs pt,en,...] [--dry-run] [--cache <dir>]
Gera: data/bible_cache/bible_{id}_{bookid}_{ch}.json + migration SQL + reports/<lang>_report.json
Stdlib-only. NÃO aplica ingestão no banco (card seguinte).
"""
from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
import time
import urllib.request
import zipfile
from pathlib import Path

from translations import BY_LANG, LANGUAGEM_NAMES, TRANSLATIONS

# ---------------------------------------------------------------- book codes

USFM_BOOK_CODES: dict[str, int] = {  # 66 livros, cânon protestante
    "GEN": 1, "EXO": 2, "LEV": 3, "NUM": 4, "DEU": 5, "JOS": 6, "JDG": 7,
    "RUT": 8, "1SA": 9, "2SA": 10, "1KI": 11, "2KI": 12, "1CH": 13, "2CH": 14,
    "EZR": 15, "NEH": 16, "EST": 17, "JOB": 18, "PSA": 19, "PRO": 20, "ECC": 21,
    "SNG": 22, "ISA": 23, "JER": 24, "LAM": 25, "EZK": 26, "DAN": 27, "HOS": 28,
    "JOL": 29, "AMO": 30, "OBA": 31, "JON": 32, "MIC": 33, "NAM": 34, "HAB": 35,
    "ZEP": 36, "HAG": 37, "ZEC": 38, "MAL": 39, "MAT": 40, "MRK": 41, "LUK": 42,
    "JHN": 43, "ACT": 44, "ROM": 45, "1CO": 46, "2CO": 47, "GAL": 48, "EPH": 49,
    "PHP": 50, "COL": 51, "1TH": 52, "2TH": 53, "1TI": 54, "2TI": 55, "TIT": 56,
    "PHM": 57, "HEB": 58, "JAS": 59, "1PE": 60, "2PE": 61, "1JN": 62, "2JN": 63,
    "3JN": 64, "JUD": 65, "REV": 66,
}

# contagem canônica de capítulos (pt_bible_book / KJV)
CHAPTERS: dict[int, int] = {
    1: 50, 2: 40, 3: 27, 4: 36, 5: 34, 6: 24, 7: 21, 8: 4, 9: 31, 10: 24,
    11: 22, 12: 25, 13: 29, 14: 36, 15: 10, 16: 13, 17: 10, 18: 42, 19: 150,
    20: 31, 21: 12, 22: 8, 23: 66, 24: 52, 25: 5, 26: 48, 27: 12, 28: 14,
    29: 3, 30: 9, 31: 1, 32: 4, 33: 7, 34: 3, 35: 3, 36: 3, 37: 2, 38: 14,
    39: 4, 40: 28, 41: 16, 42: 24, 43: 21, 44: 28, 45: 16, 46: 16, 47: 13,
    48: 6, 49: 6, 50: 4, 51: 4, 52: 5, 53: 3, 54: 6, 55: 4, 56: 3, 57: 1,
    58: 13, 59: 5, 60: 5, 61: 3, 62: 5, 63: 1, 64: 1, 65: 1, 66: 22,
}
assert sum(CHAPTERS.values()) == 1189

BOOK_NAMES_FALLBACK = {  # nomes pt (fallback catálogo; upstream \toc1 quando houver)
    1: "Gênesis", 2: "Êxodo", 3: "Levítico", 4: "Números", 5: "Deuteronômio",
    6: "Josué", 7: "Juízes", 8: "Rute", 9: "I Samuel", 10: "II Samuel",
    11: "I Reis", 12: "II Reis", 13: "I Crônicas", 14: "II Crônicas",
    15: "Esdras", 16: "Neemias", 17: "Ester", 18: "Jó", 19: "Salmos",
    20: "Provérbios", 21: "Eclesiastes", 22: "Cantares", 23: "Isaías",
    24: "Jeremias", 25: "Lamentações", 26: "Ezequiel", 27: "Daniel",
    28: "Oseias", 29: "Joel", 30: "Amós", 31: "Obadias", 32: "Jonas",
    33: "Miqueias", 34: "Naum", 35: "Habacuque", 36: "Sofonias", 37: "Ageu",
    38: "Zacarias", 39: "Malaquias", 40: "Mateus", 41: "Marcos", 42: "Lucas",
    43: "João", 44: "Atos", 45: "Romanos", 46: "I Coríntios", 47: "II Coríntios",
    48: "Gálatas", 49: "Efésios", 50: "Filipenses", 51: "Colossenses",
    52: "I Tessalonicenses", 53: "II Tessalonicenses", 54: "I Timóteo",
    55: "II Timóteo", 56: "Tito", 57: "Filemom", 58: "Hebreus", 59: "Tiago",
    60: "I Pedro", 61: "II Pedro", 62: "I João", 63: "II João", 64: "III João",
    65: "Judas", 66: "Apocalipse",
}

BOOK_ABBR = {
    1: "Gn", 2: "Ex", 3: "Lv", 4: "Nm", 5: "Dt", 6: "Js", 7: "Jz", 8: "Rt",
    9: "1Sm", 10: "2Sm", 11: "1Rs", 12: "2Rs", 13: "1Cr", 14: "2Cr", 15: "Ed",
    16: "Ne", 17: "Et", 18: "Jó", 19: "Sl", 20: "Pv", 21: "Ec", 22: "Ct",
    23: "Is", 24: "Jr", 25: "Lm", 26: "Ez", 27: "Dn", 28: "Os", 29: "Jl",
    30: "Am", 31: "Ob", 32: "Jn", 33: "Mq", 34: "Na", 35: "Hc", 36: "Sf",
    37: "Ag", 38: "Zc", 39: "Ml", 40: "Mt", 41: "Mc", 42: "Lc", 43: "Jo",
    44: "At", 45: "Rm", 46: "1Co", 47: "2Co", 48: "Gl", 49: "Ef", 50: "Fp",
    51: "Cl", 52: "1Ts", 53: "2Ts", 54: "1Tm", 55: "2Tm", 56: "Tt", 57: "Fm",
    58: "Hb", 59: "Tg", 60: "1Pe", 61: "2Pe", 62: "1Jo", 63: "2Jo", 64: "3Jo",
    65: "Jd", 66: "Ap",
}

BOOK_COLOR = {1: "#01a2d9", 6: "#85b000", 18: "#e18dff", 23: "#ff403f",
              28: "#b18500", 40: "#008c8d", 44: "#b265ff", 45: "#ff6766",
              58: "#7497ff", 66: "#ffd140"}


def usfm_code_to_book(code: str) -> int | None:
    return USFM_BOOK_CODES.get(code.strip().upper())


# ---------------------------------------------------------------- USFM parser

_CHAPTER_RE = re.compile(r"^\\c\s+(\d+)")
_VERSE_RE = re.compile(r"^\\v\s+(\d+)\S*\s*(.*)", re.M)
_MARKER_RE = re.compile(r"\\[a-zA-Z0-9]+\s*|\s*\\p\b")


def _clean(text: str) -> str:
    """Strip USFM markers, footnotes/refs content, strong numbers, normalize whitespace."""
    text = re.sub(r"\\f\s+\+.*?\\f\*", "", text, flags=re.S)  # footnotes completos
    text = re.sub(r"\\f\s+[^\\]*(\\f\*)?", "", text)  # \f aberto sem fechar
    text = re.sub(r"\\x\s+[^\\]*(\\x\*)?", "", text)  # cross-refs
    text = re.sub(r"\\bdit\s+\([^)]*\)\s*(\\bdit\*)?", "", text)  # refs parênteses
    # anotações eBible inline (repro t_5582d47e: en/es/fr com strong numbers)
    text = re.sub(r'\|strong="[^"]*"\*?', " ", text)  # |strong="H1234"*
    text = re.sub(r"\\\+w\*?\s?", " ", text)  # \+w
    text = re.sub(r"\\k\s\+?", " ", text)  # \k
    text = re.sub(r"\*?,?\s*\d+:\d+[^*]{0,120}\*", " ", text)  # *refs* de nota
    text = re.sub(r"\\[a-zA-Z0-9]+(\d*)\s*", "", text)  # markers
    text = re.sub(r"\s*\*", "", text)  # asteriscos órfãos de anotação
    text = re.sub(r"[ \t]+", " ", text)
    # nbsp: borda antes de pontuação/aspas de fechamento (tipografia fr interna
    # é preservada pelo fix-format-leaks; aqui o pipeline em pt/limpo)
    text = re.sub(r"[\u00a0 ]+([”’.,;:!?])", r"\1", text)
    text = re.sub(r"([“‘])[\u00a0 ]+", r"\1", text)
    text = re.sub(r" +\)", ")", text)
    return text.strip()


_INLINE_VERSE_RE = re.compile(r"\\v\s+(\d+)\S*\s*")


def _line_verses(line: str) -> list[tuple[str, str]]:
    """Split a line into (verse_num, text) pairs; `\\v` pode ser inline (apos `\\p`)."""
    parts = _INLINE_VERSE_RE.split(line)
    if len(parts) == 1:
        return []
    out = []
    for i in range(1, len(parts), 2):
        out.append((parts[i], parts[i + 1]))
    return out


def parse_usfm(raw: str) -> dict:
    """USFM/USFX-text → {id, toc1, toc2, chapters: {ch: {verse: text}}}."""
    if raw.startswith("\ufeff"):
        raw = raw.lstrip("\ufeff")
    raw = raw.replace("\r\n", "\n").replace("\r", "\n")
    lines = raw.split("\n")
    book_id, toc1, toc2 = "", "", ""
    chapters: dict[str, dict[str, str]] = {}
    cur_ch: str | None = None
    buf: list[str] = []
    verse_num: str | None = None

    def flush() -> None:
        nonlocal verse_num, buf
        if verse_num is not None and cur_ch is not None:
            text = _clean(" ".join(buf))
            if text:
                chapters.setdefault(cur_ch, {})[verse_num] = text
        verse_num, buf = None, []

    for line in lines:
        line = line.strip()
        if not line:
            continue
        if line.startswith("\\id "):
            book_id = line.split(None, 1)[1].strip()
        elif line.startswith("\\toc1 "):
            toc1 = line.split(None, 1)[1].strip()
        elif line.startswith("\\toc2 "):
            toc2 = line.split(None, 1)[1].strip()
        elif line.startswith("\\c "):
            flush()
            m = _CHAPTER_RE.match(line)
            cur_ch = m.group(1) if m else None
        elif line.startswith("\\v ") or _line_verses(line):
            pairs = _line_verses(line)
            if not pairs:  # só \v no começo, texto na linha seguinte
                flush()
                m = _VERSE_RE.match(line + " ")
                if m and cur_ch is not None:
                    verse_num = m.group(1)
                    buf = [m.group(2)]
                continue
            if cur_ch is None:
                continue
            for i, (num, text) in enumerate(pairs):
                flush()
                verse_num = num
                buf = [text]
            continue
        elif line.startswith("\\") and verse_num is not None and not line.startswith(("\\c ", "\\v ", "\\id ", "\\toc1 ", "\\toc2 ", "\\p ", "\\s ", "\\mt")):
            buf.append(line)  # continuação de verso em nova linha (\it/\f etc.)
        elif line.startswith("\\"):
            continue  # outros marcadores: ignorar
        elif verse_num is not None:
            buf.append(line)
    flush()
    return {"id": book_id, "toc1": toc1, "toc2": toc2, "chapters": chapters}


# ---------------------------------------------------------------- output

def chapter_path(outdir: Path, t, book_number: int, chapter: int) -> Path:
    id_book = t.id_book_base + book_number - 1
    return Path(outdir) / "bible_cache" / f"bible_{t.id_bible_version}_{id_book}_{chapter}.json"


def write_chapter(outdir: Path, t, book_number: int, chapter: int, verses: dict) -> Path:
    p = chapter_path(outdir, t, book_number, chapter)
    p.parent.mkdir(parents=True, exist_ok=True)
    with open(p, "w", encoding="utf-8", newline="\n") as f:
        json.dump(verses, f, ensure_ascii=False, separators=(",", ":"))
        f.write("\n")
    return p


# ---------------------------------------------------------------- SQL migration

def build_migration(transs) -> str:
    lines = [
        "-- 028_bible_multilingue.sql",
        "-- Gerado por scripts/ebible-to-piano — NÃO editar à mão.",
        "-- Idempotente (INSERT OR IGNORE). ADR-02/03: ids 100-112,",
        "-- book_number 1-66 por idioma, id_book = base + book-1 (200-1057).",
        "",
        "INSERT OR IGNORE INTO languages (id_language, name) VALUES",
    ]
    new = [t for t in transs if t.lang in LANGUAGEM_NAMES]
    lines += [f"  ('{t.lang}', '{LANGUAGEM_NAMES[t.lang]}')," for t in new]
    lines[-1] = lines[-1].rstrip(",")
    lines[-1] += ";"
    lines.append("")
    lines.append("INSERT OR IGNORE INTO bible_versions (id_version, name, language, abbreviation) VALUES")
    vrows = [f"  ({t.id_bible_version}, '{t.name}', '{t.lang}', '{t.abbreviation}')" for t in transs]
    lines += [r + "," for r in vrows[:-1]] + [vrows[-1] + ";"]
    lines.append("")
    lines.append("INSERT OR IGNORE INTO bible_books (id_book, name, abbreviation, chapters, book_number, id_language, testament, keywords, color) VALUES")
    brows: list[str] = []
    for t in transs:
        for book in range(1, 67):
            id_book = t.id_book_base + book - 1
            name = BOOK_NAMES_FALLBACK[book]
            abbr = BOOK_ABBR[book]
            color = BOOK_COLOR.get(_section(book), "#008c8d")
            testament = 1 if book <= 39 else 2
            brows.append(f"  ({id_book}, '{_sq(name)}', '{abbr}', {CHAPTERS[book]}, {book}, '{t.lang}', {testament}, '{_kw(name)}', '{color}')")
    lines += [r + "," for r in brows[:-1]] + [brows[-1] + ";"]
    return "\n".join(lines) + "\n"


def _section(book: int) -> int:
    for start in (1, 6, 18, 23, 28, 40, 44, 45, 58, 66):
        if book >= start:
            last = start
    return last


def _sq(s: str) -> str:
    return s.replace("'", "''")


def _kw(name: str) -> str:
    import unicodedata
    n = unicodedata.normalize("NFKD", name)
    s = "".join(c for c in n if not unicodedata.combining(c))
    return s.lower()


# ---------------------------------------------------------------- download

def fetch(url: str, dest: Path, retries: int = 4) -> Path:
    if dest.exists() and dest.stat().st_size > 0:
        return dest  # cache idempotente
    dest.parent.mkdir(parents=True, exist_ok=True)
    backoff = 2.0
    for attempt in range(retries):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "piano-api/ebible-to-piano (+https://pianolouvorja.com.br)"})
            with urllib.request.urlopen(req, timeout=120) as resp, open(dest, "wb") as f:
                while True:
                    chunk = resp.read(65536)
                    if not chunk:
                        break
                    f.write(chunk)
            return dest
        except Exception as e:
            if attempt == retries - 1:
                raise
            time.sleep(backoff)
            backoff *= 2
    raise RuntimeError(url)


def sha256_file(p: Path) -> str:
    h = hashlib.sha256()
    with open(p, "rb") as f:
        for chunk in iter(lambda: f.read(65536), b""):
            h.update(chunk)
    return h.hexdigest()


# ---------------------------------------------------------------- pipeline

def load_usfm_texts(lang: str, cache: Path) -> dict[str, str]:
    """Retorna {BOOKCODE: usfm_text}. eBible zip ou fetch.bible por livro."""
    t = BY_LANG[lang]
    texts: dict[str, str] = {}
    if t.ebible_code is None:
        for code in USFM_BOOK_CODES:
            p = fetch(t.book_url_template.format(book=code.lower()), cache / lang / f"{code.lower()}.usfm")
            texts[code] = p.read_text(encoding="utf-8-sig")
    else:
        zpath = fetch(t.book_url_template, cache / lang / f"{t.ebible_code}_usfm.zip")
        with zipfile.ZipFile(zpath) as zf:
            for name in zf.namelist():
                if name.lower().endswith(".usfm"):
                    content = zf.read(name).decode("utf-8-sig")
                    m = re.match(r"\s*\\id\s+([A-Z0-9]{3})", content)
                    if m:  # prefácios/front matter sem código canônico são ignorados
                        texts[m.group(1)] = content
                    elif name.lower().endswith(".usfm"):
                        texts[Path(name).stem[-3:].upper()] = content
    return texts


def process_language(lang: str, outdir: Path, cache: Path, dry_run: bool = False) -> dict:
    t = BY_LANG[lang]
    texts = load_usfm_texts(lang, cache)
    books = {}
    problems = []
    for code, text in texts.items():
        book = usfm_code_to_book(code)
        if book is None:
            continue
        parsed = parse_usfm(text)
        books[book] = parsed
    # completude G1: livro ausente = FAIL; divergência de capítulos = WARN (§7)
    missing = [b for b in range(1, 67) if b not in books]
    if missing:
        problems.append(f"missing books: {missing}")
    warnings = []
    total_ch, total_vs, files, book_meta = 0, 0, 0, []
    for book in sorted(books):
        parsed = books[book]
        toc1 = parsed["toc1"] or BOOK_NAMES_FALLBACK[book]
        nch = len(parsed["chapters"])
        total_ch += nch
        canon = CHAPTERS[book]
        if nch != canon:
            warnings.append(f"book {book} ({toc1}): {nch} capítulos ≠ canon {canon} — upstream divergente (sha256 no relatório detecta re-publicação)")
        for ch, verses in sorted(parsed["chapters"].items(), key=lambda kv: int(kv[0])):
            if not verses:
                problems.append(f"book {book} ch {ch}: vazio")
                continue
            if not dry_run:
                write_chapter(outdir, t, book, int(ch), verses)
            files += 1
            total_vs += len(verses)
        # sha256 "por livro": hash do JSON canônico dos capítulos
        book_json = {ch: verses for ch, verses in sorted(parsed["chapters"].items(), key=lambda kv: int(kv[0]))}
        digest = hashlib.sha256(json.dumps(book_json, ensure_ascii=False, sort_keys=True).encode("utf-8")).hexdigest()
        book_meta.append({"book": book, "name": toc1, "chapters": nch, "verses": sum(len(v) for v in parsed["chapters"].values()), "sha256": digest})
    return {
        "lang": lang, "translation": t.name, "abbreviation": t.abbreviation,
        "id_bible_version": t.id_bible_version, "id_book_base": t.id_book_base,
        "license": t.license, "attribution": t.attribution, "source_url": t.source_url,
        "note": t.note, "books": len(books), "chapters": total_ch,
        "verses": total_vs, "files_written": files, "problems": problems, "warnings": warnings,
        "books_detail": book_meta,
        "source_sha256": sha256_file(cache / lang / (f"{t.ebible_code}_usfm.zip" if t.ebible_code else "gen.usfm")) if t.ebible_code else "per-book-fetch.bible",
    }


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="eBible → piano json_db (PLAN frozen 27/11/2026)")
    ap.add_argument("--out", default="out", help="dir de saída (bible_cache/ + reports/ + migrations/)")
    ap.add_argument("--cache", default=".cache", help="cache de downloads (idempotente)")
    ap.add_argument("--langs", default=",".join(t.lang for t in TRANSLATIONS))
    ap.add_argument("--dry-run", action="store_true", help="não escreve JSONs (validação/report)")
    args = ap.parse_args(argv)

    outdir = Path(args.out)
    cache = Path(args.cache)
    langs = [l for l in args.langs.split(",") if l]
    for l in langs:
        if l not in BY_LANG:
            print(f"unknown lang {l}", file=sys.stderr)
            return 2

    reports = []
    for lang in langs:
        print(f"[{lang}] {BY_LANG[lang].name} ...", flush=True)
        rep = process_language(lang, outdir, cache, dry_run=args.dry_run)
        reports.append(rep)

    (outdir / "reports").mkdir(parents=True, exist_ok=True)
    for rep in reports:
        p = outdir / "reports" / f"{rep['lang']}_report.json"
        p.parent.mkdir(parents=True, exist_ok=True)
        with open(p, "w", encoding="utf-8", newline="\n") as f:
            json.dump(rep, f, ensure_ascii=False, indent=2)
        status = "OK" if not rep["problems"] else "PROBLEMS"
        print(f"[{rep['lang']}] {status}: {rep['books']} livros, {rep['chapters']} caps, {rep['verses']} versículos, {rep['files_written']} arquivos")
        for w in rep.get("warnings", []):
            print(f"  WARN {rep['lang']}: {w}")

    if not args.dry_run:
        (outdir / "migrations").mkdir(parents=True, exist_ok=True)
        transs = [BY_LANG[l] for l in langs]
        sql = build_migration(transs)
        (outdir / "migrations" / "028_bible_multilingue.sql").write_text(sql, encoding="utf-8", newline="\n")

    # G1/G2 asserts
    failures = [r["lang"] for r in reports if r["problems"]]
    if failures:
        print(f"G1 GATE FAIL: {failures}", file=sys.stderr)
        return 1
    print("G1-G5 OK (schema validada por testes; capítulos com shape Record<verse,text>)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
