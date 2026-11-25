import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { type SeededDb, setupSeededDb } from "../helpers/seeded-db.js";

/**
 * Onda 5a: client-platform detection (telemetry) via user-agent +
 * X-Client-Platform header. Rotas compat (montadas na raiz) são baratas
 * pra exercitar o middleware.
 */
describe("Telemetry client-platform", () => {
  let app: SeededDb;
  let router: any;

  beforeAll(async () => {
    app = await setupSeededDb();
    router = app.router;
  });

  afterAll(() => app.cleanup());

  const cases: Array<[string, string]> = [
    ["Mozilla/5.0 (Linux; Android 13; Pixel 7)", "apk-android"],
    ["Mozilla/5.0 (iPhone; CPU iPhone OS 17_0)", "apk-ios"],
    ["Mozilla/5.0 Electron/27.0 Windows NT 10.0", "desktop-windows"],
    ["Mozilla/5.0 Electron/27.0 Macintosh", "desktop-mac"],
    ["Mozilla/5.0 Electron/27.0 X11 Linux", "desktop-linux"],
  ];

  for (const [ua, expected] of cases) {
    it(`UA "${expected}" não quebra rota (200/404)`, async () => {
      const res = await router.request("/json_db", {
        headers: { "user-agent": ua },
      });
      expect([200, 404]).toContain(res.status);
    });
  }

  it("X-Client-Platform válido não quebra rota", async () => {
    const res = await router.request("/json_db", {
      headers: { "x-client-platform": "web" },
    });
    expect([200, 404]).toContain(res.status);
  });

  it("X-Client-Platform inválido cai no fallback (sem 5xx)", async () => {
    const res = await router.request("/json_db", {
      headers: { "x-client-platform": "plataforma-fantasma" },
    });
    expect([200, 404]).toContain(res.status);
  });

  it("sem user-agent (unknown) não quebra", async () => {
    const res = await router.request("/json_db", { headers: {} });
    expect([200, 404]).toContain(res.status);
  });
});

/**
 * Firebase middleware: sem FIREBASE_SERVICE_ACCOUNT, credencial firebase
 * inexistente ou header bearer não-firebase → rotas públicas seguem (no-op)
 * e token firebase malformado é rejeitado sem 5xx.
 */
describe("Firebase auth middleware (sem service account)", () => {
  let app: SeededDb;
  let router: any;
  const prev = process.env.FIREBASE_SERVICE_ACCOUNT;

  beforeAll(async () => {
    app = await setupSeededDb();
    router = app.router;
    delete process.env.FIREBASE_SERVICE_ACCOUNT;
  });

  afterAll(() => {
    if (prev !== undefined) process.env.FIREBASE_SERVICE_ACCOUNT = prev;
    app.cleanup();
  });

  it("bearer token não-firebase em rota pública: segue fluxo normal", async () => {
    const res = await router.request("/v1/custom/collections", {
      headers: { authorization: "Bearer token-qualquer-nao-firebase" },
    });
    expect([200, 401, 403]).toContain(res.status);
  });

  it("bearer malformado sem 'Bearer ' prefix: tratado como anônimo", async () => {
    const res = await router.request("/v1/custom/collections", {
      headers: { authorization: "Basic zzz" },
    });
    expect([200, 401, 403]).toContain(res.status);
  });
});
