/** Idempotência do conteúdo preserva o autor e o tenant autenticados. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { initDb } from "../../src/db/connection.js";
import { hashToken } from "../../src/v1/custom/auth.service.js";
import { type SeededDb, setupSeededDb } from "../helpers/seeded-db.js";

const LYRICS = JSON.stringify([{ text: "Santo, Santo, Santo" }]);

describe("custom edits — idempotência isolada", () => {
  let app: SeededDb;
  const authors: { id: number; token: string; tenant: string }[] = [];

  beforeAll(async () => {
    app = await setupSeededDb();
    const db = app.getDb();
    for (const [index, tenant] of ["piano", "piano", "violin"].entries()) {
      const id = Number(
        db
          .prepare(`INSERT INTO custom_users (email, password_hash, display_name, tenant_id)
        VALUES (?, 'x', 'Autor', ?)`)
          .run(`scoped-${index}@tenant.local`, tenant).lastInsertRowid,
      );
      const token = `scoped-edit-author-${index}`;
      db.prepare(
        `INSERT INTO custom_sessions (token_hash, id_user) VALUES (?, ?)`,
      ).run(hashToken(token), id);
      authors.push({ id, token, tenant });
    }
  });
  afterAll(() => app.cleanup());

  const publish = (index: number, clientUuid: string, musicId = 1) =>
    app.router.request("/v1/custom/edits", {
      method: "POST",
      headers: {
        authorization: `Bearer ${authors[index].token}`,
        "x-tenant": authors[index].tenant,
        "content-type": "application/json",
      },
      body: JSON.stringify({ clientUuid, musicId, lyrics: LYRICS }),
    });
  const mine = async (index: number) => {
    const r = await app.router.request("/v1/custom/edits/mine", {
      headers: {
        authorization: `Bearer ${authors[index].token}`,
        "x-tenant": authors[index].tenant,
      },
    });
    expect(r.status).toBe(200);
    return ((await r.json()) as { edits: { id: number; musicId: number }[] })
      .edits;
  };

  it("mesmo conteúdo de outro autor cria uma contribuição própria e retries retornam só seu ID", async () => {
    const clientUuid = "same-content-two-authors";
    const first = await publish(0, clientUuid);
    expect(first.status).toBe(201);
    const own = (await first.json()) as { id: number };
    const second = await publish(1, clientUuid);
    expect(second.status).toBe(201);
    const other = (await second.json()) as { id: number };
    expect(other.id).not.toBe(own.id);
    expect((await mine(0)).map((e) => e.id)).toContain(own.id);
    expect((await mine(1)).map((e) => e.id)).toEqual([other.id]);
    const retry = await publish(1, clientUuid);
    expect(retry.status).toBe(201);
    expect(await retry.json()).toMatchObject({ id: other.id });
  });

  it("mesmo conteúdo em outro tenant não colide nem devolve ID do primeiro tenant", async () => {
    const clientUuid = "same-content-two-tenants";
    const first = await publish(0, clientUuid, 30);
    expect(first.status).toBe(201);
    const own = (await first.json()) as { id: number };
    const second = await publish(2, clientUuid, 30);
    expect(second.status).toBe(201);
    const other = (await second.json()) as { id: number };
    expect(other.id).not.toBe(own.id);
    expect((await mine(2)).map((e) => e.id)).toEqual([other.id]);
    const retry = await publish(2, clientUuid, 30);
    expect(retry.status).toBe(201);
    expect(await retry.json()).toMatchObject({ id: other.id });
  });

  it("reaplicar migrations preserva dados, papéis e idempotência com chaves compartilhadas", async () => {
    const clientUuid = "same-content-migration-replay";
    const ids: number[] = [];
    for (let index = 0; index < authors.length; index++) {
      const r = await publish(index, clientUuid, 31);
      expect(r.status).toBe(201);
      ids.push(((await r.json()) as { id: number }).id);
    }
    expect(new Set(ids).size).toBe(authors.length);
    app
      .getDb()
      .prepare("UPDATE custom_users SET is_gm = 1 WHERE id_user = ?")
      .run(authors[0].id);
    const before = app
      .getDb()
      .prepare("SELECT * FROM custom_edits ORDER BY id")
      .all();
    initDb();
    initDb();
    expect(
      app.getDb().prepare("SELECT * FROM custom_edits ORDER BY id").all(),
    ).toEqual(before);
    expect(
      app
        .getDb()
        .prepare("SELECT is_gm FROM custom_users WHERE id_user = ?")
        .get(authors[0].id),
    ).toEqual({ is_gm: 1 });
    for (let index = 0; index < authors.length; index++) {
      const retry = await publish(index, clientUuid, 31);
      expect(retry.status).toBe(201);
      expect(await retry.json()).toMatchObject({ id: ids[index] });
    }
    expect(
      app.getDb().prepare("SELECT COUNT(*) AS n FROM custom_edits").get(),
    ).toEqual({ n: before.length });
  });
});
