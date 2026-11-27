import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import * as connection from "../../src/db/connection.js";
import { setupSeededDb } from "../helpers/seeded-db.js";

// SPEC locale-convite v1.1 (AC-4): verificação de catálogo por locale.
// Catálogo vazio deve retornar flag de convite (200), nunca erro.
describe("GET /v1/catalog/status", () => {
  let router: any;
  let cleanup: () => void;

  beforeAll(async () => {
    ({ router, cleanup } = await setupSeededDb());
  });
  afterAll(() => cleanup());

  it("retorna 200 com invite_catalogo=false quando o locale tem catálogo (pt)", async () => {
    const res = await router.request("/v1/catalog/status?lang=pt");
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.lang).toBe("pt");
    expect(body.has_albums).toBe(true);
    expect(body.has_musics).toBe(true);
    expect(body.invite_catalogo).toBe(false);
  });

  it("retorna 200 com invite_catalogo=true quando o locale está vazio (locale inexistente)", async () => {
    const res = await router.request("/v1/catalog/status?lang=zz");
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.lang).toBe("zz");
    expect(body.has_albums).toBe(false);
    expect(body.has_musics).toBe(false);
    expect(body.has_bible).toBe(false);
    expect(body.invite_catalogo).toBe(true);
  });

  it("locale 'es' com Bíblia no seed → catálogo presente, sem convite", async () => {
    const res = await router.request("/v1/catalog/status?lang=es");
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.lang).toBe("es");
    expect(body.has_albums).toBe(false);
    expect(body.has_musics).toBe(false);
    expect(body.has_bible).toBe(true);
    expect(body.invite_catalogo).toBe(false);
  });

  it("idioma cadastrado sem álbuns/músicas/Bíblia → convite, não erro", async () => {
    const { getDb } = await import("../../src/db/connection.js");
    getDb()
      .prepare(
        "INSERT OR IGNORE INTO languages (id_language, name) VALUES (?, ?)",
      )
      .run("it", "Italiano");

    const res = await router.request("/v1/catalog/status?lang=it");
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.lang).toBe("it");
    expect(body.has_albums).toBe(false);
    expect(body.has_musics).toBe(false);
    expect(body.has_bible).toBe(false);
    expect(body.invite_catalogo).toBe(true);
  });

  it("default lang=pt quando o parâmetro é omitido", async () => {
    const res = await router.request("/v1/catalog/status");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.lang).toBe("pt");
    expect(body.invite_catalogo).toBe(false);
  });

  it("falha no banco → 500 com mensagem genérica", async () => {
    const db = connection.getDb();
    const spy = vi.spyOn(db, "prepare").mockImplementation(() => {
      throw new Error("db exploded");
    });
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const res = await router.request("/v1/catalog/status?lang=pt");
      expect(res.status).toBe(500);
      expect(await res.json()).toEqual({ error: "Erro ao verificar catalogo" });
      expect(err).toHaveBeenCalledWith(
        "Error checking catalog status:",
        expect.any(Error),
      );
    } finally {
      spy.mockRestore();
      err.mockRestore();
    }
  });
});
