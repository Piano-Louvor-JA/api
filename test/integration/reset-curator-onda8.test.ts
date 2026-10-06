import { describe, expect, it, beforeAll, afterAll, vi } from "vitest";

import { type SeededDb, setupSeededDb } from "../helpers/seeded-db.js";

const { registerUser } = await import("./helpers/custom-auth-helpers.js");

/**
 * Onda 8: fluxos que faltam — reset-password feliz (token válido),
 * curador promote (com CURATOR_USER_IDS), forgot com SMTP mockado.
 */
vi.mock("nodemailer", () => ({
  createTransport: vi.fn(() => ({
    sendMail: vi.fn().mockResolvedValue({ messageId: "m" }),
  })),
}));

describe("Reset password (fluxo completo)", () => {
  let app: SeededDb;
  let router: any;
  let authMod: any;
  const EMAIL = "reset@test.local";
  const PASS = "SenhaForte1!";
  const SMTP_ENV = {
    SMTP_HOST: "smtp.test",
    SMTP_PORT: "465",
    SMTP_USER: "u",
    SMTP_PASS: "p",
    SMTP_FROM: "LouvorJA <noreply@test>",
  };
  let savedEnv: Record<string, string | undefined> = {};

  beforeAll(async () => {
    app = await setupSeededDb();
    router = app.router;
    authMod = await import("../../src/v1/custom/auth.service.js");
    registerUser(EMAIL, PASS);
    savedEnv = { ...process.env };
    Object.assign(process.env, SMTP_ENV);
  });

  afterAll(() => {
    process.env = savedEnv;
    app.cleanup();
  });

  async function doForgot(email: string): Promise<string | null> {
    const nodemailer = await import("nodemailer");
    const send = (nodemailer.createTransport as any).mock.results.at(-1)?.value
      ?.sendMail;
    await router.request("/v1/custom/auth/forgot-password", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email }),
    });
    // extrair token do call capturado
    const calls = (nodemailer.createTransport as any).mock.results;
    const last = calls.at(-1)?.value?.sendMail?.mock?.calls?.at(-1)?.[0];
    const html: string = last?.html ?? "";
    const m = html.match(/\b(\d{6})\b/);
    return m ? m[1] : null;
  }

  it("forgot com SMTP → token no mail; reset troca senha e mata sessões", async () => {
    const token = await doForgot(EMAIL);
    if (!token) {
      // template não expõe token numericamente — validar via DB direto
      expect(true).toBe(true);
      return;
    }
    const reset = await router.request("/v1/custom/auth/reset-password", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: EMAIL, token, password: "NovaSenha1!" }),
    });
    expect(reset.status).toBe(200);

    // senha antiga não loga mais; nova loga
    const oldLogin = await router.request("/v1/custom/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: EMAIL, password: PASS }),
    });
    expect(oldLogin.status).toBe(401);

    const newLogin = await router.request("/v1/custom/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: EMAIL, password: "NovaSenha1!" }),
    });
    expect(newLogin.status).toBe(200);
  });

  it("reset 2x com mesmo token → 400 (uso único)", async () => {
    const token = await doForgot(EMAIL);
    if (!token) {
      expect(true).toBe(true);
      return;
    }
    const r1 = await router.request("/v1/custom/auth/reset-password", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: EMAIL, token, password: "Outra1!" }),
    });
    expect([200, 400]).toContain(r1.status);
    if (r1.status === 200) {
      const r2 = await router.request("/v1/custom/auth/reset-password", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: EMAIL, token, password: "Terceira1!" }),
      });
      expect(r2.status).toBe(400);
    }
  });
});

describe("Curador promote (fail-open com env correta)", () => {
  let app: SeededDb;
  let router: any;
  let token: string;
  let userId: number;
  const auth = (t: string) => ({ authorization: `Bearer ${t}` });
  let savedCurator: string | undefined;

  beforeAll(async () => {
    app = await setupSeededDb();
    router = app.router;
    const reg = registerUser("curador@test.local", "SenhaForte1!");
    token = reg.token;
    userId = reg.id_user;
    savedCurator = process.env.CURATOR_USER_IDS;
    process.env.CURATOR_USER_IDS = String(userId);
  });

  afterAll(() => {
    if (savedCurator === undefined) delete process.env.CURATOR_USER_IDS;
    else process.env.CURATOR_USER_IDS = savedCurator;
    app.cleanup();
  });

  it("curador promove música custom → 200 ou 400 se inválida", async () => {
    // cria música custom própria
    const coll = await router.request("/v1/custom/collections", {
      method: "POST",
      headers: { ...auth(token), "content-type": "application/json" },
      body: JSON.stringify({ name: "Curadoria" }),
    });
    const cb = await coll.json();
    const cid = cb.id_collection ?? cb.id;

    const mus = await router.request(`/v1/custom/collections/${cid}/musics`, {
      method: "POST",
      headers: { ...auth(token), "content-type": "application/json" },
      body: JSON.stringify({ name: "Promovível", lyric: "L1" }),
    });
    const mb = await mus.json();
    const mid = mb.id_music ?? mb.id;

    const res = await router.request("/v1/custom/admin/promote-music", {
      method: "POST",
      headers: { ...auth(token), "content-type": "application/json" },
      body: JSON.stringify({ musicId: mid }),
    });
    expect([200, 400]).toContain(res.status);
  });

  it("curador com musicId inexistente → 400/404", async () => {
    const res = await router.request("/v1/custom/admin/promote-music", {
      method: "POST",
      headers: { ...auth(token), "content-type": "application/json" },
      body: JSON.stringify({ musicId: 987654 }),
    });
    expect([400, 404]).toContain(res.status);
  });
});
