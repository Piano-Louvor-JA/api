import { describe, expect, it } from "vitest";
import {
  classifyPath,
  parseManifest,
} from "../../scripts/lib/es-ja-manifest.js";

describe("ES JA manifest", () => {
  const valid = [
    "id-vocal\t12. JA 2003 - Enséñame a Servir/(audios) JA 2003 - Enséñame a Servir/Brillar por Ti (audio-cantado).mp3",
    "id-pista\t12. JA 2003 - Enséñame a Servir/(audios) JA 2003 - Enséñame a Servir/Brillar por Ti (audio-pista).mp3",
    "id-slja\t12. JA 2003 - Enséñame a Servir/(audios) JA 2003 - Enséñame a Servir/Brillar por Ti.slja",
    "id-ppt\t12. JA 2003 - Enséñame a Servir/Brillar por Ti.ppt",
  ].join("\n");

  it("classifica assets determinística e explicitamente", () => {
    const items = parseManifest(valid);
    expect(items.map((item) => [item.role, item.decision])).toEqual([
      ["vocal", "approved"],
      ["instrumental", "approved"],
      ["slja", "source-only"],
      ["presentation", "excluded"],
    ]);
  });

  it("rejeita path traversal, caminho absoluto, ID duplicado divergente e extensão desconhecida", () => {
    expect(() => parseManifest("a\t../evil.mp3")).toThrow("unsafe path");
    expect(() => parseManifest("a\t/foo.mp3")).toThrow("unsafe path");
    expect(() =>
      parseManifest("a\t12. JA 2003 - A/x.mp3\na\t12. JA 2003 - A/y.mp3"),
    ).toThrow("duplicate Drive ID");
    expect(() => parseManifest("a\t12. JA 2003 - A/x.exe")).toThrow(
      "unsupported extension",
    );
  });

  it("exige associação explícita para MP3 sem sufixo", () => {
    expect(classifyPath("12. JA 2003 - A/tema.mp3")).toEqual({
      role: "unknown-mp3",
      decision: "rejected",
    });
  });
});
