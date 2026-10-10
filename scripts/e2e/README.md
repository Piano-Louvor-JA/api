# E2E manual — palco relay (WS real contra API local)

Testes e2e da camada acima dos unit (`test/unit/palco-relay.test.ts`,
`palco-slot-routing.test.ts` usam WS mockado). Aqui o relay roda de verdade:
handshake real, keepalive, cid/slot na query string.

Pré-requisitos:

```bash
npm run dev        # API na :3100
npm i              # ws precisa estar instalado (já é dep de dev)
```

## Ambiente da API (guardrail E2E)

Todos os scripts leem `PALCO_E2E_API_URL` (default `http://localhost:3100`)
e **abortam antes de qualquer request** se o hostname for de produção
(`api.pianolouvorja.com.br`). Para rodar contra staging:

```bash
PALCO_E2E_API_URL=https://api-stg.pianolouvorja.com.br node scripts/e2e/wt5-e2e-manual.mjs
```


## wt5-e2e-manual.mjs — fluxo completo de sessão (auto-contido)

Cria sessão, busca token público, conecta receiver + operator fake,
publica projection v2 e valida que o receiver recebeu:

```bash
node scripts/e2e/wt5-e2e-manual.mjs
```

Passa se o receiver receber a projection publicada. Sai com código 0/1.

## wt5-fake-tv.mjs — TV fake (debug interativo)

Conecta como receiver numa sessão existente e loga TUDO que chega.
Útil pra depurar o operador real (web/desktop) enquanto a "TV" observa:

```bash
node scripts/e2e/wt5-fake-tv.mjs <code> <token>
```

## wt6a-e2e.mjs — roteamento por slot (WT-6A)

Dois receivers fake em slots diferentes; valida que cada um recebe só
o do seu slot:

```bash
node scripts/e2e/wt6a-e2e.mjs <code> <operatorToken>
```

O `<code>`/`<token>` do operator vem do log do desktop ao ativar o
controle remoto, ou criando sessão via `POST /v1/palco/sessions`.

## Cobertura e por que não virou teste automatizado

Requer servidor WS real escutando porta — entrar no `vitest run` do CI
exigiria subir a API inteira (supertest não cobre o upgrade de WS sem
setup extra). Quando o relay virar serviço separado ou o CI ganhar
docker-compose de teste, migra pra `test/integration/`.
