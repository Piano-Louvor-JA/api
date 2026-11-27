import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// SPEC admin-membros v1.0.0 — espelho Auth→community_members (T1)
// ACs: 4 (campos mínimos), 5 (never-write role/status), 8 (fail-open),
// 2 parcial (idempotência). Firestore fake injetável via
// setCommunityMemberFirestoreForTests (padrão members-service-getdb.test.ts).

vi.mock("firebase-admin/app", () => ({
  initializeApp: vi.fn(() => ({})),
  cert: vi.fn(() => ({})),
}));

import {
  setCommunityMemberFirestoreForTests,
  upsertCommunityMember,
} from "../../src/v1/custom/community-mirror.service.js";

type Doc = Record<string, unknown>;

function fakeFirestore() {
  const docs = new Map<string, Doc>();
  const ops = { writes: 0, writePaths: [] as string[] };
  const mkDoc = (path: string) => ({
    get: async () => ({ exists: docs.has(path), data: () => docs.get(path) }),
    create: async (data: Doc) => {
      if (docs.has(path))
        throw Object.assign(new Error("already exists"), { code: 6 });
      ops.writes++;
      ops.writePaths.push(path);
      docs.set(path, { ...data });
      return {};
    },
    set: async (data: Doc, opts?: { merge?: boolean }) => {
      ops.writes++;
      ops.writePaths.push(path);
      if (opts?.merge) {
        docs.set(path, { ...(docs.get(path) ?? {}), ...data });
      } else {
        docs.set(path, { ...data });
      }
      return {};
    },
  });
  const db = {
    collection: (name: string) => ({
      doc: (id: string) => mkDoc(`${name}/${id}`),
    }),
    __docs: docs,
    __ops: ops,
  };
  return db as unknown as Parameters<
    typeof setCommunityMemberFirestoreForTests
  >[0] & { __docs: Map<string, Doc>; __ops: typeof ops };
}

describe("community-mirror.service (SPEC admin-membros v1.0.0)", () => {
  let db: ReturnType<typeof fakeFirestore>;

  beforeEach(() => {
    db = fakeFirestore();
    setCommunityMemberFirestoreForTests(db);
  });

  afterEach(() => {
    setCommunityMemberFirestoreForTests(null);
  });

  it("AC4: usuário novo → cria doc com campos mínimos (role=member, status=active)", async () => {
    await upsertCommunityMember({
      uid: "uid-1",
      email: "a@b.com",
      name: "A",
    });
    const doc = db.__docs.get("community_members/uid-1");
    expect(doc).toBeDefined();
    expect(doc?.uid).toBe("uid-1");
    expect(doc?.email).toBe("a@b.com");
    expect(doc?.name).toBe("A");
    expect(doc?.role).toBe("member");
    expect(doc?.status).toBe("active");
    expect(doc?.createdAt).toEqual(expect.any(Date));
    expect(doc?.lastLoginAt).toEqual(expect.any(Date));
  });

  it("AC5: doc existente (moderator/banned) → atualiza SÓ lastLoginAt/email/name; nunca role/status", async () => {
    db.__docs.set("community_members/uid-2", {
      uid: "uid-2",
      email: "old@b.com",
      name: "Old",
      role: "moderator",
      status: "banned",
      createdAt: new Date("2020-01-01"),
      lastLoginAt: new Date("2020-01-01"),
    });
    await upsertCommunityMember({
      uid: "uid-2",
      email: "new@b.com",
      name: "New",
    });
    const doc = db.__docs.get("community_members/uid-2");
    expect(doc?.role).toBe("moderator");
    expect(doc?.status).toBe("banned");
    expect(doc?.createdAt).toEqual(new Date("2020-01-01"));
    expect(doc?.email).toBe("new@b.com");
    expect(doc?.name).toBe("New");
    expect(doc?.lastLoginAt).toEqual(expect.any(Date));
    expect((doc?.lastLoginAt as Date) > new Date("2020-01-01")).toBe(true);
  });

  it("AC5: criação concorrente preserva a moderação gravada após a leitura", async () => {
    let stored: Doc = {};
    const set = vi.fn(async (data: Doc) => {
      stored = { ...stored, ...data };
    });
    const create = vi.fn(async () => {
      stored = { role: "moderator", status: "banned" };
      throw Object.assign(new Error("already exists"), { code: 6 });
    });
    setCommunityMemberFirestoreForTests({
      collection: () => ({
        doc: () => ({
          get: async () => ({ exists: false }),
          create,
          set,
        }),
      }),
    } as unknown as Parameters<typeof setCommunityMemberFirestoreForTests>[0]);

    await upsertCommunityMember({
      uid: "concurrent",
      email: "a@b.com",
      name: "A",
    });
    expect(stored).toMatchObject({
      role: "moderator",
      status: "banned",
      email: "a@b.com",
      name: "A",
    });
    expect(set).toHaveBeenCalledWith(
      { email: "a@b.com", name: "A", lastLoginAt: expect.any(Date) },
      { merge: true },
    );
    expect(set.mock.calls[0][0]).not.toHaveProperty("role");
    expect(set.mock.calls[0][0]).not.toHaveProperty("status");
  });

  it("AC8: falha de Firestore → NÃO lança (fail-open, espelho best-effort)", async () => {
    const boom = {
      collection: () => {
        throw new Error("firestore down");
      },
    } as unknown as Parameters<typeof setCommunityMemberFirestoreForTests>[0];
    setCommunityMemberFirestoreForTests(boom);
    await expect(
      upsertCommunityMember({ uid: "uid-3", email: "c@b.com", name: "C" }),
    ).resolves.toBe("unchanged");
  });

  it("AC2 (parcial): 2× upsert = mesmo doc, sem duplicar (merge)", async () => {
    for (let i = 0; i < 2; i++) {
      await upsertCommunityMember({
        uid: "uid-4",
        email: "d@b.com",
        name: "D",
      });
    }
    expect(db.__docs.size).toBe(1);
    const doc = db.__docs.get("community_members/uid-4");
    expect(doc?.role).toBe("member");
    expect(doc?.status).toBe("active");
    expect(db.__ops.writePaths).toEqual([
      "community_members/uid-4",
      "community_members/uid-4",
    ]);
  });
});
