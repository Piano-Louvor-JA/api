import type { MiddlewareHandler } from "hono";
import { getDb } from "../db/connection.js";

export type TenantEnv = { Variables: { tenantId: string } };

let validTenants: string[] | undefined;

export const tenantMiddleware: MiddlewareHandler<TenantEnv> = async (
  c,
  next,
) => {
  const tenantId = c.req.header("X-Tenant") ?? "piano";
  validTenants ??= (
    getDb().prepare("SELECT id FROM tenants ORDER BY id").all() as {
      id: string;
    }[]
  ).map(({ id }) => id);

  if (!validTenants.includes(tenantId)) {
    return c.json(
      { error: "Invalid tenant", valid_tenants: validTenants },
      400,
    );
  }

  c.set("tenantId", tenantId);
  c.res.headers.set("X-Tenant", tenantId);
  await next();
};

export function resetTenantCacheForTests(): void {
  validTenants = undefined;
}
