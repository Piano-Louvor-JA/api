/**
 * X-Partner-Key opcional (.planning/partner-keys/SPEC.md).
 *
 * - Sem header: nada muda (app/web/APK não enviam).
 * - Token ativo: c.get("partner") = { id, name } + métrica por parceiro.
 * - Token desconhecido/revogado: 401. Só atinge quem envia o header.
 * - Erro interno no lookup: deixa passar sem parceiro — middleware não pode
 *   derrubar tráfego legítimo (AGENTS.md).
 */

import { createMiddleware } from "hono/factory";
import { findPartnerByKey, type Partner } from "../lib/partnerKeys.js";
import { incPartnerRequest } from "./metrics.js";

export type PartnerEnv = {
  Variables: {
    partner?: Partner;
  };
};

export const PARTNER_KEY_HEADER = "X-Partner-Key";

export const partnerKey = createMiddleware<PartnerEnv>(async (c, next) => {
  const key = c.req.header(PARTNER_KEY_HEADER);
  if (key === undefined) return next();

  let partner: Partner | null;
  try {
    partner = findPartnerByKey(key.trim());
  } catch (err) {
    console.error(
      "[piano-api] partnerKey lookup falhou:",
      err instanceof Error ? err.message : err,
    );
    return next();
  }

  if (!partner) return c.json({ error: "Invalid partner key" }, 401);

  c.set("partner", partner);
  incPartnerRequest(partner.name);
  return next();
});
