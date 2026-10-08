import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * WT-5a: relay de estado do Palco (fire-and-forget, em memória).
 *
 * Web operador (role=operator) publica estado; TVs/ receivers (role=receiver)
 * e senders (role=sender) assinam. A API NÃO persiste nada de culto: room vive
 * em memória e expira após ROOM_TTL_MS sem atividade.
 */

export const ROOM_TTL_MS = 30 * 60 * 1000;
export const MAX_ROOMS = 500;
export const MAX_CLIENTS_PER_ROOM = 32;
export const MAX_MSG_BYTES = 64 * 1024;
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export type PalcoRole = "operator" | "sender" | "receiver";

export interface RelayClient {
  id: string;
  /** Identidade estável do client (query ?cid=) — reconexão limpa o morto. */
  cid?: string;
  role: PalcoRole;
  /** Slot lógico declarado pelo receiver (?slot=N) — roteamento por destino. */
  slot?: number;
  send: (data: string) => void;
}

export interface PalcoRoom {
  code: string;
  createdAt: number;
  lastActivityAt: number;
  lastStateBySender: Map<string, string>; // clientId -> último estado (late-join)
  clients: Set<RelayClient>;
}

export interface RoomStore {
  rooms: Map<string, PalcoRoom>;
}

const store: RoomStore = { rooms: new Map() };

function makeCode(): string {
  const bytes = randomBytes(6);
  return Array.from(bytes)
    .map((b) => CODE_ALPHABET[b % CODE_ALPHABET.length])
    .join("");
}

export function normalizeCode(input: string): string {
  return input.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

export function secretKey(): string {
  return process.env.PALCO_RELAY_KEY ?? process.env.REMOTE_SESSION_KEY ?? "";
}

export function signRoom(code: string): string {
  return createHmac("sha256", secretKey()).update(code).digest("base64url");
}

export function verifyRoomToken(code: string, token: string): boolean {
  const expected = signRoom(code);
  const a = Buffer.from(expected);
  const b = Buffer.from(token);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export function roomKey(code: string): string {
  return `${code}:${signRoom(code).slice(0, 8)}`;
}

function sweep(now: number): void {
  // Expira apenas por TTL. Room vazia com idade < TTL é legítima:
  // intervalo entre createRoom() e o primeiro client conectar.
  for (const [key, room] of store.rooms) {
    if (now - room.lastActivityAt > ROOM_TTL_MS) {
      store.rooms.delete(key);
    }
  }
}

export function createRoom(): { code: string; token: string } | null {
  const now = Date.now();
  sweep(now);
  if (store.rooms.size >= MAX_ROOMS) return null;
  for (let attempt = 0; attempt < 5; attempt++) {
    const code = makeCode();
    const key = roomKey(code);
    if (!store.rooms.has(key)) {
      store.rooms.set(key, {
        code,
        createdAt: now,
        lastActivityAt: now,
        lastStateBySender: new Map(),
        clients: new Set(),
      });
      return { code, token: signRoom(code) };
    }
  }
  // Inalcançável na prática: exigiria 5 colisões seguidas de makeCode
  // (36^6 ≈ 2.2e9 combinações) — defesa em profundidade p/ loop infinito.
  /* v8 ignore next -- 5 colisões de randomBytes são estatisticamente impossíveis */
  return null;
}

export function getRoom(code: string, token: string): PalcoRoom | null {
  if (!secretKey()) return null;
  const normalized = normalizeCode(code);
  if (!verifyRoomToken(normalized, token)) return null;
  const room = store.rooms.get(roomKey(normalized));
  if (!room) return null;
  room.lastActivityAt = Date.now();
  return room;
}

/** Token de bootstrap para receiver browser, limitado a rooms ativas. */
export function getRoomToken(code: string): string | null {
  const normalized = normalizeCode(code);
  if (!/^[A-Z0-9]{6}$/.test(normalized) || !secretKey()) return null;
  const room = store.rooms.get(roomKey(normalized));
  if (!room) return null;
  room.lastActivityAt = Date.now();
  return signRoom(normalized);
}

export function joinRoom(
  room: PalcoRoom,
  client: RelayClient,
): { ok: boolean; error?: string } {
  // Reconexão por identidade: se existe client antigo com o MESMO cid (socket
  // morto cujo onClose não rodou — caso real 01/09: web/TV reconectando tomava
  // 4409 e entrava em loop), expulsa o morto e deixa o novo entrar.
  // cid diferente = operator de verdade novo → 4409 (2 operadores se pisam
  // conscientemente, não por reconexão).
  if (client.cid) {
    const stale = [...room.clients].filter((c) => c.cid === client.cid);
    for (const dead of stale) {
      room.clients.delete(dead);
      room.lastStateBySender.delete(dead.id);
    }
  }
  const operators = [...room.clients].filter((c) => c.role === "operator");
  if (client.role === "operator" && operators.length >= 1) {
    return { ok: false, error: "operator_already_present" };
  }
  if (room.clients.size >= MAX_CLIENTS_PER_ROOM) {
    return { ok: false, error: "room_full" };
  }
  room.clients.add(client);
  room.lastActivityAt = Date.now();
  // Late-join: receiver recebe o último estado de cada sender imediatamente.
  if (client.role === "receiver") {
    for (const [_senderId, state] of room.lastStateBySender) {
      client.send(state);
    }
  }
  notifyPresence(room);
  return { ok: true };
}

/** Conta receivers vivos e avisa os operators (card "TV conectada"). */
export function notifyPresence(room: PalcoRoom): void {
  // WT-5: lista individual dos receivers (não só contagem) — o card do web
  // mostra uma entrada por TV realmente conectada, sem slot fantasma.
  const receivers = [...room.clients]
    .filter((c) => c.role === "receiver")
    .map((c, i) => ({
      id: c.cid || c.id,
      slot: c.slot ?? i + 1,
      label: `Monitor ${c.slot ?? i + 1}`,
    }));
  const msg = JSON.stringify({
    v: 2,
    type: "youare",
    receivers: receivers.length,
    receiverList: receivers,
  });
  for (const c of room.clients) {
    if (c.role === "operator") c.send(msg);
  }
}

export function leaveRoom(room: PalcoRoom, client: RelayClient): void {
  room.clients.delete(client);
  room.lastStateBySender.delete(client.id);
  room.lastActivityAt = Date.now();
  notifyPresence(room);
}

/**
 * Roteia mensagem dentro da room.
 * - operator → broadcast para senders+receivers (estado do palco)
 * - sender → operator + receivers (estado do slot / status de TVs)
 * - receiver → nada (só assina); ack opcional futuro
 * Envelope com `to: "slot-N"` restringe aos receivers daquele slot
 * (WT-6A: Bíblia → Monitor 1, Hino → Monitor 2, cada receiver PWA declara
 * seu slot na query ?slot=N). Sem `to`, broadcast — retrocompatível.
 * Retorna lista de destinatários ou null se inválido.
 */
export function routeMessage(
  room: PalcoRoom,
  from: RelayClient,
  raw: string,
): RelayClient[] | null {
  if (raw.length > MAX_MSG_BYTES) return null;
  room.lastActivityAt = Date.now();

  if (from.role === "operator") {
    room.lastStateBySender.set(from.id, raw);
    const all = [...room.clients].filter((c) => c.id !== from.id);
    let targetSlot: number | null = null;
    try {
      const parsed = JSON.parse(raw) as { to?: string };
      const m = /^slot-(\d+)$/.exec(String(parsed.to ?? ""));
      if (m) targetSlot = Number(m[1]);
    } catch {
      // não-JSON: broadcast
    }
    if (targetSlot === null) return all;
    return all.filter(
      (c) =>
        c.role === "operator" || c.role === "sender" || c.slot === targetSlot,
    );
  }
  if (from.role === "sender") {
    room.lastStateBySender.set(from.id, raw);
    return [...room.clients].filter(
      (c) => c.id !== from.id && c.role !== "sender",
    );
  }
  return null; // receiver não publica
}

/** Testes/introspecção */
export function resetRelay(): void {
  store.rooms.clear();
}

export function relayStats(): { rooms: number; clients: number } {
  let clients = 0;
  for (const room of store.rooms.values()) clients += room.clients.size;
  return { rooms: store.rooms.size, clients };
}
