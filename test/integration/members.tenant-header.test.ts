/**
 * P0-A do reviewer (comentário #170): roster público com o header que o SITE
 * realmente envia (`X-Tenant: pianolouvorja`) não pode receber 400 do
 * tenantMiddleware global — o tenant raiz da comunidade precisa estar na
 * tabela `tenants` (fonte única da allowlist). Reproduzido via createApp(),
 * não via rota isolada.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../../src/app.js";
import { resetTenantCacheForTests } from "../../src/middleware/tenant.middleware.js";
import { setMembersRoutesFirestoreForTests } from "../../src/v1/custom/members.routes.js";
import { type SeededDb, setupSeededDb } from "../helpers/seeded-db.js";
import { fakeFirestore, seedMember } from "./members.routes.test.js";

describe("members routes sob createApp com X-Tenant real do site", () => {
  let app: SeededDb;
  const router = createApp();

  beforeAll(async () => {
    app = await setupSeededDb();
    resetTenantCacheForTests();
    const fake = fakeFirestore();
    setMembersRoutesFirestoreForTests(fake as never);
    seedMember(fake.docs, {
      id: "qa1",
      tenant: "pianolouvorja",
      email: "qa-dev@t.com",
      roles: ["dev"],
    });
  });

  afterAll(() => {
    setMembersRoutesFirestoreForTests(null);
    app.cleanup();
    resetTenantCacheForTests();
  });

  it("roster público aceita X-Tenant: pianolouvorja (header do site) — não 400", async () => {
    const res = await router.request("/v1/custom/community/roster?role=dev", {
      headers: { "x-tenant": "pianolouvorja" },
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Array<Record<string, unknown>> };
    expect(body.data.map((m) => m.id)).toContain("qa1");
  });

  it("header pianolouvorja ecoado na resposta (middleware global aplica)", async () => {
    const res = await router.request(
      "/v1/custom/community/roster?role=tester",
      {
        headers: { "x-tenant": "pianolouvorja" },
      },
    );

    expect(res.status).toBe(200);
    expect(res.headers.get("x-tenant")).toBe("pianolouvorja");
  });

  it("tenant desconhecido continua rejeitado (fail-closed mantido)", async () => {
    const res = await router.request("/v1/custom/community/roster?role=dev", {
      headers: { "x-tenant": "guitarra" },
    });

    expect(res.status).toBe(400);
  });
});
