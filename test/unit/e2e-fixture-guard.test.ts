import { describe, expect, it } from "vitest";

import {
  isE2EFixture,
  isE2EFixtureBlockEnabled,
} from "../../src/v1/custom/e2e-fixture-guard.js";

/**
 * G1 (guardrail E2E) — detector puro de fixtures.
 * Padrões da SPEC §3.1 (D3): sufixos de email + regex de nome, tudo
 * case-insensitive. Sem inventar padrões além dos listados.
 */
describe("isE2EFixture — emails", () => {
  it.each([
    "e2e_x@teste.com",
    "x@teste.com",
    "a@TEST.com",
    "b@probe.invalid",
    "c@example.com",
    "d@exemplo.com",
  ])("BLOQUEIA %s", (email) => {
    expect(isE2EFixture({ email })).toBe(true);
  });

  it.each([
    "alice@rank.local",
    "rafael@gmail.com",
    // sufixo .com.br ≠ .com — comparação de sufixo exato do domínio
    "maria@teste.com.br",
  ])("PERMITE %s", (email) => {
    expect(isE2EFixture({ email })).toBe(false);
  });
});

describe("isE2EFixture — nomes (displayName/name)", () => {
  it.each([
    "e2e_fulano",
    "E2E-beltrano",
    "slja_e2e_1",
    "probe-ci",
    "Probe C",
    "E2E 123",
  ])("BLOQUEIA %s", (name) => {
    expect(isE2EFixture({ name })).toBe(true);
  });

  it.each([
    "Coletânea da Igreja",
    "Culto Jovem",
    "Alice",
    "Deus é amor 2",
    // não casa ^probe em palavra interna
    "Peço a Deus",
  ])("PERMITE %s", (name) => {
    expect(isE2EFixture({ name })).toBe(false);
  });
});

describe("isE2EFixture — campos vazios/ausentes", () => {
  it("email e nome ausentes → false", () => {
    expect(isE2EFixture({})).toBe(false);
  });

  it("name null (música pode ser só link) → false", () => {
    expect(isE2EFixture({ name: null })).toBe(false);
  });
});

describe("isE2EFixtureBlockEnabled — flag trivaluada (D1)", () => {
  it("unset + production → true", () => {
    expect(
      isE2EFixtureBlockEnabled({ NODE_ENV: "production" } as NodeJS.ProcessEnv),
    ).toBe(true);
  });

  it("unset + development → false", () => {
    expect(
      isE2EFixtureBlockEnabled({
        NODE_ENV: "development",
      } as NodeJS.ProcessEnv),
    ).toBe(false);
  });

  it("unset + test → false", () => {
    expect(
      isE2EFixtureBlockEnabled({ NODE_ENV: "test" } as NodeJS.ProcessEnv),
    ).toBe(false);
  });

  it('"true" força bloqueio em development', () => {
    expect(
      isE2EFixtureBlockEnabled({
        NODE_ENV: "development",
        BLOCK_E2E_FIXTURES: "true",
      } as NodeJS.ProcessEnv),
    ).toBe(true);
  });

  it('"false" desativa mesmo em production (escape staging)', () => {
    expect(
      isE2EFixtureBlockEnabled({
        NODE_ENV: "production",
        BLOCK_E2E_FIXTURES: "false",
      } as NodeJS.ProcessEnv),
    ).toBe(false);
  });
});
