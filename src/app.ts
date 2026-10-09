import { serveStatic } from "@hono/node-server/serve-static";
import { createNodeWebSocket } from "@hono/node-ws";
import { OpenAPIHono } from "@hono/zod-openapi";
import { apiReference } from "@scalar/hono-api-reference";
import { cors } from "hono/cors";
import { secureHeaders } from "hono/secure-headers";
import { getDbStats } from "./db/connection.js";
import { reportError } from "./lib/telemetry.js";
import { APP_VERSION } from "./lib/version.js";
import { antiBotMiddleware } from "./middleware/antiBot.js";
import { metricsHandler, metricsMiddleware } from "./middleware/metrics.js";
import { rateLimit } from "./middleware/rateLimit.js";
// SEC-6 Fase 0: telemetria log-only por IP/min (api#127) — nunca bloqueia
import { telemetryMiddleware } from "./middleware/telemetry.js";
import { compatRoutes } from "./routes/compat.js";
import { albumsRoutes } from "./v1/albums/albums.routes.js";
import { bibleRoutes } from "./v1/bible/bible.routes.js";
import { categoriesRoutes } from "./v1/categories/categories.routes.js";
import { customRoutes } from "./v1/custom/custom.routes.js";
import { syncRoutes } from "./v1/custom/sync.routes.js";
// Rotas OpenAPI (V1)
import { liturgyRoutes } from "./v1/liturgy/liturgy.routes.js";
import { musicsRoutes } from "./v1/musics/musics.routes.js";
import {
  getPalcoWs,
  palcoRoutes,
  registerPalcoWs,
  setPalcoWs,
} from "./v1/palco/palco.routes.js";
import { remoteRoutes } from "./v1/remote/remote.routes.js";

// Rotas compativeis (nao-OpenAPI)

import { createRoute, z } from "@hono/zod-openapi";
import { zodErrorHook } from "./lib/zodErrorHook.js";

export function createApp() {
  const app = new OpenAPIHono({ defaultHook: zodErrorHook });

  // Anti-bot/script kiddie (SEC-7): outermost — bloqueia UA de bots antes
  // de qualquer processamento (CORS, rate-limit, rotas)
  // SEC-7 review: escopo real da API é /v1/*. /v1/health excluído do UA-block
  // (healthcheck do container e monitores da Hostinger usam curl e precisam passar).
  app.use("/v1/*", async (c, next) => {
    if (c.req.path === "/v1/health") return next();
    return antiBotMiddleware(c, next);
  });

  // RF-03: CORS configurável via CORS_ORIGINS (default * para compat com apps)
  const corsOrigins = process.env.CORS_ORIGINS ?? "*";
  const corsConfig =
    corsOrigins === "*"
      ? {}
      : { origin: corsOrigins.split(",").map((o) => o.trim()) };
  app.use("*", cors(corsConfig));
  // SEC-3 (api#124): CSP por rota — a API não serve HTML (default-src 'none'),
  // mas DUAS superfícies servem: /palco (receiver com script inline + WS) e
  // /doc (Scalar via CDN). Override pós-secureHeaders somente nessas rotas.
  // Registrado ANTES do secureHeaders de propósito: ambos aplicam pós-next(),
  // este executa por último e vence.
  const cspOverrides: Array<[RegExp, string]> = [
    [
      /^\/palco(\/|$)/,
      "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; media-src 'self' blob:; connect-src 'self' ws: wss:",
    ],
    [
      /^\/doc$/,
      "default-src 'self'; script-src 'self' https://cdn.jsdelivr.net; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; connect-src 'self' https://cdn.jsdelivr.net",
    ],
  ];
  app.use("*", async (c, next) => {
    await next();
    const override = cspOverrides.find(([re]) => re.test(c.req.path));
    if (override) c.res.headers.set("content-security-policy", override[1]);
  });
  // RF-01: secure headers globais
  app.use(
    "*",
    secureHeaders({
      referrerPolicy: "strict-origin-when-cross-origin",
      // SEC-3 (api#124): CSP default-src 'none' — API não serve HTML
      contentSecurityPolicy: { defaultSrc: ["'none'"] },
      // CORP: bloqueia subrecursos (img/audio) de origem cruzada. Em dev
      // (CORS_ORIGINS=*) liberamos cross-origin p/ o web na 5173 e o
      // Electron carregarem mídia da API; em prod mantém same-origin.
      crossOriginResourcePolicy:
        corsOrigins === "*" ? "cross-origin" : "same-origin",
      // HSTS só quando HTTPS real estiver ativo (domínio próprio + Tunnel)
      strictTransportSecurity:
        process.env.NODE_ENV === "production"
          ? "max-age=31536000; includeSubDomains"
          : undefined,
    }),
  );
  // Rate limiting Token Bucket (boas práticas louvorja/api)
  app.use("*", rateLimit);

  // Prometheus: coleta pós-next, sem derrubar a request. /metrics fica de fora.
  app.use("*", metricsMiddleware);

  // SEC-6 Fase 0 (api#127): contagem por IP/min — LOG-ONLY, nunca bloqueia.
  // Desligável sem deploy: TELEMETRY_DISABLED=true
  app.use("*", telemetryMiddleware);

  // RF-02: error handler global — nunca vaza stack/erro cru do SQLite
  app.onError((err, c) => {
    console.error("[piano-api] unhandled error:", err.message);
    reportError(err, {
      route: c.req.routePath || "unmatched",
      method: c.req.method,
    });
    return c.json({ error: "Internal Server Error" }, 500);
  });
  app.notFound((c) => c.json({ error: "Not Found" }, 404));

  const healthRoute = createRoute({
    method: "get",
    path: "/v1/health",
    tags: ["health"],
    responses: {
      200: {
        content: {
          "application/json": {
            schema: z.object({
              status: z.string(),
              version: z.string(),
              uptime: z.number(),
              db_size: z.number(),
              tables: z.number(),
            }),
          },
        },
        description: "Healthcheck da API",
      },
    },
  });

  app.openapi(healthRoute, (c) => {
    const stats = getDbStats();
    return c.json(
      {
        status: "ok",
        version: APP_VERSION,
        uptime: Math.floor(process.uptime()),
        db_size: stats.sizeBytes,
        tables: stats.tableCount,
      },
      200,
    );
  });

  app.get("/metrics", metricsHandler);

  // WT-5J: receiver desktop/TV browser na mesma origem da API/relay.
  // `index: "index.html"` evita redirect que descartaria ?code= e ?api=.
  app.use("/palco", serveStatic({ root: "./static", index: "index.html" }));
  app.use("/palco/", serveStatic({ root: "./static", index: "index.html" }));
  app.use("/palco/*", serveStatic({ root: "./static" }));

  // Anexar roteadores Zod V1
  app.route("/v1/musics", musicsRoutes);
  app.route("/v1/albums", albumsRoutes);
  app.route("/v1/categories", categoriesRoutes);
  app.route("/", compatRoutes);

  app.route("/v1/bible", bibleRoutes);
  app.route("/v1/liturgy", liturgyRoutes);
  app.route("/v1/remote", remoteRoutes);
  app.route("/v1/custom", customRoutes);
  app.route("/v1/custom", syncRoutes);
  app.route("/v1/palco", palcoRoutes);

  // WT-5a: WS do relay do Palco — mesmo app raiz (requisito do @hono/node-ws)
  setPalcoWs(createNodeWebSocket({ app }));
  registerPalcoWs(app, getPalcoWs());

  // SEC-5 (api#126): docs e spec OpenAPI so existem fora de producao.
  // Em producao as rotas nao sao registradas e o notFound global responde 404,
  // sem entregar o mapa das rotas de negocio para enumeracao/IDOR.
  if (process.env.NODE_ENV !== "production") {
    // Registrar especificacao OpenAPI
    app.doc("/openapi.json", {
      openapi: "3.0.0",
      info: {
        version: APP_VERSION,
        title: "Piano Louvor JA API",
        description:
          "API propria drop-in replacement para api.louvorja.com.br.\n\nFornece catalogo de musicas, hinos, albuns, categorias e biblia.\n\n**Endpoints de compatibilidade** (`/json_db/*`, `/file/*`, `/db/*`) nao aparecem nesta documentacao pois usam path matching dinamico.",
      },
    });

    // Interface Scalar API Reference (https://scalar.com)
    app.get(
      "/doc",
      apiReference({
        url: "/openapi.json",
        pageTitle: "Piano Louvor JA API",
        theme: "purple",
        layout: "modern",
        defaultHttpClient: {
          targetKey: "js",
          clientKey: "fetch",
        },
      }),
    );
  }

  // Montar rotas compat ao final
  // Bypass temporario de tipagem pro Hono classico

  return app;
}
