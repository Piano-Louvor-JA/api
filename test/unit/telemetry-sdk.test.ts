import { afterEach, expect, it, vi } from "vitest";

const { envelopes } = vi.hoisted(() => ({ envelopes: [] as unknown[] }));

vi.mock("@sentry/node", async (importOriginal) => {
  const sdk = await importOriginal<typeof import("@sentry/node")>();
  return {
    ...sdk,
    init: (options: Parameters<typeof sdk.init>[0]) =>
      sdk.init({
        ...options,
        transport: () => ({
          send: async (envelope) => {
            envelopes.push(envelope);
            return { statusCode: 200 };
          },
          flush: async () => true,
        }),
      }),
  };
});

afterEach(async () => {
  const sdk = await import("@sentry/node");
  await sdk.close();
  vi.unstubAllEnvs();
  envelopes.length = 0;
});

it("Sentry 11 envia erro sanitizado sem dados pessoais usando o SDK real", async () => {
  vi.stubEnv("SENTRY_DSN", "https://key@errors.example/1");
  const sdk = await import("@sentry/node");
  const { initTelemetry, reportError } = await import(
    "../../src/lib/telemetry.js"
  );
  initTelemetry();
  await vi.waitFor(() => expect(sdk.getClient()).toBeDefined());
  expect(sdk.getClient()?.getOptions().dataCollection?.userInfo).toBe(false);
  sdk.withScope((scope) => {
    scope.setUser({ email: "private@example.com", ip_address: "192.0.2.1" });
    scope.setContext("request", { authorization: "secret-token" });
    reportError(new Error("private@example.com secret-token"), {
      route: "/v1/example",
      method: "GET",
    });
  });
  await sdk.flush();
  expect(envelopes).toHaveLength(1);
  const payload = JSON.stringify(envelopes);
  expect(payload).toContain("Unhandled API error (message redacted)");
  expect(payload).toContain("/v1/example");
  expect(payload).not.toContain("private@example.com");
  expect(payload).not.toContain("192.0.2.1");
  expect(payload).not.toContain("secret-token");
});
