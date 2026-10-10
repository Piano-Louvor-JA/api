// G1 guardrail E2E (D9): base URL dos scripts e2e + guard anti-produção.
// PALCO_E2E_API_URL defaulta localhost:3100 (comportamento preservado);
// se apontar para host de produção, aborta antes de qualquer request.
export const PROD_HOSTS = ["api.pianolouvorja.com.br"];

export function resolveApiBase(source = "process.env") {
  const base = process.env.PALCO_E2E_API_URL ?? "http://localhost:3100";
  let host;
  try {
    host = new URL(base).hostname.toLowerCase();
  } catch {
    throw new Error(`PALCO_E2E_API_URL inválida: ${base}`);
  }
  if (PROD_HOSTS.includes(host)) {
    throw new Error(
      `E2E apontando para PRODUÇÃO (${host} em ${source}) — use staging (api-stg.pianolouvorja.com.br), localhost ou mock.`,
    );
  }
  return base;
}

/** http(s):// → ws(s):// para as URLs do relay. */
export function toWs(baseUrl) {
  return baseUrl.replace(/^http/, "ws");
}
