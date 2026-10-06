import { describe, expect, it, beforeAll, afterAll, vi } from "vitest";

import { type SeededDb, setupSeededDb } from "../helpers/seeded-db.js";

const { registerUser } = await import("./helpers/custom-auth-helpers.js");

/**
 * Onda 11a: catches 500 de custom.routes — injeta falha no getDb UMA vez
 * por request (vi.mock com contador). Cada it derruba um handler diferente.
 */
vi.mock("../../src/db/connection.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/db/connection.js")>();
  let failNext = false;
  return {
    ...actual,
    get getDb() {
      return () => {
        if (failNext) {
          failNext = false;
          throw new Error("db kaboom (teste de 500)");
        }
        return actual.getDb();
      };
    },
    __failNext() {
      failNext = true;
    },
  } as any;
});

const testAlias = async () =>
  await import("../../src/db/connection.js" as string);

describe("custom.routes — erros internos (500)", () => {
  let app: SeededDb;
  let router: any;
  let token: string;
  let collectionId: number;
  const auth = (t: string) => ({ authorization: `Bearer ${t}` });

  beforeAll(async () => {
    app = await setupSeededDb();
    router = app.router;
    token = registerUser("boom@test.local", "SenhaForte1!").token;

    const r = await router.request("/v1/custom/collections", {
      method: "POST",
      headers: { ...auth(token), "content-type": "application/json" },
      body: JSON.stringify({ name: "Boom Coll" }),
    });
    const b = await r.json();
    collectionId = b.id_collection ?? b.id;
  });

  afterAll(() => app.cleanup());

  async function expect500(path: string, init?: any) {
    const dbmod: any = await testAlias();
    dbmod.__failNext();
    const res = await router.request(path, init);
    expect(res.status).toBe(500);
  }

  it("GET /collections com DB quebrado → 500", async () => {
    await expect500("/v1/custom/collections", { headers: auth(token) });
  });

  it("POST /collections com DB quebrado → 500", async () => {
    await expect500("/v1/custom/collections", {
      method: "POST",
      headers: { ...auth(token), "content-type": "application/json" },
      body: JSON.stringify({ name: "x" }),
    });
  });

  it("GET /collections/{id} com DB quebrado → 500", async () => {
    await expect500(`/v1/custom/collections/${collectionId}`, {
      headers: auth(token),
    });
  });

  it("PUT /collections/{id} com DB quebrado → 500", async () => {
    await expect500(`/v1/custom/collections/${collectionId}`, {
      method: "PUT",
      headers: { ...auth(token), "content-type": "application/json" },
      body: JSON.stringify({ name: "y" }),
    });
  });

  it("DELETE /collections/{id} com DB quebrado → 500", async () => {
    await expect500(`/v1/custom/collections/${collectionId}`, {
      method: "DELETE",
      headers: auth(token),
    });
  });

  it("GET /musics com DB quebrado → 500", async () => {
    await expect500("/v1/custom/musics");
  });

  it("GET /musics/{id} com DB quebrado → 500", async () => {
    await expect500("/v1/custom/musics/1", { headers: auth(token) });
  });

  it("POST /collections/{id}/musics com DB quebrado → 500", async () => {
    await expect500(`/v1/custom/collections/${collectionId}/musics`, {
      method: "POST",
      headers: { ...auth(token), "content-type": "application/json" },
      body: JSON.stringify({ name: "x" }),
    });
  });

  it("POST copy com DB quebrado → 500", async () => {
    await expect500(`/v1/custom/collections/${collectionId}/musics/1/copy`, {
      method: "POST",
      headers: auth(token),
      body: JSON.stringify({}),
    });
  });

  it("GET /musics/{id}/lyrics com DB quebrado → 500", async () => {
    await expect500("/v1/custom/musics/1/lyrics", { headers: auth(token) });
  });

  it("POST /musics/{id}/lyrics com DB quebrado → 500", async () => {
    await expect500("/v1/custom/musics/1/lyrics", {
      method: "POST",
      headers: { ...auth(token), "content-type": "application/json" },
      body: JSON.stringify({ lyric: "x" }),
    });
  });

  it("login com DB quebrado → 500", async () => {
    await expect500("/v1/custom/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "loginboom@test.local", password: "SenhaForte1!" }),
    });
  });

  it("register com DB quebrado → 500", async () => {
    await expect500("/v1/custom/auth/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "regboom@test.local", password: "SenhaForte1!", displayName: "z" }),
    });
  });

  it("me com DB quebrado → 500", async () => {
    await expect500("/v1/custom/auth/me", { headers: auth(token) });
  });

  it("reset-password com DB quebrado → 500", async () => {
    await expect500("/v1/custom/auth/reset-password", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: "expired00000000001", password: "SenhaForte1!" }),
    });
  });
});
