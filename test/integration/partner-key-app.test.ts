import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { type SeededDb, setupSeededDb } from "../helpers/seeded-db.js";

/**
 * Token de parceiro no app real: clientes sem header não mudam nada; parceiro
 * válido passa; inválido/revogado leva 401 — inclusive em /file/*.
 */
describe("X-Partner-Key no app", () => {
  let app: SeededDb;
  let lib: typeof import("../../src/lib/partnerKeys.js");

  beforeAll(async () => {
    app = await setupSeededDb();
    lib = await import("../../src/lib/partnerKeys.js");
  });

  afterAll(() => app.cleanup());

  const get = (path: string, key?: string) =>
    app.router.request(
      path,
      key === undefined ? {} : { headers: { "X-Partner-Key": key } },
    );

  it("sem header: /v1/liturgy responde 200 como hoje", async () => {
    const res = await get("/v1/liturgy?lang=pt");
    expect(res.status).toBe(200);
  });

  it("parceiro válido: 200 no catálogo e rate limit segue por IP", async () => {
    const { key } = lib.createPartner("Liturgia Desktop");
    const res = await get("/v1/liturgy?lang=pt", key);
    expect(res.status).toBe(200);
    expect(res.headers.get("X-RateLimit-Bucket")).toBe("general");
  });

  it("token inválido: 401 em /v1 e em /file", async () => {
    for (const path of ["/v1/liturgy?lang=pt", "/file/covers/x.jpg"]) {
      const res = await get(path, "plj_invalido");
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: "Invalid partner key" });
    }
  });

  it("revogado: passa a 401 na requisição seguinte", async () => {
    const { id, key } = lib.createPartner("Temporario");
    expect((await get("/v1/liturgy?lang=pt", key)).status).toBe(200);
    lib.revokePartner(id);
    expect((await get("/v1/liturgy?lang=pt", key)).status).toBe(401);
  });
});
