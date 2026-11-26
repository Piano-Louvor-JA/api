import { afterEach, describe, expect, it, vi } from "vitest";

describe("bootPresence", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
    vi.doUnmock("../../src/lib/devicePresence.js");
  });

  it("chama startPresencePersistence no boot normal", async () => {
    const start = vi.fn(() => () => {});
    vi.doMock("../../src/lib/devicePresence.js", () => ({
      startPresencePersistence: start,
    }));
    const { bootPresence } = await import("../../src/lib/bootPresence.js");
    await bootPresence();
    expect(start).toHaveBeenCalledTimes(1);
  });

  it("falha no import/start é não-fatal (loga e segue)", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.doMock("../../src/lib/devicePresence.js", () => {
      throw new Error("módulo indisponível");
    });
    const { bootPresence } = await import("../../src/lib/bootPresence.js");
    await expect(bootPresence()).resolves.toBeUndefined();
    expect(err).toHaveBeenCalledWith(
      "[presence] não iniciou (não-fatal):",
      expect.any(Error),
    );
  });
});
