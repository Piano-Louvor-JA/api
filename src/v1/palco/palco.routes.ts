import { randomBytes } from "node:crypto";
import type { NodeWebSocket } from "@hono/node-ws";
import { OpenAPIHono } from "@hono/zod-openapi";
import { zodErrorHook } from "../../lib/zodErrorHook.js";
import {
  createRoom,
  getRoom,
  getRoomToken,
  joinRoom,
  leaveRoom,
  MAX_MSG_BYTES,
  type PalcoRole,
  type RelayClient,
  relayStats,
  routeMessage,
} from "./relay.js";

export const palcoRoutes = new OpenAPIHono({ defaultHook: zodErrorHook });

let palcoWsRef: NodeWebSocket | null = null;

/** Registra o helper (chamado por createApp) */
export function setPalcoWs(ws: NodeWebSocket): void {
  palcoWsRef = ws;
}

/** Bootstrap: injectWebSocket no servidor HTTP (index.ts / testes) */
export function getPalcoWs(): NodeWebSocket {
  if (!palcoWsRef) throw new Error("palcoWs não inicializado");
  return palcoWsRef;
}

/**
 * Bootstrap do WebSocket (@hono/node-ws).
 *
 * IMPORTANTE: o helper.upgradeWebSocket DEVE estar registrado no MESMO app
 * raiz que roteia (app.ts faz `app.get('/v1/palco/relay/:code', ...)`) —
 * se registrar num sub-app e o helper apontar para o sub-app, o upgrade
 * retorna 404/200 sem handshake. Padrão validado em wsdbg.
 */
export function registerPalcoWs(
  app: OpenAPIHono,
  wsHelper: NodeWebSocket,
): void {
  app.get(
    "/v1/palco/relay/:code",
    wsHelper.upgradeWebSocket((c) => {
      const rawCode: string | undefined = c.req.param("code");
      const code = String(rawCode ?? "").toUpperCase();
      const token = c.req.query("token") ?? "";
      const role = c.req.query("role") as PalcoRole;
      const state: {
        client: RelayClient | null;
        room: ReturnType<typeof getRoom>;
      } = { client: null, room: null };

      return {
        onOpen: (_evt, ws) => {
          if (!["operator", "sender", "receiver"].includes(role)) {
            ws.close(4400, "role_invalida");
            return;
          }
          const room = getRoom(code, token);
          if (!room) {
            ws.close(4404, "sessao_invalida");
            return;
          }
          const client: RelayClient = {
            id: `${role}-${randomBytes(6).toString("hex")}`,
            cid: (c.req.query("cid") ?? "").slice(0, 64) || undefined,
            role,
            // WT-6A: receiver declara seu slot lógico (?slot=N) para receber
            // conteúdo direcionado (Bíblia→Monitor 1, Hino→Monitor 2).
            slot: (() => {
              const s = Number(c.req.query("slot"));
              return Number.isInteger(s) && s >= 1 && s <= 32 ? s : undefined;
            })(),
            send: (data) => ws.send(data),
          };
          const joined = joinRoom(room, client);
          if (!joined.ok) {
            ws.close(4409, joined.error ?? "join_negado");
            return;
          }
          state.client = client;
          state.room = room;
        },
        onMessage: (evt, ws) => {
          const { client, room } = state;
          if (!client || !room) return;
          const raw =
            typeof evt.data === "string"
              ? evt.data
              : Buffer.from(evt.data as ArrayBuffer).toString("utf8");
          if (raw.length > MAX_MSG_BYTES) {
            ws.send(JSON.stringify({ error: "msg_too_large" }));
            return;
          }
          // Keepalive da aplicação: responde pong sem broadcast — ping não
          // é estado e não deve chegar aos receivers (01/09).
          try {
            const parsed = JSON.parse(raw) as { type?: string };
            if (parsed.type === "ping") {
              ws.send(JSON.stringify({ v: 2, type: "pong" }));
              return;
            }
          } catch {
            // não-JSON segue o roteamento normal (que rejeita)
          }
          const targets = routeMessage(room, client, raw);
          if (targets === null) {
            ws.send(JSON.stringify({ error: "role_nao_publica" }));
            return;
          }
          for (const target of targets) target.send(raw);
        },
        onClose: () => {
          if (state.client && state.room) leaveRoom(state.room, state.client);
        },
      };
    }),
  );
}

// REST: criação da sessão (operador pede código+token para exibir QR)
palcoRoutes.post("/sessions", (c) => {
  const created = createRoom();
  if (!created) return c.json({ error: "relay_indisponivel" }, 503);
  return c.json({ code: created.code, token: created.token }, 201);
});

// Receiver browser informa apenas o código; token HMAC nunca vai para a TV.
palcoRoutes.get("/sessions/:code/token", (c) => {
  const token = getRoomToken(c.req.param("code"));
  if (!token) return c.json({ error: "sessao_nao_encontrada" }, 404);
  return c.json({ token });
});

// Introspecção (debug/admin)
palcoRoutes.get("/stats", (c) => c.json(relayStats()));
