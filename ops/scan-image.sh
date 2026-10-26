#!/bin/sh
# Keine Docker-Socket-Freigabe an den Scanner. Nur ein exportiertes Image wird gelesen.
set -eu
image=${1:-turnierbaum:latest}
report=${2:-./image-vulnerabilities.json}
scanner=aquasec/trivy:0.76.1@sha256:790fd66d1697395d8693d1acaa1ea702406a20f109b6fc7bac8db623eca6c06c
tmp=$(mktemp -d)
trap 'rm -f "$tmp/image.tar"; rmdir "$tmp"' EXIT HUP INT TERM
docker image save -o "$tmp/image.tar" "$image"
# Vollständiger Bericht auf stdout; keine Produktionsdaten oder Secrets mitscannen.
docker run --rm --read-only --tmpfs /tmp -v "$tmp/image.tar":/image.tar:ro \
  -v seniorenlan-trivy-cache:/root/.cache/ "$scanner" image \
  --input /image.tar --scanners vuln --format json > "$report"
# Gleichen Report auswerten statt mit ggf. neuer DB einen abweichenden zweiten Scan zu starten.
docker run --rm -i --network none --read-only --entrypoint node "$image" -e '
  let input=""; process.stdin.on("data", x=>input+=x); process.stdin.on("end",()=>{
    const report=JSON.parse(input), counts={}; let failed=false;
    for(const result of report.Results||[]) for(const v of result.Vulnerabilities||[]) {
      counts[v.Severity]=(counts[v.Severity]||0)+1;
      if(["HIGH","CRITICAL"].includes(v.Severity)) failed=true;
    }
    console.log(JSON.stringify({counts, highOrCritical:failed})); process.exitCode=failed?1:0;
  });' < "$report"
