# Consumindo a API da Comunidade — Guia de integração (produtos LouvorJA)

> Público: devs dos produtos irmãos (Classic, Flute, Violin, PIANO) que
> consomem a API da comunidade (`/v1/custom/*`). Integração **unidirecional**:
> a comunidade do PIANO serve todo o ecossistema (ADR-003). Referência
> completa de endpoints: [`CUSTOM_API.md`](./CUSTOM_API.md).

```bash
# Defina a base uma vez e todos os exemplos abaixo funcionam:
BASE="https://api-stg.pianolouvorja.com.br"
```

## 1. Visão geral

A "comunidade" é o conjunto de coletâneas customizadas criadas por usuários
(coletâneas, músicas, letras sincronizadas, ranking, gamificação, sync
offline-first). A API é **multitenant**: cada produto do ecossistema é um
tenant e os dados são escopados por tenant — Classic não vê o catálogo da
comunidade do PIANO, e vice-versa (ADR-002/003).

## 2. Bases e ambientes

| Ambiente | Base | Uso |
|---|---|---|
| Staging | `https://api-stg.pianolouvorja.com.br` | Integração e testes — **desenvolva sempre contra STG** |
| Produção | `https://api.pianolouvorja.com.br` | Apps publicados |
| Dev local | `http://localhost:3100` | Rodando a API localmente |

Regra do ecossistema: desenvolvimento, teste e homologação usam **STG**;
produção só em release autorizado.

## 3. Autenticação

Conta **global**: um cadastro serve todos os produtos. O tenant não cria
conta nova — ele define onde a ação pontua.

Criar conta e logar (senha mínimo 8 caracteres):

```bash
# Register → 201 { "token": "...", "user": {...} }
curl -s -X POST "$BASE/v1/custom/auth/register" \
  -H "Content-Type: application/json" \
  -d '{"email":"maria.souza@example.com","password":"senha-segura-123","displayName":"Maria Souza"}'

# Login → 200 { "token": "...", "user": {...} }
curl -s -X POST "$BASE/v1/custom/auth/login" \
  -H "Content-Type: application/json" \
  -d '{"email":"maria.souza@example.com","password":"senha-segura-123"}'
```

- Sessão: **token opaco**, válido por **30 dias**; o banco guarda só o sha256.
  Envie nas rotas autenticadas: `Authorization: Bearer <token>`.
- `GET /v1/custom/auth/me` — dados da sessão; `POST /v1/custom/auth/logout`
  invalida o token (204).
- E-mail repetido → `409` (unicidade **global** entre produtos).
- `POST /v1/custom/auth/forgot-password` e `POST /v1/custom/auth/reset-password`:
  resposta **sempre 200** no forgot (não revela se o e-mail existe).
- `POST /v1/custom/auth/firebase-session`: troca um Firebase ID token por uma
  sessão da API (para clientes que já autenticam via Firebase).

## 4. Headers

| Header | Status | Detalhes |
|---|---|---|
| `Authorization: Bearer <token>` | **Obrigatório** nas rotas autenticadas | Token opaco do login/register |
| `X-Tenant: <piano\|classic\|flute\|violin>` | Opcional (default `piano`) — **na prática obrigatório para classic/flute/violin**, sem ele você lê/grava no tenant piano | Valida contra a tabela `tenants`; inválido → 400 com `valid_tenants`; resposta ecoa `X-Tenant: <resolvido>` |
| `X-Client-Platform: <valor>` | **Recomendado** (opcional na API) | Telemetria log-only, nunca bloqueia. Valores válidos: `desktop-windows`, `desktop-mac`, `desktop-linux`, `web`, `apk-android`, `apk-ios`, `palco-webos`, `palco-tizen`, `palco-androidtv`. Sem ele, fallback heurístico por User-Agent. |

> `X-Client-Version` **não existe** na API — não implemente envio dele como
> requisito. `X-Partner-Key` é outro domínio (parceiros, ver
> [`PARTNERS.md`](./PARTNERS.md)) — não misturar.

## 5. Fluxo de coletâneas end-to-end

```bash
TOKEN="<token do login>"

# 1) Listar coletâneas do seu tenant (público; paginação default 24, máx 100)
curl -s -H "X-Tenant: classic" "$BASE/v1/custom/collections?page=1&per_page=24"
# → { "data": [ { "id": 12, "name": "...", "is_owner": 0, ... } ],
#     "meta": { "total": 57, "page": 1, "per_page": 24, "last_page": 3 } }

# 2) Detalhar uma coletânea (id de exemplo)
curl -s -H "X-Tenant: classic" "$BASE/v1/custom/collections/12"

# 3) Músicas da coletânea — audio_url / instrumental_url / image_url são
#    URLs RELATIVAS sob /file (junte com a base)
curl -s -H "X-Tenant: classic" "$BASE/v1/custom/collections/12/musics"

# 4) Detalhe da música com letras sincronizadas nested (id de exemplo)
curl -s -H "X-Tenant: classic" "$BASE/v1/custom/musics/45"

# 5) Copiar música pra uma coletânea minha — idempotente por destino+nome:
#    200 se já existe, 201 se criada
curl -s -X POST -H "X-Tenant: classic" "$BASE/v1/custom/collections/99/musics/45/copy"

# 6) Criar minha própria coletânea (visibility: public|private)
curl -s -X POST -H "X-Tenant: classic" -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name":"Hinos do Culto","visibility":"public"}' \
  "$BASE/v1/custom/collections"

# 7) Sync das Minhas Coletâneas (ver seção 6)
```

Os ids acima (12, 45, 99) são **exemplos** — use os ids reais das respostas
de listagem.

## 6. Sync offline-first (resumo)

`POST /v1/custom/sync` (Bearer obrigatório): envia o estado local das Minhas
Coletâneas e recebe o estado do servidor.

- **LWW** (last-write-wins) por `client_uuid` comparando `updated_at` (ms).
  Servidor vence → estado volta no campo `conflicts` do response e o cliente
  descarta a cópia local (`server-wins`; `server-wins-forbidden` quando não é
  o dono).
- Tombstones (`deleted_at`) valem 30 dias.
- Limites: 500 collections/batch, 2000 musics/collection, 200 lyrics/music.
- Quota de mídia: 100 MB por usuário (`CUSTOM_QUOTA_MB`); excedida →
  **413** `quota_exceeded`.

Contrato completo (payloads de request/response): ver
`.planning/gauntlet/SYNC_API.md` no repositório da API.

## 7. Erros comuns e como diagnosticar

| Erro | Causa provável | O que fazer |
|---|---|---|
| `400 {"error":"Invalid tenant","valid_tenants":[...]}` | `X-Tenant` com valor inválido (typo) | Corrija usando um id de `valid_tenants` |
| `404 {"error":"Coletânea não encontrada"}` (id existe no app) | Recurso existe **em outro tenant** — leitura cross-tenant é indistinguível de inexistente (por design, não vaza existência) | Confira se está enviando o `X-Tenant` correto |
| `403 {"error":"Sem permissão"}` | Escrita em recurso de outro tenant **ou** de outro dono | Escopo errado ou falta de dono; verifique tenant e ownership |
| `401` | Token ausente/expirado | Re-login (sessão dura 30 dias) |
| `413 quota_exceeded` | Quota de mídia (100 MB) estourada | Limpar mídia excedente |
| Rate limit | Limite global por IP | Backoff e retry |
| `403` com fixture E2E | Nomes `e2e_*` / `@teste.com` / `E2E <ms>` bloqueados **em produção** | Em staging use nomes realistas ou `BLOCK_E2E_FIXTURES=false` nos testes |

Dica de debugging: toda resposta de `/v1/custom/*` ecoa o header
**`X-Tenant: <tenant resolvido>`** — confira no response qual tenant a API
aplicou na request.

## 8. Checklist de integração

- [ ] `BASE` apontando para **STG** durante desenvolvimento
- [ ] `X-Tenant` enviado em **toda** request `/v1/custom/*` (não confie no default piano)
- [ ] Header de resposta `X-Tenant` conferido no primeiro request de cada fluxo
- [ ] `Authorization: Bearer` nas rotas autenticadas; re-login tratado no 401
- [ ] Conta tratada como global (não criar conta por produto)
- [ ] `audio_url`/`instrumental_url`/`image_url` resolvidos como URLs relativas sob `/file`
- [ ] Paginação `page`/`per_page` lida do bloco `meta` (não assumir 24 fixo)
- [ ] Copy tratado como idempotente (200 existente / 201 nova)
- [ ] Sync: LWW + conflitos (`server-wins`) tratados; tombstones 30 dias; 413 tratado
- [ ] Fixtures de teste sem nomes `e2e_*`/`@teste.com` (bloqueadas em produção)
