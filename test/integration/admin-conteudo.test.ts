import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { type SeededDb, setupSeededDb } from "../helpers/seeded-db.js";

const { registerUser } = await import("./helpers/custom-auth-helpers.js");

/**
 * SPEC admin-conteudo-global v1.1.0 (RF-01..RF-04, AC-1..AC-4, AC-7):
 * rotas admin de leitura global de coletâneas/músicas + owner_name público.
 * ADMIN_EMAILS fail-closed (401 anônimo, 403 plebeu). Sem
 * password_hash/firebase_uid no corpo (AC-7).
 */
describe("Admin conteúdo global (collections/musics + owner_name)", () => {
  let app: SeededDb;
  let router: any;
  let adminToken: string;
  let userToken: string;
  let aliceToken: string;
  let plebeuId: number;
  const auth = (t: string) => ({ authorization: `Bearer ${t}` });

  let aliceColId: number; // privada de outro usuário
  let publicColId: number; // pública de plebeu

  beforeAll(async () => {
    process.env.ADMIN_EMAILS = "admin@test.local";
    app = await setupSeededDb();
    router = app.router;
    const admin = registerUser("admin@test.local", "SenhaForte1!");
    adminToken = admin.token;
    const plebeu = registerUser("plebeu@test.local", "SenhaForte1!");
    userToken = plebeu.token;
    plebeuId = plebeu.id_user;
    const alice = registerUser("alice@test.local", "SenhaForte1!");
    aliceToken = alice.token;

    const db = app.getDb();
    // alice: privada com 1 música (áudio file 2)
    const ac = db
      .prepare(
        `INSERT INTO custom_collections (name, description, owner_id, author_name, visibility, tenant_id)
         VALUES ('Alice Privada', 'desc', ?, 'Legado', 'private', 'piano')`,
      )
      .run(alice.id_user);
    aliceColId = Number(ac.lastInsertRowid);
    db.prepare(
      `INSERT INTO custom_musics (id_collection, name, lyric, id_file_audio, owner_id)
       VALUES (?, 'Musica Alice', 'letra', 2, ?)`,
    ).run(aliceColId, alice.id_user);

    // plebeu: pública com 1 música (sem áudio)
    const pc = db
      .prepare(
        `INSERT INTO custom_collections (name, description, owner_id, visibility, tenant_id)
         VALUES ('Plebeu Publica', NULL, ?, 'public', 'piano')`,
      )
      .run(plebeuId);
    publicColId = Number(pc.lastInsertRowid);
    db.prepare(
      `INSERT INTO custom_musics (id_collection, name, owner_id)
       VALUES (?, 'Musica Plebeu', ?)`,
    ).run(publicColId, plebeuId);

    // órfã: pública sem owner (owner_name null)
    db.prepare(
      `INSERT INTO custom_collections (name, visibility, tenant_id)
       VALUES ('Orfa Publica', 'public', 'piano')`,
    ).run();
  });

  afterAll(() => {
    delete process.env.ADMIN_EMAILS;
    app.cleanup();
  });

  it("AC-2: 401 sem sessão; 403 não-admin (fail-closed)", async () => {
    for (const p of [
      "/v1/custom/admin/collections",
      "/v1/custom/admin/musics",
    ]) {
      const anon = await router.request(p, {
        headers: { "X-Tenant": "piano" },
      });
      expect(anon.status, `anon ${p}`).toBe(401);
      const nonAdmin = await router.request(p, {
        headers: { ...auth(userToken), "X-Tenant": "piano" },
      });
      expect(nonAdmin.status, `non-admin ${p}`).toBe(403);
    }
  });

  it("AC-1: admin vê TODAS as coletâneas (incl. privadas de outros) com owner_name", async () => {
    const res = await router.request("/v1/custom/admin/collections", {
      headers: { ...auth(adminToken), "X-Tenant": "piano" },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.meta).toMatchObject({
      total: 3,
      page: 1,
      per_page: 24,
      last_page: 1,
    });
    expect(body.data).toHaveLength(3);
    const byName = Object.fromEntries(body.data.map((c: any) => [c.name, c]));

    expect(byName["Alice Privada"]).toMatchObject({
      visibility: "private",
      owner_id: expect.any(Number),
      author_name: "Legado",
      owner_name: "alice",
      musics_count: 1,
    });
    expect(byName["Plebeu Publica"]).toMatchObject({
      visibility: "public",
      owner_name: "plebeu",
      musics_count: 1,
    });
    expect(byName["Orfa Publica"]).toMatchObject({
      owner_id: null,
      owner_name: null,
      musics_count: 0,
    });
    // AC-7: sem dados sensíveis
    const raw = JSON.stringify(body);
    expect(raw).not.toContain("password_hash");
    expect(raw).not.toContain("firebase_uid");
  });

  it("AC-1: paginação per_page cap e page=2", async () => {
    const res = await router.request(
      "/v1/custom/admin/collections?per_page=2&page=2",
      { headers: { ...auth(adminToken), "X-Tenant": "piano" } },
    );
    const body = await res.json();
    expect(body.data).toHaveLength(1);
    expect(body.meta).toMatchObject({
      total: 3,
      page: 2,
      per_page: 2,
      last_page: 2,
    });
  });

  it("AC-3: admin vê TODAS as músicas com owner_name/collection_name", async () => {
    const res = await router.request("/v1/custom/admin/musics", {
      headers: { ...auth(adminToken), "X-Tenant": "piano" },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toHaveLength(2);
    const byName = Object.fromEntries(body.data.map((m: any) => [m.name, m]));

    expect(byName["Musica Alice"]).toMatchObject({
      id_collection: aliceColId,
      owner_name: "alice",
      collection_name: "Alice Privada",
      collection_visibility: "private",
      audio_url: "https://cdn/m1.mp3",
      id_file_audio: 2,
    });
    expect(byName["Musica Plebeu"]).toMatchObject({
      collection_name: "Plebeu Publica",
      collection_visibility: "public",
      owner_name: "plebeu",
      audio_url: null,
    });
    expect(JSON.stringify(body)).not.toContain("password_hash");
    expect(JSON.stringify(body)).not.toContain("firebase_uid");
  });

  it("AC-4: rota pública /collections ganha owner_name sem quebrar filtro", async () => {
    // anônimo: só públicas (2), com owner_name
    const anon = await router.request("/v1/custom/collections", {
      headers: { "X-Tenant": "piano" },
    });
    const anonBody = await anon.json();
    expect(anonBody.data).toHaveLength(2);
    const byName = Object.fromEntries(
      anonBody.data.map((c: any) => [c.name, c]),
    );
    expect(byName["Plebeu Publica"].owner_name).toBe("plebeu");
    expect(byName["Orfa Publica"].owner_name).toBeNull();
    expect(anonBody.meta).toMatchObject({ total: 2, page: 1, per_page: 24 });

    // plebeu logado: próprias + públicas (não vê a privada da alice)
    const mine = await router.request("/v1/custom/collections", {
      headers: { ...auth(userToken), "X-Tenant": "piano" },
    });
    const mineBody = await mine.json();
    expect(mineBody.data).toHaveLength(2);
    expect(mineBody.data.some((c: any) => c.name === "Alice Privada")).toBe(
      false,
    );
    expect(
      mineBody.data.find((c: any) => c.id_collection === publicColId).is_owner,
    ).toBe(1);

    // alice logada: vê a própria privada (não via admin) + owner_name próprio
    const aliceBody = await (
      await router.request("/v1/custom/collections", {
        headers: {
          "X-Tenant": "piano",
          authorization: `Bearer ${aliceToken}`,
        },
      })
    ).json();
    expect(aliceBody.data).toHaveLength(3);
    const alicePrivate = aliceBody.data.find(
      (c: any) => c.name === "Alice Privada",
    );
    expect(alicePrivate.owner_name).toBe("alice");
    expect(alicePrivate.is_owner).toBe(1);
  });
  it.each(["collections", "musics"])(
    "%s normaliza paginação inválida e limita tamanho",
    async (resource) => {
      for (const query of [
        "page=invalid&per_page=0",
        "page=0&per_page=invalid",
      ]) {
        const response = await router.request(
          `/v1/custom/admin/${resource}?${query}`,
          {
            headers: { ...auth(adminToken), "X-Tenant": "piano" },
          },
        );
        expect(response.status).toBe(200);
        expect((await response.json()).meta).toMatchObject({
          page: 1,
          per_page: 24,
        });
      }
      const capped = await router.request(
        `/v1/custom/admin/${resource}?per_page=999`,
        {
          headers: { ...auth(adminToken), "X-Tenant": "piano" },
        },
      );
      expect((await capped.json()).meta.per_page).toBe(100);
    },
  );

  it.each(["collections", "musics"])(
    "%s retorna erro controlado se banco falhar",
    async (resource) => {
      const db = app.getDb();
      const prepare = db.prepare.bind(db);
      const spy = vi.spyOn(db, "prepare").mockImplementation((sql: string) => {
        if (
          sql.includes("SELECT cc.id_collection") ||
          sql.includes("SELECT cm.id_music")
        )
          throw new Error("database unavailable");
        return prepare(sql);
      });
      try {
        const response = await router.request(`/v1/custom/admin/${resource}`, {
          headers: { ...auth(adminToken), "X-Tenant": "piano" },
        });
        expect(response.status).toBe(500);
        expect(await response.json()).toEqual({
          error:
            resource === "collections"
              ? "Erro ao listar coletâneas"
              : "Erro ao listar músicas",
        });
      } finally {
        spy.mockRestore();
      }
    },
  );
});
