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
import {
  AdminCollectionsListResponseSchema,
  AdminMusicsListResponseSchema,
} from "./custom.schemas.js";
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

// SPEC admin-conteudo-global v1.1.0 (D2/D3): shape das rows admin
type AdminCollectionRow = {
  id_collection: number;
  name: string;
  description: string | null;
  cover_url: string | null;
  visibility: "public" | "private";
  owner_id: number | null;
  author_name: string | null;
  owner_name: string | null;
  musics_count: number;
  created_at: string;
  updated_at: string;
};

type AdminMusicRow = {
  id_music: number;
  id_collection: number;
  name: string | null;
  lyric: string | null;
  auxiliary_lyric: string | null;
  id_file_audio: number | null;
  id_file_instrumental: number | null;
  id_file_image: number | null;
  duration: number | null;
  official_music_id: number | null;
  owner_id: number | null;
  client_uuid: string | null;
  created_at: string;
  updated_at: string;
  owner_name: string | null;
  collection_name: string;
  collection_visibility: "public" | "private";
  audio_url: string | null;
  instrumental_url: string | null;
  image_url: string | null;
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

  // ---- Admin conteúdo global (SPEC admin-conteudo-global v1.1.0) ----
  // RF-01: TODAS as coletâneas (sem filtro de visibilidade) + owner_name
  // via LEFT JOIN custom_users.display_name. Leitura pura (D5, sem audit).
  const listAdminCollectionsRoute = createRoute({
    method: "get",
    path: "/admin/collections",
    tags: ["custom"],
    description:
      "Admin: lista TODAS as coletâneas (públicas + privadas de qualquer dono) com owner_name",
    middleware: [adminAuth] as const,
    responses: {
      200: {
        content: {
          "application/json": {
            schema: AdminCollectionsListResponseSchema,
          },
        },
        description: "Lista global com meta de paginação",
      },
      401: {
        content: {
          "application/json": { schema: z.object({ error: z.string() }) },
        },
        description: "Não autenticado",
      },
      403: {
        content: {
          "application/json": { schema: z.object({ error: z.string() }) },
        },
        description: "Sem permissão",
      },
      500: {
        content: {
          "application/json": { schema: z.object({ error: z.string() }) },
        },
        description: "Erro interno",
      },
    },
  });

  customRoutes.openapi(listAdminCollectionsRoute, (c) => {
    try {
      const db = getDb();
      const rows = db
        .prepare(
          `SELECT cc.id_collection, cc.name, cc.description, cc.cover_url,
                  cc.visibility, cc.owner_id, cc.author_name,
                  cu.display_name as owner_name,
                  COUNT(cm.id_music) as musics_count,
                  cc.created_at, cc.updated_at
           FROM custom_collections cc
           LEFT JOIN custom_musics cm ON cm.id_collection = cc.id_collection
           LEFT JOIN custom_users cu ON cu.id_user = cc.owner_id
           WHERE cc.tenant_id = ?
           GROUP BY cc.id_collection
           ORDER BY cc.updated_at DESC`,
        )
        .all(c.get("tenantId")) as AdminCollectionRow[];

      // D4: paginação idêntica à rota pública (default 24, cap 100)
      const page = Math.max(1, Number(c.req.query("page") ?? 1) || 1);
      const perPageRaw = Number(c.req.query("per_page") ?? 24) || 24;
      const perPage = Math.min(100, Math.max(1, perPageRaw));
      const start = (page - 1) * perPage;
      const pageItems = rows.slice(start, start + perPage);

      return c.json(
        {
          data: pageItems,
          meta: {
            total: rows.length,
            page,
            per_page: perPage,
            last_page: Math.max(1, Math.ceil(rows.length / perPage)),
          },
        },
        200,
      );
    } catch (error) {
      console.error(error);
      return c.json({ error: "Erro ao listar coletâneas" }, 500);
    }
  });

  // RF-02: TODAS as músicas (incl. de coleções privadas) com owner_name e
  // nome/visibilidade da coleção. Mesmos JOINs da listAllMusicsRoute + users.
  const listAdminMusicsRoute = createRoute({
    method: "get",
    path: "/admin/musics",
    tags: ["custom"],
    description:
      "Admin: lista TODAS as músicas custom (incl. de coletâneas privadas) com dono e coleção",
    middleware: [adminAuth] as const,
    responses: {
      200: {
        content: {
          "application/json": { schema: AdminMusicsListResponseSchema },
        },
        description: "Lista global com meta de paginação",
      },
      401: {
        content: {
          "application/json": { schema: z.object({ error: z.string() }) },
        },
        description: "Não autenticado",
      },
      403: {
        content: {
          "application/json": { schema: z.object({ error: z.string() }) },
        },
        description: "Sem permissão",
      },
      500: {
        content: {
          "application/json": { schema: z.object({ error: z.string() }) },
        },
        description: "Erro interno",
      },
    },
  });

  customRoutes.openapi(listAdminMusicsRoute, (c) => {
    try {
      const db = getDb();
      const rows = db
        .prepare(
          `SELECT cm.id_music, cm.id_collection, cm.name, cm.lyric,
                  cm.auxiliary_lyric, cm.id_file_audio, cm.id_file_instrumental,
                  cm.id_file_image, cm.duration, cm.official_music_id,
                  cm.owner_id, cm.client_uuid, cm.created_at, cm.updated_at,
                  cu.display_name as owner_name,
                  cc.name as collection_name,
                  cc.visibility as collection_visibility,
                  f_audio.url as audio_url,
                  f_inst.url as instrumental_url,
                  f_img.url as image_url
           FROM custom_musics cm
           INNER JOIN custom_collections cc ON cm.id_collection = cc.id_collection
           LEFT JOIN custom_users cu ON cu.id_user = cm.owner_id
           LEFT JOIN files f_audio ON cm.id_file_audio = f_audio.id_file
           LEFT JOIN files f_inst ON cm.id_file_instrumental = f_inst.id_file
           LEFT JOIN files f_img ON cm.id_file_image = f_img.id_file
           WHERE cc.tenant_id = ?
           ORDER BY cm.name`,
        )
        .all(c.get("tenantId")) as AdminMusicRow[];

      const page = Math.max(1, Number(c.req.query("page") ?? 1) || 1);
      const perPageRaw = Number(c.req.query("per_page") ?? 24) || 24;
      const perPage = Math.min(100, Math.max(1, perPageRaw));
      const start = (page - 1) * perPage;
      const pageItems = rows.slice(start, start + perPage);

      return c.json(
        {
          data: pageItems,
          meta: {
            total: rows.length,
            page,
            per_page: perPage,
            last_page: Math.max(1, Math.ceil(rows.length / perPage)),
          },
        },
        200,
      );
    } catch (error) {
      console.error(error);
      return c.json({ error: "Erro ao listar músicas" }, 500);
    }
  });
}
