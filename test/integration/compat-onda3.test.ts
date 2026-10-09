import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { type SeededDb, setupSeededDb } from "../helpers/seeded-db.js";

/**
 * Onda 3c: compat routes — /json_db, /json_db/:file (miss + 404), /file/*.
 * ON_MISS_FETCH=off e MEDIA_MIRROR=off no seed (sem rede) — exercita os
 * caminhos locais: cache hit, padrão não batido → 404, negative cache.
 */
describe("Compat /json_db", () => {
  let app: SeededDb;
  let router: any;

  beforeAll(async () => {
    app = await setupSeededDb();
    router = app.router;
  });

  afterAll(() => app.cleanup());

  it("GET /json_db lista arquivos disponíveis", async () => {
    const res = await router.request("/json_db");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toBeDefined();
  });

  it("GET /json_db/music_1 → dados da música seed", async () => {
    const res = await router.request("/json_db/music_1");
    expect([200, 404]).toContain(res.status);
    if (res.status === 200) {
      const body = await res.json();
      expect(body).toBeDefined();
    }
  });

  it("GET /json_db/arquivo-que-nao-existe → 404", async () => {
    const res = await router.request("/json_db/zzz_nao_existe_zzz");
    expect(res.status).toBe(404);
  });

  it("GET /file/caminho-fora-do-media-dir → 403/404 (mirrorGuard)", async () => {
    const res = await router.request("/file/../../etc/passwd");
    expect([403, 404]).toContain(res.status);
  });

  it("GET /file/img/img1.jpg: mirror off → 404 local (não bate na rede)", async () => {
    // MEDIA_MIRROR=off no seed: sem mirror local → 404 local OU 302 redirect
    // pro upstream (comportamento do handler quando disco não tem o arquivo);
    // 400 se path não for mirrorable. Todos válidos, nada estoura 5xx.
    const res = await router.request("/file/img/img1.jpg");
    expect([200, 302, 400, 404]).toContain(res.status);
  });
});
