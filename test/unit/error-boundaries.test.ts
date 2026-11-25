import { Hono } from "hono";
import { afterEach, expect, it, vi } from "vitest";
import { zodErrorHook } from "../../src/lib/zodErrorHook.js";
import { antiBotMiddleware } from "../../src/middleware/antiBot.js";
import { verifyPassword } from "../../src/v1/custom/auth.service.js";

afterEach(() => vi.restoreAllMocks());
it.each(["0", "-1", "NaN", "Infinity"])(
  "rejeita custo de senha inválido %s",
  (cost) => {
    expect(verifyPassword("password", `pbkdf2$${cost}$salt$ff`)).toBe(false);
  },
);
it("validação incompleta responde erro genérico", () => {
  const log = vi.spyOn(console, "error").mockImplementation(() => {}),
    json = vi.fn();
  zodErrorHook({ success: false }, { json });
  expect(json).toHaveBeenCalledWith(
    { success: false, error: "Parâmetros inválidos" },
    400,
  );
  expect(log).toHaveBeenCalledWith("ZodError:", "[]");
});
it("probing registra diagnóstico sem bloquear acesso", async () => {
  const log = vi.spyOn(console, "log").mockImplementation(() => {}),
    app = new Hono();
  app.use("*", antiBotMiddleware);
  app.get("/doc", (c) => c.text("documentation"));
  const res = await app.request("/doc");
  expect(res.status).toBe(200);
  expect(await res.text()).toBe("documentation");
  expect(log).toHaveBeenCalledWith(
    expect.stringContaining("Probing detectado"),
  );
});
it("resposta lenta preserva conteúdo e registra duração", async () => {
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  let now = 1000;
  vi.spyOn(Date, "now").mockImplementation(() => now);
  const app = new Hono();
  app.use("*", antiBotMiddleware);
  app.get("/v1/example", (c) => {
    now += 3000;
    return c.text("ok");
  });
  const res = await app.request("/v1/example");
  expect(await res.text()).toBe("ok");
  expect(res.status).toBe(200);
  expect(log).toHaveBeenCalledWith(
    expect.stringContaining("Request lenta: 3000ms"),
  );
});
