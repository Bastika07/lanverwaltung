#!/bin/sh
# Linux/Docker, nur dedizierter Export. Keine Ziel-URL von außen: nur synthetischer Loopback-Server.
set -eu
umask 077
source_dir=$(realpath "${1:?Quellcodeexport fehlt}")
reports=${2:?Neues Berichtverzeichnis fehlt}
runtime=${3:?Geprüftes Node-App-Runtimeimage fehlt}
test ! -e "$source_dir/.env"
test ! -e "$source_dir/data"
test ! -e "$source_dir/.git"
mkdir "$reports"
reports=$(realpath "$reports")
scanner=ghcr.io/zaproxy/zaproxy:2.17.0@sha256:5ccfff9a411743ab2615136a2edd7416bec9ce41572fa94e935df38c14adb2b6
target_name=seniorenlan-assessment-target-$$
scan_name=seniorenlan-assessment-scanner-$$
trap 'docker rm -fv "$scan_name" "$target_name" >/dev/null 2>&1 || true' EXIT HUP INT TERM
failed=0
for role in anonymous buyer; do
  mkdir "$reports/$role"
  cp "$source_dir/ops/assessment-api.json" "$reports/$role/api.json"
  cp "$source_dir/ops/assessment-zap-hook.py" "$reports/$role/hook.py"
  chown -R 1000:1000 "$reports/$role"
  docker run -d --name "$target_name" --network none --cpus 2 --memory 512m --pids-limit 100 \
    --cap-drop ALL --security-opt no-new-privileges:true \
    --read-only --tmpfs /tmp -v "$source_dir":/app:ro --entrypoint node "$runtime" ops/assessment-target.cjs >/dev/null
  docker exec "$target_name" node -e '
    const fs=require("fs");(async()=>{for(let i=0;i<80;i++){
      if(fs.existsSync("/tmp/assessment-cookie"))return;
      await new Promise(r=>setTimeout(r,100));}process.exit(1)})()'
  cookie=
  if [ "$role" = buyer ]; then cookie=$(docker exec "$target_name" cat /tmp/assessment-cookie); fi
  set +e
  timeout 300 docker run --rm --name "$scan_name" --network container:"$target_name" \
    --cap-drop ALL --security-opt no-new-privileges:true \
    --cpus 2 --memory 1536m --pids-limit 200 --tmpfs /tmp -e _JAVA_OPTIONS=-Xmx768m \
    -e ZAP_AUTH_HEADER_VALUE="$cookie" -v "$reports/$role":/zap/wrk:rw "$scanner" \
    zap-api-scan.py -t api.json -f openapi -J report.json -r report.html \
    --hook /zap/wrk/hook.py -T 2 -s \
    -z '-silent -config ascan.maxScanDurationInMins=2 -config ascan.maxRuleDurationInMins=1 -config ascan.threadPerHost=2 -config ascan.delayInMs=100 -config connection.timeoutInSecs=5' \
    > "$reports/$role.log" 2>&1
  result=$?
  set -e
  printf '%s\n' "$result" > "$reports/$role.exit"
  docker logs "$target_name" > "$reports/$role-target.log" 2>&1
  docker rm -f "$scan_name" >/dev/null 2>&1 || true
  docker rm -fv "$target_name" >/dev/null
  if [ "$result" -gt 2 ] || [ "$result" -eq 1 ]; then failed=1; fi
  echo "ZAP $role Exit: $result (0=ohne Warnung, 2=Warnungen, 1=FAIL, >2=Fehler/unvollständig)"
done
sha256sum "$reports/"*/report.json > "$reports/SHA256SUMS"
exit "$failed"
