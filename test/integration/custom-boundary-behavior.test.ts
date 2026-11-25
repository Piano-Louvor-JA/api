import { rmSync } from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";

const { welcome, loginEmail } = vi.hoisted(() => ({
  welcome: vi.fn(async () => true),
  loginEmail: vi.fn(async () => true),
}));
vi.mock("../../src/v1/custom/mail.service.js", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../../src/v1/custom/mail.service.js")
  >()),
  smtpConfigured: () => false,
  sendWelcomeEmail: welcome,
  sendNewLoginEmail: loginEmail,
}));

import { type SeededDb, setupSeededDb } from "../helpers/seeded-db.js";
import { registerUser } from "./helpers/custom-auth-helpers.js";

let fixture: SeededDb, token: string, userId: number, cid: number, mid: number;
const paths: string[] = [];
beforeAll(async () => {
  fixture = await setupSeededDb();
  const user = registerUser("boundaries@test.local", "SenhaForte1!");
  token = user.token;
  userId = user.id_user;
  const db = fixture.getDb();
  cid = Number(
    db
      .prepare("INSERT INTO custom_collections (name,owner_id) VALUES (?,?)")
      .run("Boundaries", userId).lastInsertRowid,
  );
  mid = Number(
    db
      .prepare(
        "INSERT INTO custom_musics (id_collection,name,owner_id) VALUES (?,?,?)",
      )
      .run(cid, "Music", userId).lastInsertRowid,
  );
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});
afterAll(() => {
  fixture.cleanup();
  for (const path of paths)
    rmSync(join(process.cwd(), "media", path), { force: true });
});
const headers = () => ({
  authorization: `Bearer ${token}`,
  "content-type": "application/json",
});
const request = (
  path: string,
  body: Record<string, unknown>,
  method = "POST",
) =>
  fixture.router.request(`/v1/custom/${path}`, {
    method,
    headers: headers(),
    body: JSON.stringify(body),
  });
it.each([
  ["collections/999999/musics", { name: "Music" }, "POST"],
  ["musics/999999", { name: "Music" }, "PUT"],
  ["musics/999999/lyrics", { lyric: "Text" }, "POST"],
])("%s responde 404 ao pai ausente", async (path, body, method) => {
  expect(
    (
      await request(
        String(path),
        body as Record<string, unknown>,
        String(method),
      )
    ).status,
  ).toBe(404);
});
it("remover música de outro usuário exige permissão", async () => {
  const other = registerUser("another-boundary@test.local", "SenhaForte1!");
  const res = await fixture.router.request(`/v1/custom/musics/${mid}`, {
    method: "DELETE",
    headers: { authorization: `Bearer ${other.token}` },
  });
  expect(res.status).toBe(403);
  expect(await res.json()).toEqual({
    error: "Sem permissão para remover esta música",
  });
});
it("sem curador configurado promoção é negada", async () => {
  vi.stubEnv("CURATOR_USER_IDS", undefined);
  expect(
    (
      await request("admin/promote-music", {
        custom_music_id: mid,
        official_music_id: 1,
      })
    ).status,
  ).toBe(403);
});
it("curador autorizado recebe erro concreto para música ausente", async () => {
  vi.stubEnv("CURATOR_USER_IDS", String(userId));
  const res = await request("admin/promote-music", {
    custom_music_id: 999999,
    official_music_id: 1,
  });
  expect(res.status).toBe(400);
  expect(await res.json()).toEqual({ error: "Faixa custom não encontrada" });
});
it("paginação inválida conserva defaults sem quebrar resposta", async () => {
  const res = await fixture.router.request(
    "/v1/custom/collections?page=invalid&per_page=0",
    { headers: headers() },
  );
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.meta.page).toBe(1);
  expect(body.meta.per_page).toBe(24);
});
it("nome ausente sem referência oficial é inválido", async () => {
  expect((await request(`collections/${cid}/musics`, {})).status).toBe(400);
});
it("coleção desaparecida após insert mantém erro específico", async () => {
  const db = fixture.getDb(),
    prepare = db.prepare.bind(db);
  vi.spyOn(db, "prepare").mockImplementation((sql) =>
    sql.startsWith("SELECT * FROM custom_collections WHERE id_collection")
      ? ({ get: () => undefined } as ReturnType<typeof prepare>)
      : prepare(sql),
  );
  const res = await request("collections", { name: "Disappeared" });
  expect(res.status).toBe(500);
  expect(await res.json()).toEqual({ error: "Erro ao criar coletânea" });
});
it("erro ao listar músicas da coletânea mantém envelope", async () => {
  const db = fixture.getDb(),
    prepare = db.prepare.bind(db);
  vi.spyOn(db, "prepare").mockImplementation((sql) => {
    if (
      sql.includes("FROM custom_musics cm") &&
      sql.includes("cm.id_collection")
    )
      throw new Error("storage unavailable");
    return prepare(sql);
  });
  const res = await fixture.router.request(
    `/v1/custom/collections/${cid}/musics`,
    { headers: headers() },
  );
  expect(res.status).toBe(500);
  expect(await res.json()).toEqual({ error: "Erro ao listar músicas" });
});
it("coleção sem proprietário ainda registra uso", async () => {
  const db = fixture.getDb();
  const id = Number(
    db
      .prepare("INSERT INTO custom_collections (name,owner_id) VALUES (?,NULL)")
      .run("Ownerless").lastInsertRowid,
  );
  const res = await request(`collections/${id}/use`, {});
  expect(res.status).toBe(200);
  expect(await res.json()).toMatchObject({ ok: true, first_use: false });
});

it("proprietário ausente após uso não impede confirmação", async () => {
  const other = registerUser("third-boundary@test.local", "SenhaForte1!");
  const db = fixture.getDb(),
    prepare = db.prepare.bind(db);
  const ownerQuery =
    "SELECT owner_id FROM custom_collections WHERE id_collection = ?";
  vi.spyOn(db, "prepare").mockImplementation((sql) =>
    sql.trim() === ownerQuery
      ? ({ get: () => undefined } as ReturnType<typeof prepare>)
      : prepare(sql),
  );
  const res = await fixture.router.request(
    `/v1/custom/collections/${cid}/use`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${other.token}`,
        "content-type": "application/json",
      },
      body: "{}",
    },
  );
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ ok: true, first_use: true });
});
it("promoção sem autor identificado não concede crédito", async () => {
  const db = fixture.getDb();
  const id = Number(
    db
      .prepare(
        "INSERT INTO custom_musics (id_collection,name,owner_id) VALUES (?,?,NULL)",
      )
      .run(cid, "Ownerless music").lastInsertRowid,
  );
  vi.stubEnv("CURATOR_USER_IDS", String(userId));
  const res = await request("admin/promote-music", {
    custom_music_id: id,
    official_music_id: 31,
  });
  expect(res.status).toBe(200);
  expect(await res.json()).toMatchObject({ ok: true, awarded_to: null });
  expect(
    db
      .prepare(
        "SELECT author_user_id,points_awarded FROM official_promotions WHERE custom_music_id=?",
      )
      .get(id),
  ).toEqual({ author_user_id: null, points_awarded: 0 });
});
it("modo dev explícito retorna token de recuperação", async () => {
  vi.stubEnv("RESET_TOKEN_EXPOSE", "1");
  const res = await request("auth/forgot-password", {
    email: "boundaries@test.local",
  });
  expect(res.status).toBe(200);
  expect((await res.json()).token).toBeTypeOf("string");
});
it("falha de e-mail de boas-vindas não impede registro", async () => {
  welcome.mockRejectedValueOnce(new Error("mail unavailable"));
  const res = await request("auth/register", {
    email: "new-boundary@test.local",
    password: "SenhaForte1!",
    displayName: "New",
  });
  expect(res.status).toBe(201);
  await Promise.resolve();
  expect(welcome).toHaveBeenCalled();
});
it("falha de aviso de login não impede autenticação", async () => {
  loginEmail.mockRejectedValueOnce(new Error("mail unavailable"));
  const res = await request("auth/login", {
    email: "boundaries@test.local",
    password: "SenhaForte1!",
  });
  expect(res.status).toBe(200);
  await Promise.resolve();
  expect(loginEmail).toHaveBeenCalled();
});
function form(name: string, bytes = 2) {
  const fd = new FormData();
  fd.append("file", new File([new Uint8Array(bytes)], name));
  return fd;
}
const upload = (body: FormData) =>
  fixture.router.request("/v1/custom/files", {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
    body,
  });
it("nome inválido é recusado antes da escrita", async () => {
  const res = await upload(form("."));
  expect(res.status).toBe(400);
  expect(await res.json()).toEqual({ error: "Nome de arquivo inválido" });
});
it("quota insuficiente recusa upload sem gravar arquivo", async () => {
  vi.stubEnv("CUSTOM_QUOTA_MB", String(1 / 1048576));
  const res = await upload(form("quota.bin"));
  expect(res.status).toBe(413);
  expect(await res.json()).toMatchObject({ error: "quota_exceeded" });
});
it("colisão sem extensão preserva ambos os arquivos", async () => {
  const name = `test-noext-${process.pid}`;
  const first = await upload(form(name));
  const second = await upload(form(name));
  expect(first.status).toBe(201);
  expect(second.status).toBe(201);
  const a = await first.json(),
    b = await second.json();
  paths.push(a.url, b.url);
  expect(a.url).not.toBe(b.url);
});
it("falha do banco após upload mantém erro específico", async () => {
  const db = fixture.getDb(),
    prepare = db.prepare.bind(db);
  vi.spyOn(db, "prepare").mockImplementation((sql) => {
    if (sql.includes("INSERT INTO files"))
      throw new Error("storage unavailable");
    return prepare(sql);
  });
  const name = `test-upload-failure-${process.pid}`;
  paths.push(`/custom/${userId}/imagens/${name}`);
  const res = await upload(form(name));
  expect(res.status).toBe(500);
  expect(await res.json()).toEqual({ error: "Erro ao salvar arquivo" });
});

it("upload sem campo file retorna erro explícito", async () => {
  const response = await fixture.router.request("/v1/custom/files", {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
    body: (() => {
      const form = new FormData();
      form.set("file", "not-a-file");
      return form;
    })(),
  });
  expect(response.status).toBe(400);
  expect(await response.json()).toEqual({
    error: 'Campo "file" ausente ou inválido',
  });
});

it("edição permite remover capa explicitamente", async () => {
  const response = await fixture.router.request(
    `/v1/custom/collections/${cid}`,
    {
      method: "PUT",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ cover_url: null }),
    },
  );
  expect(response.status).toBe(200);
  expect(
    fixture
      .getDb()
      .prepare("SELECT cover_url FROM custom_collections WHERE id_collection=?")
      .get(cid),
  ).toEqual({ cover_url: null });
});
it("cópia normaliza flags e ordem nulas de estrofes legadas", async () => {
  const target = Number(
    fixture
      .getDb()
      .prepare("INSERT INTO custom_collections (name,owner_id) VALUES (?,?)")
      .run("Legacy copy destination", userId).lastInsertRowid,
  );
  fixture
    .getDb()
    .prepare(
      'INSERT INTO custom_lyrics (id_music,lyric,show_slide,"order") VALUES (?,?,NULL,NULL)',
    )
    .run(mid, "Legacy nullable verse");
  const response = await fixture.router.request(
    `/v1/custom/collections/${target}/musics/${mid}/copy`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ id_collection: target }),
    },
  );
  expect(response.status).toBe(201);
  const rows = fixture
    .getDb()
    .prepare(
      'SELECT show_slide,"order" FROM custom_lyrics WHERE lyric=? AND id_music != ?',
    )
    .all("Legacy nullable verse", mid);
  expect(rows).toContainEqual({ show_slide: 1, order: 0 });
});

it("login sem nome legado usa saudação padrão no e-mail", async () => {
  const db = fixture.getDb(),
    prepare = db.prepare.bind(db);
  vi.spyOn(db, "prepare").mockImplementation(((sql: string) => {
    const stmt = prepare(sql);
    if (sql.includes("SELECT id_user, email, display_name, password_hash")) {
      const get = stmt.get.bind(stmt);
      stmt.get = ((...args: any[]) => {
        const row = get(...args) as any;
        return row ? { ...row, display_name: null } : row;
      }) as typeof stmt.get;
    }
    return stmt;
  }) as typeof db.prepare);
  loginEmail.mockClear();
  const response = await fixture.router.request("/v1/custom/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      email: "boundaries@test.local",
      password: "SenhaForte1!",
    }),
  });
  expect(response.status).toBe(200);
  expect(loginEmail).toHaveBeenCalledWith(
    "boundaries@test.local",
    "usuário",
    expect.any(String),
  );
});
it("promoção mantém notificação interna se destinatário de e-mail não existe", async () => {
  const db = fixture.getDb();
  const id = Number(
    db
      .prepare(
        "INSERT INTO custom_musics (id_collection,name,owner_id) VALUES (?,?,?)",
      )
      .run(cid, "No email lookup", userId).lastInsertRowid,
  );
  const prepare = db.prepare.bind(db);
  vi.spyOn(db, "prepare").mockImplementation(((sql: string) =>
    sql.includes("SELECT email FROM custom_users")
      ? { get: () => undefined }
      : prepare(sql)) as typeof db.prepare);
  const { promoteMusicToF } = await import(
    "../../src/v1/custom/promotion.service.js"
  );
  const send = vi.fn();
  expect(promoteMusicToF(db, id, 777789, userId, send).ok).toBe(true);
  expect(send).not.toHaveBeenCalled();
  expect(
    prepare(
      "SELECT email_sent FROM user_notifications WHERE user_id=? ORDER BY id DESC LIMIT 1",
    ).get(userId),
  ).toEqual({ email_sent: 0 });
});
