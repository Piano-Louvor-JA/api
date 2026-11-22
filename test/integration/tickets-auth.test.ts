// B1 Slice 2 — Firebase ID token → UID/membership/RBAC + isolamento tenant
process.env.TICKETS_AUTH_TEST_MODE = "1"; // tokens "uid:<uid>" somente em teste

import { beforeEach, describe, expect, it } from "vitest";
import { closeDb, getDb, initDb } from "../../src/db/connection.js";
import {
  resolveTicketsAuth,
  type TicketsAuth,
} from "../../src/v1/tickets/tickets.auth.js";

function seedMembership(
  uid: string,
  tenantId: string,
  role: "member" | "agent" | "admin" | "global_operator",
) {
  getDb()
    .prepare(
      "INSERT INTO tenant_memberships (tenant_id, principal_id, role) VALUES (?, ?, ?)",
    )
    .run(tenantId, uid, role);
}

describe("tickets auth — resolução de identidade e RBAC", () => {
  beforeEach(() => {
    closeDb();
    process.env.DB_PATH = ":memory:";
    initDb();
    getDb()
      .prepare("INSERT INTO tenants (id, name) VALUES ('a', 'Tenant A')")
      .run();
  });

  it("token inválido → 401 sem detalhes internos", async () => {
    const err = await resolveTicketsAuth("token-invalido").catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error & { status?: number }).status).toBe(401);
  });

  it("UID sem membership → 403 (sem revelar tenants)", async () => {
    const err = await resolveTicketsAuth("uid:sem-membership").catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error & { status?: number }).status).toBe(403);
  });

  it("UID com membership resolve tenant, papel e escopo", async () => {
    seedMembership("uid-1", "a", "admin");
    const auth: TicketsAuth = await resolveTicketsAuth("uid:uid-1");
    expect(auth.uid).toBe("uid-1");
    expect(auth.tenantId).toBe("a");
    expect(auth.role).toBe("admin");
  });

  it("global_operator possui papel global sem tenant fixo", async () => {
    seedMembership("uid-g", "a", "global_operator");
    const auth = await resolveTicketsAuth("uid:uid-g");
    expect(auth.role).toBe("global_operator");
    expect(auth.globalOperator).toBe(true);
  });

  it("membership suspensa → 403", async () => {
    getDb()
      .prepare(
        "INSERT INTO tenant_memberships (tenant_id, principal_id, role, status) VALUES ('a', 'uid-s', 'member', 'suspended')",
      )
      .run();
    const err = await resolveTicketsAuth("uid:uid-s").catch((e) => e);
    expect((err as Error & { status?: number }).status).toBe(403);
  });

  it("tenant suspenso → 403", async () => {
    getDb()
      .prepare(
        "INSERT INTO tenants (id, name, status) VALUES ('susp', 'S', 'suspended')",
      )
      .run();
    seedMembership("uid-t", "susp", "admin");
    const err = await resolveTicketsAuth("uid:uid-t").catch((e) => e);
    expect((err as Error & { status?: number }).status).toBe(403);
  });
});
