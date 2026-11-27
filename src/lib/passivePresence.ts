/**
 * Presença passiva: apps antigos que ainda batem /file|/json_db|/v1/catálogo
 * sem X-Partner-Key e sem heartbeat. Vira "sem token" no painel admin.
 *
 * - install_id sintético = hash diário(IP + platform); IP nunca persiste.
 * - Só memória (recordPassiveAccess dirty=false).
 * - Nunca lança: telemetria não pode afetar a resposta.
 */

import { createHash } from "node:crypto";

import { recordPassiveAccess, setPresenceGeo } from "./devicePresence.js";
import { isPublicIp, lookupGeo } from "./geoIp.js";

/** Rotas típicas de cliente (catálogo/mídia). Evita health, admin, docs… */
export function isPassiveClientPath(path: string, method: string): boolean {
  const verb = method.toUpperCase();
  if (verb !== "GET" && verb !== "HEAD") return false;
  const p = (path.split("?")[0] || path).toLowerCase();
  if (p.startsWith("/file/")) return true;
  if (p.startsWith("/json_db/")) return true;
  if (p.startsWith("/db/")) return true;
  return /^\/v1\/(categories|albums|musics|hymnals|bible)(\/|$)/.test(p);
}

function utcDay(now = new Date()): string {
  return now.toISOString().slice(0, 10);
}

/** UUID estável no dia para o mesmo IP+plataforma (sem gravar IP). */
export function passiveInstallId(
  ip: string,
  platform: string,
  day = utcDay(),
): string {
  const hex = createHash("sha256")
    .update(`presence-passive|${day}|${ip}|${platform}`)
    .digest("hex");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    `4${hex.slice(13, 16)}`,
    `a${hex.slice(17, 20)}`,
    hex.slice(20, 32),
  ].join("-");
}

export interface PassivePresenceInput {
  path: string;
  method: string;
  ip: string;
  platform: string;
  appVersion: string | null;
  hasPartner: boolean;
}

/**
 * Se a request parece cliente sem token, registra presença passiva + geo.
 * Chamado pós-next no middleware de telemetria.
 */
export function maybeRecordPassivePresence(input: PassivePresenceInput): void {
  try {
    if (process.env.DEVICE_TELEMETRY_DISABLED === "true") return;
    if (input.hasPartner) return;
    if (!isPassiveClientPath(input.path, input.method)) return;

    // site/unknown: ruído de browser ou portal; não conta como app desatualizado.
    if (input.platform === "unknown" || input.platform === "site") return;

    const ip = input.ip.trim();
    if (!ip || ip === "unknown" || !isPublicIp(ip)) return;

    const appVersion =
      input.appVersion && input.appVersion.length <= 32
        ? input.appVersion
        : null;

    const installId = passiveInstallId(ip, input.platform);
    recordPassiveAccess({
      installId,
      platform: input.platform,
      appVersion,
    });

    void lookupGeo(ip)
      .then((geo) => {
        if (geo) setPresenceGeo(installId, geo);
      })
      .catch(() => {});
  } catch {
    // Engolido: presença passiva nunca impacta tráfego.
  }
}
