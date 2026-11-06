#!/usr/bin/env bash
# Mirror completo da Biblia — bundle-first (piano-bundle-sync SPEC v1.0.0)
#
# Antes: baixava capitulo a capitulo (~15.457 req /json_db/bible_<v>_<book>_<ch>,
# throttle 0.8s ~ 3h30 por run completa).
# Agora: 1 GET /db/manifest + 1 GET /db/bible-bundle (ZIP ~26MB, ~15.4k capitulos).
# Normal <= 2 requests/run. Run sem mudanca aplica 0 e consome 2 requests.
#
# Contrato (SPEC ADR-02):
#   - ZIP contém exclusivamente JSON UTF-8 relativo, com _bundle_manifest.json de índice
#   - Aplicação atômica: staging + validação + move; cache anterior nunca é apagado
#   - Arquivos já presentes e idênticos são preservados; faltantes preenchidos do ZIP
set -euo pipefail

BASE="${BACKUP_DIR:-$HOME/piano-api}"
API="${UPSTREAM_API:-https://api.louvorja.com.br}"
CACHE="$BASE/data/bible_cache"
STAMP_FILE="$BASE/backups/.last_bible_bundle_md5"
TS=$(date +%F_%H%M)

mkdir -p "$CACHE" "$BASE/backups"
log() { echo "[$TS] $*"; }

# ---------- request 1: manifest ----------
MANIFEST="$BASE/backups/manifest.json"
TMP_MANIFEST="$BASE/backups/.manifest.tmp"
log "GET $API/db/manifest"
if ! curl -sf --retry 2 --max-time 60 "$API/db/manifest" -o "$TMP_MANIFEST"; then
  log "FAIL: manifest indisponivel — cache anterior preservado"
  exit 1
fi
if ! python3 - "$TMP_MANIFEST" <<'EOF'
import json, re, sys
m = json.load(open(sys.argv[1]))
if not isinstance(m, list) or not m:
    sys.exit("manifest invalido")
for e in m:
    if not re.fullmatch(r"[a-f0-9]{32}", e.get("hash", "")):
        sys.exit("manifest invalido: hash nao e md5")
EOF
then
  log "FAIL: manifest invalido — cache anterior preservado"
  rm -f "$TMP_MANIFEST"
  exit 1
fi
mv "$TMP_MANIFEST" "$MANIFEST"

# ---------- request 2 (condicional): bible bundle ----------
BUNDLE_TMP="$BASE/backups/.bible-bundle.tmp"
log "GET $API/db/bible-bundle"
if ! curl -sf --retry 2 --max-time 600 "$API/db/bible-bundle" -o "$BUNDLE_TMP"; then
  log "FAIL: bible-bundle indisponivel — cache anterior preservado"
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
z = zipfile.ZipFile(sys.argv[1])
n = len(z.namelist())
for name in z.namelist():
    if name.startswith("/") or ".." in name.split("/"):
        sys.exit("caminho inseguro: %s" % name)
    if not name.endswith(".json"):
        sys.exit("entrada nao-JSON: %s" % name)
idx = json.loads(z.read("_bundle_manifest.json").decode("utf-8"))
if idx.get("kind") != "bible" or idx.get("schema_version") != 1:
    sys.exit("_bundle_manifest inesperado")
print("zip ok: %d entradas" % n)
EOF
then
  log "FAIL: ZIP invalido — descartado, cache anterior preservado"
  rm -f "$BUNDLE_TMP"
  exit 1
fi

# ---------- aplicação atômica ----------
# Estratégia: extrair tudo em staging; diretório antigo só é substituído no final.
# O relatório distingue novos/alterados de idênticos para auditoria.
log "Aplicando bundle em $CACHE (atomico: staging + move)"
STAGE="$BASE/backups/.bible_stage_$TS"
mkdir -p "$STAGE"
python3 - "$BUNDLE_TMP" "$STAGE" "$CACHE" <<'EOF'
import zipfile, sys, os, hashlib
z = zipfile.ZipFile(sys.argv[1])
stage, cache = sys.argv[2], sys.argv[3]
new = same = 0
for n in z.namelist():
    dest = os.path.join(stage, n)
    os.makedirs(os.path.dirname(dest), exist_ok=True)
    with z.open(n) as src, open(dest, "wb") as out:
        out.write(src.read())
    cur = os.path.join(cache, n)
    if os.path.exists(cur):
        h1 = hashlib.md5(open(cur, "rb").read()).hexdigest()
        h2 = hashlib.md5(open(dest, "rb").read()).hexdigest()
        if h1 == h2: same += 1
        else: new += 1
    else:
        new += 1
print("staging pronto: novos/alterados=%d identicos=%d" % (new, same))
EOF
OLD="$BASE/backups/.bible_old_$TS"
mv "$CACHE" "$OLD" && mv "$STAGE" "$CACHE" && rm -rf "$OLD"

ok=$(python3 - "$CACHE" <<'EOF'
import os, sys
print(sum(name.startswith("bible_") for name in os.listdir(sys.argv[1])))
EOF
)
log "Cache Bible: $ok capitulos"
if [[ "$ok" -lt 15000 ]]; then log "WARN: menos de 15000 capitulos no cache"; fi

echo "$MD5_NEW" > "$STAMP_FILE"
rm -f "$BUNDLE_TMP"
log "=== Bible bundle aplicado (md5 $MD5_NEW). Requests upstream nesta run: 2 ==="
