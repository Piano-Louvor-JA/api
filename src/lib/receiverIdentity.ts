import { readFileSync } from "node:fs";
import { APP_VERSION } from "./version.js";

/** Identificador público do receiver web servido pela API; nunca é chave de usuário. */
export function receiverIdentityScript(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const valid = (value: string | undefined): string => {
    const key = (value ?? "").trim();
    return /^plj_[A-Za-z0-9_-]+$/.test(key) ? key : "";
  };
  const config = JSON.stringify({
    staging: valid(env.PALCO_PARTNER_KEY_STG),
    production: valid(env.PALCO_PARTNER_KEY_PROD),
    version: APP_VERSION,
  }).replace(/</g, "\\u003c");
  return `window.__PALCO_CLIENT_IDENTITY__=${config};\n${readFileSync("static/palco/client-identity.js", "utf8")}`;
}
