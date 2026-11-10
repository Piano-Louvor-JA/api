/**
 * RF-01..RF-08 — Editas da Comunidade (API): fila custom_edits.
 * PLAN §2: matriz RF→testes é o contrato de cobertura.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { hashToken } from "../../src/v1/custom/auth.service.js";
import { type SeededDb, setupSeededDb } from "../helpers/seeded-db.js";

const LYRICS = JSON.stringify([{ text: "Slava hosana", timing: 0 }]);
const LYRICS_2 = JSON.stringify([{ text: "Slava hosana (corrigido)", timing: 0 }]);

describe("custom edits — concilio", () => {
  let app: SeededDb;
  let authorToken: string;
  let gmToken: string;
  let plainToken: string;
  let authorId = 0;
  let gmId = 0;
  let plainId = 0;

  beforeAll(async () => {
    app = await setupSeededDb();
    const db = app.getDb();
    const mk = (email: string, isGm = false) =>
      Number(
        db
          .prepare(
            `INSERT INTO custom_users (email, password_hash, display_name, tenant_id, is_gm)
             VALUES (?, 'x', ?, 'piano', ?)`,
          )
          .run(email, email.split("@")[0], isGm ? 1 : 0).lastInsertRowid,
      );
    authorId = mk("edit-author@tenant.local");
    gmId = mk("edit-gm@tenant.local", true);
    plainId = mk("edit-plain@tenant.local");
    const tok = (label: string, id: number) => {
      const t = `edit-${label}-token`;
      db.prepare(`INSERT INTO custom_sessions (token_hash, id_user) VALUES (?, ?)`).run(hashToken(t), id);
      return t;
    };
    authorToken = tok("author", authorId);
    gmToken = tok("gm", gmId);
    plainToken = tok("plain", plainId);
  });

  afterAll(() => app.cleanup());

  const publish = (token: string, body: Record<string, unknown>) =>
    app.router.request("/v1/custom/edits", {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  it("RF-03: sem sessão → 401, não publica", async () => {
    const r = await app.router.request("/v1/custom/edits", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ clientUuid: "c".repeat(40), musicId: 1, lyrics: LYRICS }),
    });
    expect(r.status).toBe(401);
  });

  it("RF-03: publica edit (published) com payload mínimo", async () => {
    const r = await publish(authorToken, { clientUuid: "a".repeat(40), musicId: 1, lyrics: LYRICS });
    expect(r.status).toBe(201);
    const body = (await r.json()) as { id: number; status: string };
    expect(body.status).toBe("published");
  });

  it("RF-03: re-publicar mesmo clientUuid (idêntico) → idempotente, sem duplicar", async () => {
    const r = await publish(authorToken, { clientUuid: "a".repeat(40), musicId: 1, lyrics: LYRICS });
    expect([200, 201]).toContain(r.status);
    const db = app.getDb();
    const n = db.prepare(`SELECT COUNT(*) AS n FROM custom_edits WHERE client_uuid = ?`).get("a".repeat(40)) as { n: number };
    expect(n.n).toBe(1);
  });

  it("RF-04: segundo publish do mesmo autor/música substitui (upsert do pending)", async () => {
    const r = await publish(authorToken, { clientUuid: "b".repeat(40), musicId: 1, lyrics: LYRICS_2 });
    expect([200, 201]).toContain(r.status);
    const db = app.getDb();
    const rows = db.prepare(`SELECT lyrics, status FROM custom_edits WHERE music_id = 1 AND author_user_id = ? AND status = 'published'`).all(authorId) as { lyrics: string; status: string }[];
    expect(rows).toHaveLength(1);
    expect(rows[0].lyrics).toBe(LYRICS_2);
  });

  it("RF-01: payload sem lyrics E sem timing → 422 (nada editável)", async () => {
    const r = await publish(authorToken, { clientUuid: "c".repeat(40), musicId: 1 });
    expect(r.status).toBe(422);
  });

  it("MULTI-TENANT: GM do violin não vê fila do piano; decide cross-tenant → 404", async () => {
    const db = app.getDb();
    // GM no tenant violin
    const gmViolinId = Number(
      db.prepare(`INSERT INTO custom_users (email, password_hash, display_name, tenant_id, is_gm) VALUES ('gm-violin@t.local','x','GMV','violin',1)`).run().lastInsertRowid,
    );
    const gmViolinToken = "gm-violin-token";
    db.prepare(`INSERT INTO custom_sessions (token_hash, id_user) VALUES (?, ?)`).run(hashToken(gmViolinToken), gmViolinId);

    // GM do autor publicou no piano (edit 1 já existe dos testes anteriores)
    const queue = await app.router.request("/v1/custom/edits?status=published", {
      headers: { authorization: `Bearer ${gmViolinToken}`, "x-tenant": "violin" },
    });
    expect(queue.status).toBe(200);
    const body = (await queue.json()) as { edits: unknown[] };
    expect(body.edits).toHaveLength(0); // violin não vê nada do piano

    // decisão cross-tenant: GM violin tenta decidir edit do piano → 404
    const rows = db.prepare(`SELECT id FROM custom_edits WHERE tenant_id = 'piano' AND status = 'published'`).all() as { id: number }[];
    expect(rows.length).toBeGreaterThan(0);
    const cross = await app.router.request(`/v1/custom/edits/${rows[0].id}/decide`, {
      method: "POST",
      headers: { authorization: `Bearer ${gmViolinToken}`, "x-tenant": "violin", "content-type": "application/json" },
      body: JSON.stringify({ decision: "approved" }),
    });
    expect(cross.status).toBe(404); // não existe no tenant dele
    const still = db.prepare(`SELECT status FROM custom_edits WHERE id = ?`).get(rows[0].id) as { status: string };
    expect(still.status).toBe("published"); // intocado
  });

  it("RF-06: GET fila sem GM → 403", async () => {
    const r = await app.router.request("/v1/custom/edits?status=published", {
      headers: { authorization: `Bearer ${plainToken}` },
    });
    expect(r.status).toBe(403);
  });

  it("RF-06: GET fila com GM → published com autor", async () => {
    const r = await app.router.request("/v1/custom/edits?status=published", {
      headers: { authorization: `Bearer ${gmToken}` },
    });
    expect(r.status).toBe(200);
    const body = (await r.json()) as { edits: { musicId: number; status: string }[] };
    expect(body.edits.length).toBeGreaterThanOrEqual(1);
    expect(body.edits.every((e) => e.status === "published")).toBe(true);
  });

  it("RF-04/RF-05: reject exige reason; decisão registra decided_by/at", async () => {
    const list = await app.router.request("/v1/custom/edits?status=published", {
      headers: { authorization: `Bearer ${gmToken}` },
    });
    const { edits } = (await list.json()) as { edits: { id: number }[] };
    const target = edits.find((e) => e.musicId === 1) ?? edits[0];

    const noReason = await app.router.request(`/v1/custom/edits/${target.id}/decide`, {
      method: "POST",
      headers: { authorization: `Bearer ${gmToken}`, "content-type": "application/json" },
      body: JSON.stringify({ decision: "rejected" }),
    });
    expect(noReason.status).toBe(422);

    const ok = await app.router.request(`/v1/custom/edits/${target.id}/decide`, {
      method: "POST",
      headers: { authorization: `Bearer ${gmToken}`, "content-type": "application/json" },
      body: JSON.stringify({ decision: "rejected", reason: "letra diverge da fonte oficial" }),
    });
    expect(ok.status).toBe(200);

    const db = app.getDb();
    const row = db.prepare(`SELECT status, reason, decided_by, decided_at FROM custom_edits WHERE id = ?`).get(target.id) as
      { status: string; reason: string; decided_by: number; decided_at: string };
    expect(row.status).toBe("rejected");
    expect(row.reason).toContain("fonte oficial");
    expect(row.decided_by).toBe(gmId);
    expect(row.decided_at).toBeTruthy();
  });

  it("RF-05: approve preserva histórico auditável", async () => {
    // autor 2 publica; GM aprova
    const pub = await publish(plainToken, { clientUuid: "d".repeat(40), musicId: 2, timing: JSON.stringify([0, 4200]) });
    expect(pub.status).toBe(201);
    const list = await app.router.request("/v1/custom/edits?status=published", {
      headers: { authorization: `Bearer ${gmToken}` },
    });
    const { edits } = (await list.json()) as { edits: { id: number; musicId: number }[] };
    const target = edits.find((e) => e.musicId === 2)!;
    const ok = await app.router.request(`/v1/custom/edits/${target.id}/decide`, {
      method: "POST",
      headers: { authorization: `Bearer ${gmToken}`, "content-type": "application/json" },
      body: JSON.stringify({ decision: "approved" }),
    });
    expect(ok.status).toBe(200);

    const hist = await app.router.request(`/v1/custom/edits/${target.id}/history`);
    expect(hist.status).toBe(200);
    const body = (await hist.json()) as { history: { status: string; at: string; by?: number | null }[] };
    expect(body.history.some((h) => h.status === "published")).toBe(true);
    expect(body.history.some((h) => h.status === "approved" && h.by === gmId)).toBe(true);
  });

  it("RF-08: applied só expõe approved; draft/mine fica com o autor", async () => {
    const applied = await app.router.request("/v1/custom/edits/applied?musicIds=1,2");
    expect(applied.status).toBe(200);
    const body = (await applied.json()) as { applied: { musicId: number }[] };
    expect(body.applied.every((e) => e.musicId === 2)).toBe(true);

    const mine = await app.router.request("/v1/custom/edits/mine", {
      headers: { authorization: `Bearer ${authorToken}` },
    });
    expect(mine.status).toBe(200);
    const mineBody = (await mine.json()) as { edits: { musicId: number }[] };
    expect(mineBody.edits.some((e) => e.musicId === 1)).toBe(true);
  });

  it("RF-07: isConcilioMember reflete is_gm", async () => {
    const { isConcilioMember } = await import("../../src/v1/custom/edits.service.js");
    const db = app.getDb();
    expect(isConcilioMember(db, gmId)).toBe(true);
    expect(isConcilioMember(db, plainId)).toBe(false);
  });
});
