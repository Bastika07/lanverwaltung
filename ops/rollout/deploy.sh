#!/usr/bin/env bash
# Automatisches Dev-Deployment für lanverwaltung (läuft per systemd-Timer).
# Rollt den neuesten main-Commit aus, sobald alle erwarteten GitHub-Workflows dieses Commits erfolgreich sind:
# Quellarchiv von GitHub → Image bauen → isolierter Smoke-Test → Backup (DB + compose.yaml) → Image tauschen
# → Health prüfen, sonst automatischer Rollback. Nur der Dev-Service wird angefasst; die Produktion nie (dafür promote.sh).
set -euo pipefail

# Installationsspezifische Werte (Pfade, Namen, Domains) stehen nicht im Repo, sondern in einer Datei nur für root.
CONFIG=${ROLLOUT_CONFIG:-/etc/lanverwaltung-rollout.conf}
[[ -r $CONFIG ]] || { echo "Konfiguration $CONFIG fehlt (Vorlage: ops/rollout/rollout.conf.example)"; exit 1; }
# shellcheck source=/dev/null
source "$CONFIG"
REPO=${REPO:-Bastika07/lanverwaltung}
STACK=$DEV_STACK PROJECT=$DEV_PROJECT CONTAINER=$DEV_CONTAINER IMAGE=$DEV_IMAGE HEALTH_URL=$DEV_HEALTH_URL BACKUPS=$DEV_BACKUPS
SERVICE=turnierbaum
STATE=/var/lib/lanverwaltung-autodeploy
WORKFLOWS='["Code checks","CodeQL Advanced","Unit tests","npm tests (full suite)","Integration tests","Container security","DAST"]'
KEEP_IMAGES=5 KEEP_BACKUPS=10

exec 9>/run/lanverwaltung-autodeploy.lock
flock -n 9 || exit 0
mkdir -p "$STATE"
log() { echo "$*"; }
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

sha=$(git ls-remote "https://github.com/$REPO" refs/heads/main | cut -f1)
[[ $sha =~ ^[0-9a-f]{40}$ ]] || { log "main konnte nicht gelesen werden"; exit 1; }
short=${sha:0:7}
image="$IMAGE:development-$short"
current=$(sed -n "s/^[[:space:]]*image:[[:space:]]*$IMAGE:development-\([0-9a-f]\{7\}\)[[:space:]]*\$/\1/p" "$STACK/compose.yaml")
[[ -n $current ]] || { log "Image-Zeile in $STACK/compose.yaml nicht gefunden – Abbruch"; exit 1; }
[[ $current == "$short" ]] && exit 0
if [[ -f $STATE/failed-$sha ]]; then exit 0; fi # fehlgeschlagene Revision nicht endlos wiederholen

# CI-Gate: alle erwarteten Workflows des Push-Laufs abgeschlossen und erfolgreich.
runs=$(curl -fsS -H 'Accept: application/vnd.github+json' "https://api.github.com/repos/$REPO/actions/runs?head_sha=$sha&event=push&per_page=50")
gate=$(jq -r --argjson want "$WORKFLOWS" '
  [.workflow_runs | group_by(.name)[] | max_by(.run_number)] as $latest
  | [$want[] as $w | ($latest | map(select(.name == $w)) | .[0]) as $r
     | if $r == null then "fehlt:\($w)" elif $r.status != "completed" then "läuft:\($w)"
       elif $r.conclusion != "success" then "rot:\($w)" else empty end] | join(", ")' <<<"$runs")
if [[ -n $gate ]]; then
  [[ $gate == *rot:* ]] && log "$short wird nicht ausgerollt: $gate"
  exit 0
fi

log "Rolle $short aus (bisher $current)"
work=$(mktemp -d "/var/tmp/$PROJECT-build-XXXXXX")
smoke=$PROJECT-smoke-$short
cleanup() { docker rm -f "$smoke" >/dev/null 2>&1 || true; rm -rf "$work"; }
trap cleanup EXIT
fail() { log "FEHLER $short: $*"; touch "$STATE/failed-$sha"; exit 1; }

curl -fsSL "https://codeload.github.com/$REPO/tar.gz/$sha" | tar -xz -C "$work" --strip-components=1
docker build -q -t "$image" "$work" >/dev/null || fail "Image-Build"

# Isolierter Smoke-Test: kein Netzwerk, keine echten Daten oder Geheimnisse.
docker run -d --name "$smoke" --network none --read-only --tmpfs /tmp --tmpfs /data:uid=1000,gid=1000 \
  --cap-drop ALL --security-opt no-new-privileges:true -e ADMIN_PASSWORD="$(openssl rand -hex 24)" "$image" >/dev/null
wait_healthy "$smoke" 120 || { docker logs --tail 30 "$smoke" 2>&1; fail "Smoke-Test nicht healthy"; }
docker rm -f "$smoke" >/dev/null

# Konsistente Online-Sicherung und Compose-Stand vor dem Tausch.
backup="$BACKUPS/auto-pre-$short-$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p -m 700 "$backup"
cp -p "$STACK/compose.yaml" "$backup/compose.yaml"
compose exec -T "$SERVICE" node lib/database-cli.js backup /data/autodeploy-backup.sqlite >/dev/null || fail "DB-Backup"
docker cp "$CONTAINER:/data/autodeploy-backup.sqlite" "$backup/db.sqlite" >/dev/null
compose exec -T "$SERVICE" rm -f /data/autodeploy-backup.sqlite
previous=$(docker inspect -f '{{.Config.Image}}' "$CONTAINER")
echo "$previous" >"$backup/previous-image"
chmod 600 "$backup"/*

sed -i "s#^\([[:space:]]*image:[[:space:]]*\)$IMAGE:development-[0-9a-f]\{7\}[[:space:]]*\$#\1$image#" "$STACK/compose.yaml"
grep -q "image: $image\$" "$STACK/compose.yaml" || { cp -p "$backup/compose.yaml" "$STACK/compose.yaml"; fail "compose.yaml nicht angepasst"; }
compose up -d --no-deps --no-build --pull never "$SERVICE" >/dev/null 2>&1

if ! wait_healthy "$CONTAINER" 150 || ! curl -fsS -o /dev/null --max-time 10 "$HEALTH_URL"; then
  docker logs --tail 30 "$CONTAINER" 2>&1 || true
  cp -p "$backup/compose.yaml" "$STACK/compose.yaml"
  compose up -d --no-deps --no-build --pull never "$SERVICE" >/dev/null 2>&1
  wait_healthy "$CONTAINER" 150 && log "Rollback auf $previous erfolgreich" || log "ROLLBACK auf $previous NICHT healthy – bitte prüfen"
  fail "neues Image nicht healthy, zurückgerollt"
fi

# Quellstand im Stack-Verzeichnis nachziehen (für Dockge/Nachvollziehbarkeit); compose.yaml, .env und Notizen bleiben.
for d in lib public docs ops test test-support .github; do rm -rf "${STACK:?}/$d"; done
tar -C "$work" --exclude=./compose.yaml --exclude=./.env --exclude=./DEPLOYMENT.md -cf - . | tar -C "$STACK" -xf -

cat >"$STACK/DEPLOYMENT.md" <<EOF
# $PROJECT – Dev (automatisch ausgerollt)

Stand: $(date -Is)
Commit: $sha
Image: $image
Vorher: $previous
Backup: $backup

Ausgerollt von /opt/lanverwaltung-autodeploy/deploy.sh (systemd-Timer lanverwaltung-autodeploy.timer, alle 5 Minuten),
sobald alle GitHub-Workflows des main-Commits grün sind. Protokoll: journalctl -u lanverwaltung-autodeploy

Rollback: \`cp $backup/compose.yaml $STACK/compose.yaml\` und
\`docker compose -p $PROJECT up -d --no-deps --no-build --pull never $SERVICE\` im Stack-Verzeichnis.
Datenbank nur bei gestopptem Dev-Container aus $backup/db.sqlite zurücksichern (verwirft spätere Änderungen).
Die Produktion wird von diesem Automatismus nie verändert (Rollout dorthin: promote.sh).
EOF
chmod 600 "$STACK/DEPLOYMENT.md"
log "OK: $short ist ausgerollt und healthy ($HEALTH_URL)"

# Aufräumen: alte Dev-Image-Tags (Image-IDs mit Produktions-Tags bleiben dabei erhalten) und alte Auto-Backups.
docker images --format '{{.CreatedAt}}\t{{.Repository}}:{{.Tag}}' | grep -P "\t$IMAGE:development-[0-9a-f]{7}\$" | sort -r \
  | cut -f2 | tail -n +$((KEEP_IMAGES + 1)) | grep -vxF "$image" | grep -vxF "$previous" | xargs -r docker rmi >/dev/null 2>&1 || true
ls -1dt "$BACKUPS"/auto-pre-* 2>/dev/null | tail -n +$((KEEP_BACKUPS + 1)) | xargs -r rm -rf
