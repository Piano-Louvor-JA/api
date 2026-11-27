# -*- coding: utf-8 -*-
"""Tabela das 15 traduções — PLAN §1 (frozen 27/11/2026).
Códigos eBible + fetch.bible hin_irv para hi (ADR-01)."""

from __future__ import annotations

from dataclasses import dataclass

EBIBLE_ZIP = "https://eBible.org/Scriptures/{code}_usfm.zip"
FETCHBIBLE_USFM = "https://v1.fetch.bible/bibles/hin_irv/usfm/{book}.usfm"


@dataclass(frozen=True)
class Translation:
    lang: str              # prefixo do app (json_db)
    ebible_code: str | None
    name: str
    abbreviation: str
    id_bible_version: int  # blocos de 100 (ADR-02)
    id_book_base: int      # id_book do livro 1 (ADR-03)
    license: str
    attribution: str
    source_url: str
    note: str = ""

    @property
    def book_url_template(self) -> str:
        if self.ebible_code is None:
            return FETCHBIBLE_USFM
        return EBIBLE_ZIP.format(code=self.ebible_code)


TRANSLATIONS: tuple[Translation, ...] = (
    Translation("pt", "porbr2018", "Bíblia Livre (Almeida 1819 atualizada)", "LIV", 99, 132, "cc-by",
                "© 2018 Diego Santos et al. — Free Bible (update of 1819 Almeida translation)",
                "https://ebible.org/find/details.php?id=porbr2018"),
    Translation("en", "engwebp", "World English Bible (2020 stable)", "WEBP", 100, 200, "PD",
                "Public Domain — World English Bible",
                "https://ebible.org/find/details.php?id=engwebp"),
    Translation("es", "spaRV1909", "Santa Biblia — Reina Valera 1909", "RV1909", 98, 66, "PD",
                "Public Domain — Reina Valera 1909",
                "https://ebible.org/find/details.php?id=spaRV1909"),
    Translation("fr", "frasbl", "Sainte Bible libre pour le monde", "SBL", 101, 266, "PD",
                "CC0 — brouillon de traduction (em revisão)",
                "https://ebible.org/find/details.php?id=frasbl",
                "draft translation in proofread"),
    Translation("ru", "russyn", "Синодальный перевод (Synodal 1876)", "SYN", 102, 332, "PD",
                "Public Domain — Synodal 1876",
                "https://ebible.org/find/details.php?id=russyn"),
    Translation("uk", "ukr1871", "Біблія П.Куліша та І.Пулюя 1905", "KUL", 103, 398, "PD",
                "Public Domain — Kulish & Puliuj 1905",
                "https://ebible.org/find/details.php?id=ukr1871"),
    Translation("it", "ita1927", "Riveduta Bibbia 1927", "RIV", 104, 464, "PD",
                "Public Domain — Riveduta 1927",
                "https://ebible.org/find/details.php?id=ita1927"),
    Translation("nl", "nld", "De Heilige Schrift 1917", "DHS", 105, 530, "PD",
                "Public Domain — De Heilige Schrift 1917 (Leidse Vertaling)",
                "https://ebible.org/find/details.php?id=nld"),
    Translation("pl", "polubg", "Święta Biblia (Updated Gdansk 2018)", "UBG", 106, 596, "cc-by-nd",
                "© 2018 Fundacja Wrota Nadziei — verbatim redistribution only",
                "https://ebible.org/find/details.php?id=polubg",
                "cc-by-nd: No-Derivatives — texto distribuído verbatim"),
    Translation("tr", "turytc", "Yorumsuz Türkçe Çeviri (YTC)", "YTC", 107, 662, "cc-by-nd",
                "© 2023-2025 İsmail Serinken + eBible.org — verbatim redistribution only",
                "https://ebible.org/find/details.php?id=turytc",
                "cc-by-nd: No-Derivatives — texto distribuído verbatim"),
    Translation("ja", "jpnm", "フリーダム・バイブル (Freedom Bible)", "JFM", 108, 728, "PD",
                "Public Domain — Freedom Bible",
                "https://ebible.org/find/details.php?id=jpnm"),
    Translation("ko", "kor", "한국어 성경 (Korean Bible 1910)", "KOR", 109, 794, "PD",
                "Public Domain — Korean Bible 1910",
                "https://ebible.org/find/details.php?id=kor"),
    Translation("zh", "cmnswcb", "世界中文圣经 (World Chinese Bible)", "WCB", 110, 860, "PD",
                "Public Domain — rascunho em revisão",
                "https://ebible.org/find/details.php?id=cmnswcb",
                "draft translation in proofread"),
    Translation("ar", "arb-vd", "الكتاب المقدس فان دايك (Van Dyck 1865)", "VDY", 111, 926, "PD",
                "Public Domain — Van Dyck 1865",
                "https://ebible.org/find/details.php?id=arb-vd"),
    Translation("hi", None, "Indian Revised Version Hindi", "IRV", 112, 992, "cc-by-sa",
                "Bridge Connectivity Solutions Pvt. Ltd. (fetch.bible hin_irv)",
                "https://v1.fetch.bible/manifest.json",
                "fetch.bible USFM por livro; KJV-versification"),
)

BY_LANG: dict[str, Translation] = {t.lang: t for t in TRANSLATIONS}

LANGUAGEM_NAMES = {  # INSERT languages p/ 13 novos idiomas
    "en": "English", "fr": "Français", "ru": "Русский", "uk": "Українська",
    "it": "Italiano", "nl": "Nederlands", "pl": "Polski", "tr": "Türkçe",
    "ja": "日本語", "ko": "한국어", "zh": "中文", "ar": "العربية", "hi": "हिन्दी",
}
