#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Fix cirúrgico de leaks de formatação nos tarballs (t_5582d47e repro en).

Repro do Rafael (28/11): Bíblia en vazando `|strong="G2532"*`, `\\+w`,
cross-refs — os tarballs en/es/fr carregam as anotações cruas do eBible
(strong numbers), os outros 12 idiomas são limpos.

Regras (ordem importa):
1. `|strong="..."*` e `\\+w`/`\\k` — anotações eBible
2. cross-ref `, *13:14 Daniel 9:27; ...*` — notas de rodapé no meio do verso
3. borda: nbsp residual, espaço antes de aspas de fechamento, espaço após
   abertura (hi/zh)

NÃO mexe: fr nbsp tipográfico interno (antes de : — round 2 preservou).
Idempotente; reescreve tarballs in-place (mesmos nomes de membros).
"""
from __future__ import annotations
import io, json, re, tarfile, sys
from pathlib import Path

DIR = Path("/media/rafaelejosi/Dados/repos/piano-api-dev/data/json_db/bible_multilingue")
LANGS = sys.argv[1].split(",") if len(sys.argv) > 1 else ["en", "es", "fr"]
# fr: tipografia interna (nbsp antes de : e dentro de «») é legítima e
# preservada (decisão round 2) — só limpamos os markers eBible nele.
FR = "fr"

STRONG = re.compile('\\|strong="[^"]*"\\*?')
W = re.compile("\\\\\\+w\\*?\\s?")
K = re.compile("\\\\k\\s\\+?")
XREF = re.compile(r"\*?,?\s*\d+:\d+[^*]{0,120}\*")

def clean(s: str, lang: str) -> str:
    s = STRONG.sub(" ", s)
    s = W.sub(" ", s)
    s = K.sub(" ", s)
    s = XREF.sub(" ", s)
    if lang != FR:
        s = re.sub(r"\s*\*", "", s)
        s = re.sub(r"\s*\*\s*", " ", s)
        s = re.sub(r"[\u00a0 ]+([”’.,;:!?])", r"\1", s)
        s = re.sub(r" +\)", ")", s)
        s = re.sub(r"([“‘])[\u00a0 ]+", r"\1", s)
        s = re.sub(r"[ \t]+", " ", s)
        s = re.sub(r"^\s*[,.;:]\s*", "", s)
        s = s.strip()
    else:
        # fr: só normaliza ASCII duplo-espaço; nbsp é conteúdo
        s = re.sub(r" *\u00a0 *", "\u00a0", s)
        s = re.sub(r"[ ]{2,}", " ", s)
        s = re.sub(r" +([.,;])", r"\1", s)  # espaço ASCII residual de marker, não o nbsp
    return s.strip()

def process_lang(lang: str) -> None:
    path = DIR / f"{lang}_bible_chapters.tar.gz"
    changed: list[tuple[str, str, str, str]] = []
    with tarfile.open(path) as tf:
        members = [m for m in tf.getmembers() if m.name.endswith(".json")]
        payloads = {}
        for m in members:
            d = json.load(io.TextIOWrapper(tf.extractfile(m), encoding="utf-8"))
            for k, v in d.items():
                nv = clean(v, lang)
                if nv != v:
                    changed.append((m.name.split("/")[-1], k, v, nv))
                    d[k] = nv
            payloads[m.name] = json.dumps(d, ensure_ascii=False, separators=(",", ":")) + "\n"
    if not changed:
        print(f"{lang}: 0 alterações")
        return
    with tarfile.open(path, "w:gz") as tf:
        for m in members:
            data = payloads[m.name].encode("utf-8")
            info = tarfile.TarInfo(m.name)
            info.size = len(data)
            info.mtime = m.mtime
            tf.addfile(info, io.BytesIO(data))
    print(f"{lang}: {len(changed)} versículos corrigidos, tarball reescrito")
    for f, k, v, nv in changed[:3]:
        print(f"  {f} {k}:")
        print(f"    - {v[:100]!r}")
        print(f"    + {nv[:100]!r}")

if __name__ == "__main__":
    for lang in LANGS:
        process_lang(lang)
