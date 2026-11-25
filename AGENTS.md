# AGENTS.md — PIANO LouvorJA API

> Guide for AI agents (Claude Code, Codex, Cursor, Hermes) working on this
> repository. **Read this before writing code.**
>
> This file adds what an agent needs. It does not restate the contribution
> process — [`CONTRIBUTING.md`](./CONTRIBUTING.md) is authoritative for that,
> and if the two disagree, CONTRIBUTING wins.

---

## What this repository is

The single backend for the LouvorJA PIANO ecosystem. **Every client consumes
this API** — desktop (Electron), mobile (Flutter) and web (PWA). There is no
second backend and no client-side fallback.

| Field | Value |
|---|---|
| Stack | Hono + Zod + OpenAPI + SQLite (better-sqlite3 / Kysely) |
| Tests | Vitest |
| Lint | Biome |
| Types | TypeScript (strict) |
| Local gate | `npm run validate:pr` |

A change to a request shape, a response schema or an error envelope here breaks
three clients at once — and they fail at **runtime**, not at compile time, because
the clients are in different languages and different repositories.

---

## Before you start

1. Read `CONTRIBUTING.md` — branching, commit style, review flow.
2. Run `npm run validate:pr` **on a clean tree first**. It must be green before
   you change anything; otherwise you cannot tell your failure from a
   pre-existing one.
3. Grep for consumers before changing a contract. Anything in `src/` that shapes
   a response is consumed by three other repositories.

---

## The local gate

```bash
npm run validate:pr   # biome check + tsc --noEmit + vitest run — the one that matters
```

While iterating:

```bash
npm run lint         # biome check src/ test/
npm run lint:fix     # biome check --write
npm run typecheck    # tsc --noEmit over app + test configs
npm test             # vitest run
npm run build        # tsc -b
```

CI repeats `validate:pr`. If the remote is red, the branch is broken — fix it
before asking for review.

Hooks (Husky + lint-staged) run on commit and format staged files only. Run them
normally. `--no-verify` only when the hook itself is broken, and say so in the
pull request.

---

## Rules that prevent real breakage

**Changing a schema or payload shape is a breaking change.**
Update every consumer in the same pull request. If you cannot, it is not one pull
request — split it. Put a contract test at the boundary (Zod schema or payload
snapshot) rather than trusting each consumer's tests to catch it downstream.

**Middleware is log-only.**
Telemetry and rate limiting must never block real traffic. The only exception is
an unambiguous bot user-agent. A middleware that can reject a request changes
availability for every client.

**SQLite writes go through the existing data layer.**
Do not open a second connection or write outside the established transaction
boundary. `better-sqlite3` is synchronous by design — do not "fix" that by
wrapping the write path in promises.

**Migrations must be idempotent.**
The same migration may run twice (deploy retry, partial failure). Test the second
run. A migration that only passes once is a migration that will fail in
production.

---

## Traps that cost real time

- **`npm install`, not `pnpm install`,** even though a `pnpm-lock.yaml` is
  present. CI installs from `package-lock.json`. Mixing lockfiles installs a
  different tree than the one CI tests — and the failure shows up as a mystery
  test result, not as a version error.
- **`better-sqlite3` is a native module.** A Node version mismatch fails at
  runtime, not at install time. Use the version CI uses.
- **Zod schemas are the contract,** not a validation convenience. Changing one
  changes the public API.
- **OpenAPI is generated from the Zod schemas.** Regenerate it when schemas
  change and commit the result — a stale generated file is a broken promise to
  every client reading it.

---

## Definition of done

- [ ] `npm run validate:pr` green, and run locally — not only in CI
- [ ] Consumers of anything you changed are updated in the same change
- [ ] A test covers the new behaviour and fails without your change
- [ ] Generated files regenerated and committed
- [ ] No credentials, tokens, internal hosts or private URLs in the diff
- [ ] Pull request states the observable outcome and the validation evidence

Security issues do not go in a public issue — see `SECURITY.md`.