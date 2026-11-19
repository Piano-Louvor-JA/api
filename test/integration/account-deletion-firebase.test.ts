import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { type SeededDb, setupSeededDb } from "../helpers/seeded-db.js";

/**
 * Exclusão de conta com sessão Firebase (desktop/web entram pelo Firebase):
 * a senha é conferida no cliente (reauthenticate do Firebase), então a API
 * aceita o ID token verificado (checkRevoked) sem pedir a senha local — vale
 * também para conta legado vinculada (pbkdf2 + firebase_uid), cuja senha
 * local pode não ser a do Firebase. O usuário também some do Firebase Auth.
 */
const { verifyIdTokenMock, deleteUserMock } = vi.hoisted(() => ({
  verifyIdTokenMock: vi.fn(),
  deleteUserMock: vi.fn(),
}));

vi.mock("firebase-admin/app", () => ({
  initializeApp: vi.fn(() => ({})),
  cert: vi.fn(() => ({})),
}));

vi.mock("firebase-admin/auth", () => ({
  getAuth: vi.fn(() => ({
    verifyIdToken: verifyIdTokenMock,
    deleteUser: deleteUserMock,
  })),
}));

const { hashPassword } = await import("../../src/v1/custom/auth.service.js");

describe("DELETE /v1/custom/auth/me — sessão Firebase", () => {
  let app: SeededDb;
  let router: any;
  const JWT = "aaa.bbb.ccc";

  beforeAll(async () => {
    app = await setupSeededDb();
    router = app.router;
    process.env.FIREBASE_SERVICE_ACCOUNT = JSON.stringify({ project_id: "t" });
  });

  afterAll(() => {
    delete process.env.FIREBASE_SERVICE_ACCOUNT;
    app.cleanup();
  });

  it("conta vinculada (com senha local) exclui sem senha e sai do Firebase", async () => {
    const db = app.getDb();
    const r = db
      .prepare(
        `INSERT INTO custom_users (email, password_hash, display_name, firebase_uid) VALUES (?, ?, ?, ?)`,
      )
      .run("vinculada@test.local", hashPassword("Outra123!"), "V", "uid-v");
    const id = Number(r.lastInsertRowid);
    verifyIdTokenMock.mockResolvedValue({
      uid: "uid-v",
      email: "vinculada@test.local",
    });

    const res = await router.request("/v1/custom/auth/me", {
      method: "DELETE",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${JWT}`,
      },
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(204);
    expect(verifyIdTokenMock).toHaveBeenCalledWith(JWT, true);
    expect(
      db.prepare(`SELECT 1 FROM custom_users WHERE id_user = ?`).get(id),
    ).toBeUndefined();
    await vi.waitFor(() =>
      expect(deleteUserMock).toHaveBeenCalledWith("uid-v"),
    );
  });

  it("token Firebase inválido → 401", async () => {
    verifyIdTokenMock.mockRejectedValue(new Error("revoked"));
    const res = await router.request("/v1/custom/auth/me", {
      method: "DELETE",
      headers: { authorization: `Bearer ${JWT}` },
    });
    expect(res.status).toBe(401);
  });
});
