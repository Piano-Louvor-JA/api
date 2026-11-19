/**
 * Atualização do apk Android pela própria API (sem consultar o GitHub em cada
 * celular, que tem limite de 60 consultas/hora por IP).
 *
 * Na VPS, `node dist/cli/fetch-apk.js [versão]` baixa o apk da release do
 * GitHub, confere o SHA-256 e grava aqui:
 *   <APP_UPDATES_DIR>/android/louvorja-piano-<versão>.apk
 *   <APP_UPDATES_DIR>/android/version.json   (escrito por último)
 * O padrão é ./data/updates, dentro do volume ./data que já persiste.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { z } from "@hono/zod-openapi";

/**
 * Nome dos apks publicados: só esse formato é servido (nada de ../).
 * A release traz o universal (`-universal`) e APKs por ABI; só o universal
 * (ou o nome antigo, sem sufixo) serve a qualquer celular.
 */
export const APK_FILE_PATTERN =
  /^louvorja-piano-(\d+\.\d+\.\d+)(?:-universal)?\.apk$/;

export const ManifestSchema = z.object({
  version: z.string().regex(/^\d+\.\d+\.\d+$/),
  file: z.string().regex(APK_FILE_PATTERN),
  size: z.number().int().positive(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  notes: z.string().default(""),
  published_at: z.string().nullable().default(null),
});

export type AppUpdateManifest = z.infer<typeof ManifestSchema>;

export function updatesDir(): string {
  return path.resolve(process.env.APP_UPDATES_DIR ?? "./data/updates");
}

export function androidDir(): string {
  return path.join(updatesDir(), "android");
}

export function manifestPath(): string {
  return path.join(androidDir(), "version.json");
}

/**
 * Manifesto publicado, ou null quando não há (ou está inválido, ou o apk
 * que ele aponta sumiu): nesses casos o app cai no caminho de reserva.
 */
export function readManifest(): AppUpdateManifest | null {
  try {
    const file = manifestPath();
    if (!existsSync(file)) return null;
    const parsed = ManifestSchema.safeParse(
      JSON.parse(readFileSync(file, "utf8")),
    );
    if (!parsed.success) return null;
    const apk = apkPath(parsed.data.file);
    if (!apk || statSync(apk).size !== parsed.data.size) return null;
    return parsed.data;
  } catch {
    return null;
  }
}

/** Caminho do apk publicado, ou null se o nome não for válido ou não existir. */
export function apkPath(file: string): string | null {
  if (!APK_FILE_PATTERN.test(file)) return null;
  const full = path.join(androidDir(), file);
  return existsSync(full) ? full : null;
}
