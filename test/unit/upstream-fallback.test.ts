import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  _candidatesForTest,
  _resetThrottleForTest,
  fetchUpstream,
  UpstreamError,
} from "../../src/lib/upstream.js";

// Fallback em cascata: Workers cai (rede/5xx) -> tenta api.louvorja.com.br
describe("fetchUpstream (fallback host)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    _resetThrottleForTest();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("monta candidatos: Workers primeiro, api.louvorja.com.br depois", () => {
    const cands = _candidatesForTest(
      "https://api.louvorja.workers.dev/json_db/config",
    );
    expect(cands).toEqual([
      "https://api.louvorja.workers.dev/json_db/config",
      "https://api.louvorja.com.br/json_db/config",
    ]);
  });

  it("URL já no fallback não duplica candidatos", () => {
    const cands = _candidatesForTest("https://api.louvorja.com.br/json_db/x");
    expect(cands).toEqual(["https://api.louvorja.com.br/json_db/x"]);
  });

  it("erro de rede no primário cai pro fallback e retorna 200", async () => {
    const ok = new Response("{}", { status: 200 });
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new TypeError("fetch failed"))
      .mockResolvedValueOnce(ok);
    vi.stubGlobal("fetch", fetchMock);

    const p = fetchUpstream("https://api.louvorja.workers.dev/json_db/x");
    await vi.advanceTimersByTimeAsync(3000);
    const res = await p;

    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect((fetchMock.mock.calls[1] as string[])[0]).toContain(
      "api.louvorja.com.br",
    );
  });

  it("5xx persistente no primário cai pro fallback", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response("down", { status: 503 }))
      // fallback responde ok
      .mockResolvedValueOnce(new Response("down", { status: 503 }))
      .mockResolvedValueOnce(new Response("down", { status: 503 }))
      .mockResolvedValueOnce(new Response("down", { status: 503 }))
      .mockResolvedValueOnce(new Response("down", { status: 503 }))
      .mockResolvedValueOnce(new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const p = fetchUpstream("https://api.louvorja.workers.dev/json_db/x");
    // 3 retries no primário (2+4+8s backoff) + throttle calls
    const assertion = p.then((res) => {
      expect(res.status).toBe(200);
    });
    await vi.advanceTimersByTimeAsync(60000);
    await assertion;
    // 4 chamadas no primário (1+3 retries) + 1 no fallback
    expect(fetchMock).toHaveBeenCalledTimes(5);
  });

  it("404 não troca de host — lança imediatamente", async () => {
    const fetchMock = vi.fn(async () => new Response("nf", { status: 404 }));
    vi.stubGlobal("fetch", fetchMock);

    const p = fetchUpstream("https://api.louvorja.workers.dev/json_db/x");
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
    expect(fetchMock).toHaveBeenCalledTimes(1); // só primário
  });

  it("ambos hosts caem: lança UpstreamError após esgotar tudo", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new TypeError("fetch failed"));
    vi.stubGlobal("fetch", fetchMock);

    const p = fetchUpstream("https://api.louvorja.workers.dev/json_db/x");
    const assertion = p.then(
      () => {
        throw new Error("deveria ter lançado");
      },
      (e: unknown) => {
        expect(e).toBeInstanceOf(UpstreamError);
      },
    );
    await vi.advanceTimersByTimeAsync(60000);
    await assertion;
    expect(fetchMock).toHaveBeenCalledTimes(2); // 1 primário + 1 fallback
  });
});
