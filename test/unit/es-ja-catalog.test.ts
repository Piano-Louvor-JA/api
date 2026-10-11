import { describe, expect, it } from "vitest";
import {
  collectionMeta,
  collectionYear,
  planCatalog,
  sanitizeSegment,
} from "../../scripts/lib/es-ja-catalog.js";

const vocal = (
  id: string,
  name: string,
  album = "12. JA 2003 - Enséñame a Servir",
) =>
  ({
    driveFileId: id,
    relativePath: `${album}/(audios) ${album}/${name} (audio-cantado).mp3`,
    role: "vocal",
    decision: "approved",
  }) as const;

const pista = (
  id: string,
  name: string,
  album = "12. JA 2003 - Enséñame a Servir",
) =>
  ({
    driveFileId: id,
    relativePath: `${album}/(audios) ${album}/${name} (audio-pista).mp3`,
    role: "instrumental",
    decision: "approved",
  }) as const;

const slja = (
  id: string,
  name: string,
  album = "12. JA 2003 - Enséñame a Servir",
) =>
  ({
    driveFileId: id,
    relativePath: `${album}/(audios) ${album}/${name}.slja`,
    role: "slja",
    decision: "source-only",
  }) as const;

describe("ES JA catalog planner", () => {
  it("extrai nome/ordem da colecao e sanitiza segmento de album", () => {
    const meta = collectionMeta("12. JA 2003 - Enséñame a Servir");
    expect(meta.order).toBe(12);
    expect(meta.name).toBe("JA 2003 - Enséñame a Servir");
    expect(meta.albumDir).toBe("12. JA 2003 - Enséñame a Servir");
    expect(() => sanitizeSegment("../evil")).toThrow("unsafe path segment");
    expect(() => sanitizeSegment("a/b")).toThrow("unsafe path segment");
  });

  it("extrai ano do tema (inclui pastas 2-em-1) e deriva coverUrl", () => {
    expect(collectionYear("12. JA 2003 - Enséñame a Servir")).toBe(2003);
    expect(collectionYear("31. JA 2022 y 2023 - Yo Voy")).toBe(2022);
    expect(collectionYear("Himnario Adventista")).toBeNull();
    const plan = planCatalog([vocal("v1", "Alpha")]);
    expect(plan.albums[0].year).toBe(2003);
    expect(plan.albums[0].coverUrl).toBe("/covers/es/2003.jpg");
  });

  it("agrupa em albums com tracks ordenadas e URLs musics/es/<album>/", () => {
    const plan = planCatalog([
      vocal("v2", "Zebra"),
      vocal("v1", "Alpha"),
      pista("p1", "Alpha"),
      slja("s1", "Alpha"),
    ]);
    expect(plan.albums).toHaveLength(1);
    const album = plan.albums[0];
    expect(album?.musics.map((m) => [m.name, m.track])).toEqual([
      ["Alpha", 1],
      ["Zebra", 2],
    ]);
    expect(album?.musics[0]?.vocal?.url).toBe(
      "/musics/es/12. JA 2003 - Enséñame a Servir/Alpha (audio-cantado).mp3",
    );
    expect(album?.musics[0]?.instrumental?.url).toBe(
      "/musics/es/12. JA 2003 - Enséñame a Servir/Alpha (audio-pista).mp3",
    );
    expect(album?.musics[0]?.sljaPath).toContain("Alpha.slja");
    expect(plan.fileCount).toBe(3);
    expect(plan.musicCount).toBe(2);
  });

  it("ordena albums por numero de colecao", () => {
    const plan = planCatalog([
      vocal("a", "X", "33. JA 2026 - Mi Lugar En El Mundo"),
      vocal("b", "Y", "12. JA 2003 - Enséñame a Servir"),
    ]);
    expect(plan.albums.map((a) => a.order)).toEqual([12, 33]);
  });

  it("musica sem vocal vira letra-only; duplicidade de variante rejeita", () => {
    const plan = planCatalog([pista("p1", "Solo Pista")]);
    expect(plan.albums[0]?.musics[0]?.vocal).toBeNull();
    expect(plan.musicCount).toBe(1);
    expect(plan.fileCount).toBe(1); // so a pista
    expect(() =>
      planCatalog([vocal("v1", "A"), pista("p1", "A"), pista("p2", "A")]),
    ).toThrow("duplicate instrumental");
  });
});
