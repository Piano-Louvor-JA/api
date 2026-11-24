import { beforeEach, describe, expect, it, vi } from "vitest";

// RF: SPEC/PLAN comunidade-organica v1.0.0 — domínio Membro (Firestore members)
// BARRA: identidade (tenant,email) única; roles multi; gm separado de staff;
// DTO público sem PII; queries tenant-scoped; erro uniforme cross-tenant.

type MemberDoc = {
  tenant_id: string;
  email: string;
  name: string;
  avatar_url: string | null;
  bio: string | null;
  github: string | null;
  since: unknown;
  roles: string[];
  status: string;
  gm: boolean;
  created_at?: unknown;
  updated_at?: unknown;
};

/** Fake Firestore em memória — coleção members com query por tenant/status/role. */
function fakeFirestore() {
  const docs = new Map<string, MemberDoc>();
  return {
    docs,
    collection(_name: string) {
      return {
        doc(id: string) {
          return {
            async get() {
              const d = docs.get(id);
              return { exists: !!d, data: () => d, id };
            },
            async set(data: MemberDoc) {
              docs.set(id, data);
            },
          };
        },
        async add(data: MemberDoc) {
          const id = `auto-${docs.size + 1}`;
          docs.set(id, data);
          return { id };
        },
        where(field: string, _op: string, value: unknown) {
          const chain = {
            where(f2: string, _o2: string, v2: unknown) {
              return {
                async get() {
                  const out = [...docs.entries()]
                    .filter(
                      ([, d]) =>
                        (d as unknown as Record<string, unknown>)[field] ===
                          value &&
                        (d as unknown as Record<string, unknown>)[f2] === v2,
                    )
                    .map(([id, d]) => ({ id, data: () => d }));
                  return { docs: out, empty: out.length === 0 };
                },
              };
            },
            async get() {
              const out = [...docs.entries()]
                .filter(
                  ([, d]) =>
                    (d as unknown as Record<string, unknown>)[field] === value,
                )
                .map(([id, d]) => ({ id, data: () => d }));
              return { docs: out, empty: out.length === 0 };
            },
          };
          return chain;
        },
      };
    },
  };
}

const setMembersFirestore = vi.hoisted(() => ({ fn: null as unknown }));

// import dinâmico para injetar override após carregar módulo
async function loadModule() {
  const mod = await import("../../src/v1/custom/members.service.js");
  return mod;
}

describe("members.service — identidade e DTO", () => {
  beforeEach(() => {
    setMembersFirestore.fn = null;
    vi.resetModules();
  });

  it("memberIdFor: deriva id determinístico de (tenant,email) com email normalizado", async () => {
    const mod = await loadModule();
    const a = mod.memberIdFor("pianolouvorja", "  Fulano@Example.COM ");
    const b = mod.memberIdFor("pianolouvorja", "fulano@example.com");
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    // tenant diferente → id diferente
    expect(mod.memberIdFor("outro", "fulano@example.com")).not.toBe(a);
  });

  it("publicMember: NUNCA expõe email/gm/status/timestamps", async () => {
    const mod = await loadModule();
    const pub = mod.toPublicMember({
      id: "x",
      tenant_id: "pianolouvorja",
      email: "a@b.c",
      name: "Ana",
      avatar_url: null,
      bio: "bio",
      github: "ana",
      since: { seconds: 1 },
      roles: ["dev", "staff"],
      status: "aprovado",
      gm: true,
    });
    const keys = Object.keys(pub).sort();
    expect(keys).toEqual([
      "avatar_url",
      "bio",
      "github",
      "id",
      "name",
      "roles",
      "since",
    ]);
    expect(JSON.stringify(pub)).not.toContain("a@b.c");
    expect((pub as Record<string, unknown>).gm).toBeUndefined();
    expect((pub as Record<string, unknown>).status).toBeUndefined();
  });

  it("normalizeEmail: trim + lowercase", async () => {
    const mod = await loadModule();
    expect(mod.normalizeEmail("  X@Y.COM ")).toBe("x@y.com");
  });
});

describe("members.service — queries tenant-scoped (estrutural)", () => {
  it("rosterRepository sempre filtra tenant_id + status aprovado", async () => {
    const ff = fakeFirestore();
    // seed 2 tenants
    const mk = (over: Partial<MemberDoc>): MemberDoc => ({
      tenant_id: "pianolouvorja",
      email: "x@y.com",
      name: "X",
      avatar_url: null,
      bio: null,
      github: null,
      since: 1,
      roles: ["dev"],
      status: "aprovado",
      gm: false,
      ...over,
    });
    ff.docs.set(
      "a1",
      mk({ email: "dev1@t.com", name: "Dev Um", roles: ["dev"] }),
    );
    ff.docs.set(
      "a2",
      mk({
        tenant_id: "outro",
        email: "dev2@t.com",
        name: "Dev Outro",
        roles: ["dev"],
      }),
    );
    ff.docs.set(
      "a3",
      mk({ email: "dev3@t.com", name: "Pendente", status: "pendente" }),
    );
    setMembersFirestore.fn = () => ff;
    const mod = await loadModule();
    mod.setMembersFirestoreForTests(ff as never);
    const roster = await mod.listRoster("pianolouvorja", "dev");
    const names = roster.map((m: { name: string }) => m.name);
    expect(names).toContain("Dev Um");
    expect(names).not.toContain("Dev Outro"); // cross-tenant não vaza
    expect(names).not.toContain("Pendente"); // só aprovado
    // DTO sem PII
    expect(JSON.stringify(roster)).not.toContain("@t.com");
  });
});

describe("members.service — memberFromDoc / getDb / sort", () => {
  it("listRoster ignora docs malformados e ordena por nome", async () => {
    const ff = fakeFirestore();
    ff.docs.set("bad", {
      tenant_id: "pianolouvorja",
      // email ausente → memberFromDoc retorna null
      name: "Zzz",
      avatar_url: null,
      bio: null,
      github: null,
      since: 1,
      roles: ["dev"],
      status: "aprovado",
      gm: false,
    } as MemberDoc);
    ff.docs.set("ok-b", {
      tenant_id: "pianolouvorja",
      email: "b@t.com",
      name: "Bruno",
      avatar_url: null,
      bio: null,
      github: null,
      since: 1,
      roles: ["dev"],
      status: "aprovado",
      gm: false,
    });
    ff.docs.set("ok-a", {
      tenant_id: "pianolouvorja",
      email: "a@t.com",
      name: "Ana",
      avatar_url: null,
      bio: null,
      github: null,
      since: 1,
      roles: ["dev"],
      status: "aprovado",
      gm: false,
    });
    // doc.data() null → memberFromDoc early-return
    const baseCollection = ff.collection("members");
    ff.collection = ((_name: string) => ({
      ...baseCollection,
      where(field: string, op: string, value: unknown) {
        const inner = baseCollection.where(field, op, value);
        return {
          where(f2: string, o2: string, v2: unknown) {
            return {
              async get() {
                const snap = await inner.where(f2, o2, v2).get();
                return {
                  docs: [
                    ...snap.docs,
                    { id: "nullish", data: () => null },
                    { id: "prim", data: () => "x" },
                  ],
                };
              },
            };
          },
        };
      },
    })) as typeof ff.collection;

    const mod = await loadModule();
    mod.setMembersFirestoreForTests(ff as never);
    const roster = await mod.listRoster("pianolouvorja", "dev");
    expect(roster.map((m: { name: string }) => m.name)).toEqual([
      "Ana",
      "Bruno",
    ]);
  });

  it("getMemberByEmail: doc de outro tenant_id no id → null", async () => {
    const { createHash } = await import("node:crypto");
    const ff = fakeFirestore();
    const id = createHash("sha256")
      .update("pianolouvorja\0cross@t.com")
      .digest("hex");
    ff.docs.set(id, {
      tenant_id: "outro",
      email: "cross@t.com",
      name: "Cross",
      avatar_url: null,
      bio: null,
      github: null,
      since: 1,
      roles: ["dev"],
      status: "aprovado",
      gm: false,
    });
    const mod = await loadModule();
    mod.setMembersFirestoreForTests(ff as never);
    expect(
      await mod.getMemberByEmail("pianolouvorja", "cross@t.com"),
    ).toBeNull();
  });
});
describe("members.service — gate GM", () => {
  it("isGmMember: gm=true autoriza; gm=false + ADMIN_EMAILS fallback; Firestore falho = fail-closed", async () => {
    const { createHash } = await import("node:crypto");
    const ff = fakeFirestore();
    const gmId = createHash("sha256")
      .update("pianolouvorja\0gm@t.com")
      .digest("hex");
    ff.docs.set(gmId, {
      tenant_id: "pianolouvorja",
      email: "gm@t.com",
      name: "GM",
      avatar_url: null,
      bio: null,
      github: null,
      since: 1,
      roles: ["staff"],
      status: "aprovado",
      gm: true,
    });
    const mod = await loadModule();
    mod.setMembersFirestoreForTests(ff as never);
    expect(await mod.isGmMember("pianolouvorja", "gm@t.com")).toBe(true);
    expect(await mod.isGmMember("outro", "gm@t.com")).toBe(false); // tenant certo importa
    // fallback ADMIN_EMAILS
    const prev = process.env.ADMIN_EMAILS;
    process.env.ADMIN_EMAILS = "legacy@t.com";
    expect(await mod.isGmMember("pianolouvorja", "legacy@t.com")).toBe(true);
    process.env.ADMIN_EMAILS = prev;
    // fail-closed em erro Firestore
    mod.setMembersFirestoreForTests({
      collection: () => {
        throw new Error("boom");
      },
    } as never);
    expect(await mod.isGmMember("pianolouvorja", "gm@t.com")).toBe(false);
  });
});
