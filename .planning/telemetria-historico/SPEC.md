# SPEC — Telemetria: histórico 3 meses, rankings e mapa BR

> Status: **em implementação** (2026-11-27).
> Repos: `api` + `site`. Baseia-se em `app/.planning/telemetria-dispositivos` (v1 online).

## Objetivo

No admin `/admin/telemetria`, além do “online agora”:

1. **Histórico ≥ 90 dias** de dispositivos que enviaram heartbeat (retenção).
2. **Rankings** por igreja, distrito, cidade, estado (UF), país e SO.
3. **Mapa do Brasil**: bolinha **verde** = online agora; **cinza** = teve acesso nos últimos 90 dias e não está online.

## Decisões

| Tema | Decisão |
|---|---|
| Janela | 90 dias (`HISTORY_WINDOW_DAYS`) |
| Fonte mapa/ranking (v1) | Tabela `device_presence` filtrada por `last_seen` (último estado por install) |
| Agregado diário | `device_presence_daily` — snapshot diário para séries futuras e reforço do histórico |
| Coordenadas | Cliente **não** envia lat/lng. Site posiciona por **UF** (centroide) + offset determinístico por cidade |
| Passiva (“Sem token”) | Fora do mapa/rankings eclesiais (sem church/geo estável) |
| Privacidade | Sem IP; sem `install_id` completo; admin only |
| Purge | `device_presence` com `last_seen` > 100d; daily > 100d |

## Endpoints (admin)

- `GET /v1/telemetry/history?days=90` — totais do período + online agora
- `GET /v1/telemetry/rankings?days=90&by=church\|district\|city\|region\|country\|os&limit=50`
- `GET /v1/telemetry/map?days=90&country=BR` — pontos `{city,region,online,seen}`

## UI (site)

Abas: **Agora** \| **Rankings** \| **Mapa**. Poll do online mantém verdes atualizados no mapa.
