// WT-6A E2E: dois receivers fake com slots diferentes; valida roteamento por slot.
// Uso: node wt6a-e2e.mjs <code> <operatorToken>
import WebSocket from "ws";
import { resolveApiBase, toWs } from "./e2e-api.mjs";

const code = process.argv[2];
const token = process.argv[3];
if (!code || !token) {
  console.error("uso: node wt6a-e2e.mjs <code> <operatorToken>");
  process.exit(1);
}
const API = resolveApiBase();

function receiver(cid, slot) {
  const rx = new WebSocket(
    `${toWs(API)}/v1/palco/relay/${code}?token=${encodeURIComponent(token)}&role=receiver&cid=${cid}&slot=${slot}`,
  );
  const got = [];
  rx.on("open", () => console.log(`[${cid}] conectado (slot ${slot})`));
  rx.on("message", (d) => {
    const m = JSON.parse(d.toString());
    got.push(m);
    console.log(`[${cid}] recebe:`, JSON.stringify(m).slice(0, 160));
  });
  rx.on("error", (e) => console.error(`[${cid}] erro:`, e.message));
  return { rx, got };
}

const tv1 = receiver("fake-tv-1", 1);
await new Promise((r) => tv1.rx.on("open", r));
const tv2 = receiver("fake-tv-2", 2);
await new Promise((r) => tv2.rx.on("open", r));

const op = new WebSocket(
  `${toWs(API)}/v1/palco/relay/${code}?token=${encodeURIComponent(token)}&role=operator`,
);
await new Promise((r) => op.on("open", r));
console.log("[operator] conectado");

// 1) direcionado ao slot 2
op.send(
  JSON.stringify({
    v: 2,
    to: "slot-2",
    type: "projection",
    module: "hymn",
    title: "HINO SÓ PRO SLOT 2",
  }),
);
// 2) broadcast (retrocompatibilidade)
op.send(
  JSON.stringify({ v: 2, type: "projection", module: "clock", time: "12:00" }),
);

await new Promise((r) => setTimeout(r, 1500));

console.log("\n=== RESULTADO ===");
const t1hymn = tv1.got.some((m) => m.title?.includes("SÓ PRO SLOT 2"));
const t2hymn = tv2.got.some((m) => m.title?.includes("SÓ PRO SLOT 2"));
const t1clock = tv1.got.some((m) => m.module === "clock");
const t2clock = tv2.got.some((m) => m.module === "clock");
console.log(
  "hino slot-2 chegou na TV1 (NÃO deve):",
  t1hymn ? "FALHOU ❌" : "ok ✓",
);
console.log(
  "hino slot-2 chegou na TV2 (deve):    ",
  t2hymn ? "ok ✓" : "FALHOU ❌",
);
console.log(
  "clock broadcast TV1 (deve):          ",
  t1clock ? "ok ✓" : "FALHOU ❌",
);
console.log(
  "clock broadcast TV2 (deve):          ",
  t2clock ? "ok ✓" : "FALHOU ❌",
);
const allOk = !t1hymn && t2hymn && t1clock && t2clock;
console.log(allOk ? "\nWT-6A E2E: PASS ✅" : "\nWT-6A E2E: FAIL ❌");
[op, tv1.rx, tv2.rx].forEach((w) => w.close());
process.exit(allOk ? 0 : 1);
