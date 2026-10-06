import { describe, expect, it, beforeAll } from "vitest";

/**
 * Onda 10c: relay direto (unit) — createRoom, getRoom (token inválido,
 * código inexistente), getRoomToken, joinRoom (reconexão mesmo cid,
 * operator duplicado, room cheio).
 */
describe("palco relay (unit direto)", () => {
  let relay: typeof import("../../src/v1/palco/relay.js");
  const prevKey = process.env.PALCO_SECRET_KEY;

  beforeAll(async () => {
    process.env.PALCO_RELAY_KEY = "chave-teste-relay-0123456789abcdef";
    relay = await import("../../src/v1/palco/relay.js");
  });

  afterAll(() => {
    if (prevKey === undefined) delete process.env.PALCO_RELAY_KEY;
    else process.env.PALCO_RELAY_KEY = prevKey;
  });

  function client(over: Partial<Record<string, any>> = {}) {
    return {
      id: Math.random().toString(36).slice(2),
      role: "receiver",
      cid: null as string | null,
      send: () => {},
      close: () => {},
      ...over,
    } as any;
  }

  it("createRoom → code 6 chars + token", () => {
    const r = relay.createRoom();
    expect(r).not.toBeNull();
    expect(r!.code).toMatch(/^[A-Z0-9]{6}$/);
    expect(r!.token).toBeTruthy();
  });

  it("getRoom com token inválido → null", () => {
    const r = relay.createRoom()!;
    expect(relay.getRoom(r.code, "token-falso")).toBeNull();
  });

  it("getRoom com código inexistente → null", () => {
    const r = relay.createRoom()!;
    // token válido de outro code não bate com normalized de code fantasma
    expect(relay.getRoom("ZZZZZZ", r.token)).toBeNull();
  });

  it("getRoom válido atualiza lastActivity e retorna room", () => {
    const r = relay.createRoom()!;
    const room = relay.getRoom(r.code, r.token);
    expect(room).not.toBeNull();
    expect(room!.code).toBe(r.code);
  });

  it("getRoomToken: código fantasma → null; código ativo → token", () => {
    const r = relay.createRoom()!;
    expect(relay.getRoomToken("ZZZZ99")).toBeNull();
    const t = relay.getRoomToken(r.code);
    expect(t).toBeTruthy();
    // token gerado valida no getRoom
    expect(relay.getRoom(r.code, t!)).not.toBeNull();
  });

  it("getRoomToken com código malformado → null", () => {
    expect(relay.getRoomToken("ab")).toBeNull();
    expect(relay.getRoomToken("AAAAAA1")).toBeNull();
  });

  it("joinRoom: operator duplicado com cid diferente → error", () => {
    const r = relay.createRoom()!;
    const room = relay.getRoom(r.code, r.token)!;
    const op1 = client({ role: "operator", cid: "c1" });
    const op2 = client({ role: "operator", cid: "c2" });
    expect(relay.joinRoom(room, op1).ok).toBe(true);
    const second = relay.joinRoom(room, op2);
    expect(second.ok).toBe(false);
    expect(second.error).toBe("operator_already_present");
  });

  it("joinRoom: reconexão mesmo cid expulsa o morto e entra", () => {
    const r = relay.createRoom()!;
    const room = relay.getRoom(r.code, r.token)!;
    const op1 = client({ role: "operator", cid: "mesmo-cid" });
    expect(relay.joinRoom(room, op1).ok).toBe(true);
    // mesmo cid (socket morto) → substitui
    const op1novo = client({ role: "operator", cid: "mesmo-cid" });
    const res = relay.joinRoom(room, op1novo);
    expect(res.ok).toBe(true);
  });

  it("joinRoom: receivers até o limite; além → room_full", () => {
    const r = relay.createRoom()!;
    const room = relay.getRoom(r.code, r.token)!;
    // enche de receivers (MAX_CLIENTS_PER_ROOM default)
    let last = { ok: true };
    for (let i = 0; i < 40; i++) {
      last = relay.joinRoom(room, client({ role: "receiver", cid: `r${i}` }));
      if (!last.ok) break;
    }
    expect(last.ok).toBe(false);
    expect(last.error).toBe("room_full");
  });

  it("joinRoom: receiver duplicado com mesmo cid reconecta", () => {
    const r = relay.createRoom()!;
    const room = relay.getRoom(r.code, r.token)!;
    const rec = client({ role: "receiver", cid: "rec-1" });
    expect(relay.joinRoom(room, rec).ok).toBe(true);
    const rec2 = client({ role: "receiver", cid: "rec-1" });
    expect(relay.joinRoom(room, rec2).ok).toBe(true);
  });
});
