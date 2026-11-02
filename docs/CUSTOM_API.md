# API — Endpoints Custom (coletâneas customizadas)

> Fonte viva: `GET /openapi.json` (spec OpenAPI 3 gerada do código por @hono/zod-openapi).
> Snapshot completo versionado: [`docs/openapi.json`](./openapi.json) — **stale**: não contém o header `X-Tenant` ainda; será regenerado no merge de `feat/community-multitenant-mt1`.
> Swagger UI interativo: `http://localhost:3100/doc` (dev) / `https://api.pianolouvorja.com.br/doc` (prod).

Última atualização: 2026-11-02 (feat/community-multitenant-docs).

## Autenticação (login simples, sem JWT)

Autenticação por **token opaco** (string aleatória de 32 bytes). O banco guarda apenas o sha256 do token — o valor puro existe só na resposta de register/login. Sessões expiram em 30 dias.

| Método | Endpoint | Auth | Descrição |
|---|---|---|---|
| POST | `/v1/custom/auth/register` | — | Cria conta `{ email, password, displayName }` → `{ token, user }` (201) |
| POST | `/v1/custom/auth/login` | — | `{ email, password }` → `{ token, user }` (200) |
| GET | `/v1/custom/auth/me` | Bearer | Dados da sessão atual (401 se inválido/expirado) |
| POST | `/v1/custom/auth/logout` | Bearer | Invalida o token (204) |
| POST | `/v1/custom/auth/firebase-session` | — | Troca um Firebase ID token por sessão da API (bridge Firebase → token opaco) |
| POST | `/v1/custom/auth/forgot-password` | — | Registra pedido de reset; **responde 200 sempre** (não revela se o e-mail existe) |
| POST | `/v1/custom/auth/reset-password` | — | Redefine a senha usando o código de reset |

Header de autenticação: `Authorization: Bearer <token>`

- Senhas: PBKDF2-SHA256, 100k iterações, salt aleatório por usuário (node:crypto, zero deps externas).
- E-mail é único **globalmente** entre os produtos da comunidade (409 se repetido) — uma conta serve todos os tenants (ver [Multitenancy](#multitenancy-header-x-tenant) e o guia [`COMMUNITY_GUIDE.md`](./COMMUNITY_GUIDE.md)).
- Erros: 400 (payload inválido), 401 (credenciais/token), 409 (e-mail existe).

## Multitenancy (header `X-Tenant`)

A API da comunidade é **multitenant**: cada produto do ecossistema LouvorJA é um tenant (`piano`, `classic`, `flute`, `violin` — ADR-002/003). Todas as rotas sob `/v1/custom/*` (inclusive `/v1/custom/sync`) escopam leitura e escrita pelo tenant resolvido do header `X-Tenant`.

**Tenants válidos** (fonte de verdade: tabela `tenants`, migration `027_community_multitenancy.sql`):

| id | name |
|---|---|
| `piano` | LouvorJA PIANO |
| `classic` | LouvorJA Clássico |
| `flute` | LouvorJA Flute |
| `violin` | LouvorJA Violin |

**Comportamento do header** (`src/middleware/tenant.middleware.ts`):

| Cenário | Comportamento |
|---|---|
| `X-Tenant` ausente | Assume `piano` — apps legados sem o header continuam idênticos (retrocompatível; testado: resposta implícita == explícita) |
| `X-Tenant: classic` (ou outro válido) | Request escopada ao tenant; resposta ecoa `X-Tenant: classic` (header de resposta) |
| `X-Tenant: banana` (inválido) | `400 {"error":"Invalid tenant","valid_tenants":["classic","flute","piano","violin"]}` (ordem alfabética) |

**Cross-tenant** (recurso de outro produto):

- **Leitura (GET)** → `404` com corpo **indistinguível** de recurso inexistente (não vaza existência):

  | Rota | Corpo do 404 |
  |---|---|
  | `GET /collections/{id}` | `{"error":"Coletânea não encontrada"}` |
  | `GET /collections/{id}/musics` | `{"error":"Coletânea não encontrada"}` |
  | `GET /musics/{id}` | `{"error":"Música não encontrada"}` |
  | `GET /musics/{id}/lyrics` | `{"error":"Música não encontrada"}` |
  | `POST /collections/{id}/use` | `{"error":"Coletânea não encontrada"}` (404; sem 403) |

- **Escrita (POST/PUT/DELETE)** → probe de existência decide: id existe em outro tenant → `403 {"error":"Sem permissão"}`; id não existe em nenhum → `404 {"error":"<Recurso> não encontrad*"}`. Mensagem **uniforme** "Sem permissão" em todos os 403 de cross-tenant.
- **Escopo por tenant também em**: listagem de coletâneas, `GET /musics` (todas), ranking (via `custom_users.tenant_id`), evento sazonal e sync.
- **Auth NÃO é escopada** (identidade global): register/login/me/logout/forgot/reset/firebase-session — uma conta serve todos os produtos; o tenant da request determina onde a ação pontua/gravita, não quem é o usuário.

**Exemplos** (base staging — os 4 produtos; `X-Tenant: piano` é o default explícito):

```bash
BASE="https://api-stg.pianolouvorja.com.br"

# Piano (default explícito)
curl -s -H "X-Tenant: piano" "$BASE/v1/custom/collections"

# Clássico
curl -s -H "X-Tenant: classic" "$BASE/v1/custom/collections"

# Flute
curl -s -H "X-Tenant: flute" "$BASE/v1/custom/collections"

# Violin
curl -s -H "X-Tenant: violin" "$BASE/v1/custom/collections"

# Tenant inválido → 400 com valid_tenants
curl -s -H "X-Tenant: banana" "$BASE/v1/custom/collections"
```

> **Nota:** sem o header, apps existentes leem/gravam no tenant `piano` — portanto **classic/flute/violin devem sempre enviar `X-Tenant`** para não ver o catálogo piano.

## Coletâneas custom

Modelo de acesso: **leitura pública global, escrita só pelo dono.**
- Qualquer pessoa (sem login) lista e lê tudo — coletâneas da comunidade.
- Criar exige estar logado; a coletânea nasce com `owner_id` do criador.
- Editar/remover exige ser o dono (403 caso contrário).
- Coletâneas antigas (sem dono, `owner_id IS NULL`) permanecem editáveis por qualquer usuário autenticado — legado da fase pré-auth.
- Respostas de listagem incluem `is_owner` (1/0) calculado para a sessão atual.
- `visibility`: `public` ou `private` (privada de outro dono → 404 na leitura, como qualquer inexistente).

| Método | Endpoint | Auth | Descrição |
|---|---|---|---|
| GET | `/v1/custom/collections` | opcional | Lista do tenant (públicas + suas privadas) + `is_owner`; paginação `?page=1&per_page=24` (máx 100) → `data[]` + `meta{total,page,per_page,last_page}` |
| POST | `/v1/custom/collections` | Bearer | Cria coletânea `{ name, description?, author_name?, visibility? }` |
| GET | `/v1/custom/collections/{id}` | — | Detalhe; privada de outro dono → 404 |
| PUT | `/v1/custom/collections/{id}` | Bearer+dono | Renomeia/descreve |
| DELETE | `/v1/custom/collections/{id}` | Bearer+dono | Remove (cascade nas músicas) |
| POST | `/v1/custom/collections/{id}/use` | Bearer | Registra uso (+5 pontos ao dono na 1ª vez por usuário); também é leitura (404 cross-tenant) |
| POST | `/v1/custom/collections/{id}/report` | Bearer | Reporta coletânea `{ reason, ... }` |

## Músicas custom

| Método | Endpoint | Auth | Descrição |
|---|---|---|---|
| GET | `/v1/custom/musics` | — | Todas as músicas do tenant (p/ seletor) |
| GET | `/v1/custom/collections/{id}/musics` | — | Músicas da coletânea |
| POST | `/v1/custom/collections/{id}/musics` | Bearer+dono | Cria música `{ name, lyric?, ... }` |
| GET | `/v1/custom/musics/{id}` | — | Detalhe com lyrics nested (404 cross-tenant) |
| POST | `/v1/custom/collections/{id}/musics/{musicId}/copy` | — | Copia música p/ outra coletânea — **idempotente por destino+nome**: 200 se já existe / 201 nova. *Nota: hoje esta rota não exige Bearer nem checagem de dono (hardening planejado em card próprio).* |
| PUT | `/v1/custom/musics/{id}` | Bearer+dono | Atualiza música |
| DELETE | `/v1/custom/musics/{id}` | Bearer+dono | Remove (cascade nas estrofes) |

Dedup: POST de música com `client_uuid` já existente retorna **200** (existente) em vez de 201 (migration 028).

## Letras (estrofes sincronizadas)

| Método | Endpoint | Auth | Descrição |
|---|---|---|---|
| GET | `/v1/custom/musics/{id}/lyrics` | — | Estrofes da música |
| POST | `/v1/custom/musics/{id}/lyrics` | Bearer+dono | Cria estrofe |
| PUT | `/v1/custom/lyrics/{id}` | Bearer+dono | Atualiza estrofe |
| DELETE | `/v1/custom/lyrics/{id}` | Bearer+dono | Remove estrofe |

## Gamificação

| Método | Endpoint | Auth | Descrição |
|---|---|---|---|
| GET | `/v1/custom/ranking?window=week\|all` | — | Ranking do tenant (via `custom_users.tenant_id`) |
| GET | `/v1/custom/ranking/me` | Bearer | Posição do usuário autenticado |
| GET | `/v1/custom/weekly-tasks` | Bearer | Tarefas semanais do usuário |
| POST | `/v1/custom/weekly-tasks/{taskId}/complete` | Bearer | Completa tarefa (+15 pontos, idempotente) |

## Curadoria

| Método | Endpoint | Auth | Descrição |
|---|---|---|---|
| POST | `/v1/custom/admin/promote-music` | Bearer+curador | Promove música custom ao catálogo; curadores via `CURATOR_USER_IDS` (fail-closed) |

## Notificações

| Método | Endpoint | Auth | Descrição |
|---|---|---|---|
| GET | `/v1/custom/notifications` | Bearer | Notificações do usuário |
| POST | `/v1/custom/notifications/read-all` | Bearer | Marca todas como lidas |

## Evento sazonal

| Método | Endpoint | Auth | Descrição |
|---|---|---|---|
| GET | `/v1/custom/seasonal-event` | — | Banner do evento sazonal do tenant (público) |

## Sync offline-first

| Método | Endpoint | Auth | Descrição |
|---|---|---|---|
| POST | `/v1/custom/sync` | Bearer | Sincronização offline-first das Minhas Coletâneas — LWW por `client_uuid`, tombstones 30 dias, limites 500 collections/batch / 2000 musics / 200 lyrics, quota 100 MB (`CUSTOM_QUOTA_MB`; excedida → **413** `quota_exceeded`). Rota procedural, **fora do OpenAPI**; contrato completo em [`.planning/gauntlet/SYNC_API.md`](../.planning/gauntlet/SYNC_API.md) |

## Arquivos (upload de mídia)

| Método | Endpoint | Auth | Descrição |
|---|---|---|---|
| POST | `/v1/custom/files` | Bearer | Upload multipart/form-data (áudio/instrumental/capa) → URL relativa |

Servidos em `GET /file/custom/...` (público, mesma base `/file` do catálogo oficial). Quota de 100 MB por usuário; excedida → 413.

## Códigos de erro

| Status | Significado |
|---|---|
| 400 | Payload inválido (Zod rejeitou) **ou** tenant inválido (corpo `{"error":"Invalid tenant","valid_tenants":[...]}`) |
| 401 | Não autenticado / token inválido ou expirado |
| 403 | Autenticado mas não é dono do recurso **ou** escrita cross-tenant (`"Sem permissão"`) **ou** fixture E2E bloqueada em produção (`e2e_*`/`@teste.com`/`E2E <ms>`; `BLOCK_E2E_FIXTURES=false` desliga em staging) |
| 404 | Recurso não existe **ou** existe em outro tenant (leitura cross-tenant — corpo indistinguível, por design) |
| 409 | E-mail já cadastrado (único global) |
| 413 | Quota de mídia excedida (sync/upload, 100 MB) |
| 422 | Register com payload inválido |

## Consumo por cliente

- **Web/Electron (desktop)**: leitura + escrita (login no editor de mídia). Sessão em `localStorage` (chave `louvorja.custom.auth`).
- **APK (mobile)**: v1 somente **leitura** — lista coletâneas, baixa (registro local via SharedPreferences), detalhe de música com letra sincronizada. Upload/edição fica no desktop.
- **Delphi**: sem mudança — custom é ecosystem novo, catálogo oficial (`/json_db/*`) intocado.
- **Produtos irmãos (classic/flute/violin)**: ver guia de integração [`COMMUNITY_GUIDE.md`](./COMMUNITY_GUIDE.md) — enviar sempre `X-Tenant`; onboarding completo lá.

## Migrações relacionadas

- `017_custom_collections.sql` — tabela base de coletâneas custom.
- `018_custom_collections_cover.sql` — capa de coletânea.
- `019_custom_musics_official_link.sql` — link música custom ↔ oficial.
- `020_custom_musics_nullable_name.sql` — nome nullable na música custom.
- `021_custom_auth.sql` — tabelas `custom_users`, `custom_sessions` (auto-aplicadas no boot).
- `022_custom_auth_ownership.sql` — `owner_id` + `author_name` nas tabelas custom, índices.
- `023_custom_password_reset.sql` — fluxo de reset de senha.
- `024_custom_visibility.sql` — coluna `visibility` (public/private) nas coletâneas.
- `025_ranking_gamification.sql` — ranking e gamificação escopados por `custom_users`.
- `026_firebase_auth_bridge.sql` — bridge de sessão Firebase.
- `027_community_multitenancy.sql` — **multitenancy**: tabela `tenants` + `tenant_id` em `custom_collections`, `custom_users`, `seasonal_events`; nota de deploy em [`DEPLOY_027_MULTITENANT.md`](./DEPLOY_027_MULTITENANT.md).
- `028_custom_musics_dedup.sql` — dedup por `client_uuid` (POST → 200 em vez de 201).
- `029_files_url_unique.sql` — unicidade de URL de arquivo.
- `031_partner_keys.sql` — chaves de parceiros (ver [`PARTNERS.md`](./PARTNERS.md)).

## Pendente (fase 2)

- Rate limit específico em auth (hoje usa o global de 100/min).
- Refresh token (hoje: re-login após 30 dias).
- Hardening da rota `copy` (exigir Bearer + owner-check) — card próprio.
- APK: upload/edição de coletâneas + "Minhas Baixadas" na UI.
