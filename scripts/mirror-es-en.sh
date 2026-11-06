#!/usr/bin/env bash
# Mirror do conteudo ES/EN — bundle-first (piano-bundle-sync SPEC v1.0.0)
#
# Antes: catalogos + detalhe music_<id> item-a-item (~2.5k req/run, throttle 0.8s).
# Agora: 1 GET /db/manifest + 1 GET /db/catalog-bundle (ZIP); os JSONs es/en/music_<id>
# são extraídos localmente do ZIP. Mídia é opt-in via MIRROR_MEDIA=1 e continua
# responsabilidade separada do mirror-media.sh; a run normal nunca a varre.
set -euo pipefail

API="${UPSTREAM_API:-https://api.louvorja.com.br}"
BASE="${BACKUP_DIR:-$HOME/piano-api}"
CACHE="$BASE/data/json_db_cache"
BUNDLE_DIR="$BASE/backups"
STAMP_FILE="$BUNDLE_DIR/.last_bundle_md5"
TS=$(date +%F_%H%M)

mkdir -p "$CACHE" "$BUNDLE_DIR"
log() { echo "[$TS] $*"; }

BUNDLE="$BUNDLE_DIR/catalog-bundle.zip"

# ---------- requests 1-2: manifest + catalog bundle ----------
log "GET $API/db/manifest"
if ! curl -sf --retry 2 --max-time 60 "$API/db/manifest" -o "$BUNDLE_DIR/.manifest.tmp"; then
  log "FAIL: manifest indisponivel — cache anterior preservado"
  exit 1
fi
if ! python3 - "$BUNDLE_DIR/.manifest.tmp" <<'EOF'
import json, re, sys
m = json.load(open(sys.argv[1]))
if not isinstance(m, list) or not m or any(not re.fullmatch(r"[a-f0-9]{32}", e.get("hash", "")) for e in m):
    sys.exit("manifest invalido")
EOF
then
  log "FAIL: manifest invalido — cache anterior preservado"
  rm -f "$BUNDLE_DIR/.manifest.tmp"
  exit 1
fi
mv "$BUNDLE_DIR/.manifest.tmp" "$BUNDLE_DIR/manifest.json"

log "GET $API/db/catalog-bundle"
if ! curl -sf --retry 2 --max-time 300 "$API/db/catalog-bundle" -o "$BUNDLE.tmp"; then
  log "FAIL: catalog-bundle indisponivel — cache anterior preservado"
  exit 1
fi
MD5_NEW=$(md5sum "$BUNDLE.tmp" | cut -d' ' -f1)
MD5_LAST=$(cat "$STAMP_FILE" 2>/dev/null || echo "none")
if [[ "$MD5_NEW" != "$MD5_LAST" || "${1:-}" == "--force" ]]; then
  # Valida e extrai em staging: cache anterior só troca após ZIP completo.
  STAGE="$BUNDLE_DIR/.lang_stage_$TS"
  if ! python3 - "$BUNDLE.tmp" "$STAGE" <<'EOF'
import json, zipfile, sys, os
z = zipfile.ZipFile(sys.argv[1])
stage = sys.argv[2]
for n in z.namelist():
    if n.startswith("/") or ".." in n.split("/") or not n.endswith(".json"):
        sys.exit("entrada insegura: %s" % n)
    json.loads(z.read(n).decode("utf-8"))
idx = json.loads(z.read("_bundle_manifest.json").decode("utf-8"))
if idx.get("kind") != "catalog" or idx.get("schema_version") != 1:
    sys.exit("_bundle_manifest inesperado")
os.makedirs(stage)
for n in z.namelist():
    if n == "_bundle_manifest.json" or n.startswith(("es_", "en_", "pt_", "music_", "album_", "config")):
        with z.open(n) as src, open(os.path.join(stage, n), "wb") as out:
            out.write(src.read())
print("staging pronto")
EOF
  then
    log "FAIL: ZIP invalido — descartado, cache anterior preservado"
    rm -rf "$STAGE" "$BUNDLE.tmp"
    exit 1
  fi
  OLD="$BUNDLE_DIR/.lang_old_$TS"
  mv "$CACHE" "$OLD" && mv "$STAGE" "$CACHE" && rm -rf "$OLD"
  echo "$MD5_NEW" > "$STAMP_FILE"
else
  log "Bundle inalterado (md5 $MD5_NEW); usando cache local"
fi
mv "$BUNDLE.tmp" "$BUNDLE"

# Mídia não possui bundle. O mirror completo é trabalho explícito de
# mirror-media.sh; não misturar com o sync normal do catálogo.
if [[ "${MIRROR_MEDIA:-0}" != "1" ]]; then
  log "JSONs sincronizados em 2 requests; mídia ignorada (use MIRROR_MEDIA=1 mirror-media.sh)."
  exit 0
fi

# ---------- mídia: item-a-item só para ausentes (opt-in) ----------
log "Midias ausentes (legado /file)"
python3 - "$CACHE" > /tmp/lang_media_paths.txt <<'EOF'
import json, sys, glob, os
cache = sys.argv[1]
paths = set()
for p in glob.glob(os.path.join(cache, "music_*.json")):
    d = json.load(open(p))
    for k in ("url_music", "url_instrumental_music", "url_image"):
        v = d.get(k)
        if v: paths.add(v)
print("\n".join(sorted(paths)))
EOF
mtotal=$(wc -l < /tmp/lang_media_paths.txt)
missing=0; fail=0; i=0
while IFS= read -r path; do
  [[ -z "$path" ]] && continue
  i=$((i+1))
  dest="$BASE/media/$path"
  [[ -s "$dest" ]] && continue
  missing=$((missing+1))
  mkdir -p "$(dirname "$dest")"
  enc=$(python3 -c "import urllib.parse,sys; print(urllib.parse.quote(sys.argv[1], safe='/'))" "$path")
  if curl -sf --retry 2 --max-time 120 "$API/file/$enc" -o "$dest.tmp"; then
    mv "$dest.tmp" "$dest"
  else
    rm -f "$dest.tmp"; fail=$((fail+1)); echo "FAIL $path" >> "$BUNDLE_DIR/.media_failures"
  fi
  (( missing % 50 == 0 )) && echo "  $missing ausentes processados / $mtotal total"
done < /tmp/lang_media_paths.txt
log "Midia: $mtotal referencias, $missing ausentes baixadas, $fail falhas"
log "=== Concluido. JSONs: 0 requests item-a-item (via bundle). Midia: somente ausentes. ==="
