// B1 — Política IA fail-closed (SPEC RF-07, §5.2) e kill switches (RF-08).
//
// auto_send = tenant_opt_in AND global_kill_off AND tenant_kill_off AND
//   category_allowlisted AND confidence >= threshold AND approved_sources_only
//   AND no_sensitive_data AND risk in {R0,R1} AND not_sla_critical AND not_reopened
//
// Qualquer sinal ausente, erro ou incerteza → NÃO envio (fail-closed) + fila humana.
// v1 (BD-07): R1 = FAQ global PIANO aprovada; limiar 0.90; opt-in por tenant.
import { randomUUID } from "node:crypto";
import { getDb } from "../../db/connection.js";
import type { TicketsAuth } from "./tickets.auth.js";

export const R3_CATEGORIES = new Set([
  "financeiro",
  "acesso",
  "incidente",
  "reclamacao",
  "lgpd",
]);

/** Allowlist R1 v1 (BD-07): somente FAQ global aprovada. */
export const R1_ALLOWLIST = new Set(["faq"]);

export const CONFIDENCE_THRESHOLD = 0.9;

export interface AutoSendInput {
  auth: TicketsAuth;
  category: string;
  confidence: number;
  sourceIds: string[];
  ticketId?: string;
  ticketStatus?: string;
  ticketReopened?: boolean;
  slaCritical?: boolean;
  sensitiveData?: boolean;
}

export interface AutoSendDecision {
  decision: "auto_send" | "draft" | "blocked";
  blockedReasons: string[];
  classification: "R0" | "R1" | "R2" | "R3";
  runId: string;
}

interface PolicyRow {
  id: string;
  scope: "global" | "tenant";
  tenant_id: string | null;
  allowlist: string;
  confidence_threshold: number;
  enabled: number;
}

function loadPolicies(tenantId: string | null): {
  global?: PolicyRow;
  tenant?: PolicyRow;
} {
  const db = getDb();
  const rows = db
    .prepare(
      "SELECT id, scope, tenant_id, allowlist, confidence_threshold, enabled FROM automation_policies",
    )
    .all() as PolicyRow[];
  return {
    global: rows.find((r) => r.scope === "global"),
    tenant: tenantId
      ? rows.find((r) => r.scope === "tenant" && r.tenant_id === tenantId)
      : undefined,
  };
}

/** Fontes elegíveis: global aprovada não revogada, ou do PRÓPRIO tenant aprovada. */
function loadApprovedSourceIds(tenantId: string | null): Set<string> {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT id, scope, tenant_id FROM knowledge_sources
       WHERE approved_for_auto_send = 1 AND revoked = 0`,
    )
    .all() as { id: string; scope: string; tenant_id: string | null }[];
  const eligible = rows.filter(
    (r) =>
      r.scope === "global" || (tenantId !== null && r.tenant_id === tenantId),
  );
  return new Set(eligible.map((r) => r.id));
}

function auditRun(
  action: string,
  tenantId: string | null,
  actor: string,
  target: string | null,
  after: unknown,
): void {
  getDb()
    .prepare(
      `INSERT INTO audit_events (tenant_id, actor, action, target, after_json)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(tenantId, actor, action, target, JSON.stringify(after));
}

/** Avalia o gate determinístico. Sempre registra automation_runs + audit. */
export function evaluateAutoSend(input: AutoSendInput): AutoSendDecision {
  const db = getDb();
  const tenantId = input.auth.tenantId;
  const reasons: string[] = [];

  // fail-closed: sem tenant resolvível, sem envio
  if (!tenantId) reasons.push("no_tenant_scope");

  const tenant = tenantId
    ? (db
        .prepare(
          "SELECT automation_opt_in, automation_kill_switch FROM tenants WHERE id = ?",
        )
        .get(tenantId) as
        | { automation_opt_in: number; automation_kill_switch: number }
        | undefined)
    : undefined;

  if (!tenant) {
    reasons.push("tenant_not_found");
  } else {
    if (tenant.automation_opt_in !== 1) reasons.push("tenant_opt_in");
    if (tenant.automation_kill_switch === 1) reasons.push("tenant_kill_switch");
  }

  const { global: globalPolicy, tenant: tenantPolicy } = loadPolicies(tenantId);
  // kill switch global: switch explícito — engajado somente quando existe
  // política global com enabled=0. Row ausente = switch desengaged (o
  // enablement real é o opt-in do tenant, default off).
  if (globalPolicy && globalPolicy.enabled === 0) {
    reasons.push("global_kill_switch");
  }
  if (tenantPolicy && tenantPolicy.enabled === 0) {
    reasons.push("tenant_kill_switch");
  }

  // classificação de risco
  let classification: "R0" | "R1" | "R2" | "R3" = "R1";
  if (R3_CATEGORIES.has(input.category)) {
    classification = "R3";
    reasons.push("risk_r3");
  } else if (!R1_ALLOWLIST.has(input.category)) {
    classification = "R2";
    reasons.push("category_not_allowlisted");
  }

  const threshold =
    tenantPolicy?.confidence_threshold ??
    globalPolicy?.confidence_threshold ??
    CONFIDENCE_THRESHOLD;
  if (input.confidence < threshold) {
    reasons.push("confidence_below_threshold");
  }

  const approved = loadApprovedSourceIds(tenantId);
  if (
    input.sourceIds.length === 0 ||
    input.sourceIds.some((s) => !approved.has(s))
  ) {
    reasons.push("source_not_approved");
  }

  if (input.sensitiveData) reasons.push("sensitive_data");
  if (input.slaCritical) reasons.push("sla_critical");
  if (input.ticketReopened) reasons.push("ticket_reopened");

  const decision: AutoSendDecision["decision"] =
    reasons.length === 0
      ? "auto_send"
      : classification === "R3"
        ? "blocked"
        : "draft";

  // registro imutável da decisão (RF-09)
  const runId = randomUUID();
  db.prepare(
    `INSERT INTO automation_runs (id, ticket_id, tenant_id, model, classification, confidence, sources_json, decision, blocked_reasons, output_ref)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
  ).run(
    runId,
    input.ticketId ?? null,
    tenantId ?? "",
    "policy-gate-v1",
    classification,
    input.confidence,
    JSON.stringify(input.sourceIds),
    decision,
    JSON.stringify(reasons),
  );
  auditRun("ai.evaluated", tenantId, input.auth.uid, input.ticketId ?? null, {
    runId,
    decision,
    classification,
    blockedReasons: reasons,
  });

  return { decision, blockedReasons: reasons, classification, runId };
}

/** Wrapper para a rota de sugestão: sempre rascunho para revisão humana;
 *  autoenvio somente via evaluateAutoSend com todos os gates. */
export function suggestAiResponse(input: {
  auth: TicketsAuth;
  draft: string;
  confidence: number;
  category: string;
  ticketId?: string;
}): {
  suggestion: string;
  decision: "draft" | "auto_send" | "blocked";
  blockedReasons: string[];
  requiresHumanReview: boolean;
  runId: string;
} {
  const evaluation = evaluateAutoSend({
    auth: input.auth,
    category: input.category,
    confidence: input.confidence,
    sourceIds: [], // sugestão da rota não cita fontes → sempre draft (fail-closed)
    ticketId: input.ticketId,
  });
  return {
    suggestion: input.draft,
    decision:
      evaluation.decision === "auto_send" ? "draft" : evaluation.decision,
    blockedReasons: evaluation.blockedReasons,
    requiresHumanReview: true, // v1: toda sugestão exige revisão humana (RF-07)
    runId: evaluation.runId,
  };
}
