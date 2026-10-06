import { describe, expect, it, beforeAll, afterAll } from "vitest";

import { type SeededDb, setupSeededDb } from "../helpers/seeded-db.js";

const { registerUser } = await import("./helpers/custom-auth-helpers.js");

/**
 * Onda 2b: auth flows — register/login/logout/me/forgot/reset + erros.
 * custom.routes auth block (register 1602, login 1682, logout 1785, me 1817,
 * forgot 1884, reset 1954). forgot/reset enviam mail → SMTP mockado via env off
 * (rotas tratam e respondem instrução de suporte).
 */
describe("Auth flows (register/login/me/logout/reset)", () => {
  let app: SeededDb;
  let router: any;
  const EMAIL = "authflow@test.local";
  const PASS = "SenhaForte1!";

  beforeAll(async () => {
    app = await setupSeededDb();
    router = app.router;
    delete process.env.SMTP_HOST; // mail off: rotas tratam gracefully
  });

  afterAll(() => app.cleanup());

  it("register → 201 com token; duplicado → 409/400", async () => {
    const r1 = await router.request("/v1/custom/auth/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: EMAIL, password: PASS, displayName: "Auth" }),
    });
    expect(r1.status).toBe(201);
    const b1 = await r1.json();
    expect(b1.token).toBeDefined();

    const r2 = await router.request("/v1/custom/auth/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: EMAIL, password: PASS, displayName: "Auth2" }),
    });
    expect([400, 409]).toContain(r2.status);
  });

  it("register senha fraca → 400", async () => {
    const res = await router.request("/v1/custom/auth/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "fraca@test.local", password: "123", displayName: "F" }),
    });
    expect(res.status).toBe(400);
  });

  it("login correto → token; senha errada → 401", async () => {
    const ok = await router.request("/v1/custom/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: EMAIL, password: PASS }),
    });
    expect(ok.status).toBe(200);
    const b = await ok.json();
    expect(b.token).toBeDefined();

    const bad = await router.request("/v1/custom/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: EMAIL, password: "Errada123!" }),
    });
    expect(bad.status).toBe(401);
  });

  it("login email inexistente → 401", async () => {
    const res = await router.request("/v1/custom/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "fantasma@test.local", password: PASS }),
    });
    expect(res.status).toBe(401);
  });

  it("GET /auth/me com token → dados do usuário; sem token → 401", async () => {
    const login = await router.request("/v1/custom/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: EMAIL, password: PASS }),
    });
    const { token } = await login.json();

    const me = await router.request("/v1/custom/auth/me", {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(me.status).toBe(200);
    const mb = await me.json();
    expect(mb.email ?? mb.user?.email).toBe(EMAIL);

    const anon = await router.request("/v1/custom/auth/me");
    expect(anon.status).toBe(401);
  });

  it("logout invalida a sessão; me depois → 401", async () => {
    const login = await router.request("/v1/custom/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: EMAIL, password: PASS }),
    });
    const { token } = await login.json();

    const out = await router.request("/v1/custom/auth/logout", {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
    });
    expect([200, 204]).toContain(out.status);

    const me = await router.request("/v1/custom/auth/me", {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(me.status).toBe(401);
  });

  it("forgot password: email existente e inexistente respondem igual (não revela)", async () => {
    const a = await router.request("/v1/custom/auth/forgot-password", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: EMAIL }),
    });
    const b = await router.request("/v1/custom/auth/forgot-password", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "naoexiste@test.local" }),
    });
    expect(a.status).toBe(b.status);
  });

  it("reset password com token inválido → 400/401", async () => {
    const res = await router.request("/v1/custom/auth/reset-password", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: "token-falso-123456", password: "NovaSenha1!" }),
    });
    expect([400, 401, 404]).toContain(res.status);
  });
});
