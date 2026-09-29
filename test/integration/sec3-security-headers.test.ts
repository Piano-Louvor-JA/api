// SEC-3 (api#124): headers de segurança — CSP + verificação dos 5 headers
// Critério de aceite da issue: CSP `default-src 'none'` no secureHeaders +
// os 5 headers presentes em todas as rotas (curl-verified).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../../src/app.js";
import { closeDb, initDb } from "../../src/db/connection.js";

let app: ReturnType<typeof createApp>;

beforeAll(() => {
  process.env.DB_PATH = ":memory:";
  process.env.NODE_ENV = "production"; // HSTS ativo, como em prod (evidência curl da issue)
  initDb();
  app = createApp();
});

afterAll(() => {
  closeDb();
});

describe("SEC-3: headers de segurança em todas as rotas", () => {
  it.each(["/v1/health", "/v1/albums", "/v1/categories"])(
    "expõe os 5 headers de segurança em %s",
    async (path) => {
      const res = await app.request(`http://localhost${path}`);

      expect(res.headers.get("strict-transport-security")).toContain(
        "max-age=31536000",
      );
      expect(res.headers.get("x-content-type-options")).toBe("nosniff");
      expect(res.headers.get("x-frame-options")).toBe("SAMEORIGIN");
      expect(res.headers.get("referrer-policy")).toBe(
        "strict-origin-when-cross-origin",
      );
      // CSP: API não serve HTML — default-src 'none' (escopo exato da issue)
      expect(res.headers.get("content-security-policy")).toBe(
        "default-src 'none'",
      );
    },
  );

  it("override de CSP no /palco permite script inline + WS do receiver", async () => {
    const res = await app.request("http://localhost/palco/");
    const csp = res.headers.get("content-security-policy") ?? "";
    expect(csp).toContain("script-src 'self' 'unsafe-inline'");
    expect(csp).toContain("connect-src 'self' ws: wss:");
    expect(csp).not.toBe("default-src 'none'");
  });

  it("override de CSP no /doc permite CDN do Scalar", async () => {
    const res = await app.request("http://localhost/doc");
    const csp = res.headers.get("content-security-policy") ?? "";
    expect(csp).toContain("https://cdn.jsdelivr.net");
    expect(csp).not.toBe("default-src 'none'");
  });

  it("mantém CORP cross-origin em dev (CORS_ORIGINS=*) para mídia do web/Electron", async () => {
    const res = await app.request("http://localhost/v1/albums");
    expect(res.headers.get("cross-origin-resource-policy")).toBe(
      "cross-origin",
    );
  });
});
