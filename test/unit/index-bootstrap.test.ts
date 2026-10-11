import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";

describe("src/index.ts — bootstrap do servidor", () => {
  afterAll(() => {
    vi.resetModules();
  });

  it("inicia servidor, aplica migrations e loga a porta", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "index-bootstrap-"));
    process.env.DB_PATH = join(tmp, "catalog.db");
    delete process.env.PORT; // fallback PORT ?? 3100

    const serveMock = vi.fn(
      (_opts: unknown, cb: (info: { port: number }) => void) => {
        cb({ port: 3100 });
        // server mínimo: injectWebSocket do palco-relay precisa de .on()
        return {
          close: () => {},
          on: () => {},
        };
      },
    );
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    vi.doMock("@hono/node-server", () => ({ serve: serveMock }));

    await import("../../src/index.js");

    expect(serveMock).toHaveBeenCalledTimes(1);
    expect(logSpy).toHaveBeenCalledWith("piano-api rodando na porta 3100");
    expect(serveMock).toHaveBeenCalledTimes(1);

    logSpy.mockRestore();
    errSpy.mockRestore();
    vi.doUnmock("@hono/node-server");
    vi.resetModules();
    delete process.env.DB_PATH;
    delete process.env.PORT;
    rmSync(tmp, { recursive: true, force: true });
  });
  it.each(["removed", "failed"])(
    "purge %s não impede o servidor",
    async (mode) => {
      const tmp = mkdtempSync(join(tmpdir(), "index-purge-"));
      process.env.DB_PATH = join(tmp, "catalog.db");
      const { register } = await import("prom-client");
      register.clear();
      vi.resetModules();
      const serve = vi.fn(() => ({ close: () => {}, on: () => {} }));
      const log = vi.spyOn(console, "log").mockImplementation(() => {}),
        error = vi.spyOn(console, "error").mockImplementation(() => {});
      vi.doMock("@hono/node-server", () => ({ serve }));
      vi.doMock("../../src/v1/custom/quota.service.js", async () => ({
        ...(await vi.importActual("../../src/v1/custom/quota.service.js")),
        purgeTombstones: () => {
          if (mode === "failed") throw new Error("purge unavailable");
          return { collections: 1, musics: 2 };
        },
      }));
      try {
        await import("../../src/index.js");
        expect(serve).toHaveBeenCalledTimes(1);
        if (mode === "failed")
          expect(error).toHaveBeenCalledWith(
            "[purge] falhou (não-fatal):",
            expect.any(Error),
          );
        else
          expect(log).toHaveBeenCalledWith(
            expect.stringContaining("tombstones removidos"),
          );
        const { closeDb } = await import("../../src/db/connection.js");
        closeDb();
      } finally {
        log.mockRestore();
        error.mockRestore();
        vi.doUnmock("@hono/node-server");
        vi.doUnmock("../../src/v1/custom/quota.service.js");
        vi.resetModules();
        delete process.env.DB_PATH;
        rmSync(tmp, { recursive: true, force: true });
      }
    },
  );
});
