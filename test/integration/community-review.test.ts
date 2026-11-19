import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import { type SeededDb, setupSeededDb } from "../helpers/seeded-db.js";

const { registerUser } = await import("./helpers/custom-auth-helpers.js");
const { resetCommunityReviewStateForTests, setCommunityReviewEmailSender } =
  await import("../../src/v1/custom/community-review.service.js");

/**
 * SPEC piano-admin-comunidade-moderacao v2.0.0 (RF-A1..A6 + RF-C3).
 *
 * Contrato linha-física (ADR-002): o par {tab, row} é a linha FÍSICA da aba
 * (1-based, header=1, dados ≥2). O PUT sai EXATAMENTE na célula física —
 * NUNCA deslocado por filtro (asserts negativos K2/K3/L1/L3 matam off-by-one).
 *
 * Zero rede real: fetch global stubado com gravação de chamadas; email com
 * sender injetado (setCommunityReviewEmailSender).
 */

const FIXTURES = join(import.meta.dirname, "../fixtures/community");

/** Linha física (i + 2) de cada pendente na fixture, espelhando o parse gviz do site. */
function parseCsvRows(csv: string): string[][] {
  const rows: string[][] = [];
  let field = "";
  let row: string[] = [];
  let quoted = false;
  for (let i = 0; i < csv.length; i++) {
    const ch = csv[i]!;
    if (quoted) {
      if (ch === '"' && csv[i + 1] === '"') {
        field += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else if (ch !== "\r") field += ch;
  }
  if (field || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

/** Linha física (i + 2) de cada pendente na fixture, espelhando o parse gviz do site. */
function pendentesDaFixture(
  tab: string,
): Array<{ row: number; nome: string; status: string }> {
  const rows = parseCsvRows(
    readFileSync(join(FIXTURES, `${tab}.csv`), "utf-8"),
  );
  return rows
    .slice(1)
    .map((cells, idx) => {
      const nomeCol = tab === "testadores" ? 0 : 1;
      return {
        row: idx + 2,
        nome: (cells[nomeCol] ?? "").trim(),
        status: (cells[cells.length - 1] ?? "").trim().toLowerCase(),
      };
    })
    .filter((r) => r.nome.length >= 2 && r.status === "pendente");
}

describe("POST /v1/custom/admin/community/review", () => {
  let app: SeededDb;
  let router: any;
  let reviewerToken: string;
  let plebeuToken: string;
  let calls: string[];
  let emailResult: { ok: boolean; error?: string };
  let fetchMock: any;

  const auth = (t: string) => ({
    authorization: `Bearer ${t}`,
    "X-Tenant": "piano",
  });
  const post = (token: string | null, body: unknown) =>
    router.request("/v1/custom/admin/community/review", {
      method: "POST",
      headers: {
        ...(token ? auth(token) : { "X-Tenant": "piano" }),
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });

  beforeAll(async () => {
    process.env.ADMIN_EMAILS = "";
    process.env.COMMUNITY_REVIEWER_EMAILS = "curador@test.local";
    process.env.TESTERS_SHEET_ID = "sheet-test-1";
    process.env.GOOGLE_CLIENT_ID = "cid";
    process.env.GOOGLE_CLIENT_SECRET = "secret";
    process.env.GOOGLE_REFRESH_TOKEN = "rtok";
    app = await setupSeededDb();
    router = app.router;
    reviewerToken = registerUser("curador@test.local", "SenhaForte1!").token;
    plebeuToken = registerUser("plebeu@test.local", "SenhaForte1!").token;

    // Stub do fetch global: grava "METHOD url[ body]" e responde como a Sheets API.
    calls = [];
    fetchMock = async (input: any, init?: any) => {
      const url = String(typeof input === "string" ? input : input.url);
      const method = (init?.method ?? "GET").toUpperCase();
      let body = "";
      if (init?.body) {
        body =
          typeof init.body === "string" ? init.body : JSON.stringify(init.body);
      }
      calls.push(`${method} ${url}${body ? ` ${body}` : ""}`);

      if (url.includes("oauth2.googleapis.com/token")) {
        return new Response(
          JSON.stringify({ access_token: "tok-1", expires_in: 3600 }),
          { status: 200 },
        );
      }
      if (method === "PUT") {
        return new Response(JSON.stringify({}), { status: 200 });
      }
      // GET da linha: extrai row da URL …/values/<tab>!A<row>:L<row>
      const m = url.match(/values\/(\w+)!A(\d+):/);
      const tabName = m?.[1] ?? "testadores";
      const rowN = Number(m?.[2] ?? 2);
      const rows: Record<string, string[][]> = {
        testadores: [["Jeydson", "garciajeydson@gmail.com"]],
        desenvolvedores: [
          ["", "invalid", "", "", "", "", "", "", "", "", "pendente"],
          [
            "",
            "Felipe Nascimento Santos",
            "fn0501925@gmail.com",
            "",
            "",
            "",
            "",
            "",
            "",
            "",
            "pendente",
          ],
          [
            "",
            "Lucas da Silva Vieira",
            "lucassilvavieira2102@gmail.com",
            "",
            "",
            "",
            "",
            "",
            "",
            "",
            "pendente",
          ],
        ],
        relatos: [["Reporter", "rep@test.local"]],
      };
      const values = rows[tabName]?.[rowN - 2] ?? [];
      return new Response(
        JSON.stringify(values.length ? { values: [values] } : {}),
        {
          status: 200,
        },
      );
    };
    vi.stubGlobal("fetch", fetchMock);

    setCommunityReviewEmailSender(async () => {
      calls.push(
        `email ${emailResult.ok ? "ok" : `erro:${emailResult.error}`}`,
      );
      if (!emailResult.ok) throw new Error(emailResult.error ?? "smtp-down");
      return { ok: true };
    });
  });

  beforeEach(() => {
    calls = [];
    emailResult = { ok: true };
    // reseta cache do OAuth token entre testes e REINJETA o sender
    // (resetCommunityReviewStateForTests zera o sender injetado no beforeAll)
    resetCommunityReviewStateForTests();
    setCommunityReviewEmailSender(async () => {
      calls.push(
        `email ${emailResult.ok ? "ok" : `erro:${emailResult.error}`}`,
      );
      if (!emailResult.ok) throw new Error(emailResult.error ?? "smtp-down");
      return { ok: true };
    });
    // REARMA o fetch mock completo (RF-A5 pode ter substituído por um failing)
    vi.stubGlobal("fetch", fetchMock);
  });

  afterAll(() => {
    vi.unstubAllGlobals();
    delete process.env.COMMUNITY_REVIEWER_EMAILS;
    delete process.env.TESTERS_SHEET_ID;
    delete process.env.GOOGLE_CLIENT_ID;
    delete process.env.GOOGLE_CLIENT_SECRET;
    delete process.env.GOOGLE_REFRESH_TOKEN;
    resetCommunityReviewStateForTests();
    app.cleanup();
  });

  it("RF-A2: sem token → 401", async () => {
    const res = await post(null, {
      tab: "testadores",
      row: 2,
      acao: "aprovar",
    });
    expect(res.status).toBe(401);
  });

  it("RF-A2 fail-closed: sem COMMUNITY_REVIEWER_EMAILS → 403 mesmo com token válido", async () => {
    delete process.env.COMMUNITY_REVIEWER_EMAILS;
    const res = await post(plebeuToken, {
      tab: "testadores",
      row: 2,
      acao: "aprovar",
    });
    expect(res.status).toBe(403);
    process.env.COMMUNITY_REVIEWER_EMAILS = "curador@test.local";
  });

  it("RF-A2: token sem papel → 403 uniforme", async () => {
    const res = await post(plebeuToken, {
      tab: "testadores",
      row: 2,
      acao: "aprovar",
    });
    expect(res.status).toBe(403);
  });

  it("RF-A1: validação — tab inválida / row < 2 / row não-inteira / ação inválida por tab → 400 sem efeito colateral", async () => {
    const casos = [
      { tab: "outras", row: 2, acao: "aprovar" },
      { tab: "testadores", row: 1, acao: "aprovar" },
      { tab: "testadores", row: 0, acao: "aprovar" },
      { tab: "testadores", row: 2.5, acao: "aprovar" },
      { tab: "testadores", row: 2, acao: "resolver" },
      { tab: "relatos", row: 2, acao: "aprovar" },
      { tab: "testadores", row: 2, acao: "inventar" },
    ];
    for (const body of casos) {
      const res = await post(reviewerToken, body);
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
    expect(calls.filter((c) => c.startsWith("PUT")).length).toBe(0);
  });

  it("RF-A3/A4/A5: aprovar testador row 2 → PUT L2 + PUT J2=TRUE + email, nessa ordem", async () => {
    const res = await post(reviewerToken, {
      tab: "testadores",
      row: 2,
      acao: "aprovar",
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({
      ok: true,
      tab: "testadores",
      row: 2,
      status: "aprovado",
      emailEnviado: true,
    });
    const puts = calls.filter((c) => c.startsWith("PUT"));
    expect(
      puts.some(
        (c) => c.includes("/values/testadores!L2?") && c.includes("aprovado"),
      ),
    ).toBe(true);
    expect(
      puts.some(
        (c) => c.includes("/values/testadores!J2?") && c.includes("TRUE"),
      ),
    ).toBe(true);
    expect(calls[calls.length - 1]).toBe("email ok");
  });

  it("RF-A3: rejeitar dev row 3 → PUT K3 apenas (sem coluna J)", async () => {
    const res = await post(reviewerToken, {
      tab: "desenvolvedores",
      row: 3,
      acao: "rejeitar",
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("rejeitado");
    const puts = calls.filter((c) => c.startsWith("PUT"));
    expect(puts.some((c) => c.includes("/values/desenvolvedores!K3?"))).toBe(
      true,
    );
    expect(puts.length).toBe(1);
  });

  it("RF-A4: relatos resolver → PUT I2 e SEM email", async () => {
    const res = await post(reviewerToken, {
      tab: "relatos",
      row: 2,
      acao: "resolver",
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("resolvido");
    expect(body.emailEnviado).toBe(false);
    expect(calls.some((c) => c.startsWith("email"))).toBe(false);
    expect(calls.some((c) => c.includes("/values/relatos!I2?"))).toBe(true);
  });

  it("RF-A4: falha de SMTP → 200 {ok:true, emailEnviado:false, emailErro} e PUT já feito (nunca reverte)", async () => {
    emailResult = { ok: false, error: "smtp-down" };
    const res = await post(reviewerToken, {
      tab: "desenvolvedores",
      row: 4,
      acao: "aprovar",
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.emailEnviado).toBe(false);
    expect(body.emailErro).toBe("smtp-down");
    expect(calls.some((c) => c.includes("/values/desenvolvedores!K4?"))).toBe(
      true,
    );
  });

  it("RF-A5: PUT falha → erro propagado e email NEM tentado", async () => {
    calls = [];
    const failing = async (input: any, init?: any) => {
      const url = String(typeof input === "string" ? input : input.url);
      if ((init?.method ?? "GET").toUpperCase() === "PUT") {
        return new Response(JSON.stringify({ error: "boom" }), { status: 500 });
      }
      if (url.includes("oauth2.googleapis.com/token")) {
        return new Response(
          JSON.stringify({ access_token: "t", expires_in: 3600 }),
          {
            status: 200,
          },
        );
      }
      return new Response(JSON.stringify({ values: [["N", "e@x.local"]] }), {
        status: 200,
      });
    };
    vi.stubGlobal("fetch", failing);
    const res = await post(reviewerToken, {
      tab: "testadores",
      row: 2,
      acao: "aprovar",
    });
    expect(res.status).toBe(500);
    expect(calls.some((c) => c.startsWith("email"))).toBe(false);
  });

  it("RF-C3 CONTRATO LINHA-FÍSICA: fixture CSV real → pendentes rows {2|3,4} → PUT sai EXATAMENTE em testadores!L2, desenvolvedores!K3, desenvolvedores!K4 — nunca K2/K3(testadores)/L1/L3", async () => {
    // (a) parse da fixture — rows físicas esperadas
    const testers = pendentesDaFixture("testadores");
    const devs = pendentesDaFixture("desenvolvedores");
    expect(testers.map((t) => t.row)).toEqual([2]);
    expect(testers[0]!.nome).toBe("Jeydson");
    expect(devs.map((d) => d.row)).toEqual([3, 4]);
    expect(devs[0]!.nome).toContain("Felipe");
    expect(devs[1]!.nome).toContain("Lucas");
    // relatos: header-only → nenhum pendente
    expect(pendentesDaFixture("relatos")).toEqual([]);

    // (b) ciclo completo: POST review de cada pendente → grava célula física exata
    calls = [];
    for (const t of testers) {
      const res = await post(reviewerToken, {
        tab: "testadores",
        row: t.row,
        acao: "aprovar",
      });
      expect(res.status).toBe(200);
    }
    for (const d of devs) {
      const res = await post(reviewerToken, {
        tab: "desenvolvedores",
        row: d.row,
        acao: "aprovar",
      });
      expect(res.status).toBe(200);
    }

    const putUrls = calls
      .filter((c) => c.startsWith("PUT"))
      .map((c) => c.match(/values\/(\w+)!([A-Z]+)(\d+)\?/))
      .filter(Boolean)
      .map((m) => `${m![1]}!${m![2]}${m![3]}`);

    expect(putUrls).toEqual(
      expect.arrayContaining([
        "testadores!L2",
        "desenvolvedores!K3",
        "desenvolvedores!K4",
      ]),
    );
    // asserts negativos — off-by-one em ambas as direções
    for (const proibido of [
      "desenvolvedores!K2",
      "testadores!L1",
      "testadores!L3",
      "testadores!K3",
    ]) {
      expect(putUrls, `PUT não pode sair em ${proibido}`).not.toContain(
        proibido,
      );
    }
    // nenhuma outra célula de status além das 3 esperadas
    const statusCells = putUrls.filter((u) => !u.startsWith("testadores!J"));
    expect(statusCells.sort()).toEqual([
      "desenvolvedores!K3",
      "desenvolvedores!K4",
      "testadores!L2",
    ]);
  });
});
