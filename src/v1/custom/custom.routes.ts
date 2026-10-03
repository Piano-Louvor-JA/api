import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { getDb } from "../../db/connection.js";
import {
  type CustomAuthEnv,
  optionalAuth,
  requireAuth,
} from "./auth.middleware.js";
import {
  AuthResponseSchema,
  CreateCustomCollectionSchema,
  CreateCustomLyricSchema,
  CreateCustomMusicSchema,
  CustomCollectionSchema,
  CustomCollectionsListResponseSchema,
  CustomLyricSchema,
  CustomLyricsListResponseSchema,
  CustomMusicSchema,
  CustomMusicsListResponseSchema,
  ForgotPasswordSchema,
  LoginSchema,
  MeResponseSchema,
  // Auth
  RegisterSchema,
  ResetPasswordSchema,
  UpdateCustomCollectionSchema,
  UpdateCustomLyricSchema,
  UpdateCustomMusicSchema,
} from "./custom.schemas.js";
import { firebaseAuth } from "./firebase-auth.middleware.js";
import {
  listUnreadNotifications,
  markAllRead,
  promoteMusicToF,
} from "./promotion.service.js";
import {
  checkAnomalyAndFreeze,
  creditPoints,
  evaluateBadges,
  getRanking,
  getUserPosition,
  recordCollectionUse,
} from "./ranking.service.js";
import {
  completeWeeklyTask,
  getWeeklyTasksForUser,
  isoWeekKey,
} from "./weekly-tasks.service.js";

// lint: row types das tabelas custom (evitam 'as any' nas queries)
type CollectionRow = {
  id_collection: number;
  name: string;
  description: string | null;
  created_at: string;
  updated_at: string;
  cover_url: string | null;
  owner_id: number | null;
  author_name: string | null;
  visibility: "public" | "private";
  client_uuid: string | null;
  deleted_at: number | null;
  updated_at_ms: number | null;
  musics_count?: number;
  is_owner?: number;
};
type MusicRow = {
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
  created_at: string;
  updated_at: string;
  client_uuid: string | null;
  deleted_at: number | null;
  updated_at_ms: number | null;
};
type LyricRow = {
  id_lyric: number;
  id_music: number;
  lyric: string | null;
  aux_lyric: string | null;
  id_file_image: number | null;
  time: string | null;
  instrumental_time: string | null;
  show_slide: number;
  order: number;
  created_at: string | null;
  updated_at: string | null;
};
type UserRow = {
  id_user: number;
  email: string;
  password_hash: string;
  display_name: string | null;
};
type SessionRow = {
  id_user: number;
  email: string;
  display_name: string | null;
};

const customRoutes = new OpenAPIHono<CustomAuthEnv>();

// Rotas públicas (sem auth): health/register/login. Todo o resto valida sessão
// via optionalAuth (leitura aceita anônimo) ou exige owner check na rota.
customRoutes.use("*", optionalAuth);
customRoutes.use("*", firebaseAuth);

// ============================================
// Collections
// ============================================

const listCollectionsRoute = createRoute({
  method: "get",
  path: "/collections",
  tags: ["custom"],
  description:
    "Lista coletâneas customizadas (públicas + minhas se autenticado)",
  middleware: [optionalAuth] as const,
  responses: {
    200: {
      content: {
        "application/json": { schema: CustomCollectionsListResponseSchema },
      },
      description: "Lista de coletâneas",
    },
    500: {
      content: {
        "application/json": { schema: z.object({ error: z.string() }) },
      },
      description: "Erro interno",
    },
  },
});

customRoutes.openapi(listCollectionsRoute, (c) => {
  try {
    const db = getDb();
    const user = c.get("user") as { id_user: number } | undefined;

    // api#82: privada só o dono vê. Deslogado vê apenas públicas.
    // Ordem dos placeholders: 1º o do is_owner (SELECT), 2º o do WHERE.
    const params: unknown[] = [];
    const query = `
      SELECT cc.*, COUNT(cm.id_music) as musics_count,
             ${user ? "?" : "0"} as is_owner
      FROM custom_collections cc
      LEFT JOIN custom_musics cm ON cm.id_collection = cc.id_collection
      WHERE ${user ? "(cc.visibility = 'public' OR cc.owner_id = ?)" : "cc.visibility = 'public'"}
        AND NOT EXISTS (
          SELECT 1 FROM collection_reports r
          WHERE r.collection_id = cc.id_collection AND r.status = 'open'
        )
      GROUP BY cc.id_collection ORDER BY cc.updated_at DESC
    `;
    if (user) {
      params.push(user.id_user); // is_owner
      params.push(user.id_user); // filtro de visibilidade
    }

    const collections = db
      .prepare(query)
      .all(...(params as string[])) as CollectionRow[];

    // Paginação (query da Comunidade): page/per_page via query string.
    const page = Math.max(1, Number(c.req.query("page") ?? 1) || 1);
    const perPageRaw = Number(c.req.query("per_page") ?? 24) || 24;
    const perPage = Math.min(100, Math.max(1, perPageRaw));
    const start = (page - 1) * perPage;
    const pageItems = collections.slice(start, start + perPage);

    return c.json(
      {
        data: pageItems,
        meta: {
          total: collections.length,
          page,
          per_page: perPage,
          last_page: Math.max(1, Math.ceil(collections.length / perPage)),
        },
      },
      200,
    );
  } catch (error) {
    console.error(error);
    return c.json({ error: "Erro ao listar coletâneas" }, 500);
  }
});

const createCollectionRoute = createRoute({
  method: "post",
  path: "/collections",
  tags: ["custom"],
  description: "Cria uma nova coletânea customizada",
  middleware: [optionalAuth] as const,
  request: {
    body: {
      content: { "application/json": { schema: CreateCustomCollectionSchema } },
    },
  },
  responses: {
    201: {
      content: { "application/json": { schema: CustomCollectionSchema } },
      description: "Coletânea criada",
    },
    400: {
      content: {
        "application/json": { schema: z.object({ error: z.string() }) },
      },
      description: "Dados inválidos",
    },
    401: {
      content: {
        "application/json": { schema: z.object({ error: z.string() }) },
      },
      description: "Não autenticado (api#82: escrita exige identidade)",
    },
    500: {
      content: {
        "application/json": { schema: z.object({ error: z.string() }) },
      },
      description: "Erro interno",
    },
  },
});

customRoutes.openapi(createCollectionRoute, async (c) => {
  try {
    const body = c.req.valid("json");
    const db = getDb();
    const user = c.get("user") as { id_user: number } | undefined;

    // api#82 hardening: escrita na API exige identidade (sem auth cria
    // local no cliente — a API nunca recebe anônimo).
    if (!user) return c.json({ error: "Não autenticado" }, 401);

    const result = db
      .prepare(
        `INSERT INTO custom_collections (name, description, owner_id, author_name, visibility) VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        body.name,
        body.description ?? null,
        user.id_user,
        body.author_name ?? null,
        body.visibility ?? "public",
      );

    const collection = db
      .prepare(`SELECT * FROM custom_collections WHERE id_collection = ?`)
      .get(result.lastInsertRowid) as CollectionRow | undefined;
    if (!collection) {
      return c.json({ error: "Erro ao criar coletânea" }, 500);
    }

    // F2: publicar coletânea pública credita +10 (SPEC §2). Privada não pontua.
    if ((body.visibility ?? "public") === "public") {
      creditPoints(db, user.id_user, "publish", Number(result.lastInsertRowid));
      checkAnomalyAndFreeze(db, user.id_user);
      evaluateBadges(db, user.id_user);
    }

    return c.json({ ...collection, musics_count: 0 }, 201);
  } catch (error) {
    console.error(error);
    return c.json({ error: "Erro ao criar coletânea" }, 500);
  }
});

const getCollectionRoute = createRoute({
  method: "get",
  path: "/collections/{id}",
  tags: ["custom"],
  description: "Detalhe de uma coletânea customizada",
  middleware: [optionalAuth] as const,
  request: {
    params: z.object({
      id: z.string().openapi({ description: "ID da coletânea", example: "1" }),
    }),
  },
  responses: {
    200: {
      content: { "application/json": { schema: CustomCollectionSchema } },
      description: "Coletânea encontrada",
    },
    404: {
      content: {
        "application/json": { schema: z.object({ error: z.string() }) },
      },
      description: "Coletânea não encontrada",
    },
    500: {
      content: {
        "application/json": { schema: z.object({ error: z.string() }) },
      },
      description: "Erro interno",
    },
  },
});

customRoutes.openapi(getCollectionRoute, (c) => {
  try {
    const { id } = c.req.valid("param");
    const db = getDb();
    const user = c.get("user") as { id_user: number } | undefined;

    const collection = db
      .prepare(
        `SELECT cc.*, COUNT(cm.id_music) as musics_count
         FROM custom_collections cc
         LEFT JOIN custom_musics cm ON cm.id_collection = cc.id_collection
         WHERE cc.id_collection = ?
         GROUP BY cc.id_collection`,
      )
      .get(parseInt(id, 10)) as CollectionRow | undefined;

    if (!collection) {
      return c.json({ error: "Coletânea não encontrada" }, 404);
    }

    // api#82: privada só o dono acessa (404, não 403 — não revela existência)
    if (
      collection.visibility === "private" &&
      (!user || collection.owner_id !== user.id_user)
    ) {
      return c.json({ error: "Coletânea não encontrada" }, 404);
    }

    return c.json(collection, 200);
  } catch (error) {
    console.error(error);
    return c.json({ error: "Erro ao buscar coletânea" }, 500);
  }
});

const updateCollectionRoute = createRoute({
  method: "put",
  path: "/collections/{id}",
  tags: ["custom"],
  description: "Atualiza uma coletânea customizada",
  middleware: [requireAuth] as const,
  request: {
    params: z.object({
      id: z.string().openapi({ description: "ID da coletânea", example: "1" }),
    }),
    body: {
      content: { "application/json": { schema: UpdateCustomCollectionSchema } },
    },
  },
  responses: {
    200: {
      content: { "application/json": { schema: CustomCollectionSchema } },
      description: "Coletânea atualizada",
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
    404: {
      content: {
        "application/json": { schema: z.object({ error: z.string() }) },
      },
      description: "Coletânea não encontrada",
    },
    500: {
      content: {
        "application/json": { schema: z.object({ error: z.string() }) },
      },
      description: "Erro interno",
    },
  },
});

customRoutes.openapi(updateCollectionRoute, (c) => {
  try {
    const { id } = c.req.valid("param");
    const body = c.req.valid("json");
    const db = getDb();
    const user = c.get("user") as { id_user: number };

    const collection = db
      .prepare(`SELECT * FROM custom_collections WHERE id_collection = ?`)
      .get(parseInt(id, 10)) as CollectionRow | undefined;

    if (!collection) {
      return c.json({ error: "Coletânea não encontrada" }, 404);
    }

    // Apenas dono pode editar (coletâneas sem dono permanecem públicas p/ leitura, mas sem edição)
    if (collection.owner_id != null && collection.owner_id !== user.id_user) {
      return c.json({ error: "Sem permissão para editar esta coletânea" }, 403);
    }

    db.prepare(
      `UPDATE custom_collections
       SET name = ?, description = ?, cover_url = ?, visibility = ?, updated_at = CURRENT_TIMESTAMP
       WHERE id_collection = ?`,
    ).run(
      body.name ?? collection.name,
      body.description ?? collection.description,
      body.cover_url !== undefined ? body.cover_url : collection.cover_url,
      body.visibility ?? collection.visibility ?? "public",
      parseInt(id, 10),
    );

    const updated = db
      .prepare(
        `SELECT cc.*, COUNT(cm.id_music) as musics_count
         FROM custom_collections cc
         LEFT JOIN custom_musics cm ON cm.id_collection = cc.id_collection
         WHERE cc.id_collection = ?
         GROUP BY cc.id_collection`,
      )
      .get(parseInt(id, 10)) as CollectionRow | undefined;

    return c.json(updated, 200);
  } catch (error) {
    console.error(error);
    return c.json({ error: "Erro ao atualizar coletânea" }, 500);
  }
});

const deleteCollectionRoute = createRoute({
  method: "delete",
  path: "/collections/{id}",
  tags: ["custom"],
  description: "Remove uma coletânea customizada (cascade em músicas)",
  middleware: [requireAuth] as const,
  request: {
    params: z.object({
      id: z.string().openapi({ description: "ID da coletânea", example: "1" }),
    }),
  },
  responses: {
    200: {
      content: {
        "application/json": { schema: z.object({ success: z.boolean() }) },
      },
      description: "Coletânea removida",
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
    404: {
      content: {
        "application/json": { schema: z.object({ error: z.string() }) },
      },
      description: "Coletânea não encontrada",
    },
    500: {
      content: {
        "application/json": { schema: z.object({ error: z.string() }) },
      },
      description: "Erro interno",
    },
  },
});

customRoutes.openapi(deleteCollectionRoute, (c) => {
  try {
    const { id } = c.req.valid("param");
    const db = getDb();
    const user = c.get("user") as { id_user: number };

    const collection = db
      .prepare(`SELECT * FROM custom_collections WHERE id_collection = ?`)
      .get(parseInt(id, 10)) as CollectionRow | undefined;

    if (!collection) {
      return c.json({ error: "Coletânea não encontrada" }, 404);
    }

    // Apenas dono pode deletar
    if (collection.owner_id != null && collection.owner_id !== user.id_user) {
      return c.json(
        { error: "Sem permissão para remover esta coletânea" },
        403,
      );
    }

    db.prepare(`DELETE FROM custom_collections WHERE id_collection = ?`).run(
      parseInt(id, 10),
    );

    return c.json({ success: true }, 200);
  } catch (error) {
    console.error(error);
    return c.json({ error: "Erro ao remover coletânea" }, 500);
  }
});

// ============================================
// Musics
// ============================================

// GET /musics — todas as músicas custom (qualquer coletânea), p/ seletor do editor
const listAllMusicsRoute = createRoute({
  method: "get",
  path: "/musics",
  tags: ["custom"],
  description: "Lista todas as músicas custom (de todas as coletâneas)",
  request: {},
  responses: {
    200: {
      content: {
        "application/json": { schema: CustomMusicsListResponseSchema },
      },
      description: "Lista de músicas",
    },
    500: {
      content: {
        "application/json": { schema: z.object({ error: z.string() }) },
      },
      description: "Erro interno",
    },
  },
});

customRoutes.openapi(listAllMusicsRoute, (c) => {
  try {
    const db = getDb();

    const musics = db
      .prepare(
        `SELECT cm.*,
                cc.name as collection_name,
                f_audio.url as audio_url,
                f_inst.url as instrumental_url,
                f_img.url as image_url,
                f_img.image_position as image_position
         FROM custom_musics cm
         INNER JOIN custom_collections cc ON cm.id_collection = cc.id_collection
         LEFT JOIN files f_audio ON cm.id_file_audio = f_audio.id_file
         LEFT JOIN files f_inst ON cm.id_file_instrumental = f_inst.id_file
         LEFT JOIN files f_img ON cm.id_file_image = f_img.id_file
         ORDER BY cm.name`,
      )
      .all() as (MusicRow & {
      collection_name: string;
      audio_url: string | null;
      instrumental_url: string | null;
      image_url: string | null;
      image_position: number | null;
    })[];

    return c.json(
      {
        data: musics,
        meta: {
          total: musics.length,
          per_page: musics.length,
          current_page: 1,
          last_page: 1,
        },
      },
      200,
    );
  } catch (error) {
    console.error(error);
    return c.json({ error: "Erro ao listar músicas" }, 500);
  }
});

const listMusicsRoute = createRoute({
  method: "get",
  path: "/collections/{id}/musics",
  tags: ["custom"],
  description: "Lista músicas de uma coletânea customizada",
  request: {
    params: z.object({
      id: z.string().openapi({ description: "ID da coletânea", example: "1" }),
    }),
  },
  responses: {
    200: {
      content: {
        "application/json": { schema: CustomMusicsListResponseSchema },
      },
      description: "Lista de músicas",
    },
    500: {
      content: {
        "application/json": { schema: z.object({ error: z.string() }) },
      },
      description: "Erro interno",
    },
  },
});

customRoutes.openapi(listMusicsRoute, (c) => {
  try {
    const { id } = c.req.valid("param");
    const db = getDb();

    const musics = db
      .prepare(
        `SELECT cm.*,
                f_audio.url as audio_url,
                f_inst.url as instrumental_url,
                f_img.url as image_url,
                f_img.image_position as image_position
         FROM custom_musics cm
         LEFT JOIN files f_audio ON cm.id_file_audio = f_audio.id_file
         LEFT JOIN files f_inst ON cm.id_file_instrumental = f_inst.id_file
         LEFT JOIN files f_img ON cm.id_file_image = f_img.id_file
         WHERE cm.id_collection = ?
         ORDER BY cm.name`,
      )
      .all(parseInt(id, 10)) as MusicRow[];

    return c.json(
      {
        data: musics,
        meta: {
          total: musics.length,
          per_page: musics.length,
          current_page: 1,
          last_page: 1,
        },
      },
      200,
    );
  } catch (error) {
    console.error(error);
    return c.json({ error: "Erro ao listar músicas" }, 500);
  }
});

// POST /collections/{id}/musics/{musicId}/copy — clona música (com letra/áudio/bg) p/ outra coletânea
const copyMusicRoute = createRoute({
  method: "post",
  path: "/collections/{id}/musics/{musicId}/copy",
  tags: ["custom"],
  description:
    "Copia uma música custom existente para esta coletânea (com letra e mídia)",
  request: {
    params: z.object({
      id: z.string().openapi({ description: "ID da coletânea destino" }),
      musicId: z.string().openapi({ description: "ID da música de origem" }),
    }),
  },
  responses: {
    200: {
      content: { "application/json": { schema: CustomMusicSchema } },
      description: "Música já existia na coletânea destino (idempotente)",
    },
    201: {
      content: { "application/json": { schema: CustomMusicSchema } },
      description: "Música copiada",
    },
    404: {
      content: {
        "application/json": { schema: z.object({ error: z.string() }) },
      },
      description: "Música ou coletânea não encontrada",
    },
    500: {
      content: {
        "application/json": { schema: z.object({ error: z.string() }) },
      },
      description: "Erro interno",
    },
  },
});

customRoutes.openapi(copyMusicRoute, (c) => {
  try {
    const { id, musicId } = c.req.valid("param");
    const db = getDb();

    const src = db
      .prepare("SELECT * FROM custom_musics WHERE id_music = ?")
      .get(parseInt(musicId, 10)) as MusicRow | undefined;
    if (!src) return c.json({ error: "Música de origem não encontrada" }, 404);

    const dest = db
      .prepare(
        "SELECT id_collection FROM custom_collections WHERE id_collection = ?",
      )
      .get(parseInt(id, 10)) as CollectionRow | undefined;
    if (!dest)
      return c.json({ error: "Coletânea destino não encontrada" }, 404);

    // Evita duplicar na mesma coletânea
    const dup = db
      .prepare(
        "SELECT * FROM custom_musics WHERE id_collection = ? AND name = ?",
      )
      .get(parseInt(id, 10), src.name) as MusicRow | undefined;
    if (dup) return c.json(dup, 200);

    const result = db
      .prepare(
        `INSERT INTO custom_musics (id_collection, name, lyric, auxiliary_lyric, id_file_audio, id_file_instrumental, id_file_image, duration, official_music_id, owner_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        parseInt(id, 10),
        src.name,
        src.lyric,
        src.auxiliary_lyric,
        src.id_file_audio,
        src.id_file_instrumental,
        src.id_file_image,
        src.duration,
        src.official_music_id,
        dest.owner_id,
      );
    const newId = result.lastInsertRowid as number;

    // Clona as estrofes (letra + timing + bg por estrofe)
    const lyrics = db
      .prepare(
        'SELECT * FROM custom_lyrics WHERE id_music = ? ORDER BY "order", id_lyric',
      )
      .all(src.id_music) as LyricRow[];
    const insertLyric = db.prepare(
      `INSERT INTO custom_lyrics (id_music, lyric, aux_lyric, id_file_image, time, instrumental_time, show_slide, "order")
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const l of lyrics) {
      insertLyric.run(
        newId,
        l.lyric,
        l.aux_lyric,
        l.id_file_image,
        l.time,
        l.instrumental_time,
        l.show_slide ?? 1,
        l.order ?? 0,
      );
    }

    const music = db
      .prepare("SELECT * FROM custom_musics WHERE id_music = ?")
      .get(newId) as MusicRow | undefined;
    return c.json(music, 201);
  } catch (error) {
    console.error(error);
    return c.json({ error: "Erro ao copiar música" }, 500);
  }
});

const createMusicRoute = createRoute({
  method: "post",
  path: "/collections/{id}/musics",
  tags: ["custom"],
  description: "Cria uma nova música em uma coletânea customizada",
  request: {
    params: z.object({
      id: z.string().openapi({ description: "ID da coletânea", example: "1" }),
    }),
    body: {
      content: { "application/json": { schema: CreateCustomMusicSchema } },
    },
  },
  responses: {
    200: {
      content: { "application/json": { schema: CustomMusicSchema } },
      description:
        "Música já existia (dedup por client_uuid) — retorna a existente",
    },
    201: {
      content: { "application/json": { schema: CustomMusicSchema } },
      description: "Música criada",
    },
    404: {
      content: {
        "application/json": { schema: z.object({ error: z.string() }) },
      },
      description: "Coletânea não encontrada",
    },
    500: {
      content: {
        "application/json": { schema: z.object({ error: z.string() }) },
      },
      description: "Erro interno",
    },
  },
});

customRoutes.openapi(createMusicRoute, (c) => {
  try {
    const { id } = c.req.valid("param");
    const body = c.req.valid("json");
    const db = getDb();

    const collection = db
      .prepare(`SELECT * FROM custom_collections WHERE id_collection = ?`)
      .get(parseInt(id, 10)) as CollectionRow | undefined;

    if (!collection) {
      return c.json({ error: "Coletânea não encontrada" }, 404);
    }

    // Dedup de imports (app#336 fase 3): mesmo owner + mesmo client_uuid
    // (hash determinístico do conteúdo) → retorna o registro existente
    // sem duplicar (200 em vez de 201).
    if (body.client_uuid) {
      const existing = db
        .prepare(
          `SELECT id_music FROM custom_musics
           WHERE owner_id = ? AND client_uuid = ?`,
        )
        .get(collection.owner_id, body.client_uuid) as
        | { id_music: number }
        | undefined;
      if (existing) {
        const full = db
          .prepare(`SELECT * FROM custom_musics WHERE id_music = ?`)
          .get(existing.id_music) as Record<string, unknown>;
        return c.json(full as never, 200);
      }
    }

    const result = db
      .prepare(
        `INSERT INTO custom_musics (id_collection, name, lyric, auxiliary_lyric, id_file_audio, id_file_instrumental, id_file_image, duration, official_music_id, owner_id, client_uuid)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        parseInt(id, 10),
        body.name,
        body.lyric ?? null,
        body.auxiliary_lyric ?? null,
        body.id_file_audio ?? null,
        body.id_file_instrumental ?? null,
        body.id_file_image ?? null,
        body.duration ?? null,
        body.official_music_id ?? null,
        collection.owner_id,
        body.client_uuid ?? null,
      );

    // Link p/ hino oficial: herda nome/duração da tabela oficial p/ a lista.
    if (body.official_music_id != null) {
      db.prepare(
        `UPDATE custom_musics
         SET name = COALESCE((SELECT m.name FROM musics m WHERE m.id_music = ?), name),
             duration = COALESCE((SELECT fm.duration FROM musics m JOIN files fm ON m.id_file_music = fm.id_file WHERE m.id_music = ?), duration)
         WHERE id_music = ?`,
      ).run(
        body.official_music_id,
        body.official_music_id,
        result.lastInsertRowid,
      );
    }

    const music = db
      .prepare(`SELECT * FROM custom_musics WHERE id_music = ?`)
      .get(result.lastInsertRowid) as MusicRow | undefined;

    return c.json(music, 201);
  } catch (error) {
    console.error(error);
    return c.json({ error: "Erro ao criar música" }, 500);
  }
});

const getMusicRoute = createRoute({
  method: "get",
  path: "/musics/{id}",
  tags: ["custom"],
  description: "Detalhe de uma música customizada com estrofes",
  request: {
    params: z.object({
      id: z.string().openapi({ description: "ID da música", example: "1" }),
    }),
  },
  responses: {
    200: {
      content: { "application/json": { schema: CustomMusicSchema } },
      description: "Música encontrada",
    },
    404: {
      content: {
        "application/json": { schema: z.object({ error: z.string() }) },
      },
      description: "Música não encontrada",
    },
    500: {
      content: {
        "application/json": { schema: z.object({ error: z.string() }) },
      },
      description: "Erro interno",
    },
  },
});

customRoutes.openapi(getMusicRoute, (c) => {
  try {
    const { id } = c.req.valid("param");
    const db = getDb();

    const music = db
      .prepare(
        `SELECT cm.*,
                f_audio.url as audio_url,
                f_inst.url as instrumental_url,
                f_img.url as image_url,
                f_img.image_position as image_position
         FROM custom_musics cm
         LEFT JOIN files f_audio ON cm.id_file_audio = f_audio.id_file
         LEFT JOIN files f_inst ON cm.id_file_instrumental = f_inst.id_file
         LEFT JOIN files f_img ON cm.id_file_image = f_img.id_file
         WHERE cm.id_music = ?`,
      )
      .get(parseInt(id, 10)) as
      | (MusicRow & {
          audio_url: string | null;
          instrumental_url: string | null;
          image_url: string | null;
          image_position: number | null;
        })
      | undefined;

    if (!music) {
      return c.json({ error: "Música não encontrada" }, 404);
    }

    // Estrofes
    const lyrics = db
      .prepare(
        `SELECT cl.*,
                f_img.url as image_url,
                f_img.image_position as image_position
         FROM custom_lyrics cl
         LEFT JOIN files f_img ON cl.id_file_image = f_img.id_file
         WHERE cl.id_music = ?
         ORDER BY cl."order" ASC`,
      )
      .all(parseInt(id, 10)) as (LyricRow & {
      image_url: string | null;
      image_position: number | null;
    })[];

    return c.json({ ...music, lyrics }, 200);
  } catch (error) {
    console.error(error);
    return c.json({ error: "Erro ao buscar música" }, 500);
  }
});

const updateMusicRoute = createRoute({
  method: "put",
  path: "/musics/{id}",
  tags: ["custom"],
  description: "Atualiza uma música customizada",
  middleware: [requireAuth] as const,
  request: {
    params: z.object({
      id: z.string().openapi({ description: "ID da música", example: "1" }),
    }),
    body: {
      content: { "application/json": { schema: UpdateCustomMusicSchema } },
    },
  },
  responses: {
    200: {
      content: { "application/json": { schema: CustomMusicSchema } },
      description: "Música atualizada",
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
    404: {
      content: {
        "application/json": { schema: z.object({ error: z.string() }) },
      },
      description: "Música não encontrada",
    },
    500: {
      content: {
        "application/json": { schema: z.object({ error: z.string() }) },
      },
      description: "Erro interno",
    },
  },
});

customRoutes.openapi(updateMusicRoute, (c) => {
  try {
    const { id } = c.req.valid("param");
    const body = c.req.valid("json");
    const db = getDb();

    const music = db
      .prepare(`SELECT * FROM custom_musics WHERE id_music = ?`)
      .get(parseInt(id, 10)) as MusicRow | undefined;

    if (!music) {
      return c.json({ error: "Música não encontrada" }, 404);
    }

    // Permissão: dono da música OU dono da coletânea pai
    const user = c.get("user") as { id_user: number };
    if (music.owner_id != null && music.owner_id !== user.id_user) {
      return c.json({ error: "Sem permissão para editar esta música" }, 403);
    }

    db.prepare(
      `UPDATE custom_musics
       SET name = ?, lyric = ?, auxiliary_lyric = ?, id_file_audio = ?, id_file_instrumental = ?, id_file_image = ?, duration = ?, updated_at = CURRENT_TIMESTAMP
       WHERE id_music = ?`,
    ).run(
      body.name ?? music.name,
      body.lyric ?? music.lyric,
      body.auxiliary_lyric ?? music.auxiliary_lyric,
      body.id_file_audio ?? music.id_file_audio,
      body.id_file_instrumental ?? music.id_file_instrumental,
      body.id_file_image ?? music.id_file_image,
      body.duration ?? music.duration,
      parseInt(id, 10),
    );

    const updated = db
      .prepare(
        `SELECT cm.*,
                f_audio.url as audio_url,
                f_inst.url as instrumental_url,
                f_img.url as image_url,
                f_img.image_position as image_position
         FROM custom_musics cm
         LEFT JOIN files f_audio ON cm.id_file_audio = f_audio.id_file
         LEFT JOIN files f_inst ON cm.id_file_instrumental = f_inst.id_file
         LEFT JOIN files f_img ON cm.id_file_image = f_img.id_file
         WHERE cm.id_music = ?`,
      )
      .get(parseInt(id, 10)) as
      | (MusicRow & {
          audio_url: string | null;
          instrumental_url: string | null;
          image_url: string | null;
          image_position: number | null;
        })
      | undefined;

    return c.json(updated, 200);
  } catch (error) {
    console.error(error);
    return c.json({ error: "Erro ao atualizar música" }, 500);
  }
});

const deleteMusicRoute = createRoute({
  method: "delete",
  path: "/musics/{id}",
  tags: ["custom"],
  description: "Remove uma música customizada (cascade em estrofes)",
  middleware: [requireAuth] as const,
  request: {
    params: z.object({
      id: z.string().openapi({ description: "ID da música", example: "1" }),
    }),
  },
  responses: {
    200: {
      content: {
        "application/json": { schema: z.object({ success: z.boolean() }) },
      },
      description: "Música removida",
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
    404: {
      content: {
        "application/json": { schema: z.object({ error: z.string() }) },
      },
      description: "Música não encontrada",
    },
    500: {
      content: {
        "application/json": { schema: z.object({ error: z.string() }) },
      },
      description: "Erro interno",
    },
  },
});

customRoutes.openapi(deleteMusicRoute, (c) => {
  try {
    const { id } = c.req.valid("param");
    const db = getDb();
    const user = c.get("user") as { id_user: number };

    const music = db
      .prepare(`SELECT * FROM custom_musics WHERE id_music = ?`)
      .get(parseInt(id, 10)) as MusicRow | undefined;

    if (!music) {
      return c.json({ error: "Música não encontrada" }, 404);
    }

    if (music.owner_id != null && music.owner_id !== user.id_user) {
      return c.json({ error: "Sem permissão para remover esta música" }, 403);
    }

    db.prepare(`DELETE FROM custom_musics WHERE id_music = ?`).run(
      parseInt(id, 10),
    );

    return c.json({ success: true }, 200);
  } catch (error) {
    console.error(error);
    return c.json({ error: "Erro ao remover música" }, 500);
  }
});

// ============================================
// Lyrics (estrofes)
// ============================================

const listLyricsRoute = createRoute({
  method: "get",
  path: "/musics/{id}/lyrics",
  tags: ["custom"],
  description: "Lista estrofes de uma música customizada",
  request: {
    params: z.object({
      id: z.string().openapi({ description: "ID da música", example: "1" }),
    }),
  },
  responses: {
    200: {
      content: {
        "application/json": { schema: CustomLyricsListResponseSchema },
      },
      description: "Lista de estrofes",
    },
    500: {
      content: {
        "application/json": { schema: z.object({ error: z.string() }) },
      },
      description: "Erro interno",
    },
  },
});

customRoutes.openapi(listLyricsRoute, (c) => {
  try {
    const { id } = c.req.valid("param");
    const db = getDb();

    const lyrics = db
      .prepare(
        `SELECT cl.*,
                f_img.url as image_url,
                f_img.image_position as image_position
         FROM custom_lyrics cl
         LEFT JOIN files f_img ON cl.id_file_image = f_img.id_file
         WHERE cl.id_music = ?
         ORDER BY cl."order" ASC`,
      )
      .all(parseInt(id, 10)) as (LyricRow & {
      image_url: string | null;
      image_position: number | null;
    })[];

    return c.json({ data: lyrics }, 200);
  } catch (error) {
    console.error(error);
    return c.json({ error: "Erro ao listar estrofes" }, 500);
  }
});

const createLyricRoute = createRoute({
  method: "post",
  path: "/musics/{id}/lyrics",
  tags: ["custom"],
  description: "Cria uma nova estrofe em uma música customizada",
  request: {
    params: z.object({
      id: z.string().openapi({ description: "ID da música", example: "1" }),
    }),
    body: {
      content: { "application/json": { schema: CreateCustomLyricSchema } },
    },
  },
  responses: {
    201: {
      content: { "application/json": { schema: CustomLyricSchema } },
      description: "Estrofe criada",
    },
    404: {
      content: {
        "application/json": { schema: z.object({ error: z.string() }) },
      },
      description: "Música não encontrada",
    },
    500: {
      content: {
        "application/json": { schema: z.object({ error: z.string() }) },
      },
      description: "Erro interno",
    },
  },
});

customRoutes.openapi(createLyricRoute, (c) => {
  try {
    const { id } = c.req.valid("param");
    const body = c.req.valid("json");
    const db = getDb();

    const music = db
      .prepare(`SELECT * FROM custom_musics WHERE id_music = ?`)
      .get(parseInt(id, 10)) as MusicRow | undefined;

    if (!music) {
      return c.json({ error: "Música não encontrada" }, 404);
    }

    // Se order não fornecida, pegar próxima
    let order = body.order;
    if (order === undefined) {
      const last = db
        .prepare(
          `SELECT MAX("order") as max_order FROM custom_lyrics WHERE id_music = ?`,
        )
        .get(parseInt(id, 10)) as { max_order: number | null } | undefined;
      order = (last?.max_order || 0) + 1;
    }

    const result = db
      .prepare(
        `INSERT INTO custom_lyrics (id_music, lyric, aux_lyric, id_file_image, time, instrumental_time, show_slide, "order")
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        parseInt(id, 10),
        body.lyric,
        body.aux_lyric ?? null,
        body.id_file_image ?? null,
        body.time ?? "00:00",
        body.instrumental_time ?? "00:00",
        body.show_slide ?? 1,
        order,
      );

    const lyric = db
      .prepare(`SELECT * FROM custom_lyrics WHERE id_lyric = ?`)
      .get(result.lastInsertRowid) as LyricRow | undefined;

    return c.json(lyric, 201);
  } catch (error) {
    console.error(error);
    return c.json({ error: "Erro ao criar estrofe" }, 500);
  }
});

const updateLyricRoute = createRoute({
  method: "put",
  path: "/lyrics/{id}",
  tags: ["custom"],
  description: "Atualiza uma estrofe",
  request: {
    params: z.object({
      id: z.string().openapi({ description: "ID da estrofe", example: "1" }),
    }),
    body: {
      content: { "application/json": { schema: UpdateCustomLyricSchema } },
    },
  },
  responses: {
    200: {
      content: { "application/json": { schema: CustomLyricSchema } },
      description: "Estrofe atualizada",
    },
    404: {
      content: {
        "application/json": { schema: z.object({ error: z.string() }) },
      },
      description: "Estrofe não encontrada",
    },
    500: {
      content: {
        "application/json": { schema: z.object({ error: z.string() }) },
      },
      description: "Erro interno",
    },
  },
});

customRoutes.openapi(updateLyricRoute, (c) => {
  try {
    const { id } = c.req.valid("param");
    const body = c.req.valid("json");
    const db = getDb();

    const lyric = db
      .prepare(`SELECT * FROM custom_lyrics WHERE id_lyric = ?`)
      .get(parseInt(id, 10)) as LyricRow | undefined;

    if (!lyric) {
      return c.json({ error: "Estrofe não encontrada" }, 404);
    }

    db.prepare(
      `UPDATE custom_lyrics
       SET lyric = ?, aux_lyric = ?, id_file_image = ?, time = ?, instrumental_time = ?, show_slide = ?, "order" = ?, updated_at = CURRENT_TIMESTAMP
       WHERE id_lyric = ?`,
    ).run(
      body.lyric ?? lyric.lyric,
      body.aux_lyric ?? lyric.aux_lyric,
      body.id_file_image ?? lyric.id_file_image,
      body.time ?? lyric.time,
      body.instrumental_time ?? lyric.instrumental_time,
      body.show_slide ?? lyric.show_slide,
      body.order ?? lyric.order,
      parseInt(id, 10),
    );

    const updated = db
      .prepare(`SELECT * FROM custom_lyrics WHERE id_lyric = ?`)
      .get(parseInt(id, 10)) as LyricRow | undefined;

    return c.json(updated, 200);
  } catch (error) {
    console.error(error);
    return c.json({ error: "Erro ao atualizar estrofe" }, 500);
  }
});

const deleteLyricRoute = createRoute({
  method: "delete",
  path: "/lyrics/{id}",
  tags: ["custom"],
  description: "Remove uma estrofe",
  request: {
    params: z.object({
      id: z.string().openapi({ description: "ID da estrofe", example: "1" }),
    }),
  },
  responses: {
    200: {
      content: {
        "application/json": { schema: z.object({ success: z.boolean() }) },
      },
      description: "Estrofe removida",
    },
    404: {
      content: {
        "application/json": { schema: z.object({ error: z.string() }) },
      },
      description: "Estrofe não encontrada",
    },
    500: {
      content: {
        "application/json": { schema: z.object({ error: z.string() }) },
      },
      description: "Erro interno",
    },
  },
});

customRoutes.openapi(deleteLyricRoute, (c) => {
  try {
    const { id } = c.req.valid("param");
    const db = getDb();

    const lyric = db
      .prepare(`SELECT * FROM custom_lyrics WHERE id_lyric = ?`)
      .get(parseInt(id, 10)) as LyricRow | undefined;

    if (!lyric) {
      return c.json({ error: "Estrofe não encontrada" }, 404);
    }

    db.prepare(`DELETE FROM custom_lyrics WHERE id_lyric = ?`).run(
      parseInt(id, 10),
    );

    return c.json({ success: true }, 200);
  } catch (error) {
    console.error(error);
    return c.json({ error: "Erro ao remover estrofe" }, 500);
  }
});

// ============================================
// Files — upload de mídia custom (áudio/imagens de .slja)
// Salva em media/custom/{audio|imagens}/ e registra na tabela files.
// Servido depois via GET /file/custom/... (compat.ts).
// ============================================

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const CUSTOM_MEDIA_DIR = join(process.cwd(), "media", "custom");

const uploadCustomFileRoute = createRoute({
  method: "post",
  path: "/files",
  tags: ["custom"],
  description:
    "Upload de arquivo de mídia custom (áudio ou imagem) para uso em músicas/coletâneas",
  middleware: [requireAuth] as const,
  request: {
    body: {
      content: {
        "multipart/form-data": {
          schema: z.object({
            file: z
              .custom<Blob>()
              .describe("Arquivo (mp3, png, jpg, bmp...)"),
            kind: z
              .enum(["audio", "imagens"])
              .optional()
              .describe("Subpasta de destino"),
          }),
        },
      },
    },
  },
  responses: {
    201: {
      content: {
        "application/json": {
          schema: z.object({
            id_file: z.number(),
            url: z.string(),
            name: z.string(),
            size: z.number(),
          }),
        },
      },
      description: "Arquivo salvo e registrado",
    },
    400: {
      content: {
        "application/json": { schema: z.object({ error: z.string() }) },
      },
      description: "Arquivo ausente ou inválido",
    },
    500: {
      content: {
        "application/json": { schema: z.object({ error: z.string() }) },
      },
      description: "Erro interno",
    },
  },
});

// biome-ignore lint/suspicious/noExplicitAny: OpenAPI route context omite Variables injetadas por requireAuth.
customRoutes.openapi(uploadCustomFileRoute, async (c: any) => {
  try {
    const formData = await c.req.formData();
    const file = formData.get("file");
    const kindRaw = formData.get("kind") ?? "imagens";
    const kind = kindRaw === "audio" ? "audio" : "imagens";

    if (!(file instanceof File)) {
      return c.json({ error: 'Campo "file" ausente ou inválido' }, 400);
    }

    const user = c.get("user") as { id_user: number };
    const { quotaCheck } = await import("./quota.service.js");
    const quota = quotaCheck(user.id_user, file.size);
    if (!quota.ok) {
      return c.json({ error: "quota_exceeded", message: quota.message }, 413);
    }

    // Sanitiza nome: mantém basename, remove separadores e caracteres perigosos
    const safeName = file.name
      .split(/[/\\]/)
      .pop()!
      .replace(/[^a-zA-Z0-9._\- ()]/g, "_");
    if (!safeName || safeName === ".") {
      return c.json({ error: "Nome de arquivo inválido" }, 400);
    }

    // B11: mídia isolada por id numérico do usuário; nunca e-mail no path.
    const destDir = join(CUSTOM_MEDIA_DIR, String(user.id_user), kind);
    mkdirSync(destDir, { recursive: true });

    // Nome final: id_generator-friendly — prefixa timestamp se já existir
    let finalName = safeName;
    const bytes = Buffer.from(await file.arrayBuffer());
    let path = join(destDir, finalName);
    if (existsSync(path)) {
      const dot = safeName.lastIndexOf(".");
      const stem = dot > 0 ? safeName.slice(0, dot) : safeName;
      const ext = dot > 0 ? safeName.slice(dot) : "";
      finalName = `${stem}_${Date.now()}${ext}`;
      path = join(destDir, finalName);
    }
    writeFileSync(path, bytes);

    const urlPath = `/custom/${user.id_user}/${kind}/${finalName}`;
    const type = kind === "audio" ? "audio" : "image";

    const db = getDb();
    const result = db
      .prepare(
        `INSERT INTO files (name, path, type, url, size) VALUES (?, ?, ?, ?, ?)`,
      )
      .run(safeName, urlPath, type, urlPath, bytes.length);
    const idFile = Number(result.lastInsertRowid);

    return c.json(
      { id_file: idFile, url: urlPath, name: safeName, size: bytes.length },
      201,
    );
  } catch (error) {
    console.error(error);
    return c.json({ error: "Erro ao salvar arquivo" }, 500);
  }
});

// ============================================
// Auth — login simples e-mail + senha
// ============================================

import {
  generateSessionToken,
  hashPassword,
  hashToken,
  verifyPassword,
} from "./auth.service.js";
import {
  sendNewLoginEmail,
  sendResetTokenEmail,
  sendWelcomeEmail,
  smtpConfigured,
} from "./mail.service.js";

const registerRoute = createRoute({
  method: "post",
  path: "/auth/register",
  tags: ["custom"],
  description: "Registra um novo usuário de coletâneas custom",
  request: {
    body: { content: { "application/json": { schema: RegisterSchema } } },
  },
  responses: {
    201: {
      content: { "application/json": { schema: AuthResponseSchema } },
      description: "Usuário criado",
    },
    409: {
      content: {
        "application/json": { schema: z.object({ error: z.string() }) },
      },
      description: "E-mail já cadastrado",
    },
    422: {
      content: {
        "application/json": { schema: z.object({ error: z.string() }) },
      },
      description: "Dados inválidos",
    },
    500: {
      content: {
        "application/json": { schema: z.object({ error: z.string() }) },
      },
      description: "Erro interno",
    },
  },
});

customRoutes.openapi(registerRoute, (c) => {
  try {
    const body = c.req.valid("json");
    const db = getDb();

    const passwordHash = hashPassword(body.password);

    let result: { lastInsertRowid: number | bigint };
    try {
      result = db
        .prepare(
          `INSERT INTO custom_users (email, password_hash, display_name) VALUES (?, ?, ?)`,
        )
        .run(body.email, passwordHash, body.displayName);
    } catch (e) {
      if (
        typeof e === "object" &&
        e !== null &&
        "code" in e &&
        e.code === "SQLITE_CONSTRAINT_UNIQUE"
      ) {
        return c.json({ error: "E-mail já cadastrado" }, 409);
      }
      throw e;
    }

    const userId = Number(result.lastInsertRowid);
    const token = generateSessionToken();
    db.prepare(
      `INSERT INTO custom_sessions (token_hash, id_user) VALUES (?, ?)`,
    ).run(hashToken(token), userId);

    // Boas-vindas: fire-and-forget, nunca bloqueia nem falha o registro
    void sendWelcomeEmail(body.email, body.displayName).catch(() => {});

    return c.json(
      {
        token,
        user: {
          id_user: userId,
          email: body.email,
          displayName: body.displayName,
        },
      },
      201,
    );
  } catch (error) {
    console.error(error);
    return c.json({ error: "Erro ao registrar usuário" }, 500);
  }
});

const loginRoute = createRoute({
  method: "post",
  path: "/auth/login",
  tags: ["custom"],
  description: "Login de usuário de coletâneas custom",
  request: {
    body: { content: { "application/json": { schema: LoginSchema } } },
  },
  responses: {
    200: {
      content: { "application/json": { schema: AuthResponseSchema } },
      description: "Login ok",
    },
    401: {
      content: {
        "application/json": { schema: z.object({ error: z.string() }) },
      },
      description: "Credenciais inválidas",
    },
    500: {
      content: {
        "application/json": { schema: z.object({ error: z.string() }) },
      },
      description: "Erro interno",
    },
  },
});

customRoutes.openapi(loginRoute, (c) => {
  try {
    const body = c.req.valid("json");
    const db = getDb();

    const user = db
      .prepare(
        `SELECT id_user, email, display_name, password_hash FROM custom_users WHERE email = ?`,
      )
      .get(body.email) as UserRow | undefined;

    if (!user || !verifyPassword(body.password, user.password_hash)) {
      return c.json({ error: "Credenciais inválidas" }, 401);
    }

    const token = generateSessionToken();
    db.prepare(
      `INSERT INTO custom_sessions (token_hash, id_user) VALUES (?, ?)`,
    ).run(hashToken(token), user.id_user);

    // Aviso de novo login: fire-and-forget (data local do servidor, PT-BR)
    void sendNewLoginEmail(
      user.email,
      user.display_name ?? "usuário",
      new Date().toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" }),
    ).catch(() => {});

    return c.json(
      {
        token,
        user: {
          id_user: user.id_user,
          email: user.email,
          displayName: user.display_name,
        },
      },
      200,
    );
  } catch (error) {
    console.error(error);
    return c.json({ error: "Erro ao fazer login" }, 500);
  }
});

// POST /auth/firebase-session — troca o Firebase ID token (Bearer) por uma
// sessão com id_user real. O middleware firebaseAuth (aplicado em "*" acima)
// já validou o token e fez o upsert em custom_users; aqui só devolvemos.
const firebaseSessionRoute = createRoute({
  method: "post",
  path: "/auth/firebase-session",
  tags: ["custom"],
  description:
    "Valida Firebase ID token (Bearer) e devolve sessão com id_user real",
  responses: {
    200: {
      content: { "application/json": { schema: AuthResponseSchema } },
      description: "Sessão válida",
    },
    401: {
      content: {
        "application/json": { schema: z.object({ error: z.string() }) },
      },
      description: "Token Firebase ausente ou inválido",
    },
  },
});

customRoutes.openapi(firebaseSessionRoute, (c) => {
  const user = c.get("user");
  if (!user) return c.json({ error: "Não autenticado" }, 401);

  const raw = c.req.header("authorization") ?? "";
  const token = raw.startsWith("Bearer ") ? raw.slice(7) : "";
  return c.json(
    {
      token,
      user: {
        id_user: user.id_user,
        email: user.email,
        displayName: user.display_name,
      },
    },
    200,
  );
});

const logoutRoute = createRoute({
  method: "post",
  path: "/auth/logout",
  tags: ["custom"],
  description: "Logout — invalida token da sessão",
  request: {},
  responses: {
    204: { description: "Logout ok" },
    401: {
      content: {
        "application/json": { schema: z.object({ error: z.string() }) },
      },
      description: "Token inválido",
    },
  },
});

customRoutes.openapi(logoutRoute, (c) => {
  const raw = c.req.header("authorization") ?? "";
  const token = raw.startsWith("Bearer ") ? raw.slice(7) : "";
  if (!token) return c.json({ error: "Token ausente" }, 401);

  const db = getDb();
  db.prepare(`DELETE FROM custom_sessions WHERE token_hash = ?`).run(
    hashToken(token),
  );
  return c.body(null, 204);
});

const meRoute = createRoute({
  method: "get",
  path: "/auth/me",
  tags: ["custom"],
  description: "Usuário autenticado atual",
  request: {},
  responses: {
    200: {
      content: { "application/json": { schema: MeResponseSchema } },
      description: "Usuário logado",
    },
    401: {
      content: {
        "application/json": { schema: z.object({ error: z.string() }) },
      },
      description: "Não autenticado",
    },
  },
});

customRoutes.openapi(meRoute, (c) => {
  const raw = c.req.header("authorization") ?? "";
  const token = raw.startsWith("Bearer ") ? raw.slice(7) : "";
  if (!token) return c.json({ error: "Não autenticado" }, 401);

  const db = getDb();
  const session = db
    .prepare(
      `SELECT cu.id_user, cu.email, cu.display_name
       FROM custom_sessions cs
       INNER JOIN custom_users cu ON cu.id_user = cs.id_user
       WHERE cs.token_hash = ?`,
    )
    .get(hashToken(token)) as SessionRow | undefined;

  if (!session) return c.json({ error: "Não autenticado" }, 401);

  return c.json(
    {
      user: {
        id_user: session.id_user,
        email: session.email,
        displayName: session.display_name,
      },
    },
    200,
  );
});

// ============================================
// Auth — reset de senha (sem SMTP)
// ============================================
// Fluxo: usuário pede reset → API gera token opaco de 1h (uso único) → o
// token é ENTREGUE AO USUÁRIO por canal externo (suporte/tela admin do
// operador). Sem SMTP nesta fase: nada é enviado automaticamente.
// forgot-password responde 200 SEMPRE (não revela se o e-mail existe).

const forgotPasswordRoute = createRoute({
  method: "post",
  path: "/auth/forgot-password",
  tags: ["custom"],
  description: "Gera token de reset (uso único, 1h). Resposta sempre 200.",
  request: {
    body: { content: { "application/json": { schema: ForgotPasswordSchema } } },
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z.object({
            ok: z.boolean(),
            /** Presente SOMENTE quando RESET_TOKEN_EXPOSE=1 (dev/self-host sem SMTP). */
            token: z.string().optional(),
          }),
        },
      },
      description: "Token gerado (ou resposta neutra se e-mail inexistente)",
    },
    500: {
      content: {
        "application/json": { schema: z.object({ error: z.string() }) },
      },
      description: "Erro interno",
    },
  },
});

customRoutes.openapi(forgotPasswordRoute, async (c) => {
  try {
    const body = c.req.valid("json");
    const db = getDb();

    const user = db
      .prepare(`SELECT id_user, display_name FROM custom_users WHERE email = ?`)
      .get(body.email) as { id_user: number; display_name: string } | undefined;

    // Sem exposição de existência: resposta idêntica nos dois casos.
    if (!user) return c.json({ ok: true }, 200);

    const token = generateSessionToken();
    const expires = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    db.prepare(
      `UPDATE custom_users SET reset_token_hash = ?, reset_token_expires = ? WHERE id_user = ?`,
    ).run(hashToken(token), expires, user.id_user);

    // 1) SMTP configurado → envia o token por e-mail (fluxo primário).
    if (smtpConfigured()) {
      const sent = await sendResetTokenEmail(
        body.email,
        user.display_name,
        token,
      );
      if (sent) return c.json({ ok: true }, 200);
      // SMTP falhou → cai pro fallback abaixo.
    }

    // 2) Fallback self-host/dev: expõe o token na resposta quando
    // RESET_TOKEN_EXPOSE=1 (não exige canal de suporte).
    if (process.env.RESET_TOKEN_EXPOSE === "1") {
      return c.json({ ok: true, token }, 200);
    }
    return c.json({ ok: true }, 200);
  } catch {
    return c.json({ error: "Erro interno" }, 500);
  }
});

const resetPasswordRoute = createRoute({
  method: "post",
  path: "/auth/reset-password",
  tags: ["custom"],
  description: "Troca a senha usando token de reset (uso único, 1h).",
  request: {
    body: { content: { "application/json": { schema: ResetPasswordSchema } } },
  },
  responses: {
    200: {
      content: {
        "application/json": { schema: z.object({ ok: z.boolean() }) },
      },
      description: "Senha alterada",
    },
    400: {
      content: {
        "application/json": { schema: z.object({ error: z.string() }) },
      },
      description: "Token inválido ou expirado",
    },
    500: {
      content: {
        "application/json": { schema: z.object({ error: z.string() }) },
      },
      description: "Erro interno",
    },
  },
});

customRoutes.openapi(resetPasswordRoute, (c) => {
  try {
    const body = c.req.valid("json");
    const db = getDb();

    const user = db
      .prepare(
        `SELECT id_user, reset_token_expires FROM custom_users WHERE reset_token_hash = ?`,
      )
      .get(hashToken(body.token)) as
      | { id_user: number; reset_token_expires: string }
      | undefined;

    if (
      !user?.reset_token_expires ||
      new Date(user.reset_token_expires).getTime() < Date.now()
    ) {
      return c.json({ error: "Token inválido ou expirado" }, 400);
    }

    const passwordHash = hashPassword(body.password);
    // Uso único: limpa o token ao trocar a senha. Invalida também todas as
    // sessões abertas (senha vazou — melhor derrubar tudo).
    const sweep = db.transaction(() => {
      db.prepare(
        `UPDATE custom_users SET password_hash = ?, reset_token_hash = NULL, reset_token_expires = NULL WHERE id_user = ?`,
      ).run(passwordHash, user.id_user);
      db.prepare(`DELETE FROM custom_sessions WHERE id_user = ?`).run(
        user.id_user,
      );
    });
    sweep();

    return c.json({ ok: true }, 200);
  } catch {
    return c.json({ error: "Erro interno" }, 500);
  }
});

// ============================================
// Ranking & Gamificação (F1..F2) — SPEC 16/09
// ============================================

const recordUseRoute = createRoute({
  method: "post",
  path: "/collections/{id}/use",
  tags: ["custom"],
  description:
    "Registra uso de coletânea pública (1x por usuário×coletânea; credita +5 ao dono)",
  middleware: [requireAuth] as const,
  request: {
    params: z.object({ id: z.string() }),
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z.object({ ok: z.boolean(), first_use: z.boolean() }),
        },
      },
      description: "Uso registrado (ou já existente)",
    },
    401: {
      content: {
        "application/json": { schema: z.object({ error: z.string() }) },
      },
      description: "Não autenticado",
    },
    404: {
      content: {
        "application/json": { schema: z.object({ error: z.string() }) },
      },
      description: "Coletânea não encontrada",
    },
  },
});

customRoutes.openapi(recordUseRoute, (c) => {
  const db = getDb();
  const user = c.get("user") as { id_user: number };
  const collectionId = Number(c.req.valid("param").id);

  const exists = db
    .prepare(
      `SELECT 1 FROM custom_collections WHERE id_collection = ? AND visibility = 'public'`,
    )
    .get(collectionId);
  if (!exists) return c.json({ error: "Coletânea não encontrada" }, 404);

  const firstUse = recordCollectionUse(db, user.id_user, collectionId);
  if (firstUse) {
    const owner = db
      .prepare(
        `SELECT owner_id FROM custom_collections WHERE id_collection = ?`,
      )
      .get(collectionId) as { owner_id: number | null } | undefined;
    if (owner?.owner_id != null) evaluateBadges(db, owner.owner_id);
  }
  return c.json({ ok: true, first_use: firstUse }, 200);
});

const rankingRoute = createRoute({
  method: "get",
  path: "/ranking",
  tags: ["custom"],
  description:
    "Ranking global de contribuidores (janela week|all; desempate por ponto mais antigo)",
  request: {
    query: z.object({
      window: z.enum(["week", "all"]).optional().default("all"),
    }),
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z.object({
            data: z.array(
              z.object({
                position: z.number(),
                user_id: z.number(),
                display_name: z.string().nullable(),
                total: z.number(),
              }),
            ),
          }),
        },
      },
      description: "Ranking global",
    },
  },
});

customRoutes.openapi(rankingRoute, (c) => {
  const db = getDb();
  const window = c.req.valid("query").window;
  const data = getRanking(db, window);
  return c.json({ data }, 200);
});

const myPositionRoute = createRoute({
  method: "get",
  path: "/ranking/me",
  tags: ["custom"],
  description: "Posição do usuário autenticado no ranking (week|all)",
  middleware: [requireAuth] as const,
  request: {
    query: z.object({
      window: z.enum(["week", "all"]).optional().default("all"),
    }),
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z.object({
            position: z.number().nullable(),
            total: z.number().nullable(),
          }),
        },
      },
      description: "Posição no ranking (null se não pontuou)",
    },
    401: {
      content: {
        "application/json": { schema: z.object({ error: z.string() }) },
      },
      description: "Não autenticado",
    },
  },
});

customRoutes.openapi(myPositionRoute, (c) => {
  const db = getDb();
  const user = c.get("user") as { id_user: number };
  const window = c.req.valid("query").window;
  const pos = getUserPosition(db, user.id_user, window);
  return c.json(
    { position: pos?.position ?? null, total: pos?.total ?? null },
    200,
  );
});

// ============================================
// Tarefas semanais (F4)
// ============================================

const weeklyTasksRoute = createRoute({
  method: "get",
  path: "/weekly-tasks",
  tags: ["custom"],
  description:
    "Tarefas semanais do usuário autenticado (3 rotativas, reset domingo 00:00 UTC-3)",
  middleware: [requireAuth] as const,
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z.object({
            week_key: z.string(),
            data: z.array(
              z.object({
                id: z.string(),
                description: z.string(),
                done: z.boolean(),
                bonus: z.number(),
              }),
            ),
          }),
        },
      },
      description: "Tarefas da semana",
    },
    401: {
      content: {
        "application/json": { schema: z.object({ error: z.string() }) },
      },
      description: "Não autenticado",
    },
  },
});

customRoutes.openapi(weeklyTasksRoute, (c) => {
  const db = getDb();
  const user = c.get("user") as { id_user: number };
  const weekKey = isoWeekKey();
  const tasks = getWeeklyTasksForUser(db, user.id_user, weekKey).map((t) => ({
    ...t,
    bonus: 15,
  }));
  return c.json({ week_key: weekKey, data: tasks }, 200);
});

const completeTaskRoute = createRoute({
  method: "post",
  path: "/weekly-tasks/{taskId}/complete",
  tags: ["custom"],
  description:
    "Marca tarefa semanal como concluída (idempotente; +15 na 1a vez da semana)",
  middleware: [requireAuth] as const,
  request: {
    params: z.object({ taskId: z.string() }),
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z.object({ ok: z.boolean(), credited: z.boolean() }),
        },
      },
      description: "Tarefa marcada",
    },
    401: {
      content: {
        "application/json": { schema: z.object({ error: z.string() }) },
      },
      description: "Não autenticado",
    },
    404: {
      content: {
        "application/json": { schema: z.object({ error: z.string() }) },
      },
      description: "Tarefa não existe nesta semana",
    },
  },
});

customRoutes.openapi(completeTaskRoute, (c) => {
  const db = getDb();
  const user = c.get("user") as { id_user: number };
  const weekKey = isoWeekKey();
  const taskId = c.req.valid("param").taskId;

  const task = getWeeklyTasksForUser(db, user.id_user, weekKey).find(
    (t) => t.id === taskId,
  );
  if (!task) return c.json({ error: "Tarefa não existe nesta semana" }, 404);

  // Validação mínima do servidor: tarefa done = marcada pelo cliente após
  // cumprir; o servidor garante idempotência e bônus 1x. Validações fortes
  // por tarefa (contagens) entram no F5+ (anti-fraude).
  const credited = completeWeeklyTask(db, user.id_user, task, weekKey);
  if (credited) {
    creditPoints(db, user.id_user, "weekly_task");
  }
  return c.json({ ok: true, credited }, 200);
});

// ============================================
// Moderação (F5) — report esconde até revisão
// ============================================

const reportCollectionRoute = createRoute({
  method: "post",
  path: "/collections/{id}/report",
  tags: ["custom"],
  description:
    "Reporta coletânea (esconde do catálogo público até revisão da curadoria)",
  middleware: [requireAuth] as const,
  request: {
    params: z.object({ id: z.string() }),
    body: {
      content: {
        "application/json": {
          schema: z.object({ reason: z.string().min(3).max(500) }),
        },
      },
    },
  },
  responses: {
    200: {
      content: {
        "application/json": { schema: z.object({ ok: z.boolean() }) },
      },
      description: "Report registrado",
    },
    401: {
      content: {
        "application/json": { schema: z.object({ error: z.string() }) },
      },
      description: "Não autenticado",
    },
    404: {
      content: {
        "application/json": { schema: z.object({ error: z.string() }) },
      },
      description: "Coletânea não encontrada",
    },
  },
});

customRoutes.openapi(reportCollectionRoute, (c) => {
  const db = getDb();
  const user = c.get("user") as { id_user: number };
  const collectionId = Number(c.req.valid("param").id);
  const { reason } = c.req.valid("json");

  const exists = db
    .prepare(`SELECT 1 FROM custom_collections WHERE id_collection = ?`)
    .get(collectionId);
  if (!exists) return c.json({ error: "Coletânea não encontrada" }, 404);

  db.prepare(
    `INSERT OR IGNORE INTO collection_reports (collection_id, reporter_id, reason) VALUES (?, ?, ?)`,
  ).run(collectionId, user.id_user, reason);

  return c.json({ ok: true }, 200);
});

// ============================================
// F6: promoção ao oficial + notificações
// ============================================

const promoteRoute = createRoute({
  method: "post",
  path: "/admin/promote-music",
  tags: ["custom"],
  description:
    "Promove faixa custom ao acervo oficial (curador; +50 pts, badge Autor Oficial, crédito permanente)",
  middleware: [requireAuth] as const,
  request: {
    body: {
      content: {
        "application/json": {
          schema: z.object({
            custom_music_id: z.number(),
            official_music_id: z.number(),
          }),
        },
      },
    },
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z.object({
            ok: z.boolean(),
            awarded_to: z.number().nullable().optional(),
            points: z.number().optional(),
          }),
        },
      },
      description: "Promovida",
    },
    400: {
      content: {
        "application/json": { schema: z.object({ error: z.string() }) },
      },
      description: "Erro de validação",
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
      description: "Sem permissão de curador",
    },
  },
});

customRoutes.openapi(promoteRoute, (c) => {
  const user = c.get("user") as { id_user: number };

  // Curadores autorizados via env (ids separados por vírgula). Sem env,
  // nenhum usuário tem poder de promoção (fail-closed).
  const curators = (process.env.CURATOR_USER_IDS ?? "")
    .split(",")
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isFinite(n) && n > 0);
  if (!curators.includes(user.id_user)) {
    return c.json({ error: "Sem permissão de curador" }, 403);
  }

  const db = getDb();
  const { custom_music_id, official_music_id } = c.req.valid("json");
  const result = promoteMusicToF(
    db,
    custom_music_id,
    official_music_id,
    user.id_user,
    (to, subject, _body) => {
      // Injeção do mail real fica no compose da rota (mail.service já existe).
      console.log(`[f6-mail] to=${to} subject=${subject}`);
    },
  );
  if (!result.ok) return c.json({ error: result.error ?? "Erro" }, 400);
  return c.json(
    { ok: true, awarded_to: result.awardedTo ?? null, points: result.points },
    200,
  );
});

const notificationsRoute = createRoute({
  method: "get",
  path: "/notifications",
  tags: ["custom"],
  description: "Notificações não lidas do usuário autenticado",
  middleware: [requireAuth] as const,
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z.object({
            data: z.array(
              z.object({
                id: z.number(),
                type: z.string(),
                title: z.string(),
                body: z.string(),
                created_at: z.string(),
              }),
            ),
          }),
        },
      },
      description: "Notificações não lidas",
    },
    401: {
      content: {
        "application/json": { schema: z.object({ error: z.string() }) },
      },
      description: "Não autenticado",
    },
  },
});

customRoutes.openapi(notificationsRoute, (c) => {
  const db = getDb();
  const user = c.get("user") as { id_user: number };
  return c.json({ data: listUnreadNotifications(db, user.id_user) }, 200);
});

const markReadRoute = createRoute({
  method: "post",
  path: "/notifications/read-all",
  tags: ["custom"],
  description: "Marca todas as notificações do usuário como lidas",
  middleware: [requireAuth] as const,
  responses: {
    200: {
      content: {
        "application/json": { schema: z.object({ ok: z.boolean() }) },
      },
      description: "Marcadas",
    },
    401: {
      content: {
        "application/json": { schema: z.object({ error: z.string() }) },
      },
      description: "Não autenticado",
    },
  },
});

customRoutes.openapi(markReadRoute, (c) => {
  const db = getDb();
  const user = c.get("user") as { id_user: number };
  markAllRead(db, user.id_user);
  return c.json({ ok: true }, 200);
});

// ============================================
// F6: evento sazonal ativo (banner público)
// ============================================

const seasonalEventRoute = createRoute({
  method: "get",
  path: "/seasonal-event",
  tags: ["custom"],
  description:
    "Evento sazonal ativo (multiplicador de pontos) — público, para banner na Comunidade",
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z.object({
            active: z.boolean(),
            name: z.string().optional(),
            description: z.string().optional(),
            multiplier: z.number().optional(),
          }),
        },
      },
      description: "Evento ativo ou active:false",
    },
  },
});

customRoutes.openapi(seasonalEventRoute, (c) => {
  const db = getDb();
  const row = db
    .prepare(
      `SELECT name, description, multiplier FROM seasonal_events
       WHERE active = 1 AND datetime('now') BETWEEN starts_at AND ends_at
       ORDER BY multiplier DESC LIMIT 1`,
    )
    .get() as
    | { name: string; description: string | null; multiplier: number }
    | undefined;
  if (!row) return c.json({ active: false }, 200);
  return c.json(
    {
      active: true,
      name: row.name,
      description: row.description ?? undefined,
      multiplier: row.multiplier,
    },
    200,
  );
});

export { customRoutes };
