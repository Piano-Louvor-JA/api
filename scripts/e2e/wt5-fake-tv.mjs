// Receiver fake WT-5: conecta como TV na sessão informada e loga tudo que recebe.
import WebSocket from "ws";
import { resolveApiBase, toWs } from "./e2e-api.mjs";

const code = process.argv[2];
const token = process.argv[3];
const API = resolveApiBase();
const rx = new WebSocket(
  `${toWs(API)}/v1/palco/relay/${code}?token=${encodeURIComponent(token)}&role=receiver&cid=fake-tv-1`,
);
rx.on("open", () => console.log("[receiver] conectado na sessão", code));
rx.on("message", (d) => {
  const m = JSON.parse(d.toString());
  console.log("[receiver] msg:", JSON.stringify(m));
});
rx.on("close", (c, r) => console.log("[receiver] fechou", c, r.toString()));
rx.on("error", (e) => console.log("[receiver] erro:", e.message));
setInterval(() => {
  try {
    rx.send(JSON.stringify({ type: "ping" }));
  } catch {}
}, 10000);
