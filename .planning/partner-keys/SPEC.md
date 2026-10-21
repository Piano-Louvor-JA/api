# SPEC: Token de parceiro (X-Partner-Key)

## Contexto
Apps parceiros (primeiro: Liturgia Desktop) vão consumir `/v1/liturgy` e
`/file/...`. Queremos identificar cada parceiro, medir o uso dele e poder
cortar o acesso de um parceiro sem afetar app/web/APK, que não enviam token.

O token vai embutido num app distribuído, então **não é segredo forte**: é um
identificador revogável. Por isso ele não muda o rate limit (que segue por IP,
um balde por instalação) e não dá acesso a nada que não seja público.

## Requisitos Funcionais

### RF-01: Token opcional
WHEN a requisição não traz `X-Partner-Key` THE SYSTEM SHALL processá-la
exatamente como hoje (sem lookup, sem header extra, sem bloqueio).

### RF-02: Token válido identifica o parceiro
WHEN a requisição traz um `X-Partner-Key` ativo THE SYSTEM SHALL seguir a
requisição normalmente, expor o parceiro no contexto (`c.get("partner")`) e
contar `partner_requests_total{partner}` no /metrics.

### RF-03: Token inválido ou revogado
WHEN a requisição traz `X-Partner-Key` desconhecido ou revogado THE SYSTEM
SHALL responder 401 `{ "error": "Invalid partner key" }`. Só afeta quem envia
o header; clientes próprios não enviam.

### RF-04: Armazenamento
THE SYSTEM SHALL guardar apenas o SHA-256 do token (tabela `partner_keys`),
nunca o token em claro. O token tem o formato `plj_<43 chars base64url>`
(32 bytes aleatórios).

### RF-05: Gestão por CLI, sem rota HTTP
THE SYSTEM SHALL oferecer `node dist/cli/partners.js` com:
- `create <nome>`: cria e imprime o token **uma única vez**;
- `list`: lista id, nome, prefixo, status e datas (nunca o token);
- `revoke <id>`: revoga (efeito imediato na próxima requisição).

Em dev: `npm run partners -- <comando>`.

### RF-06: Migration idempotente
`031_partner_keys.sql` usa `CREATE TABLE/INDEX IF NOT EXISTS` e pode rodar
duas vezes.

## Não-Funcionais
- TDD: testes unit (lib, middleware, CLI) + integração (app real).
- Zero mudança em schemas de resposta existentes.
- Sem dependências novas (`node:crypto`).
- Lookup por índice único no hash; custo só quando o header vem.

## Fora de Escopo
- Tornar o token obrigatório em alguma rota (próximo passo, por rota).
- Cota de rate limit por parceiro (rate limit continua por IP).
- Rotas HTTP de administração.
