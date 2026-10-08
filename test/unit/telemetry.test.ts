import { beforeEach, describe, expect, it, vi } from "vitest";

const { captureExceptionMock, initMock } = vi.hoisted(() => ({
  captureExceptionMock: vi.fn(),
  initMock: vi.fn(),
}));

vi.mock("@sentry/node", () => ({
  captureException: captureExceptionMock,
  init: initMock,
}));

describe("telemetria api", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllEnvs();
    captureExceptionMock.mockClear();
    initMock.mockClear();
  });

  it("sem SENTRY_DSN não inicializa e captureException é no-op", async () => {
    vi.stubEnv("SENTRY_DSN", "");
    const { initTelemetry, reportError } = await import(
      "../../src/lib/telemetry.js"
    );
    initTelemetry();
    reportError(new Error("não enviar"));
    expect(initMock).not.toHaveBeenCalled();
    expect(captureExceptionMock).not.toHaveBeenCalled();
  });

  it("com SENTRY_DSN inicializa sem PII/tracing e captura", async () => {
    vi.stubEnv("SENTRY_DSN", "https://key@errors.example/1");
    const { initTelemetry, reportError } = await import(
      "../../src/lib/telemetry.js"
    );
    initTelemetry();
    const error = new Error("boom");
    await vi.waitFor(() => expect(initMock).toHaveBeenCalled());
    expect(initMock).toHaveBeenCalledWith(
      expect.objectContaining({
        dsn: "https://key@errors.example/1",
        sendDefaultPii: false,
        tracesSampleRate: 0,
      }),
    );
    reportError(error, { route: "/v1/x" });
    await vi.waitFor(() =>
      expect(captureExceptionMock).toHaveBeenCalledWith(error, {
        extra: { route: "/v1/x" },
      }),
    );
  });
});
