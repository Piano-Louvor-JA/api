/**
 * SPEC piano-admin-panel v1.1.0 (RF-01): rotas de gestão (UI do painel).
 * Todas atrás do adminAuth (fail-closed; allowlist ADMIN_EMAILS).
 *
 * /v1/custom/admin/seasonal-events  GET/POST/PUT/DELETE — CRUD de eventos
 *   sazonais (multiplicador do ranking).
 * /v1/custom/admin/weekly-tasks     GET/PUT — pool de tasks semanais
 *   (tabela weekly_task_defs; substitui o pool ativo).
 *
 * RF-05: cada mutação loga no console com e-mail do admin (auditoria mínima).
 *
 * Exporta registerAdminRoutes(router) — chamado pelo custom.routes no fim
 * (evita import circular com o router privado).
 */

import type { OpenAPIHono } from "@hono/zod-openapi";
import { createRoute, z } from "@hono/zod-openapi";

import { getDb } from "../../db/connection.js";
import { type AdminEnv, adminAuth } from "./admin.middleware.js";
import { activeTaskDefs, type WeeklyTaskDef } from "./weekly-tasks.service.js";

// ============================================
// Schemas
// ============================================

const SeasonalEventSchema = z.object({
  id: z.number(),
  name: z.string(),
  description: z.string().nullable(),
  multiplier: z.number(),
  starts_at: z.string(),
  ends_at: z.string(),
  active: z.boolean(),
});

const SeasonalEventInputSchema = z.object({
  name: z.string().min(1).max(120),
  description: z.string().max(500).nullable().optional(),
  multiplier: z.number().min(1.0),
  starts_at: z.string().min(10),
  ends_at: z.string().min(10),
  active: z.boolean().optional(),
});

const WeeklyTaskDefSchema = z.object({
  id: z.string().min(1).max(60),
  description: z.string().min(1).max(200),
  active: z.boolean().optional(),
});

const WeeklyTaskPoolSchema = z.object({
  tasks: z.array(WeeklyTaskDefSchema).min(3).max(20),
});

// ============================================
// Helpers
// ============================================

type EventRow = {
  id: number;
  name: string;
  description: string | null;
  multiplier: number;
  starts_at: string;
  ends_at: string;
  active: number;
};

function rowToEvent(r: EventRow) {
  return { ...r, active: r.active === 1 };
}

function audit(email: string, action: string, detail: string): void {
  console.log(`[admin] ${email} → ${action}: ${detail}`);
}

// ============================================
// Registro
// ============================================

export function registerAdminRoutes(
  customRoutes: OpenAPIHono<AdminEnv & { Variables: { tenantId: string } }>,
): void {
  // ---- Seasonal events: GET (lista todas, inclusive inativas/expiradas) ----
  const listEventsRoute = createRoute({
    method: "get",
    path: "/admin/seasonal-events",
    tags: ["custom"],
    description: "Admin: lista TODOS os eventos sazonais (inclusive inativos)",
    middleware: [adminAuth] as const,
    responses: {
      200: {
        content: {
          "application/json": {
            schema: z.object({ data: z.array(SeasonalEventSchema) }),
          },
        },
        description: "Lista completa",
      },
    },
  });

  customRoutes.openapi(listEventsRoute, (c) => {
    const db = getDb();
    const rows = db
      .prepare(
        `SELECT id, name, description, multiplier, starts_at, ends_at, active
         FROM seasonal_events WHERE tenant_id = ? ORDER BY starts_at DESC`,
      )
      .all(c.get("tenantId")) as EventRow[];
    return c.json({ data: rows.map(rowToEvent) }, 200);
  });

  // ---- Seasonal events: POST ----
  const createEventRoute = createRoute({
    method: "post",
    path: "/admin/seasonal-events",
    tags: ["custom"],
    description: "Admin: cria evento sazonal",
    middleware: [adminAuth] as const,
    request: {
      body: {
        content: { "application/json": { schema: SeasonalEventInputSchema } },
      },
    },
    responses: {
      201: {
        content: { "application/json": { schema: SeasonalEventSchema } },
        description: "Criado",
      },
      400: { description: "Datas invertidas ou payload inválido" },
    },
  });

  customRoutes.openapi(createEventRoute, (c) => {
    const body = c.req.valid("json") as z.infer<
      typeof SeasonalEventInputSchema
    >;
    if (new Date(body.ends_at) <= new Date(body.starts_at)) {
      return c.json({ error: "ends_at deve ser posterior a starts_at" }, 400);
    }
    const db = getDb();
    const user = c.get("user")!;
    const r = db
      .prepare(
        `INSERT INTO seasonal_events (name, description, multiplier, starts_at, ends_at, active, tenant_id)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        body.name,
        body.description ?? null,
        body.multiplier,
        body.starts_at,
        body.ends_at,
        body.active === false ? 0 : 1,
        c.get("tenantId"),
      );
    const id = Number(r.lastInsertRowid);
    audit(user.email, "seasonal-event.create", `id=${id} name=${body.name}`);
    const row = db
      .prepare(`SELECT * FROM seasonal_events WHERE id = ?`)
      .get(id) as EventRow;
    return c.json(rowToEvent(row), 201);
  });

  // ---- Seasonal events: PUT ----
  const updateEventRoute = createRoute({
    method: "put",
    path: "/admin/seasonal-events/{id}",
    tags: ["custom"],
    description: "Admin: atualiza evento sazonal",
    middleware: [adminAuth] as const,
    request: {
      params: z.object({ id: z.string() }),
      body: {
        content: { "application/json": { schema: SeasonalEventInputSchema } },
      },
    },
    responses: {
      200: {
        content: { "application/json": { schema: SeasonalEventSchema } },
        description: "Atualizado",
      },
      404: { description: "Evento não encontrado" },
      400: { description: "Payload inválido" },
    },
  });

  customRoutes.openapi(updateEventRoute, (c) => {
    const { id } = c.req.valid("param");
    const body = c.req.valid("json") as z.infer<
      typeof SeasonalEventInputSchema
    >;
    if (new Date(body.ends_at) <= new Date(body.starts_at)) {
      return c.json({ error: "ends_at deve ser posterior a starts_at" }, 400);
    }
    const db = getDb();
    const user = c.get("user")!;
    const r = db
      .prepare(
        `UPDATE seasonal_events
       SET name = ?, description = ?, multiplier = ?, starts_at = ?, ends_at = ?, active = ?
       WHERE id = ? AND tenant_id = ?`,
      )
      .run(
        body.name,
        body.description ?? null,
        body.multiplier,
        body.starts_at,
        body.ends_at,
        body.active === false ? 0 : 1,
        parseInt(id, 10),
        c.get("tenantId"),
      );
    if (r.changes === 0) {
      return c.json({ error: "Evento não encontrado" }, 404);
    }
    audit(user.email, "seasonal-event.update", `id=${id} name=${body.name}`);
    const row = db
      .prepare(`SELECT * FROM seasonal_events WHERE id = ?`)
      .get(parseInt(id, 10)) as EventRow;
    return c.json(rowToEvent(row), 200);
  });

  // ---- Seasonal events: DELETE (soft — histórico preservado) ----
  const deleteEventRoute = createRoute({
    method: "delete",
    path: "/admin/seasonal-events/{id}",
    tags: ["custom"],
    description: "Admin: desativa evento sazonal (soft; histórico preservado)",
    middleware: [adminAuth] as const,
    request: {
      params: z.object({ id: z.string() }),
    },
    responses: {
      200: {
        content: {
          "application/json": { schema: z.object({ success: z.boolean() }) },
        },
        description: "Desativado",
      },
      404: { description: "Evento não encontrado" },
    },
  });

  customRoutes.openapi(deleteEventRoute, (c) => {
    const { id } = c.req.valid("param");
    const db = getDb();
    const user = c.get("user")!;
    const r = db
      .prepare(
        `UPDATE seasonal_events SET active = 0 WHERE id = ? AND tenant_id = ?`,
      )
      .run(parseInt(id, 10), c.get("tenantId"));
    if (r.changes === 0) {
      return c.json({ error: "Evento não encontrado" }, 404);
    }
    audit(user.email, "seasonal-event.deactivate", `id=${id}`);
    return c.json({ success: true }, 200);
  });

  // ---- Weekly tasks pool: GET ----
  const listTasksRoute = createRoute({
    method: "get",
    path: "/admin/weekly-tasks",
    tags: ["custom"],
    description: "Admin: pool ativo de tasks semanais",
    middleware: [adminAuth] as const,
    responses: {
      200: {
        content: {
          "application/json": {
            schema: z.object({ data: z.array(WeeklyTaskDefSchema) }),
          },
        },
        description: "Pool ativo",
      },
    },
  });

  customRoutes.openapi(listTasksRoute, (c) => {
    const db = getDb();
    const rows = activeTaskDefs(db);
    return c.json({ data: rows }, 200);
  });

  // ---- Weekly tasks pool: PUT (substitui o pool ativo) ----
  const putTasksRoute = createRoute({
    method: "put",
    path: "/admin/weekly-tasks",
    tags: ["custom"],
    description:
      "Admin: substitui o pool de tasks semanais (desativa antigas, insere novas)",
    middleware: [adminAuth] as const,
    request: {
      body: {
        content: { "application/json": { schema: WeeklyTaskPoolSchema } },
      },
    },
    responses: {
      200: {
        content: {
          "application/json": {
            schema: z.object({ data: z.array(WeeklyTaskDefSchema) }),
          },
        },
        description: "Pool atualizado",
      },
    },
  });

  customRoutes.openapi(putTasksRoute, (c) => {
    const body = c.req.valid("json") as {
      tasks: Array<{ id: string; description: string; active?: boolean }>;
    };
    const db = getDb();
    const user = c.get("user")!;

    const insert = db.prepare(
      `INSERT OR REPLACE INTO weekly_task_defs (id, description, active, sort_order) VALUES (?, ?, ?, ?)`,
    );
    const deactivateAll = db.prepare(`UPDATE weekly_task_defs SET active = 0`);

    const tx = db.transaction(() => {
      deactivateAll.run();
      body.tasks.forEach((t, i) => {
        insert.run(t.id, t.description, t.active === false ? 0 : 1, i);
      });
    });
    tx();

    audit(
      user.email,
      "weekly-tasks.replace",
      `count=${body.tasks.length} ids=${body.tasks.map((t) => t.id).join(",")}`,
    );
    const rows = activeTaskDefs(db) as WeeklyTaskDef[];
    return c.json({ data: rows }, 200);
  });
}
