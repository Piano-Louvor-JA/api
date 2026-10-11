# ES JA catalog — Gauntlet State

Barra: SPEC.md frozen no vault; RF-06 bloqueia qualquer materialização/publicação sem `license_approval_id` documental.

## P1: parser `.slja`
- Ciclo: 1
- Status: PASSOU localmente
- Commit: `d5ab980`
- Evidência: `npx vitest run test/unit/es-ja-slja.test.ts test/unit/es-ja-manifest.test.ts` — 7/7; `npm run typecheck`; Biome nos 4 arquivos ES; `git diff --check`.
- Próximo gate: QA independente.

## P2: aquisição privada do acervo
- Status: pendente
- Fato: manifest contém 893 entradas; Drive endpoint confirmado; somente 8/173 `.slja` locais.
- Limite: arquivamento privado autorizado; publicação bloqueada por RF-06.
- Próximo comando: implementar downloader idempotente com limite de concorrência e checksums, sem inserir/publicar DB.

## P3: materialização/publicação
- Status: BLOQUEADO
- Razão: ausência de `license_approval_id` documental, conforme RF-06.
