# API — Endpoints Bíblia (catálogo oficial, espelho LouvorJA)

> Fonte viva: `GET /openapi.json` · Swagger UI: `/doc`.
> Complementa [CUSTOM_API.md](./CUSTOM_API.md). Última atualização: 2026-10-17 (bundles para Bíblia offline).

## Visão geral

A Bíblia é servida pelo **catálogo compat** (`/json_db/*`), o mesmo canal que os
apps (Flutter mobile/desktop, web, Electron, Delphi) já usam pra hinários.
Para uso offline existem os **bundles** (`/v1/bible/bundles*`): a versão
inteira num único request, com sha256 para o cliente detectar atualização.
O `GET /v1/bible` e o `GET /v1/bible/{book}/{chapter}` existem mas estão
**semi-quebrados pra ES** (ver "Limitações").

## Idiomas e versões

| Idioma | Versões (id → nome) | Capítulos |
|---|---|---|
| **pt** | 1 ACRF · 2 ARA · 3 ARC-IB · 4 NTLH · 5 NVI · 6 KJ Atualizada · 7 NVTransformadora · 8 NAA · 9 ARC-Fiel · 13 AC-Fiel | ✅ 66 livros (ids **1–66**) × 1189 caps |
| **es** | 10 Reina-Valera (RV) · 11 Reino-Valera 1989 (RVA) · 12 Las Sagradas Escrituras (SEV) | ✅ 66 livros (ids **67–132**) × 1189 caps |
| **en** | — não existe no ecossistema LouvorJA | ❌ (clients fazem fallback pt) |

## Endpoints

### `GET /json_db/pt_bible_book` · `GET /json_db/es_bible_book`
Lista de livros do idioma. Formato (contrato com apps):

```json
[{ "id_bible_book": 67, "book_number": 1, "name": "Génesis", "chapters": 50,
   "testament": 1, "keywords": "genesis", "abbreviation": "Gn", "color": "#01a2d9" }]
```

⚠️ **ES usa ids de livro com offset +66** (Génesis=67 … Apocalipsis=132).
Os apps leem o `id_bible_book` daqui e usam direto na chave de capítulo.

### `GET /json_db/pt_bible_version` · `GET /json_db/es_bible_version`
Lista de versões do idioma:

```json
[{ "id_bible_version": 10, "name": "Reina-Valera", "abbreviation": "RV" }]
```

### `GET /json_db/bible_{versionId}_{bookId}_{chapter}`
Capítulo completo (versículo a versículo). Chave definida por
`ScriptureFormat.chapterRecordKey` no Flutter:

```
bible_1_1_1   → Gênesis 1, versão 1 (ACRF, pt)
bible_10_67_1 → Génesis 1, versão 10 (RV, es)   ← bookId 67 = 1º livro ES
```

Resposta: `{"data": ["v1", "v2", ...]}`.

**Cache on-demand:** primeira chamada busca do upstream e grava em
`data/bible_cache/bible_{v}_{b}_{c}.json`; chamadas seguintes saem do disco.
Local: 15.458 arquivos (13 versões × 1189 caps — **completo**, pt+es).
⚠️ A prod do upstream (api.louvorja.com.br) **não tem capítulos ES** — o nosso
mirror é mais completo que a origem; miss de ES nunca resolve no upstream.
Diretório configurável por `BIBLE_CACHE_DIR` (padrão `data/bible_cache`).

### `GET /v1/bible/bundles`
Manifesto dos bundles, uma entrada por versão (só ids numéricos):

```json
{ "schema": 1, "versions": [{
  "versionId": 2, "language": "pt", "name": "Almeida Revista e Atualizada",
  "abbreviation": "ARA", "books": 66, "chapters": 1189,
  "complete": true, "missing": 0,
  "sha256": "<hex>", "bytes": 4400000, "gzipBytes": 1300000,
  "updatedAt": "2026-09-10T12:00:00.000Z" }] }
```

`complete: false` (falta capítulo no cache) vem com `sha256`/`bytes`/`gzipBytes`
nulos e `missing` = quantos capítulos faltam. O cliente compara o `sha256` com
o do bundle que tem no disco; diferente → baixa de novo.

### `GET /v1/bible/bundles/{versionId}`
Versão inteira, montada a partir do `bible_cache` (mesmos textos de
`/json_db/bible_*`, já sanitizados). **Nunca chama o upstream.**

```json
{ "schema": 1, "versionId": 2, "language": "pt", "name": "...", "abbreviation": "ARA",
  "chapters": { "<idLivro>": { "<capítulo>": { "<versículo>": "texto" } } } }
```

- `Accept-Encoding: gzip` → resposta compactada (`Content-Encoding: gzip`).
- `ETag` = `"<sha256>"` dos bytes **descompactados**; o cliente valida o
  download fazendo sha256 do corpo. `If-None-Match` igual → `304`.
- `409 { "error": "bundle_incompleto", "missing": N, "sample": ["bible_2_1_3", ...] }`
  quando falta capítulo no cache; `404` para versão inexistente.
- Bundle montado fica em memória (só o gzip) e é revalidado pelo `stat` dos
  arquivos no máximo a cada 60 s (`BIBLE_BUNDLE_REVALIDATE_MS`).

## Limitações conhecidas

- `GET /v1/bible` e `GET /v1/bible/{book}/{chapter}` (REST/OpenAPI): a query
  `lang` filtra `bible_books.id_language`, mas só `pt` está populado — ES dá
  lista vazia. **Deprecated de facto**: os apps usam `/json_db/*`. Corrigir ou
  remover numa fase futura.
- `bible_verses` (SQLite) vazia por design — capítulos são proxy+cache, não
  linhas no DB. Busca full-text dependeria de popular essa tabela (FTS5).
- EN: sem dados em toda a cadeia (upstream incluído).
