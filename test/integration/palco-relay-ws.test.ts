import { unlinkSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { serve } from "@hono/node-server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { createApp } from "../../src/app.js";
import { closeDb, initDb } from "../../src/db/connection.js";
import { getPalcoWs } from "../../src/v1/palco/palco.routes.js";
import { resetRelay } from "../../src/v1/palco/relay.js";

const TEST_DB = "./data/test-palco-relay.db";

interface TestServer {
  url: string;
  close: () => Promise<void>;
}

async function startServer(): Promise<TestServer> {
  const app = createApp();
  const server = serve({ fetch: app.fetch, port: 0 });
  getPalcoWs().injectWebSocket(server);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const addr = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${addr.port}`,
    close: () =>
      new Promise((resolve) => {
        server.close(() => resolve());
      }),
  };
}

function connectWs(
  url: string,
  path: string,
): {
  ws: WebSocket;
  messages: string[];
  opened: Promise<void>;
  closed: Promise<{ code: number }>;
} {
  const ws = new WebSocket(`${url.replace("http", "ws")}${path}`);
  const messages: string[] = [];
  let openedResolve: () => void;
  let closedResolve: (v: { code: number }) => void;
  const opened = new Promise<void>((r) => (openedResolve = r));
  const closed = new Promise<{ code: number }>((r) => (closedResolve = r));
  ws.on("open", () => openedResolve());
  ws.on("message", (data) => messages.push(String(data)));
  ws.on("close", (code) => closedResolve({ code }));
  return { ws, messages, opened, closed };
}

function waitFor(
  messages: string[],
  predicate: (m: string) => boolean,
  timeoutMs = 2000,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const existing = messages.find(predicate);
    if (existing) return resolve(existing);
    const timer = setTimeout(
      () => reject(new Error("timeout esperando mensagem")),
      timeoutMs,
    );
    const origPush = messages.push.bind(messages);
    messages.push = (m: string) => {
      origPush(m);
      if (predicate(m)) {
        clearTimeout(timer);
        resolve(m);
      }
      return messages.length;
    };
  });
}

describe("palco relay E2E (WS real)", () => {
  let srv: TestServer;

  beforeEach(async () => {
    process.env.DB_PATH = TEST_DB;
    process.env.REMOTE_SESSION_KEY = "test-remote-session-key-32-bytes!";
    process.env.PALCO_RELAY_KEY = "test-palco-relay-key-32-bytes!!";
    initDb();
    resetRelay();
    srv = await startServer();
  });

  afterEach(async () => {
    await srv.close();
    closeDb();
    delete process.env.REMOTE_SESSION_KEY;
    delete process.env.PALCO_RELAY_KEY;
    try {
      unlinkSync(TEST_DB);
    } catch {}
  });

  it("GET /v1/palco/sessions/:code/token retorna token de sessão ativa", async () => {
    const app = createApp();
    const created = await app.request("/v1/palco/sessions", { method: "POST" });
    const { code, token } = (await created.json()) as {
      code: string;
      token: string;
    };

    const res = await app.request(
      `/v1/palco/sessions/${code.toLowerCase()}/token`,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ token });

    const missing = await app.request("/v1/palco/sessions/ZZZZZZ/token");
    expect(missing.status).toBe(404);
  });

  it("POST /v1/palco/sessions cria code+token", async () => {
    const app = createApp();
    const res = await app.request("/v1/palco/sessions", { method: "POST" });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { code: string; token: string };
    expect(body.code).toMatch(/^[A-Z0-9]{6}$/);
    expect(body.token.length).toBeGreaterThan(20);
  });

  it("operator → receiver: mensagem chega; receiver não publica", async () => {
    const app = createApp();
    const created = await app.request("/v1/palco/sessions", { method: "POST" });
    const { code, token } = (await created.json()) as {
      code: string;
      token: string;
    };

    const receiver = connectWs(
      srv.url,
      `/v1/palco/relay/${code}?token=${token}&role=receiver`,
    );
    await receiver.opened;

    const operator = connectWs(
      srv.url,
      `/v1/palco/relay/${code}?token=${token}&role=operator`,
    );
    await operator.opened;

    operator.ws.send(JSON.stringify({ module: "bible", verse: "Jo 3:16" }));

    const got = await waitFor(receiver.messages, (m) => m.includes("bible"));
    expect(JSON.parse(got).verse).toBe("Jo 3:16");

    // receiver tenta publicar → API recusa
    receiver.ws.send('{"hack":true}');
    const denied = await waitFor(receiver.messages, (m) =>
      m.includes("role_nao_publica"),
    );
    expect(denied).toBeTruthy();

    operator.ws.close();
    receiver.ws.close();
  });

  it("token inválido no handshake → 404/connection recusada", async () => {
    const app = createApp();
    const created = await app.request("/v1/palco/sessions", { method: "POST" });
    const { code } = (await created.json()) as { code: string };

    const bad = connectWs(
      srv.url,
      `/v1/palco/relay/${code}?token=INVALIDO&role=receiver`,
    );
    await bad.opened.catch(() => {});
    const result = await bad.closed;
    // Servidor aceita handshake, valida token no onOpen e fecha 4404
    expect(result.code).toBe(4404);
  });

  it("late-join: receiver que conecta depois recebe último slide", async () => {
    const app = createApp();
    const created = await app.request("/v1/palco/sessions", { method: "POST" });
    const { code, token } = (await created.json()) as {
      code: string;
      token: string;
    };

    const operator = connectWs(
      srv.url,
      `/v1/palco/relay/${code}?token=${token}&role=operator`,
    );
    await operator.opened;
    operator.ws.send('{"module":"media","hymn":101}');

    // TV conecta DEPOIS do slide já publicado
    const lateReceiver = connectWs(
      srv.url,
      `/v1/palco/relay/${code}?token=${token}&role=receiver`,
    );
    await lateReceiver.opened;

    const got = await waitFor(lateReceiver.messages, (m) =>
      m.includes("media"),
    );
    expect(JSON.parse(got).hymn).toBe(101);

    operator.ws.close();
    lateReceiver.ws.close();
  });

  it("2 receivers na mesma room recebem o mesmo estado", async () => {
    const app = createApp();
    const created = await app.request("/v1/palco/sessions", { method: "POST" });
    const { code, token } = (await created.json()) as {
      code: string;
      token: string;
    };

    const tv1 = connectWs(
      srv.url,
      `/v1/palco/relay/${code}?token=${token}&role=receiver&slot=0`,
    );
    const tv2 = connectWs(
      srv.url,
      `/v1/palco/relay/${code}?token=${token}&role=receiver&slot=1`,
    );
    await Promise.all([tv1.opened, tv2.opened]);

    const operator = connectWs(
      srv.url,
      `/v1/palco/relay/${code}?token=${token}&role=operator`,
    );
    await operator.opened;
    operator.ws.send('{"module":"clock"}');

    await Promise.all([
      waitFor(tv1.messages, (m) => m.includes("clock")),
      waitFor(tv2.messages, (m) => m.includes("clock")),
    ]);

    operator.ws.close();
    tv1.ws.close();
    tv2.ws.close();
  });

  it("role inválida é rejeitada (4400)", async () => {
    const app = createApp();
    const created = await app.request("/v1/palco/sessions", { method: "POST" });
    const { code, token } = (await created.json()) as {
      code: string;
      token: string;
    };

    const bad = connectWs(
      srv.url,
      `/v1/palco/relay/${code}?token=${token}&role=hacker`,
    );
    await bad.opened.catch(() => {});
    const result = await bad.closed;
    expect(result.code).toBe(4400);
  });

  it("ping → pong sem broadcast; msg > MAX rejeitada; json inválido ignorado", async () => {
    const app = createApp();
    const created = await app.request("/v1/palco/sessions", { method: "POST" });
    const { code, token } = (await created.json()) as {
      code: string;
      token: string;
    };

    const receiver = connectWs(
      srv.url,
      `/v1/palco/relay/${code}?token=${token}&role=receiver&slot=0`,
    );
    const operator = connectWs(
      srv.url,
      `/v1/palco/relay/${code}?token=${token}&role=operator`,
    );
    await Promise.all([receiver.opened, operator.opened]);

    // ping → pong direto pro emissor
    operator.ws.send('{"type":"ping"}');
    await waitFor(operator.messages, (m) => m.includes("pong"));

    // msg grande (> MAX_MSG_BYTES) → error msg_too_large
    operator.ws.send("x".repeat(256 * 1024));
    await waitFor(operator.messages, (m) => m.includes("msg_too_large"));

    // json inválido → ignorado (sem crash, sem resposta)
    operator.ws.send("{broken json");
    await new Promise((r) => setTimeout(r, 100));

    operator.ws.close();
    receiver.ws.close();
  });

  it("segundo operator é rejeitado (4409)", async () => {
    const app = createApp();
    const created = await app.request("/v1/palco/sessions", { method: "POST" });
    const { code, token } = (await created.json()) as {
      code: string;
      token: string;
    };

    const op1 = connectWs(
      srv.url,
      `/v1/palco/relay/${code}?token=${token}&role=operator`,
    );
    await op1.opened;

    const op2 = connectWs(
      srv.url,
      `/v1/palco/relay/${code}?token=${token}&role=operator`,
    );
    await op2.opened.catch(() => {});
    const result = await op2.closed;
    expect(result.code).toBe(4409);

    op1.ws.close();
  });
});
