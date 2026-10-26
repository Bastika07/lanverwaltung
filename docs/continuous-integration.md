# Continuous Integration

GitHub Actions prüft Pushes auf `main`, Pull Requests gegen `main` und manuelle Starts. Codeprüfungen laufen zusätzlich wöchentlich. Alle Tests verwenden synthetische Daten und isolierte temporäre Verzeichnisse; Discord, DMX und Produktionsdaten sind nicht erforderlich. Kein Workflow deployt auf Dev oder Produktion.

| Workflow | Prüfung | Laufzeit |
| --- | --- | --- |
| Code checks | JavaScript-Syntax aller eigenen JS/CJS/MJS-Dateien und Projekt-JSON; actionlint für Workflows | Node 22/24 auf Ubuntu |
| CodeQL Advanced | Sicherheitsanalyse für JavaScript/TypeScript und das Python-Hilfsskript | Ubuntu, ohne Build |
| Unit tests | Rendering/Markdown, Datenschutzlogik, Website-Modul mit Testkontext und CI-Testauswahl | Node 22/24 auf Ubuntu und Windows |
| npm tests (full suite) | Unveränderte vollständige `npm test`-Testsuite | Node 22/24 auf Ubuntu |
| Integration tests | Echter HTTP-Server, SQLite/Dateisystem, Migrationen, Parallelität, Catering und Sicherheits-/Proxy-Grenzen | Node 22/24 auf Ubuntu |

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

CodeQL meldet Befunde im Security-/Code-Scanning-Bereich. Ein erfolgreicher Analyselauf bedeutet nicht automatisch, dass es keine Befunde gibt. Verpflichtende Checks und Schweregrad-Grenzen müssen bei Bedarf zusätzlich über Repository-Rulesets konfiguriert werden; diese Einstellungen werden von den Workflows nicht verändert.
