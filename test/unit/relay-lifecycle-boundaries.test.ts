import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createRoom,
  getRoom,
  MAX_MSG_BYTES,
  ROOM_TTL_MS,
  relayStats,
  resetRelay,
  routeMessage,
} from "../../src/v1/palco/relay.js";

afterEach(() => {
  resetRelay();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("Relay lifecycle boundary behavior", () => {
  it("expires inactive rooms during the next session creation", () => {
    vi.stubEnv("PALCO_RELAY_KEY", "test-relay-key-not-a-real-secret");
    const clock = vi.spyOn(Date, "now").mockReturnValue(1000000);
    const first = createRoom()!;
    expect(getRoom(first.code, first.token)).not.toBeNull();
    clock.mockReturnValue(1000000 + ROOM_TTL_MS + 1);
    const second = createRoom()!;
    expect(getRoom(first.code, first.token)).toBeNull();
    expect(getRoom(second.code, second.token)).not.toBeNull();
    expect(relayStats().rooms).toBe(1);
  });
  it("does not authenticate a room without a configured server key", () => {
    vi.stubEnv("PALCO_RELAY_KEY", "");
    vi.stubEnv("REMOTE_SESSION_KEY", "");
    expect(getRoom("AAAAAA", "token")).toBeNull();
  });
  it("rejects oversized messages before altering the room activity or state", () => {
    vi.stubEnv("PALCO_RELAY_KEY", "test-relay-key-not-a-real-secret");
    const session = createRoom()!;
    const room = getRoom(session.code, session.token)!;
    const lastActivity = room.lastActivityAt;
    const operator = {
      id: "operator",
      role: "operator" as const,
      send: vi.fn(),
    };
    expect(
      routeMessage(room, operator, "x".repeat(MAX_MSG_BYTES + 1)),
    ).toBeNull();
    expect(room.lastActivityAt).toBe(lastActivity);
    expect(room.lastStateBySender.size).toBe(0);
  });
});
