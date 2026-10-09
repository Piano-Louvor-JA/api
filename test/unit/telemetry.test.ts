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
    initMock.mockReset();
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
  it("remove dados pessoais do evento e mantém localização da falha", async () => {
    vi.stubEnv("SENTRY_DSN", "https://key@errors.example/1");
    const { initTelemetry } = await import("../../src/lib/telemetry.js");
    initTelemetry();
    await vi.waitFor(() => expect(initMock).toHaveBeenCalled());
    const options = initMock.mock.calls[0][0];
    expect(options.defaultIntegrations).toBe(false);
    const sanitized = options.beforeSend({
      event_id: "123",
      timestamp: 1,
      platform: "node",
      message: "person@example.com",
      user: { email: "person@example.com" },
      request: {
        url: "/users/person@example.com",
        headers: { authorization: "secret" },
        data: "password",
      },
      breadcrumbs: [{ message: "secret" }],
      contexts: { private: { token: "secret" } },
      extra: {
        route: "/users/:id",
        method: "GET",
        path: "/users/42",
        password: "secret",
      },
      exception: {
        values: [
          {
            type: "TypeError",
            value: "secret",
            stacktrace: {
              frames: [
                {
                  filename: "/home/person/routes.ts?token=secret",
                  lineno: 42,
                  colno: 3,
                  vars: { password: "secret" },
                  pre_context: ["secret"],
                  function: "secret",
                },
              ],
            },
          },
        ],
      },
    });
    expect(JSON.stringify(sanitized)).not.toMatch(
      /secret|person@example|password|\/home\/person/,
    );
    expect(sanitized.extra).toEqual({ route: "/users/:id", method: "GET" });
    expect(sanitized.exception.values[0].stacktrace.frames[0]).toEqual({
      filename: "routes.ts",
      lineno: 42,
      colno: 3,
      in_app: undefined,
    });
  });

  it("falha do SDK não interrompe inicialização nem captura", async () => {
    vi.stubEnv("SENTRY_DSN", "https://key@errors.example/1");
    initMock.mockImplementationOnce(() => {
      throw new Error("SDK unavailable");
    });
    const { initTelemetry, reportError } = await import(
      "../../src/lib/telemetry.js"
    );
    expect(() => initTelemetry()).not.toThrow();
    await vi.waitFor(() => expect(initMock).toHaveBeenCalled());
    expect(() => reportError(new Error("boom"))).not.toThrow();
    expect(captureExceptionMock).not.toHaveBeenCalled();
    initTelemetry();
    await vi.waitFor(() => expect(initMock).toHaveBeenCalledTimes(2));
    captureExceptionMock.mockImplementationOnce(() => {
      throw new Error("capture failed");
    });
    expect(() => reportError(new Error("boom"))).not.toThrow();
  });
});
