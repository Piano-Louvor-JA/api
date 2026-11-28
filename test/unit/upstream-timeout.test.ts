import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  _resetThrottleForTest,
  fetchUpstream,
  UpstreamError,
} from "../../src/lib/upstream.js";

// Env ANTES do import: upstream.ts lê FETCH_TIMEOUT_MS no momento do import.
vi.hoisted(() => {
  process.env.FETCH_TIMEOUT_MS = "500";
});

describe("fetchUpstream — timeout (HOTFIX t_b3824cb7)", () => {
  beforeEach(() => {
    _resetThrottleForTest();
    process.env.FETCH_TIMEOUT_MS = "500";
  });
  afterEach(() => {
    delete process.env.FETCH_TIMEOUT_MS;
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("upstream pendurado aborta em FETCH_TIMEOUT_MS e lança UpstreamError", async () => {
    const fetchMock = vi.fn(
      (_u: string, init?: RequestInit) =>
        new Promise<Response>((_, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(
              new DOMException(
                "The operation was aborted due to timeout",
                "TimeoutError",
              ),
            ),
          );
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const t0 = Date.now();
    await expect(
      fetchUpstream("https://upstream/json_db/x"),
    ).rejects.toBeInstanceOf(UpstreamError);
    // 2 hosts: cada um aborta em ~0,5s (throttle ~0 no primeiro)
    expect(Date.now() - t0).toBeLessThan(4_000);
    expect(fetchMock).toHaveBeenCalledTimes(2); // tentou fallback também
  });

  it("UpstreamError do timeout tem status 504", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_u: string, init?: RequestInit) =>
          new Promise<Response>((_, reject) => {
            init?.signal?.addEventListener("abort", () =>
              reject(
                new DOMException(
                  "The operation was aborted due to timeout",
                  "TimeoutError",
                ),
              ),
            );
          }),
      ),
    );
    try {
      await fetchUpstream("https://upstream/json_db/x");
      expect.unreachable();
    } catch (e) {
      expect((e as UpstreamError).status).toBe(504);
    }
  });
});
