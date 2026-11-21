import { createRoute, z } from "@hono/zod-openapi";
import { OpenAPIHono } from "@hono/zod-openapi";
import { getFirestore } from "firebase-admin/firestore";
import { adminAuth } from "./admin.middleware.js";
import { firebaseAuth } from "./firebase-auth.middleware.js";
import {
  MEMBER_ROLES,
  MEMBER_STATUSES,
  memberIdFor,
  normalizeEmail,
  toPublicMember,
  type Member,
  type MemberRole,
  type MemberStatus,
} from "./members.service.js";

export const tenantHeader = z
  .string()
  .optional()
  .openapi("X-Tenant", {
    description:
      "Tenant opcional; ausente resolve pianolouvorja. Inválido retorna 400.",
  });

const PUBLIC_TENANTS = ["pianolouvorja"] as const;

function resolveTenant(headerValue: string | undefined):
  | { ok: true; tenant: string }
  | { ok: false } {
  if (headerValue === undefined || headerValue === "") {
    return { ok: true, tenant: "pianolouvorja" };
  }
  return (PUBLIC_TENANTS as readonly string[]).includes(headerValue)
    ? { ok: true, tenant: headerValue }
    : { ok: false };
}

let firestoreOverride: ReturnType<typeof getFirestore> | null = null;

export function setMembersRoutesFirestoreForTests(
  firestore: ReturnType<typeof getFirestore> | null,
): void {
  firestoreOverride = firestore;
}

async function getDb(): Promise<ReturnType<typeof getFirestore>> {
  if (firestoreOverride) return firestoreOverride;
  return getFirestore(await import("./firebase-auth.middleware.js").then(
    (m) => m.getFirebaseApp(),
  ));
}

// ── Schemas ──
const PublicMemberSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    avatar_url: z.string().nullable(),
    bio: z.string().nullable(),
    github: z.string().nullable(),
    since: z.unknown(),
    roles: z.array(z.enum(MEMBER_ROLES)),
  })
  .openapi("PublicMember");

const AdminMemberSchema = z
  .object({
    id: z.string(),
    tenant_id: z.string(),
    email: z.string(),
    name: z.string(),
    avatar_url: z.string().nullable(),
    bio: z.string().nullable(),
    github: z.string().nullable(),
    since: z.unknown(),
    roles: z.array(z.enum(MEMBER_ROLES)),
    status: z.enum(MEMBER_STATUSES),
    gm: z.boolean(),
  })
  .openapi("AdminMember");

const RoleQuery = z.enum(MEMBER_ROLES);
const StatusQuery = z.enum(MEMBER_STATUSES);

// ── GET /v1/custom/community/roster (público) ──
const rosterRoute = createRoute({
  method: "get",
  path: "/community/roster",
  tags: ["custom"],
  request: {
    headers: z.object({ "X-Tenant": tenantHeader }),
    query: z.object({ role: RoleQuery }),
  },
  responses: {
    200: {
      content: {
        "application/json": { schema: z.object({ data: z.array(PublicMemberSchema) }) },
      },
      description: "Roster público aprovado do tenant",
    },
    400: {
      content: { "application/json": { schema: z.object({ error: z.string() }) } },
      description: "Tenant ou role inválido",
    },
  },
});

// ── GET /v1/custom/admin/members ──
const adminListRoute = createRoute({
  method: "get",
  path: "/admin/members",
  tags: ["custom"],
  request: {
    headers: z.object({ "X-Tenant": tenantHeader }),
    query: z.object({
      status: StatusQuery.optional(),
      role: RoleQuery.optional(),
      limit: z.coerce.number().int().min(1).max(100).default(50).optional(),
    }),
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z.object({ data: z.array(AdminMemberSchema) }),
        },
      },
      description: "Membros do tenant (admin)",
    },
    401: {
      content: { "application/json": { schema: z.object({ error: z.string() }) } },
      description: "Não autenticado",
    },
    403: {
      content: { "application/json": { schema: z.object({ error: z.string() }) } },
      description: "Sem permissão GM",
    },
    400: {
      content: { "application/json": { schema: z.object({ error: z.string(), valid_tenants: z.array(z.string()) }) } },
      description: "Tenant inválido",
    },
  },
});

// ── POST /v1/custom/admin/members ──
const adminCreateRoute = createRoute({
  method: "post",
  path: "/admin/members",
  tags: ["custom"],
  request: {
    headers: z.object({ "X-Tenant": tenantHeader }),
    body: {
      content: {
        "application/json": {
          schema: z.object({
            email: z.string().email(),
            name: z.string().min(2).max(120),
            avatar_url: z.string().url().nullable().optional(),
            bio: z.string().max(1000).nullable().optional(),
            github: z.string().max(120).nullable().optional(),
            roles: z.array(z.enum(MEMBER_ROLES)).optional(),
            status: z.enum(MEMBER_STATUSES).optional(),
            gm: z.boolean().optional(),
          }),
        },
      },
      required: true,
    },
  },
  responses: {
    201: {
      content: { "application/json": { schema: AdminMemberSchema } },
      description: "Criado",
    },
    400: {
      content: { "application/json": { schema: z.object({ error: z.string() }) } },
      description: "Payload/tenant inválido",
    },
    401: {
      content: { "application/json": { schema: z.object({ error: z.string() }) } },
      description: "Não autenticado",
    },
    403: {
      content: { "application/json": { schema: z.object({ error: z.string() }) } },
      description: "Sem permissão GM",
    },
    409: {
      content: { "application/json": { schema: z.object({ error: z.string() }) } },
      description: "Duplicata (tenant,email)",
    },
  },
});

// ── PATCH /v1/custom/admin/members/:memberId ──
const adminPatchRoute = createRoute({
  method: "patch",
  path: "/admin/members/:memberId",
  tags: ["custom"],
  request: {
    headers: z.object({ "X-Tenant": tenantHeader }),
    params: z.object({ memberId: z.string().min(1) }),
    body: {
      content: {
        "application/json": {
          schema: z
            .object({
              name: z.string().min(2).max(120).optional(),
              avatar_url: z.string().url().nullable().optional(),
              bio: z.string().max(1000).nullable().optional(),
              github: z.string().max(120).nullable().optional(),
              roles: z.array(z.enum(MEMBER_ROLES)).optional(),
              status: z.enum(MEMBER_STATUSES).optional(),
              gm: z.boolean().optional(),
            })
            .refine(
              (body) => Object.keys(body).length > 0,
              "Ao menos um campo mutável é obrigatório",
            ),
        },
      },
      required: true,
    },
  },
  responses: {
    200: {
      content: { "application/json": { schema: AdminMemberSchema } },
      description: "Atualizado",
    },
    404: {
      content: { "application/json": { schema: z.object({ error: z.string() }) } },
      description: "Não encontrado no tenant",
    },
    422: {
      content: { "application/json": { schema: z.object({ error: z.string() }) } },
      description: "Transição inválida (ex.: aprovado sem role)",
    },
    400: {
      content: { "application/json": { schema: z.object({ error: z.string(), valid_tenants: z.array(z.string()) }) } },
      description: "Tenant inválido",
    },
  },
});

function invalidTenantResponse(c: { json: (body: unknown, status: 400) => unknown }) {
  return c.json(
    { error: "Tenant inválido", valid_tenants: ["pianolouvorja"] as string[] },
    400,
  );
}

export const membersRoutes = new OpenAPIHono();

membersRoutes.openapi(rosterRoute, async (c) => {
  const tenant = resolveTenant(c.req.header("X-Tenant"));
  if (!tenant.ok) {
    return c.json(
      { error: "Tenant inválido", valid_tenants: [...PUBLIC_TENANTS] },
      400,
    );
  }
  const role = c.req.valid("query").role as MemberRole;
  const db = await getDb();
  const snapshot = await db
    .collection("members")
    .where("tenant_id", "==", tenant.tenant)
    .where("status", "==", "aprovado")
    .get();
  const data = snapshot.docs
    .map((doc) => {
      const row = doc.data() as Record<string, unknown>;
      const member = { ...(row as unknown as Member), id: doc.id };
      return Array.isArray(member.roles) && member.roles.includes(role)
        ? toPublicMember(member)
        : null;
    })
    .filter((m): m is ReturnType<typeof toPublicMember> => m !== null)
    .sort((a, b) => a.name.localeCompare(b.name, "pt-BR"));
  return c.json({ data }, 200);
});

membersRoutes.use("/admin/members", firebaseAuth, adminAuth);
membersRoutes.use("/admin/members/*", firebaseAuth, adminAuth);

membersRoutes.openapi(adminListRoute, async (c) => {
  const tenant = resolveTenant(c.req.header("X-Tenant"));
  if (!tenant.ok) {
    return c.json(
      { error: "Tenant inválido", valid_tenants: [...PUBLIC_TENANTS] },
      400,
    );
  }
  const { status, role } = c.req.valid("query");
  const limit = c.req.valid("query").limit ?? 50;
  const db = await getDb();
  let query = db
    .collection("members")
    .where("tenant_id", "==", tenant.tenant);
  if (status) query = query.where("status", "==", status) as typeof query;
  if (role) query = query.where("roles", "array-contains", role) as typeof query;
  const snapshot = await query.limit(limit).get();
  const data = snapshot.docs.map((doc) => ({
    id: doc.id,
    ...(doc.data() as unknown as Omit<Member, "id">),
  }));
  return c.json({ data }, 200);
});

membersRoutes.openapi(adminCreateRoute, async (c) => {
  const tenant = resolveTenant(c.req.header("X-Tenant"));
  if (!tenant.ok) {
    return c.json(
      { error: "Tenant inválido", valid_tenants: [...PUBLIC_TENANTS] },
      400,
    );
  }
  const body = c.req.valid("json");
  const email = normalizeEmail(body.email);
  const id = memberIdFor(tenant.tenant, email);
  const db = await getDb();
  const existing = await db.collection("members").doc(id).get();
  if (existing.exists) {
    return c.json({ error: "Membro já existe neste tenant" }, 409);
  }
  const now = new Date();
  const doc: Omit<Member, "id"> = {
    tenant_id: tenant.tenant,
    email,
    name: body.name,
    avatar_url: body.avatar_url ?? null,
    bio: body.bio ?? null,
    github: body.github ?? null,
    since: now,
    roles: body.roles ?? [],
    status: body.status ?? "pendente",
    gm: body.gm ?? false,
    created_at: now,
    updated_at: now,
  };
  await db.collection("members").doc(id).set(doc as never);
  return c.json({ ...doc, id }, 201);
});

membersRoutes.openapi(adminPatchRoute, async (c) => {
  const tenant = resolveTenant(c.req.header("X-Tenant"));
  if (!tenant.ok) {
    return c.json(
      { error: "Tenant inválido", valid_tenants: [...PUBLIC_TENANTS] },
      400,
    );
  }
  const { memberId } = c.req.valid("param");
  const body = c.req.valid("json");
  const db = await getDb();
  const ref = db.collection("members").doc(memberId);
  const snapshot = await ref.get();
  const existing = snapshot.exists
    ? (snapshot.data() as Record<string, unknown>)
    : null;
  // 404 uniforme: inexistente OU de outro tenant (não vaza existência)
  if (
    !existing ||
    existing.tenant_id !== tenant.tenant ||
    typeof existing.email !== "string"
  ) {
    return c.json({ error: "Membro não encontrado" }, 404);
  }
  const current = { id: snapshot.id, ...(existing as unknown as Omit<Member, "id">) };
  const nextRoles = body.roles ?? (current.roles as MemberRole[]);
  const nextStatus = body.status ?? (current.status as MemberStatus);
  if (nextStatus === "aprovado" && nextRoles.length === 0) {
    return c.json({ error: "Membro aprovado exige ao menos uma role" }, 422);
  }
  const updated: Omit<Member, "id"> = {
    ...current,
    ...body,
    roles: nextRoles,
    status: nextStatus,
    updated_at: new Date(),
  };
  await ref.set(updated as never);
  return c.json({ id: snapshot.id, ...updated }, 200);
});
