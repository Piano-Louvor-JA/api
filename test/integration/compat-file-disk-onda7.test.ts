import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { type SeededDb, setupSeededDb } from "../helpers/seeded-db.js";

let fixture: SeededDb, dir: string, prefix: string;
beforeAll(async () => {
  mkdirSync(join(process.cwd(), "media"), { recursive: true });
  dir = mkdtempSync(join(process.cwd(), "media", "test-disk-"));
  prefix = basename(dir);
  for (const ext of ["mp3", "bmp", "jpg", "jpeg", "png"])
    writeFileSync(join(dir, `sample.${ext}`), Buffer.alloc(1024, 7));
  fixture = await setupSeededDb();
});
afterAll(() => {
  fixture.cleanup();
  rmSync(dir, { recursive: true, force: true });
});
it.each([
  ["mp3", "audio/mpeg"],
  ["bmp", "image/bmp"],
  ["jpg", "image/jpeg"],
  ["jpeg", "image/jpeg"],
  ["png", "image/png"],
])("serve arquivo %s local com mime correto", async (ext, mime) => {
  const res = await fixture.router.request(`/file/${prefix}/sample.${ext}`);
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toBe(mime);
  expect(res.headers.get("accept-ranges")).toBe("bytes");
  expect(res.headers.get("content-length")).toBe("1024");
  expect(new Uint8Array(await res.arrayBuffer())).toEqual(
    new Uint8Array(1024).fill(7),
  );
});
it.each([
  ["bytes=0-99", 100, "bytes 0-99/1024"],
  ["bytes=1000-", 24, "bytes 1000-1023/1024"],
])("range %s preserva trecho de áudio", async (range, size, contentRange) => {
  const res = await fixture.router.request(`/file/${prefix}/sample.mp3`, {
    headers: { range },
  });
  expect(res.status).toBe(206);
  expect(res.headers.get("content-range")).toBe(contentRange);
  expect(new Uint8Array(await res.arrayBuffer())).toEqual(
    new Uint8Array(Number(size)).fill(7),
  );
});
it("range malformado mantém resposta integral", async () => {
  const res = await fixture.router.request(`/file/${prefix}/sample.mp3`, {
    headers: { range: "invalid" },
  });
  expect(res.status).toBe(200);
  expect((await res.arrayBuffer()).byteLength).toBe(1024);
});
