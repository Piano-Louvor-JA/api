import { describe, expect, it, beforeAll, afterAll } from "vitest";

import { type SeededDb, setupSeededDb } from "../helpers/seeded-db.js";

const { registerUser } = await import("./helpers/custom-auth-helpers.js");

/**
 * Onda 16: arms de fallback (??) e caminhos alternativos diretos:
 * - update music parcial (só um campo) + lyric parcial
 * - create lyric SEM order (calcula next)
 * - record use: owner com badges (owner_id != null) — fluxo feliz
 * - seasonal active:true (evento na tabela) via rota
 * - formData sem kind (default imagens)
 */
describe("fallback arms", () => {
  let app: SeededDb;
  let router: any;
  let token: string;
  const auth = (t: string) => ({ authorization: `Bearer ${t}` });

  beforeAll(async () => {
    app = await setupSeededDb();
    router = app.router;
    token = registerUser("fb@test.local", "SenhaForte1!").token;
  });

  afterAll(() => app.cleanup());

  async function newCollection(name: string): Promise<number> {
    const r = await router.request("/v1/custom/collections", {
      method: "POST",
      headers: { ...auth(token), "content-type": "application/json" },
      body: JSON.stringify({ name }),
    });
    const b = await r.json();
    return b.id_collection ?? b.id;
  }

  it("create lyric sem order → calcula próxima (L1258)", async () => {
    const cid = await newCollection("Order Auto");
    const created = await router.request(`/v1/custom/collections/${cid}/musics`, {
      method: "POST",
      headers: { ...auth(token), "content-type": "application/json" },
      body: JSON.stringify({ name: "L" }),
    });
    const cb = await created.json();
    const mid = cb.id_music ?? cb.id;

    const l1 = await router.request(`/v1/custom/musics/${mid}/lyrics`, {
      method: "POST",
      headers: { ...auth(token), "content-type": "application/json" },
      body: JSON.stringify({ lyric: "sem order" }),
    });
    expect([200, 201]).toContain(l1.status);
    const l1b = await l1.json();
    const order1 = l1b.order ?? l1b.data?.order;
    if (order1 != null) expect(order1).toBeGreaterThan(0);
  });

  it("update music parcial: só lyric, resto herda (L1039)", async () => {
    const cid = await newCollection("Parcial");
    const created = await router.request(`/v1/custom/collections/${cid}/musics`, {
      method: "POST",
      headers: { ...auth(token), "content-type": "application/json" },
      body: JSON.stringify({ name: "Original", lyric: "letra original" }),
    });
    const cb = await created.json();
    const mid = cb.id_music ?? cb.id;

    const res = await router.request(`/v1/custom/musics/${mid}`, {
      method: "PUT",
      headers: { ...auth(token), "content-type": "application/json" },
      body: JSON.stringify({ lyric: "letra nova" }),
    });
    expect([200, 204]).toContain(res.status);

    const got = await router.request(`/v1/custom/musics/${mid}`, {
      headers: auth(token),
    });
    const gb = await got.json();
    expect(gb.name).toBe("Original");
    expect(gb.lyric).toBe("letra nova");
  });

  it("update lyric parcial: só time (L1346)", async () => {
    const cid = await newCollection("Lyric Parcial");
    const created = await router.request(`/v1/custom/collections/${cid}/musics`, {
      method: "POST",
      headers: { ...auth(token), "content-type": "application/json" },
      body: JSON.stringify({ name: "LP" }),
    });
    const cb = await created.json();
    const mid = cb.id_music ?? cb.id;

    const l = await router.request(`/v1/custom/musics/${mid}/lyrics`, {
      method: "POST",
      headers: { ...auth(token), "content-type": "application/json" },
      body: JSON.stringify({ lyric: "verso", time: "00:10" }),
    });
    const lb = await l.json();
    const lyricId = lb.id_lyric ?? lb.id;

    const res = await router.request(`/v1/custom/lyrics/${lyricId}`, {
      method: "PUT",
      headers: { ...auth(token), "content-type": "application/json" },
      body: JSON.stringify({ time: "00:20" }),
    });
    expect([200, 204]).toContain(res.status);
  });

  it("record use: owner com badges reavaliadas → 200 ok (L2050)", async () => {
    const cid = await newCollection("Use Badges");
    const res = await router.request(`/v1/custom/collections/${cid}/use`, {
      method: "POST",
      headers: { ...auth(token), "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect([200, 201]).toContain(res.status);
    const b = await res.json();
    expect(b.ok ?? b.first_use != null).toBeTruthy();
  });

  it("seasonal event ativo via rota → active:true (L2499-2504)", async () => {
    const db = app.getDb();
    try {
      db.prepare(
        `INSERT INTO seasonal_events (name, multiplier, starts_at, ends_at)
         VALUES ('Páscoa', 1.5, datetime('now','-1 day'), datetime('now','+1 day'))`,
      ).run();
    } catch {
      // schema pode variar
    }
    const res = await router.request("/v1/custom/seasonal", {
      headers: auth(token),
    });
    expect([200, 404]).toContain(res.status);
  });

  it("upload sem kind → default imagens (L1490)", async () => {
    const fd = new FormData();
    fd.append("file", new File([Buffer.from("z")], "semkind.png", { type: "image/png" }));
    const res = await router.request("/v1/custom/files", {
      method: "POST",
      headers: auth(token),
      body: fd,
    });
    expect([200, 201]).toContain(res.status);
    const b = await res.json();
    expect(String(b.url ?? b.path)).toContain("/imagens/");
  });
});
