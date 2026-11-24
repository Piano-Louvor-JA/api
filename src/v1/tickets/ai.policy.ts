/**
 * central-tickets B1.1 — política de autoenvio IA (SPEC-B1.1 §6.2, SPEC pai L136).
 * Pura e fail-closed: qualquer sinal ausente/erro → false (fila humana).
 */
import { getDb } from "../../db/connection.js";
import { audit } from "./audit.service.js";

export type AutoSendSignals = {
  tenantOptIn: boolean;
  globalKill: boolean;
  tenantKill: boolean;
  risk: "R0" | "R1" | "R2" | "R3";
  reopened: boolean;
  slaCritical: boolean;
  categoryAllowlisted: boolean;
  confidence: number;
  approvedSourcesOnly: boolean;
  noSensitiveData: boolean;
};

const MIN_CONFIDENCE = 0.9;

export function autoSendEligible(s: AutoSendSignals): boolean {
  return (
    s.tenantOptIn &&
    !s.globalKill &&
    !s.tenantKill &&
    (s.risk === "R0" || s.risk === "R1") &&
    !s.reopened &&
    !s.slaCritical &&
    s.categoryAllowlisted &&
    s.confidence >= MIN_CONFIDENCE &&
    s.approvedSourcesOnly &&
    s.noSensitiveData
  );
}

/**
 * Enqueue determinístico: candidatos autoenviáveis + auditoria de cada decisão.
 * Envio real é stub (v1 sem provedor). Retorna total enfileirado (0 se kill on).
 */
export function enqueueAutoReplies(): { enqueued: number; humanQueue: number } {
  const db = getDb();
  const globalKill =
    (
      db
        .prepare("SELECT enabled FROM tickets_global_switch WHERE id = 1")
        .get() as { enabled: number } | undefined
    )?.enabled === 1;
  if (globalKill) {
    audit({
      tenantId: "public",
      action: "ai_decision",
      entityType: "queue",
      metadata: { enqueued: 0, reason: "kill_switch_global_on" },
    });
    return { enqueued: 0, humanQueue: 0 };
  }
  // v1 sem provedor externo: sem sinais de confiança disponíveis, tudo fila humana
  audit({
    tenantId: "public",
    action: "ai_decision",
    entityType: "queue",
    metadata: { enqueued: 0, reason: "no_provider_fail_closed" },
  });
  return { enqueued: 0, humanQueue: 0 };
}
