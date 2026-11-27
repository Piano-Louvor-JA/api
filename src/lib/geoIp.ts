/**
 * Cidade/UF/país por IP para a telemetria de dispositivos.
 *
 * - Provedor configurável por `GEOIP_URL` (template com `{ip}`), ex.:
 *   `https://ipinfo.io/{ip}/json` (o mesmo do monitoramento da VPS).
 *   Sem env: desligado (devolve null).
 * - Cache em memória por IP (24 h, LRU simples) — o IP só existe como chave
 *   deste cache, com TTL; nunca é gravado em banco nem devolvido em resposta.
 * - Timeout curto e nunca lança: geo é opcional, o heartbeat não espera.
 */

import { isIP } from "node:net";

import type { GeoInfo } from "./devicePresence.js";

const CACHE_TTL_MS = 24 * 3600_000;
const CACHE_MAX = 5_000;
const DEFAULT_TIMEOUT_MS = 1_500;
let cacheMax = CACHE_MAX;

/** Testes: reduz o LRU para exercitar eviction sem 5k lookups. `0` é válido. */
export function setGeoCacheMaxForTests(n: number | null): void {
  cacheMax = n == null ? CACHE_MAX : Math.max(0, n);
}

type FetchLike = (
  url: string,
  init?: { signal?: AbortSignal },
) => Promise<Response>;

let fetchImpl: FetchLike | null = null;
const cache = new Map<string, { geo: GeoInfo | null; expires: number }>();

/** Testes: injeta fetch fake (null volta ao fetch global). */
export function setGeoFetchForTests(fn: FetchLike | null): void {
  fetchImpl = fn;
}

export function resetGeoIpForTests(): void {
  cache.clear();
  cacheMax = CACHE_MAX;
}

/** IPv4/IPv6 roteável na internet (fora de loopback, privado e link-local). */
export function isPublicIp(ip: string): boolean {
  const version = isIP(ip);
  if (version === 4) {
    const [a, b] = ip.split(".").map(Number);
    if (a === 10 || a === 127 || a === 0) return false;
    if (a === 169 && b === 254) return false;
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 192 && b === 168) return false;
    if (a === 100 && b >= 64 && b <= 127) return false; // CGNAT
    return true;
  }
  if (version === 6) {
    const lower = ip.toLowerCase();
    if (lower === "::1" || lower === "::") return false;
    if (/^fe[89ab]/.test(lower)) return false; // link-local
    if (/^f[cd]/.test(lower)) return false; // ULA
    return true;
  }
  return false;
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/**
 * Estados do Brasil por nome (sem acento, minúsculas) → sigla da UF.
 * O ipinfo.io (provedor do monitoramento da VPS) devolve só o nome, às
 * vezes em inglês ("Federal District") ou sem acento ("Amapa").
 */
const BR_UF: Record<string, string> = {
  acre: "AC",
  alagoas: "AL",
  amapa: "AP",
  amazonas: "AM",
  bahia: "BA",
  ceara: "CE",
  "distrito federal": "DF",
  "federal district": "DF",
  "espirito santo": "ES",
  goias: "GO",
  maranhao: "MA",
  "mato grosso": "MT",
  "mato grosso do sul": "MS",
  "minas gerais": "MG",
  para: "PA",
  paraiba: "PB",
  parana: "PR",
  pernambuco: "PE",
  piaui: "PI",
  "rio de janeiro": "RJ",
  "rio grande do norte": "RN",
  "rio grande do sul": "RS",
  rondonia: "RO",
  roraima: "RR",
  "santa catarina": "SC",
  "sao paulo": "SP",
  sergipe: "SE",
  tocantins: "TO",
};

function brazilianUf(region: string | null): string | null {
  if (!region) return null;
  const key = region
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/^(state of|estado d[eo]a?)\s+/, "")
    .trim();
  return BR_UF[key] ?? null;
}

/**
 * Normaliza os formatos mais comuns (ip-api, ipapi.co, ipwho.is, ipinfo).
 * Prefere a sigla da UF (`region_code`, `region` curto do ip-api ou, no
 * Brasil, o nome do estado convertido).
 */
export function parseGeoResponse(raw: unknown): GeoInfo | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (r.status === "fail" || r.success === false) return null;

  const regionCode = str(r.region_code) ?? str(r.regionCode);
  const region = str(r.region);
  const regionName = str(r.regionName);
  const country = str(r.countryCode) ?? str(r.country_code) ?? str(r.country);
  const isBrazil = country?.toUpperCase() === "BR";
  const geo: GeoInfo = {
    city: str(r.city),
    region:
      regionCode ??
      (region && region.length <= 3 ? region : null) ??
      (isBrazil ? (brazilianUf(regionName) ?? brazilianUf(region)) : null) ??
      regionName ??
      region,
    country,
  };
  return geo.city || geo.region || geo.country ? geo : null;
}

function remember(ip: string, geo: GeoInfo | null, now: number): void {
  if (cache.size >= cacheMax) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(ip, { geo, expires: now + CACHE_TTL_MS });
}

export async function lookupGeo(
  ip: string,
  now = Date.now(),
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<GeoInfo | null> {
  const template = process.env.GEOIP_URL;
  if (!template || !isPublicIp(ip)) return null;

  const hit = cache.get(ip);
  if (hit && hit.expires > now) return hit.geo;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let geo: GeoInfo | null = null;
  try {
    const doFetch = fetchImpl ?? (globalThis.fetch as FetchLike);
    const res = await doFetch(
      template.replace("{ip}", encodeURIComponent(ip)),
      {
        signal: controller.signal,
      },
    );
    if (res.ok) geo = parseGeoResponse(await res.json());
  } catch {
    // Provedor fora/lento: sem geo desta vez.
  } finally {
    clearTimeout(timer);
  }
  // Falha também entra no cache (evita martelar o provedor), mas por menos tempo.
  remember(ip, geo, geo ? now : now - CACHE_TTL_MS + 10 * 60_000);
  return geo;
}
