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
    expect(plan.fileCount).toBe(2); // 1 (vocal ausente) + 1 pista
    expect(() =>
      planCatalog([vocal("v1", "A"), pista("p1", "A"), pista("p2", "A")]),
    ).toThrow("duplicate instrumental");
  });

  it("slja e mp3 com grafia divergente (acento/case/pontuacao) viram UMA musica", () => {
    // caso real JA 2003: .slja "Enseñame a Servir" vs mp3 "Enséñame a Servir"
    const plan = planCatalog([
      vocal("v1", "Enséñame a Servir"),
      pista("p1", "Enséñame a Servir"),
      slja("s1", "Enseñame a Servir"),
    ]);
    expect(plan.albums[0]?.musics).toHaveLength(1);
    expect(plan.albums[0]?.musics[0]?.vocal?.url).toContain("Enséñame");
    expect(plan.albums[0]?.musics[0]?.sljaPath).toContain("Enseñame");
    expect(plan.musicCount).toBe(1);

    // caso real JA 2010: slja "Te voy a abrazar" vs mp3 "Te Voy a Abrazar"
    const plan2 = planCatalog([
      vocal("v9", "Te Voy a Abrazar", "19. JA 2010 - Generación Esperanza"),
      slja("s9", "Te voy a abrazar", "19. JA 2010 - Generación Esperanza"),
    ]);
    expect(plan2.albums[0]?.musics).toHaveLength(1);
    expect(plan2.musicCount).toBe(1);

    // pontuacao "Ven, Espíritu Santo" vs "Ven Espíritu Santo"
    const plan3 = planCatalog([
      vocal("v3", "Ven Espíritu Santo", "22. JA 2013 - Gente como Jesús"),
      slja("s3", "Ven, Espíritu Santo", "22. JA 2013 - Gente como Jesús"),
    ]);
    expect(plan3.albums[0]?.musics).toHaveLength(1);
  });
});
