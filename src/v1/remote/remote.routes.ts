import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";
import { z } from "@hono/zod-openapi";
import { Hono } from "hono";
import { getDb } from "../../db/connection.js";

const TTL_MS = 5 * 60 * 1000;
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

const createSchema = z.object({
  endpoint: z.string().url().startsWith("ws://"),
  token: z.string().min(8).max(128),
});

function hash(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function secretKey() {
  const value = process.env.REMOTE_SESSION_KEY;
  if (!value) throw new Error("REMOTE_SESSION_KEY ausente");
  return createHash("sha256").update(value).digest();
}

function seal(value: unknown) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", secretKey(), iv);
  const encrypted = Buffer.concat([
    cipher.update(JSON.stringify(value), "utf8"),
    cipher.final(),
  ]);
  return `${iv.toString("base64url")}.${cipher.getAuthTag().toString("base64url")}.${encrypted.toString("base64url")}`;
}

function unseal(value: string) {
  const [ivText, tagText, encryptedText] = value.split(".");
  if (!ivText || !tagText || !encryptedText)
    throw new Error("payload_invalido");
  const decipher = createDecipheriv(
    "aes-256-gcm",
    secretKey(),
    Buffer.from(ivText, "base64url"),
    { authTagLength: 16 },
  );
  decipher.setAuthTag(Buffer.from(tagText, "base64url"));
  const plain = Buffer.concat([
    decipher.update(Buffer.from(encryptedText, "base64url")),
    decipher.final(),
  ]);
  return JSON.parse(plain.toString("utf8")) as {
    endpoint: string;
    token: string;
  };
}

function makeCode() {
  const bytes = randomBytes(8);
  const raw = Array.from(bytes)
    .map((b) => CODE_ALPHABET[b % CODE_ALPHABET.length])
    .join("");
  return `${raw.slice(0, 4)}-${raw.slice(4)}`;
}

function normalizeCode(input: string) {
  return input.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

function isPrivateWsEndpoint(endpoint: string) {
  try {
    const url = new URL(endpoint);
    const host = url.hostname;
    return (
      /^192\.168\./.test(host) ||
      /^10\./.test(host) ||
      /^172\.(1[6-9]|2\d|3[0-1])\./.test(host)
    );
  } catch {
    return false;
  }
}

export const remoteRoutes = new Hono();

remoteRoutes.post("/sessions", async (c) => {
  const body = createSchema.safeParse(await c.req.json().catch(() => null));
  if (!body.success || !isPrivateWsEndpoint(body.data.endpoint)) {
    return c.json({ error: "endpoint_lan_invalido" }, 400);
  }

  const now = Date.now();
  const expiresAt = now + TTL_MS;
  const db = getDb();
  db.prepare(
    "DELETE FROM remote_sessions WHERE expires_at <= ? OR claimed_at IS NOT NULL",
  ).run(now);

  let code = makeCode();
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      db.prepare(
        "INSERT INTO remote_sessions (code_hash, payload_ciphertext, expires_at, created_at) VALUES (?, ?, ?, ?)",
      ).run(hash(normalizeCode(code)), seal(body.data), expiresAt, now);
      return c.json(
        { code, expiresAt: new Date(expiresAt).toISOString() },
        201,
      );
    } catch {
      code = makeCode();
    }
  }
  return c.json({ error: "codigo_indisponivel" }, 503);
});

remoteRoutes.post("/sessions/:code/claim", (c) => {
  const now = Date.now();
  const codeHash = hash(normalizeCode(c.req.param("code")));
  const db = getDb();
  const row = db
    .prepare(
      "SELECT payload_ciphertext, expires_at, claimed_at FROM remote_sessions WHERE code_hash = ?",
    )
    .get(codeHash) as
    | {
        payload_ciphertext: string;
        expires_at: number;
        claimed_at: number | null;
      }
    | undefined;

  if (!row) return c.json({ error: "codigo_invalido" }, 404);
  if (row.claimed_at !== null || row.expires_at <= now) {
    db.prepare("DELETE FROM remote_sessions WHERE code_hash = ?").run(codeHash);
    return c.json({ error: "codigo_expirado_ou_utilizado" }, 410);
  }

  // Claim atômico: só um browser ganha a sessão.
  const claimed = db
    .prepare(
      "UPDATE remote_sessions SET claimed_at = ? WHERE code_hash = ? AND claimed_at IS NULL AND expires_at > ?",
    )
    .run(now, codeHash, now);
  if (claimed.changes !== 1)
    return c.json({ error: "codigo_expirado_ou_utilizado" }, 410);

  try {
    return c.json(
      {
        ...unseal(row.payload_ciphertext),
        expiresAt: new Date(row.expires_at).toISOString(),
      },
      200,
    );
  } catch {
    return c.json({ error: "sessao_invalida" }, 500);
  }
});
