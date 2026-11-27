#!/usr/bin/env bash
# ingest-bible-multilingue.sh — deploy staging (e depois prod) da Bíblia 15 idiomas.
#
# Onde roda: DENTRO do checkout da API no servidor
# (staging: /opt/services/api-piano-louvorja-stg).
# Idempotente: pode rodar quantas vezes quiser.
#   1. Verifica sha256 dos tarballs em data/json_db/bible_multilingue/
#   2. Extrai bible_{v}_{b}_{c}.json para data/bible_cache/ (rota serve direto)
#   3. Restart do container — migrations (038) rodam no boot
#   4. Validação: 13 idiomas × 66 livros + 1 capítulo por idioma = 200
#
# Uso: bash scripts/ebible-to-piano/ingest-bible-multilingue.sh
set -euo pipefail

cd "$(dirname "$0")/../.."
DIR=data/json_db/bible_multilingue
CACHE=data/bible_cache
PORT="${PORT:-3101}"

[ -f "$DIR/catalog.json" ] || { echo "✗ $DIR/catalog.json ausente"; exit 1; }

echo "== 1/3 checksums =="
( cd "$DIR" && sha256sum -c --quiet --ignore-missing *_bible_catalog.sha256 ) \
  || { echo "✗ checksum FAILED"; exit 1; }
echo "✓ todos os checksums OK"

echo "== 2/3 extrair capítulos para $CACHE =="
mkdir -p "$CACHE"
TOTAL=0
for tar in "$DIR"/*_bible_chapters.tar.gz; do
  n=$(tar -tzf "$tar" | wc -l)
  tar -xzf "$tar" -C "$CACHE"
  TOTAL=$((TOTAL + n))
done
echo "✓ $TOTAL capítulos extraídos"

echo "== 3/3 restart container (migrations no boot) =="
if command -v docker >/dev/null 2>&1 && docker ps --format '{{.Names}}' | grep -q piano-api-stg; then
  docker restart piano-api-stg
  sleep 8
  echo "✓ container reiniciado"
else
  echo "  (docker/staging não detectado — pule restart; inicie a API manualmente)"
fi

echo "== validação =="
FAIL=0
for lang in en fr ru uk it nl pl tr ja ko zh ar hi; do
  code=$(curl -sS -o /dev/null -w '%{http_code}' "http://localhost:${PORT}/json_db/${lang}_bible_book")
  n=$(curl -sS "http://localhost:${PORT}/json_db/${lang}_bible_book" | python3 -c 'import json,sys;print(len(json.load(sys.stdin)))' 2>/dev/null || echo 0)
  if [ "$code" != "200" ] || [ "$n" != "66" ]; then
    echo "✗ $lang: HTTP $code, $n livros"; FAIL=1
  else
    echo "  ✓ $lang: 66 livros"
  fi
done
[ "$FAIL" = "0" ] || exit 1
echo "✓ 13 idiomas × 66 livros OK"
