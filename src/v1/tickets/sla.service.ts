/**
 * central-tickets B1 — SLA: janela útil 08:00–18:00 America/Sao_Paulo, seg–sex.
 * P1 1h/4h · P2 4h/12h · P3 12h/48h · P4 24h/120h (tabela tickets_sla_policy).
 */
import { getDb } from "../../db/connection.js";

const OPEN_H = 8;
const CLOSE_H = 18;

/** Offset -03:00 (America/Sao_Paulo, sem DST desde 2019). */
function saoPauloNow(now = new Date()): Date {
  return new Date(now.getTime() - 3 * 3600_000);
}

type Parts = { y: number; m: number; d: number; h: number; min: number };

function parts(dt: Date): Parts {
  return {
    y: dt.getUTCFullYear(),
    m: dt.getUTCMonth() + 1,
    d: dt.getUTCDate(),
    h: dt.getUTCHours(),
    min: dt.getUTCMinutes(),
  };
}

/** Soma `hours` úteis a `from` (UTC ISO), pulando fora-da-janela/fim-de-semana. */
export function addBusinessHours(fromIso: string, hours: number): string {
  let dt = new Date(new Date(fromIso).getTime() - 3 * 3600_000); // SP wall clock (UTC-3)
  let remaining = hours * 60;
  // guard: máx 60 iterações/dia
  for (let guard = 0; guard < 400 && remaining > 0; guard++) {
    const p = parts(dt);
    const dow = dt.getUTCDay(); // 0 dom .. 6 sáb
    const inWindow = dow >= 1 && dow <= 5 && p.h >= OPEN_H && p.h < CLOSE_H;
    if (inWindow) {
      // minutos até fechamento
      const untilClose = (CLOSE_H - p.h) * 60 - p.min;
      const step = Math.min(remaining, untilClose);
      dt = new Date(dt.getTime() + step * 60_000);
      remaining -= step;
      if (remaining > 0) dt = nextOpen(dt);
    } else {
      dt = nextOpen(dt);
    }
  }
  return new Date(dt.getTime() + 3 * 3600_000).toISOString();
}

function fromIsos(iso: string): Date {
  return new Date(iso);
}

/** Avança para 08:00 do próximo dia útil (wall clock SP já shiftado). */
function nextOpen(dt: Date): Date {
  const p = parts(dt);
  let d = new Date(Date.UTC(p.y, p.m - 1, p.d, OPEN_H, 0, 0));
  // se hoje ainda abre (antes das 8 em dia útil), volta para hoje 08:00
  if (d.getTime() > dt.getTime()) {
    const dow = d.getUTCDay();
    if (dow === 0) d = new Date(d.getTime() + 24 * 3600_000);
    if (d.getUTCDay() === 6) d = new Date(d.getTime() + 48 * 3600_000);
    return d;
  }
  // senão próximo dia útil
  do {
    d = new Date(d.getTime() + 24 * 3600_000);
  } while (d.getUTCDay() === 0 || d.getUTCDay() === 6);
  return d;
}

export function slaFor(
  tenantId: string,
  priority: string,
): { first_response_hours: number; resolve_hours: number } {
  const db = getDb();
  const row = db
    .prepare(
      `SELECT first_response_hours, resolve_hours FROM tickets_sla_policy
       WHERE priority = ? AND (tenant_id = ? OR tenant_id IS NULL)
       ORDER BY tenant_id NULLS LAST LIMIT 1`,
    )
    .get(priority, tenantId) as
    | { first_response_hours: number; resolve_hours: number }
    | undefined;
  return row ?? { first_response_hours: 24, resolve_hours: 120 };
}

/** Due dates de criação de ticket. */
export function computeDueDates(
  tenantId: string,
  priority: string,
  nowIso: string,
): { firstResponseDue: string; resolveDue: string } {
  const sla = slaFor(tenantId, priority);
  return {
    firstResponseDue: addBusinessHours(nowIso, sla.first_response_hours),
    resolveDue: addBusinessHours(nowIso, sla.resolve_hours),
  };
}
