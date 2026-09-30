/**
 * SEC-6 Fase 0 — relatório p95/p99 de requests por IP/min a partir dos logs.
 * Issue: Piano-louvor-JA/api#127
 *
 * Lê as linhas `[telemetry] {...}` emitidas pelo middleware
 * (src/middleware/telemetry.ts) e calcula, por minuto e agregado:
 *   - p95/p99 de requests por IP (distribuição dos totais por IP/minuto)
 *   - total de requests, IPs únicos, top IPs e top rotas
 *
 * Uso:
 *   node dist/scripts/analyze-telemetry.js < log-api.txt
 *   docker logs piano-api 2>&1 | node dist/scripts/analyze-telemetry.js
 *   node dist/scripts/analyze-telemetry.js log.txt --json
 *   node dist/scripts/analyze-telemetry.js --self-test   # distribuição conhecida
 *
 * Saída: relatório texto (ou JSON com --json) — insumo para decidir
 * thresholds da Fase 1 com DADOS de sábado real (mín. 5x p99, issue #127).
 */

import { readFileSync } from "node:fs";

interface TelemetryLine {
  minute: string;
  ip: string;
  total: number;
  routes: Record<string, number>;
}

export function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  // Interpolado (método padrão em telemetria/observabilidade)
  const idx = (sorted.length - 1) * (p / 100);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

export function parseTelemetryLines(input: string): TelemetryLine[] {
  const out: TelemetryLine[] = [];
  for (const rawLine of input.split("\n")) {
    const line = rawLine.trim();
    if (!line.startsWith("[telemetry]")) continue;
    try {
      const parsed = JSON.parse(
        line.slice("[telemetry]".length),
      ) as TelemetryLine;
      if (
        typeof parsed.minute === "string" &&
        typeof parsed.ip === "string" &&
        typeof parsed.total === "number"
      ) {
        out.push({
          minute: parsed.minute,
          ip: parsed.ip,
          total: parsed.total,
          routes: parsed.routes ?? {},
        });
      }
    } catch {
      // linha malformada fora do formato — ignora
    }
  }
  return out;
}

export interface MinuteReport {
  minute: string;
  totalRequests: number;
  uniqueIps: number;
  p95: number;
  p99: number;
  max: number;
  topIps: Array<{ ip: string; count: number }>;
}

export function reportByMinute(lines: TelemetryLine[]): MinuteReport[] {
  const byMinute = new Map<string, TelemetryLine[]>();
  for (const l of lines) {
    const arr = byMinute.get(l.minute) ?? [];
    arr.push(l);
    byMinute.set(l.minute, arr);
  }

  return [...byMinute.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([minute, entries]) => {
      // Nota: `total` é cumulativo dentro do minuto (o middleware re-loga o
      // bucket a cada request). O valor final por IP = último registro.
      const finalByIp = new Map<string, number>();
      for (const e of entries) finalByIp.set(e.ip, e.total);
      const counts = [...finalByIp.values()].sort((a, b) => a - b);
      const totalRequests = counts.reduce((s, n) => s + n, 0);

      return {
        minute,
        totalRequests,
        uniqueIps: finalByIp.size,
        p95: percentile(counts, 95),
        p99: percentile(counts, 99),
        max: counts[counts.length - 1] ?? 0,
        topIps: [...finalByIp.entries()]
          .map(([ip, count]) => ({ ip, count }))
          .sort((a, b) => b.count - a.count)
          .slice(0, 5),
      };
    });
}

export interface GlobalReport {
  minutes: number;
  totalRequests: number;
  uniqueIps: number;
  p95: number;
  p99: number;
  max: number;
  topIps: Array<{ ip: string; count: number }>;
  topRoutes: Array<{ route: string; count: number }>;
}

export function reportGlobal(lines: TelemetryLine[]): GlobalReport {
  const finalByIp = new Map<string, number>();
  const minutes = new Set<string>();

  for (const l of lines) {
    minutes.add(l.minute);
  }
  // Último `total` por (ip) dentro de cada minuto já é o total do minuto;
  // somamos por minuto para não dupla-contar IP presente em vários minutos.
  const perMinuteIp = new Map<string, Map<string, number>>();
  for (const l of lines) {
    const m = perMinuteIp.get(l.minute) ?? new Map<string, number>();
    m.set(l.ip, l.total);
    perMinuteIp.set(l.minute, m);
  }
  for (const [, ips] of perMinuteIp) {
    for (const [ip, total] of ips) {
      finalByIp.set(ip, (finalByIp.get(ip) ?? 0) + total);
    }
  }
  // Rotas: último valor por (minute, ip, rota) = total daquele minuto.
  const perMinuteRoute = new Map<string, number>();
  const seenRouteFinal = new Set<string>();
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i];
    for (const [route, count] of Object.entries(l.routes)) {
      const key = `${l.minute}|${l.ip}|${route}`;
      if (seenRouteFinal.has(key)) continue;
      seenRouteFinal.add(key);
      perMinuteRoute.set(route, (perMinuteRoute.get(route) ?? 0) + count);
    }
  }

  const counts = [...finalByIp.values()].sort((a, b) => a - b);
  return {
    minutes: minutes.size,
    totalRequests: counts.reduce((s, n) => s + n, 0),
    uniqueIps: finalByIp.size,
    p95: percentile(counts, 95),
    p99: percentile(counts, 99),
    max: counts[counts.length - 1] ?? 0,
    topIps: [...finalByIp.entries()]
      .map(([ip, count]) => ({ ip, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 10),
    topRoutes: [...perMinuteRoute.entries()]
      .map(([route, count]) => ({ route, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 10),
  };
}

function fmt(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(1);
}

function printReport(perMinute: MinuteReport[], global: GlobalReport): void {
  console.log("SEC-6 Fase 0 — relatório de telemetria (requests por IP/min)");
  console.log("=".repeat(72));
  console.log(
    `${"minuto (UTC)".padEnd(17)} ${"total".padStart(7)} ${"IPs".padStart(5)} ${"p95".padStart(7)} ${"p99".padStart(7)} ${"max".padStart(7)}`,
  );
  for (const m of perMinute) {
    console.log(
      `${m.minute.padEnd(17)} ${String(m.totalRequests).padStart(7)} ${String(m.uniqueIps).padStart(5)} ${fmt(m.p95).padStart(7)} ${fmt(m.p99).padStart(7)} ${String(m.max).padStart(7)}`,
    );
  }
  console.log("-".repeat(72));
  console.log(
    `Janela: ${global.minutes} minuto(s), ${global.totalRequests} requests, ${global.uniqueIps} IP(s)`,
  );
  console.log(
    `p95 por IP/min: ${fmt(global.p95)}   p99 por IP/min: ${fmt(global.p99)}   max: ${global.max}`,
  );
  if (global.topIps.length > 0) {
    console.log("Top IPs:");
    for (const t of global.topIps)
      console.log(`  ${t.ip.padEnd(16)} ${String(t.count).padStart(8)}`);
  }
  if (global.topRoutes.length > 0) {
    console.log("Top rotas:");
    for (const t of global.topRoutes)
      console.log(`  ${t.route.padEnd(36)} ${String(t.count).padStart(8)}`);
  }
}

/** Distribuição sintética com p95/p99 conhecidos (validação do parser). */
function selfTest(): number {
  // 100 IPs com 1..100 req/min → p95 = 95.05, p99 = 99.01 (interpolado)
  const lines: TelemetryLine[] = [];
  for (let i = 1; i <= 100; i++) {
    lines.push({
      minute: "2026-10-03T19:00", // um sábado :), UTC
      ip: `10.0.0.${i}`,
      total: i,
      routes: { "GET /v1/musics": i },
    });
  }
  const [m] = reportByMinute(lines);
  const g = reportGlobal(lines);
  const expected = { p95: 95.05, p99: 99.01 };
  const ok =
    Math.abs(m.p95 - expected.p95) < 0.01 &&
    Math.abs(m.p99 - expected.p99) < 0.01 &&
    m.totalRequests === 5050 &&
    m.uniqueIps === 100 &&
    g.p95 === m.p95;
  console.log(
    `self-test: p95=${m.p95} (esp ${expected.p95}) p99=${m.p99} (esp ${expected.p99}) total=${m.totalRequests} ips=${m.uniqueIps} → ${ok ? "OK" : "FAIL"}`,
  );
  return ok ? 0 : 1;
}

function main(): number {
  const args = process.argv.slice(2);
  if (args.includes("--self-test")) return selfTest();

  let input = "";
  const fileArgs = args.filter((a) => !a.startsWith("--"));
  if (fileArgs.length > 0) {
    input = readFileSync(fileArgs[0], "utf-8");
  } else {
    input = readFileSync("/dev/stdin", "utf-8");
  }

  const lines = parseTelemetryLines(input);
  if (lines.length === 0) {
    console.error("Nenhuma linha [telemetry] encontrada na entrada.");
    return 1;
  }
  const perMinute = reportByMinute(lines);
  const global = reportGlobal(lines);

  if (args.includes("--json")) {
    console.log(JSON.stringify({ perMinute, global }, null, 2));
  } else {
    printReport(perMinute, global);
  }
  return 0;
}

// Executa como script apenas quando invocado diretamente (import de teste não roda main)
if (process.argv[1]?.includes("analyze-telemetry")) {
  process.exit(main());
}
