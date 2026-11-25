import { afterEach, expect, it, vi } from "vitest";

const transport = vi.hoisted(() => ({
  sendMail: vi.fn().mockResolvedValue({}),
  create: vi.fn(),
}));
vi.mock("nodemailer", () => ({
  createTransport: transport.create.mockReturnValue({
    sendMail: transport.sendMail,
  }),
}));

import { sendResetTokenEmail } from "../../src/v1/custom/mail.service.js";

afterEach(() => vi.unstubAllEnvs());
it("SMTP sem porta explícita usa SSL na porta 465", async () => {
  vi.stubEnv("SMTP_HOST", "smtp.test");
  vi.stubEnv("SMTP_USER", "test-user");
  vi.stubEnv("SMTP_PASS", "test-password");
  vi.stubEnv("SMTP_FROM", "sender@test.local");
  vi.stubEnv("SMTP_PORT", undefined);
  expect(
    await sendResetTokenEmail("user@test.local", "User", "test-token"),
  ).toBe(true);
  expect(transport.create).toHaveBeenCalledWith(
    expect.objectContaining({ port: 465, secure: true }),
  );
  expect(transport.sendMail).toHaveBeenCalledWith(
    expect.objectContaining({ to: "user@test.local" }),
  );
});
