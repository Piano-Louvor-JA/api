import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import { type SeededDb, setupSeededDb } from "../helpers/seeded-db.js";

const { registerUser } = await import("./helpers/custom-auth-helpers.js");
const { resetPresenceForTests } = await import(
  "../../src/lib/devicePresence.js"
);
const { resetGeoIpForTests, setGeoFetchForTests } = await import(
  "../../src/lib/geoIp.js"
);

/**
 * POST /v1/telemetry/heartbeat (público, nunca 4xx para o app) e
 * GET /v1/telemetry/online (admin). IP nunca sai na resposta.
 */
describe("/v1/telemetry", () => {
  let app: SeededDb;
  let adminToken: string;
  let userToken: string;
  const INSTALL_ID = "6f1c2b0e-8a4d-4c1e-9b2a-3d4e5f6a7b8c";
  const IP = "177.38.10.20";

  const body = (over: Record<string, unknown> = {}) => ({
    install_id: INSTALL_ID,
    platform: "desktop-windows",
    app_version: "1.38.0",
    os: { name: "Windows 11 Pro", release: "10.0.26100", arch: "x64" },
    locale: "pt-BR",
    timezone: "America/Sao_Paulo",
    district: "  Bertioga ",
    church: "Rio da Praia",
    ...over,
  });

  const beat = (payload: unknown, headers: Record<string, string> = {}) =>
    app.router.request("/v1/telemetry/heartbeat", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-forwarded-for": IP,
        "x-client-platform": "desktop-windows",
        ...headers,
      },
      body: typeof payload === "string" ? payload : JSON.stringify(payload),
    });

  const online = (token?: string, query = "") =>
    app.router.request(`/v1/telemetry/online${query}`, {
      headers: token ? { authorization: `Bearer ${token}` } : {},
    });

  beforeAll(async () => {
    process.env.ADMIN_EMAILS = "adm-tele@test.local";
    app = await setupSeededDb();
    adminToken = registerUser("adm-tele@test.local", "SenhaForte1!").token;
    userToken = registerUser("comum-tele@test.local", "SenhaForte1!").token;
  });

  afterAll(() => {
    process.env.ADMIN_EMAILS = "";
    delete process.env.GEOIP_URL;
    delete process.env.DEVICE_TELEMETRY_DISABLED;
    setGeoFetchForTests(null);
    app.cleanup();
  });

  beforeEach(() => {
    resetPresenceForTests();
    resetGeoIpForTests();
    delete process.env.DEVICE_TELEMETRY_DISABLED;
    process.env.GEOIP_URL = "https://geo.example/json/{ip}";
    setGeoFetchForTests(
      (async () =>
        new Response(
          JSON.stringify({ city: "Bertioga", region: "SP", countryCode: "BR" }),
        )) as never,
    );
  });

  it("heartbeat válido → 204 e aparece no /online do admin, com geo e sem IP", async () => {
    expect((await beat(body())).status).toBe(204);
    // A geo resolve fora do caminho da resposta.
    await vi.waitFor(async () => {
      const json = await (await online(adminToken)).json();
      expect(json.devices[0].city).toBe("Bertioga");
    });

    const res = await online(adminToken);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.online_window_min).toBe(11);
    expect(json.totals).toMatchObject({
      online: 1,
      by_platform: { "desktop-windows": 1 },
    });
    expect(json.devices[0]).toMatchObject({
      install_id_short: "6f1c2b",
      platform: "desktop-windows",
      app_version: "1.38.0",
      os: "Windows 11 Pro 10.0.26100 x64",
      district: "Bertioga",
      church: "Rio da Praia",
      city: "Bertioga",
      region: "SP",
      country: "BR",
      identified: false,
    });
    const raw = JSON.stringify(json);
    expect(raw).not.toContain(IP);
    expect(raw).not.toContain(INSTALL_ID);
  });

  it("corpo inválido, JSON quebrado ou install_id ruim → 204 sem gravar", async () => {
    expect((await beat("{nao-json")).status).toBe(204);
    expect((await beat(body({ install_id: "123" }))).status).toBe(204);
    expect((await beat({})).status).toBe(204);
    const json = await (await online(adminToken)).json();
    expect(json.totals.online).toBe(0);
  });

  it("campo podre é descartado, o resto grava", async () => {
    expect(
      (
        await beat(
          body({
            church: 42,
            district: "x".repeat(500),
            os: "lixo",
            platform: "tv-alien",
          }),
        )
      ).status,
    ).toBe(204);
    const [device] = (await (await online(adminToken)).json()).devices;
    expect(device.church).toBeNull();
    expect(device.district).toBeNull();
    expect(device.os).toBeNull();
    // Plataforma inválida no corpo cai no header X-Client-Platform.
    expect(device.platform).toBe("desktop-windows");
  });

  it("geo fora do ar não afeta o heartbeat", async () => {
    setGeoFetchForTests((async () => {
      throw new Error("down");
    }) as never);
    expect((await beat(body())).status).toBe(204);
    const [device] = (await (await online(adminToken)).json()).devices;
    expect(device.city).toBeNull();
  });

  it("/online: sem token 401, usuário comum 403", async () => {
    expect((await online()).status).toBe(401);
    expect((await online(userToken)).status).toBe(403);
  });

  it("/online aplica filtros por query", async () => {
    await beat(body());
    await beat(
      body({
        install_id: "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d",
        platform: "apk-android",
        church: "IASD Centro",
      }),
      { "x-client-platform": "apk-android" },
    );
    const byPlatform = await (
      await online(adminToken, "?platform=apk-android")
    ).json();
    expect(byPlatform.devices).toHaveLength(1);
    expect(byPlatform.devices[0].church).toBe("IASD Centro");
    const byQ = await (await online(adminToken, "?q=rio%20da%20praia")).json();
    expect(byQ.devices).toHaveLength(1);
  });

  it("kill switch: DEVICE_TELEMETRY_DISABLED=true responde 204 e não grava", async () => {
    process.env.DEVICE_TELEMETRY_DISABLED = "true";
    expect((await beat(body())).status).toBe(204);
    delete process.env.DEVICE_TELEMETRY_DISABLED;
    expect((await (await online(adminToken)).json()).totals.online).toBe(0);
  });

  it("só install_id: campos opcionais viram null e strings vazias são descartadas", async () => {
    expect(
      (
        await beat({
          install_id: INSTALL_ID,
          locale: "   ",
          timezone: "",
          church: "  ",
        })
      ).status,
    ).toBe(204);
    const [device] = (await (await online(adminToken)).json()).devices;
    expect(device).toMatchObject({
      app_version: null,
      os: null,
      district: null,
      church: null,
    });
  });

  it("geo que rejeita a promise não derruba o heartbeat", async () => {
    const geo = await import("../../src/lib/geoIp.js");
    const spy = vi
      .spyOn(geo, "lookupGeo")
      .mockRejectedValueOnce(new Error("reject"));
    try {
      expect((await beat(body())).status).toBe(204);
      await vi.waitFor(async () => {
        expect(spy).toHaveBeenCalled();
      });
      const [device] = (await (await online(adminToken)).json()).devices;
      expect(device.city).toBeNull();
    } finally {
      spy.mockRestore();
    }
  });
});
