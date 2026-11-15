#!/usr/bin/env bash
# Mirror completo da Biblia — bundle-first (piano-bundle-sync SPEC v1.2.1)
#
# Antes: baixava capitulo a capitulo (~15.457 req /json_db/bible_<v>_<book>_<ch>,
# throttle 0.8s ~ 3h30 por run completa).
# Depois (PR #240): 2 requests/run sempre — manifest + bible-bundle (~26MB como sonda,
# md5 do ZIP como stamp). Agora (SPEC v1.2.1, RF-24): gate digest entry-wise —
# warm run = 1 request (manifest), 0 ZIP; ZIP só quando o digest do subset diverge.
#
# Contrato (SPEC ADR-09/10/11, v1.2.1):
#   - GET /db/manifest -> array entry-wise {file, table, path, hash}, hash = MD5 do arquivo
#   - Subset bible (padrão de chave ADR-09 bible_<v>_<book>_<ch>) + manifestDigest =
#     SHA-256 da serialização canônica (linhas file\tmd5\n ordenadas byte-a-byte por file)
#   - Estado schema 2 em backups/.state_bible.json {schema, artifact, manifestDigest,
#     checkedAtEpochMs, appliedAtEpochMs}; gravado SÓ após a aplicação atômica
#   - ZIP contém exclusivamente JSON UTF-8 relativo, com _bundle_manifest.json de índice
#   - Changed/cold: validação ADR-10 completa (completude subset⊆ZIP + congruência MD5
#     entry-wise) antes do staging + move; cache anterior nunca é apagado
set -euo pipefail

BASE="${BACKUP_DIR:-$HOME/piano-api}"
API="${UPSTREAM_API:-https://api.louvorja.com.br}"
CACHE="$BASE/data/bible_cache"
STATE_FILE="$BASE/backups/.state_bible.json"
LEGACY_STAMP="$BASE/backups/.last_bible_bundle_md5"
ARTIFACT="bible"
TS=$(date +%F_%H%M)
FORCE="${1:-}"

mkdir -p "$CACHE" "$BASE/backups"
log() { echo "[$TS] $*"; }

now_ms() { python3 -c 'import time; print(int(time.time() * 1000))'; }

# ---------- request 1: manifest ----------
MANIFEST="$BASE/backups/manifest.json"
TMP_MANIFEST="$BASE/backups/.manifest.tmp"
log "GET $API/db/manifest"
if ! curl -sf --retry 2 --max-time 60 "$API/db/manifest" -o "$TMP_MANIFEST"; then
  log "FAIL: manifest indisponivel — cache anterior preservado"
  exit 1
fi

# ---------- validação ADR-09 + subset + digest canônico ----------
DIGEST=$(python3 - "$TMP_MANIFEST" "$ARTIFACT" <<'PYEOF'
import hashlib, json, re, sys

manifest_path, artifact = sys.argv[1], sys.argv[2]
try:
    m = json.load(open(manifest_path, encoding="utf-8"))
except Exception as exc:
    sys.exit("manifest invalido: JSON ilegivel: %s" % exc)
if not isinstance(m, list) or not m:
    sys.exit("manifest invalido: nao e lista nao-vazia")

BIBLE_KEY = re.compile(r"^bible_[a-z0-9]+_\d+_\d+$")
CATALOG_KEY = re.compile(
    r"^(?:pt|es)_(?:categories|musics|hymnal|hymnal_\d+|bible_book|bible_version)$"
    r"|^music_\d+$|^album_\d+$|^config$"
)
MD5 = re.compile(r"^[a-f0-9]{32}$")
CTRL = re.compile(r"[\x00-\x1f]")

subset = []
seen = set()
ignored = 0
for e in m:
    if not isinstance(e, dict):
        sys.exit("manifest invalido: entry nao e objeto")
    file, h = e.get("file"), e.get("hash")
    table, path = e.get("table"), e.get("path")
    if not isinstance(file, str) or not isinstance(h, str):
        sys.exit("manifest invalido: file/hash nao sao strings: %r" % (e,))
    if not isinstance(table, str) or not isinstance(path, str):
        sys.exit("manifest invalido: table/path nao sao strings: %r" % (e,))
    if not file.endswith(".json"):
        sys.exit("manifest invalido: file nao termina em .json: %s" % file)
    if "/" in file or ".." in file or "\\" in file or CTRL.search(file):
        sys.exit("manifest invalido: file inseguro: %r" % file)
    if not MD5.fullmatch(h):
        sys.exit("manifest invalido: hash nao e md5: %s" % file)
    if file in seen:
        sys.exit("manifest invalido: file duplicado: %s" % file)
    seen.add(file)
    key = file[: -len(".json")]
    if artifact == "catalog":
        if CATALOG_KEY.fullmatch(key):
            subset.append((file, h))
    elif BIBLE_KEY.fullmatch(key):
        subset.append((file, h))
    else:
        ignored += 1  # fora dos padrões: ignorada com log sanitizado, sem fail

if not subset:
    sys.exit("manifest invalido: subset %s vazio" % artifact)

lines = "".join("%s\t%s\n" % (f, h) for f, h in sorted(subset, key=lambda p: p[0].encode("utf-8")))
sys.stderr.write("subset %s: %d entries, %d fora dos padroes ignoradas\n" % (artifact, len(subset), ignored))
print(hashlib.sha256(lines.encode("utf-8")).hexdigest())
PYEOF
) || { log "FAIL: manifest invalido — descartado, cache anterior preservado"; rm -f "$TMP_MANIFEST"; exit 1; }
mv "$TMP_MANIFEST" "$MANIFEST"

# ---------- estado schema 2 + migração one-shot ----------
APPLIED=$(python3 -c '
import json, sys
try:
    s = json.load(open(sys.argv[1]))
    if s.get("schema") == 2 and s.get("artifact") == sys.argv[2]:
        print(s.get("manifestDigest", ""))
except Exception:
    pass
' "$STATE_FILE" "$ARTIFACT" 2>/dev/null || true)
MIGRATING=0
if [[ -z "$APPLIED" ]]; then
  if [[ -f "$LEGACY_STAMP" ]]; then
    log "Migracao one-shot: stamp legado presente — tratando como divergente (cold apply)"
  fi
  MIGRATING=1
  APPLIED=""
fi

# ---------- gate digest: warm run = 1 request, 0 ZIP ----------
if [[ "$MIGRATING" == 0 && "$APPLIED" == "$DIGEST" && "$FORCE" != "--force" ]]; then
  CHECKED=$(now_ms)
  python3 - "$STATE_FILE" "$ARTIFACT" "$APPLIED" "$CHECKED" <<'PYEOF'
import json, os, sys
path, artifact, digest, checked = sys.argv[1], sys.argv[2], sys.argv[3], int(sys.argv[4])
try:
    s = json.load(open(path))
except Exception:
    s = {}
s.update({
    "schema": 2,
    "artifact": artifact,
    "manifestDigest": digest,
    "checkedAtEpochMs": checked,
    "appliedAtEpochMs": s.get("appliedAtEpochMs", 0),
})
tmp = path + ".tmp"
with open(tmp, "w") as f:
    json.dump(s, f)
os.replace(tmp, path)
PYEOF
  log "Up-to-date (manifestDigest $DIGEST igual ao aplicado). 1 request nesta run, 0 ZIP."
  exit 0
fi

# ---------- request 2 (condicional): bible bundle ----------
BUNDLE_TMP="$BASE/backups/.bible-bundle.tmp"
log "GET $API/db/bible-bundle"
if ! curl -sf --retry 2 --max-time 600 "$API/db/bible-bundle" -o "$BUNDLE_TMP"; then
  log "FAIL: bible-bundle indisponivel — cache anterior preservado"
  exit 1
fi

# ---------- validação ADR-10: estrutura + completude subset⊆ZIP + congruência MD5 entry-wise ----------
log "manifestDigest divergiu ($DIGEST vs aplicado) — validando ZIP (ADR-10)"
if ! python3 - "$BUNDLE_TMP" "$MANIFEST" "$ARTIFACT" <<'PYEOF'
import hashlib, json, re, sys, zipfile

bundle_path, manifest_path, artifact = sys.argv[1], sys.argv[2], sys.argv[3]
BIBLE_KEY = re.compile(r"^bible_[a-z0-9]+_\d+_\d+$")
CATALOG_KEY = re.compile(
    r"^(?:pt|es)_(?:categories|musics|hymnal|hymnal_\d+|bible_book|bible_version)$"
    r"|^music_\d+$|^album_\d+$|^config$"
)
pattern = CATALOG_KEY if artifact == "catalog" else BIBLE_KEY
manifest = json.load(open(manifest_path, encoding="utf-8"))
subset = {}
for e in manifest:
    key = e["file"][: -len(".json")]
    if pattern.fullmatch(key):
        subset[e["file"]] = e["hash"]

z = zipfile.ZipFile(bundle_path)  # corrompido -> exceção
names = set(z.namelist())
for n in z.namelist():
    if n.startswith("/") or ".." in n.split("/") or "\\" in n:
        sys.exit("caminho inseguro no zip: %s" % n)
    if not n.endswith(".json"):
        sys.exit("entrada nao-JSON no zip: %s" % n)
    with z.open(n) as f:
        json.loads(f.read().decode("utf-8"))  # JSON invalido -> exceção

idx = json.loads(z.read("_bundle_manifest.json").decode("utf-8"))
if idx.get("kind") != artifact or idx.get("schema_version") != 1:
    sys.exit("_bundle_manifest inesperado")

# completude subset⊆ZIP
missing = [f for f in subset if f not in names]
if missing:
    sys.exit("bundle incompleto: %d entries do subset ausentes no ZIP (ex: %s)" % (len(missing), missing[0]))

# congruência MD5 entry-wise: bytes extraídos === hash do manifest para todo entry do subset
for f, expected in sorted(subset.items()):
    actual = hashlib.md5(z.read(f)).hexdigest()
    if actual != expected:
        sys.exit("congruencia MD5 falhou para %s: zip=%s manifest=%s — bundle invalido" % (f, actual, expected))

if artifact == "catalog":
    for k in ("pt_categories.json", "pt_musics.json", "config.json"):
        if k not in names:
            sys.exit("chave essencial ausente: %s" % k)
else:
    if not any(n.startswith("bible_") for n in names):
        sys.exit("nenhum capitulo bible_* no zip")
print("zip ok: %d entradas, subset %s validado entry-wise (%d)" % (len(names), artifact, len(subset)))
PYEOF
then
  log "FAIL: ZIP invalido (ADR-10) — descartado, cache anterior preservado"
  rm -f "$BUNDLE_TMP"
  exit 1
fi

# ---------- aplicação atômica ----------
# Estratégia: extrair tudo em staging; diretório antigo só é substituído no final.
# O relatório distingue novos/alterados de idênticos para auditoria.
log "Aplicando bundle em $CACHE (atomico: staging + move)"
STAGE="$BASE/backups/.bible_stage_$TS"
mkdir -p "$STAGE"
python3 - "$BUNDLE_TMP" "$STAGE" "$CACHE" <<'PYEOF'
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
PYEOF
OLD="$BASE/backups/.bible_old_$TS"
mv "$CACHE" "$OLD" && mv "$STAGE" "$CACHE" && rm -rf "$OLD"

ok=$(python3 - "$CACHE" <<'PYEOF'
import os, sys
print(sum(name.startswith("bible_") for name in os.listdir(sys.argv[1])))
PYEOF
)
log "Cache Bible: $ok capitulos"
if [[ "$ok" -lt 15000 ]]; then log "WARN: menos de 15000 capitulos no cache"; fi

# ---------- estado (só após o commit atômico) + migração one-shot ----------
CHECKED=$(now_ms)
python3 - "$STATE_FILE" "$ARTIFACT" "$DIGEST" "$CHECKED" <<'PYEOF'
import json, os, sys
path, artifact, digest, checked = sys.argv[1], sys.argv[2], sys.argv[3], int(sys.argv[4])
s = {
    "schema": 2,
    "artifact": artifact,
    "manifestDigest": digest,
    "checkedAtEpochMs": checked,
    "appliedAtEpochMs": checked,
}
tmp = path + ".tmp"
with open(tmp, "w") as f:
    json.dump(s, f)
os.replace(tmp, path)
PYEOF
if [[ "$MIGRATING" == 1 && -f "$LEGACY_STAMP" ]]; then
  rm -f "$LEGACY_STAMP"
  log "Migracao concluida: stamp legado $LEGACY_STAMP removido"
fi
rm -f "$BUNDLE_TMP"
log "=== Bible bundle aplicado (manifestDigest $DIGEST). Requests upstream nesta run: 2 ==="
