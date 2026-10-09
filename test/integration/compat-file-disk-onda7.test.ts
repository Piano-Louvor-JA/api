import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type SeededDb, setupSeededDb } from "../helpers/seeded-db.js";

describe("Compat /file serves actual local media", () => {
  let app: SeededDb;
  let mediaDir: string;
  const bytes = Buffer.from("0123456789");
  beforeAll(async () => {
    const root = join(process.cwd(), "media");
    mkdirSync(root, { recursive: true });
    mediaDir = mkdtempSync(join(root, "coverage-local-"));
    mkdirSync(join(mediaDir, "img"));
    for (const ext of ["mp3", "bmp", "jpg", "jpeg", "png"]) {
      writeFileSync(join(mediaDir, "img", `sample.${ext}`), bytes);
    }
    app = await setupSeededDb();
  });
  afterAll(() => {
    app.cleanup();
    rmSync(mediaDir, { recursive: true, force: true });
  });

  it.each([
    ["mp3", "audio/mpeg"],
    ["bmp", "image/bmp"],
    ["jpg", "image/jpeg"],
    ["jpeg", "image/jpeg"],
    ["png", "image/png"],
  ])("serves %s with its MIME and unchanged bytes", async (ext, mime) => {
    const res = await app.router.request(
      `/file/${mediaDir.split("/").pop()}/img/sample.${ext}`,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe(mime);
    expect(res.headers.get("accept-ranges")).toBe("bytes");
    expect(res.headers.get("content-length")).toBe(String(bytes.length));
    expect(Buffer.from(await res.arrayBuffer())).toEqual(bytes);
  });

  it.each([
    ["bytes=2-5", "2345", "bytes 2-5/10"],
    ["bytes=6-", "6789", "bytes 6-9/10"],
  ])("supports seeking with %s", async (range, expected, contentRange) => {
    const res = await app.router.request(
      `/file/${mediaDir.split("/").pop()}/img/sample.mp3`,
      {
        headers: { range },
      },
    );
    expect(res.status).toBe(206);
    expect(res.headers.get("content-range")).toBe(contentRange);
    expect(await res.text()).toBe(expected);
  });

  it("invalid Range falls back to the full file", async () => {
    const res = await app.router.request(
      `/file/${mediaDir.split("/").pop()}/img/sample.mp3`,
      {
        headers: { range: "invalid" },
      },
    );
    expect(res.status).toBe(200);
    expect(Buffer.from(await res.arrayBuffer())).toEqual(bytes);
  });
});
