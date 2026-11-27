import type { Context } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// RF-003/RF-004 — firebaseAuth middleware: valida ID token Firebase, upsert custom_users

const { verifyIdTokenMock, getDbMock } = vi.hoisted(() => ({
  verifyIdTokenMock: vi.fn(),
  getDbMock: {
    prepare: vi.fn(),
  },
}));

vi.mock("firebase-admin/app", () => ({
  initializeApp: vi.fn(() => ({})),
  cert: vi.fn(() => ({})),
}));
vi.mock("firebase-admin/auth", () => ({
  getAuth: vi.fn(() => ({ verifyIdToken: verifyIdTokenMock })),
}));

// conexão do banco mockada
vi.mock("../../src/db/connection.js", () => ({
  getDb: () => getDbMock,
}));

import { upsertCommunityMember } from "../../src/v1/custom/community-mirror.service.js";
import { firebaseAuth } from "../../src/v1/custom/firebase-auth.middleware.js";

vi.mock("../../src/v1/custom/community-mirror.service.js", () => ({
  upsertCommunityMember: vi.fn(async () => {}),
  setCommunityMemberFirestoreForTests: vi.fn(),
}));

type User = { id_user: number; email: string; display_name: string };

function makeContext(headers: Record<string, string>) {
  const store = new Map<string, unknown>();
  return {
    req: { header: (k: string) => headers[k] },
    set: (k: string, v: unknown) => store.set(k, v),
    get: (k: string) => store.get(k),
  } as unknown as Context & { get: (k: string) => User | undefined };
}

const stmtChain = (result: {
  get?: unknown;
  run?: (...a: unknown[]) => unknown;
}) => ({
  get: vi.fn(() => result.get),
  run: vi.fn(result.run ?? (() => ({ lastInsertRowid: 1 }))),
});

describe("firebaseAuth middleware (RF-003/RF-004)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
    vi.stubEnv("FIREBASE_SERVICE_ACCOUNT", JSON.stringify({ project_id: "t" }));
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  const callMiddleware = async (
    ctx: ReturnType<typeof makeContext>,
    next: () => Promise<void>,
  ) => firebaseAuth(ctx as never, next);

  it("sem header authorization → segue anônimo, sem tocar banco", async () => {
    const ctx = makeContext({});
    let nextRan = false;
    await callMiddleware(ctx, async () => {
      nextRan = true;
    });
    expect(nextRan).toBe(true);
    expect(ctx.get("user")).toBeUndefined();
    expect(getDbMock.prepare).not.toHaveBeenCalled();
  });

  it("token opaco legacy (sem JWT dots) → ignora (optionalAuth cuida)", async () => {
    const ctx = makeContext({ authorization: "Bearer abcdef123" });
    await callMiddleware(ctx, async () => {});
    expect(verifyIdTokenMock).not.toHaveBeenCalled();
  });

  it("configuração ausente mantém sessão anônima e informa falha", async () => {
    vi.resetModules();
    vi.stubEnv("FIREBASE_SERVICE_ACCOUNT", undefined);
    const { firebaseAuth: freshAuth } = await import(
      "../../src/v1/custom/firebase-auth.middleware.js"
    );
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const ctx = makeContext({ authorization: "Bearer a.b.c" }),
        next = vi.fn(async () => {});
      await freshAuth(ctx as never, next);
      expect(next).toHaveBeenCalledOnce();
      expect(ctx.get("user")).toBeUndefined();
      expect(verifyIdTokenMock).not.toHaveBeenCalled();
      expect(warning).toHaveBeenCalledWith(
        "[firebaseAuth] verifyIdToken FALHOU:",
        "FIREBASE_SERVICE_ACCOUNT não configurado",
      );
    } finally {
      warning.mockRestore();
    }
  });
  it("ID token Firebase válido + usuário novo → INSERT com firebase_uid e seta user", async () => {
    verifyIdTokenMock.mockResolvedValue({
      uid: "fb-uid-1",
      email: "novo@gmail.com",
      name: "Novo",
    });
    const selectByUid = stmtChain({ get: undefined });
    const selectByEmail = stmtChain({ get: undefined });
    const insert = stmtChain({
      run: () => ({ lastInsertRowid: 42 }),
    });
    getDbMock.prepare.mockImplementation((sql: string) => {
      if (sql.includes("firebase_uid = ?")) return selectByUid;
      if (sql.includes("email = ?")) return selectByEmail;
      return insert;
    });

    const ctx = makeContext({
      authorization: "Bearer a.b.c",
    });
    await callMiddleware(ctx, async () => {});

    expect(verifyIdTokenMock).toHaveBeenCalled();
    expect(insert.run).toHaveBeenCalledWith(
      "novo@gmail.com",
      "firebase$no-local-password",
      "Novo",
      "fb-uid-1",
    );
    expect(ctx.get("user")).toEqual({
      id_user: 42,
      email: "novo@gmail.com",
      display_name: "Novo",
    });
    expect(upsertCommunityMember).toHaveBeenCalledWith({
      uid: "fb-uid-1",
      email: "novo@gmail.com",
      name: "Novo",
    });
  });

  it("T3: login válido chama espelho community_members 1× (AC1/AC7)", async () => {
    verifyIdTokenMock.mockResolvedValue({
      uid: "fb-uid-9",
      email: "esp@gmail.com",
      name: "Esp",
    });
    getDbMock.prepare.mockImplementation((sql: string) => {
      if (sql.includes("firebase_uid = ?"))
        return stmtChain({
          get: { id_user: 9, email: "esp@gmail.com", display_name: "Esp" },
        });
      return stmtChain({});
    });
    const ctx = makeContext({ authorization: "Bearer a.b.c" });
    await callMiddleware(ctx, async () => {});
    expect(upsertCommunityMember).toHaveBeenCalledExactlyOnceWith({
      uid: "fb-uid-9",
      email: "esp@gmail.com",
      name: "Esp",
    });
  });

  it.each([new Error("firestore down"), "firestore down"])(
    "T3/AC8: falha do espelho NÃO quebra login — next() roda, warn logado (%s)",
    async (failure) => {
      verifyIdTokenMock.mockResolvedValue({
        uid: "fb-uid-10",
        email: "fail@gmail.com",
        name: "Fail",
      });
      vi.mocked(upsertCommunityMember).mockRejectedValueOnce(failure);
      getDbMock.prepare.mockImplementation((sql: string) => {
        if (sql.includes("firebase_uid = ?"))
          return stmtChain({
            get: { id_user: 10, email: "fail@gmail.com", display_name: "Fail" },
          });
        return stmtChain({});
      });
      const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        const ctx = makeContext({ authorization: "Bearer a.b.c" });
        const next = vi.fn(async () => {});
        await callMiddleware(ctx, next);
        expect(next).toHaveBeenCalledOnce();
        expect(ctx.get("user")).toEqual({
          id_user: 10,
          email: "fail@gmail.com",
          display_name: "Fail",
        });
        expect(warning).toHaveBeenCalledWith(
          "[communityMirror] upsert falhou:",
          "firestore down",
        );
      } finally {
        warning.mockRestore();
        vi.mocked(upsertCommunityMember).mockReset();
        vi.mocked(upsertCommunityMember).mockResolvedValue(undefined);
      }
    },
  );

  it("T3/AC9: sem user resolvido (conflito RF-05/anônimo) → espelho NÃO chamado", async () => {
    verifyIdTokenMock.mockResolvedValue({
      uid: "fb-uid-11",
      email: "conflict@gmail.com",
      name: "C",
    });
    // conflito: e-mail legacy vinculado a outro firebase_uid → segue anônimo
    getDbMock.prepare.mockImplementation((sql: string) => {
      if (sql.includes("firebase_uid = ?"))
        return stmtChain({ get: undefined });
      if (sql.includes("email = ?"))
        return stmtChain({
          get: {
            id_user: 11,
            email: "conflict@gmail.com",
            display_name: "C",
            firebase_uid: "outro-uid",
          },
        });
      return stmtChain({});
    });
    const ctx = makeContext({ authorization: "Bearer a.b.c" });
    await callMiddleware(ctx, async () => {});
    expect(ctx.get("user")).toBeUndefined();
    expect(upsertCommunityMember).not.toHaveBeenCalled();
  });

  it("ID token com email já existente (legacy) → vincula firebase_uid ao id_user existente", async () => {
    verifyIdTokenMock.mockResolvedValue({
      uid: "fb-uid-2",
      email: "legacy@test.com",
      name: "Legacy",
    });
    const selectByUid = stmtChain({ get: undefined });
    const selectByEmail = stmtChain({
      get: { id_user: 7, email: "legacy@test.com", display_name: "Legacy" },
    });
    const update = stmtChain({ run: () => ({}) });
    getDbMock.prepare.mockImplementation((sql: string) => {
      if (sql.includes("firebase_uid = ?") && sql.startsWith("SELECT"))
        return selectByUid;
      if (sql.includes("email = ?")) return selectByEmail;
      return update;
    });

    const ctx = makeContext({ authorization: "Bearer a.b.c" });
    await callMiddleware(ctx, async () => {});

    expect(update.run).toHaveBeenCalledWith("fb-uid-2", 7);
    expect(ctx.get("user")).toEqual({
      id_user: 7,
      email: "legacy@test.com",
      display_name: "Legacy",
    });
  });

  it("token Firebase inválido → segue anônimo, não lança", async () => {
    verifyIdTokenMock.mockRejectedValue(new Error("id-token-expired"));
    getDbMock.prepare.mockImplementation(() => stmtChain({}));
    const ctx = makeContext({ authorization: "Bearer a.b.c" });
    await callMiddleware(ctx, async () => {});
    expect(ctx.get("user")).toBeUndefined();
  });

  it("sem name no decoded → display_name derivado do email", async () => {
    verifyIdTokenMock.mockResolvedValue({
      uid: "fb-uid-3",
      email: "semname@gmail.com",
    });
    const selectByUid = stmtChain({ get: undefined });
    const selectByEmail = stmtChain({ get: undefined });
    const insert = stmtChain({ run: () => ({ lastInsertRowid: 5 }) });
    getDbMock.prepare.mockImplementation((sql: string) => {
      if (sql.includes("firebase_uid = ?")) return selectByUid;
      if (sql.includes("email = ?")) return selectByEmail;
      return insert;
    });

    const ctx = makeContext({ authorization: "Bearer a.b.c" });
    await callMiddleware(ctx, async () => {});
    expect(insert.run).toHaveBeenCalledWith(
      "semname@gmail.com",
      "firebase$no-local-password",
      "semname",
      "fb-uid-3",
    );
  });

  it("sem email no decoded → email sintético com uid", async () => {
    verifyIdTokenMock.mockResolvedValue({ uid: "fb-uid-4" });
    const selectByUid = stmtChain({ get: undefined });
    const selectByEmail = stmtChain({ get: undefined });
    const insert = stmtChain({ run: () => ({ lastInsertRowid: 6 }) });
    getDbMock.prepare.mockImplementation((sql: string) => {
      if (sql.includes("firebase_uid = ?")) return selectByUid;
      if (sql.includes("email = ?")) return selectByEmail;
      return insert;
    });

    const ctx = makeContext({ authorization: "Bearer a.b.c" });
    await callMiddleware(ctx, async () => {});
    expect(insert.run).toHaveBeenCalledWith(
      "fb-uid-4@firebase.local",
      "firebase$no-local-password",
      "fb-uid-4",
      "fb-uid-4",
    );
  });
  it("falha de verificação sem objeto Error não interrompe o fluxo", async () => {
    verifyIdTokenMock.mockRejectedValue("provider unavailable");
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const ctx = makeContext({ authorization: "Bearer a.b.c" });
      await callMiddleware(ctx, async () => {});
      expect(ctx.get("user")).toBeUndefined();
      expect(warning).toHaveBeenCalledWith(
        "[firebaseAuth] verifyIdToken FALHOU:",
        "provider unavailable",
      );
    } finally {
      warning.mockRestore();
    }
  });
});
