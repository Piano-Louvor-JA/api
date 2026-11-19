# API — Endpoints Custom (coletâneas customizadas)

> Fonte viva: `GET /openapi.json` (spec OpenAPI 3 gerada do código por @hono/zod-openapi).
> Snapshot completo versionado: [`docs/openapi.json`](./openapi.json).
> Swagger UI interativo: `http://localhost:3100/doc` (dev) / `https://api.pianolouvorja.com.br/doc` (prod).

Última atualização: 2026-09-10 (feat/custom-auth).

## Autenticação (login simples, sem JWT)

Autenticação por **token opaco** (string aleatória de 32 bytes). O banco guarda apenas o sha256 do token — o valor puro existe só na resposta de register/login. Sessões expiram em 30 dias.

| Método | Endpoint | Auth | Descrição |
|---|---|---|---|
| POST | `/v1/custom/auth/register` | — | Cria conta `{ email, password, displayName }` → `{ token, user }` (201) |
| POST | `/v1/custom/auth/login` | — | `{ email, password }` → `{ token, user }` (200) |
| GET | `/v1/custom/auth/me` | Bearer | Dados da sessão atual (401 se inválido/expirado) |
| POST | `/v1/custom/auth/logout` | Bearer | Invalida o token (204) |
| DELETE | `/v1/custom/auth/me` | Bearer | Exclui a conta (204). Body `{ "password": "..." }` obrigatório em contas com senha (400 sem senha, 403 senha errada). Coletâneas privadas são apagadas; as públicas ficam na comunidade sem autor, sob o usuário-sistema "Conta excluída" |
| POST | `/v1/custom/collections/{id}/block-author` | Bearer | Bloqueia o autor da coletânea: as coletâneas dele somem da listagem para quem bloqueou (400 se a coletânea é sua ou não tem autor) |
| GET | `/v1/custom/blocks` | Bearer | Lista os autores bloqueados (`id_user`, `displayName`) |
| DELETE | `/v1/custom/blocks/{id}` | Bearer | Desbloqueia o autor (204) |

Header de autenticação: `Authorization: Bearer <token>`.

- Senhas: PBKDF2-SHA256, 100k iterações, salt aleatório por usuário (node:crypto, zero deps externas).
- E-mail é único (409 se repetido).
- Erros: 400 (payload inválido), 401 (credenciais/token), 409 (e-mail existe).

## Coletâneas custom

Modelo de acesso: **leitura pública global, escrita só pelo dono.**
- Qualquer pessoa (sem login) lista e lê tudo — coletâneas da comunidade.
- Criar exige estar logado; a coletânea nasce com `owner_id` do criador.
- Editar/remover exige ser o dono (403 caso contrário).
- Coletâneas antigas (sem dono, `owner_id IS NULL`) permanecem editáveis por qualquer usuário autenticado — legado da fase pré-auth.
- Respostas de listagem incluem `is_owner` (1/0) calculado para a sessão atual.

| Método | Endpoint | Auth | Descrição |
|---|---|---|---|
| GET | `/v1/custom/collections` | opcional | Lista todas (público) + `is_owner` |
| POST | `/v1/custom/collections` | Bearer | Cria coletânea `{ name, description?, author_name? }` |
| PUT | `/v1/custom/collections/{id}` | Bearer+dono | Renomeia/descreve |
| DELETE | `/v1/custom/collections/{id}` | Bearer+dono | Remove (cascade nas músicas) |

## Músicas custom

| Método | Endpoint | Auth | Descrição |
|---|---|---|---|
| GET | `/v1/custom/collections/{id}/musics` | — | Músicas da coletânea |
| POST | `/v1/custom/collections/{id}/musics` | Bearer+dono | Cria música `{ name, lyric?, ... }` |
| POST | `/v1/custom/collections/{id}/musics/{musicId}/copy` | Bearer+dono | Copia música p/ outra coletânea |
| PUT | `/v1/custom/musics/{id}` | Bearer+dono | Atualiza música |
| DELETE | `/v1/custom/musics/{id}` | Bearer+dono | Remove (cascade nas estrofes) |

## Letras (estrofes sincronizadas)

| Método | Endpoint | Auth | Descrição |
|---|---|---|---|
| GET | `/v1/custom/musics/{id}/lyrics` | — | Estrofes da música |
| PUT | `/v1/custom/lyrics/{id}` | Bearer+dono | Atualiza estrofe |

## Arquivos (upload de mídia)

| Método | Endpoint | Auth | Descrição |
|---|---|---|---|
| POST | `/v1/custom/files` | Bearer | Upload multipart/form-data (áudio/instrumental/capa) → URL relativa |

Servidos em `GET /file/custom/...` (público, mesma base `/file` do catálogo oficial).

## Códigos de erro

| Status | Significado |
|---|---|
| 400 | Payload inválido (Zod rejeitou) |
| 401 | Não autenticado / token inválido ou expirado |
| 403 | Autenticado mas não é dono do recurso |
| 404 | Recurso não existe |
| 409 | E-mail já cadastrado |

## Consumo por cliente

- **Web/Electron (desktop)**: leitura + escrita (login no editor de mídia). Sessão em `localStorage` (chave `louvorja.custom.auth`).
- **APK (mobile)**: v1 somente **leitura** — lista coletâneas, baixa (registro local via SharedPreferences), detalhe de música com letra sincronizada. Upload/edição fica no desktop.
- **Delphi**: sem mudança — custom é ecosystem novo, catálogo oficial (`/json_db/*`) intocado.

## Migrações relacionadas

- `021_custom_auth.sql` — tabelas `custom_users`, `custom_sessions` (auto-aplicadas no boot).
- `022_custom_auth_ownership.sql` — `owner_id` + `author_name` nas tabelas custom, índices.

## Pendente (fase 2)

- Rate limit específico em auth (hoje usa o global de 100/min).
- Refresh token (hoje: re-login após 30 dias).
- Reset de senha (sem canal de e-mail ainda).
- APK: upload/edição de coletâneas + "Minhas Baixadas" na UI.
