import type { Context } from "hono";
import { afterEach, expect, it, vi } from "vitest";

vi.mock("../../src/lib/telemetry.js", () => ({ reportError: vi.fn() }));

import { createApp } from "../../src/app.js";
import { reportError } from "../../src/lib/telemetry.js";

afterEach(() => vi.restoreAllMocks());
it("erro sem rota registrada mantém resposta genérica e contexto unmatched", () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  const app = createApp();
  const handler = (
    app as unknown as { errorHandler: (err: Error, c: Context) => unknown }
  ).errorHandler;
  const json = vi.fn();
  handler!(new Error("sensitive database failure"), {
    req: { routePath: undefined, method: "GET" },
    json,
  } as unknown as Context);
  expect(json).toHaveBeenCalledWith({ error: "Internal Server Error" }, 500);
  expect(reportError).toHaveBeenCalledWith(expect.any(Error), {
    route: "unmatched",
    method: "GET",
  });
});
