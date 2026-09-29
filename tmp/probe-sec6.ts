import { createApp } from "./src/app.js";
import { initDb, closeDb } from "./src/db/connection.js";

async function main() {
  process.env.DB_PATH = ":memory:";
  initDb();
  const app = createApp();

  for (const ip of ["10.0.0.1", "10.0.0.2"]) {
    for (let i = 0; i < 5; i++) {
      const req = new Request("http://localhost/v1/categories", {
        method: "GET",
        headers: ip !== "localhost" ? { "x-real-ip": ip } : undefined,
      });
      const res = await app.request(req);
      console.log(ip, i, res.status);
    }
  }

  closeDb();
}

main();