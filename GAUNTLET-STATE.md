# ES JA catalog — Gauntlet State

Barra: SPEC.md frozen no vault; RF-06 bloqueia qualquer materialização/publicação sem `license_approval_id` documental.

## P1: parser `.slja`
- Ciclo: 3
- Status: PASSOU (validação real concluída)
- Commits: `d5ab980` → `feb586e` (autoClose) → backslash-fix → `fromBuffer` fix (yauzl.open pendura em Node 26)
- Evidência unitária: `./node_modules/.bin/vitest run test/unit/es-ja-slja.test.ts` — 5/5; typecheck; Biome limpo.
- Evidência real: validação completa do acervo local — **173/173 `.slja` ok, 0 falha, 6.174 slides** (`slja-validation.json`, via `validate-slja.mjs` com timeout 10s/arquivo).
- Bugs reais encontrados e corrigidos: nomes de entrada com `\` (legado Windows), handles não fechados, yauzl.open+fd-slicer pendurado em Node 26.
- Próximo gate: QA independente.

## P2: aquisição privada do acervo
- Status: CONCLUÍDO (privado)
- Fato: 893/893 arquivos baixados (0 falha, ~17 GB) em `/media/rafaelejosi/NovoVolume/es-ja-drive/private/`; report `private-download-report.json`.
- Downloader: `scripts/download-es-ja-private.ts` (idempotente, guard 5 GiB, retry 3, sha256, `.part` atômico), commit `b752342` + fix statfs.
- Limite: arquivamento privado autorizado; publicação bloqueada por RF-06.

## P3: materialização/publicação
- Status: BLOQUEADO
- Razão: ausência de `license_approval_id` documental, conforme RF-06. Procedência registrada (Telegram dev Louvor JA, adição antecipada) — autoriza apenas arquivamento privado.
