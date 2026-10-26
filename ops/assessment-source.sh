#!/bin/sh
# Nur dedizierten Quellcodeexport und geklonte Bundle-Historie übergeben, nie Produktionsverzeichnisse.
# Regeln vorher aus https://github.com/semgrep/semgrep-rules.git klonen und auf rules_commit auschecken.
set -eu
umask 077
source_dir=$(realpath "${1:?Quellcodeexport fehlt}")
history_dir=$(realpath "${2:?Bundle-Klon fehlt}")
rules_dir=$(realpath "${3:?Regel-Klon fehlt}")
reports=${4:?Neues Berichtverzeichnis fehlt}
rules_commit=16b9e6d45f10649f6a531ec4838ed9924372c3bc
test "$(git -C "$rules_dir" rev-parse HEAD)" = "$rules_commit"
test ! -e "$source_dir/.git"
test ! -e "$source_dir/.env"
test ! -e "$source_dir/data"
mkdir "$reports"
reports=$(realpath "$reports")
semgrep=semgrep/semgrep:1.182.0@sha256:4a34048c04fef049f71665047f074cffb00cc3d89482f965a5cd151d589237af
gitleaks=ghcr.io/gitleaks/gitleaks:v8.30.1@sha256:c00b6bd0aeb3071cbcb79009cb16a60dd9e0a7c60e2be9ab65d25e6bc8abbb7f
docker run --rm --network none --cpus 2 --memory 1g --read-only --tmpfs /tmp \
  -e HOME=/tmp -e SEMGREP_SEND_METRICS=off -v "$source_dir":/src:ro -v "$rules_dir":/rules:ro \
  "$semgrep" semgrep scan --config /rules/javascript --config /rules/generic \
  --metrics off --disable-version-check --no-git-ignore --json /src > "$reports/semgrep.json" 2> "$reports/semgrep.log"
for kind in source history; do
  if [ "$kind" = source ]; then directory=$source_dir; mode=dir; else directory=$history_dir; mode=git; fi
  docker run --rm --network none --cpus 2 --memory 512m --read-only --tmpfs /tmp \
    -e GIT_CONFIG_COUNT=1 -e GIT_CONFIG_KEY_0=safe.directory -e GIT_CONFIG_VALUE_0=/src \
    -v "$directory":/src:ro --entrypoint /bin/sh "$gitleaks" -c \
    'gitleaks "$1" /src --redact=100 --report-format json --report-path /tmp/report.json --exit-code 0 && cat /tmp/report.json' sh "$mode" \
    > "$reports/gitleaks-$kind.json" 2> "$reports/gitleaks-$kind.log"
done
printf '%s\n' "$rules_commit" > "$reports/rules-commit.txt"
sha256sum "$reports/"*.json > "$reports/SHA256SUMS"
# Findings sind Triage-Eingaben, kein automatischer Sicherheitsnachweis. Parserwarnungen im JSON prüfen.
