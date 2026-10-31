# Continuous Integration

GitHub Actions prüft Pushes auf `main`, Pull Requests gegen `main` und manuelle Starts. Codeprüfungen laufen zusätzlich wöchentlich. Alle Tests verwenden synthetische Daten und isolierte temporäre Verzeichnisse; Discord, DMX und Produktionsdaten sind nicht erforderlich. Kein Workflow deployt auf Dev oder Produktion.

| Workflow | Prüfung | Laufzeit |
| --- | --- | --- |
| Code checks | JavaScript-Syntax aller eigenen JS/CJS/MJS-Dateien und Projekt-JSON; actionlint für Workflows | Node 22/24 auf Ubuntu |
| CodeQL Advanced | SAST mit `security-extended` für JavaScript/TypeScript und das Python-Hilfsskript | Ubuntu, ohne Build; zusätzlich wöchentlich |
| DAST | Aktiver ZAP-API-Scan, anonym und als synthetischer Käufer; Gate ab Schweregrad Mittel | Ubuntu/Docker; zusätzlich wöchentlich |
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

## SAST und DAST

SAST läuft im bestehenden CodeQL-Workflow mit `security-extended`. Ergebnisse stehen unter **Security → Code scanning**. CodeQL macht den Job nicht allein wegen eines Fundes rot: Für eine verbindliche Merge-Sperre müssen Code-Scanning-Regeln und erforderliche Statuschecks im Repository-Ruleset aktiviert werden.

`DAST` läuft bei Pushes auf `main`, Pull Requests gegen `main`, montags und manuell. Der Workflow baut das Laufzeitimage und verwendet einen separaten `git archive`-Export ohne Arbeitskopie, `.git`, `.env` oder Datenverzeichnis. `ops/assessment-zap.sh` startet je Rolle eine neue synthetische Instanz mit zufälligen Test-Sitzungen. Das Ziel hat `--network none`, keine Portfreigabe und nur temporäre Daten; ZAP teilt dessen Netzwerknamespace. Beide Container haben CPU-/Speicher-/Prozesslimits, keine Linux-Capabilities und keine Möglichkeit zur Privilegienerhöhung. Der Scanner erhält keinen Docker-Socket. Images werden vor dem Lauf aus der Registry geladen; die aktiven Scans haben keinen externen Netzwerkzugang. Keine frei konfigurierbare Ziel-URL, keine Produktions-Secrets und keine echten Discord-/DMX-Aufrufe.

`ops/check-dast.cjs` lehnt Befunde ab **Mittel**, Scannerfehler, fehlende/ungültige Berichte, fehlende Rollenprüfungen und unvollständige aktive Scans ab. Niedrige und informative Befunde bleiben zur Bewertung sichtbar. ZAP-Exitcode 2 allein ist kein Fehler; zusätzlich werden JSON-Befunde und Coverage geprüft. Es gibt keine pauschalen Befund-Ausnahmen. Das Gate wird mit synthetischen Berichten auf Erfolg und Fehlerfälle getestet.

JSON-/HTML-Berichte, Coverage und Protokolle bleiben auch nach Fehlern sieben Tage als Actions-Artefakte erhalten. Sie enthalten Testdaten, können aber technische Schwachstellendetails offenlegen: nicht ungeprüft weitergeben und die Sichtbarkeit der Actions-Artefakte beachten.

**Grenzen:** Das vorhandene OpenAPI-Subset umfasst sechs API-Pfade und die Rollen anonym/Käufer. Kein vollständiger Browser-/SPA-Crawl, kein Admin-Scan, kein echter OAuth-End-to-End-Test und keine Prüfung von Produktions-TLS, Proxy oder externen Diensten. Transportfehler einzelner Probeanfragen und HTTP-Statusverteilung stehen im Coverage-Bericht und benötigen separate Bewertung. Ein grüner Scan ersetzt weder die HTTP-Berechtigungstests noch eine vollständige Sicherheitsprüfung. Der Workflow verändert keine Rulesets und führt kein Deployment aus. Den digest-fixierten ZAP-Scanner in `ops/assessment-zap.sh` regelmäßig bewusst aktualisieren.

## Ruleset importieren

Die Vorlage [`.github/rulesets/main.json`](../.github/rulesets/main.json) lässt sich unter **Settings → Rules → Rulesets → New ruleset → Import a ruleset** importieren. Die Datei herunterladen, auswählen, Einstellungen kontrollieren und speichern. Die Vorlage ist auf **Active** eingestellt; das bloße Ablegen im Repository aktiviert nichts.

Sie schützt ausschließlich `main`: Pull Request erforderlich, alle 15 CI-Checks verpflichtend und aktuell zum Zielbranch, CodeQL-Sicherheitsbefunde ab **Mittel** sowie sonstige CodeQL-Fehler blockierend. Force-Push und Branchlöschung sind untersagt. Es gibt keine Bypass-Ausnahmen. Die Zahl notwendiger Review-Zustimmungen ist bewusst **0**, damit ein einzelner Maintainer eigene PRs nach grünen Checks mergen kann; offene Review-Unterhaltungen müssen trotzdem erledigt sein. Für ein Team bei Bedarf mindestens eine Zustimmung einstellen.

Die vorhandenen Checknamen und die GitHub-Actions-App-ID wurden gegen die tatsächlichen Check-Runs des Repositorys geprüft; der neue ZAP-Check entspricht dem Jobnamen im Workflow. Bei Umbenennung eines CI-Jobs auch Ruleset und Vorlage aktualisieren. Erst aktivieren, wenn der DAST-Workflow im PR vorhanden ist und alle Checks erfolgreich gelaufen sind. Nur ein Push auf diesen Featurebranch startet wegen der Branchfilter noch keine CI: Dafür einen Pull Request gegen `main` öffnen. CodeQL muss Ergebnisse für den PR und den Zielbranch haben. Bestehende Befunde können den Merge blockieren; dann bewerten und beheben, nicht das Gate blind abschwächen. Die Code-Scanning-Regel muss vom GitHub-Tarif und der Repository-Konfiguration unterstützt werden.

## Dependency-Updates

`.github/dependabot.yml` erstellt wöchentlich Update-PRs für GitHub Actions und das Docker-Basisimage. Actions bleiben auf Commit-SHAs, das Node-Image auf einen Digest fixiert. Node-Hauptversionssprünge benötigen eine bewusste Umstellung. Es gibt keine automatischen Merges oder Deployments. Der lokal gebündelte Markdown-Parser und das in `ops/scan-image.sh` fixierte Trivy-Image müssen separat geprüft und aktualisiert werden; Dependabot erfasst diese Shell-/Vendor-Dateien nicht.

## Container-Prüfung

`Container security` baut das echte Produktions-Dockerfile und startet das Image ohne Netzwerkzugang, Portfreigabe oder persistentes Datenvolume. Ein temporäres, beschreibbares `/data` dient ausschließlich dem synthetischen Healthcheck. Danach prüft `ops/scan-image.sh` das exportierte Image mit dem digest-fixierten Trivy-Scanner; der Scanner erhält keinen Docker-Socket. Die Schwachstellendatenbank wird jeweils aktuell geladen.

Jeder gemeldete HIGH-/CRITICAL-Befund lässt den Job fehlschlagen, auch wenn noch kein Fix verfügbar ist. Es gibt keine pauschalen Ignore-Regeln. Der vollständige JSON-Bericht wird auch bei einem fehlgeschlagenen Schwachstellen-Gate für 14 Tage als Actions-Artefakt gespeichert. Netzwerk-/Scannerfehler machen den Lauf ebenfalls rot. Der tägliche Lauf erkennt neu veröffentlichte Schwachstellen auch ohne Codeänderung.

## README-Badges

Die vorhandenen Test-/CodeQL-Badges bleiben erhalten. Ergänzt werden Container-Scan, die aus dem Repository gelesene MIT-Lizenz und die deklarierte Node-Mindestversion. Ein grüner Badge gilt für den jeweiligen CI-Lauf auf `main`, nicht für die gerade auf Dev oder Produktion laufende Version und nicht als allgemeiner Sicherheitsnachweis.
