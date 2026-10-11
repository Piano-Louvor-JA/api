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

  it("override de CSP no /doc permite CDN do Scalar E o script inline do apiReference (hash exato)", async () => {
    const res = await app.request("http://localhost/doc");
    const csp = res.headers.get("content-security-policy") ?? "";
    expect(csp).toContain("https://cdn.jsdelivr.net");
    // o HTML do @scalar/hono-api-reference injeta <script type="module">
    // inline; sem hash o browser bloqueia e a página fica branca.
    // Hash = sha256 do corpo exato do script inline (371 chars), verificado
    // contra o HTML servido em dev e stg (idênticos).
    expect(csp).toContain(
      "script-src 'self' 'sha256-cJJuuIl7sR6XSe3HJ7vUlnJlP9y1BeLiX0XJPjPWRPc=' https://cdn.jsdelivr.net",
    );
    // script-src NÃO pode ter 'unsafe-inline' (hash é o mecanismo exato);
    // style-src mantém 'unsafe-inline' — Scalar injeta <style> inline
    const scriptSrc = csp.match(/script-src ([^;]+)/)?.[1] ?? "";
    expect(scriptSrc).not.toContain("'unsafe-inline'");
    expect(csp).not.toBe("default-src 'none'");
    // ponytail: guarda de hash-vs-HTML-real não roda aqui (test env não serve
    // o HTML completo do Scalar); valida-se no smoke pós-deploy (stg/dev).
  });

  it("mantém CORP cross-origin em dev (CORS_ORIGINS=*) para mídia do web/Electron", async () => {
    const res = await app.request("http://localhost/v1/albums");
    expect(res.headers.get("cross-origin-resource-policy")).toBe(
      "cross-origin",
    );
  });
});
