import type { Context, Next } from "hono";
import { expect, it, vi } from "vitest";

vi.mock("../../src/v1/custom/firebase-auth.middleware.js", () => ({
  firebaseAuth: async (_c: Context, next: Next) => next(),
}));
vi.mock("../../src/v1/custom/auth.middleware.js", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../../src/v1/custom/auth.middleware.js")
  >()),
  optionalAuth: async (c: Context, next: Next) => {
    c.set("user", { id_user: 1, email: "test@local", display_name: "User" });
    await next();
  },
}));

import { customRoutes } from "../../src/v1/custom/custom.routes.js";

it.each([undefined, "Basic invalid"])(
  "contexto autenticado sem Bearer não inventa token (%s)",
  async (header) => {
    const response = await customRoutes.request("/auth/firebase-session", {
      method: "POST",
      headers: header ? { authorization: header } : {},
    });
    expect(response.status).toBe(200);
    expect((await response.json()).token).toBe("");
  },
);
