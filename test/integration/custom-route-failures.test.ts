import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { type SeededDb, setupSeededDb } from "../helpers/seeded-db.js";
import { registerUser } from "./helpers/custom-auth-helpers.js";

let fixture: SeededDb, token: string, cid: number, mid: number, lid: number;
beforeAll(async () => {
  fixture = await setupSeededDb();
  const user = registerUser("route-failures@test.local", "SenhaForte1!");
  token = user.token;
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
  lid = Number(
    db
      .prepare("INSERT INTO custom_lyrics (id_music, lyric) VALUES (?, ?)")
      .run(mid, "Lyric").lastInsertRowid,
  );
});
afterEach(() => vi.restoreAllMocks());
afterAll(() => fixture.cleanup());
const cases: [
  string,
  string,
  Record<string, unknown> | null,
  RegExp,
  string,
][] = [
  [
    "GET",
    "collections",
    null,
    /FROM custom_collections/,
    "Erro ao listar coletâneas",
  ],
  [
    "POST",
    "collections",
    { name: "New" },
    /INSERT INTO custom_collections/,
    "Erro ao criar coletânea",
  ],
  [
    "GET",
    "collections/CID",
    null,
    /FROM custom_collections/,
    "Erro ao buscar coletânea",
  ],
  [
    "PUT",
    "collections/CID",
    { name: "New" },
    /UPDATE custom_collections/,
    "Erro ao atualizar coletânea",
  ],
  [
    "DELETE",
    "collections/CID",
    null,
    /DELETE FROM custom_collections/,
    "Erro ao remover coletânea",
  ],
  ["GET", "musics", null, /FROM custom_musics/, "Erro ao listar músicas"],
  ["GET", "musics/MID", null, /FROM custom_musics/, "Erro ao buscar música"],
  [
    "POST",
    "collections/CID/musics",
    { name: "New" },
    /INSERT INTO custom_musics/,
    "Erro ao criar música",
  ],
  [
    "POST",
    "collections/CID/musics/MID/copy",
    {},
    /SELECT \* FROM custom_musics/,
    "Erro ao copiar música",
  ],
  [
    "PUT",
    "musics/MID",
    { name: "New" },
    /UPDATE custom_musics/,
    "Erro ao atualizar música",
  ],
  [
    "DELETE",
    "musics/MID",
    null,
    /DELETE FROM custom_musics/,
    "Erro ao remover música",
  ],
  [
    "GET",
    "musics/MID/lyrics",
    null,
    /FROM custom_lyrics/,
    "Erro ao listar estrofes",
  ],
  [
    "POST",
    "musics/MID/lyrics",
    { lyric: "New" },
    /INSERT INTO custom_lyrics/,
    "Erro ao criar estrofe",
  ],
  [
    "PUT",
    "lyrics/LID",
    { lyric: "New" },
    /UPDATE custom_lyrics/,
    "Erro ao atualizar estrofe",
  ],
  [
    "DELETE",
    "lyrics/LID",
    null,
    /DELETE FROM custom_lyrics/,
    "Erro ao remover estrofe",
  ],
  [
    "POST",
    "auth/register",
    { email: "new@test.local", password: "SenhaForte1!", displayName: "New" },
    /INSERT INTO custom_users/,
    "Erro ao registrar usuário",
  ],
  [
    "POST",
    "auth/forgot-password",
    { email: "route-failures@test.local" },
    /reset_token_hash/,
    "Erro interno",
  ],
  [
    "POST",
    "sync",
    { collections: [], operator_state: [] },
    /FROM operator_state/,
    "Erro interno no sync",
  ],
];
it.each(cases)(
  "%s %s conserva envelope após falha de banco",
  async (method, path, body, pattern, message) => {
    const db = fixture.getDb();
    const prepare = db.prepare.bind(db);
    vi.spyOn(db, "prepare").mockImplementation((sql) => {
      if (pattern.test(sql)) throw new Error("storage unavailable");
      return prepare(sql);
    });
    const res = await fixture.router.request(
      `/v1/custom/${path.replace("CID", String(cid)).replace("MID", String(mid)).replace("LID", String(lid))}`,
      {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      },
    );
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: message });
  },
);
