/**
 * central-tickets B1 — KB: artigos globais PIANO (tenant_id NULL) +
 * artigos do próprio tenant. Tenant alheio nunca é retornado.
 */
import { OpenAPIHono, z } from "@hono/zod-openapi";
import { getDb } from "../../db/connection.js";
import {
  requireTicketRole,
  type TicketsEnv,
  ticketsAuth,
} from "./auth.middleware.js";

const app = new OpenAPIHono<TicketsEnv>();
app.use("*", ticketsAuth);

app.get("/", requireTicketRole("client"), (c) => {
  const u = c.get("ticketsUser");
  const rows = getDb()
    .prepare(
      `SELECT id, tenant_id, slug, title, updated_at FROM tickets_kb_articles
       WHERE status = 'published' AND (tenant_id = ? OR tenant_id IS NULL)
       ORDER BY tenant_id NULLS LAST, title`,
    )
    .all(u.tenantId);
  return c.json({ items: rows });
});

app.get("/:slug", requireTicketRole("client"), (c) => {
  const u = c.get("ticketsUser");
  const row = getDb()
    .prepare(
      `SELECT * FROM tickets_kb_articles
       WHERE slug = ? AND status = 'published' AND (tenant_id = ? OR tenant_id IS NULL)`,
    )
    .get(c.req.param("slug"), u.tenantId) as
    | Record<string, unknown>
    | undefined;
  if (!row) return c.json({ error: "Not Found" }, 404);
  return c.json(row);
});

// gestão de artigos: agent+
app.post("/", requireTicketRole("agent"), async (c) => {
  const u = c.get("ticketsUser");
  const body = z
    .object({
      scope: z.enum(["global", "tenant"]).default("tenant"),
      slug: z.string().min(2).max(120),
      title: z.string().min(2).max(200),
      body: z.string().min(1).max(20000),
      status: z.enum(["draft", "published"]).default("draft"),
    })
    .parse(await c.req.json());
  try {
    const info = getDb()
      .prepare(
        "INSERT INTO tickets_kb_articles (tenant_id, slug, title, body, status) VALUES (?,?,?,?,?)",
      )
      .run(
        body.scope === "global" ? null : u.tenantId,
        body.slug,
        body.title,
        body.body,
        body.status,
      );
    return c.json({ id: Number(info.lastInsertRowid) }, 201);
  } catch {
    return c.json({ error: "Slug duplicado" }, 409);
  }
});

export default app;
