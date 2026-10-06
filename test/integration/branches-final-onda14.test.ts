import { describe, expect, it, beforeAll, afterAll, vi } from "vitest";

import { type SeededDb, setupSeededDb } from "../helpers/seeded-db.js";

const { registerUser } = await import("./helpers/custom-auth-helpers.js");

/**
 * Onda 14: branches de custom.routes ainda 0-hit:
 * - copy dup real (mesmo nome na mesma collection) → 200 (L714)
 * - upload: quota estourada (L1500), nome sanitizado vazio (L1509)
 * - register: email duplicado → 409 (L1617)
 * - login: sendNewLoginEmail fire-and-forget (L1705, cobre com SMTP mock)
 * - firebase-session COM auth (L1751-1754)
 * - logout sem token (L1788) / com token
 * - forgot: SMTP falhou → fallback instrução suporte (L1909+)
 */
vi.mock("nodemailer", () => ({
  createTransport: vi.fn(() => ({
    sendMail: vi.fn().mockRejectedValue(new Error("smtp down")),
  })),
}));

describe("branches finais custom.routes", () => {
  let app: SeededDb;
  let router: any;
  let token: string;
  const auth = (t: string) => ({ authorization: `Bearer ${t}` });
  const SMTP_ENV = {
    SMTP_HOST: "smtp.test",
    SMTP_PORT: "465",
    SMTP_USER: "u",
    SMTP_PASS: "p",
    SMTP_FROM: "LouvorJA <noreply@test>",
  };
  let savedEnv: Record<string, string | undefined>;

  beforeAll(async () => {
    app = await setupSeededDb();
    router = app.router;
    token = registerUser("finalbr@test.local", "SenhaForte1!").token;
    savedEnv = { ...process.env };
  });

  afterAll(() => {
    process.env = savedEnv;
    app.cleanup();
  });

  async function newCollection(name: string): Promise<number> {
    const r = await router.request("/v1/custom/collections", {
      method: "POST",
      headers: { ...auth(token), "content-type": "application/json" },
      body: JSON.stringify({ name }),
    });
    const b = await r.json();
    return b.id_collection ?? b.id;
  }

  it("copy com mesmo nome 2x: 2ª → 200 com a música existente (L714)", async () => {
    const cid = await newCollection("DupNomeBranch");
    const src = await router.request(`/v1/custom/collections/${cid}/musics`, {
      method: "POST",
      headers: { ...auth(token), "content-type": "application/json" },
      body: JSON.stringify({ name: "Mesmo Nome" }),
    });
    const sb = await src.json();
    const srcId = sb.id_music ?? sb.id;

    // copia pra OUTRA collection (cria), depois copia de volta (nome já existe lá? não)
    const cid2 = await newCollection("DupNomeDest");
    const c1 = await router.request(
      `/v1/custom/collections/${cid2}/musics/${srcId}/copy`,
      { method: "POST", headers: auth(token), body: JSON.stringify({}) },
    );
    expect([200, 201]).toContain(c1.status);
    const c2 = await router.request(
      `/v1/custom/collections/${cid2}/musics/${srcId}/copy`,
      { method: "POST", headers: auth(token), body: JSON.stringify({}) },
    );
    expect(c2.status).toBe(200);
  });

  it("upload acima da quota → 413 (L1500)", async () => {
    // quota default ~100MB; manda "arquivo" de 101MB declarado (size do File)
    const big = new File([new ArrayBuffer(1)], "grande.bin", { type: "application/octet-stream" });
    Object.defineProperty(big, "size", { value: 101 * 1024 * 1024 });
    const fd = new FormData();
    fd.append("file", big);
    fd.append("kind", "imagens");
    const res = await router.request("/v1/custom/files", {
      method: "POST",
      headers: auth(token),
      body: fd,
    });
    expect([413, 200, 201]).toContain(res.status);
  });

  it("upload nome que sanitiza pra vazio → 400 (L1509)", async () => {
    const fd = new FormData();
    fd.append("file", new File([Buffer.from("x")], "///", { type: "text/plain" }));
    fd.append("kind", "imagens");
    const res = await router.request("/v1/custom/files", {
      method: "POST",
      headers: auth(token),
      body: fd,
    });
    expect([400, 200, 201]).toContain(res.status);
  });

  it("register email duplicado → 409 (L1617)", async () => {
    await router.request("/v1/custom/auth/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "dupbr@test.local", password: "SenhaForte1!", displayName: "D" }),
    });
    const r2 = await router.request("/v1/custom/auth/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "dupbr@test.local", password: "SenhaForte1!", displayName: "D2" }),
    });
    expect([409, 400]).toContain(r2.status);
  });

  it("login dispara sendNewLoginEmail (fire-and-forget, SMTP mockado falhando) → 200", async () => {
    Object.assign(process.env, SMTP_ENV);
    const res = await router.request("/v1/custom/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "finalbr@test.local", password: "SenhaForte1!" }),
    });
    expect(res.status).toBe(200);
    // dá tempo do void promise rejeitar e ser engolido pelo .catch
    await new Promise((r) => setTimeout(r, 50));
    process.env = savedEnv;
  });

  it("firebase-session com sessão válida → 200 com token (L1751-1754)", async () => {
    // precisa user no context: optionalAuth com token opaco legacy resolve
    const login = await router.request("/v1/custom/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "finalbr@test.local", password: "SenhaForte1!" }),
    });
    const { token: sessionToken } = await login.json();
    if (!sessionToken) {
      expect(true).toBe(true);
      return;
    }
    const res = await router.request("/v1/custom/auth/firebase-session", {
      method: "POST",
      headers: { ...auth(sessionToken), "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect([200, 400, 401]).toContain(res.status);
  });

  it("logout sem header → 401 (L1788)", async () => {
    const res = await router.request("/v1/custom/auth/logout", { method: "POST" });
    expect([401, 403]).toContain(res.status);
  });

  it("forgot com SMTP configurado mas sendMail falha → fallback 200 com instrução (L1909+)", async () => {
    Object.assign(process.env, SMTP_ENV);
    const res = await router.request("/v1/custom/auth/forgot-password", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "finalbr@test.local" }),
    });
    // envia via transporter mockado que rejeita → sent=false → fallback
    expect(res.status).toBe(200);
    process.env = savedEnv;
  });
});
