import { readFileSync } from "node:fs";
import vm from "node:vm";
import { expect, it } from "vitest";
import { receiverIdentityScript } from "../../src/lib/receiverIdentity.js";

it("receiver servido pela API recebe parceiro por ambiente sem chave na URL", async () => {
  const calls: Array<{ input: unknown; init: RequestInit }> = [];
  const context = vm.createContext({
    URL,
    Headers,
    Request,
    location: { href: "https://api-stg.pianolouvorja.com.br/palco/" },
    window: {
      fetch: async (input: unknown, init: RequestInit) => {
        calls.push({ input, init });
        return {};
      },
    },
  });
  vm.runInContext(
    receiverIdentityScript({
      PALCO_PARTNER_KEY_STG: "plj_palco_stg_teste",
      PALCO_PARTNER_KEY_PROD: "plj_palco_prod_teste",
    }),
    context,
  );
  for (const host of [
    "api-stg.pianolouvorja.com.br",
    "api.pianolouvorja.com.br",
    "external.test",
  ]) {
    await context.window.fetch(`https://${host}/v1/palco/sessions`);
  }
  expect(new Headers(calls[0]?.init.headers).get("X-Partner-Key")).toBe(
    "plj_palco_stg_teste",
  );
  expect(new Headers(calls[1]?.init.headers).get("X-Partner-Key")).toBe(
    "plj_palco_prod_teste",
  );
  expect(new Headers(calls[2]?.init.headers).has("X-Partner-Key")).toBe(false);
  expect(new Headers(calls[0]?.init.headers).get("X-Client-Platform")).toBe(
    "palco-browser",
  );
  expect(
    new Headers(calls[0]?.init.headers).get("X-Client-Version"),
  ).toBeTruthy();
  expect(String(calls[0]?.input)).not.toContain("plj_");
  expect(readFileSync("static/palco/index.html", "utf8")).toContain(
    "/palco/client-identity.js",
  );
});

it("configuração inválida/ausente omite chaves e não incorpora código arbitrário", () => {
  const script = receiverIdentityScript({ PALCO_PARTNER_KEY_STG: "</script>" });
  expect(script).toContain('"staging":""');
  expect(script).not.toContain("</script>");
});
