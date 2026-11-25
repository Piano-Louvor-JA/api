// E2E manual WT-5: receiver fake conecta no relay da API local e verifica
// que recebe a projection que o operador publica (simulado via role=sender).
import WebSocket from "ws";
import { resolveApiBase, toWs } from "./e2e-api.mjs";

const API = resolveApiBase();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  // 1. cria sessão (operator pede código+token)
  const res = await fetch(`${API}/v1/palco/sessions`, { method: "POST" });
  if (res.status !== 201)
    throw new Error(`create session failed: ${res.status}`);
  const { code, token } = await res.json();
  console.log("session:", code);

  // 2. receiver conecta (só código, sem token — busca via endpoint público)
  const tk = await (
    await fetch(`${API}/v1/palco/sessions/${code}/token`)
  ).json();
  const rxUrl = `${toWs(API)}/v1/palco/relay/${code}?token=${encodeURIComponent(tk.token)}&role=receiver&cid=fake-tv-1`;
  const rx = new WebSocket(rxUrl);
  const received = [];
  rx.on("message", (d) => received.push(JSON.parse(d.toString())));
  await new Promise((res2, rej) => {
    rx.on("open", res2);
    rx.on("error", rej);
  });
  console.log("receiver conectado");

  // 3. "operator" conecta e publica uma projection v2 (hino ativo)
  const op = new WebSocket(
    `${toWs(API)}/v1/palco/relay/${code}?token=${encodeURIComponent(token)}&role=operator&cid=fake-op`,
  );
  await new Promise((res2, rej) => {
    op.on("open", res2);
    op.on("error", rej);
  });
  const msg = JSON.stringify({
    v: 2,
    type: "projection",
    text: "Senhor Deus dos exércitos",
    footer: "Santo, Santo, Santo",
    fontSize: 4,
    textShadow: true,
  });
  const opReceived = [];
  op.on("message", (d) => opReceived.push(JSON.parse(d.toString())));
  op.send(JSON.stringify({ type: "ping" }));
  op.send(msg);
  await sleep(500);

  const proj = received.find((m) => m.type === "projection");
  const pong = opReceived.find((m) => m.type === "pong");
  console.log("receiver recebeu:", JSON.stringify(received));
  const ok =
    proj &&
    proj.text === "Senhor Deus dos exércitos" &&
    proj.footer === "Santo, Santo, Santo";
  console.log(ok ? "E2E PASS: projection chegou no receiver" : "E2E FAIL");
  console.log("pong keepalive:", pong ? "ok" : "FALHOU");
  rx.close();
  op.close();
  process.exit(ok && pong ? 0 : 1);
}
main().catch((e) => {
  console.error("E2E ERROR:", e.message);
  process.exit(1);
});
