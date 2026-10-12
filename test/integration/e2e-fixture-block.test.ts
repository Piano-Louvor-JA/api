import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { type SeededDb, setupSeededDb } from "../helpers/seeded-db.js";

/**
 * G1 (guardrail E2E) — contrato A1-A3 da SPEC:
 * fixtures E2E são bloqueadas com 403 E2E_FIXTURE_BLOCKED quando o guard
 * está ativo (production-like), e aceitas quando a flag desativa (staging).
 *
 * Env mutado com save/restore (padrão do seeded-db.ts). A suíte roda
 * serial (vitest forks, maxWorkers 1) — sem colisão com files concorrentes.
 */
describe("E2E fixture block (POST register/collections/musics)", () => {
  let app: SeededDb;
  let tokenLegit: string;
  let collectionId: number;
  const originalNodeEnv = process.env.NODE_ENV;
  const originalBlockFlag = process.env.BLOCK_E2E_FIXTURES;

  async function postJson(path: string, body: unknown, token?: string) {
    return app.router.request(path, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body),
    });
  }

  beforeAll(async () => {
    app = await setupSeededDb();

    // Usuário "limpo" para criar coletâneas/músicas nos cenários A3.
    process.env.NODE_ENV = "development";
    process.env.BLOCK_E2E_FIXTURES = undefined;
    const res = await postJson("/v1/custom/auth/register", {
      email: "carla@rank.local",
      password: "SenhaForte1!",
      displayName: "Carla",
    });
    expect(res.status).toBe(201);
    tokenLegit = ((await res.json()) as { token: string }).token;

    const col = await postJson(
      "/v1/custom/collections",
      { name: "Coletânea da Igreja", visibility: "public" },
      tokenLegit,
    );
    expect(col.status).toBe(201);
    collectionId = ((await col.json()) as { id_collection: number })
      .id_collection;
  });

  afterAll(() => {
    app.cleanup();
    if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = originalNodeEnv;
    if (originalBlockFlag === undefined) delete process.env.BLOCK_E2E_FIXTURES;
    else process.env.BLOCK_E2E_FIXTURES = originalBlockFlag;
  });

  describe("A1 — production-like bloqueia fixtures no register", () => {
    beforeAll(() => {
      process.env.NODE_ENV = "production";
      process.env.BLOCK_E2E_FIXTURES = undefined;
    });

    it("register e2e_x@teste.com → 403 E2E_FIXTURE_BLOCKED sem criar usuário", async () => {
      const usersBefore = (
        app.getDb().prepare("SELECT COUNT(*) AS n FROM custom_users").get() as {
          n: number;
        }
      ).n;

      const res = await postJson("/v1/custom/auth/register", {
        email: "e2e_x@teste.com",
        password: "SenhaForte1!",
        displayName: "Fulano E2E",
      });

      expect(res.status).toBe(403);
      const body = (await res.json()) as { error?: string; message?: string };
      expect(body.error).toBe("E2E_FIXTURE_BLOCKED");
      expect(body.message).toBeTruthy();

      const usersAfter = (
        app.getDb().prepare("SELECT COUNT(*) AS n FROM custom_users").get() as {
          n: number;
        }
      ).n;
      expect(usersAfter).toBe(usersBefore);
    });

    it("register com displayName slja_e2e_probe e email limpo → 403 (detecta pelo nome)", async () => {
      const res = await postJson("/v1/custom/auth/register", {
        email: "davi@rank.local",
        password: "SenhaForte1!",
        displayName: "slja_e2e_probe",
      });
      expect(res.status).toBe(403);
      const body = (await res.json()) as { error?: string };
      expect(body.error).toBe("E2E_FIXTURE_BLOCKED");
    });
  });

  describe("A2 — BLOCK_E2E_FIXTURES=false aceita (escape staging)", () => {
    beforeAll(() => {
      process.env.NODE_ENV = "development";
      process.env.BLOCK_E2E_FIXTURES = "false";
    });

    it("register e2e_x@teste.com → 201 com token", async () => {
      const res = await postJson("/v1/custom/auth/register", {
        email: "e2e_x@teste.com",
        password: "SenhaForte1!",
        displayName: "E2E Fulano",
      });
      expect(res.status).toBe(201);
      const body = (await res.json()) as { token?: string };
      expect(body.token).toBeTruthy();
    });
  });

  describe("A3 — production-like bloqueia coletânea/música fixture", () => {
    beforeAll(() => {
      process.env.NODE_ENV = "production";
      process.env.BLOCK_E2E_FIXTURES = undefined;
    });

    it('collections "E2E 123" → 403; "Coletânea da Igreja" passa (201)', async () => {
      const blocked = await postJson(
        "/v1/custom/collections",
        { name: "E2E 123" },
        tokenLegit,
      );
      expect(blocked.status).toBe(403);
      expect(((await blocked.json()) as { error?: string }).error).toBe(
        "E2E_FIXTURE_BLOCKED",
      );

      const allowed = await postJson(
        "/v1/custom/collections",
        { name: "Coletânea da Igreja" },
        tokenLegit,
      );
      expect(allowed.status).toBe(201);
    });

    it('musics name "E2E teste" → 403; "Hino 15" passa (201)', async () => {
      const blocked = await postJson(
        `/v1/custom/collections/${collectionId}/musics`,
        { name: "E2E teste" },
        tokenLegit,
      );
      expect(blocked.status).toBe(403);
      expect(((await blocked.json()) as { error?: string }).error).toBe(
        "E2E_FIXTURE_BLOCKED",
      );

      const allowed = await postJson(
        `/v1/custom/collections/${collectionId}/musics`,
        { name: "Hino 15" },
        tokenLegit,
      );
      expect(allowed.status).toBe(201);
    });
  });
});
