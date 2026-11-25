# Decisão — Fonte de dados de país (geo-IP) na infra Hostinger/Caddy

**Task:** t_8d58b70d · **Status:** DECIDIDO (pendente aprovação)
**Contexto:** SPEC seção F1 ponto 2 · `docs/spec-telemetry-geo.md`
**Decisão de Raphael (prévia): migrar a fonte de país para o log de acessos ou para o Caddy.**

## 0. Por que mudar

A spec de telemetria (seção 3) assume país via `cf-ipcountry` (Cloudflare) ou
`x-vercel-ip-country` (Vercel). **Verificado na prática (2026-09-30): nenhum dos
dois headers existe no deploy real.**

Evidência coletada ao vivo contra `https://api.pianolouvorja.com.br/v1/health`:

```
$ dig +short api.pianolouvorja.com.br
31.97.159.123                      # DNS direto — Hostinger VPS, sem proxy Cloudflare
$ curl -sI https://api.pianolouvorja.com.br/v1/health | grep -iE 'via|cf-|server'
via: 1.1 Caddy                     # TLS/proxy terminado no Caddy no próprio VPS
# (sem cf-ray, sem cf-ipcountry, sem x-vercel-ip-country)
```

Ou seja: o pipeline como especificado gravaria 100% dos registros como país
desconhecido ("XX"). É preciso outra fonte de país.

## 1. Log de acessos hoje (o que existe de fato)

Fatos verificados:

1. **A API roda atrás de Caddy no VPS Hostinger (31.97.159.123).** O header
   `via: 1.1 Caddy` está presente em toda resposta; o `docker-compose.yml` do
   piano-api usa `expose: 3100` + `networks: proxy` (rede externa) — ou seja, o
   Caddy é um reverse-proxy **separado**, quase certamente outro container Docker
   no mesmo host, gerenciado pelo Ezequias.
2. **Caddy, por padrão, NÃO escreve access log.** A diretiva `log` tem que ser
   habilitada por site no Caddyfile. Logo: salvo o Ezequias tenha configurado
   explicitamente, **hoje não existe arquivo de access log** — só runtime logs
   no stdout/journald do container.
3. **VPS Hostinger não tem "log de acessos" gerenciado.** Esse recurso do
   hPanel existe apenas em hosting compartilhado (`~/logs/`); em VPS (KVM, root
   total) quem define logging é o software instalado — aqui, o Caddy.
4. SSH no VPS não está disponível desta estação (`Permission denied`), então o
   Caddyfile real não pôde ser inspecionado diretamente. **Ação de confirmação
   com Ezequias (5 min no VPS):** `docker ps` (container do Caddy?) +
   `docker exec <caddy> cat /etc/caddy/Caddyfile` + `ls` do volume de logs.
   Conclusão técnica não muda: se houver log, ele é CLF/JSON do Caddy (ver
   abaixo); se não houver, precisa ser habilitado — e aí nasce a Opção A/B.

Formato do access log do Caddy quando habilitado (`log { output file ... }`):
por padrão é **Combined Log Format** (CLF: `IP - user [ts] "req" status bytes`),
sem campo de país. Com `format json`, traz `request.client_ip`, status, duração,
headers — também **sem país**. Em ambos os casos o IP aparece **em claro no
arquivo**, o que colide com a regra LGPD do projeto (ver §4).

## 2. Opção A — Caddy `log` + plugin geoip (MaxMind GeoLite2) como header

Como funciona: rebuild do Caddy com `xcaddy` + plugin `caddy-geoip`; baixar
GeoLite2-Country.mmdb (conta gratuita MaxMind + EULA + key); plugin expõe
placeholder `{geoip.country_code}`; injetar no upstream:

```
api.pianolouvorja.com.br {
    log { output file /data/access.log { roll_size 100mb roll_keep 3 } }
    geoip /data/GeoLite2-Country.mmdb
    reverse_proxy piano-api:3100 {
        header_up X-Geo-Country {geoip.country_code}
    }
}
```

A API então lê `X-Geo-Country` como fonte primária de país (um if a mais no
pipeline da spec, seção 3).

| Prós | Contras |
|---|---|
| País resolvido em tempo de request, no lugar certo (pipeline da spec funciona como desenhado) | Rebuild do Caddy com xcaddy — perde o binário oficial/docker image; **todo upgrade futuro do Caddy refaz o build** |
| Zero latência extra visível (lookup mmdb local ~µs) | **Dependência de licença MaxMind** (conta grátis + EULA GeoLite2; distribuição do .mmdb é restrita, renovação/atualização semanal precisa de cron + key) |
| Sem parsing de log, sem shipper, sem job extra | Caddy gerenciado pelo Ezequias em container — trocar a imagem oficial por uma custom é mudança na infra dele, aprovação obrigatória |
| IP cru nunca entra na aplicação | Plugin caddy-geoip é de mantenedor terceiro, atualização irregular vs versões do Caddy |
| | Ainda precisa `log` habilitado se quiser auditoria |

## 3. Opção B — parsing server-side do access log do Caddy

Como funciona: habilitar `log` no Caddyfile (JSON format), volume compartilhado
ou `docker logs`; job no piano-api (ou cron no host) lê o arquivo
incrementalmente, agrupa por `(dia, país?, rota)`… **problema: o log não tem
país** — o parser precisaria ele mesmo fazer geo-lookup por IP (mmdb local ou
API externa), i.e. **resolve o mesmo problema da Opção A, mas fora de ordem**.

| Prós | Contras |
|---|---|
| Caddy permanece binário oficial (só diretiva `log`) | **Requer GeoLite2 do mesmo jeito** (licença, key, atualização) — a diferença A×B não é "com ou sem MaxMind", é onde o lookup roda |
| Sem rebuild/upgrade-friction do proxy | Países chegam com atraso (batch), não em tempo real |
| Log é útil para auditoria/debug independente | **IP cru persistido em arquivo no disco** — retenção e rotação viram obrigação LGPD (Marco Civil Art.15: 6 meses); hoje o projeto não persiste IP em nenhum lugar |
| Reusa infra de log se ela já existir | Parser é código novo a manter (formato, roll de arquivo, dedup, replay pós-crash) |
| | Só cobre tráfego que passa pelo Caddy HTTP access path — eventos fire-and-forget do app continuam sem país se o pipeline da spec for o de produção |

## 4. Peso LGPD (restrição inegociável)

- Hoje: IP cru **nunca** é persistido; só `sha256(salt+ip)` com `ip_hash`
  expirado em 7 dias (spec §3). Ambas as opções introduzem IP cru no **log de
  acessos do Caddy** (mesmo a A, se `log` for habilitado). A B o torna
  **entrada obrigatória do pipeline**, com janela de dias entre gravação e
  agregação.
- Mitigações: rotação agressiva (`roll_keep 1`, 24–48h) OU log format JSON
  filtrado sem `client_ip`, OU — na A — manter `log` desligado e usar apenas o
  header (nenhum IP em disco).
- Base legal (legítimo interesse, agregado) continua válida nas duas; o risco
  adicionado é de **retenção de dado bruto**, não de finalidade.

## 5. Comparativo resumido

| Critério | A — Caddy+geoip header | B — parsing de log |
|---|---|---|
| Esforço inicial | Médio (xcaddy build + MaxMind + Caddyfile) | Médio-alto (log + shipper + parser + geo-lookup) |
| Mudança na infra do Ezequias | Troca imagem do Caddy (invasivo) | Apenas diretiva `log` (pouco invasivo) |
| Latência do dado | Tempo real | Batch (horas) |
| Manutenção contínua | Rebuild a cada upgrade Caddy + update semanal mmdb | Parser + estado de leitura + update semanal mmdb |
| Dependência MaxMind | Sim | Sim (igual) |
| LGPD | Header only: IP em disco = zero | IP cru em disco por design |
| Código novo na API | 3 linhas (ler header) | Job inteiro de ingestão |

## 6. Recomendação — Opção A, variante minimal

**Recomendado: A com o menor alcance possível**: plugin geoip no Caddy injetando
`X-Geo-Country`, **sem** habilitar access log. É a única variante que mantém o
IP cru fora de qualquer persistência, alimenta o pipeline da spec em tempo real
com ~3 linhas de código na API, e evita construir um parser que, no fim, faria o
mesmo lookup MaxMind — mais tarde e com mais superfície LGPD.

Plano B se Ezequias rejeitar trocar a imagem do Caddy (aceitável — é infra
dele): lookup geo-IP **dentro do piano-api** no handler de telemetria, com
`GeoLite2-Country.mmdb` num volume read-only e `TELEMETRY_MMDB_PATH` no env.
Mesma licença MaxMind, zero mudança no proxy, tempo real, IP nunca sai do
processo. Isso é estritamente melhor que B e deve ser a segunda escolha, não o
parsing de log. **Parsing de log (B) fica descartado**: mais trabalho, dado
atrasado, IP cru retido e mesma dependência de MaxMind.

## 7. O que exatamente muda (aceitação)

Caminho recomendado (A minimal):

1. **Caddy (Ezequias):** rebuild com `xcaddy build --with github.com/kabaka/caddy-geoip`
   (ou imagem Docker equivalente), baixar GeoLite2-Country.mmdb, cron semanal
   de atualização, e no site da API:
   `reverse_proxy piano-api:3100 { header_up X-Geo-Country {geoip.country_code} }`.
2. **piano-api (`docs/spec-telemetry-geo.md` §3.1 + código futuro):** fonte de
   país passa a ser, em ordem: `x-geo-country` → `cf-ipcountry` →
   `x-vercel-ip-country` → senão descarta registro. Atualizar a spec na mesma
   PR da implementação do endpoint.
3. **LGPD:** nenhum `access_log` novo; IP cru permanece não-persistido;
   privacy.vue (seções 1.4/8) continua verdadeira — sem alteração de texto
   (a coleta declarada não muda, só a fonte técnica do país).

Plano B (se aprovado): `TELEMETRY_MMDB_PATH` no docker-compose/env, lookup no
handler, mesmo esquema de header-fallback.

## 8. Verificação pendente (bloqueio de 5 min com Ezequias)

Confirmar no VPS: `docker ps` (qual container é o Caddy), Caddyfile atual
(existe `log` hoje? qual output?), e aprovação para trocar a imagem. Sem isso,
a implementação da A não pode começar — mas a decisão conceitual acima não muda.
