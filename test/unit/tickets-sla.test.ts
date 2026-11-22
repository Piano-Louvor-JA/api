/**
 * central-tickets B1 — testes UNITÁRIOS (sla.service + auth middleware puro).
 */
import { beforeAll, describe, expect, it } from "vitest";
import { getDb, initDb } from "../../src/db/connection.js";
import {
  addBusinessHours,
  computeDueDates,
  slaFor,
} from "../../src/v1/tickets/sla.service.js";

beforeAll(() => {
  process.env.DB_PATH ??= ":memory:";
  initDb();
});

describe("slaFor", () => {
  it("P1 ndaad → 1h primeira resposta", () => {
    expect(slaFor("ndaad", "P1").first_response_hours).toBe(1);
  });
  it("P4 ndaad → 24h/120h", () => {
    expect(slaFor("ndaad", "P4")).toEqual({
      first_response_hours: 24,
      resolve_hours: 120,
    });
  });
  it("tenant sem política cai no default 24/120", () => {
    expect(slaFor("sem-sla-tenant", "P1")).toEqual({
      first_response_hours: 24,
      resolve_hours: 120,
    });
  });
});

describe("addBusinessHours", () => {
  it("dentro da janela útil soma direto", () => {
    // 2026-11-23 seg 10:00 SP = 13:00 UTC
    const from = "2026-11-23T13:00:00.000Z";
    expect(addBusinessHours(from, 1)).toBe("2026-11-23T14:00:00.000Z");
  });

  it("após 18h pula para próximo dia útil 08h", () => {
    // seg 19:00 SP (22:00 UTC) + 1h útil → ter 09:00 SP (12:00 UTC)
    const from = "2026-11-23T22:00:00.000Z";
    expect(addBusinessHours(from, 1)).toBe("2026-11-24T12:00:00.000Z");
  });

  it("sexta após 18h pula para segunda 08h", () => {
    // sex 2026-11-27 19:00 SP (22:00 UTC) + 2h úteis → seg 2026-11-30 10:00 SP (13:00 UTC)
    const from = "2026-11-27T22:00:00.000Z";
    expect(addBusinessHours(from, 2)).toBe("2026-11-30T13:00:00.000Z");
  });

  it("soma que ultrapassa 18h para no mesmo dia e continua no próximo", () => {
    // seg 17:00 SP (20:00 UTC) + 3h → 1h até 18h + 2h → ter 10:00 SP (13:00 UTC)
    const from = "2026-11-23T20:00:00.000Z";
    expect(addBusinessHours(from, 3)).toBe("2026-11-24T13:00:00.000Z");
  });

  it("fim de semana inteiro pula para segunda", () => {
    // sáb 2026-11-28 10:00 SP (13:00 UTC) + 1h → seg 09:00 SP (12:00 UTC)
    const from = "2026-11-28T13:00:00.000Z";
    expect(addBusinessHours(from, 1)).toBe("2026-11-30T12:00:00.000Z");
  });
});

describe("computeDueDates", () => {
  it("P1 dentro da janela gera first+resolve", () => {
    const due = computeDueDates("ndaad", "P1", "2026-11-23T13:00:00.000Z");
    expect(due.firstResponseDue).toBe("2026-11-23T14:00:00.000Z");
    // resolve conta desde a criação: 10:00 SP + 4h úteis = 14:00 SP (17:00 UTC)
    expect(due.resolveDue).toBe("2026-11-23T17:00:00.000Z");
  });
});
