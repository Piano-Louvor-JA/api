/**
 * P0-B do reviewer (comentário #170): gate GM — testes adversariais.
 * Cenários exigidos: 401, 403, GM true, fallback ADMIN_EMAILS, Firestore
 * falho (fail-closed) e cross-tenant.
 */

import type { MiddlewareHandler } from "hono";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { gmAuth } from "../../src/v1/custom/gm.middleware.js";
import {
  memberIdFor,
  setMembersFirestoreForTests,
} from "../../src/v1/custom/members.service.js";

/** Seed no ID determinístico que o serviço procura: sha256(tenant\0email). */
function gmSeed(
  docs: Map<string, DocData>,
  opts: { tenant: string; email: string; roles?: string[]; gm?: boolean },
) {
  seedMember(docs, { id: memberIdFor(opts.tenant, opts.email), ...opts });
}

import { fakeFirestore, seedMember } from "./members.routes.test.js";

type DocData = Record<string, unknown>;

function withUser(email: string): Record<string, string> {
  // firebaseAuth já rodou antes do gmAuth na cadeia real; aqui simulamos a
  // sessão populada injetando o header que o middleware de teste consome via
  // c.set — na prática, chamamos o gmAuth depois de um stub que popula user.
  return { "x-test-user-email": email };
}

/** Stub que popula c.get("user") como o firebaseAuth faria. */
const stubFirebaseAuth: MiddlewareHandler = async (c, next) => {
  const email = c.req.header("x-test-user-email");
  if (email) {
    c.set("user", { id_user: 1, email });
  }
  await next();
};

function buildChainedApp(): {
  app: Hono;
  docs: Map<string, DocData>;
} {
  const fake = fakeFirestore();
  setMembersFirestoreForTests(fake as never);
  const app = new Hono();
  app.use("*", stubFirebaseAuth);
  app.use("*", gmAuth as MiddlewareHandler);
  app.get("/ok", (c) => c.json({ ok: true }));
  return { app, docs: (fake as { docs: Map<string, DocData> }).docs };
}

describe("gmAuth — gate GM das rotas admin/members", () => {
  beforeEach(() => {
    process.env.ADMIN_EMAILS = "";
  });
  afterEach(() => {
    setMembersFirestoreForTests(null);
  });

  it("401 sem sessão (fail-closed)", async () => {
    const { app } = buildChainedApp();
    const res = await app.request("/ok");
    expect(res.status).toBe(401);
  });

  it("403 para usuário autenticado sem gm e fora do fallback", async () => {
    const { app, docs } = buildChainedApp();
    gmSeed(docs, {
      tenant: "pianolouvorja",
      email: "plain@t.com",
      roles: ["dev"],
      gm: false,
    });
    const res = await app.request("/ok", {
      headers: { ...withUser("plain@t.com"), "x-tenant": "pianolouvorja" },
    });
    expect(res.status).toBe(403);
  });

  it("200 para gm:true no tenant correto", async () => {
    const { app, docs } = buildChainedApp();
    gmSeed(docs, {
      tenant: "pianolouvorja",
      email: "boss@t.com",
      roles: ["dev"],
      gm: true,
    });
    const res = await app.request("/ok", {
      headers: { ...withUser("BOSS@t.com"), "x-tenant": "pianolouvorja" },
    });
    expect(res.status).toBe(200);
  });

  it("fallback transitório: ADMIN_EMAILS autoriza quando não há doc gm", async () => {
    const { app } = buildChainedApp();
    process.env.ADMIN_EMAILS = "legacy@t.com";
    const res = await app.request("/ok", {
      headers: { ...withUser("Legacy@T.com"), "x-tenant": "pianolouvorja" },
    });
    expect(res.status).toBe(200);
  });

  it("fail-closed absoluto: Firestore quebrado → 403 mesmo com ADMIN_EMAILS", async () => {
    const broken = {
      collection() {
        return {
          doc() {
            return {
              async get(): Promise<never> {
                throw new Error("firestore down");
              },
            };
          },
        };
      },
    };
    setMembersFirestoreForTests(broken as never);
    const app = new Hono();
    app.use("*", stubFirebaseAuth);
    app.use("*", gmAuth as MiddlewareHandler);
    app.get("/ok", (c) => c.json({ ok: true }));

    // Firestore indisponível: resposta INDETERMINADA → 403 SEMPRE,
    // mesmo com ADMIN_EMAILS (fail-closed absoluto, PLAN §2.4/§7).
    process.env.ADMIN_EMAILS = "";
    const denied = await app.request("/ok", {
      headers: { ...withUser("x@t.com"), "x-tenant": "pianolouvorja" },
    });
    expect(denied.status).toBe(403);

    process.env.ADMIN_EMAILS = "x@t.com";
    const deniedComFallback = await app.request("/ok", {
      headers: { ...withUser("x@t.com"), "x-tenant": "pianolouvorja" },
    });
    expect(deniedComFallback.status).toBe(403);
  });

  it("cross-tenant: gm:true em outro tenant não autoriza aqui", async () => {
    const { app, docs } = buildChainedApp();
    gmSeed(docs, {
      tenant: "outro",
      email: "cross@t.com",
      roles: ["dev"],
      gm: true,
    });
    const res = await app.request("/ok", {
      headers: { ...withUser("cross@t.com"), "x-tenant": "pianolouvorja" },
    });
    expect(res.status).toBe(403);
  });

  it("tenant inválido → 400 antes do lookup", async () => {
    const { app } = buildChainedApp();
    const res = await app.request("/ok", {
      headers: { ...withUser("boss@t.com"), "x-tenant": "guitarra" },
    });
    expect(res.status).toBe(400);
  });
});
