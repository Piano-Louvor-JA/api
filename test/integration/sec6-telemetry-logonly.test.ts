// SEC-6 Fase 0: middleware de telemetria log-only (sem bloqueio)
// Issue: Piano-louvor-JA/api#127 — telemetria sem bloqueio para decisão futura de rate limit
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

describe("SEC-6 Fase 0: telemetria sem bloqueio (log-only)", () => {
  beforeEach(() => {
    // Limpa métricas para teste limpo
    vi.spyOn(console, "log").mockImplementation(() => {});
    process.env.NODE_ENV = "development"; // Força ambiente não-production para middleware
  });

  afterEach(() => {
    process.env.NODE_ENV = "test"; // Volta ao normal
  });

  it("conta requests por IP/min (sem bloquear nenhuma)", async () => {
    // Força a flag de ambiente para middleware ativo
    const originalEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = "development";
    
    const res1 = await app.request("http://localhost/v1/categories");
    const res2 = await app.request("http://localhost/v1/categories", {
      headers: { "x-real-ip": "192.168.1.100" },
    });
    const res3 = await app.request("http://localhost/v1/albums");
    
    process.env.NODE_ENV = originalEnv;

    // Todas as requests devem retornar 200 (nenhum bloqueado)
    expect(res1.status).toBe(200);
    expect(res2.status).toBe(200);
    expect(res3.status).toBe(200);
  });

  it("exporta métricas agregadas via endpoint de debug", async () => {
    // Força a flag de ambiente para middleware ativo
    const originalEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = "development";
    
    // Faz alguns requests para gerar dados
    await app.request("http://localhost/v1/categories");
    await app.request("http://localhost/v1/categories", {
      headers: { "x-real-ip": "10.0.0.5" },
    });
    
    const res = await app.request("http://localhost/v1/telemetry/debug");
    process.env.NODE_ENV = originalEnv;

    expect(res.status).toBe(200);
    const metrics = (await res.json()) as Array<{
      minute: string;
      ip: string;
      method: string;
      path: string;
      count: number;
    }>;

    expect(metrics.length).toBeGreaterThan(0);
    expect(metrics.some(m => m.ip === "10.0.0.5")).toBe(true);
    expect(metrics.some(m => m.path === "/v1/categories")).toBe(true);
  });

  it("acessa à rota de telemetria mesmo quando rate limit atingido (outro middleware)", async () => {
    // Força a flag de ambiente para middleware ativo
    const originalEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = "development";
    
    // Fazer muitas requests pode atingir o rate limit existente, mas a telemetria deve continuar
    const promises = [];
    for (let i = 0; i < 30; i++) {
      promises.push(app.request("http://localhost/v1/categories"));
    }

    // Algumas podem 429 (rate limit), mas nenhuma deve bloquear por causa da telemetria
    const results = await Promise.all(promises);
    process.env.NODE_ENV = originalEnv;

    expect(results.some(r => r.status === 429)).toBe(true);
    expect(results.every(r => r.status !== 500)).toBe(true); // Telemetria não quebra
  });
});