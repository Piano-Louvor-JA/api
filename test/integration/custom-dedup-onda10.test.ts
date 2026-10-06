import { describe, expect, it, beforeAll, afterAll } from "vitest";

import { type SeededDb, setupSeededDb } from "../helpers/seeded-db.js";

const { registerUser } = await import("./helpers/custom-auth-helpers.js");

/**
 * Onda 10b: ramos restantes de custom.routes com caminhos reais:
 * - create music com client_uuid (dedup app#336) → 2º POST retorna existente
 * - create music com official_music_id (herda nome/duração)
 * - copy com lyrics clonadas
 * - GET music com lyrics anexadas
 * - update music por dono da coletânea pai (permissão alternativa)
 */
describe("custom.routes ramos de dedup/official/copy", () => {
  let app: SeededDb;
  let router: any;
  let token: string;
  let tokenB: string;
  const auth = (t: string) => ({ authorization: `Bearer ${t}` });
  const UUID = "dedup-uuid-12345678";

  beforeAll(async () => {
    app = await setupSeededDb();
    router = app.router;
    token = registerUser("dedup@test.local", "SenhaForte1!").token;
    tokenB = registerUser("dedup2@test.local", "SenhaForte1!").token;
  });

  afterAll(() => app.cleanup());

  async function newCollection(t: string, name: string): Promise<number> {
    const r = await router.request("/v1/custom/collections", {
      method: "POST",
      headers: { ...auth(t), "content-type": "application/json" },
      body: JSON.stringify({ name }),
    });
    const b = await r.json();
    return b.id_collection ?? b.id;
  }

  it("create com client_uuid: 2º POST mesmo uuid → 200 dedup (não 201)", async () => {
    const cid = await newCollection(token, "Dedup Coll");
    const body = {
      method: "POST",
      headers: { ...auth(token), "content-type": "application/json" },
      body: JSON.stringify({ name: "Dedup Music", client_uuid: UUID }),
    };
    const r1 = await router.request(`/v1/custom/collections/${cid}/musics`, body);
    expect(r1.status).toBe(201);

    const r2 = await router.request(`/v1/custom/collections/${cid}/musics`, body);
    expect(r2.status).toBe(200);
  });

  it("create com official_music_id herda nome do hino oficial", async () => {
    const cid = await newCollection(token, "Official Coll");
    const r = await router.request(`/v1/custom/collections/${cid}/musics`, {
      method: "POST",
      headers: { ...auth(token), "content-type": "application/json" },
      body: JSON.stringify({
        name: "nome-qualquer",
        official_music_id: 1,
      }),
    });
    expect(r.status).toBe(201);
    const b = await r.json();
    // herda nome da música oficial 1 ("Musica Um" no seed)
    expect(b.name).toBe("Musica Um");
  });

  it("copy clona lyrics: nova música tem estrofes da origem", async () => {
    const cid = await newCollection(token, "Copy Lyrics");
    // origem com lyrics
    const created = await router.request(`/v1/custom/collections/${cid}/musics`, {
      method: "POST",
      headers: { ...auth(token), "content-type": "application/json" },
      body: JSON.stringify({ name: "Com Letra", lyric: "V1\nV2" }),
    });
    const cb = await created.json();
    const srcId = cb.id_music ?? cb.id;

    // lyrics de verdade na tabela custom_lyrics (copy clona dessa tabela)
    await router.request(`/v1/custom/musics/${srcId}/lyrics`, {
      method: "POST",
      headers: { ...auth(token), "content-type": "application/json" },
      body: JSON.stringify({ lyric: "Estrofe A", order: 1 }),
    });

    const copy = await router.request(
      `/v1/custom/collections/${cid}/musics/${srcId}/copy`,
      { method: "POST", headers: auth(token), body: JSON.stringify({}) },
    );
    // 201 = copiou; 200 = já existia (idempotente por nome)
    expect([200, 201]).toContain(copy.status);
    const copyBody = await copy.json();
    const copyId = copyBody.id_music ?? copyBody.id;

    // lyrics clonadas
    const lyrics = await router.request(`/v1/custom/musics/${copyId}/lyrics`, {
      headers: auth(token),
    });
    const lb = await lyrics.json();
    const items = lb.data ?? lb;
    expect((Array.isArray(items) ? items : items.items ?? []).length).toBeGreaterThan(0);
  });

  it("GET music detail inclui lyrics no corpo", async () => {
    const cid = await newCollection(token, "Detail Coll");
    const created = await router.request(`/v1/custom/collections/${cid}/musics`, {
      method: "POST",
      headers: { ...auth(token), "content-type": "application/json" },
      body: JSON.stringify({ name: "Com Detalhe", lyric: "S1" }),
    });
    const cb = await created.json();
    const mid = cb.id_music ?? cb.id;

    const got = await router.request(`/v1/custom/musics/${mid}`, {
      headers: auth(token),
    });
    expect(got.status).toBe(200);
    const gb = await got.json();
    expect(Array.isArray(gb.lyrics)).toBe(true);
  });

  it("update music por não-dono mas dono da coletânea é bloqueado se não for dono de ambos", async () => {
    const cid = await newCollection(token, "Perms");
    const created = await router.request(`/v1/custom/collections/${cid}/musics`, {
      method: "POST",
      headers: { ...auth(token), "content-type": "application/json" },
      body: JSON.stringify({ name: "P" }),
    });
    const cb = await created.json();
    const mid = cb.id_music ?? cb.id;

    const res = await router.request(`/v1/custom/musics/${mid}`, {
      method: "PUT",
      headers: { ...auth(tokenB), "content-type": "application/json" },
      body: JSON.stringify({ name: "X" }),
    });
    expect([403, 404]).toContain(res.status);
  });
});
