import type { Context } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";

// admin-membros v1.0.0 — espelho Auth→community_members/{uid} no login

const {
  verifyIdTokenMock,
  getDbMock,
  fsDocSetMock,
  fsDocCreateMock,
  fsDocGetMock,
} = vi.hoisted(() => ({
  verifyIdTokenMock: vi.fn(),
  getDbMock: { prepare: vi.fn() },
  fsDocSetMock: vi.fn(),
  fsDocCreateMock: vi.fn(),
  fsDocGetMock: vi.fn(),
}));

vi.mock("firebase-admin/app", () => ({
  initializeApp: vi.fn(() => ({})),
  cert: vi.fn(() => ({})),
}));
vi.mock("firebase-admin/auth", () => ({
  getAuth: vi.fn(() => ({ verifyIdToken: verifyIdTokenMock })),
}));
vi.mock("firebase-admin/firestore", () => ({
  getFirestore: vi.fn(() => ({
    collection: vi.fn(() => ({
      doc: vi.fn(() => ({
        get: fsDocGetMock,
        set: fsDocSetMock,
        create: fsDocCreateMock,
      })),
    })),
  })),
}));
vi.mock("../../src/db/connection.js", () => ({
  getDb: () => getDbMock,
}));

import { firebaseAuth } from "../../src/v1/custom/firebase-auth.middleware.js";

function makeContext(headers: Record<string, string>) {
  const store = new Map<string, unknown>();
  return {
    req: { header: (k: string) => headers[k] },
    set: (k: string, v: unknown) => store.set(k, v),
    get: (k: string) => store.get(k),
  } as unknown as Context;
}

const stmtChain = (result: { get?: unknown }) => ({
  get: vi.fn(() => result.get),
  run: vi.fn(() => ({ lastInsertRowid: 1 })),
});

describe("firebaseAuth middleware — espelho community_members (SPEC admin-membros v1.0.0)", () => {
  const callMirror = async (ctx: ReturnType<typeof makeContext>) =>
    firebaseAuth(ctx as never, async () => {});

  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
    vi.stubEnv("FIREBASE_SERVICE_ACCOUNT", JSON.stringify({ project_id: "t" }));
    fsDocGetMock.mockResolvedValue({ exists: false });
    fsDocSetMock.mockResolvedValue(undefined);
    fsDocCreateMock.mockResolvedValue(undefined);
    verifyIdTokenMock.mockResolvedValue({
      uid: "uid-1",
      email: "novo@teste.dev",
      name: "Novo Tester",
      firebase: { project_id: "t" },
    });
    getDbMock.prepare.mockReturnValue(stmtChain({ get: undefined }));
  });

  it("AC1/AC4: login de usuário novo → cria doc community_members/{uid} com campos mínimos", async () => {
    const ctx = makeContext({ authorization: "Bearer a.b.c" });
    await callMirror(ctx);
    await vi.waitFor(() => expect(fsDocCreateMock).toHaveBeenCalledOnce());
    const data = fsDocCreateMock.mock.calls[0][0] as Record<string, unknown>;
    expect(data.uid).toBe("uid-1");
    expect(data.email).toBe("novo@teste.dev");
    expect(data.role).toBe("member");
    expect(data.status).toBe("active");
    expect(data.createdAt).toBeInstanceOf(Date);
  });

  it("AC5: login existente → atualiza perfil preservando role/status", async () => {
    fsDocGetMock.mockResolvedValue({
      exists: true,
      data: () => ({ role: "moderator", status: "banned" }),
    });
    const ctx = makeContext({ authorization: "Bearer a.b.c" });
    await callMirror(ctx);
    await vi.waitFor(() => expect(fsDocSetMock).toHaveBeenCalledOnce());
    expect(fsDocCreateMock).not.toHaveBeenCalled();
    expect(fsDocSetMock.mock.calls[0][0]).not.toHaveProperty("role");
    expect(fsDocSetMock.mock.calls[0][0]).not.toHaveProperty("status");
  });

  it("Firestore pendente não bloqueia o login", async () => {
    fsDocGetMock.mockReturnValue(new Promise(() => {}));
    const ctx = makeContext({ authorization: "Bearer a.b.c" });
    await callMirror(ctx);
    expect(ctx.get("user")).toBeDefined();
    expect(fsDocCreateMock).not.toHaveBeenCalled();
  });

  it("usuário sem email → doc com fallback definido", async () => {
    verifyIdTokenMock.mockResolvedValue({
      uid: "uid-anon",
      firebase: { project_id: "t" },
    });
    const ctx = makeContext({ authorization: "Bearer a.b.c" });
    await callMirror(ctx);
    await vi.waitFor(() => expect(fsDocCreateMock).toHaveBeenCalledOnce());
    const data = fsDocCreateMock.mock.calls[0][0] as Record<string, unknown>;
    expect(data.email).not.toBeUndefined();
  });
});
