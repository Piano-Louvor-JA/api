// SEC-142 (api#142): chave do relay — fail-fast no boot em produção
import { describe, it, expect } from "vitest";
import { validateEnv } from "../../src/config/env.js";

describe("SEC-142: PALCO_RELAY_KEY obrigatória em produção", () => {
  const base = {
    NODE_ENV: "production",
    PORT: "3100",
    DB_PATH: ":memory:",
  };

  it("produção SEM PALCO_RELAY_KEY → boot falha", () => {
    expect(() =>
      validateEnv({ ...base, PALCO_RELAY_KEY: undefined }),
    ).toThrow("PALCO_RELAY_KEY é obrigatória em produção");
  });

  it("produção com PALCO_RELAY_KEY vazia/espaços → boot falha", () => {
    expect(() => validateEnv({ ...base, PALCO_RELAY_KEY: "   " })).toThrow(
      "PALCO_RELAY_KEY é obrigatória em produção",
    );
  });

  it("produção COM PALCO_RELAY_KEY → boot OK", () => {
    expect(() =>
      validateEnv({ ...base, PALCO_RELAY_KEY: "chave-forte-123" }),
    ).not.toThrow();
  });

  it("desenvolvimento SEM chave → boot OK (relay falha seguro em runtime)", () => {
    expect(() =>
      validateEnv({ NODE_ENV: "development", PALCO_RELAY_KEY: undefined }),
    ).not.toThrow();
  });
});
