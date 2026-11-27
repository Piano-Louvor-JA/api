import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  listOnline,
  resetPresenceForTests,
} from "../../src/lib/devicePresence.js";
import {
  resetGeoIpForTests,
  setGeoFetchForTests,
} from "../../src/lib/geoIp.js";
import {
  isPassiveClientPath,
  maybeRecordPassivePresence,
  passiveInstallId,
} from "../../src/lib/passivePresence.js";

const T0 = Date.parse("2026-11-27T11:00:00.000Z");
const PUBLIC_IP = "177.222.130.196";

describe("passivePresence", () => {
  beforeEach(() => {
    resetPresenceForTests();
    resetGeoIpForTests();
    delete process.env.DEVICE_TELEMETRY_DISABLED;
    vi.useFakeTimers();
    vi.setSystemTime(T0);
  });

  afterEach(() => {
    vi.useRealTimers();
    setGeoFetchForTests(null);
    delete process.env.DEVICE_TELEMETRY_DISABLED;
  });

  it("reconhece rotas de catálogo/mídia e ignora o resto", () => {
    expect(isPassiveClientPath("/file/musics/pt/x.mp3", "GET")).toBe(true);
    expect(isPassiveClientPath("/json_db/music_1", "GET")).toBe(true);
    expect(isPassiveClientPath("/v1/categories", "GET")).toBe(true);
    expect(isPassiveClientPath("/v1/albums/1", "HEAD")).toBe(true);
    expect(isPassiveClientPath("/v1/health", "GET")).toBe(false);
    expect(isPassiveClientPath("/v1/categories", "POST")).toBe(false);
    expect(isPassiveClientPath("/metrics", "GET")).toBe(false);
  });

  it("install_id sintético é estável no mesmo dia e muda no outro", () => {
    const a = passiveInstallId(PUBLIC_IP, "desktop-linux", "2026-11-27");
    const b = passiveInstallId(PUBLIC_IP, "desktop-linux", "2026-11-27");
    const c = passiveInstallId(PUBLIC_IP, "desktop-linux", "2026-11-28");
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-a[0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  it("request sem token em /file vira dispositivo unidentified/passive", async () => {
    process.env.GEOIP_URL = "https://geo.example/{ip}";
    setGeoFetchForTests(
      (async () =>
        new Response(
          JSON.stringify({
            city: "Conceicao do Castelo",
            region: "Espirito Santo",
            countryCode: "BR",
          }),
        )) as never,
    );

    maybeRecordPassivePresence({
      path: "/file/musics/pt/hinario/x.mp3",
      method: "GET",
      ip: PUBLIC_IP,
      platform: "desktop-linux",
      appVersion: null,
      hasPartner: false,
    });

    const { totals, devices } = listOnline(T0 + 1000);
    expect(totals).toMatchObject({
      online: 1,
      identified: 0,
      unidentified: 1,
    });
    expect(devices[0]).toMatchObject({
      identified: false,
      source: "passive",
      platform: "desktop-linux",
    });
    expect(JSON.stringify(devices)).not.toContain(PUBLIC_IP);

    await vi.waitFor(() => {
      expect(listOnline(T0 + 1000).devices[0]?.city).toBe(
        "Conceicao do Castelo",
      );
    });
  });

  it("com partner ou kill switch não registra", () => {
    maybeRecordPassivePresence({
      path: "/file/x.mp3",
      method: "GET",
      ip: PUBLIC_IP,
      platform: "desktop-windows",
      appVersion: "1.0.0",
      hasPartner: true,
    });
    expect(listOnline(T0 + 1000).totals.online).toBe(0);

    process.env.DEVICE_TELEMETRY_DISABLED = "true";
    maybeRecordPassivePresence({
      path: "/file/x.mp3",
      method: "GET",
      ip: PUBLIC_IP,
      platform: "desktop-windows",
      appVersion: null,
      hasPartner: false,
    });
    expect(listOnline(T0 + 1000).totals.online).toBe(0);
  });

  it("ignora platform site/unknown e IP privado", () => {
    maybeRecordPassivePresence({
      path: "/v1/categories",
      method: "GET",
      ip: PUBLIC_IP,
      platform: "site",
      appVersion: null,
      hasPartner: false,
    });
    maybeRecordPassivePresence({
      path: "/v1/categories",
      method: "GET",
      ip: PUBLIC_IP,
      platform: "unknown",
      appVersion: null,
      hasPartner: false,
    });
    maybeRecordPassivePresence({
      path: "/v1/categories",
      method: "GET",
      ip: "192.168.0.10",
      platform: "apk-android",
      appVersion: null,
      hasPartner: false,
    });
    expect(listOnline(T0 + 1000).totals.online).toBe(0);
  });
});
