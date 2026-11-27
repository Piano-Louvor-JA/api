/**
 * Telemetria de dispositivos online (app/.planning/telemetria-dispositivos).
 *
 * - POST /v1/telemetry/heartbeat — público, chamado pelos clientes a cada
 *   5 min. SEMPRE 204: corpo inválido é ignorado e campo podre é descartado
 *   (nunca 4xx para o app). Geo por IP resolve fora do caminho da resposta.
 * - GET /v1/telemetry/online — admin (ADMIN_EMAILS, fail-closed): quem
 *   mandou sinal nos últimos 11 min, com totais e filtros. Sem IP e sem o
 *   install_id completo.
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
  source: z.enum(["heartbeat", "passive"]),
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
              unidentified: z.number(),
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

// /v1/telemetry não passa pelos middlewares de sessão do /v1/custom:
// resolve o usuário (token opaco ou Firebase) antes do gate de admin.
telemetryRoutes.use("/online", optionalAuth, firebaseAuth, adminAuth);

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
