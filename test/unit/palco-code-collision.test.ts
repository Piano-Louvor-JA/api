import { afterEach, expect, it, vi } from "vitest";

const bytes = vi.hoisted(() => vi.fn());
vi.mock("node:crypto", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:crypto")>()),
  randomBytes: bytes,
}));

import { createRoom, getRoom } from "../../src/v1/palco/relay.js";

afterEach(() => vi.unstubAllEnvs());
it("colisão de código tenta outro código sem substituir a sala existente", () => {
  vi.stubEnv("PALCO_RELAY_KEY", "collision-test-key");
  bytes
    .mockReturnValueOnce(Buffer.alloc(6, 0))
    .mockReturnValueOnce(Buffer.alloc(6, 0))
    .mockReturnValueOnce(Buffer.alloc(6, 1));
  const first = createRoom()!,
    second = createRoom()!;
  expect(first.code).toBe("AAAAAA");
  expect(second.code).toBe("BBBBBB");
  expect(bytes).toHaveBeenCalledTimes(3);
  expect(getRoom(first.code, first.token)).not.toBeNull();
  expect(getRoom(second.code, second.token)).not.toBeNull();
});
