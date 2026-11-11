// RED cases 1..8 — SPEC piano-bundle-sync v1.2.1 (RF-24) para os scripts
// scripts/backup-upstream.sh (catalog) e scripts/backup-bible.sh (bible).
//
// Fixture: derivada do manifest REAL de api.louvorja.com.br (probe executado
// em 2026-11-07, cacheado em test/fixtures/bundle/manifest-real-2026-11-07.json —
// bytes verbatim do upstream; conteúdos reais real_*.json do probe do APK de
// 2026-11-06, MD5s conferem com o manifest). Nada de envelope sintético antigo.
//
// Cada caso sobe um servidor HTTP local (access log por run) e executa o script
// com UPSTREAM_API apontando para ele e IMPORT_SCRIPT=stub (sem tocar no repo).
// Os runs usam spawn ASSÍNCRONO — spawnSync bloqueia o event loop e o servidor
// de fixture (mesmo processo) nunca atenderia o curl.
// Rodar: node test/scripts/backup-digest-gate.test.mjs

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// zipSync próprio (STORE, sem compressão) — evita depender de fflate (que não
// está nas deps do api); o formato é lido por zipfile/Python sem problema.
function zipSync(entries) {
  const chunks = [];
  const central = [];
  let offset = 0;
  const crc32Table = (() => {
    const t = new Int32Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[i] = c;
    }
    return t;
  })();
  const crc32 = (buf) => {
    let c = -1;
    for (let i = 0; i < buf.length; i++)
      c = crc32Table[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
    return (c ^ -1) >>> 0;
  };
  for (const [name, content] of Object.entries(entries)) {
    const nameBytes = Buffer.from(name, "utf8");
    const data = Buffer.isBuffer(content) ? content : Buffer.from(content);
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0x5441, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    local.writeUInt16LE(0, 28);
    chunks.push(local, nameBytes, data);
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(0, 8);
    cd.writeUInt16LE(0, 10);
    cd.writeUInt16LE(0, 12);
    cd.writeUInt16LE(0x5441, 14);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(data.length, 20);
    cd.writeUInt32LE(data.length, 24);
    cd.writeUInt16LE(nameBytes.length, 28);
    cd.writeUInt32LE(offset, 42);
    central.push(cd, nameBytes);
    offset += 30 + nameBytes.length + data.length;
  }
  const cdBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(cdBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...chunks, cdBuf, end]);
}

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "../..");
const FIXTURES = join(HERE, "../fixtures/bundle");

// ---- fixture: manifest REAL (cacheado do probe; baixado uma única vez se ausente) ----
const MANIFEST_CACHE = join(FIXTURES, "manifest-real-2026-11-07.json");
function loadRealManifest() {
  if (existsSync(MANIFEST_CACHE))
    return JSON.parse(readFileSync(MANIFEST_CACHE, "utf8"));
  const { execFileSync } = require("node:child_process");
  try {
    execFileSync(
      "curl",
      ["-sf", "https://api.louvorja.com.br/db/manifest", "-o", MANIFEST_CACHE],
      { stdio: "pipe" },
    );
  } catch {
    throw new Error("fixture: falha ao obter manifest real do upstream");
  }
  return JSON.parse(readFileSync(MANIFEST_CACHE, "utf8"));
}
const REAL_MANIFEST = loadRealManifest();

// paridade RF-24c: mesmo canonicalizador dos clientes (linhas file\tmd5\n, ordenado por file)
function canonicalSerialization(entries) {
  const sorted = [...entries].sort((a, b) =>
    a.file < b.file ? -1 : a.file > b.file ? 1 : 0,
  );
  return sorted.map((e) => `${e.file}\t${e.hash}\n`).join("");
}
const sha256Hex = (s) => createHash("sha256").update(s, "utf8").digest("hex");
const md5Hex = (buf) => createHash("md5").update(buf).digest("hex");
const CATALOG_KEY =
  /^(?:pt|es)_(?:categories|musics|hymnal|hymnal_\d+|bible_book|bible_version)$|^music_\d+$|^album_\d+$|^config$/;
const BIBLE_KEY = /^bible_[a-z0-9]+_\d+_\d+$/;

const catalogEntries = REAL_MANIFEST.filter((e) =>
  CATALOG_KEY.test(e.file.replace(/\.json$/, "")),
);
const bibleEntries = REAL_MANIFEST.filter((e) =>
  BIBLE_KEY.test(e.file.replace(/\.json$/, "")),
);
if (!catalogEntries.length || !bibleEntries.length)
  throw new Error("fixture: subsets vazios no manifest real");

// ---- servidor HTTP de fixture com access log por run ----
function startFixtureServer(routes) {
  const accessLog = [];
  const srv = createServer((req, res) => {
    accessLog.push(req.url);
    const route = routes[req.url];
    if (!route) {
      res.writeHead(404);
      res.end("not found");
      return;
    }
    res.writeHead(200, route.headers ?? { "Content-Type": "application/json" });
    res.end(route.body);
  });
  return new Promise((ok) =>
    srv.listen(0, "127.0.0.1", () =>
      ok({ srv, url: `http://127.0.0.1:${srv.address().port}`, accessLog }),
    ),
  );
}

// run assíncrono do script (NUNCA spawnSync aqui: bloquearia o fixture server)
function runScript(script, env, args = []) {
  return new Promise((resolveP) => {
    const child = spawn("bash", [join(REPO, "scripts", script), ...args], {
      cwd: REPO,
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "",
      stderr = "";
    child.stdout.on("data", (d) => {
      stdout += d;
    });
    child.stderr.on("data", (d) => {
      stderr += d;
    });
    const timer = setTimeout(() => child.kill("SIGKILL"), 120_000);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolveP({ status: code, stdout, stderr });
    });
  });
}

function freshBase() {
  const base = mkdtempSync(join(tmpdir(), "bundle-gate-"));
  mkdirSync(join(base, "backups"), { recursive: true });
  mkdirSync(join(base, "data"), { recursive: true });
  return base;
}

const IMPORT_STUB = join(HERE, "fixtures/import-stub.mjs");

let passed = 0,
  failed = 0;
function check(name, cond, detail = "") {
  if (cond) {
    passed++;
    console.log(`  ✓ RED ${name}`);
  } else {
    failed++;
    console.error(`  ✗ RED ${name} — ${detail}`);
  }
}

function runEnv(base, api, extra = {}) {
  return {
    BACKUP_DIR: base,
    UPSTREAM_API: api,
    IMPORT_SCRIPT: IMPORT_STUB,
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    ...extra,
  };
}

// ---- helper: constrói bundle ZIP no formato real do contrato ----
function buildBundle(kind, files, { mutate } = {}) {
  const entries = {
    "_bundle_manifest.json": JSON.stringify({
      kind,
      schema_version: 1,
      generatedAt: "2026-11-07T00:00:00Z",
    }),
  };
  for (const [file, content] of Object.entries(files)) entries[file] = content;
  if (mutate) mutate(entries);
  return zipSync(entries);
}

// ---- conteúdos REAIS do probe 2026-11-06 (fixtures do APK, MD5s conferem
// com o manifest real verbatim) ----
const realFile = (file) => {
  const p = join(FIXTURES, `real_${file}`);
  if (!existsSync(p)) throw new Error(`fixture ausente: ${p}`);
  return readFileSync(p);
};

function subsetFiles(entries, kind) {
  const pattern = kind === "catalog" ? CATALOG_KEY : BIBLE_KEY;
  const files = {};
  const available =
    kind === "catalog"
      ? ["pt_categories.json", "pt_musics.json", "config.json", "album_1.json"]
      : ["bible_10_100_1.json", "bible_10_100_2.json", "bible_10_100_3.json"];
  for (const e of entries) {
    if (
      pattern.test(e.file.replace(/\.json$/, "")) &&
      available.includes(e.file)
    ) {
      files[e.file] = realFile(e.file);
    }
  }
  for (const f of available) {
    const entry = entries.find((e) => e.file === f);
    if (!entry) throw new Error(`fixture: ${f} não está no manifest real`);
    if (md5Hex(files[f]) !== entry.hash) {
      throw new Error(
        `fixture: md5 de ${f} divergiu do manifest real (${md5Hex(files[f])} != ${entry.hash})`,
      );
    }
  }
  return files;
}

const catalogFiles = subsetFiles(catalogEntries, "catalog");
const bibleFiles = subsetFiles(bibleEntries, "bible");
const catalogZip = buildBundle("catalog", catalogFiles);
const bibleZip = buildBundle("bible", bibleFiles);

// FIXTURE_MANIFEST: as entries reais (verbatim do manifest upstream) cujos bytes
// reais temos no probe — mesmas do fixture do APK. O manifest upstream completo
// (18.060 entries) continua em manifest-real-2026-11-07.json para referência;
// os casos RED usam o subset com bytes reais para que cold apply valide (subset
// ⊆ ZIP precisa de todo entry com conteúdo no ZIP de fixture).
const FIXTURE_FILES = Object.keys(catalogFiles).concat(Object.keys(bibleFiles));
const FIXTURE_MANIFEST = FIXTURE_FILES.map((f) => {
  const e = REAL_MANIFEST.find((x) => x.file === f);
  if (!e) throw new Error(`fixture: ${f} ausente no manifest real`);
  return { ...e };
});
const fixtureCatalogEntries = FIXTURE_MANIFEST.filter((e) =>
  CATALOG_KEY.test(e.file.replace(/\.json$/, "")),
);
const fixtureBibleEntries = FIXTURE_MANIFEST.filter((e) =>
  BIBLE_KEY.test(e.file.replace(/\.json$/, "")),
);
const catalogDigest = sha256Hex(canonicalSerialization(fixtureCatalogEntries));
const bibleDigest = sha256Hex(canonicalSerialization(fixtureBibleEntries));

// paridade RF-24c: golden digest do APK computado sobre as entries do fixture
// (canonical_catalog/canonical_bible do APK = mesmas entries, mesmo canonicalizador).
const GOLDEN_CATALOG_DIGEST = readFileSync(
  join(FIXTURES, "golden_catalog_digest.txt"),
  "utf8",
).trim();
const GOLDEN_BIBLE_DIGEST = readFileSync(
  join(FIXTURES, "golden_bible_digest.txt"),
  "utf8",
).trim();
const GOLDEN_CANONICAL_CATALOG = [
  "album_1.json",
  "config.json",
  "pt_categories.json",
  "pt_musics.json",
]
  .map((f) => {
    const e = REAL_MANIFEST.find((x) => x.file === f);
    if (!e) throw new Error(`paridade: ${f} ausente no manifest real`);
    return `${f}\t${e.hash}\n`;
  })
  .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
  .join("");
const GOLDEN_CANONICAL_BIBLE = [
  "bible_10_100_1.json",
  "bible_10_100_2.json",
  "bible_10_100_3.json",
]
  .map((f) => {
    const e = REAL_MANIFEST.find((x) => x.file === f);
    if (!e) throw new Error(`paridade: ${f} ausente no manifest real`);
    return `${f}\t${e.hash}\n`;
  })
  .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
  .join("");
const GOLDEN_CATALOG_ENTRY_DIGEST = sha256Hex(GOLDEN_CANONICAL_CATALOG);
const GOLDEN_BIBLE_ENTRY_DIGEST = sha256Hex(GOLDEN_CANONICAL_BIBLE);

async function main() {
  console.log(
    `fixture: manifest real (${REAL_MANIFEST.length} entries; catalog=${catalogEntries.length} bible=${bibleEntries.length})`,
  );
  console.log(
    `fixture: digest catalog=${catalogDigest.slice(0, 12)}… bible=${bibleDigest.slice(0, 12)}…`,
  );

  // paridade RF-24c ANTES de qualquer caso: o canonicalizador do script sobre as
  // entries do fixture do APK deve produzir EXATAMENTE os golden digests do APK.
  {
    const scriptDigestOf = (files) => {
      const entries = Object.entries(files).map(([file, content]) => ({
        file,
        hash: md5Hex(content),
      }));
      return sha256Hex(canonicalSerialization(entries));
    };
    const dCat = scriptDigestOf({
      "album_1.json": realFile("album_1.json"),
      "config.json": realFile("config.json"),
      "pt_categories.json": realFile("pt_categories.json"),
      "pt_musics.json": realFile("pt_musics.json"),
    });
    const dBib = scriptDigestOf({
      "bible_10_100_1.json": realFile("bible_10_100_1.json"),
      "bible_10_100_2.json": realFile("bible_10_100_2.json"),
      "bible_10_100_3.json": realFile("bible_10_100_3.json"),
    });
    if (dCat !== GOLDEN_CATALOG_DIGEST)
      throw new Error(
        `paridade RF-24c quebrada: catalog ${dCat} != golden ${GOLDEN_CATALOG_DIGEST}`,
      );
    if (dBib !== GOLDEN_BIBLE_DIGEST)
      throw new Error(
        `paridade RF-24c quebrada: bible ${dBib} != golden ${GOLDEN_BIBLE_DIGEST}`,
      );
    if (
      GOLDEN_CATALOG_ENTRY_DIGEST !== GOLDEN_CATALOG_DIGEST ||
      GOLDEN_BIBLE_ENTRY_DIGEST !== GOLDEN_BIBLE_DIGEST
    ) {
      throw new Error(
        "paridade: fixtures canonical_*.txt do APK desatualizados vs golden digests",
      );
    }
    console.log("paridade RF-24c: canonicalizador == golden do APK ✓");
  }

  // ============ RED 1: entry fora do padrão é ignorada, run segue ============
  {
    console.log("RED 1: entry fora do padrão ignorada");
    const manifest = [
      ...FIXTURE_MANIFEST,
      {
        file: "desconhecido_xyz.json",
        table: "desconhecido_xyz",
        path: "/db/desconhecido_xyz",
        hash: md5Hex(Buffer.from("{}")),
      },
    ];
    const base = freshBase();
    const { srv, url, accessLog } = await startFixtureServer({
      "/db/manifest": { body: JSON.stringify(manifest) },
      "/db/catalog-bundle": {
        body: catalogZip,
        headers: { "Content-Type": "application/zip" },
      },
    });
    const r = await runScript("backup-upstream.sh", runEnv(base, url));
    if (r.status !== 0)
      throw new Error(
        `RED 1 falhou: status=${r.status}\nSTDOUT=${r.stdout}\nSTDERR=${r.stderr}`,
      );
    const state = JSON.parse(
      readFileSync(join(base, "backups/.state_catalog.json"), "utf8"),
    );
    check("1a run segue (exit 0)", r.status === 0);
    check(
      "1b digest ignora entry estranha (digest == digest do subset real)",
      state.manifestDigest === catalogDigest,
    );
    check(
      "1c ZIP baixado e aplicado na cold",
      accessLog.includes("/db/catalog-bundle"),
    );
    srv.close();
    rmSync(base, { recursive: true, force: true });
  }

  // ============ RED 2: manifest inválido (duplicado/inseguro/hash) aborta, 0 ZIP ============
  for (const [label, mutateManifest] of [
    ["duplicado", (m) => [...m, m[0]]],
    [
      "file inseguro",
      (m) => m.map((e, i) => (i === 0 ? { ...e, file: "../escape.json" } : e)),
    ],
    [
      "file sem .json",
      (m) => m.map((e, i) => (i === 0 ? { ...e, file: "album_1" } : e)),
    ],
    [
      "hash não-md5",
      (m) => m.map((e, i) => (i === 0 ? { ...e, hash: "zzz" } : e)),
    ],
    [
      "ctrl-char",
      (m) =>
        m.map((e, i) => (i === 0 ? { ...e, file: "album_1\x01.json" } : e)),
    ],
  ]) {
    const manifest = mutateManifest(FIXTURE_MANIFEST);
    const base = freshBase();
    const { srv, url, accessLog } = await startFixtureServer({
      "/db/manifest": { body: JSON.stringify(manifest) },
      "/db/catalog-bundle": {
        body: catalogZip,
        headers: { "Content-Type": "application/zip" },
      },
    });
    const r = await runScript("backup-upstream.sh", runEnv(base, url));
    check(
      `2 aborta (${label}): exit≠0`,
      r.status !== 0,
      `status=${r.status} out=${r.stdout}`,
    );
    check(
      `2 (${label}): 0 ZIP`,
      !accessLog.includes("/db/catalog-bundle"),
      accessLog.join(","),
    );
    check(
      `2 (${label}): estado anterior intacto`,
      !existsSync(join(base, "backups/.state_catalog.json")),
    );
    srv.close();
    rmSync(base, { recursive: true, force: true });
  }

  // ============ RED 3: warm run = 1 request, 0 ZIP, nenhum .tmp de bundle ============
  {
    console.log("RED 3: warm run digest-gated");
    const base = freshBase();
    const { srv, url, accessLog } = await startFixtureServer({
      "/db/manifest": { body: JSON.stringify(FIXTURE_MANIFEST) },
      "/db/catalog-bundle": {
        body: catalogZip,
        headers: { "Content-Type": "application/zip" },
      },
    });
    const cold = await runScript("backup-upstream.sh", runEnv(base, url));
    if (cold.status !== 0)
      throw new Error(
        `RED 3 setup cold falhou: ${cold.stderr}\n${cold.stdout}`,
      );
    accessLog.length = 0;
    const warm = await runScript("backup-upstream.sh", runEnv(base, url));
    const state = JSON.parse(
      readFileSync(join(base, "backups/.state_catalog.json"), "utf8"),
    );
    const tmpFiles = readdirSync(join(base, "backups")).filter((f) =>
      f.includes(".tmp"),
    );
    check("3a warm exit 0", warm.status === 0, warm.stderr);
    check(
      "3b warm = 1 request",
      accessLog.length === 1 && accessLog[0] === "/db/manifest",
      accessLog.join(","),
    );
    check(
      '3c warm log declara "1 request nesta run, 0 ZIP"',
      warm.stdout.includes("1 request nesta run, 0 ZIP"),
    );
    check(
      "3d nenhum .tmp de bundle criado no warm",
      tmpFiles.length === 0,
      tmpFiles.join(","),
    );
    check(
      "3e checkedAt atualizado, manifestDigest/appliedAt intactos",
      state.checkedAtEpochMs > 0 &&
        state.manifestDigest === catalogDigest &&
        state.appliedAtEpochMs > 0,
    );
    srv.close();
    rmSync(base, { recursive: true, force: true });
  }

  // ============ RED 4: uma entry mudada + ZIP incompleto invalida tudo ============
  {
    console.log("RED 4: hash mudado no manifest + ZIP incompleto");
    const changed = FIXTURE_MANIFEST.map((e) =>
      e.file === "pt_musics.json"
        ? { ...e, hash: md5Hex(Buffer.from("novo")) }
        : e,
    );
    const incompleteZip = buildBundle("catalog", {
      "pt_categories.json": catalogFiles["pt_categories.json"],
      "config.json": catalogFiles["config.json"],
    });
    const base = freshBase();
    const { srv, url } = await startFixtureServer({
      "/db/manifest": { body: JSON.stringify(changed) },
      "/db/catalog-bundle": {
        body: incompleteZip,
        headers: { "Content-Type": "application/zip" },
      },
    });
    // estado anterior: cold apply do bundle válido
    const srv2 = await startFixtureServer({
      "/db/manifest": { body: JSON.stringify(FIXTURE_MANIFEST) },
      "/db/catalog-bundle": {
        body: catalogZip,
        headers: { "Content-Type": "application/zip" },
      },
    });
    const cold = await runScript("backup-upstream.sh", runEnv(base, srv2.url));
    if (cold.status !== 0)
      throw new Error(
        `RED 4 setup cold falhou: ${cold.stderr}\n${cold.stdout}`,
      );
    srv2.srv.close();
    const stateBefore = readFileSync(
      join(base, "backups/.state_catalog.json"),
      "utf8",
    );
    const r = await runScript("backup-upstream.sh", runEnv(base, url));
    const stateAfter = readFileSync(
      join(base, "backups/.state_catalog.json"),
      "utf8",
    );
    check("4a invalida (exit≠0)", r.status !== 0, `status=${r.status}`);
    check(
      "4b nada aplicado, estado anterior preservado",
      stateAfter === stateBefore,
    );
    check(
      "4c log de completude",
      r.stdout.includes("incompleto") || r.stdout.includes("FAIL"),
    );
    srv.close();
    rmSync(base, { recursive: true, force: true });
  }

  // ============ RED 5: MD5 divergente em UMA entry invalida o bundle inteiro ============
  {
    console.log("RED 5: congruência entry-wise");
    const tamperedZip = buildBundle("catalog", catalogFiles, {
      mutate: (entries) => {
        entries["config.json"] = Buffer.from(
          JSON.stringify({ tampered: true }),
        );
      },
    });
    const base = freshBase();
    const { srv, url } = await startFixtureServer({
      "/db/manifest": { body: JSON.stringify(FIXTURE_MANIFEST) },
      "/db/catalog-bundle": {
        body: tamperedZip,
        headers: { "Content-Type": "application/zip" },
      },
    });
    const r = await runScript("backup-upstream.sh", runEnv(base, url));
    check("5a invalida tudo (exit≠0)", r.status !== 0, `status=${r.status}`);
    check(
      "5b nada aplicado (sem estado)",
      !existsSync(join(base, "backups/.state_catalog.json")),
    );
    check(
      "5c log de congruência",
      r.stdout.includes("congruencia") || r.stdout.includes("FAIL"),
    );
    srv.close();
    rmSync(base, { recursive: true, force: true });
  }

  // ============ RED 6: estado só após o commit (crash entre extração e estado) ============
  {
    console.log("RED 6: crash antes do commit não grava estado");
    const base = freshBase();
    const { srv, url } = await startFixtureServer({
      "/db/manifest": { body: JSON.stringify(FIXTURE_MANIFEST) },
      "/db/catalog-bundle": {
        body: catalogZip,
        headers: { "Content-Type": "application/zip" },
      },
    });
    // IMPORT_SCRIPT que mata o processo: o import roda DEPOIS do move do RAW e
    // ANTES da gravação do estado — crash ali simula kill entre extração e commit.
    const killerStub = join(HERE, "fixtures/import-kill.mjs");
    const r = await runScript("backup-upstream.sh", {
      ...runEnv(base, url),
      IMPORT_SCRIPT: killerStub,
    });
    check("6a run abortada", r.status !== 0, `status=${r.status}`);
    check(
      "6b .state_catalog.json NÃO gravado",
      !existsSync(join(base, "backups/.state_catalog.json")),
    );
    srv.close();
    rmSync(base, { recursive: true, force: true });
  }

  // ============ RED 7: --force pula o gate digest ============
  {
    console.log("RED 7: --force");
    const base = freshBase();
    const { srv, url, accessLog } = await startFixtureServer({
      "/db/manifest": { body: JSON.stringify(FIXTURE_MANIFEST) },
      "/db/catalog-bundle": {
        body: catalogZip,
        headers: { "Content-Type": "application/zip" },
      },
    });
    const cold = await runScript("backup-upstream.sh", runEnv(base, url));
    if (cold.status !== 0)
      throw new Error(
        `RED 7 setup cold falhou: ${cold.stderr}\n${cold.stdout}`,
      );
    accessLog.length = 0;
    const forced = await runScript("backup-upstream.sh", runEnv(base, url), [
      "--force",
    ]);
    check(
      "7a --force baixa ZIP mesmo com digest igual",
      accessLog.includes("/db/catalog-bundle"),
      accessLog.join(","),
    );
    check(
      "7b --force valida e aplica (exit 0)",
      forced.status === 0,
      forced.stderr,
    );
    const state = JSON.parse(
      readFileSync(join(base, "backups/.state_catalog.json"), "utf8"),
    );
    check(
      "7c estado regravado com o mesmo digest",
      state.manifestDigest === catalogDigest && state.appliedAtEpochMs > 0,
    );
    srv.close();
    rmSync(base, { recursive: true, force: true });
  }

  // ============ RED 8: migração one-shot do stamp legado ============
  for (const [script, stamp, stateFile, kind, zipBody, digest] of [
    [
      "backup-upstream.sh",
      ".last_bundle_md5",
      ".state_catalog.json",
      "catalog",
      catalogZip,
      catalogDigest,
    ],
    [
      "backup-bible.sh",
      ".last_bible_bundle_md5",
      ".state_bible.json",
      "bible",
      bibleZip,
      bibleDigest,
    ],
  ]) {
    console.log(`RED 8: migração one-shot (${kind})`);
    const base = freshBase();
    writeFileSync(join(base, "backups", stamp), "deadbeef");
    const { srv, url, accessLog } = await startFixtureServer({
      "/db/manifest": { body: JSON.stringify(FIXTURE_MANIFEST) },
      [`/db/${kind}-bundle`]: {
        body: zipBody,
        headers: { "Content-Type": "application/zip" },
      },
    });
    const env = runEnv(base, url);
    if (kind === "bible") delete env.IMPORT_SCRIPT; // bible script não usa import
    const r = await runScript(script, env);
    const state = JSON.parse(
      readFileSync(join(base, "backups", stateFile), "utf8"),
    );
    check(
      `8a ${kind}: cold apply com estado schema 2`,
      r.status === 0 &&
        state.schema === 2 &&
        state.artifact === kind &&
        state.manifestDigest === digest,
      `${r.status} ${r.stderr}`,
    );
    check(
      `8b ${kind}: ZIP baixado apesar de stamp presente`,
      accessLog.includes(`/db/${kind}-bundle`),
    );
    check(
      `8c ${kind}: stamp legado removido`,
      !existsSync(join(base, "backups", stamp)),
    );
    check(
      `8d ${kind}: MD5 do ZIP não reaproveitado`,
      state.manifestDigest !== "deadbeef",
    );
    accessLog.length = 0;
    const warm = await runScript(script, runEnv(base, url));
    check(
      `8e ${kind}: 2º run warm (1 request, 0 ZIP)`,
      warm.status === 0 && accessLog.length === 1,
      `${warm.status} ${accessLog.join(",")} ${warm.stderr}`,
    );
    srv.close();
    rmSync(base, { recursive: true, force: true });
  }

  console.log(`\nRED cases: ${passed} ok, ${failed} falha(s)`);
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
