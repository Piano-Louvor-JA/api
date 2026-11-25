/**
 * SPEC piano-admin-comunidade-moderacao v2.0.0 (RF-A3/A4) — escrita na sheet
 * de testadores via Sheets API v4, porte do núcleo de
 * piano-site/server/api/admin/community/review.post.ts (ADR-001).
 *
 * Contrato linha-física (ADR-002): row é a linha FÍSICA da aba (1-based,
 * header=1, dados ≥2) — gravada exatamente em {col}{row}.
 *
 * STATUS_COL: testadores L/12, desenvolvedores K/11, relatos I/9.
 * Aprovar testador também grava TRUE em J{row} (ativo).
 * Ordem interna: PUT status (→ PUT ativo) → email. PUT falha → erro propagado
 * sem email; falha de SMTP → nunca falha a moderação já persistida.
 */

import { sendEmail, smtpConfigured } from "./mail.service.js";

const STATUS_COL: Record<string, number> = {
  testadores: 12, // L
  desenvolvedores: 11, // K
  relatos: 9, // I
};

const COL_LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";

/** Ações válidas por aba (paridade com o handler original do site). */
export function acoesValidas(tab: string): string[] {
  return tab === "relatos" ? ["resolver", "rejeitar"] : ["aprovar", "rejeitar"];
}

/** Valida body de review; retorna mensagem de erro ou null se válido. */
export function validarReviewBody(body: {
  tab?: unknown;
  row?: unknown;
  acao?: unknown;
}): string | null {
  const { tab, row, acao } = body ?? {};
  if (!tab || typeof tab !== "string" || !Object.hasOwn(STATUS_COL, tab))
    return "tab inválida";
  if (typeof row !== "number" || !Number.isInteger(row) || row < 2) {
    return "row inválida (>=2, linha 1 é header)";
  }
  if (!acao || typeof acao !== "string" || !acoesValidas(tab).includes(acao)) {
    return `ação inválida para ${tab}`;
  }
  return null;
}

export function novoStatus(tab: string, acao: string): string {
  if (tab === "relatos") return acao === "resolver" ? "resolvido" : "rejeitado";
  return acao === "aprovar" ? "aprovado" : "rejeitado";
}

export function statusColLetter(tab: string): string {
  return COL_LETTERS[STATUS_COL[tab]! - 1]!;
}

// ============================================
// OAuth refresh→access token com cache
// ============================================

let cachedToken: { token: string; exp: number } | null = null;

export async function getAccessToken(
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  if (cachedToken && cachedToken.exp > Date.now() + 60_000)
    return cachedToken.token;
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const refreshToken = process.env.GOOGLE_REFRESH_TOKEN;
  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error("Google OAuth não configurado");
  }
  const res = await fetchImpl("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }).toString(),
  });
  if (!res.ok) throw new Error(`oauth-token-failed:${res.status}`);
  const json = (await res.json()) as {
    access_token: string;
    expires_in: number;
  };
  cachedToken = {
    token: json.access_token,
    exp: Date.now() + json.expires_in * 1000,
  };
  return json.access_token;
}

/** Nome/email conforme schema da aba (testadores: A=nome,B=email; demais: B=nome,C=email). */
export function nomeEmailDe(
  tab: string,
  values: string[],
): { nome: string; email: string } {
  return tab === "testadores"
    ? { nome: values[0] ?? "", email: values[1] ?? "" }
    : { nome: values[1] ?? "", email: values[2] ?? "" };
}

// ============================================
// Email sender injetável (testes; prod usa mail.service)
// ============================================

export type EmailSender = (args: {
  to: string;
  subject: string;
  html: string;
}) => Promise<{
  ok: boolean;
  error?: string;
}>;

let emailSender: EmailSender | null = null;

/** HTML → texto puro para a parte text/plain do e-mail. */
function htmlToText(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&middot;/g, "·")
    .replace(/&copy;/g, "©")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n+/g, "\n\n")
    .trim();
}

/** Remetente padrão: SMTP da própria API (mail.service). */
const smtpSender: EmailSender = async ({ to, subject, html }) => {
  if (!smtpConfigured()) return { ok: false, error: "SMTP não configurado" };
  const ok = await sendEmail(to, subject, html, htmlToText(html));
  return ok ? { ok: true } : { ok: false, error: "falha no envio do e-mail" };
};

export function setCommunityReviewEmailSender(sender: EmailSender): void {
  emailSender = sender;
}

/** Testes: zera cache de token + sender injetado. */
export function resetCommunityReviewStateForTests(): void {
  cachedToken = null;
  emailSender = null;
}

// ============================================
// Fluxo completo de moderação
// ============================================

export type ReviewResult =
  | {
      ok: true;
      tab: string;
      row: number;
      status: string;
      emailEnviado: boolean;
      emailErro?: string;
    }
  | { ok: false; error: string };

export async function reviewCommunityEntry(
  input: { tab: string; row: number; acao: string },
  deps: { fetchImpl?: typeof fetch } = {},
): Promise<ReviewResult> {
  const fetchImpl = deps.fetchImpl ?? fetch;

  const invalid = validarReviewBody(input);
  if (invalid) return { ok: false, error: invalid };

  const { tab, row, acao } = input;
  const sheetId = process.env.TESTERS_SHEET_ID;
  if (!sheetId) return { ok: false, error: "TESTERS_SHEET_ID não configurado" };

  let token: string;
  try {
    token = await getAccessToken(fetchImpl);
  } catch (err: unknown) {
    return { ok: false, error: (err as Error).message };
  }
  const colLetter = statusColLetter(tab);

  // 1) Lê a linha pra pegar nome/email (pro email)
  const linhaRes = await fetchImpl(
    `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${tab}!A${row}:${colLetter}${row}`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  if (!linhaRes.ok)
    return { ok: false, error: `sheet-read-failed:${linhaRes.status}` };
  const linhaJson = (await linhaRes.json()) as { values?: string[][] };
  const values = linhaJson.values?.[0] ?? [];
  if (!values.length) return { ok: false, error: "Linha não encontrada" };

  const { nome, email } = nomeEmailDe(tab, values);

  // 2) Atualiza célula de status — linha FÍSICA exata (ADR-002)
  const status = novoStatus(tab, acao);
  const putRes = await fetchImpl(
    `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${tab}!${colLetter}${row}?valueInputOption=USER_ENTERED`,
    {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ values: [[status]] }),
    },
  );
  if (!putRes.ok) {
    // RF-A5: PUT falha → erro propagado, email nem tentado, sem ok:true.
    return { ok: false, error: `sheet-write-failed:${putRes.status}` };
  }

  // 3) Aprovar testador também ativa (coluna J ativo=TRUE) — não falha a aprovação.
  if (tab === "testadores" && acao === "aprovar") {
    await fetchImpl(
      `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/testadores!J${row}?valueInputOption=USER_ENTERED`,
      {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ values: [["TRUE"]] }),
      },
    ).catch(() => {});
  }

  // 4) Email de resposta (isolado — RF-A4). relatos: sem email no review.
  let emailEnviado = false;
  let emailErro: string | undefined;

  let template:
    | "tester_aprovado"
    | "tester_rejeitado"
    | "dev_aprovado"
    | "dev_rejeitado"
    | null = null;
  if (tab === "testadores")
    template = acao === "aprovar" ? "tester_aprovado" : "tester_rejeitado";
  if (tab === "desenvolvedores")
    template = acao === "aprovar" ? "dev_aprovado" : "dev_rejeitado";

  if (template && email) {
    try {
      const { renderCommunityReviewEmail } = await import(
        "./community-review.templates.js"
      );
      const { subject, html } = renderCommunityReviewEmail(template, { nome });
      const result = await (emailSender ?? smtpSender)({
        to: email,
        subject,
        html,
      });
      emailEnviado = result.ok;
      emailErro = result.error;
    } catch (err: unknown) {
      emailEnviado = false;
      emailErro =
        err instanceof Error ? err.message : "erro desconhecido no envio";
    }
  }

  return { ok: true, tab, row, status, emailEnviado, emailErro };
}
