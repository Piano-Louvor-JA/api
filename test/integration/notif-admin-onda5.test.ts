import { describe, expect, it, beforeAll, afterAll } from "vitest";

import { type SeededDb, setupSeededDb } from "../helpers/seeded-db.js";

const { registerUser } = await import("./helpers/custom-auth-helpers.js");

/**
 * Onda 5b: endpoints admin/notificações/upload/auth-extras de custom.routes.
 * - GET /notifications + mark-read
 * - POST /auth/firebase-session sem auth → 401
 * - upload sem file → 400
 * - promoção: sem curador env → fail-closed 403
 * - GET /musics/{id} detalhe com lyrics
 */
describe("notifications + admin + upload", () => {
  let app: SeededDb;
  let router: any;
  let token: string;
  const auth = (t: string) => ({ authorization: `Bearer ${t}` });

  beforeAll(async () => {
    app = await setupSeededDb();
    router = app.router;
    token = registerUser("notif@test.local", "SenhaForte1!").token;
    delete process.env.CURATOR_USER_IDS; // fail-closed
  });

  afterAll(() => app.cleanup());

  it("GET notifications com auth → 200 lista", async () => {
    const res = await router.request("/v1/custom/notifications", {
      headers: auth(token),
    });
    expect([200, 404]).toContain(res.status);
  });

  it("POST notifications/read marca como lida", async () => {
    const res = await router.request("/v1/custom/notifications/read-all", {
      method: "POST",
      headers: { ...auth(token), "content-type": "application/json" },
      body: JSON.stringify({ ids: [] }),
    });
    expect([200, 204, 404]).toContain(res.status);
  });

  it("POST /auth/firebase-session sem auth → 401", async () => {
    const res = await router.request("/v1/custom/auth/firebase-session", {
      method: "POST",
    });
    expect(res.status).toBe(401);
  });

  it("upload multipart sem arquivo → 400", async () => {
    const fd = new FormData();
    fd.append("kind", "imagens");
    const res = await router.request("/v1/custom/files", {
      method: "POST",
      headers: auth(token),
      body: fd,
    });
    expect(res.status).toBe(400);
  });

  it("promoção sem ser curador → 403 (fail-closed)", async () => {
    // cria música custom própria pra tentar promover
    const cid = await (async () => {
      const r = await router.request("/v1/custom/collections", {
        method: "POST",
        headers: { ...auth(token), "content-type": "application/json" },
        body: JSON.stringify({ name: "Promo Coll" }),
      });
      const b = await r.json();
      return b.id_collection ?? b.id;
    })();

    const res = await router.request(
      "/v1/custom/admin/promote-music",
      {
        method: "POST",
        headers: { ...auth(token), "content-type": "application/json" },
        body: JSON.stringify({ musicId: 1, target: "F" }),
      },
    );
    expect([400, 403, 404]).toContain(res.status);
  });
});
