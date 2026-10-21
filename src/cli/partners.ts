/**
 * Gestão de tokens de parceiro (.planning/partner-keys/SPEC.md).
 *
 * Produção (dentro do container):
 *   docker compose exec api node dist/cli/partners.js create "Liturgia Desktop"
 *   docker compose exec api node dist/cli/partners.js list
 *   docker compose exec api node dist/cli/partners.js revoke <id>
 * Dev: npm run partners -- <comando>
 */

import { pathToFileURL } from "node:url";
import { closeDb, initDb } from "../db/connection.js";
import {
  createPartner,
  listPartners,
  revokePartner,
} from "../lib/partnerKeys.js";

const USAGE = [
  "Uso:",
  '  partners create "<nome do parceiro>"',
  "  partners list",
  "  partners revoke <id>",
].join("\n");

/** Executa um comando contra o DB já inicializado. Devolve o exit code. */
export function run(argv: string[], out: (line: string) => void): number {
  const [command, ...args] = argv;

  if (command === "create" && args.join(" ").trim()) {
    const { id, name, key } = createPartner(args.join(" "));
    out(`Parceiro criado: #${id} ${name}`);
    out(`Token (guarde agora, não será mostrado de novo): ${key}`);
    return 0;
  }

  if (command === "list") {
    const partners = listPartners();
    if (partners.length === 0) out("Nenhum parceiro cadastrado.");
    for (const p of partners) {
      const status = p.active ? "ativo" : `revogado em ${p.revoked_at}`;
      out(
        `#${p.id}  ${p.name}  ${p.key_prefix}…  ${status}  criado em ${p.created_at}`,
      );
    }
    return 0;
  }

  if (command === "revoke" && args.length === 1) {
    const id = Number(args[0]);
    if (Number.isInteger(id) && id > 0 && revokePartner(id)) {
      out(`Parceiro #${id} revogado.`);
      return 0;
    }
    out(`Parceiro #${args[0]} não encontrado ou já revogado.`);
    return 1;
  }

  out(USAGE);
  return 1;
}

/* istanbul ignore if -- entrypoint do processo; a lógica é coberta via run() */
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  initDb();
  const code = run(process.argv.slice(2), (line) => console.log(line));
  closeDb();
  process.exit(code);
}
