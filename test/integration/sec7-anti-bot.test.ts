// Teste do anti-bot/script kiddie middleware
import { describe, it, expect, beforeEach } from "vitest";
import { Hono } from "hono";
import { antiBotMiddleware } from "./src/middleware/antiBot.js";

describe("antiBotMiddleware", () => {
  const app = new Hono();
  app.use("/api/*", antiBotMiddleware);
  app.get("/api/teste", (c) => c.json({ ok: true }));

  it("bloqueia user-agent suspeito", async () => {
    const res = await app.request("http://localhost/api/teste", {
      headers: { "user-agent": "curl/7.88.1" },
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({
      error: "User-Agent não suportado. Utilize um cliente HTTP padrão.",
    });
  });

  it("aceita user-agent normal", async () => {
    const res = await app.request("http://localhost/api/teste", {
      headers: { "user-agent": "Mozilla/5.0" },
    });
    expect(res.status).toBe(200);
  });
});