/**
 * Seed idempotente do domínio Membro — SPEC comunidade-organica v1.0.0 §4.
 *
 * Migra para Firestore `members` (tenant pianolouvorja):
 *  - Jeydson  → roles:[tester], status aprovado (já aprovado na sheet)
 *  - Felipe Nascimento Santos → roles:[dev], aprovado (decisão SPEC/AC6)
 *  - Lucas da Silva Vieira    → roles:[dev], aprovado (decisão SPEC/AC6)
 *  - Equipe fundadora (team.ts) → roles com staff, aprovados
 *
 * Idempotente: upsert por (tenant,email) sem rebaixar status/roles existentes.
 * NUNCA atribui gm por inferência — gm:true só via PATCH admin explícito.
 *
 * Uso (server-side, com FIREBASE_SERVICE_ACCOUNT no env):
 *   npx tsx scripts/seed-members.ts
 */
import { cert, getApps, initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { createHash } from "node:crypto";

type SeedMember = {
  email: string;
  name: string;
  roles: string[];
  status: "aprovado" | "pendente";
  avatar_url: string | null;
  github: string | null;
};

// Fonte: decisão do mantenedor registrada na SPEC §3 (migração). Dados
// públicos já declarados no site (sheet gviz e app/data/team.ts).
const SEED: SeedMember[] = [
  {
    email: "garciajeydson@gmail.com",
    name: "Jeydson",
    roles: ["tester"],
    status: "aprovado",
    avatar_url: null,
    github: null,
  },
  {
    email: "fn0501925@gmail.com",
    name: "Felipe Nascimento Santos",
    roles: ["dev"],
    status: "aprovado",
    avatar_url: null,
    github: "Lipesantos658",
  },
  {
    email: "lucassilvavieira2102@gmail.com",
    name: "Lucas da Silva Vieira",
    roles: ["dev"],
    status: "aprovado",
    avatar_url: null,
    github: "venatornocte",
  },
  {
    email: "ezequiasfonseca@gmail.com",
    name: "Ezequias Fonseca",
    roles: ["staff"],
    status: "aprovado",
    avatar_url: "https://github.com/ezequiasfonseca.png?size=96",
    github: "ezequiasfonseca",
  },
  {
    email: "rafael.zendron22@gmail.com",
    name: "Rafael Dias Zendron",
    roles: ["dev", "staff"],
    status: "aprovado",
    avatar_url: "https://github.com/rafaumeu.png?size=96",
    github: "rafaumeu",
  },
  {
    email: "rafaelji@hotmail.com",
    name: "Rafael Barbosa Silva",
    roles: ["staff"],
    status: "aprovado",
    avatar_url: "https://github.com/rafaelji.png?size=96",
    github: "rafaelji",
  },
  {
    email: "educharquero@gmail.com",
    name: "Eduardo Charquero",
    roles: ["staff"],
    status: "aprovado",
    avatar_url: "https://github.com/educharquero.png?size=96",
    github: "educharquero",
  },
  {
    email: "vbfoz@gmail.com",
    name: "Vilmar Catafesta",
    roles: ["staff"],
    status: "aprovado",
    avatar_url: null,
    github: "vbfoz",
  },
  {
    email: "elomarmoreira@gmail.com",
    name: "Elomar",
    roles: ["staff"],
    status: "aprovado",
    avatar_url: "https://github.com/elomarXa.png?size=96",
    github: "elomarXa",
  },
];

const TENANT = "pianolouvorja";

function memberIdFor(tenantId: string, email: string): string {
  return createHash("sha256")
    .update(`${tenantId}\0${email.trim().toLowerCase()}`)
    .digest("hex");
}

async function main() {
  const serviceAccount = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!serviceAccount) {
    console.error(
      "FIREBASE_SERVICE_ACCOUNT ausente — abortando (nunca rodar sem credencial).",
    );
    process.exit(1);
  }
  const sa =
    typeof serviceAccount === "string" && serviceAccount.trim().startsWith("{")
      ? JSON.parse(serviceAccount)
      : JSON.parse(
          Buffer.from(serviceAccount, "base64").toString("utf8"),
        );
  if (getApps().length === 0) {
    initializeApp({ credential: cert(sa) });
  }
  const db = getFirestore();
  let created = 0;
  let preserved = 0;
  for (const member of SEED) {
    const id = memberIdFor(TENANT, member.email);
    const ref = db.collection("members").doc(id);
    const existing = await ref.get();
    if (existing.exists) {
      // Idempotência: preserva roles/status/gm já definidos por admin.
      preserved += 1;
      console.log(`SKIP (existe) ${member.email}`);
      continue;
    }
    await ref.set({
      tenant_id: TENANT,
      email: member.email.trim().toLowerCase(),
      name: member.name,
      avatar_url: member.avatar_url,
      bio: null,
      github: member.github,
      since: new Date(),
      roles: member.roles,
      status: member.status,
      gm: false,
      created_at: new Date(),
      updated_at: new Date(),
    });
    created += 1;
    console.log(`SEED ${member.email} → ${member.roles.join("+")}`);
  }
  console.log(`\nFIM: ${created} criados, ${preserved} preservados. Nenhum gm atribuído.`);
}

main().catch((error) => {
  console.error("ERRO:", error);
  process.exit(1);
});
