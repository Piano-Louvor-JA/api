import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { type SeededDb, setupSeededDb } from "../helpers/seeded-db.js";

const { registerUser } = await import("./helpers/custom-auth-helpers.js");

/**
 * Cover privacy (t_c68a47ac, api — decisão Rafael 27/11):
 * capa privada/pública por coletânea. cover_url redigido para não-donos
 * quando cover_private=1; arquivo /file/custom também protegido.
 *
 * Compat: cover_private default 1 (nova coluna) — coletâneas legadas com
 * cover continuam visíveis só ao dono (LGPD conservador).
 */
describe("Cover privacy — cover_url por privacidade", () => {
  let app: SeededDb;
  let router: any;
  let ownerToken: string;
  let otherToken: string;
  let ownerId: number;
  const auth = (t: string) => ({ authorization: `Bearer ${t}` });

  beforeAll(async () => {
    app = await setupSeededDb();
    router = app.router;
    const owner = registerUser("cover.owner@test.local", "SenhaForte1!");
    const other = registerUser("cover.other@test.local", "SenhaForte1!");
    ownerToken = owner.token;
    otherToken = other.token;
    ownerId = owner.id_user;
  });

  afterAll(() => app.cleanup());

  async function createCollection(
    token: string,
    visibility: "public" | "private",
    coverUrl: string | null,
    coverPrivate?: boolean,
  ): Promise<number> {
    const res = await router.request("/v1/custom/collections", {
      method: "POST",
      headers: { ...auth(token), "content-type": "application/json" },
      body: JSON.stringify({
        name: `cover-${visibility}-${Math.random().toString(36).slice(2, 7)}`,
        visibility,
        ...(coverUrl !== undefined ? { cover_url: coverUrl } : {}),
        ...(coverPrivate !== undefined ? { cover_private: coverPrivate } : {}),
      }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    return body.id_collection ?? body.id;
  }

  it("GET detail: cover_private=1 (default) → cover_url null para não-dono; dono vê", async () => {
    const id = await createCollection(
      ownerToken,
      "public",
      "/custom/1/imagens/capa.png",
    );
    // default: sem cover_private → 1 (privada)

    const asOwner = await router.request(`/v1/custom/collections/${id}`, {
      headers: auth(ownerToken),
    });
    expect(asOwner.status).toBe(200);
    expect((await asOwner.json()).cover_url).toBe("/custom/1/imagens/capa.png");

    const asOther = await router.request(`/v1/custom/collections/${id}`, {
      headers: auth(otherToken),
    });
    expect(asOther.status).toBe(200);
    expect((await asOther.json()).cover_url).toBeNull();

    const anon = await router.request(`/v1/custom/collections/${id}`);
    expect(anon.status).toBe(200);
    expect((await anon.json()).cover_url).toBeNull();
  });

  it("GET detail: cover_private=0 → cover_url público sem auth", async () => {
    const id = await createCollection(
      ownerToken,
      "public",
      "/custom/1/imagens/aberta.png",
      false,
    );
    const anon = await router.request(`/v1/custom/collections/${id}`);
    expect(anon.status).toBe(200);
    expect((await anon.json()).cover_url).toBe("/custom/1/imagens/aberta.png");
  });

  it("PUT cover_private atualiza privacidade da capa", async () => {
    const id = await createCollection(
      ownerToken,
      "public",
      "/custom/1/imagens/toggle.png",
      false,
    );
    const put = await router.request(`/v1/custom/collections/${id}`, {
      method: "PUT",
      headers: { ...auth(ownerToken), "content-type": "application/json" },
      body: JSON.stringify({ cover_private: true }),
    });
    expect(put.status).toBe(200);
    const asOther = await router.request(`/v1/custom/collections/${id}`, {
      headers: auth(otherToken),
    });
    expect((await asOther.json()).cover_url).toBeNull();
  });

  it("LIST pública: cover_private=1 → cover_url null na listagem", async () => {
    const priv = await createCollection(
      ownerToken,
      "public",
      "/custom/1/imagens/lp.png",
    );
    await createCollection(
      ownerToken,
      "public",
      "/custom/1/imagens/lpub.png",
      false,
    );

    const list = await router.request("/v1/custom/collections");
    expect(list.status).toBe(200);
    const items = (await list.json()).data;
    const privRow = items.find((c: any) => c.id_collection === priv);
    expect(privRow.cover_url).toBeNull();

    const listOwner = await router.request("/v1/custom/collections", {
      headers: auth(ownerToken),
    });
    const ownerItems = (await listOwner.json()).data;
    const ownRow = ownerItems.find((c: any) => c.id_collection === priv);
    expect(ownRow.cover_url).toBe("/custom/1/imagens/lp.png");
  });

  it("file guard: /file/custom de cover privada → 404 para não-dono, 200 p/ dono", async () => {
    // grava arquivo físico no CUSTOM_MEDIA_DIR do teste
    const { mkdirSync, writeFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    // MEDIA_DIR do /file é process.cwd()/media (ver compat-file-disk-onda7)
    const dir = join(
      process.cwd(),
      "media",
      "custom",
      String(ownerId),
      "imagens",
    );
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "guard.png"), Buffer.from("fakepng"));

    const priv = await createCollection(
      ownerToken,
      "public",
      `/custom/${ownerId}/imagens/guard.png`,
    );

    const res = await router.request(
      `/file/custom/${ownerId}/imagens/guard.png`,
    );
    expect(res.status).toBe(404);

    const resOther = await router.request(
      `/file/custom/${ownerId}/imagens/guard.png`,
      {
        headers: auth(otherToken),
      },
    );
    expect(resOther.status).toBe(404);

    const resOwner = await router.request(
      `/file/custom/${ownerId}/imagens/guard.png`,
      {
        headers: auth(ownerToken),
      },
    );
    expect(resOwner.status).toBe(200);

    const pub = await createCollection(
      ownerToken,
      "public",
      `/custom/${ownerId}/imagens/guard.png`,
      false,
    );
    expect(pub).toBeDefined();
    const resAnon = await router.request(
      `/file/custom/${ownerId}/imagens/guard.png`,
    );
    // agora é pública → anônimo vê
    expect(resAnon.status).toBe(200);
  });
});
