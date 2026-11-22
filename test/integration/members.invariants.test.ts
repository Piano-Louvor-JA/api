/**
 * P1-B do reviewer (#170): invariantes de domínio POST/PATCH.
 * - POST com roles duplicadas → grava dedupe.
 * - POST status=aprovado com roles: [] → 422.
 * - PATCH que deixa aprovado sem roles → 422.
 * - PATCH com roles duplicadas → dedupe no doc final.
 *
 * Autenticação: stub Firebase + ADMIN_EMAILS (fallback transitório do gate GM).
 */

import type { MiddlewareHandler } from "hono";
import { Hono } from "hono";
import { beforeEach, describe, expect, it } from "vitest";
import {
  membersRoutes,
  setMembersRoutesFirestoreForTests,
} from "../../src/v1/custom/members.routes.js";
import { memberIdFor } from "../../src/v1/custom/members.service.js";
import { fakeFirestore } from "./members.routes.test.js";

const stubFirebaseAuth: MiddlewareHandler = async (c, next) => {
  c.set("user", { id_user: 1, email: "gm@t.com" });
  await next();
};

function buildApp(): { app: Hono; docs: Map<string, Record<string, unknown>> } {
  const fake = fakeFirestore();
  setMembersRoutesFirestoreForTests(fake as never);
  const h = new Hono();
  h.use("*", stubFirebaseAuth);
  h.route("/v1/custom", membersRoutes);
  return {
    app: h,
    docs: (fake as unknown as { docs: Map<string, Record<string, unknown>> })
      .docs,
  };
}

const HDR = { "content-type": "application/json", "x-tenant": "pianolouvorja" };

describe("invariantes de domínio — POST/PATCH members", () => {
  beforeEach(() => {
    process.env.ADMIN_EMAILS = "gm@t.com";
  });

  it("POST com roles duplicadas grava dedupe (documento final)", async () => {
    const { app, docs } = buildApp();
    const res = await app.request("/v1/custom/admin/members", {
      method: "POST",
      headers: HDR,
      body: JSON.stringify({
        email: "dup@t.com",
        name: "Dup",
        roles: ["dev", "dev", "tester", "dev"],
        status: "pendente",
      }),
    });
    expect(res.status).toBe(201);
    const doc = docs.get(memberIdFor("pianolouvorja", "dup@t.com"));
    expect(doc?.roles).toEqual(["dev", "tester"]);
  });

  it("POST aprovado com roles vazias → 422 e nada gravado", async () => {
    const { app, docs } = buildApp();
    const res = await app.request("/v1/custom/admin/members", {
      method: "POST",
      headers: HDR,
      body: JSON.stringify({
        email: "vazio@t.com",
        name: "Vazio",
        roles: [],
        status: "aprovado",
      }),
    });
    expect(res.status).toBe(422);
    expect(docs.size).toBe(0);
  });

  it("PATCH para aprovado com roles vazias → 422 (doc preservado)", async () => {
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
    const res = await app.request(`/v1/custom/admin/members/${id}`, {
      method: "PATCH",
      headers: HDR,
      body: JSON.stringify({ status: "aprovado", roles: [] }),
    });
    expect(res.status).toBe(422);
    expect(docs.get(id)?.status).toBe("pendente");
  });

  it("PATCH com roles duplicadas grava dedupe no doc final", async () => {
    const { app, docs } = buildApp();
    const id = memberIdFor("pianolouvorja", "patch@t.com");
    docs.set(id, {
      tenant_id: "pianolouvorja",
      email: "patch@t.com",
      name: "Patch",
      avatar_url: null,
      bio: null,
      github: null,
      roles: ["tester"],
      status: "aprovado",
      gm: false,
    });
    const res = await app.request(`/v1/custom/admin/members/${id}`, {
      method: "PATCH",
      headers: HDR,
      body: JSON.stringify({ roles: ["dev", "dev", "curador"] }),
    });
    expect(res.status).toBe(200);
    expect(docs.get(id)?.roles).toEqual(["dev", "curador"]);
  });
});
