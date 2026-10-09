import { type Context, Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import { zodErrorHook } from "../../src/lib/zodErrorHook.js";
import { antiBotMiddleware } from "../../src/middleware/antiBot.js";
import { getClientIpSafe, rateLimit } from "../../src/middleware/rateLimit.js";
import { verifyPassword } from "../../src/v1/custom/auth.service.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("Middleware and validation boundary behavior", () => {
  it("probing is log-only and slow requests keep their response", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const time = vi.spyOn(Date, "now");
    time.mockReturnValueOnce(1000).mockReturnValue(4001);
    const app = new Hono();
    app.use("*", antiBotMiddleware);
    app.get("/doc", (c) => c.text("ok"));
    const res = await app.request("/doc");
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");
    expect(
      log.mock.calls.some(([line]) => String(line).includes("Probing")),
    ).toBe(true);
    expect(
      log.mock.calls.some(([line]) => String(line).includes("Request lenta")),
    ).toBe(true);
  });
  it("missing validation details still return only the generic 400 envelope", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const json = vi.fn();
    zodErrorHook({ success: false }, { json });
    expect(json).toHaveBeenCalledWith(
      { success: false, error: "Parâmetros inválidos" },
      400,
    );
  });
  it.each(["pbkdf2$NaN$salt$ff", "pbkdf2$0$salt$ff", "pbkdf2$-1$salt$ff"])(
    "rejects an invalid stored iteration count %s",
    (hash) => {
      expect(verifyPassword("password", hash)).toBe(false);
    },
  );
  it("does not treat whitespace forwarding as a usable client IP", () => {
    const c = { req: { header: () => "   " } } as unknown as Context;
    expect(getClientIpSafe(c, { TRUSTED_PROXY: true })).toBe("");
  });
  it("invalid rate limit env values fall back to defaults while still calling next", async () => {
    vi.stubEnv("RATE_LIMIT_MAX", "invalid");
    vi.stubEnv("RATE_LIMIT_BURST", "invalid");
    vi.stubEnv("TRUSTED_PROXY", "true");
    const app = new Hono();
    app.use("*", rateLimit);
    app.get("/boundary", (c) => c.text("ok"));
    const res = await app.request("/boundary", {
      headers: { "x-real-ip": "boundary-unique" },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("X-RateLimit-Limit")).toBe("5000");
    expect(res.headers.get("X-RateLimit-Remaining")).toBe("99");
  });
});
