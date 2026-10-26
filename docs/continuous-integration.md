# Continuous Integration

GitHub Actions prüft Pushes auf `main`, Pull Requests gegen `main` und manuelle Starts. Codeprüfungen laufen zusätzlich wöchentlich. Alle Tests verwenden synthetische Daten und isolierte temporäre Verzeichnisse; Discord, DMX und Produktionsdaten sind nicht erforderlich. Kein Workflow deployt auf Dev oder Produktion.

| Workflow | Prüfung | Laufzeit |
| --- | --- | --- |
| Code checks | JavaScript-Syntax aller eigenen JS/CJS/MJS-Dateien und Projekt-JSON; actionlint für Workflows | Node 22/24 auf Ubuntu |
| CodeQL Advanced | Sicherheitsanalyse für JavaScript/TypeScript und das Python-Hilfsskript | Ubuntu, ohne Build |
| Unit tests | Rendering/Markdown, Datenschutzlogik, Website-Modul mit Testkontext und CI-Testauswahl | Node 22/24 auf Ubuntu und Windows |
| npm tests (full suite) | Unveränderte vollständige `npm test`-Testsuite | Node 22/24 auf Ubuntu |
| Integration tests | Echter HTTP-Server, SQLite/Dateisystem, Migrationen, Parallelität, Catering und Sicherheits-/Proxy-Grenzen | Node 22/24 auf Ubuntu |
| Container security | Produktionsimage bauen, isolierter Healthcheck, Trivy-Schwachstellenscan | Ubuntu; zusätzlich täglich |

## Lokal ausführen

```sh
npm run check
npm run test:unit
npm run test:integration
npm test
```

Es sind keine npm-Pakete installiert und keine npm-Abhängigkeiten deklariert. Deshalb gibt es absichtlich weder `npm ci` noch einen erfundenen Lockfile oder npm-Cache. Der vorhandene Markdown-Parser bleibt lokal gebündelt.

`ops/run-tests.cjs` definiert die schnellen Unit-Testdateien. Alle übrigen `test/*.test.js` werden automatisch als Integrationstests ausgeführt, einschließlich neu hinzugefügter Dateien. `test/ci.test.js` prüft die vollständige, überschneidungsfreie Aufteilung. `npm test` bleibt die Gesamtsuite. Gemischte Testdateien wie `security.test.js` bleiben vollständig in der Integrationssuite.

Drittanbieter-Actions sind auf vollständige Commit-SHAs fixiert. Workflows haben standardmäßig nur `contents: read`; ausschließlich der CodeQL-Job darf Sicherheitsanalysen hochladen. Es werden keine Repository-Secrets und kein `pull_request_target` verwendet. Gleiche Workflow-Läufe eines Branches/PRs lösen veraltete Läufe ab; Jobs haben Zeitlimits.

CodeQL meldet Befunde im Security-/Code-Scanning-Bereich. Die [Triage der sechs bestehenden Hinweise](codeql-triage.md) dokumentiert Einordnung und offene Folgearbeiten. Ein erfolgreicher Analyselauf bedeutet nicht automatisch, dass es keine Befunde gibt. Verpflichtende Checks und Schweregrad-Grenzen müssen bei Bedarf zusätzlich über Repository-Rulesets konfiguriert werden; diese Einstellungen werden von den Workflows nicht verändert.

## Dependency-Updates

`.github/dependabot.yml` erstellt wöchentlich Update-PRs für GitHub Actions und das Docker-Basisimage. Actions bleiben auf Commit-SHAs, das Node-Image auf einen Digest fixiert. Node-Hauptversionssprünge benötigen eine bewusste Umstellung. Es gibt keine automatischen Merges oder Deployments. Der lokal gebündelte Markdown-Parser und das in `ops/scan-image.sh` fixierte Trivy-Image müssen separat geprüft und aktualisiert werden; Dependabot erfasst diese Shell-/Vendor-Dateien nicht.

## Container-Prüfung

`Container security` baut das echte Produktions-Dockerfile und startet das Image ohne Netzwerkzugang, Portfreigabe oder persistentes Datenvolume. Ein temporäres, beschreibbares `/data` dient ausschließlich dem synthetischen Healthcheck. Danach prüft `ops/scan-image.sh` das exportierte Image mit dem digest-fixierten Trivy-Scanner; der Scanner erhält keinen Docker-Socket. Die Schwachstellendatenbank wird jeweils aktuell geladen.

Jeder gemeldete HIGH-/CRITICAL-Befund lässt den Job fehlschlagen, auch wenn noch kein Fix verfügbar ist. Es gibt keine pauschalen Ignore-Regeln. Der vollständige JSON-Bericht wird auch bei einem fehlgeschlagenen Schwachstellen-Gate für 14 Tage als Actions-Artefakt gespeichert. Netzwerk-/Scannerfehler machen den Lauf ebenfalls rot. Der tägliche Lauf erkennt neu veröffentlichte Schwachstellen auch ohne Codeänderung.

## README-Badges

Die vorhandenen Test-/CodeQL-Badges bleiben erhalten. Ergänzt werden Container-Scan, die aus dem Repository gelesene MIT-Lizenz und die deklarierte Node-Mindestversion. Ein grüner Badge gilt für den jeweiligen CI-Lauf auf `main`, nicht für die gerade auf Dev oder Produktion laufende Version und nicht als allgemeiner Sicherheitsnachweis.