# Piano Louvor JA — API

![CI](https://img.shields.io/github/actions/workflow/status/Piano-Louvor-JA/api/ci.yml?branch=main&label=CI)
![Release](https://img.shields.io/github/v/release/Piano-Louvor-JA/api?include_prereleases)
![License](https://img.shields.io/badge/license-MIT-blue)
![Platform](https://img.shields.io/badge/platform-Node%2022%20%7C%20Docker-lightgrey)

REST API for the Louvor JA (Piano) system. Serves hymnal data, albums, musics, lyrics, and bible references with full OpenAPI documentation.

## Tech Stack

| Layer        | Technology                              |
| ------------ | --------------------------------------- |
| Framework    | [Hono](https://hono.dev) + Zod OpenAPI  |
| Validation   | [Zod](https://zod.dev) schemas → OpenAPI|
| Database     | SQLite (`better-sqlite3` + Kysely)      |
| Linter       | [Biome](https://biomejs.dev)            |
| Tests        | [Vitest](https://vitest.dev) + coverage |
| API Docs     | [Scalar](https://scalar.com) at `/doc`  |
| Container    | Docker (Node 22)                        |

## Quick Start

```bash
git clone https://github.com/pianolouvorja/api.git
cd api
npm install
npm run dev          # http://localhost:3000
```

API documentation available at `http://localhost:3000/doc` (Scalar UI).

## Scripts

```bash
npm run dev            # development with hot reload
npm run build          # compile TypeScript
npm run start          # run compiled output
npm run typecheck      # tsc --noEmit
npm run lint           # biome check
npm run test           # vitest run
npm run test:coverage  # vitest with coverage report
npm run test:watch     # vitest in watch mode
```

## Project Structure

```
src/
  app.ts               # Hono app + Scalar setup
  routes/
    compat.ts          # /json_db/* and /file/* compatibility routes
  v1/
    categories/        # /v1/categories
    albums/            # /v1/albums
    musics/            # /v1/musics
    bible/             # /v1/bible
  db/
    migrations/        # SQL migrations (001-014)
scripts/
  import-upstream.ts   # mirror data from api.louvorja.com.br
data/
  catalog.db           # SQLite database
```

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md) for the full guide.

TL;DR: branch from `staging`, open PR against `staging`, CI must pass, one approval required.

## License

[MIT](./LICENSE) © Piano Louvor JA
