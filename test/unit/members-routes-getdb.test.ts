import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { getFirebaseApp, getFirestore } = vi.hoisted(() => ({
  getFirebaseApp: vi.fn(async () => ({ name: "app" })),
  getFirestore: vi.fn(() => ({
    collection: () => ({
      where: () => ({
        where: () => ({
          async get() {
            return { docs: [] };
          },
        }),
      }),
    }),
  })),
}));

vi.mock("firebase-admin/firestore", () => ({ getFirestore }));
vi.mock("../../src/v1/custom/firebase-auth.middleware.js", () => ({
  getFirebaseApp,
  firebaseAuth: async (_c: unknown, next: () => Promise<void>) => next(),
}));

describe("members.routes getDb sem firestoreOverride", () => {
  beforeEach(() => {
    getFirebaseApp.mockClear();
    getFirestore.mockClear();
  });

  afterEach(async () => {
    const { setMembersRoutesFirestoreForTests } = await import(
      "../../src/v1/custom/members.routes.js"
    );
    setMembersRoutesFirestoreForTests(null);
  });

  it("sem override chama getFirebaseApp + getFirestore", async () => {
    const { membersRoutes, setMembersRoutesFirestoreForTests } = await import(
      "../../src/v1/custom/members.routes.js"
    );
    setMembersRoutesFirestoreForTests(null);

    const app = new Hono();
    app.route("/v1/custom", membersRoutes);
    const res = await app.request("/v1/custom/community/roster?role=dev");
    expect(res.status).toBe(200);
    expect(getFirebaseApp).toHaveBeenCalled();
    expect(getFirestore).toHaveBeenCalled();
  });
});
