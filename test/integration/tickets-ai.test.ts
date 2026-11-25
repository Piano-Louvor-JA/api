// B1 Slice 5 — Política IA fail-closed (RF-07, SPEC 5.2) + kill switches (RF-08)
process.env.TICKETS_AUTH_TEST_MODE = "1";

import { beforeEach, describe, expect, it } from "vitest";
import { closeDb, getDb, initDb } from "../../src/db/connection.js";
import {
  evaluateAutoSend,
  suggestAiResponse,
} from "../../src/v1/tickets/tickets.ai.js";
import type { TicketsAuth } from "../../src/v1/tickets/tickets.auth.js";

const auth = (over: Partial<TicketsAuth> = {}): TicketsAuth => ({
  uid: "uid-agent",
  tenantId: "a",
  role: "agent",
  globalOperator: false,
  ...over,
});

function seedAi() {
  const db = getDb();
  db.prepare(
    "INSERT INTO tenants (id, name) VALUES ('a', 'Tenant A'), ('b', 'Tenant B')",
  ).run();
  db.prepare(
    `INSERT INTO knowledge_sources (id, scope, title, content, approved_for_auto_send)
     VALUES ('kb-ok', 'global', 'FAQ PIANO', 'Conteúdo aprovado', 1)`,
  ).run();
  db.prepare(
    `INSERT INTO knowledge_sources (id, scope, tenant_id, title, content, approved_for_auto_send)
     VALUES ('kb-tenant-b', 'tenant', 'b', 'KB do B', 'Segredo do B', 1)`,
  ).run();
  return db;
}

const baseInput = {
  auth: auth(),
  category: "faq",
  confidence: 0.95,
  sourceIds: ["kb-ok"] as string[],
  ticketStatus: "new" as const,
  ticketReopened: false,
  slaCritical: false,
  sensitiveData: false,
};

describe("gate determinístico de autoenvio (SPEC 5.2)", () => {
  beforeEach(() => {
    closeDb();
    process.env.DB_PATH = ":memory:";
    initDb();
    seedAi();
  });

  it("todas as condições true → auto_send (R1, FAQ global aprovada)", () => {
    // ativa opt-in e política p/ tenant a
    getDb()
      .prepare("UPDATE tenants SET automation_opt_in = 1 WHERE id = 'a'")
      .run();
    const result = evaluateAutoSend(baseInput);
    expect(result.decision).toBe("auto_send");
    expect(result.blockedReasons).toEqual([]);
  });

  it("sem opt-in do tenant → bloqueado (fail-closed)", () => {
    const result = evaluateAutoSend(baseInput);
    expect(result.decision).not.toBe("auto_send");
    expect(result.blockedReasons).toContain("tenant_opt_in");
  });

  it("kill switch global → bloqueia mesmo com tudo ok", () => {
    const db = getDb();
    db.prepare("UPDATE tenants SET automation_opt_in = 1 WHERE id = 'a'").run();
    db.prepare(
      "INSERT INTO automation_policies (id, scope, enabled) VALUES ('ap-global', 'global', 0)",
    ).run(); // switch engajado
    const result = evaluateAutoSend(baseInput);
    expect(result.decision).not.toBe("auto_send");
    expect(result.blockedReasons).toContain("global_kill_switch");
  });

  it("kill switch do tenant → bloqueia", () => {
    const db = getDb();
    db.prepare("UPDATE tenants SET automation_opt_in = 1 WHERE id = 'a'").run();
    db.prepare(
      "INSERT INTO automation_policies (id, scope, tenant_id, enabled) VALUES ('ap-a', 'tenant', 'a', 0)",
    ).run();
    const result = evaluateAutoSend(baseInput);
    expect(result.decision).not.toBe("auto_send");
    expect(result.blockedReasons).toContain("tenant_kill_switch");
  });

  it("confiança < 0.90 → bloqueado", () => {
    getDb()
      .prepare("UPDATE tenants SET automation_opt_in = 1 WHERE id = 'a'")
      .run();
    const result = evaluateAutoSend({ ...baseInput, confidence: 0.89 });
    expect(result.decision).not.toBe("auto_send");
    expect(result.blockedReasons).toContain("confidence_below_threshold");
  });

  it("fonte não aprovada/revogada → bloqueado", () => {
    getDb()
      .prepare("UPDATE tenants SET automation_opt_in = 1 WHERE id = 'a'")
      .run();
    const result = evaluateAutoSend({
      ...baseInput,
      sourceIds: ["kb-tenant-b"], // KB de outro tenant
    });
    expect(result.decision).not.toBe("auto_send");
    expect(result.blockedReasons).toContain("source_not_approved");
  });

  it("categoria fora da allowlist (mas não R3) → bloqueado", () => {
    getDb()
      .prepare("UPDATE tenants SET automation_opt_in = 1 WHERE id = 'a'")
      .run();
    const result = evaluateAutoSend({
      ...baseInput,
      category: "suporte-avancado",
    });
    expect(result.decision).not.toBe("auto_send");
    expect(result.blockedReasons).toContain("category_not_allowlisted");
  });

  it("ticket reaberto → bloqueado sempre", () => {
    getDb()
      .prepare("UPDATE tenants SET automation_opt_in = 1 WHERE id = 'a'")
      .run();
    const result = evaluateAutoSend({ ...baseInput, ticketReopened: true });
    expect(result.decision).not.toBe("auto_send");
    expect(result.blockedReasons).toContain("ticket_reopened");
  });

  it("SLA crítico → bloqueado sempre", () => {
    getDb()
      .prepare("UPDATE tenants SET automation_opt_in = 1 WHERE id = 'a'")
      .run();
    const result = evaluateAutoSend({ ...baseInput, slaCritical: true });
    expect(result.decision).not.toBe("auto_send");
    expect(result.blockedReasons).toContain("sla_critical");
  });

  it("categoria sensível (R3) → bloqueado sempre (financeiro/acesso/incidente/reclamação/LGPD)", () => {
    getDb()
      .prepare("UPDATE tenants SET automation_opt_in = 1 WHERE id = 'a'")
      .run();
    for (const category of [
      "financeiro",
      "acesso",
      "incidente",
      "reclamacao",
      "lgpd",
    ]) {
      const result = evaluateAutoSend({ ...baseInput, category });
      expect(result.decision, `categoria ${category}`).not.toBe("auto_send");
      expect(result.blockedReasons).toContain("risk_r3");
    }
  });

  it("dados sensíveis no conteúdo → bloqueado", () => {
    getDb()
      .prepare("UPDATE tenants SET automation_opt_in = 1 WHERE id = 'a'")
      .run();
    const result = evaluateAutoSend({ ...baseInput, sensitiveData: true });
    expect(result.decision).not.toBe("auto_send");
    expect(result.blockedReasons).toContain("sensitive_data");
  });

  it("decisão é registrada em automation_runs + audit_events", () => {
    const db = getDb();
    db.prepare("UPDATE tenants SET automation_opt_in = 1 WHERE id = 'a'").run();
    db.prepare(
      `INSERT INTO tickets (id, tenant_id, source, status, priority, subject, description, requester_ref, created_by)
       VALUES ('tk-real', 'a', 'portal', 'new', 'P3', 's', 'd', 'uid-agent', 'uid-agent')`,
    ).run();
    const result = evaluateAutoSend({ ...baseInput, ticketId: "tk-real" });
    expect(result.runId).toBeDefined();
    const run = getDb()
      .prepare(
        "SELECT decision, classification, confidence FROM automation_runs WHERE id = ?",
      )
      .get(result.runId!) as {
      decision: string;
      classification: string;
      confidence: number;
    };
    expect(run.decision).toBe(result.decision);
    expect(run.classification).toBe("R1");
    const audit = getDb()
      .prepare(
        "SELECT COUNT(*) c FROM audit_events WHERE action = 'ai.evaluated'",
      )
      .get() as { c: number };
    expect(audit.c).toBeGreaterThanOrEqual(1);
  });

  it("sem tenant na auth → no_tenant_scope + tenant_not_found", () => {
    const result = evaluateAutoSend({
      ...baseInput,
      auth: auth({
        tenantId: null,
        globalOperator: true,
        role: "global_operator",
      }),
    });
    expect(result.decision).not.toBe("auto_send");
    expect(result.blockedReasons).toContain("no_tenant_scope");
    expect(result.blockedReasons).toContain("tenant_not_found");
  });

  it("tenant inexistente no banco → tenant_not_found", () => {
    const result = evaluateAutoSend({
      ...baseInput,
      auth: auth({ tenantId: "ghost" }),
    });
    expect(result.blockedReasons).toContain("tenant_not_found");
  });

  it("kill switch no registro do tenant → tenant_kill_switch", () => {
    getDb()
      .prepare(
        "UPDATE tenants SET automation_opt_in = 1, automation_kill_switch = 1 WHERE id = 'a'",
      )
      .run();
    const result = evaluateAutoSend(baseInput);
    expect(result.blockedReasons).toContain("tenant_kill_switch");
  });

  it("suggestAiResponse sempre exige revisão humana e nunca auto_send", () => {
    getDb()
      .prepare("UPDATE tenants SET automation_opt_in = 1 WHERE id = 'a'")
      .run();
    const result = suggestAiResponse({
      auth: auth(),
      draft: "texto sugerido",
      confidence: 0.99,
      category: "faq",
    });
    expect(result.requiresHumanReview).toBe(true);
    expect(result.decision).toBe("draft");
    expect(result.suggestion).toBe("texto sugerido");
    expect(result.blockedReasons.length).toBeGreaterThan(0);
  });

  it("suggestAiResponse com categoria R3 → decision blocked", () => {
    const result = suggestAiResponse({
      auth: auth(),
      draft: "não enviar",
      confidence: 0.99,
      category: "financeiro",
    });
    expect(result.decision).toBe("blocked");
    expect(result.blockedReasons).toContain("risk_r3");
  });
});
