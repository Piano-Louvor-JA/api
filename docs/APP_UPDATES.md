# Atualização do apk Android pela API

O apk Android pergunta a versão nova à API e baixa o arquivo dela. Antes ele
consultava a API do GitHub direto de cada celular, que aceita só 60 consultas
anônimas por hora por IP: numa igreja com vários celulares na mesma internet o
limite estourava e o banner de atualização não aparecia.

O iPhone/iPad não usa nada disto: lá a atualização é pela App Store.

## Rotas (sem autenticação)

| Rota | O que devolve |
|---|---|
| `GET /v1/app/version` | `{ version, apk_url, size, sha256, notes, published_at }`, ou `404` quando nada foi publicado |
| `GET /v1/app/apk/louvorja-piano-<versão>-universal.apk` | o apk publicado (releases antigas: sem `-universal`) |

O app compara `version` com a instalada, mostra o banner, baixa `apk_url` e só
instala se o SHA-256 bater. Se a API responder `404` ou estiver fora do ar, o
app volta a consultar o GitHub (caminho de reserva).

## Publicar uma versão

Depois que o workflow `release.yml` do repositório `apk` anexar o
`louvorja-piano-<versão>.apk` à release, rode no servidor, na pasta da API:

```bash
docker compose exec api node dist/cli/fetch-apk.js          # última release
docker compose exec api node dist/cli/fetch-apk.js 1.0.1    # versão exata
```

O comando:

1. lê a release no GitHub (`Piano-Louvor-JA/apk`, ou `APK_RELEASE_REPO`);
   a release traz o apk universal e APKs por ABI; só o universal é publicado,
   porque serve a qualquer celular;
2. baixa o apk e confere o SHA-256 que o GitHub publica no asset;
3. nunca sobrescreve um apk já publicado que seja diferente da release;
4. só então troca o `version.json`: o banner nunca aparece antes de o
   download funcionar;
5. mantém o apk anterior (para rollback) e apaga os mais antigos.

Não precisa rebuild nem restart. Os arquivos ficam em
`./data/updates/android/` (dentro do volume `./data` que já persiste), ou em
`APP_UPDATES_DIR` quando definido.

**Rollback:** rode o comando com a versão anterior. Os celulares que já
atualizaram não voltam (o Android não instala versão menor); quem ainda não
atualizou passa a ver a versão anterior.

`GITHUB_TOKEN` é opcional (só para fugir do limite anônimo do próprio servidor,
o que não costuma acontecer com uma consulta por publicação).

Em desenvolvimento: `npm run fetch-apk -- [versão]`.

## Conferir

```bash
curl -s https://<host-da-api>/v1/app/version
```
