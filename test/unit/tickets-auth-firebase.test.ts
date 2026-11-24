// Cobre o caminho Firebase real de tickets.auth (sem TICKETS_AUTH_TEST_MODE).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { verifyIdTokenMock, initializeAppMock, certMock, getAuthMock } =
  vi.hoisted(() => ({
    verifyIdTokenMock: vi.fn(),
    initializeAppMock: vi.fn(() => ({ name: "tickets-test-app" })),
    certMock: vi.fn((sa: unknown) => ({ cert: sa })),
    getAuthMock: vi.fn(),
  }));

vi.mock("firebase-admin/app", () => ({
  initializeApp: initializeAppMock,
  cert: certMock,
}));

vi.mock("firebase-admin/auth", () => ({
  getAuth: getAuthMock,
}));

describe("tickets.auth — Firebase path (sem TEST_MODE)", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    delete process.env.TICKETS_AUTH_TEST_MODE;
    delete process.env.FIREBASE_SERVICE_ACCOUNT;
    getAuthMock.mockReturnValue({ verifyIdToken: verifyIdTokenMock });
  });

  afterEach(() => {
    delete process.env.FIREBASE_SERVICE_ACCOUNT;
    delete process.env.TICKETS_AUTH_TEST_MODE;
  });

  it("sem FIREBASE_SERVICE_ACCOUNT → HttpError 503 auth indisponível", async () => {
    const { verifyToken, HttpError } = await import(
      "../../src/v1/tickets/tickets.auth.js"
    );
    const err = await verifyToken("any-token").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect((err as { status: number }).status).toBe(503);
    expect((err as Error).message).toBe("auth indisponível");
    expect(initializeAppMock).not.toHaveBeenCalled();
  });

  it("token Firebase inválido → HttpError 401 genérico", async () => {
    process.env.FIREBASE_SERVICE_ACCOUNT = JSON.stringify({
      project_id: "demo",
    });
    verifyIdTokenMock.mockRejectedValue(new Error("id-token-expired"));
    const { verifyToken, HttpError } = await import(
      "../../src/v1/tickets/tickets.auth.js"
    );
    const err = await verifyToken("bad.jwt.token").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect((err as { status: number }).status).toBe(401);
    expect((err as Error).message).toBe("não autenticado");
    expect(initializeAppMock).toHaveBeenCalled();
    expect(verifyIdTokenMock).toHaveBeenCalledWith("bad.jwt.token", true);
  });

  it("token Firebase válido → retorna uid (reusa app em cache)", async () => {
    process.env.FIREBASE_SERVICE_ACCOUNT = JSON.stringify({
      project_id: "demo",
    });
    verifyIdTokenMock.mockResolvedValue({ uid: "firebase-uid-9" });
    const { verifyToken } = await import(
      "../../src/v1/tickets/tickets.auth.js"
    );
    await expect(verifyToken("good.jwt.token")).resolves.toBe("firebase-uid-9");
    verifyIdTokenMock.mockResolvedValue({ uid: "firebase-uid-10" });
    await expect(verifyToken("another.jwt")).resolves.toBe("firebase-uid-10");
    expect(initializeAppMock).toHaveBeenCalledTimes(1);
  });

  it("assertTenantScope: globalOperator ignora tenant e não lança", async () => {
    const { assertTenantScope } = await import(
      "../../src/v1/tickets/tickets.auth.js"
    );
    expect(() =>
      assertTenantScope(
        {
          uid: "g",
          tenantId: null,
          role: "global_operator",
          globalOperator: true,
        },
        "qualquer-tenant",
      ),
    ).not.toThrow();
  });

  it("assertTenantScope: membership de outro tenant → 403", async () => {
    const { assertTenantScope, HttpError } = await import(
      "../../src/v1/tickets/tickets.auth.js"
    );
    expect(() =>
      assertTenantScope(
        {
          uid: "u",
          tenantId: "a",
          role: "admin",
          globalOperator: false,
        },
        "b",
      ),
    ).toThrow(HttpError);
  });
});
