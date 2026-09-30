import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../../src/app.js";

describe("OpenAPI Docs", () => {
  const app = createApp();

  it("GET /openapi.json deve retornar spec valida", async () => {
    const res = await app.request("/openapi.json");
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.openapi).toBe("3.0.0");
    expect(body.info.title).toBe("Piano Louvor JA API");
    expect(body.info.version).toBeDefined();
    // O endpoint /v1/health deve estar documentado
    expect(body.paths["/v1/health"]).toBeDefined();
    expect(body.paths["/v1/health"].get).toBeDefined();
  });

  it("GET /doc deve servir Swagger UI em HTML", async () => {
    const res = await app.request("/doc");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
  });

  it("GET /v1/health deve estar documentado com schema", async () => {
    const res = await app.request("/openapi.json");
    const body = await res.json();
    const healthPath = body.paths["/v1/health"].get;
    const responseSchema =
      healthPath.responses["200"].content["application/json"].schema;
    expect(responseSchema.properties.status).toBeDefined();
    expect(responseSchema.properties.version).toBeDefined();
    expect(responseSchema.properties.uptime).toBeDefined();
    expect(responseSchema.properties.db_size).toBeDefined();
    expect(responseSchema.properties.tables).toBeDefined();
  });
});

describe("SEC-5: docs bloqueados em producao", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("GET /openapi.json responde 404 com NODE_ENV=production", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const prodApp = createApp();

    const res = await prodApp.request("/openapi.json");
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBeTruthy();
  });

  it("GET /doc responde 404 com NODE_ENV=production", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const prodApp = createApp();

    const res = await prodApp.request("/doc");
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBeTruthy();
  });

  it("GET /doc e /openapi.json continuam 200 sem NODE_ENV=production", async () => {
    vi.stubEnv("NODE_ENV", "development");
    const devApp = createApp();

    const spec = await devApp.request("/openapi.json");
    expect(spec.status).toBe(200);
    const specBody = (await spec.json()) as { paths?: Record<string, unknown> };
    expect(specBody.paths?.["/v1/health"]).toBeDefined();

    const doc = await devApp.request("/doc");
    expect(doc.status).toBe(200);
    expect(doc.headers.get("content-type")).toContain("text/html");
  });
});
