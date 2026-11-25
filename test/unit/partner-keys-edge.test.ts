import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/db/connection.js", () => ({
  initDb: vi.fn(),
  closeDb: vi.fn(),
}));
vi.mock("../../src/lib/partnerKeys.js", () => ({
  createPartner: vi.fn(),
  listPartners: vi.fn(() => []),
  revokePartner: vi.fn(),
  findPartnerByKey: vi.fn(),
}));
vi.mock("../../src/middleware/metrics.js", () => ({
  incPartnerRequest: vi.fn(),
}));

afterEach(() => vi.restoreAllMocks());

describe("partner keys: operação e falhas de consulta", () => {
  it("CLI pode ser importado sem caminho de execução e informa cadastro vazio", async () => {
    const argv = process.argv;
    let cli: typeof import("../../src/cli/partners.js");
    try {
      process.argv = [argv[0]];
      cli = await import("../../src/cli/partners.js");
    } finally {
      process.argv = argv;
    }
    const out = vi.fn();
    expect(cli.run(["list"], out)).toBe(0);
    expect(out).toHaveBeenCalledExactlyOnceWith("Nenhum parceiro cadastrado.");
    const { initDb } = await import("../../src/db/connection.js");
    expect(initDb).not.toHaveBeenCalled();
  });

  it("falha não-Error no lookup mantém a requisição disponível e sem parceiro", async () => {
    const { findPartnerByKey } = await import("../../src/lib/partnerKeys.js");
    vi.mocked(findPartnerByKey).mockImplementationOnce(() => {
      throw "lookup indisponível";
    });
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const { partnerKey } = await import("../../src/middleware/partnerKey.js");
    const app = new Hono();
    app.use("*", partnerKey);
    app.get("/x", (c) => c.text("disponível"));
    const res = await app.request("/x", {
      headers: { "X-Partner-Key": "plj_test" },
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("disponível");
    expect(log).toHaveBeenCalledWith(
      "[piano-api] partnerKey lookup falhou:",
      "lookup indisponível",
    );
    const { incPartnerRequest } = await import(
      "../../src/middleware/metrics.js"
    );
    expect(incPartnerRequest).not.toHaveBeenCalled();
  });
});
