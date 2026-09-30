import { loadEnvFile } from "node:process";
import { serve } from "@hono/node-server";
import { createApp } from "./app.js";
import { validateEnv } from "./config/env.js";
import { initDb } from "./db/connection.js";
import { getPalcoWs } from "./v1/palco/palco.routes.js";

// Carrega `.env` no próprio processo. Cobre `node dist/index.js` direto,
// não apenas `npm start` — sem a chave o relay criava sala e recusava WS 4404.
try {
  loadEnvFile(".env");
} catch {
  /* .env é opcional fora de dev */
}

// RF-04: fail fast se env inválida
validateEnv(process.env as Record<string, string | undefined>);

const app = createApp();
const port = Number(process.env.PORT ?? 3100);

initDb();

// Purge de tombstones >30d no boot (B5) — falha aqui não derruba o servidor
try {
  const { purgeTombstones } = await import("./v1/custom/quota.service.js");
  const purged = purgeTombstones(30);
  if (purged.collections || purged.musics) {
    console.log(`[purge] tombstones removidos: ${JSON.stringify(purged)}`);
  }
} catch (e) {
  console.error("[purge] falhou (não-fatal):", e);
}

const server = serve(
  { fetch: app.fetch, port, hostname: "0.0.0.0" },
  (info) => {
    console.log(`piano-api rodando na porta ${info.port}`);
  },
);

// WT-5a: injeta suporte a WebSocket no servidor HTTP (relay do Palco)
getPalcoWs().injectWebSocket(server);
