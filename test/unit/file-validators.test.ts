import { describe, expect, it } from "vitest";
import { contentEtag, isNotModified } from "../../src/lib/fileValidators.js";

describe("fileValidators", () => {
  const mtime = new Date("2026-01-01T00:00:00Z");

  it("If-None-Match aceita * e ETag fraco (W/)", () => {
    expect(isNotModified("*", undefined, '"abc"', mtime)).toBe(true);
    expect(isNotModified('W/"abc"', undefined, '"abc"', mtime)).toBe(true);
    expect(isNotModified('"xyz"', undefined, '"abc"', mtime)).toBe(false);
  });

  it("If-None-Match tem precedência sobre If-Modified-Since", () => {
    expect(
      isNotModified('"xyz"', "Thu, 01 Jan 2026 00:00:00 GMT", '"abc"', mtime),
    ).toBe(false);
  });

  it("sem condicionais nunca é 304", () => {
    expect(isNotModified(undefined, undefined, '"abc"', mtime)).toBe(false);
  });

  it("hash depende do conteúdo e é reaproveitado para a mesma versão", () => {
    const a = contentEtag("x.mp3", 1, 3, Buffer.from("abc"));
    expect(contentEtag("x.mp3", 1, 3, Buffer.from("zzz"))).toBe(a);
    expect(contentEtag("x.mp3", 2, 3, Buffer.from("zzz"))).not.toBe(a);
  });

  it("cache cheio é esvaziado e o hash volta a ser calculado", () => {
    const first = contentEtag("first.mp3", 1, 3, Buffer.from("abc"));
    expect(contentEtag("first.mp3", 1, 3, Buffer.from("zzz"))).toBe(first);
    for (let i = 0; i < 20_000; i++) {
      contentEtag(`fill-${i}.mp3`, 1, 1, Buffer.from("x"));
    }
    expect(contentEtag("first.mp3", 1, 3, Buffer.from("zzz"))).not.toBe(first);
  });
});
