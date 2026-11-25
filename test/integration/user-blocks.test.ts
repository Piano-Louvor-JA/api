import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { type SeededDb, setupSeededDb } from "../helpers/seeded-db.js";

const { registerUser } = await import("./helpers/custom-auth-helpers.js");

/**
 * Bloqueio de usuário (App Store 1.2 — conteúdo gerado por usuários):
 * quem bloqueia deixa de ver as coletâneas do autor bloqueado na Comunidade.
 * - POST   /v1/custom/collections/{id}/block-author  bloqueia o dono da coletânea
 * - GET    /v1/custom/blocks                          lista quem eu bloqueei
 * - DELETE /v1/custom/blocks/{id}                     desbloqueia
 */
describe("Bloqueio de usuários", () => {
  let app: SeededDb;
  let router: any;
  let seq = 0;
  let ana: { id_user: number; token: string };
  let beto: { id_user: number; token: string };
  let caio: { id_user: number; token: string };

  beforeAll(async () => {
    app = await setupSeededDb();
    router = app.router;
  });

  afterAll(() => app.cleanup());

  beforeEach(() => {
    seq += 1;
    ana = registerUser(`ana${seq}@test.local`, "SenhaForte1!");
    beto = registerUser(`beto${seq}@test.local`, "SenhaForte1!");
    caio = registerUser(`caio${seq}@test.local`, "SenhaForte1!");
  });

  function collection(owner: number | null, visibility = "public"): number {
    const r = app
      .getDb()
      .prepare(
        `INSERT INTO custom_collections (name, owner_id, visibility) VALUES (?, ?, ?)`,
      )
      .run(`Coletânea ${seq} ${owner}`, owner, visibility);
    return Number(r.lastInsertRowid);
  }

  function req(path: string, token: string | null, method = "GET") {
    return router.request(`/v1/custom${path}`, {
      method,
      headers: token ? { authorization: `Bearer ${token}` } : {},
    });
  }

  async function listedIds(token: string | null): Promise<number[]> {
    const res = await req("/collections?per_page=100", token);
    expect(res.status).toBe(200);
    const body = await res.json();
    return body.data.map((c: { id_collection: number }) => c.id_collection);
  }

  it("sem login → 401", async () => {
    const id = collection(beto.id_user);
    expect(
      (await req(`/collections/${id}/block-author`, null, "POST")).status,
    ).toBe(401);
    expect((await req("/blocks", null)).status).toBe(401);
  });

  it("bloquear o autor esconde as coletâneas dele só para quem bloqueou", async () => {
    const dele = collection(beto.id_user);
    const outra = collection(beto.id_user);
    const terceiro = collection(caio.id_user);

    const res = await req(
      `/collections/${dele}/block-author`,
      ana.token,
      "POST",
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.blocked.id_user).toBe(beto.id_user);

    const daAna = await listedIds(ana.token);
    expect(daAna).not.toContain(dele);
    expect(daAna).not.toContain(outra);
    expect(daAna).toContain(terceiro);

    // os outros continuam vendo
    expect(await listedIds(caio.token)).toContain(dele);
    expect(await listedIds(null)).toContain(dele);
  });

  it("bloquear de novo é idempotente e aparece uma vez na lista", async () => {
    const id = collection(beto.id_user);
    await req(`/collections/${id}/block-author`, ana.token, "POST");
    const again = await req(
      `/collections/${id}/block-author`,
      ana.token,
      "POST",
    );
    expect(again.status).toBe(200);

    const list = await (await req("/blocks", ana.token)).json();
    expect(list.data).toHaveLength(1);
    expect(list.data[0]).toMatchObject({
      id_user: beto.id_user,
      displayName: `beto${seq}`,
    });
  });

  it("desbloquear volta a mostrar as coletâneas", async () => {
    const id = collection(beto.id_user);
    await req(`/collections/${id}/block-author`, ana.token, "POST");
    const del = await req(`/blocks/${beto.id_user}`, ana.token, "DELETE");
    expect(del.status).toBe(204);
    expect(await listedIds(ana.token)).toContain(id);
    expect((await (await req("/blocks", ana.token)).json()).data).toEqual([]);
  });

  it("não dá para bloquear a si mesmo nem coletânea sem dono", async () => {
    const minha = collection(ana.id_user);
    const orfa = collection(null);
    expect(
      (await req(`/collections/${minha}/block-author`, ana.token, "POST"))
        .status,
    ).toBe(400);
    expect(
      (await req(`/collections/${orfa}/block-author`, ana.token, "POST"))
        .status,
    ).toBe(400);
  });

  it("coletânea inexistente → 404", async () => {
    expect(
      (await req("/collections/99999999/block-author", ana.token, "POST"))
        .status,
    ).toBe(404);
  });

  it("excluir a conta apaga os bloqueios feitos e recebidos", async () => {
    const { deleteAccount } = await import(
      "../../src/v1/custom/account-deletion.service.js"
    );
    const id = collection(beto.id_user);
    const daAna = collection(ana.id_user);
    await req(`/collections/${id}/block-author`, ana.token, "POST");
    await req(`/collections/${daAna}/block-author`, caio.token, "POST");

    deleteAccount(app.getDb(), ana.id_user);

    const n = app
      .getDb()
      .prepare(
        `SELECT COUNT(*) n FROM custom_user_blocks WHERE blocker_id = ? OR blocked_id = ?`,
      )
      .get(ana.id_user, ana.id_user) as { n: number };
    expect(n.n).toBe(0);
  });
});
