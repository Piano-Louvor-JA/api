// Teste manual de telemetria com Node 24
import { createApp } from "./dist/src/app.js";
import { initDb, closeDb } from "./dist/src/db/connection.js";

async function test() {
  process.env.DB_PATH = ":memory:";
  initDb();
  const app = createApp();

  // Testar se rota existe
  try {
    const res = await app.request("http://localhost/v1/telemetry/debug");
    console.log("DEBUG ROTA STATUS:", res.status);
    const body = await res.text();
    console.log("DEBUG ROTA BODY:", body.slice(0, 200));
  } catch (err) {
    console.error("ERRO ROTA DEBUG", err.message);
  }

  // Testar normal requests
  try {
    const res1 = await app.request("http://localhost/v1/categories");
    console.log("CAT 1 STATUS:", res1.status);
  } catch (err) {
    console.error("ERRO CAT 1", err.message);
  }

  closeDb();
}

test().catch(console.error);