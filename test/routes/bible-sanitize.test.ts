import { describe, expect, it } from "vitest";
import { sanitizeBibleChapter } from "../../src/routes/compat.js";

describe("sanitizeBibleChapter — ruído da fonte NTLH (issues 316/317)", () => {
  it("remove tags <J> mantendo o texto interno", () => {
    const out = sanitizeBibleChapter({
      "16": "<J>Porque Deus amou o mundo tanto, que deu o seu único Filho</J>",
    });
    expect(out["16"]).toBe(
      "Porque Deus amou o mundo tanto, que deu o seu único Filho",
    );
  });

  it("remove marcador de fala '  -  ' após quebra de linha", () => {
    const out = sanitizeBibleChapter({
      "2": "Uma noite ele foi visitar Jesus e disse:\n  -  Rabi, nós sabemos que o senhor é um mestre",
    });
    expect(out["2"]).toBe(
      "Uma noite ele foi visitar Jesus e disse:\nRabi, nós sabemos que o senhor é um mestre",
    );
  });

  it("omite versos vazios da fonte (caso real: Números 3 v19)", () => {
    const out = sanitizeBibleChapter({
      "18": "  ",
      "19": "",
      "20": "Verso com conteúdo",
    });
    expect(Object.keys(out)).toEqual(["20"]);
  });

  it("não altera texto limpo (idempotente p/ capítulos sãos)", () => {
    const clean = { "1": "No princípio Deus criou os céus e a terra." };
    expect(sanitizeBibleChapter(clean)).toEqual(clean);
  });

  it("ignora valores não-string sem quebrar", () => {
    const out = sanitizeBibleChapter({
      "1": "<J>Texto</J>",
      "2": undefined as unknown as string,
    });
    expect(out).toEqual({ "1": "Texto" });
  });
});
