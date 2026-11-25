// SEC-4 (issue Piano-louvor-JA/api#125): ZodError não pode vazar na resposta
// Spec: comentário 5883186824 na issue — resposta genérica, detalhe só em log server-side
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createApp } from "../../src/app.js";
import { closeDb, initDb } from "../../src/db/connection.js";

let app: ReturnType<typeof createApp>;

beforeAll(() => {
  process.env.DB_PATH = ":memory:";
  initDb();
  app = createApp();
});

afterAll(() => {
  closeDb();
});

describe("SEC-4: ZodError sanitizado (info leak)", () => {
  it.each([
    "/v1/albums/999999", // param fora do schema
    "/v1/bible/1/1", // sem query obrigatória (lang)
  ])("GET %s não vaza estrutura interna de validação", async (path) => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const res = await app.request(path);
      const text = await res.text();

      expect(text).not.toContain("ZodError");
      expect(text).not.toContain("expected");
      expect(text).not.toContain("invalid_type");
      expect(text).not.toContain('"path"');
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("mantém contrato success/error e mensagem genérica", async () => {
    const res = await app.request("/v1/albums/999999");
    const body = (await res.json()) as { error?: unknown };

    expect(body.error).toBe("Parâmetros inválidos");
  });

  it("loga o detalhe completo server-side para debug", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await app.request("/v1/albums/999999");
      expect(errorSpy).toHaveBeenCalled();
      const logged = errorSpy.mock.calls.flat().join(" ");
      expect(logged).toContain("ZodError");
    } finally {
      errorSpy.mockRestore();
    }
  });
});
