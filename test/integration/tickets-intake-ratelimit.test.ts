// B1 Slice 6 — antiabuso do intake público (RF-03: rate limit + payload limit)
process.env.TICKETS_AUTH_TEST_MODE = "1";

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../../src/app.js";
import { closeDb, getDb, initDb } from "../../src/db/connection.js";
import { buildTicketsRoutes } from "../../src/v1/tickets/tickets.routes.js";

const VALID = {
  requester_name: "Maria",
  requester_email: "maria@example.com",
  subject: "Solicitação válida",
  message: "Mensagem longa o suficiente",
  consent_lgpd: true,
};

async function postIntake(app: ReturnType<typeof createApp>) {
  return app.request("/v1/tickets/public/intake", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(VALID),
  });
}

describe("intake público — rate limit antiabuso", () => {
  let app: ReturnType<typeof createApp>;
  beforeEach(() => {
    closeDb();
    process.env.DB_PATH = ":memory:";
    process.env.TICKETS_INTAKE_RATE_MAX = "3";
    initDb();
    app = createApp();
    app.route("/v1/tickets", buildTicketsRoutes());
  });
  afterEach(() => {
    delete process.env.TICKETS_INTAKE_RATE_MAX;
  });

  it("permite até o limite e depois 429 sem criar registro", async () => {
    for (let i = 0; i < 3; i++) {
      const res = await postIntake(app);
      expect(res.status, `req ${i + 1}`).toBe(201);
    }
    const blocked = await postIntake(app);
    expect(blocked.status).toBe(429);
    expect(
      (
        getDb().prepare("SELECT COUNT(*) c FROM triage_requests").get() as {
          c: number;
        }
      ).c,
    ).toBe(3);
  });

  it("429 inclui Retry-After", async () => {
    for (let i = 0; i < 3; i++) await postIntake(app);
    const blocked = await postIntake(app);
    expect(blocked.headers.get("retry-after")).toBeTruthy();
  });
});
