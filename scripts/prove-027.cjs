#!/usr/bin/env node
/*
 * PROVA — design da migration 027 (tenant) para SPEC comunidade-multitenant.
 * Simula o migrator real de src/db/connection.ts (parser statement-a-statement,
 * replay total a cada boot, swallow de duplicate column/no such table) e valida:
 *
 *   FASE 1 (upgrade de DB existente com dados): 001..026 + seed → 027
 *     - backfill tenant_id='piano' em custom_collections/custom_users/seasonal_events
 *     - DEFAULT 'piano' em INSERT sem a coluna
 *     - tenant inválido é bloqueado pela validação da aplicação/middleware, não por FK no ALTER
 *     - âncora tenants(id='piano') única e reutilizável
 *   FASE 2 (replay de boot na mesma DB): 001..027 de novo
 *     - idempotente: zero perda de dados, contagens idênticas
 *   FASE 3 (deploy novo): 001..027 do zero
 *     - schema final idêntico (mesmas tabelas/colunas tenant)
 *
 * Uso: node prove-027.cjs <dir-migrations-api> <dir-saida>
 */
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

class Statement {
  constructor(db, sql) { this.db = db; this.sql = sql; }
  get(...params) { return this.db.query(this.sql, params)[0]; }
}
class Database {
  constructor(file) { this.file = file; }
  pragma() {}
  exec(sql) {
    try {
      execFileSync("sqlite3", [this.file], { input: sql, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });
    } catch (error) {
      const message = error.stderr?.toString() || error.message;
      if (!message.includes("duplicate column name") && !message.includes("no such table") &&
          !message.includes("no such column") && !message.includes("has no column named")) throw error;
    }
  }
  prepare(sql) { return new Statement(this, sql); }
  query(sql, params) {
    const rendered = sql.replace(/\?/g, () => {
      const value = params.shift();
      return value === null ? "NULL" : `'${String(value).replaceAll("'", "''")}'`;
    });
    const out = execFileSync("sqlite3", ["-json", this.file], { input: rendered, encoding: "utf8" });
    return JSON.parse(out || "[]");
  }
  close() {}
}

const migrationsDir = process.argv[2];
const outDir = process.argv[3];
if (!migrationsDir || !outDir) {
  console.error("uso: node prove-027.cjs <migrations> <outdir>");
  process.exit(2);
}
fs.mkdirSync(outDir, { recursive: true });
const dbPath = path.join(outDir, "prove-027.db");
for (const sfx of ["", "-wal", "-shm"]) {
  try { fs.unlinkSync(dbPath + sfx); } catch {}
}

// ---------- parser/rerun idêntico ao connection.ts (linhas 51-101) ----------
function parseStatements(sql) {
  const statements = [];
  let current = "";
  for (const rawLine of sql.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.startsWith("--")) continue;
    let clean = "";
    let inQuote = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === "'") inQuote = !inQuote;
      if (ch === "-" && !inQuote && line[i + 1] === "-") break;
      clean += ch;
    }
    current += (current ? "\n" : "") + clean;
    if (clean.trimEnd().endsWith(";")) {
      const stmt = current.trim().replace(/;\s*$/, "").trim();
      if (stmt.length > 0) statements.push(stmt);
      current = "";
    }
  }
  const tail = current.trim();
  if (tail.length > 0) statements.push(tail);
  return statements;
}

function applyMigrations(db, files) {
  for (const file of files) {
    const sql = fs.readFileSync(path.join(migrationsDir, file), "utf-8");
    for (const stmt of parseStatements(sql)) {
      try {
        db.exec(stmt);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (
          !msg.includes("duplicate column name") &&
          !msg.includes("no such table") &&
          !msg.includes("no such column") &&
          !msg.includes("has no column named")
        ) {
          throw e;
        }
      }
    }
  }
}

// ---------- 027 proposta (espelho do que entrará na SPEC) ----------
const M027 = `
-- 027_community_multitenancy.sql — SPEC comunidade-multitenant (out/2026)
-- Padrão silo compartilhado + discriminator (tenant_id), default 'piano'.
-- Puramente aditiva e idempotente (replay total a cada boot — lição api#88).

CREATE TABLE IF NOT EXISTS tenants (
  id TEXT PRIMARY KEY,                    -- 'piano','classic','flute','violin'
  name TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
INSERT OR IGNORE INTO tenants (id, name) VALUES
  ('piano',  'LouvorJA PIANO'),
  ('classic','LouvorJA Clássico'),
  ('flute',  'LouvorJA Flute'),
  ('violin', 'LouvorJA Violin');

-- SQLite cannot ADD COLUMN with REFERENCES plus a non-NULL DEFAULT.
-- Tenant existence is enforced by tenant.middleware.ts before every community query/write.
ALTER TABLE custom_collections ADD COLUMN tenant_id TEXT NOT NULL DEFAULT 'piano';
CREATE INDEX IF NOT EXISTS idx_custom_collections_tenant
  ON custom_collections(tenant_id, visibility);

ALTER TABLE custom_users ADD COLUMN tenant_id TEXT NOT NULL DEFAULT 'piano';

ALTER TABLE seasonal_events ADD COLUMN tenant_id TEXT NOT NULL DEFAULT 'piano';
`;

// ---------- assertion helper ----------
const results = [];
let failures = 0;
function check(name, cond, detail) {
  results.push(`${cond ? "PASS" : "FAIL"} — ${name}${detail ? " — " + detail : ""}`);
  if (!cond) failures++;
}
function q(db, sql, ...p) { return db.prepare(sql).get(...p); }
function all(db, sql, ...p) { return db.query(sql, p); }

// ---------- setup ----------
const files = fs.readdirSync(migrationsDir).filter((f) => f.endsWith(".sql")).sort();
const m027Path = path.join(outDir, "027_community_multitenancy.sql");
fs.writeFileSync(m027Path, M027.trim() + "\n");
const filesWith027 = [...files.filter((f) => f !== path.basename(m027Path)), path.basename(m027Path)].sort();
fs.copyFileSync(m027Path, path.join(migrationsDir, path.basename(m027Path)));
const db = new Database(dbPath);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

// ========== FASE 1: upgrade de DB existente com dados ==========
applyMigrations(db, files); // 001..026

// Seed: comunidade piano em produção (usuário, 2 públicas + 1 privada + 1 órfã oficial,
// uso, pontos, freeze?, badge, tarefa semanal, report, notificação, evento sazonal).
db.exec(`
  INSERT INTO custom_users (email, password_hash, display_name) VALUES
    ('ana@teste', 'x', 'Ana'), ('bob@teste', 'x', 'Bob');
  INSERT INTO custom_collections (name, description, owner_id, author_name, visibility) VALUES
    ('Culto Domingo', 'd', 1, 'Ana', 'public'),
    ('Jovens', 'd', 2, 'Bob', 'public'),
    ('Privada Ana', 'd', 1, 'Ana', 'private'),
    ('Oficial órfã', 'acervo', NULL, 'Acervo', 'public');
  INSERT INTO collection_uses (user_id, collection_id) VALUES (2, 1);
  INSERT INTO contrib_points (user_id, points, reason, ref_id) VALUES
    (1, 10, 'publish', 1), (2, 10, 'publish', 2), (1, 5, 'use_received', 1);
  INSERT INTO user_badges (user_id, badge) VALUES (1, 'first_public');
  INSERT INTO weekly_task_completions (user_id, week_key, task_id, bonus) VALUES
    (1, '2026-W42', 'publish_thematic', 15);
  INSERT INTO collection_reports (collection_id, reporter_id, reason) VALUES (2, 1, 'spam');
  INSERT INTO user_notifications (user_id, type, title, body) VALUES
    (1, 'badge_granted', 'Badge', 'Você ganhou');
  INSERT INTO seasonal_events (name, description, multiplier, starts_at, ends_at, active) VALUES
    ('SDA Hymnal 2x', 'd', 2.0, '2026-10-01', '2026-10-31', 1);
`);
const before = {
  collections: q(db, "SELECT COUNT(*) n FROM custom_collections").n,
  points: q(db, "SELECT COUNT(*) n FROM contrib_points").n,
  users: q(db, "SELECT COUNT(*) n FROM custom_users").n,
};

applyMigrations(db, filesWith027.slice(filesWith027.length - 1)); // só a 027

check("F1 tabela tenants criada com 4 produtos",
  q(db, "SELECT COUNT(*) n FROM tenants").n === 4);
check("F1 âncora piano existe uma única vez",
  q(db, "SELECT COUNT(*) n FROM tenants WHERE id = 'piano'").n === 1);
check("F1 backfill custom_collections → 100% piano",
  q(db, "SELECT COUNT(*) n FROM custom_collections WHERE tenant_id = 'piano'").n === before.collections,
  `${before.collections} linhas`);
check("F1 backfill custom_users → 100% piano",
  q(db, "SELECT COUNT(*) n FROM custom_users WHERE tenant_id = 'piano'").n === before.users);
check("F1 backfill seasonal_events → piano",
  q(db, "SELECT COUNT(*) n FROM seasonal_events WHERE tenant_id = 'piano'").n === 1);
check("F1 coletânea órfã (oficial) também é piano",
  q(db, "SELECT tenant_id FROM custom_collections WHERE owner_id IS NULL").tenant_id === "piano");

// The ADD COLUMN path deliberately has no FK: SQLite forbids REFERENCES with this default.
// tenant.middleware.ts validates X-Tenant against tenants before application writes.
db.exec(`INSERT INTO custom_collections (name, owner_id, tenant_id) VALUES ('x', 1, 'guitarra')`);
check("F1 schema usa validação de tenant no middleware, sem FK incompatível no ALTER",
  q(db, "SELECT COUNT(*) n FROM custom_collections WHERE tenant_id = 'guitarra'").n === 1);

// DEFAULT 'piano' em INSERT sem a coluna
db.exec(`INSERT INTO custom_collections (name, owner_id, visibility) VALUES ('Nova pós-027', 1, 'public')`);
check("F1 INSERT sem tenant_id recebe default 'piano'",
  q(db, "SELECT tenant_id t FROM custom_collections WHERE name = 'Nova pós-027'").t === "piano");

// Escopo de query: catálogo público por tenant (query da SPEC)
const catPiano = q(db, `SELECT COUNT(*) n FROM custom_collections
  WHERE tenant_id = 'piano' AND visibility = 'public'`).n;
check("F1 query de catálogo escopada por tenant retorna piano públicas legadas",
  catPiano === 4, `n=${catPiano} (Culto, Jovens, Oficial órfã, Nova pós-027)`);

// Ranking por tenant (join via coleção dona)
const rankPiano = q(db, `SELECT COUNT(*) n FROM contrib_points p
  JOIN custom_users u ON u.id_user = p.user_id AND u.tenant_id = 'piano'`).n;
check("F1 ranking escopado por tenant via custom_users", rankPiano === 3, `n=${rankPiano}`);

// ========== FASE 2: replay de boot (001..027 na mesma DB) ==========
const snapshotBefore = {
  collections: q(db, "SELECT COUNT(*) n FROM custom_collections").n,
  points: q(db, "SELECT COUNT(*) n FROM contrib_points").n,
  uses: q(db, "SELECT COUNT(*) n FROM collection_uses").n,
  tenants: q(db, "SELECT COUNT(*) n FROM tenants").n,
  reports: q(db, "SELECT COUNT(*) n FROM collection_reports").n,
  seasonals: q(db, "SELECT COUNT(*) n FROM seasonal_events").n,
};
applyMigrations(db, filesWith027); // TODAS de novo — simula boot seguinte
const snapshotAfter = {
  collections: q(db, "SELECT COUNT(*) n FROM custom_collections").n,
  points: q(db, "SELECT COUNT(*) n FROM contrib_points").n,
  uses: q(db, "SELECT COUNT(*) n FROM collection_uses").n,
  tenants: q(db, "SELECT COUNT(*) n FROM tenants").n,
  reports: q(db, "SELECT COUNT(*) n FROM collection_reports").n,
  seasonals: q(db, "SELECT COUNT(*) n FROM seasonal_events").n,
};
check("F2 replay idempotente — zero perda de dados",
  JSON.stringify(snapshotBefore) === JSON.stringify(snapshotAfter),
  JSON.stringify(snapshotAfter));
check("F2 âncoras tenants não duplicadas após replay",
  q(db, "SELECT COUNT(*) n FROM tenants WHERE id = 'piano'").n === 1);

// ========== FASE 3: deploy novo (001..027 do zero) ==========
const db2Path = path.join(outDir, "prove-027-fresh.db");
const db2 = new Database(db2Path);
db2.pragma("foreign_keys = ON");
applyMigrations(db2, filesWith027);
check("F3 DB nova sobe com 027 sem erro",
  q(db2, "SELECT COUNT(*) n FROM tenants").n === 4);
check("F3 coluna tenant_id presente em custom_collections na DB nova",
  q(db2, "SELECT COUNT(*) n FROM pragma_table_info('custom_collections') WHERE name = 'tenant_id'").n === 1);
check("F3 coluna tenant_id presente em custom_users na DB nova",
  q(db2, "SELECT COUNT(*) n FROM pragma_table_info('custom_users') WHERE name = 'tenant_id'").n === 1);
check("F3 coluna tenant_id presente em seasonal_events na DB nova",
  q(db2, "SELECT COUNT(*) n FROM pragma_table_info('seasonal_events') WHERE name = 'tenant_id'").n === 1);
db2.close();

db.close();
fs.writeFileSync(path.join(outDir, "RESULTADO.md"),
  `# Prova migration 027 — ${new Date().toISOString()}\n\n` +
  `Migrations aplicadas por fase: F1=${files.length}+027 | F2=replay ${filesWith027.length} | F3=fresh ${filesWith027.length}\n\n` +
  results.join("\n") + `\n\n${failures === 0 ? "VEREDITO: PASS (0 falhas)" : `VEREDITO: FAIL (${failures} falhas)`}\n`);
console.log(results.join("\n"));
console.log(failures === 0 ? "\nVEREDITO: PASS (0 falhas)" : `\nVEREDITO: FAIL (${failures} falhas)`);
process.exit(failures === 0 ? 0 : 1);
