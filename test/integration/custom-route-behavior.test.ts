import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { hashToken } from "../../src/v1/custom/auth.service.js";
import { type SeededDb, setupSeededDb } from "../helpers/seeded-db.js";
import { registerUser } from "./helpers/custom-auth-helpers.js";

let fixture: SeededDb,
  user: ReturnType<typeof registerUser>,
  cid: number,
  mid: number;
beforeAll(async () => {
  fixture = await setupSeededDb();
  user = registerUser("behavior@test.local", "SenhaForte1!");
  const db = fixture.getDb();
  cid = Number(
    db
      .prepare("INSERT INTO custom_collections (name, owner_id) VALUES (?, ?)")
      .run("Owner", user.id_user).lastInsertRowid,
  );
  mid = Number(
    db
      .prepare(
        "INSERT INTO custom_musics (id_collection, name, owner_id) VALUES (?, ?, ?)",
      )
      .run(cid, "Music", user.id_user).lastInsertRowid,
  );
  db.prepare(
    'INSERT INTO custom_lyrics (id_music, lyric, "order") VALUES (?, ?, ?)',
  ).run(mid, "Lyric", 1);
});
afterAll(() => {
  vi.unstubAllEnvs();
  fixture.cleanup();
});
const headers = () => ({
  authorization: `Bearer ${user.token}`,
  "content-type": "application/json",
});
it("evento sazonal inativo e ativo preserva descrição opcional", async () => {
  const db = fixture.getDb();
  db.prepare("UPDATE seasonal_events SET active=0").run();
  expect(
    await (await fixture.router.request("/v1/custom/seasonal-event")).json(),
  ).toEqual({ active: false });
  db.prepare(
    "INSERT INTO seasonal_events (name, description, starts_at, ends_at, multiplier, active) VALUES (?, ?, ?, ?, ?, ?)",
  ).run("Event", null, "2000-01-01", "2100-01-01", 2, 1);
  expect(
    await (await fixture.router.request("/v1/custom/seasonal-event")).json(),
  ).toEqual({ active: true, name: "Event", multiplier: 2 });
  db.prepare(
    "UPDATE seasonal_events SET description='Description' WHERE name='Event'",
  ).run();
  expect(
    await (await fixture.router.request("/v1/custom/seasonal-event")).json(),
  ).toMatchObject({ description: "Description" });
  db.prepare("UPDATE seasonal_events SET active=0").run();
});
it("curador autorizado promove faixa e credita o autor", async () => {
  vi.stubEnv("CURATOR_USER_IDS", String(user.id_user));
  const res = await fixture.router.request("/v1/custom/admin/promote-music", {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({ custom_music_id: mid, official_music_id: 1 }),
  });
  expect(res.status).toBe(200);
  expect(await res.json()).toMatchObject({
    ok: true,
    awarded_to: user.id_user,
    points: 50,
  });
  expect(
    fixture
      .getDb()
      .prepare("SELECT official_music_id FROM custom_musics WHERE id_music=?")
      .get(mid),
  ).toMatchObject({ official_music_id: 1 });
});
it("cópia em outra coletânea preserva letra e ordem", async () => {
  const db = fixture.getDb();
  const dest = Number(
    db
      .prepare("INSERT INTO custom_collections (name, owner_id) VALUES (?, ?)")
      .run("Destination", user.id_user).lastInsertRowid,
  );
  const res = await fixture.router.request(
    `/v1/custom/collections/${dest}/musics/${mid}/copy`,
    { method: "POST", headers: headers(), body: "{}" },
  );
  expect(res.status).toBe(201);
  const copy = await res.json();
  expect(copy.id_music).not.toBe(mid);
  expect(
    db
      .prepare('SELECT lyric, "order" FROM custom_lyrics WHERE id_music=?')
      .all(copy.id_music),
  ).toEqual([{ lyric: "Lyric", order: 1 }]);
});
it("reset consome token válido e impede reutilização", async () => {
  const token = "reset-valid-token-123456789";
  fixture
    .getDb()
    .prepare(
      "UPDATE custom_users SET reset_token_hash=?,reset_token_expires=? WHERE id_user=?",
    )
    .run(
      hashToken(token),
      new Date(Date.now() + 60000).toISOString(),
      user.id_user,
    );
  const request = () =>
    fixture.router.request("/v1/custom/auth/reset-password", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token, password: "NovaSenhaForte1!" }),
    });
  expect((await request()).status).toBe(200);
  expect((await request()).status).toBe(400);
});
