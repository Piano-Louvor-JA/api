# PLAN: Token de parceiro

1. T1 Migration `031_partner_keys.sql` (RF-04, RF-06) + teste de idempotência.
2. T2 `src/lib/partnerKeys.ts`: gerar, hashear, criar, listar, revogar e
   buscar por token (RF-04, RF-05) — testes unit primeiro.
3. T3 `src/middleware/partnerKey.ts` (RF-01..03) + métrica
   `partner_requests_total` — testes unit primeiro.
4. T4 Montar o middleware em `app.ts` antes do rate limit + teste de
   integração com o app real (sem header / válido / inválido / revogado).
5. T5 CLI `src/cli/partners.ts` (`run(argv, out)` testável) + script npm.
6. T6 Docs: `docs/PARTNERS.md` (uso pelo parceiro e operação na VPS) e
   `.env.example` sem mudanças (nada novo em env).
7. T7 `npm run validate:pr` + build no Node 22.
