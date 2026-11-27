/**
 * SPEC admin-membros v1.0.0 — T4 CLI backfill idempotente.
 * Varre auth.listUsers() (páginas de 1000) e faz upsert por uid em
 * community_members (nunca escreve role/status; docs sheet_* intocados —
 * doc id = uid Firebase nunca colide com sheet_<hash>).
 *
 * Produção (container, com FIREBASE_SERVICE_ACCOUNT):
 *   node dist/cli/community-backfill.js [--dry-run] [--emails]
 * Dev: npm run community-backfill
 */
import { pathToFileURL } from "node:url";

import { getFirebaseApp } from "../v1/custom/firebase-auth.middleware.js";
import {
  setCommunityMemberFirestoreForTests,
  upsertCommunityMember,
} from "../v1/custom/community-mirror.service.js";

const USAGE =
  "Uso: community-backfill [--dry-run] [--emails]  # espelho Auth→community_members";

type AuthUser = {
  uid: string;
  email?: string;
  displayName?: string;
};

/** Executa o backfill. Exit code. */
export async function run(
  argv: string[],
  out: (line: string) => void,
): Promise<number> {
  const dryRun = argv.includes("--dry-run");
  const withEmails = argv.includes("--emails");

  const app = await getFirebaseApp();
  const { getAuth } = await import("firebase-admin/auth");
  const auth = getAuth(app);

  let pages = 0;
  let created = 0;
  let updated = 0;
  let unchanged = 0;
  let listed = 0;
  let pageToken: string | undefined;

  do {
    const page = await auth.listUsers(1000, pageToken);
    pages++;
    for (const u of page.users as AuthUser[]) {
      listed++;
      const email = u.email ?? `${u.uid}@firebase.local`;
      const name = u.displayName ?? email.split("@")[0];
      const label = withEmails ? `${u.uid} ${email}` : u.uid;
      if (dryRun) {
        out(`dry-run ${label}`);
        continue;
      }
      const result = await upsertCommunityMember({ uid: u.uid, email, name });
      if (result === "created") created++;
      else if (result === "updated") updated++;
      else unchanged++;
      out(`${result === "created" ? "+" : result === "updated" ? "~" : "="} ${label}`);
    }
    pageToken = page.pageToken;
  } while (pageToken);

  out(
    `\nBackfill concluído: users=${listed} created=${created} updated=${updated} unchanged=${unchanged} pages=${pages}${dryRun ? " (dry-run)" : ""}`,
  );
  out("(output sem email por padrão — não colar em log público)");
  return 0;
}

/** Export de teste: evita inicializar app/firebase no import. */
export const __testHooks = { setCommunityMemberFirestoreForTests };

/* istanbul ignore if -- entrypoint do processo; lógica coberta via run() */
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const code = await run(
    process.argv.slice(2),
    (line: string) => console.log(line),
  );
  process.exit(code);
}

export { USAGE };
