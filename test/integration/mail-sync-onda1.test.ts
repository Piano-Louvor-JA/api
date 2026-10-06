import { describe, expect, it, beforeAll, afterAll, vi } from "vitest";

import { type SeededDb, setupSeededDb } from "../helpers/seeded-db.js";

/**
 * Onda 1c: mail.service (SMTP mockado via vi.mock) + sync.routes (POST /v1/custom/sync).
 */
vi.mock("nodemailer", () => ({
  createTransport: vi.fn(() => ({
    sendMail: vi.fn().mockResolvedValue({ messageId: "mock-1" }),
  })),
}));

describe("Mail service (SMTP mockado)", () => {
  let app: SeededDb;
  let mail: typeof import("../../src/v1/custom/mail.service.js");
  const SMTP_ENV = {
    SMTP_HOST: "smtp.test",
    SMTP_PORT: "465",
    SMTP_USER: "u",
    SMTP_PASS: "p",
    SMTP_FROM: "LouvorJA <noreply@test>",
  };

  beforeAll(async () => {
    app = await setupSeededDb();
    mail = await import("../../src/v1/custom/mail.service.js");
  });

  afterAll(() => app.cleanup());

  it("smtpConfigured reflete envs", () => {
    const prev = { ...process.env };
    delete process.env.SMTP_HOST;
    expect(mail.smtpConfigured()).toBe(false);
    Object.assign(process.env, SMTP_ENV);
    expect(mail.smtpConfigured()).toBe(true);
    process.env = prev;
  });

  it("sendResetTokenEmail sem SMTP falha rápido", async () => {
    const prev = { ...process.env };
    delete process.env.SMTP_HOST;
    await expect(
      mail.sendResetTokenEmail("x@test", "token-123"),
    ).rejects.toThrow();
    process.env = prev;
  });

  it("sendResetTokenEmail com SMTP envia via transporter", async () => {
    const prev = { ...process.env };
    Object.assign(process.env, SMTP_ENV);
    // assinatura: (to, displayName, token)
    const ok = await mail.sendResetTokenEmail("dest@test", "Rafael", "token-9");
    expect(ok).toBe(true);

    const nodemailer = await import("nodemailer");
    const cfg = (nodemailer.createTransport as any).mock.calls.at(-1)?.[0];
    expect(cfg.host).toBe("smtp.test");
    process.env = prev;
  });

  it("sendWelcomeEmail e sendNewLoginEmail usam o mesmo pipeline", async () => {
    const prev = { ...process.env };
    Object.assign(process.env, SMTP_ENV);
    expect(mail.smtpConfigured()).toBe(true);
    expect(await mail.sendWelcomeEmail("novo@test", "Rafael")).toBe(true);
    expect(
      await mail.sendNewLoginEmail("novo@test", "Rafael", "Chrome/Linux"),
    ).toBe(true);
    process.env = prev;
  });

  it("templates renderizam HTML com conteúdo esperado", async () => {
    const t = await import("../../src/v1/custom/email-templates.js");
    expect(t.renderWelcomeEmail("Rafael")).toContain("Rafael");
    expect(t.renderResetPasswordEmail("Rafael", "123456")).toContain("123456");
    expect(t.renderNewLoginEmail("Rafael", "Chrome/Linux")).toContain("Chrome/Linux");
  });
});

describe("Sync routes (POST /v1/custom/sync)", () => {
  let app: SeededDb;
  let router: any;
  let token: string;
  const auth = (t: string) => ({ authorization: `Bearer ${t}` });
  const collection = {
    client_uuid: "uuid-1234-5678",
    name: "Sync Onda",
    updated_at: 1,
  };

  beforeAll(async () => {
    app = await setupSeededDb();
    router = app.router;
    const { registerUser } = await import("./helpers/custom-auth-helpers.js");
    token = registerUser("sync@test.local", "SenhaForte1!").token;
  });

  afterAll(() => app.cleanup());

  it("POST /sync sem auth → 401", async () => {
    const res = await router.request("/v1/custom/sync", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ collections: [] }),
    });
    expect([401, 403]).toContain(res.status);
  });

  it("POST /sync com collections vazio responde 200 com resultado", async () => {
    const res = await router.request("/v1/custom/sync", {
      method: "POST",
      headers: { ...auth(token), "content-type": "application/json" },
      body: JSON.stringify({ collections: [] }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toBeDefined();
  });

  it("POST /sync com payload inválido → 400 com details", async () => {
    const res = await router.request("/v1/custom/sync", {
      method: "POST",
      headers: { ...auth(token), "content-type": "application/json" },
      body: JSON.stringify({ operations: "not-an-array" }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("Payload inválido");
  });

  it("POST /sync com JSON inválido (com auth) → 400", async () => {
    const res = await router.request("/v1/custom/sync", {
      method: "POST",
      headers: { ...auth(token), "content-type": "application/json" },
      body: "{broken",
    });
    expect(res.status).toBe(400);
  });

  it("POST /sync insere collection nova e reflete no resultado", async () => {
    const res = await router.request("/v1/custom/sync", {
      method: "POST",
      headers: { ...auth(token), "content-type": "application/json" },
      body: JSON.stringify({ collections: [collection] }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    const items = body.collections ?? body.data?.collections ?? [];
    expect(items.length).toBe(1);
    expect(items[0].id_collection ?? items[0].client_uuid).toBeDefined();
  });

  it("POST /sync idempotente: mesma uuid não duplica", async () => {
    const bodyReq = {
      method: "POST",
      headers: { ...auth(token), "content-type": "application/json" },
      body: JSON.stringify({ collections: [collection] }),
    };
    await router.request("/v1/custom/sync", bodyReq);
    const res2 = await router.request("/v1/custom/sync", bodyReq);
    expect(res2.status).toBe(200);
    const list = await router.request("/v1/custom/collections", {
      headers: auth(token),
    });
    const listBody = await list.json();
    const items = listBody.data ?? listBody;
    const named = (Array.isArray(items) ? items : items.items).filter(
      (c: any) => c.name === "Sync Onda",
    );
    expect(named.length).toBe(1);
  });
});
