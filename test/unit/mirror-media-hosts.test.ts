import { describe, expect, it } from "vitest";

/**
 * RED TEAM 2026-09-30 (api-stg bateria 1): o mirror on-demand de /file/:path*
 * pendurava para sempre quando o host principal (api.louvorja.com.br) estava
 * fora — fetch sem AbortSignal.timeout. Com o upstream morto, cada request de
 * mídia segura 1 conexão aberta indefinidamente = DoS sem atacante.
 *
 * Contratos novos:
 * 1. fetch do mirror tem timeout (não pendura) — host lento/morto é pulado.
 * 2. Ordem de tentativa: FALLBACK primeiro (workers.dev/Cloudflare, estável),
 *    host principal (classic) por ÚLTIMO — diretriz do Rafael: upstream
 *    instável vai pro fim da fila.
 * 3. UPSTREAM_FALLBACK_API aceita lista separada por vírgula (dica do
 *    Ezequias): "a,b,c" cria múltiplos candidatos de fallback.
 */

describe("mirror media hosts (ordem + parse de lista)", () => {
  it("ordena: fallbacks primeiro, host principal por último", async () => {
    const { mediaHostsForTest } = await import("../../src/routes/compat.js");
    const hosts = mediaHostsForTest("https://classic.example.com");
    expect(hosts[0]).not.toContain("classic.example.com");
    expect(hosts[hosts.length - 1]).toBe("https://classic.example.com");
  });

  it("parseia UPSTREAM_FALLBACK_API como lista separada por vírgula", async () => {
    const { mediaHostsForTest } = await import("../../src/routes/compat.js");
    const hosts = mediaHostsForTest(
      "https://classic.example.com",
      "https://a.workers.dev, https://b.workers.dev",
    );
    // fallbacks na ordem declarada, principal no fim, sem duplicados
    expect(hosts).toEqual([
      "https://a.workers.dev",
      "https://b.workers.dev",
      "https://classic.example.com",
    ]);
  });

  it("sem UPSTREAM_FALLBACK_API: default workers.dev antes do principal", async () => {
    const { mediaHostsForTest } = await import("../../src/routes/compat.js");
    const hosts = mediaHostsForTest("https://classic.example.com", undefined);
    expect(hosts).toEqual([
      "https://api.louvorja.workers.dev",
      "https://classic.example.com",
    ]);
  });

  it("MIRROR_FETCH_TIMEOUT_MS existe e é finito (proteção anti-hang)", async () => {
    const { MIRROR_FETCH_TIMEOUT_MS_FOR_TEST } = await import(
      "../../src/routes/compat.js"
    );
    expect(MIRROR_FETCH_TIMEOUT_MS_FOR_TEST).toBeGreaterThan(0);
    expect(MIRROR_FETCH_TIMEOUT_MS_FOR_TEST).toBeLessThanOrEqual(15_000);
  });
});
