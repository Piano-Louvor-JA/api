#!/usr/bin/env bash
# Backup completo da api.louvorja.com.br — bundle-first (piano-bundle-sync SPEC v1.0.0)
#
# Antes: dump item-a-item (~880 req /json_db/music_<id> por run, throttle 0.8s ~ 12min).
# Agora: 1 GET /db/manifest + 1 GET /db/catalog-bundle (ZIP). Normal <= 2 requests/run;
# run sem mudança ainda faz 2 (manifest + bundle sonda) e aplica 0 — o upstream não
# expõe o MD5 do bundle no manifest, então o ZIP (~4MB) é a sonda de mudança.
#
# Contrato (SPEC ADR-01/02):
#   - GET /db/catalog-bundle -> application/zip
#   - ZIP contém exclusivamente JSON UTF-8 relativo, com _bundle_manifest.json de índice
#   - Aplicação atômica: staging temporário + validação + move; cache anterior nunca é apagado
#   - Cache-buster proibido; revalidação governada pelo conteúdo
#
# Dump cru legado continua em $RAW (extraído do ZIP, sem request extra), para
# compatibilidade do import-upstream.ts.
set -euo pipefail

export PATH="$HOME/.nvm/versions/node/v22.23.2/bin:$PATH"

API="${UPSTREAM_API:-https://api.louvorja.com.br}"
BASE="${BACKUP_DIR:-$HOME/piano-api}"
RAW="$BASE/backups/raw"
DB="$BASE/data/catalog.db"
STAMP_FILE="$BASE/backups/.last_bundle_md5"
TS=$(date +%F_%H%M)

mkdir -p "$RAW" "$BASE/backups"

log() { echo "[$TS] $*"; }

# ---------- request 1: manifest ----------
MANIFEST="$BASE/backups/manifest.json"
TMP_MANIFEST="$BASE/backups/.manifest.tmp"
log "GET $API/db/manifest"
if ! curl -sf --retry 2 --max-time 60 "$API/db/manifest" -o "$TMP_MANIFEST"; then
  log "FAIL: manifest indisponivel — mantendo estado anterior (nenhum outro request sera feito)"
  exit 1
fi
if ! python3 - "$TMP_MANIFEST" <<'EOF'
import json, re, sys
m = json.load(open(sys.argv[1]))
if not isinstance(m, list) or not m:
    sys.exit("manifest invalido: nao e lista nao-vazia")
for e in m:
    if not re.fullmatch(r"[a-f0-9]{32}", e.get("hash", "")):
        sys.exit("manifest invalido: hash nao e md5: %s" % e.get("path"))
EOF
then
  log "FAIL: manifest invalido — descartado, cache anterior preservado"
  rm -f "$TMP_MANIFEST"
  exit 1
fi
mv "$TMP_MANIFEST" "$MANIFEST"

# ---------- request 2 (condicional): catalog bundle ----------
BUNDLE_TMP="$BASE/backups/.catalog-bundle.tmp"
log "GET $API/db/catalog-bundle"
if ! curl -sf --retry 2 --max-time 300 "$API/db/catalog-bundle" -o "$BUNDLE_TMP"; then
  log "FAIL: catalog-bundle indisponivel — cache anterior preservado"
  exit 1
fi
MD5_NEW=$(md5sum "$BUNDLE_TMP" | cut -d' ' -f1)
MD5_LAST=$(cat "$STAMP_FILE" 2>/dev/null || echo "none")
if [[ "$MD5_NEW" == "$MD5_LAST" && "${1:-}" != "--force" ]]; then
  log "Bundle inalterado (md5 $MD5_NEW). 2 requests nesta run, 0 aplicados."
  rm -f "$BUNDLE_TMP"
  exit 0
fi

# ---------- validação do ZIP (SPEC ADR-02) ----------
log "MD5 do bundle: $MD5_NEW — validando ZIP"
if ! python3 - "$BUNDLE_TMP" <<'EOF'
import json, zipfile, sys
z = zipfile.ZipFile(sys.argv[1])  # corrompido -> exceção
for n in z.namelist():
    if n.startswith("/") or ".." in n.split("/"):
        sys.exit("caminho inseguro no zip: %s" % n)
    if not n.endswith(".json"):
        sys.exit("entrada nao-JSON no zip: %s" % n)
    with z.open(n) as f:
        json.loads(f.read().decode("utf-8"))  # JSON invalido -> exceção
idx = json.loads(z.read("_bundle_manifest.json").decode("utf-8"))
if idx.get("kind") != "catalog" or idx.get("schema_version") != 1:
    sys.exit("_bundle_manifest inesperado")
for k in ("pt_categories.json", "pt_musics.json", "config.json"):
    if k not in z.namelist():
        sys.exit("chave essencial ausente: %s" % k)
print("zip ok: %d entradas" % len(z.namelist()))
EOF
then
  log "FAIL: ZIP invalido — descartado, cache anterior preservado"
  rm -f "$BUNDLE_TMP"
  exit 1
fi

# ---------- aplicação atômica: extrair p/ RAW (dump cru) ----------
log "Aplicando bundle em $RAW (atomico: staging + move)"
STAGE="$BASE/backups/.raw_stage_$TS"
mkdir -p "$STAGE"
python3 - "$BUNDLE_TMP" "$STAGE" <<'EOF'
import zipfile, sys, os
z = zipfile.ZipFile(sys.argv[1])
stage = sys.argv[2]
for n in z.namelist():
    dest = os.path.join(stage, n)
    os.makedirs(os.path.dirname(dest), exist_ok=True)
    with z.open(n) as src, open(dest, "wb") as out:
        out.write(src.read())
EOF
OLD="$BASE/backups/.raw_old_$TS"
mv "$RAW" "$OLD" && mv "$STAGE" "$RAW" && rm -rf "$OLD"

python3 - "$RAW/_bundle_manifest.json" <<'EOF'
import json, sys
idx = json.load(open(sys.argv[1]))
print("bundle: kind=%s files=%s generated=%s" % (idx.get("kind"), idx.get("total_files", len(idx.get("files", []))), idx.get("generatedAt", "n/a")))
EOF

# ---------- rebuild SQLite from extracted bundle (zero upstream requests) ----------
IMPORT_SCRIPT="${IMPORT_SCRIPT:-$BASE/scripts/import-upstream.ts}"
log "Rebuild SQLite from local bundle via import-upstream.ts"
cd "$BASE"
DB_PATH="$DB" LOCAL_JSON_DIR="$RAW" IMPORT_SKIP_BIBLE=1 npx tsx "$IMPORT_SCRIPT" | tail -20

# ---------- snapshot versionado + estado ----------
mkdir -p "$BASE/backups/snapshots"
cp "$DB" "$BASE/backups/snapshots/catalog_$TS.db"
# shellcheck disable=SC2012 # mtime ordering selects the four newest snapshots.
ls -t "$BASE/backups/snapshots/"*.db | tail -n +5 | xargs -r rm --
echo "$MD5_NEW" > "$STAMP_FILE"
rm -f "$BUNDLE_TMP"
log "=== Backup concluido (bundle md5 $MD5_NEW). Requests upstream nesta run: 2 ==="
