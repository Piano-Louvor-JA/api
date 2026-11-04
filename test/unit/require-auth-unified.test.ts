import type { Context } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";

// piano-unified-auth R1–R5 — requireAuth deve aceitar usuário já resolvido
// por optionalAuth/firebaseAuth globais (token opaco OU Firebase ID token).
// https://github.com/Piano-Louvor-JA/api — SPEC piano-unified-auth v1.0.0 RF-01/RF-02

const { prepareMock } = vi.hoisted(() => ({ prepareMock: vi.fn() }));

vi.mock("../../src/db/connection.js", () => ({
  getDb: () => ({ prepare: prepareMock }),
}));

import { requireAuth } from "../../src/v1/custom/auth.middleware.js";

type User = { id_user: number; email: string; display_name: string };

function makeContext(opts: { headers?: Record<string, string>; user?: User }) {
  const store = new Map<string, unknown>();
  if (opts.user) store.set("user", opts.user);
  return {
    req: { header: (k: string) => opts.headers?.[k] ?? "" },
    set: (k: string, v: unknown) => store.set(k, v),
    get: (k: string) => store.get(k),
    // resposta curta-circuitada em 401
    json: (body: unknown, status: number) => ({ body, status }),
  } as unknown as Context & { get: (k: string) => User | undefined };
}

const firebaseUser: User = {
  id_user: 42,
  email: "rafael@example.com",
  display_name: "Rafael",
};

describe("requireAuth (unified auth RF-01/RF-02)", () => {
  beforeEach(() => {
    prepareMock.mockReset();
  });

  it("R1: user resolvido por firebaseAuth + Bearer Firebase ID token → 200 sem reconsultar custom_sessions", async () => {
    const ctx = makeContext({
      headers: {
        authorization: "Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.sig",
      },
      user: firebaseUser,
    });
    let nextRan = false;
    // biome-ignore lint/suspicious/noExplicitAny: middleware handler direto
    const res = await (requireAuth as any)(ctx, async () => {
      nextRan = true;
    });
    expect(nextRan).toBe(true);
    expect(res).toBeUndefined(); // não short-circuitou com 401
    expect(prepareMock).not.toHaveBeenCalled(); // R5: sem reconsulta ao banco
    expect(ctx.get("user")).toEqual(firebaseUser);
  });

  it("R2: sem user resolvido e sem token → 401, sem next()", async () => {
    const ctx = makeContext({});
    let nextRan = false;
    // biome-ignore lint/suspicious/noExplicitAny: middleware handler direto
    const res = await (requireAuth as any)(ctx, async () => {
      nextRan = true;
    });
    expect(nextRan).toBe(false);
    expect(res).toEqual({ body: { error: "Não autenticado" }, status: 401 });
  });

  it("R5: user presente mas sem header authorization → aceita (cadeia global já validou)", async () => {
    const ctx = makeContext({ user: firebaseUser });
    let nextRan = false;
    // biome-ignore lint/suspicious/noExplicitAny: middleware handler direto
    const res = await (requireAuth as any)(ctx, async () => {
      nextRan = true;
    });
    expect(nextRan).toBe(true);
    expect(res).toBeUndefined();
    expect(prepareMock).not.toHaveBeenCalled();
  });

  it("R3: sem user resolvido + token opaco legacy válido em custom_sessions → 200 via fallback", async () => {
    prepareMock.mockReturnValueOnce({
      get: () => ({
        id_user: 7,
        email: "legacy@example.com",
        display_name: "Legacy",
      }),
    });
    const ctx = makeContext({ headers: { authorization: "Bearer opaco123" } });
    let nextRan = false;
    // biome-ignore lint/suspicious/noExplicitAny: middleware handler direto
    const res = await (requireAuth as any)(ctx, async () => {
      nextRan = true;
    });
    expect(nextRan).toBe(true);
    expect(res).toBeUndefined();
    expect(ctx.get("user")).toMatchObject({ id_user: 7 });
  });

  it("R3-neg: sem user resolvido + token desconhecido → 401", async () => {
    prepareMock.mockReturnValueOnce({ get: () => undefined });
    const ctx = makeContext({
      headers: { authorization: "Bearer desconhecido" },
    });
    let nextRan = false;
    // biome-ignore lint/suspicious/noExplicitAny: middleware handler direto
    const res = await (requireAuth as any)(ctx, async () => {
      nextRan = true;
    });
    expect(nextRan).toBe(false);
    expect(res).toEqual({ body: { error: "Não autenticado" }, status: 401 });
  });
});
