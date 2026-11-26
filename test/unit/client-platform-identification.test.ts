import { Hono } from "hono";
import { expect, it } from "vitest";
import { clientPlatform } from "../../src/middleware/telemetry.js";

it.each(["site", "palco-browser"])(
  "reconhece %s sem fallback por user-agent",
  async (platform) => {
    const app = new Hono().get("/", (c) => c.text(clientPlatform(c)));
    const response = await app.request("/", {
      headers: { "X-Client-Platform": platform, "User-Agent": "Android" },
    });
    expect(await response.text()).toBe(platform);
  },
);
