/**
 * G1 (guardrail E2E) — detector de fixtures de teste E2E.
 *
 * Última linha de defesa contra dados de teste em produção: as rotas de
 * escrita (/auth/register, /collections, /collections/{id}/musics) chamam
 * isE2EFixture() no topo do handler e devolvem 403 E2E_FIXTURE_BLOCKED
 * quando o guard está ativo.
 *
 * Padrões da SPEC §3.1 (D3) — case-insensitive, sem inventar além:
 *  - sufixo de email (domínio exato após @, 1 nível): teste.com, test.com,
 *    probe.invalid, example.com, exemplo.com;
 *  - nome (displayName/name): ^e2e[_-], ^slja_e2e_, ^probe, prefixo "E2E ".
 *
 * Flag BLOCK_E2E_FIXTURES (D1, trivaluada):
 *  - unset  → bloqueia só em NODE_ENV=production;
 *  - "true" → bloqueia sempre;
 *  - "false" → nunca bloqueia (escape explícito para staging rodar E2E).
 *
 * Leitura por-request (D6): NÃO faz parte do validateEnv (fail-fast no
 * boot) — mesmo padrão do PALCO_RELAY_KEY.
 */

const E2E_EMAIL_DOMAINS = new Set([
  "teste.com",
  "test.com",
  "probe.invalid",
  "example.com",
  "exemplo.com",
]);

const E2E_NAME_PREFIXES = [
  "e2e_",
  "e2e-",
  "slja_e2e_",
  "probe",
  "e2e ",
] as const;

export interface E2EFixtureFields {
  email?: string | null;
  name?: string | null;
}

/** Campo que casou (para a mensagem do 403) ou null se não é fixture. */
export function whichE2EFixtureField(
  fields: E2EFixtureFields,
): "email" | "name" | null {
  if (typeof fields.email === "string" && fields.email.length > 0) {
    const at = fields.email.lastIndexOf("@");
    if (at >= 0) {
      const domain = fields.email
        .slice(at + 1)
        .trim()
        .toLowerCase();
      if (domain.length > 0 && E2E_EMAIL_DOMAINS.has(domain)) {
        return "email";
      }
    }
  }
  if (typeof fields.name === "string" && fields.name.length > 0) {
    const name = fields.name.toLowerCase();
    if (E2E_NAME_PREFIXES.some((prefix) => name.startsWith(prefix))) {
      return "name";
    }
  }
  return null;
}

/** true se algum campo casa com os padrões de fixture E2E (SPEC §3.1). */
export function isE2EFixture(fields: E2EFixtureFields): boolean {
  return whichE2EFixtureField(fields) !== null;
}

/**
 * Guard ativo? (D1):
 *  - BLOCK_E2E_FIXTURES="true"  → sempre;
 *  - BLOCK_E2E_FIXTURES="false" → nunca;
 *  - unset (ou valor não reconhecido) → só em NODE_ENV=production.
 */
export function isE2EFixtureBlockEnabled(
  env: {
    BLOCK_E2E_FIXTURES?: string | undefined;
    NODE_ENV?: string | undefined;
  } = process.env,
): boolean {
  const flag = env.BLOCK_E2E_FIXTURES?.trim().toLowerCase();
  if (flag === "true") return true;
  if (flag === "false") return false;
  return env.NODE_ENV === "production";
}

/** Body do 403 (D2). field = campo que casou ("email" | "name"). */
export function e2eFixtureBlockedJson(field: "email" | "name"): {
  error: string;
  message: string;
} {
  const label = field === "email" ? "E-mail" : "Nome";
  return {
    error: "E2E_FIXTURE_BLOCKED",
    message: `${label} não permitido em produção: dados de teste E2E. Env BLOCK_E2E_FIXTURES=false desativa (apenas staging/local).`,
  };
}
