/**
 * Telemetria de dispositivos online (app/.planning/telemetria-dispositivos)
 * + histórico 90d / rankings / mapa (api/.planning/telemetria-historico).
 *
 * - POST /v1/telemetry/heartbeat — público, sempre 204.
 * - GET /v1/telemetry/online — admin: janela 11 min.
 * - GET /v1/telemetry/history|rankings|map — admin: janela 90d.
 *
 * Kill switch: DEVICE_TELEMETRY_DISABLED=true → heartbeat 204 sem gravar.
 */

import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";

import {
  type DeviceHeartbeat,
  listOnline,
  ONLINE_WINDOW_MS,
  recordHeartbeat,
  setPresenceGeo,
} from "../../lib/devicePresence.js";
import {
  HISTORY_WINDOW_DAYS,
  listMapPoints,
  listRankings,
  summarizeHistory,
} from "../../lib/devicePresenceHistory.js";
import { lookupGeo } from "../../lib/geoIp.js";
import type { PartnerEnv } from "../../middleware/partnerKey.js";
import {
  clientIp,
  clientPlatform,
  VALID_PLATFORMS,
} from "../../middleware/telemetry.js";
import { adminAuth } from "../custom/admin.middleware.js";
import { optionalAuth } from "../custom/auth.middleware.js";
import { firebaseAuth } from "../custom/firebase-auth.middleware.js";

/** Texto opcional: trim, vazio vira null; inválido/grande demais vira null. */
const optText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .transform((v) => v || null)
    .nullish()
    .catch(null);

/**
 * Contrato do corpo (snake_case). Só `install_id` é obrigatório; o resto
 * tem fallback por campo para nunca derrubar o heartbeat.
 */
export const HeartbeatBodySchema = z.object({
  install_id: z.uuid(),
  platform: optText(32),
  app_version: optText(32),
  os: z
    .object({
      name: optText(64),
      release: optText(64),
      arch: optText(16),
    })
    .nullish()
    .catch(null),
  locale: optText(16),
  timezone: optText(64),
  district: optText(80),
  church: optText(80),
});

const heartbeatRoute = createRoute({
  method: "post",
  path: "/heartbeat",
  tags: ["telemetry"],
  description:
    "Sinal de 'online' dos clientes (a cada 5 min). Corpo: install_id (UUID), platform, app_version, os{name,release,arch}, locale, timezone, district, church. Sempre 204.",
  responses: {
    204: { description: "Registrado (ou silenciosamente ignorado)" },
  },
});

const OnlineDeviceSchema = z.object({
  install_id_short: z.string(),
  platform: z.string(),
  app_version: z.string().nullable(),
  os: z.string().nullable(),
  district: z.string().nullable(),
  church: z.string().nullable(),
  city: z.string().nullable(),
  region: z.string().nullable(),
  country: z.string().nullable(),
  identified: z.boolean(),
  first_seen: z.string(),
  last_seen: z.string(),
});

const errorSchema = {
  content: {
    "application/json": { schema: z.object({ error: z.string() }) },
  },
};

const onlineRoute = createRoute({
  method: "get",
  path: "/online",
  tags: ["telemetry"],
  description:
    "Dispositivos online (último sinal há até 11 min). Gate ADMIN_EMAILS fail-closed.",
  request: {
    query: z.object({
      platform: z.string().optional(),
      region: z.string().optional(),
      district: z.string().optional(),
      q: z.string().optional(),
    }),
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z.object({
            generated_at: z.string(),
            online_window_min: z.number(),
            totals: z.object({
              online: z.number(),
              identified: z.number(),
              by_platform: z.record(z.string(), z.number()),
            }),
            devices: z.array(OnlineDeviceSchema),
          }),
        },
      },
      description: "Dispositivos online",
    },
    401: { ...errorSchema, description: "Não autenticado" },
    403: { ...errorSchema, description: "Sem permissão" },
  },
});

export const telemetryRoutes = new OpenAPIHono<PartnerEnv>();

function isDisabled(): boolean {
  return process.env.DEVICE_TELEMETRY_DISABLED === "true";
}

telemetryRoutes.openapi(heartbeatRoute, async (c) => {
  try {
    if (isDisabled()) return c.body(null, 204);

    const raw = await c.req.json().catch(() => null);
    const parsed = HeartbeatBodySchema.safeParse(raw);
    if (!parsed.success) return c.body(null, 204);
    const body = parsed.data;

    const platform =
      body.platform && VALID_PLATFORMS.has(body.platform.toLowerCase())
        ? body.platform.toLowerCase()
        : clientPlatform(c);

    const heartbeat: DeviceHeartbeat = {
      installId: body.install_id.toLowerCase(),
      platform,
      appVersion: body.app_version ?? null,
      osName: body.os?.name ?? null,
      osRelease: body.os?.release ?? null,
      osArch: body.os?.arch ?? null,
      locale: body.locale ?? null,
      timezone: body.timezone ?? null,
      district: body.district ?? null,
      church: body.church ?? null,
      partnerId: c.get("partner")?.id ?? null,
    };
    recordHeartbeat(heartbeat);

    // Geo fora do caminho da resposta; o IP só vive no cache do geoIp.
    const ip = clientIp(c);
    void lookupGeo(ip)
      .then((geo) => {
        if (geo) setPresenceGeo(heartbeat.installId, geo);
      })
      .catch(() => {});
  } catch {
    // Telemetria nunca derruba a request do cliente.
  }
  return c.body(null, 204);
});

const periodQuery = z.object({
  days: z.coerce.number().int().min(1).max(HISTORY_WINDOW_DAYS).optional(),
});

const historyRoute = createRoute({
  method: "get",
  path: "/history",
  tags: ["telemetry"],
  description:
    "Resumo do histórico de presença (até 90 dias). Gate ADMIN_EMAILS.",
  request: { query: periodQuery },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z.object({
            period_days: z.number(),
            generated_at: z.string(),
            online_window_min: z.number(),
            totals: z.object({
              seen: z.number(),
              online: z.number(),
              offline_seen: z.number(),
              with_church: z.number(),
              with_geo: z.number(),
              by_platform: z.record(z.string(), z.number()),
            }),
          }),
        },
      },
      description: "Resumo do período",
    },
    401: { ...errorSchema, description: "Não autenticado" },
    403: { ...errorSchema, description: "Sem permissão" },
  },
});

const rankingsRoute = createRoute({
  method: "get",
  path: "/rankings",
  tags: ["telemetry"],
  description:
    "Ranking de dispositivos no período (igreja, distrito, cidade, UF, país, SO).",
  request: {
    query: periodQuery.extend({
      by: z.enum(["church", "district", "city", "region", "country", "os"]),
      limit: z.coerce.number().int().min(1).max(200).optional(),
    }),
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z.object({
            period_days: z.number(),
            by: z.string(),
            generated_at: z.string(),
            items: z.array(
              z.object({
                key: z.string(),
                label: z.string(),
                devices: z.number(),
                online: z.number(),
              }),
            ),
          }),
        },
      },
      description: "Itens do ranking",
    },
    401: { ...errorSchema, description: "Não autenticado" },
    403: { ...errorSchema, description: "Sem permissão" },
  },
});

const mapRoute = createRoute({
  method: "get",
  path: "/map",
  tags: ["telemetry"],
  description:
    "Pontos do mapa (país): verde=online agora, cinza=viu no período e offline.",
  request: {
    query: periodQuery.extend({
      country: z.string().trim().min(2).max(2).optional(),
    }),
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z.object({
            period_days: z.number(),
            country: z.string(),
            generated_at: z.string(),
            online_window_min: z.number(),
            points: z.array(
              z.object({
                city: z.string().nullable(),
                region: z.string(),
                country: z.string(),
                devices: z.number(),
                online: z.number(),
                is_online: z.boolean(),
              }),
            ),
          }),
        },
      },
      description: "Pontos agregados por cidade/UF",
    },
    401: { ...errorSchema, description: "Não autenticado" },
    403: { ...errorSchema, description: "Sem permissão" },
  },
});

// /v1/telemetry não passa pelos middlewares de sessão do /v1/custom:
// resolve o usuário (token opaco ou Firebase) antes do gate de admin.
telemetryRoutes.use("/online", optionalAuth, firebaseAuth, adminAuth);
telemetryRoutes.use("/history", optionalAuth, firebaseAuth, adminAuth);
telemetryRoutes.use("/rankings", optionalAuth, firebaseAuth, adminAuth);
telemetryRoutes.use("/map", optionalAuth, firebaseAuth, adminAuth);

telemetryRoutes.openapi(onlineRoute, (c) => {
  const { platform, region, district, q } = c.req.valid("query");
  const { totals, devices } = listOnline(Date.now(), {
    platform,
    region,
    district,
    q,
  });
  c.header("Cache-Control", "no-store");
  return c.json(
    {
      generated_at: new Date().toISOString(),
      online_window_min: ONLINE_WINDOW_MS / 60_000,
      totals,
      devices,
    },
    200,
  );
});

telemetryRoutes.openapi(historyRoute, (c) => {
  const { days } = c.req.valid("query");
  c.header("Cache-Control", "no-store");
  return c.json(summarizeHistory(days ?? HISTORY_WINDOW_DAYS), 200);
});

telemetryRoutes.openapi(rankingsRoute, (c) => {
  const { days, by, limit } = c.req.valid("query");
  c.header("Cache-Control", "no-store");
  return c.json(
    listRankings(by, days ?? HISTORY_WINDOW_DAYS, limit ?? 50),
    200,
  );
});

telemetryRoutes.openapi(mapRoute, (c) => {
  const { days, country } = c.req.valid("query");
  c.header("Cache-Control", "no-store");
  return c.json(
    listMapPoints(days ?? HISTORY_WINDOW_DAYS, country ?? "BR"),
    200,
  );
});
