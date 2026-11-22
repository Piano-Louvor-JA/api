/**
 * P1 do reviewer (comentário #170): paginação cursor-based do admin list.
 * 55 registros, limit 50 → página 1 (50 + next_cursor), página 2 (5,
 * next_cursor null), sem duplicação nem salto; ordem determinística por
 * doc-id; cursor inválido não explode.
 */

import type { MiddlewareHandler } from "hono";
import { Hono } from "hono";
import { beforeEach, describe, expect, it } from "vitest";
import { gmAuth } from "../../src/v1/custom/gm.middleware.js";
import {
  membersRoutes,
  setMembersRoutesFirestoreForTests,
} from "../../src/v1/custom/members.routes.js";
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

describe("GET /admin/members — paginação por cursor", () => {
  let app: Hono;
  let docs: Map<string, DocData>;

  beforeEach(() => {
    const fake = fakeFirestore();
    docs = docsOf(fake);
    setMembersRoutesFirestoreForTests(fake as never);
    process.env.ADMIN_EMAILS = "gm@t.com"; // fallback autoriza o stub
    const h = new Hono();
    h.use("*", stubFirebaseAuth);
    h.use("*", gmAuth as MiddlewareHandler);
    h.route("/v1/custom", membersRoutes);
    app = h;
  });

  it("55 registros, limit 50: duas páginas completas sem duplicação/salto", async () => {
    for (let i = 0; i < 55; i++) {
      const email = `p${String(i).padStart(2, "0")}@t.com`;
      docs.set(`id-${String(i).padStart(3, "0")}`, {
        tenant_id: "pianolouvorja",
        email,
        name: `Membro ${i}`,
        avatar_url: null,
        bio: null,
        github: null,
        roles: ["dev"],
        status: "aprovado",
        gm: false,
        created_at: 0,
        updated_at: 0,
      });
    }

    const page1 = await app.request(
      "/v1/custom/admin/members?limit=50&cursor=",
      { headers: { "x-tenant": "pianolouvorja" } },
    );
    expect(page1.status).toBe(200);
    const b1 = (await page1.json()) as {
      data: { id: string }[];
      next_cursor: string | null;
    };
    expect(b1.data).toHaveLength(50);
    expect(b1.next_cursor).toBeTruthy();

    const page2 = await app.request(
      `/v1/custom/admin/members?limit=50&cursor=${encodeURIComponent(b1.next_cursor!)}`,
      { headers: { "x-tenant": "pianolouvorja" } },
    );
    expect(page2.status).toBe(200);
    const b2 = (await page2.json()) as {
      data: { id: string }[];
      next_cursor: string | null;
    };
    expect(b2.data).toHaveLength(5);
    expect(b2.next_cursor).toBeNull();

    const ids = [...b1.data, ...b2.data].map((m) => m.id);
    expect(new Set(ids).size).toBe(55); // sem duplicação
    expect(ids).toHaveLength(55); // sem salto
    const sorted = [...ids].sort();
    expect(ids).toEqual(sorted); // ordem determinística por doc-id
  });

  it("cursor inválido (não-base64/id inexistente) não explode — 200 ou 400 controlado", async () => {
    const res = await app.request(
      "/v1/custom/admin/members?limit=5&cursor=%%%",
      { headers: { "x-tenant": "pianolouvorja" } },
    );
    expect([200, 400]).toContain(res.status);
  });
});
