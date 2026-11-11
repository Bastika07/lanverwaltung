#!/usr/bin/env bash
# Produktions-Rollout: befördert genau das Image, das auf Dev läuft und healthy ist (Dev rollt deploy.sh aus).
# Kein Neubau. Vorher konsistente Sicherung (DB, Datenvolume, compose.yaml, .env, DEPLOYMENT.md), danach Prüfung,
# bei Fehlschlag automatischer Rollback. Bricht ab, solange ein Event aktiv ist.
#
#   promote.sh status             Stand von Produktion und Dev, aktives Event, letzte Sicherung
#   promote.sh promote <commit>   Dev-Image dieses Commits (7–40 Hex-Zeichen) auf Produktion bringen
#   promote.sh rollback           auf das Image unter „Vorher:“ in DEPLOYMENT.md zurück (Datenbank bleibt)
#
# Für einen eingeschränkten SSH-Schlüssel: authorized_keys mit restrict,command="…/promote.sh"; der gewünschte
# Befehl kommt dann aus SSH_ORIGINAL_COMMAND und wird streng geprüft. Protokoll: journalctl -t lanverwaltung-promote
set -euo pipefail

# Installationsspezifische Werte (Pfade, Namen, Domains) stehen nicht im Repo, sondern in einer Datei nur für root.
CONFIG=${ROLLOUT_CONFIG:-/etc/lanverwaltung-rollout.conf}
[[ -r $CONFIG ]] || { echo "Konfiguration $CONFIG fehlt (Vorlage: ops/rollout/rollout.conf.example)"; exit 1; }
# shellcheck source=/dev/null
source "$CONFIG"
STACK=$PROD_STACK PROJECT=$PROD_PROJECT CONTAINER=$PROD_CONTAINER IMAGE=$PROD_IMAGE VOLUME=$PROD_VOLUME
DOMAIN=$PROD_DOMAIN BACKUPS=$PROD_BACKUPS
HEALTH_URL=$DOMAIN/api/health
SERVICE=turnierbaum

log() { echo "$*"; logger -t lanverwaltung-promote -- "$*" 2>/dev/null || true; }
die() { log "ABBRUCH: $*"; exit 1; }
compose() { docker compose -p "$PROJECT" --project-directory "$STACK" -f "$STACK/compose.yaml" "$@"; }
wait_healthy() { # Container, Sekunden
  local i status
  for ((i = 0; i < $2; i += 3)); do
    status=$(docker inspect -f '{{.State.Health.Status}}' "$1" 2>/dev/null || echo missing)
    [[ $status == healthy ]] && return 0
    [[ $status == unhealthy || $status == missing ]] && return 1
    sleep 3
  done
  return 1
}
image_of() { sed -n "s/^[[:space:]]*image:[[:space:]]*\($1:[a-z]*-[0-9a-f]\{7\}\)[[:space:]]*\$/\1/p" "$2"; }
# Node im laufenden Produktionscontainer, nur lesend auf die Datenbank. Scheitert die Abfrage, scheitert die Funktion
# (z. B. „aktives Event?“ darf bei einem Fehler nicht als „keines“ gelten); eine leere Ausgabe ist dagegen kein Fehler.
db_query() {
  local out
  out=$(docker exec "$CONTAINER" node -e "const {DatabaseSync}=require('node:sqlite');const d=new DatabaseSync('/data/db.sqlite',{readOnly:true});$1" 2>&1) || return 1
  grep -v -i -e experimentalwarning -e trace-warnings <<<"$out" || true
}
active_event() { db_query "for (const r of d.prepare('SELECT payload FROM events').all()) { const e=JSON.parse(r.payload); if (e.active) console.log(e.name); }"; }

# ---------- Befehl bestimmen (direkt oder über erzwungenen SSH-Befehl) ----------
if [[ -n ${SSH_ORIGINAL_COMMAND:-} ]]; then
  [[ $SSH_ORIGINAL_COMMAND =~ ^(status|rollback|promote\ [0-9a-f]{7,40})$ ]] || die "nicht erlaubter Befehl"
  read -r -a args <<<"$SSH_ORIGINAL_COMMAND"
else
  args=("$@")
fi
cmd=${args[0]:-status}

if [[ $cmd == status ]]; then
  echo "Produktion: $(docker inspect -f '{{.Config.Image}} {{.State.Health.Status}}' "$CONTAINER" 2>/dev/null || echo 'nicht gestartet')"
  echo "Dev:        $(docker inspect -f '{{.Config.Image}} {{.State.Health.Status}}' "$DEV_CONTAINER" 2>/dev/null || echo 'nicht gestartet')"
  events=$(active_event) && echo "Aktives Event: ${events:-keines}" || echo "Aktives Event: nicht ermittelbar"
  echo "Vorher:     $(sed -n 's/^Vorher: //p' "$STACK/DEPLOYMENT.md")"
  echo "Sicherung:  $(ls -1dt "$BACKUPS"/pre-* 2>/dev/null | head -1)"
  exit 0
fi

# Schreibende Befehle: nie parallel zu sich selbst oder zum Dev-Timer (der räumt alte Dev-Images auf)
exec 8>/run/lanverwaltung-promote.lock
flock -n 8 || die "es läuft bereits ein Rollout"
exec 9>/run/lanverwaltung-autodeploy.lock
flock -w 600 9 || die "Dev-Rollout läuft seit über 10 Minuten"

current=$(image_of "$IMAGE" "$STACK/compose.yaml")
[[ -n $current ]] || die "Image-Zeile in $STACK/compose.yaml nicht gefunden"
events=$(active_event) || die "aktives Event nicht ermittelbar – ist $CONTAINER gestartet?"
event=${events%%$'\n'*}
[[ -z $event ]] || die "Event „$event“ ist aktiv – kein Rollout während einer LAN"

case $cmd in
  promote)
    want=${args[1]:-}
    [[ $want =~ ^[0-9a-f]{7,40}$ ]] || die "Commit fehlt oder ungültig"
    short=${want:0:7}
    target="$IMAGE:production-$short"
    [[ $current == "$target" ]] && { log "$short ist bereits auf Produktion – nichts zu tun"; exit 0; }
    source="$DEV_IMAGE:development-$short"
    # Nur befördern, was auf Dev läuft und healthy ist
    [[ $(image_of "$DEV_IMAGE" "$DEV_STACK/compose.yaml") == "$source" ]] || die "$short läuft nicht auf Dev"
    [[ $(docker inspect -f '{{.Config.Image}}' "$DEV_CONTAINER" 2>/dev/null) == "$source" ]] || die "Dev-Container läuft nicht mit $source"
    wait_healthy "$DEV_CONTAINER" 3 || die "Dev ist nicht healthy"
    docker image inspect "$source" >/dev/null 2>&1 || die "Image $source fehlt"
    note="Production promotes the exact image tested on Dev ($source), no rebuild."
    ;;
  rollback)
    target=$(sed -n 's/^Vorher: //p' "$STACK/DEPLOYMENT.md")
    [[ $target =~ ^$IMAGE:production-[0-9a-f]{7}$ ]] || die "kein gültiges „Vorher:“ in DEPLOYMENT.md"
    docker image inspect "$target" >/dev/null 2>&1 || die "Image $target fehlt – Rollback nur von Hand (Backup)"
    short=${target##*-}
    source=$target
    note="Rollback von $current auf $target per promote.sh; Datenbank unverändert."
    ;;
  *) die "unbekannter Befehl: $cmd (status | promote <commit> | rollback)" ;;
esac

log "Rolle $target aus (bisher $current)"
backup="$BACKUPS/pre-revision-$short"
[[ -e $backup ]] && backup="$backup-$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p -m 700 "$backup"
fail() { log "FEHLER: $*"; exit 1; }

# ---------- Sicherung ----------
cp -p "$STACK/compose.yaml" "$STACK/DEPLOYMENT.md" "$backup/"
cp -p "$STACK/.env" "$backup/env"
echo "$current" >"$backup/previous-image"
compose exec -T "$SERVICE" node lib/database-cli.js backup /data/promote-backup.sqlite >/dev/null 2>&1 || fail "DB-Backup"
docker cp "$CONTAINER:/data/promote-backup.sqlite" "$backup/db.sqlite" >/dev/null
compose exec -T "$SERVICE" rm -f /data/promote-backup.sqlite
docker run --rm --user 0 --network none --entrypoint tar -v "$VOLUME:/data:ro" -v "$backup:/backup" "$current" \
  czf /backup/data-volume.tar.gz -C /data . || fail "Volume-Archiv"
chmod 600 "$backup"/*
integrity=$(docker run --rm --user 0 --network none --entrypoint node -v "$backup:/b:ro" "$current" -e \
  "const {DatabaseSync}=require('node:sqlite');console.log(new DatabaseSync('/b/db.sqlite',{readOnly:true}).prepare('PRAGMA integrity_check').get().integrity_check)" 2>/dev/null)
[[ $integrity == ok ]] || fail "Sicherung nicht integer ($integrity)"
counts() { db_query "console.log(['events','persons','orders'].map((t)=>t+' '+d.prepare('SELECT COUNT(*) n FROM '+t).get().n).join(', '))"; }
before=$(counts)
log "Sicherung: $backup ($before)"

# ---------- Umstellen ----------
[[ $cmd == promote ]] && docker tag "$source" "$target"
sed -i "s#^\([[:space:]]*image:[[:space:]]*\)$IMAGE:[a-z]*-[0-9a-f]\{7\}[[:space:]]*\$#\1$target#" "$STACK/compose.yaml"
grep -q "image: $target\$" "$STACK/compose.yaml" || { cp -p "$backup/compose.yaml" "$STACK/compose.yaml"; fail "compose.yaml nicht angepasst"; }
compose up -d --no-deps --no-build --pull never "$SERVICE" >/dev/null 2>&1

check() {
  wait_healthy "$CONTAINER" 150 && curl -fsS -o /dev/null --max-time 10 "$HEALTH_URL" && curl -fsS -o /dev/null --max-time 10 "$DOMAIN/" \
    && [[ $(compose exec -T "$SERVICE" node lib/database-cli.js check 2>&1) == *OK* ]] && [[ $(counts) == "$before" ]]
}
if ! check; then
  docker logs --tail 30 "$CONTAINER" 2>&1 || true
  cp -p "$backup/compose.yaml" "$STACK/compose.yaml"
  compose up -d --no-deps --no-build --pull never "$SERVICE" >/dev/null 2>&1
  wait_healthy "$CONTAINER" 150 && log "Rollback auf $current erfolgreich" || log "ROLLBACK auf $current NICHT healthy – bitte prüfen"
  fail "$target nicht healthy oder Daten abweichend, zurückgerollt"
fi

cat >"$STACK/DEPLOYMENT.md" <<EOF
# $PROJECT

Commit: $short
Image: $target
Image-ID: $(docker image inspect -f '{{.Id}}' "$target")
Domain: $DOMAIN
Backup: $backup (compose.yaml, DEPLOYMENT.md, env, db.sqlite, data-volume.tar.gz, previous-image)
Vorher: $current
Rollout: $(date -Is) per /opt/lanverwaltung-autodeploy/promote.sh

$note
Container healthy, $DOMAIN antwortet, SQLite-Integrität und Schema OK, Daten unverändert ($before).
Änderungen: https://github.com/${REPO:-Bastika07/lanverwaltung}/compare/${current##*-}...$short

Rollback: \`promote.sh rollback\` (Image unter „Vorher:“) oder von Hand: image-Zeile in compose.yaml auf $current und
\`docker compose -p $PROJECT up -d --no-deps --no-build --pull never $SERVICE\` im Stack-Verzeichnis.
Datenbank nur bei gestopptem Container aus $backup/db.sqlite zurücksichern (verwirft spätere Änderungen).
EOF
chmod 600 "$STACK/DEPLOYMENT.md"
log "OK: $target ist auf Produktion und healthy ($DOMAIN)"
