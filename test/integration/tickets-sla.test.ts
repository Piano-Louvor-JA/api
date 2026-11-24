// B1 Slice 4 — SLA P1–P4, janela 08:00–18:00 America/Sao_Paulo (BD-02)
import { describe, expect, it } from "vitest";
import {
  addBusinessHours,
  computeSlaDueDates,
} from "../../src/v1/tickets/tickets.sla.js";

// America/Sao_Paulo = UTC-3 (sem DST desde 2019)

function spDate(iso: string): Date {
  return new Date(iso);
}

describe("SLA — janela comercial 08:00–18:00 America/Sao_Paulo", () => {
  it("dentro do horário comercial: conta a partir do momento", () => {
    // 2026-11-19 15:00 SP (18:00 UTC) — quinta-feira, dentro da janela
    const start = spDate("2026-11-19T18:00:00.000Z");
    const end = addBusinessHours(start, 1);
    // 15:00 + 1h = 16:00 SP mesmo dia (dentro da janela)
    expect(end.toISOString()).toBe("2026-11-19T19:00:00.000Z");
  });

  it(" fora da janela (noite) → avança para próximo dia útil 08:00", () => {
    // 2026-11-19 22:00 SP (2026-11-20T01:00Z) — quinta noite
    const start = spDate("2026-11-20T01:00:00.000Z");
    const end = addBusinessHours(start, 1);
    // próximo dia útil (sexta 20/11) 08:00 SP + 1h = 09:00 SP = 12:00Z
    expect(end.toISOString()).toBe("2026-11-20T12:00:00.000Z");
  });

  it("sexta após 18h → segunda 08:00", () => {
    // 2026-11-20 20:00 SP (23:00Z sexta)
    const start = spDate("2026-11-20T23:00:00.000Z");
    const end = addBusinessHours(start, 2);
    // segunda 23/11 08:00 SP + 2h = 10:00 SP = 13:00Z
    expect(end.toISOString()).toBe("2026-11-23T13:00:00.000Z");
  });

  it("horas que transbordam o dia útil continuam no dia seguinte", () => {
    // 2026-11-19 16:00 SP (19:00Z) + 4h → cabem 2h hoje (até 18h),
    // 2h restantes vão para sexta 08:00→10:00 SP = 13:00Z
    const start = spDate("2026-11-19T19:00:00.000Z");
    const end = addBusinessHours(start, 4);
    expect(end.toISOString()).toBe("2026-11-20T13:00:00.000Z");
  });

  it("P1–P4 geram prazos distintos e monotônicos", () => {
    const start = spDate("2026-11-19T15:00:00.000Z"); // 12:00 SP dentro da janela
    const p1 = computeSlaDueDates("P1", start);
    const p2 = computeSlaDueDates("P2", start);
    const p3 = computeSlaDueDates("P3", start);
    const p4 = computeSlaDueDates("P4", start);
    expect(new Date(p1.firstResponseDueAt).getTime()).toBeLessThan(
      new Date(p2.firstResponseDueAt).getTime(),
    );
    expect(new Date(p2.firstResponseDueAt).getTime()).toBeLessThan(
      new Date(p3.firstResponseDueAt).getTime(),
    );
    expect(new Date(p3.firstResponseDueAt).getTime()).toBeLessThan(
      new Date(p4.firstResponseDueAt).getTime(),
    );
    expect(new Date(p1.resolutionDueAt).getTime()).toBeLessThan(
      new Date(p1.firstResponseDueAt).getTime() + 1000 * 60 * 60 * 24 * 30,
    );
  });
});
