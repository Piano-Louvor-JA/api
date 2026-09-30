// SEC-143 (api#143): guardas do mirror on-demand — unidade pura

import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  escapesMediaDir,
  mirrorablePath,
  NegativeCache,
  Semaphore,
} from "../../src/lib/mirrorGuard.js";

describe("SEC-143: mirrorablePath (allowlist de extensão)", () => {
  it("permite extensões de mídia conhecidas", () => {
    expect(mirrorablePath("hinos/1.mp3")).toBe(true);
    expect(mirrorablePath("covers/x.bmp")).toBe(true);
    expect(mirrorablePath("a/b/c.jpg")).toBe(true);
    expect(mirrorablePath("a/b/c.jpeg")).toBe(true);
    expect(mirrorablePath("a/b/c.png")).toBe(true);
  });

  it("rejeita extensão desconhecida ou ausente (não espelha)", () => {
    expect(mirrorablePath("arquivo.exe")).toBe(false);
    expect(mirrorablePath("sem-ext")).toBe(false);
    expect(mirrorablePath("x/.env")).toBe(false);
    expect(mirrorablePath("x/db.sqlite")).toBe(false);
  });

  it("rejeita traversal e paths absolutos independente da extensão", () => {
    expect(mirrorablePath("../etc/passwd.mp3")).toBe(false);
    expect(mirrorablePath("a/../../etc.mp3")).toBe(false);
    expect(mirrorablePath("/etc/passwd.mp3")).toBe(false);
  });
});

describe("SEC-143: escapesMediaDir (defesa em profundidade)", () => {
  const mediaDir = "/srv/piano-api/media";

  it("path interno não escapa", () => {
    expect(escapesMediaDir(mediaDir, join(mediaDir, "hinos/1.mp3"))).toBe(
      false,
    );
  });

  it("path com .. escapa", () => {
    expect(escapesMediaDir(mediaDir, join(mediaDir, "../.env"))).toBe(true);
  });

  it("path absoluto fora do media dir escapa", () => {
    expect(escapesMediaDir(mediaDir, "/etc/passwd")).toBe(true);
  });
});

describe("SEC-143: NegativeCache (evita martelar upstream p/ 404)", () => {
  beforeEach(() => vi.useFakeTimers());

  it("cacheia miss e expira após TTL", () => {
    const cache = new NegativeCache(60_000, 100);
    expect(cache.has("x.mp3")).toBe(false);
    cache.set("x.mp3");
    expect(cache.has("x.mp3")).toBe(true);
    vi.advanceTimersByTime(61_000);
    expect(cache.has("x.mp3")).toBe(false);
  });

  it("cap de tamanho: não cresce sem limite", () => {
    const cache = new NegativeCache(60_000, 3);
    cache.set("a");
    cache.set("b");
    cache.set("c");
    cache.set("d"); // evicted: > cap
    expect(cache.size()).toBeLessThanOrEqual(3);
  });
});

describe("SEC-143: Semaphore (cap de downloads concorrentes)", () => {
  it("limita aquisições e libera corretamente", () => {
    const sem = new Semaphore(2);
    expect(sem.tryAcquire()).toBe(true);
    expect(sem.tryAcquire()).toBe(true);
    expect(sem.tryAcquire()).toBe(false); // cap atingido
    sem.release();
    expect(sem.tryAcquire()).toBe(true);
  });
});
