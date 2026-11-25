// Stub de import-upstream.ts para os testes do gate digest: grava marcador de
// execução sem tocar em SQLite (o gate não depende do rebuild em si).
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const raw = process.env.LOCAL_JSON_DIR ?? "";
mkdirSync(dirname(join(raw, ".imported")), { recursive: true });
writeFileSync(join(raw, ".imported"), "ok");
console.log("import stub ok");
