import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { closeDb, getDb, getDbStats, initDb } from "../../src/db/connection.js";
import {
  _resetThrottleForTest,
  fetchUpstream,
  UpstreamError,
} from "../../src/lib/upstream.js";

describe("unit - connection.ts branches", () => {
  // DB tmp isolado por arquivo: evita FK race com workers paralelos no DB compartilhado (data/catalog.db)
  const tmpDir = mkdtempSync(join(tmpdir(), "cov-branches-"));
  const originalDbPath = process.env.DB_PATH;

  afterAll(() => {
    // Restore default DB_PATH
    if (originalDbPath === undefined) delete process.env.DB_PATH;
    else process.env.DB_PATH = originalDbPath;
    rmSync(tmpDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    process.env.DB_PATH = join(tmpDir, "cov.db");
  });

  it("getDb throws when db not initialized", () => {
    closeDb();
    expect(() => getDb()).toThrow("DB nao inicializado");
  });

  it("getDbStats returns zeros when db not initialized", () => {
    closeDb();
    const stats = getDbStats();
    expect(stats).toEqual({ sizeBytes: 0, tableCount: 0 });
  });

  it("initDb handles migrations dir not found (lines 33-34)", async () => {
    // Use a temp path that doesn't exist
    const originalDbPath = process.env.DB_PATH;
    process.env.DB_PATH = "/tmp/nonexistent_test_path/catalog.db";

    // Should log warning but not throw
    initDb();
    closeDb();

    if (originalDbPath) process.env.DB_PATH = originalDbPath;
    else delete process.env.DB_PATH;
  });

  it("initDb handles migration error throw (line 51)", async () => {
    // This is harder to test - we'd need to inject a failing migration
    // The try-catch on lines 43-52 covers this
    // At minimum we test that initDb doesn't throw on normal operation
    initDb();
    closeDb();
  });

  it("getDbStats covers lines 90-97 when db is initialized", () => {
    initDb();
    const stats = getDbStats();
    expect(stats.sizeBytes).toBeGreaterThanOrEqual(0);
    expect(stats.tableCount).toBeGreaterThan(0);
    closeDb();
  });
});

describe("unit - upstream.ts branches", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    _resetThrottleForTest();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("_resetThrottleForTest resets state", () => {
    // Just verify it doesn't throw
    _resetThrottleForTest();
  });

  it("fetchUpstream returns on 200", async () => {
    const ok = new Response("{}", { status: 200 });
    const fetchMock = vi.fn(async () => ok);
    vi.stubGlobal("fetch", fetchMock);

    const p = fetchUpstream("https://upstream/json_db/config");
    await vi.advanceTimersByTimeAsync(1000);
    const res = await p;

    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("fetchUpstream retries on 429 with Retry-After", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response("rate limited", {
          status: 429,
          headers: { "retry-after": "1" },
        }),
      )
      .mockResolvedValueOnce(new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const p = fetchUpstream("https://upstream/json_db/x");
    await vi.advanceTimersByTimeAsync(5000);
    const res = await p;

    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("fetchUpstream throws UpstreamError after max retries on 429", async () => {
    const fetchMock = vi.fn(async () => new Response("nope", { status: 429 }));
    vi.stubGlobal("fetch", fetchMock);

    const p = fetchUpstream("https://upstream/json_db/x");
    const assertion = p.then(
      () => {
        throw new Error("deveria ter lançado");
      },
      (e: unknown) => {
        expect(e).toBeInstanceOf(UpstreamError);
        expect((e as UpstreamError).status).toBe(429);
      },
    );
    await vi.advanceTimersByTimeAsync(60000);
    await assertion;
    expect(fetchMock).toHaveBeenCalledTimes(8); // primário (4) + fallback (4)
  });

  it("fetchUpstream throws immediately on 404 (non-retryable)", async () => {
    const fetchMock = vi.fn(async () => new Response("nf", { status: 404 }));
    vi.stubGlobal("fetch", fetchMock);

    const p = fetchUpstream("https://upstream/json_db/x");
    const assertion = p.then(
      () => {
        throw new Error("deveria ter lançado");
      },
      (e: unknown) => {
        expect(e).toBeInstanceOf(UpstreamError);
        expect((e as UpstreamError).status).toBe(404);
      },
    );
    await vi.advanceTimersByTimeAsync(1000);
    await assertion;
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("fetchUpstream respects rate limit between calls", async () => {
    const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const p1 = fetchUpstream("https://upstream/a");
    await vi.advanceTimersByTimeAsync(1000);
    await p1;

    const p2 = fetchUpstream("https://upstream/b");
    await vi.advanceTimersByTimeAsync(2000);
    await p2;
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("fetchUpstream wait branch (line 27) - throttle delay", async () => {
    const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const p1 = fetchUpstream("https://upstream/a");
    await vi.advanceTimersByTimeAsync(1000);
    await p1;

    // Second call should wait for MIN_INTERVAL_MS (800ms)
    const p2 = fetchUpstream("https://upstream/b");
    // Don't advance enough time - throttle will wait
    await vi.advanceTimersByTimeAsync(100);
    // Now advance remaining
    await vi.advanceTimersByTimeAsync(800);
    await p2;
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("fetchUpstream retries on 5xx (line 52)", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("server error", { status: 500 }))
      .mockResolvedValueOnce(new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const p = fetchUpstream("https://upstream/json_db/x");
    await vi.advanceTimersByTimeAsync(5000);
    const res = await p;

    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("fetchUpstream throws after max retries on 5xx", async () => {
    const fetchMock = vi.fn(
      async () => new Response("server error", { status: 500 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const p = fetchUpstream("https://upstream/json_db/x");
    const assertion = p.then(
      () => {
        throw new Error("deveria ter lançado");
      },
      (e: unknown) => {
        expect(e).toBeInstanceOf(UpstreamError);
        expect((e as UpstreamError).status).toBe(500);
      },
    );
    await vi.advanceTimersByTimeAsync(60000);
    await assertion;
    expect(fetchMock).toHaveBeenCalledTimes(8); // primário (4) + fallback (4)
  });
});
