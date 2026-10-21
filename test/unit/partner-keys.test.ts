import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * Token de parceiro (.planning/partner-keys/SPEC.md): lib, middleware e CLI
 * contra um SQLite real com as migrations aplicadas.
 */
describe("partner keys", () => {
  const tmpDir = mkdtempSync(join(tmpdir(), "piano-partner-"));
  const prevDbPath = process.env.DB_PATH;
  let lib: typeof import("../../src/lib/partnerKeys.js");
  let conn: typeof import("../../src/db/connection.js");

  beforeAll(async () => {
    process.env.DB_PATH = join(tmpDir, "partner.db");
    conn = await import("../../src/db/connection.js");
    conn.initDb();
    lib = await import("../../src/lib/partnerKeys.js");
  });

  afterAll(() => {
    conn.closeDb();
    process.env.DB_PATH = prevDbPath;
    rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("lib", () => {
    it("gera token plj_ com 32 bytes base64url e hash SHA-256", () => {
      const key = lib.generatePartnerKey();
      expect(key).toMatch(/^plj_[A-Za-z0-9_-]{43}$/);
      expect(lib.generatePartnerKey()).not.toBe(key);
      expect(lib.hashPartnerKey(key)).toMatch(/^[0-9a-f]{64}$/);
    });

    it("create guarda só o hash, nunca o token em claro", () => {
      const { id, key } = lib.createPartner("Liturgia Desktop");
      const row = conn
        .getDb()
        .prepare("SELECT * FROM partner_keys WHERE id_partner = ?")
        .get(id) as Record<string, unknown>;
      expect(row.name).toBe("Liturgia Desktop");
      expect(row.key_hash).toBe(lib.hashPartnerKey(key));
      expect(row.key_prefix).toBe(key.slice(0, 8));
      expect(Object.values(row)).not.toContain(key);
    });

    it("create rejeita nome vazio", () => {
      expect(() => lib.createPartner("   ")).toThrow(/nome/i);
    });

    it("findPartnerByKey acha ativo e ignora desconhecido/revogado", () => {
      const { id, key } = lib.createPartner("Parceiro X");
      expect(lib.findPartnerByKey(key)).toEqual({ id, name: "Parceiro X" });
      expect(lib.findPartnerByKey("plj_naoexiste")).toBeNull();
      expect(lib.findPartnerByKey("")).toBeNull();
      expect(lib.revokePartner(id)).toBe(true);
      expect(lib.findPartnerByKey(key)).toBeNull();
      expect(lib.revokePartner(id)).toBe(false);
      expect(lib.revokePartner(999_999)).toBe(false);
    });

    it("list devolve metadados sem token nem hash", () => {
      const list = lib.listPartners();
      expect(list.length).toBeGreaterThanOrEqual(2);
      for (const p of list) {
        expect(Object.keys(p).sort()).toEqual(
          [
            "active",
            "created_at",
            "id",
            "key_prefix",
            "name",
            "revoked_at",
          ].sort(),
        );
      }
      expect(list.find((p) => p.name === "Parceiro X")?.active).toBe(false);
    });

    it("migration roda de novo sem erro e mantém os dados", () => {
      const before = lib.listPartners().length;
      conn.initDb();
      expect(lib.listPartners().length).toBe(before);
    });
  });

  describe("middleware", () => {
    async function call(header?: string) {
      const { Hono } = await import("hono");
      const { partnerKey } = await import("../../src/middleware/partnerKey.js");
      const app = new Hono();
      app.use("*", partnerKey);
      app.get("/x", (c) =>
        c.json({
          partner: (c.get as (k: string) => unknown)("partner") ?? null,
        }),
      );
      return app.request(
        "/x",
        header === undefined ? {} : { headers: { "X-Partner-Key": header } },
      );
    }

    it("sem header segue normal e sem parceiro", async () => {
      const res = await call();
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ partner: null });
    });

    it("token válido segue e expõe o parceiro", async () => {
      const { id, key } = lib.createPartner("Liturgia Teste");
      const res = await call(key);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        partner: { id, name: "Liturgia Teste" },
      });
    });

    it("token inválido ou vazio responde 401", async () => {
      for (const h of ["plj_errado", ""]) {
        const res = await call(h);
        expect(res.status).toBe(401);
        expect(await res.json()).toEqual({ error: "Invalid partner key" });
      }
    });

    it("conta partner_requests_total por parceiro", async () => {
      const { key } = lib.createPartner("Metrico");
      await call(key);
      const { register } = await import("prom-client");
      const text = await register.metrics();
      expect(text).toMatch(/partner_requests_total\{partner="Metrico"\} 1/);
    });
  });

  describe("middleware fail-open", () => {
    it("erro no lookup deixa a request passar sem parceiro", async () => {
      const { Hono } = await import("hono");
      const { partnerKey } = await import("../../src/middleware/partnerKey.js");
      const app = new Hono();
      app.use("*", partnerKey);
      app.get("/x", (c) => c.text("ok"));
      conn.closeDb();
      try {
        const res = await app.request("/x", {
          headers: { "X-Partner-Key": "plj_qualquer" },
        });
        expect(res.status).toBe(200);
      } finally {
        conn.initDb();
      }
    });
  });

  describe("CLI", () => {
    async function runCli(argv: string[]) {
      const { run } = await import("../../src/cli/partners.js");
      const lines: string[] = [];
      const code = run(argv, (l) => lines.push(l));
      return { code, out: lines.join("\n") };
    }

    it("create imprime o token uma vez e list não mostra", async () => {
      const created = await runCli(["create", "Liturgia", "CLI"]);
      expect(created.code).toBe(0);
      const key = created.out.match(/plj_[A-Za-z0-9_-]{43}/)?.[0];
      expect(key).toBeDefined();
      expect(lib.findPartnerByKey(key as string)?.name).toBe("Liturgia CLI");

      const listed = await runCli(["list"]);
      expect(listed.code).toBe(0);
      expect(listed.out).toContain("Liturgia CLI");
      expect(listed.out).not.toContain(key as string);
    });

    it("revoke por id desativa; id inválido falha", async () => {
      const { id, key } = lib.createPartner("Revogavel");
      expect((await runCli(["revoke", String(id)])).code).toBe(0);
      expect(lib.findPartnerByKey(key)).toBeNull();
      expect((await runCli(["revoke", String(id)])).code).toBe(1);
      expect((await runCli(["revoke", "abc"])).code).toBe(1);
    });

    it("comando desconhecido ou sem nome mostra uso e falha", async () => {
      for (const argv of [[], ["xyz"], ["create"]]) {
        const r = await runCli(argv);
        expect(r.code).toBe(1);
        expect(r.out).toMatch(/uso/i);
      }
    });
  });
});
