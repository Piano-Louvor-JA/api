import { describe, expect, it } from "vitest";
import { resolveVersionAbbreviation } from "../../src/routes/compat.js";

/** Produção grava NTLH e NVT sem sigla: o manifesto dos bundles saía vazio. */
describe("resolveVersionAbbreviation — versões PT sem sigla no banco", () => {
  it("deriva NTLH e NVT pelo nome", () => {
    expect(
      resolveVersionAbbreviation(
        null,
        "Nova Tradução na Linguagem de Hoje",
        "4.0",
      ),
    ).toBe("NTLH");
    expect(
      resolveVersionAbbreviation("", "Nova Versão Transformadora", "7.0"),
    ).toBe("NVT");
    expect(
      resolveVersionAbbreviation(null, "nova traducao na linguagem de hoje"),
    ).toBe("NTLH");
  });

  it("não confunde NVT com NVI", () => {
    expect(resolveVersionAbbreviation(null, "Nova Versão Internacional")).toBe(
      "NVI",
    );
  });
});
