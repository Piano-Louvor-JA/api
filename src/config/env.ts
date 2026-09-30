// RF-04: validação de env no boot — fail fast com Zod
import { z } from "zod";

const envSchema = z.object({
  PORT: z.coerce.number().int().min(1).max(65535).default(3100),
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),
  DB_PATH: z.string().default("./data/catalog.db"),
  MEDIA_DIR: z.string().default("./media"),
  UPSTREAM_API: z.string().url().default("https://api.louvorja.com.br"),
  UPSTREAM_FALLBACK_API: z
    .string()
    .url()
    .default("https://api.louvorja.workers.dev"),
  CORS_ORIGINS: z.string().default("*"),
  TRUSTED_PROXY: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),
});

export type Env = z.infer<typeof envSchema>;

/**
 * Valida variáveis de ambiente. Recebe um objeto (injetável para testes).
 * Lança com mensagem clara indicando qual variável está inválida.
 */
export function validateEnv(raw: Record<string, string | undefined>): Env {
  const parsed = envSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const path = issue?.path.join(".");
    throw new Error(
      `Env inválida: ${path} — ${issue?.message}. Corrija o .env e reinicie.`,
    );
  }
  // SEC-142 (api#142): relay do palco com HMAC de chave vazia = qualquer um
  // forja token de sala. Em produção, chave é OBRIGATÓRIA — API não sobe sem.
  // Em dev/test, permite ausente (relay falha seguro: getRoom → null).
  if (parsed.data.NODE_ENV === "production" && !raw.PALCO_RELAY_KEY?.trim()) {
    throw new Error(
      "Env inválida: PALCO_RELAY_KEY é obrigatória em produção (SEC-142). Defina uma chave forte no .env e reinicie.",
    );
  }
  return parsed.data;
}
