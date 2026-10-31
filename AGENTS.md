# AGENTS.md

Hinweise für KI-Coding-Agenten (Claude Code, Codex, Copilot u. a.), die an diesem Repository arbeiten. Für Menschen gilt die [README](README.md).

## Projekt in Kürze

Selbstgehostetes LAN-Party-System: Turniere, Durchsagen, Programm, Infos, Teilnehmer, Sitzplan, Tickets, Catering, Gastserver, Beamer-Infoscreen und Discord-Bot. Mehrere Events, Personen bleiben eventübergreifend erhalten.

- **Laufzeit:** Node.js ≥ 22.16, **keine npm-Abhängigkeiten**. Nur Node-Bordmittel (`node:http`, `node:sqlite`, `node:crypto`, `node:test` …).
- **Persistenz:** SQLite über `node:sqlite` ([lib/storage.js](lib/storage.js)). Single-Writer-Objektmodell, jeder `save()` ist atomar. Details: [docs/sqlite.md](docs/sqlite.md).
- **Frontend:** Vanilla-JS ohne Build-Schritt in [public/](public/), per `<script>` in [public/index.html](public/index.html) eingebunden. Der Markdown-Parser liegt gebündelt in `public/vendor/`.
- **Sprache:** UI-Texte, Kommentare, Doku und Logmeldungen sind **Deutsch**.

## Struktur

| Pfad | Inhalt |
|---|---|
| [server.js](server.js) | HTTP-Server, Routing, Admin-Zugang, Sicherheits-Header |
| [lib/](lib/) | Serverseitige Domänenmodule (Tickets, Personen, Sitzplan, Catering, Discord, DMX, Zugriff, Sicherheit, Storage …) |
| [public/](public/) | Browser-Code und Styles; [public/bracket.js](public/bracket.js) wird auch serverseitig genutzt |
| [test/](test/) | Tests mit `node:test`; Hilfen in `test/helpers/` und [test-support/isolated.cjs](test-support/isolated.cjs) |
| [ops/](ops/) | Codeprüfung, Testaufteilung, Sicherheits-Assessment, Image-Scan |
| [docs/](docs/) | Feature- und Betriebsdoku (Deutsch) |
| [.github/workflows/](.github/workflows/) | CI: Code checks, CodeQL, Unit-, npm- und Integrationstests, Container-Scan |

## Befehle

```sh
npm run check             # Syntax aller JS/CJS/MJS und Projekt-JSON
npm run test:unit         # schnelle Unit-Tests (Liste in ops/run-tests.cjs)
npm run test:integration  # alle übrigen test/*.test.js
npm test                  # Gesamtsuite
HOST=127.0.0.1 node server.js   # lokal starten, http://127.0.0.1:3000 (Notzugang in data/admin-password.txt)
```

Es gibt **kein** `npm install`/`npm ci` und keinen Lockfile. Nichts davon anlegen.

## Regeln für Änderungen

- **Keine neuen Abhängigkeiten** (npm-Pakete, CDNs, externe Dienste). Benötigte Funktionen mit Node-Bordmitteln umsetzen oder, nach Rücksprache, lokal vendoren.
- **Stil der Umgebung übernehmen:** CommonJS mit `'use strict'`, kompakter Code, deutsche Bezeichner in UI und Kommentaren, Kommentardichte wie im umgebenden Code.
- **Sicherheit hat Vorrang** (siehe README-Abschnitt „Sicherheit (OWASP)“ und [docs/security-operations.md](docs/security-operations.md)):
  - Alle Ausgaben HTML-maskieren, keine Inline-Skripte (CSP), Links nur `http(s)`.
  - Eingaben serverseitig prüfen, Länge begrenzen, nur bekannte Felder übernehmen.
  - Zugriffsrechte serverseitig prüfen (Admin, eigenes Konto, „nur Teilnehmer mit Ticket“), auch auf alternativen API-Pfaden.
  - Öffentliche Antworten ohne Anschriften, Discord-IDs oder interne Notizen.
  - Sicherheitsrelevante Ereignisse über das bestehende `"sec"`-Logging, ohne personenbezogene Daten.
- **Datenmodell:** Neue Felder abwärtskompatibel einführen; bestehende Daten müssen beim Start weiter laden. Migrationen idempotent halten (vgl. [lib/security-migration.js](lib/security-migration.js)).
- **Eventbezug beachten:** Klären, ob Daten pro Event oder global gelten (README-Abschnitt „Events“), und Module über die Modulschalter pro Event respektieren.
- **Tests:** Jede Änderung mit Tests absichern. Tests verwenden nur synthetische Daten und isolierte temporäre Verzeichnisse, nie Discord, DMX oder echte Daten. Neue Testdateien landen automatisch in der Integrationssuite; schnelle, reine Logiktests in `ops/run-tests.cjs` als Unit-Test eintragen (`test/ci.test.js` prüft die Aufteilung).
- **Doku:** Nutzersichtbare Änderungen in der [README](README.md) und ggf. in `docs/` beschreiben, kurz und auf Deutsch.

## Commits und Pull Requests

- Conventional Commits, z. B. `feat: …`, `fix: …`, `ci: …`, `docs: …`. Beschreibung Deutsch oder Englisch.
- PRs gegen `main`. Vor dem PR `npm run check` und `npm test` lokal grün haben.
- Keine Secrets, `.env`-Dateien, Datenbanken oder Sicherungen committen.
