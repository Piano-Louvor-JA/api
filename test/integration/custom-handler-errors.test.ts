import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { type SeededDb, setupSeededDb } from "../helpers/seeded-db.js";
import { registerUser } from "./helpers/custom-auth-helpers.js";

describe("custom handlers preserve their error envelope after authentication", () => {
  let app: SeededDb;
  let token: string;
  beforeAll(async () => {
    app = await setupSeededDb();
    token = registerUser("handler-errors@test.local", "SenhaForte1!").token;
  });
  afterEach(() => vi.restoreAllMocks());
  afterAll(() => app.cleanup());

  // Fail the handler query, not the session query in optionalAuth/requireAuth.
  // A generic global 500 must not accidentally satisfy these assertions.
  const cases = [
    ["GET", "/collections", "custom_collections", "Erro ao listar coletâneas"],
    [
      "POST",
      "/collections",
      "custom_collections",
      "Erro ao criar coletânea",
      { name: "Example" },
    ],
    ["GET", "/collections/1", "custom_collections", "Erro ao buscar coletânea"],
    [
      "PUT",
      "/collections/1",
      "custom_collections",
      "Erro ao atualizar coletânea",
      { name: "Changed" },
    ],
    [
      "DELETE",
      "/collections/1",
      "custom_collections",
      "Erro ao remover coletânea",
    ],
    ["GET", "/musics", "custom_musics", "Erro ao listar músicas"],
    ["GET", "/collections/1/musics", "custom_musics", "Erro ao listar músicas"],
    ["GET", "/musics/1", "custom_musics", "Erro ao buscar música"],
    [
      "POST",
      "/collections/1/musics",
      "custom_collections",
      "Erro ao criar música",
      { name: "Example" },
    ],
    [
      "POST",
      "/collections/1/musics/1/copy",
      "custom_musics",
      "Erro ao copiar música",
    ],
    [
      "PUT",
      "/musics/1",
      "custom_musics",
      "Erro ao atualizar música",
      { name: "Changed" },
    ],
    ["DELETE", "/musics/1", "custom_musics", "Erro ao remover música"],
    ["GET", "/musics/1/lyrics", "custom_lyrics", "Erro ao listar estrofes"],
    [
      "POST",
      "/musics/1/lyrics",
      "custom_musics",
      "Erro ao criar estrofe",
      { lyric: "Example" },
    ],
    [
      "PUT",
      "/lyrics/1",
      "custom_lyrics",
      "Erro ao atualizar estrofe",
      { lyric: "Changed" },
    ],
    ["DELETE", "/lyrics/1", "custom_lyrics", "Erro ao remover estrofe"],
    [
      "POST",
      "/auth/login",
      "custom_users",
      "Erro ao fazer login",
      { email: "handler-errors@test.local", password: "SenhaForte1!" },
    ],
    [
      "POST",
      "/auth/register",
      "INSERT INTO custom_users",
      "Erro ao registrar usuário",
      { email: "new@test.local", password: "SenhaForte1!", displayName: "New" },
    ],
    [
      "POST",
      "/auth/forgot-password",
      "custom_users WHERE email",
      "Erro interno",
      { email: "handler-errors@test.local" },
    ],
    [
      "POST",
      "/auth/reset-password",
      "reset_token_hash",
      "Erro interno",
      { token: "valid-length-reset-token", password: "SenhaForte1!" },
    ],
  ] as const;

  it.each(cases)(
    "%s %s reports the handler failure",
    async (method, path, query, error, body) => {
      const db = app.getDb();
      const original = db.prepare.bind(db);
      let injected = false;
      vi.spyOn(db, "prepare").mockImplementation((sql: string) => {
        if (
          !injected &&
          sql.includes(query) &&
          !sql.includes("FROM custom_sessions")
        ) {
          injected = true;
          throw new Error("private SQL detail must not be sent");
        }
        return original(sql);
      });
      vi.spyOn(console, "error").mockImplementation(() => {});
      const response = await app.router.request(`/v1/custom${path}`, {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      expect(injected).toBe(true);
      expect(response.status).toBe(500);
      expect(await response.json()).toEqual({ error });
    },
  );
});
