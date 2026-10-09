import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { hashToken, verifyPassword } from "../../src/v1/custom/auth.service.js";
import { type SeededDb, setupSeededDb } from "../helpers/seeded-db.js";
import { registerUser } from "./helpers/custom-auth-helpers.js";

describe("Custom API boundary contracts", () => {
  let app: SeededDb;
  let owner: ReturnType<typeof registerUser>;
  let other: ReturnType<typeof registerUser>;
  let cid: number;
  let mid: number;
  let media: string;
  const uploadedFiles: string[] = [];
  const headers = (token = owner.token) => ({
    authorization: `Bearer ${token}`,
    "content-type": "application/json",
  });
  const request = (
    path: string,
    method = "GET",
    body?: unknown,
    token?: string,
  ) =>
    app.router.request(`/v1/custom${path}`, {
      method,
      headers: headers(token),
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  beforeAll(async () => {
    media = mkdtempSync(join(tmpdir(), "plj-boundary-"));
    vi.stubEnv("SMTP_HOST", "");
    app = await setupSeededDb();
    owner = registerUser("boundaries@test.local", "SenhaForte1!");
    other = registerUser("outsider@test.local", "SenhaForte1!");
    const collection = await request("/collections", "POST", {
      name: "Boundaries",
    });
    expect(collection.status).toBe(201);
    cid = (await collection.json()).id_collection;
    const music = await request(`/collections/${cid}/musics`, "POST", {
      name: "Original",
    });
    expect(music.status).toBe(201);
    mid = (await music.json()).id_music;
  });
  afterEach(() => vi.restoreAllMocks());
  afterAll(() => {
    app.cleanup();
    vi.unstubAllEnvs();
    for (const path of uploadedFiles) rmSync(path, { force: true });
    rmSync(media, { recursive: true, force: true });
  });

  it("normalizes invalid pagination without removing results", async () => {
    const res = await request("/collections?page=invalid&per_page=invalid");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.meta).toMatchObject({ page: 1, per_page: 24 });
    expect(
      body.data.some(
        (row: { id_collection: number }) => row.id_collection === cid,
      ),
    ).toBe(true);
  });
  it("updates a cover URL without overwriting other fields", async () => {
    const res = await request(`/collections/${cid}`, "PUT", {
      cover_url: "https://example.test/cover.png",
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      name: "Boundaries",
      cover_url: "https://example.test/cover.png",
    });
  });
  it.each([
    [
      "/collections/999999/musics",
      "POST",
      { name: "Missing" },
      "Coletânea não encontrada",
    ],
    ["/musics/999999", "PUT", { name: "Missing" }, "Música não encontrada"],
    [
      "/musics/999999/lyrics",
      "POST",
      { lyric: "Missing" },
      "Música não encontrada",
    ],
  ])("%s returns a specific 404", async (path, method, body, error) => {
    const res = await request(path, method, body);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error });
  });
  it("denies deletion by another user and preserves the music", async () => {
    const res = await request(
      `/musics/${mid}`,
      "DELETE",
      undefined,
      other.token,
    );
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      error: "Sem permissão para remover esta música",
    });
    expect(
      app
        .getDb()
        .prepare("SELECT id_music FROM custom_musics WHERE id_music = ?")
        .get(mid),
    ).toBeDefined();
  });
  it("copies verses and their timings into a different collection", async () => {
    const verse = await request(`/musics/${mid}/lyrics`, "POST", {
      lyric: "Verse",
      aux_lyric: "Aux",
      time: "00:10",
      instrumental_time: "00:12",
    });
    expect(verse.status).toBe(201);
    const dest = await request("/collections", "POST", { name: "Destination" });
    const destId = (await dest.json()).id_collection;
    const copied = await request(
      `/collections/${destId}/musics/${mid}/copy`,
      "POST",
    );
    expect(copied.status).toBe(201);
    const id = (await copied.json()).id_music;
    const verses = await request(`/musics/${id}/lyrics`);
    const data = await verses.json();
    expect(data.data).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          lyric: "Verse",
          aux_lyric: "Aux",
          time: "00:10",
          instrumental_time: "00:12",
        }),
      ]),
    );
  });
  it("password reset is single-use and revokes all old sessions", async () => {
    const user = registerUser("reset-boundary@test.local", "SenhaForte1!");
    const token = "reset-boundary-token-valid-length";
    app
      .getDb()
      .prepare(
        "UPDATE custom_users SET reset_token_hash = ?, reset_token_expires = ? WHERE id_user = ?",
      )
      .run(
        hashToken(token),
        new Date(Date.now() + 3600000).toISOString(),
        user.id_user,
      );
    const body = { token, password: "NovaSenhaForte2!" };
    const reset = await request("/auth/reset-password", "POST", body);
    expect(reset.status).toBe(200);
    expect(await reset.json()).toEqual({ ok: true });
    const row = app
      .getDb()
      .prepare(
        "SELECT password_hash, reset_token_hash FROM custom_users WHERE id_user = ?",
      )
      .get(user.id_user) as {
      password_hash: string;
      reset_token_hash: string | null;
    };
    expect(verifyPassword(body.password, row.password_hash)).toBe(true);
    expect(row.reset_token_hash).toBeNull();
    expect(
      app
        .getDb()
        .prepare("SELECT 1 FROM custom_sessions WHERE id_user = ?")
        .get(user.id_user),
    ).toBeUndefined();
    expect((await request("/auth/reset-password", "POST", body)).status).toBe(
      400,
    );
    expect(
      (await request("/auth/me", "GET", undefined, user.token)).status,
    ).toBe(401);
  });
  it("forgot password exposes a token only when the documented flag is enabled", async () => {
    vi.stubEnv("RESET_TOKEN_EXPOSE", "1");
    const res = await request("/auth/forgot-password", "POST", {
      email: "boundaries@test.local",
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.token).toEqual(expect.any(String));
    expect(
      app
        .getDb()
        .prepare("SELECT 1 FROM custom_users WHERE reset_token_hash = ?")
        .get(hashToken(body.token)),
    ).toBeDefined();
    vi.stubEnv("RESET_TOKEN_EXPOSE", "0");
  });
  it("curator promotion fails closed without configured curator IDs", async () => {
    vi.stubEnv("CURATOR_USER_IDS", "");
    const res = await request("/admin/promote-music", "POST", {
      custom_music_id: mid,
      official_music_id: 30,
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "Sem permissão de curador" });
  });
  it("authorized curator receives a specific error for a missing music", async () => {
    vi.stubEnv("CURATOR_USER_IDS", `invalid,-1,0,${owner.id_user}`);
    const res = await request("/admin/promote-music", "POST", {
      custom_music_id: 999999,
      official_music_id: 30,
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Faixa custom não encontrada" });
  });
  it("authorized promotion credits the author and persists a notification", async () => {
    vi.stubEnv("CURATOR_USER_IDS", String(owner.id_user));
    const res = await request("/admin/promote-music", "POST", {
      custom_music_id: mid,
      official_music_id: 30,
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      awarded_to: owner.id_user,
      points: 50,
    });
    const promotion = app
      .getDb()
      .prepare(
        "SELECT author_user_id FROM official_promotions WHERE custom_music_id = ?",
      )
      .get(mid);
    expect(promotion).toEqual({ author_user_id: owner.id_user });
    expect(
      app
        .getDb()
        .prepare(
          "SELECT type FROM user_notifications WHERE user_id = ? AND type = 'music_promoted'",
        )
        .get(owner.id_user),
    ).toEqual({ type: "music_promoted" });
  });
  it("seasonal banner distinguishes no event from an active event", async () => {
    const db = app.getDb();
    db.prepare("DELETE FROM seasonal_events").run();
    expect(await (await request("/seasonal-event")).json()).toEqual({
      active: false,
    });
    db.prepare(
      "INSERT INTO seasonal_events (name, description, multiplier, starts_at, ends_at, active) VALUES ('Event', NULL, 2, datetime('now','-1 day'), datetime('now','+1 day'), 1)",
    ).run();
    expect(await (await request("/seasonal-event")).json()).toEqual({
      active: true,
      name: "Event",
      multiplier: 2,
    });
    db.prepare("UPDATE seasonal_events SET description = 'Description'").run();
    expect(await (await request("/seasonal-event")).json()).toMatchObject({
      description: "Description",
    });
  });
  it("upload rejects a string pretending to be a file", async () => {
    const form = new FormData();
    form.set("file", "text");
    const res = await app.router.request("/v1/custom/files", {
      method: "POST",
      headers: { authorization: `Bearer ${owner.token}` },
      body: form,
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: 'Campo "file" ausente ou inválido',
    });
  });
  it("upload over quota returns 413 without inserting a file", async () => {
    vi.stubEnv("CUSTOM_QUOTA_MB", "0.000001");
    const form = new FormData();
    form.set("file", new File(["too many bytes"], "over.jpg"));
    const res = await app.router.request("/v1/custom/files", {
      method: "POST",
      headers: { authorization: `Bearer ${owner.token}` },
      body: form,
    });
    expect(res.status).toBe(413);
    expect(await res.json()).toMatchObject({ error: "quota_exceeded" });
    expect(
      app.getDb().prepare("SELECT 1 FROM files WHERE name = 'over.jpg'").get(),
    ).toBeUndefined();
    vi.stubEnv("CUSTOM_QUOTA_MB", "100");
  });
  it("upload collisions without an extension preserve both payloads", async () => {
    const upload = () => {
      const form = new FormData();
      form.set("file", new File(["bytes"], basename(media)));
      return app.router.request("/v1/custom/files", {
        method: "POST",
        headers: { authorization: `Bearer ${owner.token}` },
        body: form,
      });
    };
    const first = await upload();
    const second = await upload();
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    const firstBody = await first.json();
    const secondBody = await second.json();
    expect(firstBody.url).not.toBe(secondBody.url);
    for (const body of [firstBody, secondBody]) {
      const path = join(process.cwd(), "media", body.url.slice(1));
      uploadedFiles.push(path);
      expect(readFileSync(path, "utf8")).toBe("bytes");
    }
  });
});
