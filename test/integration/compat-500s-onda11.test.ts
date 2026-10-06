import { describe, expect, it, beforeAll, afterAll, vi } from "vitest";

import { type SeededDb, setupSeededDb } from "../helpers/seeded-db.js";

/**
 * Onda 11b: catches 500 de compat.ts (json_db/file), liturgy e remote via
 * getDb injetado com falha — mesmo padrão da 11a.
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
          throw new Error("db kaboom (compat/liturgy)");
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

describe("compat + liturgy + remote — 500 com DB quebrado", () => {
  let app: SeededDb;
  let router: any;

  beforeAll(async () => {
    app = await setupSeededDb();
    router = app.router;
  });

  afterAll(() => app.cleanup());

  async function expect500(path: string, init?: any) {
    const dbmod: any = await testAlias();
    dbmod.__failNext();
    const res = await router.request(path, init);
    expect([500]).toContain(res.status);
  }

  it("GET /json_db (manifest estático) → 200 mesmo sem DB", async () => {
    const res = await router.request("/json_db");
    expect(res.status).toBe(200);
  });

  it("GET /json_db/music_1 com DB quebrado → 500", async () => {
    await expect500("/json_db/music_1");
  });

  it("GET /v1/liturgy com DB quebrado → 500", async () => {
    await expect500("/v1/liturgy?lang=pt");
  });

  it("POST /v1/remote/sessions com DB quebrado → 500", async () => {
    process.env.REMOTE_SESSION_KEY = "chave-teste-remote-0123456789abcdef";
    // endpoint LAN válido (isPrivateWsEndpoint): ws://192.168.x.x
    await expect500("/v1/remote/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ endpoint: "ws://192.168.0.42:8080/relay", token: "token-12345678" }),
    });
    delete process.env.REMOTE_SESSION_KEY;
  });
});
