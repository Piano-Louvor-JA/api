# Deploy — variáveis de ambiente

O piano-api é configurado 100% por env vars. Sem nenhuma delas, roda com defaults
de desenvolvimento (OK para dev local, NÃO ok para produção).

## Banco de dados

| Env | Default | Descrição |
|-----|---------|-----------|
| `DB_PATH` | `./data/catalog.db` | Caminho do SQLite. **Produção deve apontar para volume persistente** (ex.: `/data/catalog.db` no container). |

**Importante (B18 — ambientes separados):** dev/staging/prod devem ter bancos
físicos separados. Como o `DB_PATH` é por processo, basta cada ambiente definir
o seu:

- dev local: não seta (usa `./data/catalog.db` do repo, gitignored)
- staging: `DB_PATH=/data/staging-catalog.db`
- prod: `DB_PATH=/data/catalog.db`

As migrations (001→023) aplicam sozinhas no boot, statement-a-statement
(idempotentes — re-execução sem erro, lição api#88).

## Quota de mídia custom

| Env | Default | Descrição |
|-----|---------|-----------|
| `CUSTOM_QUOTA_MB` | `100` | Quota de mídia custom por usuário, em MB. Upload acima → HTTP 413. |

Arquivos de mídia vão para `media/custom/{user_id}/{kind}/` relativo ao cwd.
Em produção com container, monte `media/` em volume persistente junto do DB.

## Runbook: limpeza de coletâneas de teste no prod (B8)

As coletâneas de teste ("tt", "kiki", "Person", "probe-test", "teste") existem
no banco de produção e devem ser removidas após o merge do offline-first.

**Executar APENAS com aprovação do Rafael ou Ezequias, e sempre com backup prévio:**

```bash
# 1. Backup (no host do container)
sqlite3 /data/catalog.db ".backup /data/backup-$(date +%Y%m%d-%H%M).db"

# 2. Ver o que será removido (dry run — só SELECT)
ssh root@31.97.159.123
docker exec -w /app NODE_PATH=/app/node_modules node -e "
const db = require('better-sqlite3')(process.env.DB_PATH || '/data/catalog.db');
const rows = db.prepare(\"SELECT id_collection, name, owner_id FROM custom_collections WHERE name IN ('tt','kiki','Person','probe-test','teste')\").all();
console.log(rows);
"

# 3. Aplicar (script preparado, idempotente)
docker cp scripts/cleanup-test-collections.sql <container>:/tmp/
docker exec -w /app node -e "
const db = require('better-sqlite3')('/data/catalog.db');
require('fs').readFileSync('/tmp/cleanup-test-collections.sql','utf8')
  .split(';\n').filter(s=>s.trim()).forEach(stmt => db.exec(stmt));
"

# 4. Verificação (B8: contagem = 0)
docker exec -w /app node -e "
const db = require('better-sqlite3')('/data/catalog.db');
console.log(db.prepare(\"SELECT COUNT(*) c FROM custom_collections WHERE name IN ('tt','kiki','Person','probe-test','teste')\").get());
"
```

## Checklist de deploy

1. `DB_PATH` apontando para volume persistente (não para cwd do container)
2. Volume para `media/` (mídia custom)
3. `CUSTOM_QUOTA_MB` definido explicitamente (mesmo que = default)
4. Após start: `GET /v1/health` 200 e logs sem erro de migration
5. Se B8 pendente: runbook acima

## Telemetria de requests por IP/min (SEC-6 Fase 0 — api#127)

Middleware **log-only**: conta requests por IP/minuto e emite 1 linha de log
estruturada por IP/minuto. NÃO bloqueia, NÃO limita, NÃO altera resposta —
é pré-requisito para decidir thresholds de rate limit com dados reais
(mín. 2–4 semanas, incluindo sábados) antes de qualquer Fase 1.

| Env | Default | Descrição |
|-----|---------|-----------|
| `TELEMETRY_DISABLED` | `false` | `true` desliga a coleta (kill switch sem deploy). Log-only, zero risco a tráfego. |

Formato do log (stdout, 1 linha por IP/minuto):

```
[telemetry] {"minute":"2026-10-03T19:04","ip":"203.0.113.5","total":7,"routes":{"GET /v1/musics":5,"GET /v1/albums":2}}
```

Gerar o relatório p95/p99 (requests por IP/min) a partir dos logs:

```bash
docker logs piano-api 2>&1 | npx tsx scripts/analyze-telemetry.ts
# ou de um arquivo salvo:
npx tsx scripts/analyze-telemetry.ts saturdays-logs.txt --json
# validação do parser/percentis com distribuição conhecida:
npx tsx scripts/analyze-telemetry.ts --self-test
```

Saída: p95/p99/max por minuto + agregado da janela, top IPs e top rotas —
insumo para o threshold da Fase 1 (mínimo 5x o p99 de sábado, issue #127).
