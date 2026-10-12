import type { NodeWebSocket } from "@hono/node-ws";
import type { OpenAPIHono } from "@hono/zod-openapi";
import { afterEach, expect, it, vi } from "vitest";
import {
  getPalcoWs,
  registerPalcoWs,
} from "../../src/v1/palco/palco.routes.js";
import {
  createRoom,
  getRoom,
  getRoomToken,
  MAX_MSG_BYTES,
  MAX_ROOMS,
  ROOM_TTL_MS,
  routeMessage,
} from "../../src/v1/palco/relay.js";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});
function handlers(params: Record<string, string> = {}, code?: string) {
  let factory: (c: unknown) => {
    onOpen: (evt: unknown, ws: unknown) => void;
    onMessage: (evt: { data: unknown }, ws: unknown) => void;
    onClose: () => void;
  } = () => {
    throw new Error("not registered");
  };
  const helper = {
    upgradeWebSocket: (callback: typeof factory) => {
      factory = callback;
      return () => {};
    },
  };
  registerPalcoWs(
    { get: vi.fn() } as unknown as OpenAPIHono,
    helper as unknown as NodeWebSocket,
  );
  return factory({
    req: { param: () => code, query: (key: string) => params[key] },
  });
}
const ws = () => ({ close: vi.fn(), send: vi.fn() });
it("bootstrap sem helper falha explicitamente", () => {
  expect(() => getPalcoWs()).toThrow("palcoWs não inicializado");
});
it("callbacks antes do handshake e fechamento são seguros", () => {
  const events = handlers(),
    client = ws();
  events.onMessage({ data: "{}" }, client);
  events.onClose();
  expect(client.send).not.toHaveBeenCalled();
  events.onOpen({}, client);
  expect(client.close).toHaveBeenCalledWith(4400, "role_invalida");
});
it("código ou token ausente não autentica receiver", () => {
  vi.stubEnv("PALCO_RELAY_KEY", "test-relay-key");
  const events = handlers({ role: "receiver" }),
    client = ws();
  events.onOpen({}, client);
  expect(client.close).toHaveBeenCalledWith(4404, "sessao_invalida");
});
it("mensagem binária de receiver é rejeitada sem publicação", () => {
  vi.stubEnv("PALCO_RELAY_KEY", "test-relay-key");
  const created = createRoom()!;
  const events = handlers(
      { role: "receiver", token: created.token, cid: "stable-device" },
      created.code,
    ),
    client = ws();
  events.onOpen({}, client);
  events.onMessage({ data: Buffer.from("{}") }, client);
  expect(client.send).toHaveBeenCalledWith(
    JSON.stringify({ error: "role_nao_publica" }),
  );
  events.onClose();
});
it("expiração remove sala sem aceitar o token antigo", () => {
  vi.useFakeTimers();
  vi.stubEnv("PALCO_RELAY_KEY", "test-relay-key");
  const created = createRoom()!;
  vi.advanceTimersByTime(ROOM_TTL_MS + 1);
  createRoom();
  expect(getRoomToken(created.code)).toBeNull();
  expect(getRoom(created.code, created.token)).toBeNull();
});
it("ausência de chave bloqueia consulta de sala", () => {
  vi.stubEnv("PALCO_RELAY_KEY", undefined);
  vi.stubEnv("REMOTE_SESSION_KEY", undefined);
  expect(getRoom("AAAAAA", "invalid")).toBeNull();
});
it("relay direto limita mensagem antes de atualizar estado", () => {
  vi.stubEnv("PALCO_RELAY_KEY", "test-relay-key");
  const created = createRoom()!,
    room = getRoom(created.code, created.token)!;
  const sender = { id: "operator", role: "operator" as const, send: () => {} };
  expect(routeMessage(room, sender, "x".repeat(MAX_MSG_BYTES + 1))).toBeNull();
  expect(room.lastStateBySender.size).toBe(0);
});
it("limite de salas é respeitado e recupera após expiração", async () => {
  vi.useFakeTimers();
  vi.stubEnv("PALCO_RELAY_KEY", "test-relay-key");
  vi.advanceTimersByTime(3 * ROOM_TTL_MS + 1);
  for (let i = 0; i < MAX_ROOMS; i++) expect(createRoom()).not.toBeNull();
  expect(createRoom()).toBeNull();
  const { palcoRoutes } = await import("../../src/v1/palco/palco.routes.js");
  const response = await palcoRoutes.request("/sessions", { method: "POST" });
  expect(response.status).toBe(503);
  expect(await response.json()).toEqual({ error: "relay_indisponivel" });
  vi.advanceTimersByTime(ROOM_TTL_MS + 1);
  expect(createRoom()).not.toBeNull();
});
