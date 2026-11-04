import type { Context } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";

// piano-unified-auth RF-05 — upsert firebaseAuth NUNCA re-vincula e-mail
// legacy que já possui firebase_uid de OUTRO UID (sem merge por suposição).

const { verifyIdTokenMock, getDbMock } = vi.hoisted(() => ({
  verifyIdTokenMock: vi.fn(),
  getDbMock: { prepare: vi.fn() },
}));

vi.mock("firebase-admin/app", () => ({
  initializeApp: vi.fn(() => ({})),
  cert: vi.fn(() => ({})),
}));
vi.mock("firebase-admin/auth", () => ({
  getAuth: vi.fn(() => ({ verifyIdToken: verifyIdTokenMock })),
}));
vi.mock("../../src/db/connection.js", () => ({
  getDb: () => getDbMock,
}));

import { firebaseAuth } from "../../src/v1/custom/firebase-auth.middleware.js";

type User = { id_user: number; email: string; display_name: string };

function makeContext(headers: Record<string, string>) {
  const store = new Map<string, unknown>();
  return {
    req: { header: (k: string) => headers[k] },
    set: (k: string, v: unknown) => store.set(k, v),
    get: (k: string) => store.get(k),
  } as unknown as Context & { get: (k: string) => User | undefined };
}

const JWT = "Bearer h.1.2"; // 3 segmentos → cai no fluxo Firebase

describe("firebaseAuth upsert (RF-05 conflito)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("FIREBASE_SERVICE_ACCOUNT", JSON.stringify({ project_id: "t" }));
    verifyIdTokenMock.mockResolvedValue({
      uid: "uid-novo",
      email: "legacy@example.com",
      name: "Legacy",
    });
  });

  it("R4: e-mail já vinculado a OUTRO firebase_uid → segue anônimo, SEM update/insert", async () => {
    const stmts: Record<
      string,
      { get?: unknown; run?: ReturnType<typeof vi.fn> }
    > = {};
    const stmt = (result: unknown, run?: ReturnType<typeof vi.fn>) => ({
      get: vi.fn(() => result),
      run: run ?? vi.fn(),
    });
    const byUid = stmt(undefined); // lookup por uid não acha
    const byEmail = stmt({
      id_user: 7,
      email: "legacy@example.com",
      display_name: "Legacy",
      firebase_uid: "uid-ANTIGO",
    });
    const update = stmt(undefined, vi.fn());
    const insert = stmt(undefined, vi.fn());
    getDbMock.prepare.mockImplementation((sql: string) => {
      if (sql.includes("firebase_uid = ?")) return byUid;
      if (sql.includes("WHERE email")) return byEmail;
      if (sql.startsWith("UPDATE")) return update;
      if (sql.startsWith("INSERT")) return insert;
      return stmt(undefined);
    });

    const ctx = makeContext({ authorization: JWT });
    await firebaseAuth(ctx as never, async () => {});
    expect(ctx.get("user")).toBeUndefined(); // anônimo → 401 nas requireAuth
    expect(update.run).not.toHaveBeenCalled();
    expect(insert.run).not.toHaveBeenCalled();
  });

  it("R4b: e-mail legacy SEM firebase_uid → vincula (UPDATE) preservando id_user", async () => {
    const update = vi.fn();
    getDbMock.prepare.mockImplementation((sql: string) => ({
      get: vi.fn(() =>
        sql.includes("firebase_uid = ?")
          ? undefined
          : sql.includes("WHERE email")
            ? {
                id_user: 7,
                email: "legacy@example.com",
                display_name: "Legacy",
                firebase_uid: null,
              }
            : undefined,
      ),
      run: update,
    }));

    const ctx = makeContext({ authorization: JWT });
    await firebaseAuth(ctx as never, async () => {});
    expect(ctx.get("user")).toMatchObject({ id_user: 7 }); // MESMO id_user
    expect(update).toHaveBeenCalled();
  });
});
