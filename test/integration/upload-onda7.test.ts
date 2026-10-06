import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { type SeededDb, setupSeededDb } from "../helpers/seeded-db.js";

const { registerUser } = await import("./helpers/custom-auth-helpers.js");

/**
 * Onda 7b: upload custom file (multipart real) — fluxo feliz, quota,
 * sanitize de nome, colisão de nome (timestamp), kind audio/imagens.
 * CUSTOM_MEDIA_DIR aponta pra tmp (env lida no handler? — se capturada no
 * import, cria em media/custom/<id> que é gitignored).
 */
describe("Upload custom files (multipart)", () => {
  let app: SeededDb;
  let router: any;
  let token: string;
  const auth = (t: string) => ({ authorization: `Bearer ${t}` });
  const prevDir = process.env.CUSTOM_MEDIA_DIR;

  beforeAll(async () => {
    app = await setupSeededDb();
    router = app.router;
    token = registerUser("upload@test.local", "SenhaForte1!").token;
    process.env.CUSTOM_MEDIA_DIR = mkdtempSync(join(tmpdir(), "plj-up-"));
  });

  afterAll(() => {
    if (prevDir === undefined) delete process.env.CUSTOM_MEDIA_DIR;
    else process.env.CUSTOM_MEDIA_DIR = prevDir;
    app.cleanup();
  });

  it("upload sem campo file → 400", async () => {
    const fd = new FormData();
    fd.append("kind", "imagens");
    const res = await router.request("/v1/custom/files", {
      method: "POST",
      headers: auth(token),
      body: fd,
    });
    expect(res.status).toBe(400);
  });

  it("upload feliz de imagem → 201 com url /custom/", async () => {
    const fd = new FormData();
    fd.append(
      "file",
      new File([Buffer.from("fakepng")], "capa teste.png", {
        type: "image/png",
      }),
    );
    fd.append("kind", "imagens");
    const res = await router.request("/v1/custom/files", {
      method: "POST",
      headers: auth(token),
      body: fd,
    });
    expect([200, 201]).toContain(res.status);
    const body = await res.json();
    expect(String(body.url ?? body.path ?? "")).toContain("/custom/");
  });

  it("upload com mesmo nome 2x → 2º ganha sufixo timestamp", async () => {
    const mk = () => {
      const fd = new FormData();
      fd.append(
        "file",
        new File([Buffer.from("aa")], "mesmo.jpg", { type: "image/jpeg" }),
      );
      fd.append("kind", "imagens");
      return fd;
    };
    const r1 = await router.request("/v1/custom/files", {
      method: "POST",
      headers: auth(token),
      body: mk(),
    });
    const r2 = await router.request("/v1/custom/files", {
      method: "POST",
      headers: auth(token),
      body: mk(),
    });
    expect([200, 201]).toContain(r1.status);
    expect([200, 201]).toContain(r2.status);
    const b1 = await r1.json();
    const b2 = await r2.json();
    expect(String(b1.url ?? b1.path)).not.toBe(String(b2.url ?? b2.path));
  });

  it("upload kind=audio grava em /custom/<id>/audio/", async () => {
    const fd = new FormData();
    fd.append(
      "file",
      new File([Buffer.alloc(64, 1)], "tom.mp3", { type: "audio/mpeg" }),
    );
    fd.append("kind", "audio");
    const res = await router.request("/v1/custom/files", {
      method: "POST",
      headers: auth(token),
      body: fd,
    });
    expect([200, 201]).toContain(res.status);
    const body = await res.json();
    expect(String(body.url ?? body.path)).toContain("/audio/");
  });

  it("nome só de caracteres perigosos → sanitizado ou 400", async () => {
    const fd = new FormData();
    fd.append(
      "file",
      new File([Buffer.from("x")], "..%2f..%2fevil", { type: "text/plain" }),
    );
    fd.append("kind", "imagens");
    const res = await router.request("/v1/custom/files", {
      method: "POST",
      headers: auth(token),
      body: fd,
    });
    expect([200, 201, 400]).toContain(res.status);
  });
});
