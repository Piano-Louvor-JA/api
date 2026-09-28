<!--
  PR Template — pianolouvorja/api
  Base: SEMPRE `staging` (DEPLOY.md). main só via PR de staging.
  Uma PR única quando a funcionalidade INTEIRA estiver pronta (F0..F5) — NÃO uma PR por fase.
  Commits por fase dentro da branch feat/...
-->

## 📋 Descrição
<!-- O que muda e por quê. Link para issue/spec se houver. -->

## ✅ Checklist de Qualidade (obrigatório)
- [ ] `npm run lint` passa
- [ ] `npm run typecheck` passa
- [ ] `npm run test` passa (cobertura ≥ threshold)
- [ ] `npm run build` passa
- [ ] Docker build + smoke test passam
- [ ] **Evidência de Regressão** preenchida abaixo

## 🔁 Evidência de Regressão (obrigatório — anti-regressão)
| Métrica | Baseline (staging) | Pós-mudança (esta PR) |
|---------|-------------------|----------------------|
| Testes passed | | |
| Testes failed | | |
| Typecheck | OK / FAIL | OK / FAIL |
| Build | OK / FAIL | OK / FAIL |

**Como obter:**
```bash
# 1. Em staging (baseline)
git checkout staging && git pull
npm run test:regression -- --baseline

# 2. Na branch da PR (comparação)
git checkout feat/sua-branch
npm run test:regression -- --compare
```
Cole os números acima. Se houver regressão → **PR não passa no CI** (gate `regression-gate`).

## 🎯 Consumidores impactados (paridade api↔app↔web↔APK)
- [ ] Nenhum (mudança isolada)
- [ ] `pianolouvorja/app` (desktop Electron) — endpoints: ____
- [ ] `pianolouvorja/web` (Vue 3) — endpoints: ____
- [ ] `pianolouvorja/apk` (Flutter) — endpoints: ____
- [ ] Outro: ____

## 🧪 Como testar localmente
```bash
# passos para reproduzir/validar
```
