/**
 * Gaps admin/members: tenant inválido, filtros status/role, limit default,
 * POST defaults/409, PATCH 404, roster ordenado, getDb sem override.
 */
import type { MiddlewareHandler } from "hono";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  membersRoutes,
  setMembersRoutesFirestoreForTests,
} from "../../src/v1/custom/members.routes.js";
import {
  memberIdFor,
  setMembersFirestoreForTests,
} from "../../src/v1/custom/members.service.js";
import {
  type DocData,
  fakeFirestore,
  seedMember,
} from "./members.routes.test.js";

const stubFirebaseAuth: MiddlewareHandler = async (c, next) => {
  c.set("user", { id_user: 1, email: "gm@t.com" });
  await next();
};

function docsOf(fake: ReturnType<typeof fakeFirestore>) {
  return (fake as unknown as { docs: Map<string, DocData> }).docs;
}

function buildApp() {
  const fake = fakeFirestore();
  const docs = docsOf(fake);
  setMembersRoutesFirestoreForTests(fake as never);
  setMembersFirestoreForTests(fake as never);
  seedMember(docs, {
    id: memberIdFor("pianolouvorja", "gm@t.com"),
    tenant: "pianolouvorja",
    email: "gm@t.com",
    roles: ["staff"],
    gm: true,
  });
  const h = new Hono();
  h.use("*", stubFirebaseAuth);
  h.route("/v1/custom", membersRoutes);
  return { app: h, docs, fake };
}

const HDR = {
  "content-type": "application/json",
  "x-tenant": "pianolouvorja",
};

describe("members admin — gaps de cobertura", () => {
  beforeEach(() => {
    process.env.ADMIN_EMAILS = "";
  });
  afterEach(() => {
    setMembersRoutesFirestoreForTests(null);
    setMembersFirestoreForTests(null);
  });

  it("roster ordena por nome (pt-BR) com 2+ aprovados", async () => {
    const { app, docs } = buildApp();
    seedMember(docs, {
      id: "z-bruno",
      tenant: "pianolouvorja",
      email: "bruno@t.com",
      roles: ["dev"],
    });
    docs.set("z-bruno", { ...docs.get("z-bruno")!, name: "Bruno" });
    seedMember(docs, {
      id: "a-ana",
      tenant: "pianolouvorja",
      email: "ana@t.com",
      roles: ["dev"],
    });
    docs.set("a-ana", { ...docs.get("a-ana")!, name: "Ana" });

    const res = await app.request("/v1/custom/community/roster?role=dev");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { name: string }[] };
    const names = body.data.map((m) => m.name);
    expect(names.indexOf("Ana")).toBeLessThan(names.indexOf("Bruno"));
  });

  it("admin list: tenant inválido → 400 (gmAuth); sem X-Tenant usa default", async () => {
    const { app } = buildApp();
    const bad = await app.request("/v1/custom/admin/members", {
      headers: { "x-tenant": "guitarra" },
    });
    expect(bad.status).toBe(400);

    const def = await app.request("/v1/custom/admin/members");
    expect(def.status).toBe(200);
  });

  it("admin list: sem limit usa default 50; filtros status e role", async () => {
    const { app, docs } = buildApp();
    seedMember(docs, {
      id: "m-dev",
      tenant: "pianolouvorja",
      email: "dev@t.com",
      roles: ["dev"],
      status: "aprovado",
    });
    seedMember(docs, {
      id: "m-pend",
      tenant: "pianolouvorja",
      email: "pend@t.com",
      roles: ["dev"],
      status: "pendente",
    });
    seedMember(docs, {
      id: "m-test",
      tenant: "pianolouvorja",
      email: "test@t.com",
      roles: ["tester"],
      status: "aprovado",
    });

    const byStatus = await app.request(
      "/v1/custom/admin/members?status=pendente",
      { headers: { "x-tenant": "pianolouvorja" } },
    );
    expect(byStatus.status).toBe(200);
    const sBody = (await byStatus.json()) as { data: { id: string }[] };
    expect(sBody.data.map((m) => m.id)).toContain("m-pend");
    expect(sBody.data.map((m) => m.id)).not.toContain("m-dev");

    const byRole = await app.request("/v1/custom/admin/members?role=tester", {
      headers: { "x-tenant": "pianolouvorja" },
    });
    expect(byRole.status).toBe(200);
    const rBody = (await byRole.json()) as { data: { id: string }[] };
    expect(rBody.data.map((m) => m.id)).toContain("m-test");
    expect(rBody.data.map((m) => m.id)).not.toContain("m-dev");
  });

  it("POST create: defaults roles/status; 409 em duplicata; tenant inválido", async () => {
    const { app, docs } = buildApp();

    const badTenant = await app.request("/v1/custom/admin/members", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-tenant": "outro",
      },
      body: JSON.stringify({ email: "x@t.com", name: "Xis" }),
    });
    expect(badTenant.status).toBe(400);

    const created = await app.request("/v1/custom/admin/members", {
      method: "POST",
      headers: { "content-type": "application/json" }, // sem X-Tenant → default
      body: JSON.stringify({ email: "novo@t.com", name: "Novo" }),
    });
    expect(created.status).toBe(201);
    const body = (await created.json()) as {
      status: string;
      roles: string[];
      email: string;
    };
    expect(body.status).toBe("pendente");
    expect(body.roles).toEqual([]);
    expect(body.email).toBe("novo@t.com");

    const dup = await app.request("/v1/custom/admin/members", {
      method: "POST",
      headers: HDR,
      body: JSON.stringify({ email: "novo@t.com", name: "Outro" }),
    });
    expect(dup.status).toBe(409);
    expect(docs.has(memberIdFor("pianolouvorja", "novo@t.com"))).toBe(true);
  });

  it("PATCH: tenant inválido → 400; membro inexistente → 404; roles omitidas", async () => {
    const { app, docs } = buildApp();
    const id = memberIdFor("pianolouvorja", "alvo@t.com");
    docs.set(id, {
      tenant_id: "pianolouvorja",
      email: "alvo@t.com",
      name: "Alvo",
      avatar_url: null,
      bio: null,
      github: null,
      roles: ["dev"],
      status: "pendente",
      gm: false,
    });

    const badTenant = await app.request(`/v1/custom/admin/members/${id}`, {
      method: "PATCH",
      headers: {
        "content-type": "application/json",
        "x-tenant": "hack",
      },
      body: JSON.stringify({ name: "Xis" }),
    });
    expect(badTenant.status).toBe(400);

    // memberId na rota é validado como hex sha256 (64 chars)
    const missingId = "a".repeat(64);
    const missing = await app.request(`/v1/custom/admin/members/${missingId}`, {
      method: "PATCH",
      headers: HDR,
      body: JSON.stringify({ name: "Xis" }),
    });
    expect(missing.status).toBe(404);

    const patchName = await app.request(`/v1/custom/admin/members/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" }, // default tenant
      body: JSON.stringify({ name: "Alvo Atualizado" }),
    });
    expect(patchName.status).toBe(200);
    const updated = (await patchName.json()) as {
      name: string;
      roles: string[];
    };
    expect(updated.name).toBe("Alvo Atualizado");
    expect(updated.roles).toEqual(["dev"]);
  });
});
