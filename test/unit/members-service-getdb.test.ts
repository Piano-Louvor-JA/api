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
      doc: () => ({
        async get() {
          return { exists: false, data: () => undefined, id: "x" };
        },
      }),
    }),
  })),
}));

vi.mock("firebase-admin/firestore", () => ({ getFirestore }));
vi.mock("../../src/v1/custom/firebase-auth.middleware.js", () => ({
  getFirebaseApp,
}));

describe("members.service getDb sem firestoreOverride", () => {
  beforeEach(() => {
    getFirebaseApp.mockClear();
    getFirestore.mockClear();
  });

  afterEach(async () => {
    const { setMembersFirestoreForTests } = await import(
      "../../src/v1/custom/members.service.js"
    );
    setMembersFirestoreForTests(null);
  });

  it("listRoster sem override usa getFirebaseApp + getFirestore", async () => {
    const { listRoster, setMembersFirestoreForTests } = await import(
      "../../src/v1/custom/members.service.js"
    );
    setMembersFirestoreForTests(null);
    const roster = await listRoster("pianolouvorja", "dev");
    expect(roster).toEqual([]);
    expect(getFirebaseApp).toHaveBeenCalled();
    expect(getFirestore).toHaveBeenCalled();
  });
});
