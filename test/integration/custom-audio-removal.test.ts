import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { type SeededDb, setupSeededDb } from "../helpers/seeded-db.js";

const { registerUser } = await import("./helpers/custom-auth-helpers.js");

/**
 * SPEC-audio-removal v1.0.0 (vault de07e71):
 * RF-01 schema null-safe (id_file_*: nullable) + RF-02 handler distingue
 * ausente de null + RF-03 allowlist de extensão no upload kind=audio
 * (mp3/ogg/m4a/wav/flac/aac).
 */
describe("SPEC-audio-removal: PUT musics null-safe + upload allowlist", () => {
  let app: SeededDb;
  let router: any;
  let token: string;
  const auth = (t: string) => ({ authorization: `Bearer ${t}` });
  const prevDir = process.env.CUSTOM_MEDIA_DIR;

  /** Cria coletânea + música com áudio vinculado; retorna ids. */
  async function createMusicWithAudio(): Promise<{
    collectionId: number;
    musicId: number;
  }> {
    const col = await router.request("/v1/custom/collections", {
      method: "POST",
      headers: { ...auth(token), "content-type": "application/json" },
      body: JSON.stringify({ name: "Áudio SPEC" }),
    });
    const colBody = await col.json();
    const collectionId = colBody.id_collection ?? colBody.id;

    const fd = new FormData();
    fd.append(
      "file",
      new File([Buffer.from("fakemp3")], "hino.mp3", { type: "audio/mpeg" }),
    );
    fd.append("kind", "audio");
    const up = await router.request("/v1/custom/files", {
      method: "POST",
      headers: auth(token),
      body: fd,
    });
    expect([200, 201]).toContain(up.status);
    const upBody = await up.json();
    const idFileAudio = upBody.id_file ?? upBody.idFile;

    const music = await router.request(
      `/v1/custom/collections/${collectionId}/musics`,
      {
        method: "POST",
        headers: { ...auth(token), "content-type": "application/json" },
        body: JSON.stringify({
          name: "Hino áudio",
          id_file_audio: idFileAudio,
        }),
      },
    );
    expect([200, 201]).toContain(music.status);
    const musicBody = await music.json();
    const musicId = musicBody.id_music ?? musicBody.id;
    expect(musicId).toBeDefined();
    return { collectionId, musicId };
  }

  beforeAll(async () => {
    app = await setupSeededDb();
    router = app.router;
    token = registerUser("audio-spec@test.local", "SenhaForte1!").token;
    process.env.CUSTOM_MEDIA_DIR = mkdtempSync(join(tmpdir(), "plj-audio-"));
  });

  afterAll(() => {
    if (prevDir === undefined) delete process.env.CUSTOM_MEDIA_DIR;
    else process.env.CUSTOM_MEDIA_DIR = prevDir;
    app.cleanup();
  });

  it("AC-1: PUT id_file_audio null remove o vínculo (e GET reflete)", async () => {
    const { musicId } = await createMusicWithAudio();

    const put = await router.request(`/v1/custom/musics/${musicId}`, {
      method: "PUT",
      headers: { ...auth(token), "content-type": "application/json" },
      body: JSON.stringify({ id_file_audio: null }),
    });
    expect([200, 204]).toContain(put.status);

    const got = await router.request(`/v1/custom/musics/${musicId}`, {
      headers: auth(token),
    });
    const gotBody = await got.json();
    expect(gotBody.id_file_audio ?? null).toBeNull();
    expect(gotBody.audio_url ?? null).toBeNull();
  });

  it("AC-2: PUT sem o campo mantém o áudio atual", async () => {
    const { musicId } = await createMusicWithAudio();

    // renomeia sem tocar em id_file_audio
    const put = await router.request(`/v1/custom/musics/${musicId}`, {
      method: "PUT",
      headers: { ...auth(token), "content-type": "application/json" },
      body: JSON.stringify({ name: "Hino áudio renomeado" }),
    });
    expect([200, 204]).toContain(put.status);

    const got = await router.request(`/v1/custom/musics/${musicId}`, {
      headers: auth(token),
    });
    const gotBody = await got.json();
    expect(gotBody.audio_url ?? "").not.toBe("");
    expect(gotBody.name).toBe("Hino áudio renomeado");
  });

  it("AC-3a: upload kind=audio com extensão fora da allowlist → rejeitado", async () => {
    const fd = new FormData();
    fd.append(
      "file",
      new File([Buffer.from("x")], "malware.exe", {
        type: "application/octet-stream",
      }),
    );
    fd.append("kind", "audio");
    const res = await router.request("/v1/custom/files", {
      method: "POST",
      headers: auth(token),
      body: fd,
    });
    expect(res.status).toBe(400);
  });

  it("AC-3b: upload kind=audio aceita ogg, m4a, flac e aac", async () => {
    for (const [name, mime] of [
      ["hino.ogg", "audio/ogg"],
      ["hino.m4a", "audio/mp4"],
      ["hino.flac", "audio/flac"],
      ["hino.aac", "audio/aac"],
    ] as const) {
      const fd = new FormData();
      fd.append(
        "file",
        new File([Buffer.from("fakeaudio")], name, { type: mime }),
      );
      fd.append("kind", "audio");
      const res = await router.request("/v1/custom/files", {
        method: "POST",
        headers: auth(token),
        body: fd,
      });
      expect([200, 201], `${name} deve ser aceito`).toContain(res.status);
    }
  });

  it("AC-3c: upload kind=imagens não é afetado pela allowlist de áudio", async () => {
    const fd = new FormData();
    fd.append(
      "file",
      new File([Buffer.from("fakepng")], "capa.png", { type: "image/png" }),
    );
    fd.append("kind", "imagens");
    const res = await router.request("/v1/custom/files", {
      method: "POST",
      headers: auth(token),
      body: fd,
    });
    expect([200, 201]).toContain(res.status);
  });
});
