# Token de parceiro (`X-Partner-Key`)

Apps parceiros se identificam com o cabeçalho `X-Partner-Key`. O token é
**opcional**: app, web e APK não enviam nada e seguem funcionando igual.

| Situação | Resultado |
|---|---|
| Sem `X-Partner-Key` | Igual a hoje |
| Token ativo | Segue normal; uso contado em `partner_requests_total{partner}` |
| Token desconhecido ou revogado | `401 {"error":"Invalid partner key"}` |

O rate limit continua **por IP** (cada instalação do parceiro tem o próprio
balde). O token vai embutido no app do parceiro, então trate-o como um
identificador revogável, não como segredo forte.

## Para o parceiro

```http
GET /v1/liturgy?lang=pt
User-Agent: NomeDoApp/1.2.3
X-Partner-Key: plj_...
```

Vale para `/v1/*` e `/file/...`.

### Atualização de arquivos em `/file/...`

Toda resposta de `/file/...` traz `ETag` (hash do conteúdo), `Last-Modified`
e `Cache-Control: no-cache`. Guarde o `ETag` de cada arquivo e revalide:

```http
GET /file/musics/pt/90122.mp3
If-None-Match: "<etag guardado>"
```

`304` = arquivo igual ao do cache; `200` = arquivo corrigido no mesmo
endereço (corpo novo e `ETag` novo).

## Operação

Dentro do container (o token aparece **uma única vez**; só o hash fica no
banco):

```bash
docker compose exec api node dist/cli/partners.js create "Liturgia Desktop"
docker compose exec api node dist/cli/partners.js list
docker compose exec api node dist/cli/partners.js revoke <id>
```

A revogação vale na requisição seguinte, sem reiniciar. Em dev:
`npm run partners -- list`.

Spec: `.planning/partner-keys/SPEC.md`.

## Site e receiver distribuído pela API

A telemetria reconhece também `site` e `palco-browser`; esses valores
não caem no fallback por User-Agent. Nenhum header novo é obrigatório.

O HTML em `/palco` carrega `/palco/client-identity.js`, gerado em runtime
com a versão do artefato da API e as variáveis `PALCO_PARTNER_KEY_STG` e
`PALCO_PARTNER_KEY_PROD`. Configure no container as chaves já emitidas para
o parceiro Palco no banco de cada ambiente. Sem variável, o receiver mantém
o acesso sem chave. Não há nova migration ou emissão automática de token.

Essa configuração pública e revogável é usada somente nas chamadas HTTP
`/v1/palco` à API Piano HTTPS (ou API local). Não altera o token de sessão,
não coloca a chave na URL do WebSocket e não a envia a upstream ou terceiros.
O script é servido com `Cache-Control: no-store`; recarregue o receiver após
alterar a configuração. O receiver hospedado na API não depende da publicação
do repositório `palco-receiver` para receber esta correção.
