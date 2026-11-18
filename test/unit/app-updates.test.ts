import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../../src/app.js";
import { run } from "../../src/cli/fetch-apk.js";

/**
 * Atualização do apk pela API: o CLI publica a release do GitHub em
 * APP_UPDATES_DIR e as rotas /v1/app/* servem manifesto e apk.
 */

const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");

/** GitHub de mentira: releases por tag e o download dos assets. */
function fakeGithub(
  releases: Record<string, { apk: Buffer; digest?: string; body?: string }>,
  latest: string,
) {
  const calls: string[] = [];
  const impl = (async (input: string | URL | Request) => {
    const url = String(input);
    calls.push(url);
    const dl = /\/download\/v([\d.]+)\/(.+)$/.exec(url);
    if (dl) {
      const r = releases[dl[1] as string];
      return r ? new Response(r.apk) : new Response("nope", { status: 404 });
    }
    const tag = url.endsWith("/releases/latest")
      ? latest
      : /\/tags\/v([\d.]+)$/.exec(url)?.[1];
    const r = tag ? releases[tag] : undefined;
    if (!r) return new Response("{}", { status: 404 });
    const name = `louvorja-piano-${tag}.apk`;
    return Response.json({
      tag_name: `v${tag}`,
      body: r.body ?? `Notas da ${tag}`,
      published_at: "2026-11-18T12:00:00Z",
      assets: [
        { name: "louvorja-piano-ios-unsigned.ipa", size: 1, digest: null },
        {
          name,
          size: r.apk.length,
          digest: r.digest ?? `sha256:${sha(r.apk)}`,
          browser_download_url: `https://github.com/x/releases/download/v${tag}/${name}`,
        },
      ],
    });
  }) as typeof fetch;
  return { impl, calls };
}

describe("atualização do apk pela API", () => {
  let dir: string;
  const prev = process.env.APP_UPDATES_DIR;
  const lines: string[] = [];
  const out = (l: string) => lines.push(l);
  const apk100 = Buffer.from("apk-1.0.0-conteudo");
  const apk101 = Buffer.from("apk-1.0.1-conteudo-maior");
  const apk102 = Buffer.from("apk-1.0.2");

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "piano-updates-"));
    process.env.APP_UPDATES_DIR = dir;
    lines.length = 0;
  });
  afterEach(() => {
    process.env.APP_UPDATES_DIR = prev;
    rmSync(dir, { recursive: true, force: true });
  });

  it("sem publicação: /v1/app/version responde 404", async () => {
    const res = await createApp().request("/v1/app/version");
    expect(res.status).toBe(404);
  });

  it("publica a última release, serve manifesto e apk", async () => {
    const gh = fakeGithub({ "1.0.1": { apk: apk101 } }, "1.0.1");
    expect(await run([], out, gh.impl)).toBe(0);
    expect(gh.calls[0]).toBe(
      "https://api.github.com/repos/Piano-Louvor-JA/apk/releases/latest",
    );

    const app = createApp();
    const res = await app.request("/v1/app/version");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      version: "1.0.1",
      apk_url: "/v1/app/apk/louvorja-piano-1.0.1.apk",
      size: apk101.length,
      sha256: sha(apk101),
      notes: "Notas da 1.0.1",
      published_at: "2026-11-18T12:00:00Z",
    });

    const file = await app.request("/v1/app/apk/louvorja-piano-1.0.1.apk");
    expect(file.status).toBe(200);
    expect(file.headers.get("content-type")).toBe(
      "application/vnd.android.package-archive",
    );
    expect(file.headers.get("content-length")).toBe(String(apk101.length));
    expect(Buffer.from(await file.arrayBuffer())).toEqual(apk101);
  });

  it("não serve nomes fora do padrão nem apks que não existem", async () => {
    const app = createApp();
    for (const p of [
      "/v1/app/apk/version.json",
      "/v1/app/apk/..%2Fversion.json",
      "/v1/app/apk/louvorja-piano-9.9.9.apk",
    ]) {
      expect((await app.request(p)).status).toBe(404);
    }
  });

  it("SHA-256 que não confere: nada é publicado", async () => {
    const gh = fakeGithub(
      { "1.0.1": { apk: apk101, digest: `sha256:${"0".repeat(64)}` } },
      "1.0.1",
    );
    expect(await run(["1.0.1"], out, gh.impl)).toBe(1);
    expect(existsSync(join(dir, "android", "version.json"))).toBe(false);
    expect(readdirSync(join(dir, "android"))).toEqual([]);
  });

  it("release sem apk ou sem digest falha com mensagem", async () => {
    const semDigest = fakeGithub(
      { "1.0.1": { apk: apk101, digest: "" } },
      "1.0.1",
    );
    expect(await run([], out, semDigest.impl)).toBe(1);
    expect(lines.at(-1)).toContain("SHA-256");
    expect(await run(["2.0.0"], out, semDigest.impl)).toBe(1);
    expect(await run(["abc"], out, semDigest.impl)).toBe(2);
  });

  it("nunca sobrescreve um apk publicado que difere da release", async () => {
    mkdirSync(join(dir, "android"), { recursive: true });
    writeFileSync(join(dir, "android", "louvorja-piano-1.0.1.apk"), "outro");
    const gh = fakeGithub({ "1.0.1": { apk: apk101 } }, "1.0.1");
    expect(await run(["1.0.1"], out, gh.impl)).toBe(1);
    expect(
      readFileSync(join(dir, "android", "louvorja-piano-1.0.1.apk"), "utf8"),
    ).toBe("outro");
  });

  it("mantém só o atual e o anterior; versão antiga é o rollback", async () => {
    const gh = fakeGithub(
      {
        "1.0.0": { apk: apk100 },
        "1.0.1": { apk: apk101 },
        "1.0.2": { apk: apk102 },
      },
      "1.0.2",
    );
    expect(await run(["1.0.0"], out, gh.impl)).toBe(0);
    expect(await run(["1.0.1"], out, gh.impl)).toBe(0);
    expect(await run([], out, gh.impl)).toBe(0);
    expect(
      readdirSync(join(dir, "android"))
        .filter((f) => f.endsWith(".apk"))
        .sort(),
    ).toEqual(["louvorja-piano-1.0.1.apk", "louvorja-piano-1.0.2.apk"]);

    // Rollback para a 1.0.1 (já no disco: não baixa de novo).
    const before = gh.calls.length;
    expect(await run(["1.0.1"], out, gh.impl)).toBe(0);
    expect(gh.calls.length).toBe(before + 1); // só a consulta da release
    const res = await createApp().request("/v1/app/version");
    expect((await res.json()).version).toBe("1.0.1");
  });

  it("manifesto apontando para apk sumido ou corrompido vira 404", async () => {
    const gh = fakeGithub({ "1.0.1": { apk: apk101 } }, "1.0.1");
    await run([], out, gh.impl);
    rmSync(join(dir, "android", "louvorja-piano-1.0.1.apk"));
    expect((await createApp().request("/v1/app/version")).status).toBe(404);
    writeFileSync(join(dir, "android", "version.json"), "{quebrado");
    expect((await createApp().request("/v1/app/version")).status).toBe(404);
  });
});
