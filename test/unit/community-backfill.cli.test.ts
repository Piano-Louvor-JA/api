import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// SPEC admin-membros v1.0.0 T4 — CLI backfill idempotente (AC2/AC3/AC4).
// fake auth (3 users: 1 já existente, 2 novos) + fake Firestore.

vi.mock("firebase-admin/app", () => ({
  initializeApp: vi.fn(() => ({})),
  cert: vi.fn(() => ({})),
}));

const { listUsersMock } = vi.hoisted(() => ({
  listUsersMock: vi.fn(),
}));

vi.mock("firebase-admin/auth", async () => {
  const actual = await vi.importActual<typeof import("firebase-admin/auth")>(
    "firebase-admin/auth",
  );
  return { ...actual, getAuth: vi.fn(() => ({ listUsers: listUsersMock })) };
});

import { run } from "../../src/cli/community-backfill.js";
import { setCommunityMemberFirestoreForTests } from "../../src/v1/custom/community-mirror.service.js";

type Doc = Record<string, unknown>;

function fakeFirestore() {
  const docs = new Map<string, Doc>();
  const db = {
    collection: (name: string) => ({
      doc: (id: string) => ({
        create: async (data: Doc) => {
          const key = `${name}/${id}`;
          if (docs.has(key))
            throw Object.assign(new Error("already exists"), { code: 6 });
          docs.set(key, { ...data });
          return {};
        },
        get: async () => ({
          exists: docs.has(`${name}/${id}`),
          data: () => docs.get(`${name}/${id}`),
        }),
        set: async (data: Doc, opts?: { merge?: boolean }) => {
          const key = `${name}/${id}`;
          docs.set(
            key,
            opts?.merge ? { ...(docs.get(key) ?? {}), ...data } : { ...data },
          );
          return {};
        },
      }),
    }),
    __docs: docs,
  };
  return db as unknown as Parameters<
    typeof setCommunityMemberFirestoreForTests
  >[0] & { __docs: Map<string, Doc> };
}

const users = [
  { uid: "u1", email: "um@b.com", displayName: "Um" },
  { uid: "u2", email: "dois@b.com", displayName: "Dois" },
  { uid: "u3", email: "tres@b.com", displayName: "Tres" },
];

describe("CLI community-backfill (T4)", () => {
  let db: ReturnType<typeof fakeFirestore>;
  let out: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.stubEnv("FIREBASE_SERVICE_ACCOUNT", JSON.stringify({ project_id: "t" }));
    db = fakeFirestore();
    out = vi.fn();
    setCommunityMemberFirestoreForTests(db);
    listUsersMock.mockReset();
    // paginação: 1 página, nextPageToken undefined
    listUsersMock.mockResolvedValue({ users, pageToken: undefined });
  });

  afterEach(() => {
    setCommunityMemberFirestoreForTests(null);
    vi.unstubAllEnvs();
  });

  it("backfill cria 2 novos e atualiza 1 existente (AC3/AC4)", async () => {
    db.__docs.set("community_members/u1", {
      uid: "u1",
      email: "old@b.com",
      name: "Old",
      role: "member",
      status: "active",
    });
    const code = await run([], out);
    expect(code).toBe(0);
    expect(db.__docs.size).toBe(3);
    const doc = db.__docs.get("community_members/u2");
    expect(doc?.uid).toBe("u2");
    expect(doc?.role).toBe("member");
    expect(doc?.status).toBe("active");
    expect(doc?.email).toBe("dois@b.com");
    // existente atualizado, role/status preservados
    const d1 = db.__docs.get("community_members/u1");
    expect(d1?.role).toBe("member");
    expect(d1?.email).toBe("um@b.com");
  });

  it("AC2: idempotente — 2ª execução 0 created, tudo unchanged", async () => {
    await run([], out);
    out.mockClear();
    const code = await run([], out);
    expect(code).toBe(0);
    const lines = out.mock.calls.map((c) => String(c[0])).join("\n");
    expect(lines).toContain("created=0");
    expect(lines).toContain("updated=0");
    expect(db.__docs.size).toBe(3);
  });

  it("paginação: percorre múltiplas páginas (1000/página)", async () => {
    listUsersMock.mockResolvedValueOnce({ users, pageToken: "tok" });
    listUsersMock.mockResolvedValueOnce({
      users: [{ uid: "u4", email: "q@b.com", displayName: "Q" }],
      pageToken: undefined,
    });
    const code = await run([], out);
    expect(code).toBe(0);
    expect(listUsersMock).toHaveBeenCalledTimes(2);
    expect(db.__docs.size).toBe(4);
    const lines = out.mock.calls.map((c) => String(c[0])).join("\n");
    expect(lines).toContain("pages=2");
  });

  it("--dry-run: lista sem escrever", async () => {
    const code = await run(["--dry-run"], out);
    expect(code).toBe(0);
    expect(db.__docs.size).toBe(0);
    const lines = out.mock.calls.map((c) => String(c[0])).join("\n");
    expect(lines).toContain("3");
  });

  it("--emails: output inclui email; sem flag não inclui", async () => {
    await run([], out);
    const plain = out.mock.calls.map((c) => String(c[0])).join("\n");
    expect(plain).not.toContain("dois@b.com");
    out.mockClear();
    await run(["--emails"], out);
    const withEmails = out.mock.calls.map((c) => String(c[0])).join("\n");
    expect(withEmails).toContain("dois@b.com");
  });
});
