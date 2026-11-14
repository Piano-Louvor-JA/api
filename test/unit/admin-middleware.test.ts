import { describe, beforeEach, it, expect, vi } from "vitest";

/**
 * SPEC piano-admin-panel v1.1.0 (RF-01): middleware admin fail-closed.
 * ADMIN_EMAILS vazio → ninguém é admin (AC-6). E-mail na allowlist → passa.
 * Fora da allowlist → 403 uniforme (AC-2). Sem sessão → 401 (AC-3).
 */

const mocks = vi.hoisted(() => ({
  env: { ADMIN_EMAILS: "" as string },
  user: null as null | { id_user: number; email: string },
}));

vi.mock("../../db/connection.js", () => ({
  getDb: () => ({
    prepare: () => ({
      get: () => mocks.user,
      all: () => [],
    }),
  }),
}));

import { adminAuth } from "../../src/v1/custom/admin.middleware.js";

function makeCtx(email: string | undefined) {
  const json = vi.fn();
  return {
    req: { header: () => email ? `Bearer tok` : undefined },
    get: () => email ? { id_user: 1, email } : undefined,
    set: vi.fn(),
    json,
    status: undefined as number | undefined,
    // emulate c.json(body, status)
  };
}

describe("adminAuth middleware", () => {
  beforeEach(() => {
    mocks.env.ADMIN_EMAILS = "";
    mocks.user = { id_user: 1, email: "r@test.local" };
    delete process.env.ADMIN_EMAILS;
  });

  it("ADMIN_EMAILS vazio → 403 mesmo com sessão válida (fail-closed, AC-6)", async () => {
    const ctx = makeCtx("r@test.local");
    await adminAuth(ctx as never, vi.fn());
    expect(ctx.json).toHaveBeenCalledWith(
      expect.objectContaining({ error: expect.any(String) }),
      403,
    );
  });

  it("e-mail na allowlist → passa (next chamado)", async () => {
    process.env.ADMIN_EMAILS = "eze@test.local, r@test.local";
    const ctx = makeCtx("r@test.local");
    const next = vi.fn();
    await adminAuth(ctx as never, next);
    expect(next).toHaveBeenCalled();
    expect(ctx.json).not.toHaveBeenCalled();
  });

  it("e-mail fora da allowlist → 403 uniforme (AC-2)", async () => {
    process.env.ADMIN_EMAILS = "eze@test.local";
    const ctx = makeCtx("intruder@test.local");
    await adminAuth(ctx as never, vi.fn());
    expect(ctx.json).toHaveBeenCalledWith(
      expect.objectContaining({ error: expect.any(String) }),
      403,
    );
  });

  it("sem sessão → 401 (AC-3)", async () => {
    process.env.ADMIN_EMAILS = "r@test.local";
    mocks.user = null;
    const ctx = makeCtx(undefined);
    await adminAuth(ctx as never, vi.fn());
    expect(ctx.json).toHaveBeenCalledWith(
      expect.objectContaining({ error: expect.any(String) }),
      401,
    );
  });
});
