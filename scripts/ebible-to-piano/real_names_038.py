#!/usr/bin/env python3
"""Regenera 038_bible_multilingue.sql com nomes reais (\toc1 do USFM, via report).

Base: migration gerada pelo ebible_to_piano.py (fallback pt) + reports/*.json
(nomes reais por idioma). Mantém ids/estrutura — só substitui a coluna `name`
de bible_books para idiomas != pt.
"""
import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
MIG = ROOT / "src/db/migrations/038_bible_multilingue.sql"
REPORTS = ROOT / "scripts/ebible-to-piano/out/reports"

ROW_RE = re.compile(
    r"^  \((\d+), '(.*)', '(.*)', (\d+), (\d+), '(\w+)', (\d), '(.*)', '(#.*)'\),?$",
)


def main() -> None:
    text = MIG.read_text()
    out = []
    replaced = 0
    for line in text.splitlines(keepends=True):
        m = ROW_RE.match(line)
        if m and m.group(6) != "pt":
            lang = m.group(6)
            book_number = int(m.group(5))
            rep = json.loads((REPORTS / f"{lang}_report.json").read_text())
            names = {b["book"]: b["name"] for b in rep["books_detail"]}
            real = names.get(book_number)
            if real:
                name = real.replace("'", "''")
                newline = f"  ({m.group(1)}, '{name}', '{m.group(3)}', {m.group(4)}, {m.group(5)}, '{lang}', {m.group(7)}, '{m.group(8)}', '{m.group(9)}'),\n"
                if line != newline:
                    replaced += 1
                out.append(newline)
                continue
        out.append(line)
    MIG.write_text("".join(out))
    print(f"✓ {replaced} nomes substituídos por nomes reais (\\toc1)")


if __name__ == "__main__":
    main()
