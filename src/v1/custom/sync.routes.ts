/**
 * POST /v1/custom/sync — batch LWW (gauntlet P3).
 * Rota procedural (não openapi route) — payload é grande e o contrato vive
 * documentado em .planning/gauntlet/SYNC_API.md (B16).
 */
import { Hono } from "hono";
import type { TenantEnv } from "../../middleware/tenant.middleware.js";
import type { CustomAuthEnv } from "./auth.middleware.js";
import { requireSyncAuth, runSync, SyncRequestSchema } from "./sync.service.js";

export const syncRoutes = new Hono<CustomAuthEnv & TenantEnv>();

syncRoutes.use("/sync", requireSyncAuth);

syncRoutes.post("/sync", async (c) => {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    return c.json({ error: "JSON inválido" }, 400);
  }

  const parsed = SyncRequestSchema.safeParse(raw);
  if (!parsed.success) {
    return c.json(
      { error: "Payload inválido", details: parsed.error.issues.slice(0, 10) },
      400,
    );
  }

  try {
    const user = c.get("user") as { id_user: number };
    const result = runSync(user.id_user, parsed.data, c.get("tenantId"));
    return c.json(result, 200);
  } catch (error) {
    console.error("[sync] erro:", error);
    return c.json({ error: "Erro interno no sync" }, 500);
  }
});
