import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sendEmail = vi.fn<(...args: unknown[]) => Promise<boolean>>();
const smtpConfigured = vi.fn<() => boolean>();
vi.mock("../../src/v1/custom/mail.service.js", () => ({
  sendEmail: (...args: unknown[]) => sendEmail(...args),
  smtpConfigured: () => smtpConfigured(),
}));

const {
  nomeEmailDe,
  resetCommunityReviewStateForTests,
  reviewCommunityEntry,
  setCommunityReviewEmailSender,
  validarReviewBody,
} = await import("../../src/v1/custom/community-review.service.js");
const { renderCommunityReviewEmail } = await import(
  "../../src/v1/custom/community-review.templates.js"
);

/** Sheets/OAuth falsos: token, linha do testador e PUTs ok. */
const fakeFetch = (async (input: unknown, init?: RequestInit) => {
  const url = String(input);
  if (url.includes("oauth2.googleapis.com")) {
    return new Response(
      JSON.stringify({ access_token: "tok", expires_in: 3600 }),
    );
  }
  if ((init?.method ?? "GET") === "PUT") return new Response("{}");
  return new Response(
    JSON.stringify({ values: [["Testador Exemplo", "testador@exemplo.test"]] }),
  );
}) as typeof fetch;

describe("community-review.service", () => {
  beforeEach(() => {
    resetCommunityReviewStateForTests();
    sendEmail.mockReset();
    smtpConfigured.mockReset();
    process.env.TESTERS_SHEET_ID = "sheet-unit";
    process.env.GOOGLE_CLIENT_ID = "cid";
    process.env.GOOGLE_CLIENT_SECRET = "secret";
    process.env.GOOGLE_REFRESH_TOKEN = "rtok";
  });
  afterEach(() => resetCommunityReviewStateForTests());

  it("rejeita abas que só existem no protótipo do objeto", () => {
    for (const tab of [
      "constructor",
      "toString",
      "__proto__",
      "hasOwnProperty",
    ]) {
      expect(validarReviewBody({ tab, row: 2, acao: "aprovar" })).toBe(
        "tab inválida",
      );
    }
  });

  it("sem remetente injetado, envia pelo SMTP da API", async () => {
    smtpConfigured.mockReturnValue(true);
    sendEmail.mockResolvedValue(true);

    const result = await reviewCommunityEntry(
      { tab: "testadores", row: 2, acao: "aprovar" },
      { fetchImpl: fakeFetch },
    );

    expect(result).toMatchObject({ ok: true, emailEnviado: true });
    expect(sendEmail).toHaveBeenCalledTimes(1);
    const [to, subject, html, text] = sendEmail.mock.calls[0]!;
    expect(to).toBe("testador@exemplo.test");
    expect(subject).toContain("testadores");
    expect(String(html)).toContain("Testador Exemplo");
    expect(String(text)).toContain("Testador Exemplo");
    expect(String(text)).not.toContain("<");
  });

  it("SMTP com falha → moderação ok com emailEnviado false e motivo", async () => {
    smtpConfigured.mockReturnValue(true);
    sendEmail.mockResolvedValue(false);

    const result = await reviewCommunityEntry(
      { tab: "testadores", row: 2, acao: "rejeitar" },
      { fetchImpl: fakeFetch },
    );

    expect(result).toMatchObject({
      ok: true,
      emailEnviado: false,
      emailErro: "falha no envio do e-mail",
    });
  });

  it("SMTP não configurado → não tenta enviar e informa o motivo", async () => {
    smtpConfigured.mockReturnValue(false);

    const result = await reviewCommunityEntry(
      { tab: "desenvolvedores", row: 2, acao: "aprovar" },
      {
        fetchImpl: (async (input: unknown, init?: RequestInit) => {
          const url = String(input);
          if (url.includes("oauth2")) {
            return new Response(
              JSON.stringify({ access_token: "tok", expires_in: 3600 }),
            );
          }
          if ((init?.method ?? "GET") === "PUT") return new Response("{}");
          return new Response(
            JSON.stringify({
              values: [["", "Dev Exemplo", "dev@exemplo.test"]],
            }),
          );
        }) as typeof fetch,
      },
    );

    expect(sendEmail).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      ok: true,
      emailEnviado: false,
      emailErro: "SMTP não configurado",
    });
  });

  it("escapa HTML do nome no template", () => {
    const { html } = renderCommunityReviewEmail("tester_aprovado", {
      nome: '<b>Ana & "Bia"</b>',
    });
    expect(html).toContain("&lt;b&gt;Ana &amp; &quot;Bia&quot;&lt;/b&gt;");
    expect(html).not.toContain("<b>Ana");
  });

  it("nomeEmailDe tolera linha vazia", () => {
    expect(nomeEmailDe("testadores", [])).toEqual({ nome: "", email: "" });
    expect(nomeEmailDe("relatos", [])).toEqual({ nome: "", email: "" });
  });

  it("valida corpo ausente e row não numérica", () => {
    expect(validarReviewBody(undefined as never)).toBe("tab inválida");
    expect(validarReviewBody({ tab: "testadores", row: "2" })).toBe(
      "row inválida (>=2, linha 1 é header)",
    );
  });

  it("template usa o link de WhatsApp informado e nome vazio", () => {
    const { html } = renderCommunityReviewEmail("dev_aprovado", {
      whatsappUrl: "https://chat.whatsapp.com/exemplo",
    });
    expect(html).toContain("https://chat.whatsapp.com/exemplo");
    expect(html).toContain("Olá, !");
  });

  /** Sheets falso configurável por cenário. */
  function sheets(opts: {
    tokenStatus?: number;
    readStatus?: number;
    values?: string[][] | undefined;
    ativoRejects?: boolean;
  }) {
    const calls: string[] = [];
    const impl = (async (input: unknown, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      calls.push(`${method} ${url}`);
      if (url.includes("oauth2")) {
        return new Response(
          JSON.stringify({ access_token: "tok", expires_in: 3600 }),
          { status: opts.tokenStatus ?? 200 },
        );
      }
      if (method === "PUT") {
        if (opts.ativoRejects && url.includes("!J")) throw new Error("rede");
        return new Response("{}");
      }
      return new Response(
        JSON.stringify(
          opts.values === undefined ? {} : { values: opts.values },
        ),
        { status: opts.readStatus ?? 200 },
      );
    }) as typeof fetch;
    return { impl, calls };
  }

  it("OAuth não configurado → erro mapeado, sem chamar o Sheets", async () => {
    delete process.env.GOOGLE_REFRESH_TOKEN;
    const { impl, calls } = sheets({});
    const result = await reviewCommunityEntry(
      { tab: "relatos", row: 2, acao: "resolver" },
      { fetchImpl: impl },
    );
    expect(result).toEqual({
      ok: false,
      error: "Google OAuth não configurado",
    });
    expect(calls).toEqual([]);
  });

  it("falha ao obter token → erro oauth-token-failed", async () => {
    const { impl } = sheets({ tokenStatus: 401 });
    const result = await reviewCommunityEntry(
      { tab: "relatos", row: 2, acao: "resolver" },
      { fetchImpl: impl },
    );
    expect(result).toEqual({ ok: false, error: "oauth-token-failed:401" });
  });

  it("token em cache é reaproveitado entre moderações", async () => {
    smtpConfigured.mockReturnValue(false);
    const { impl, calls } = sheets({ values: [["", "Rep", "r@exemplo.test"]] });
    await reviewCommunityEntry(
      { tab: "relatos", row: 2, acao: "rejeitar" },
      { fetchImpl: impl },
    );
    await reviewCommunityEntry(
      { tab: "relatos", row: 2, acao: "resolver" },
      { fetchImpl: impl },
    );
    expect(calls.filter((c) => c.includes("oauth2"))).toHaveLength(1);
  });

  it("sem TESTERS_SHEET_ID → erro de configuração", async () => {
    delete process.env.TESTERS_SHEET_ID;
    const result = await reviewCommunityEntry(
      { tab: "relatos", row: 2, acao: "resolver" },
      { fetchImpl: sheets({}).impl },
    );
    expect(result).toEqual({
      ok: false,
      error: "TESTERS_SHEET_ID não configurado",
    });
  });

  it("leitura da linha falha → sheet-read-failed", async () => {
    const result = await reviewCommunityEntry(
      { tab: "relatos", row: 2, acao: "resolver" },
      { fetchImpl: sheets({ readStatus: 403 }).impl },
    );
    expect(result).toEqual({ ok: false, error: "sheet-read-failed:403" });
  });

  it("linha vazia ou sem values → Linha não encontrada", async () => {
    for (const values of [undefined, [[]]]) {
      resetCommunityReviewStateForTests();
      const result = await reviewCommunityEntry(
        { tab: "relatos", row: 9, acao: "resolver" },
        { fetchImpl: sheets({ values }).impl },
      );
      expect(result).toEqual({ ok: false, error: "Linha não encontrada" });
    }
  });

  it("linha curta sem nome/email → moderação ok e nenhum e-mail", async () => {
    for (const tab of ["testadores", "desenvolvedores"]) {
      resetCommunityReviewStateForTests();
      const result = await reviewCommunityEntry(
        { tab, row: 2, acao: "rejeitar" },
        { fetchImpl: sheets({ values: [["x"]] }).impl },
      );
      expect(result).toMatchObject({ ok: true, emailEnviado: false });
    }
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("falha ao marcar ativo não derruba a aprovação", async () => {
    smtpConfigured.mockReturnValue(true);
    sendEmail.mockResolvedValue(true);
    const result = await reviewCommunityEntry(
      { tab: "testadores", row: 2, acao: "aprovar" },
      {
        fetchImpl: sheets({
          values: [["Testador Exemplo", "testador@exemplo.test"]],
          ativoRejects: true,
        }).impl,
      },
    );
    expect(result).toMatchObject({ ok: true, status: "aprovado" });
  });

  it("exceção não-Error no envio → motivo genérico", async () => {
    setCommunityReviewEmailSender(async () => {
      throw "falhou";
    });
    const result = await reviewCommunityEntry(
      { tab: "testadores", row: 2, acao: "aprovar" },
      {
        fetchImpl: sheets({
          values: [["Testador Exemplo", "testador@exemplo.test"]],
        }).impl,
      },
    );
    expect(result).toMatchObject({
      ok: true,
      emailEnviado: false,
      emailErro: "erro desconhecido no envio",
    });
  });
});
