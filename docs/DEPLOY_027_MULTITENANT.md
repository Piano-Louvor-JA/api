# Deploy — Migration 027 (multitenancy da comunidade)

> Migration: `src/db/migrations/027_community_multitenancy.sql`
> Prova: PASS 16/16 checks em 2026-10-29T20:50:31Z
> (`multitenant-tenant-model/RESULTADO.md`, vault — método na seção 6).

## 1. O que muda

| Mudança | Detalhe |
|---|---|
| Tabela nova | `tenants` (`id` TEXT PK, `name`, `created_at`) + 4 âncoras `INSERT OR IGNORE`: `piano` (LouvorJA PIANO), `classic` (LouvorJA Clássico), `flute` (LouvorJA Flute), `violin` (LouvorJA Violin) |
| Colunas novas | `tenant_id TEXT NOT NULL DEFAULT 'piano'` em `custom_collections`, `custom_users`, `seasonal_events` |
| Índice novo | `idx_custom_collections_tenant (tenant_id, visibility)` |
| Sem FK física | SQLite não permite `ADD COLUMN` com `REFERENCES` + DEFAULT NOT NULL; validação de tenant fica no middleware (`tenant.middleware.ts`), que valida contra a tabela `tenants` antes de toda query da comunidade |

Backfill: toda linha existente herda `tenant_id = 'piano'` (inclui coletâneas
órfãs do catálogo oficial).

## 2. Ordem de rollout

1. **Backup** do banco antes do deploy:
   ```bash
   sqlite3 /caminho/do/banco.db ".backup /caminho/do/banco-pre-027.db"
   ```
2. **Deploy do código**. As migrations aplicam **sozinhas no boot**,
   statement-a-statement, em ordem alfabética de filename. `027_community_multitenancy.sql`
   **coexiste** com `027_bible_es_catalog.sql` e `027_operator_state.sql` — as
   três rodam juntas, em ordem alfabética, sem dependência entre si (provado na
   fase F1 da seção 6).
3. **Verificação pós-deploy** (seção 3).

## 3. Verificação pós-deploy

```bash
# tenants = 4
sqlite3 $DB "SELECT COUNT(*) FROM tenants;"                       # → 4

# tenant_id presente nas 3 tabelas
sqlite3 $DB "SELECT name FROM pragma_table_info('custom_collections') WHERE name='tenant_id';"
sqlite3 $DB "SELECT name FROM pragma_table_info('custom_users') WHERE name='tenant_id';"
sqlite3 $DB "SELECT name FROM pragma_table_info('seasonal_events') WHERE name='tenant_id';"

# Smoke default (sem header) → 200 + header de resposta X-Tenant: piano
curl -si https://api-stg.pianolouvorja.com.br/v1/custom/collections | grep -i "^x-tenant"

# Smoke tenant irmão → 200 + X-Tenant: violin
curl -si -H "X-Tenant: violin" https://api-stg.pianolouvorja.com.br/v1/custom/collections | grep -i "^x-tenant"

# Smoke inválido → 400 com valid_tenants
curl -s -H "X-Tenant: banana" https://api-stg.pianolouvorja.com.br/v1/custom/collections
# → {"error":"Invalid tenant","valid_tenants":["classic","flute","piano","violin"]}
```

## 4. Idempotência

Replay de boot é **seguro**: a fase F2 da prova reexecutou as 30 migrations
sobre um banco já migrado — zero perda de dados e âncoras de tenant não
duplicadas (`INSERT OR IGNORE`). O migrador engole `duplicate column name`
(lição api#88), então o `ALTER TABLE ... ADD COLUMN` repetido não falha.

## 5. Rollback

Forward-only: a migration não tem down script. Para reverter:

1. Restaurar o backup da seção 2 (`mv banco-pre-027.db banco.db`).
2. Redeploy da versão de código anterior.

Seguro porque o código antigo **tolera** as colunas/índices novos (o
`tenant_id` tem DEFAULT `'piano'`, e apps que não enviam `X-Tenant` continuam
no tenant piano — retrocompatibilidade testada).

## 6. Prova de 3 fases (referência)

Resultado: **PASS — 16/16 checks, 2026-10-29T20:50:31Z** (0 falhas).

| Fase | O que prova |
|---|---|
| F1 — upgrade com dados | Tabela `tenants` + 4 produtos; backfill 100% piano em collections/users/seasonal_events; ranking e catálogo escopados |
| F2 — replay de boot | Idempotência total: zero perda de dados, âncoras não duplicadas |
| F3 — deploy novo | DB fresca sobe com 027 sem erro; `tenant_id` presente nas 3 tabelas |

Como reexecutar:

```bash
node scripts/prove-027.cjs src/db/migrations /tmp/prove-027-out
```
