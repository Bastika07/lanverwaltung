# SQLite-Datenhaltung

Ab dieser Version ist **`DATA_DIR/db.sqlite`** die maßgebliche Datenbank. Node.js ab **22.16** wird benötigt (`node:sqlite` und dessen Online-Backup-API); keine zusätzlichen npm-Abhängigkeiten. Das Dockerimage enthält eine passende Node-Version. Node 22 kann noch eine ExperimentalWarning für das eingebaute SQLite-Modul ausgeben.

## Einmalige Übernahme

Beim ersten Start ohne initialisierte SQLite-Datenbank wird `db.json` in **einer Transaktion** importiert. Alle Felder, Reihenfolgen, Personen-/Discord-Zuordnungen, Website-Texte, Profile, Sitzungen, Bestellungen, Tickets, Eintrittscodes und Ergebnisse bleiben unverändert. Der geladene SQLite-Stand wird vor Commit mit der JSON-Quelle verglichen. Die existierenden Sicherheitsmigrationen bleiben separat versioniert; die Speicherumstellung erneuert keine Ticketcodes.

Die ursprüngliche `db.json` bleibt unangetastet, ist danach aber **nur ein alter Migrationsstand**, keine aktuelle Sicherung. Eine initialisierte SQLite-Datenbank hat immer Vorrang; Änderungen an der alten JSON-Datei werden nicht mehr eingelesen. Bei ungültigem JSON, doppelten IDs/Codes, unpassendem SQLite-Schema oder Integritätsfehlern wird der Start abgebrochen, nicht still auf leere Daten oder altes JSON zurückgefallen. Nach einem fehlgeschlagenen Erstimport kann die Quelle korrigiert und die Migration erneut gestartet werden. Vorher eine geschützte Sicherung anlegen.

## Tabellen und Transaktionen

Eigene Datensätze für `persons`, `accounts`, `announcements`, `events`, `orders`, `tickets` und `user_sessions`. Eventbezogene Turniere, Programmpunkte, Ticketarten, Teilnahmen und Gastserver liegen in `event_items`; globale Einstellungen und Sitzplan in `root_state`. Flexible Fachinhalte und Ergebnisbäume bleiben JSON-Spalten **innerhalb von SQLite**, nicht eine einzelne JSON-Gesamtdatei. Indizes unterstützen Kontozuordnung, Bestellstatus, Personenbezug und Ticketcodes. Eintrittscodes sind eindeutig; Event-/Bestellzuordnungen sind per Fremdschlüssel gesichert. Historische Personen-/Käuferbezüge werden bewusst nicht durch kaskadierende Personenlöschung entfernt.

`save()` schreibt nur veränderte Datensätze und notwendige Löschungen in einer `BEGIN IMMEDIATE`-Transaktion. Entweder der komplette Speicherstand wird übernommen oder keiner. SQLite läuft mit WAL und `synchronous=FULL`. Schlägt ein Speichern fehl, wird die App beendet, statt anschließend mit einem ungespeicherten Arbeitsspeicherstand Erfolg zu melden; Docker startet sie gemäß Restart-Policy neu.

**Eine App-Instanz pro Datenverzeichnis.** Die Fachlogik arbeitet weiterhin mit ihrem Objektmodell im Arbeitsspeicher; dies ist kein Multi-Instance-/Load-Balancer-Umbau. Ein separater SQLite-Betriebssystemlock in `db.writer.sqlite` verhindert einen zweiten App-Schreiber. Er wird auch bei Prozessabsturz automatisch freigegeben. Den Lock nicht löschen/ersetzen, während die App läuft. Leser und Online-Backups bleiben erlaubt. Direkte SQL-Änderungen während des App-Betriebs sind nicht unterstützt. Die Transaktionsgrenze ist jeweils `save()`, nicht pauschal ein kompletter HTTP-Request mit mehreren Speicherschritten.

SQLite muss auf einem lokalen, zuverlässig sperrbaren Dateisystem liegen, nicht auf NFS/SMB oder in einem aktiv synchronisierten Cloud-Ordner. Für lokalen Entwicklungsbetrieb `DATA_DIR` bei Bedarf auf ein Verzeichnis außerhalb von OneDrive setzen.

## Konsistente Sicherung im Betrieb

**Nicht nur die laufende `db.sqlite` kopieren:** Noch nicht eingecheckte Änderungen können in `db.sqlite-wal` liegen. Stattdessen erstellt die SQLite-Backup-API eine konsistente, eigenständige Datei und prüft deren Integrität:

```sh
docker compose exec -T turnierbaum node lib/database-cli.js backup /data/backups/lan-2026-10-23.sqlite
docker compose cp turnierbaum:/data/backups/lan-2026-10-23.sqlite ./lan-2026-10-23.sqlite
docker compose exec -T turnierbaum node lib/database-cli.js check
```

Ein vorhandenes Sicherungsziel wird nicht überschrieben. Dateinamen müssen je Sicherung neu gewählt werden. Für automatische Läufe die erste Anweisung als Pre-Backup-Schritt nutzen oder den Container sauber stoppen und dann das vollständige Datenvolume sichern. **Eine tägliche Dockge-/Host-Sicherung ist ausreichend als bestehender Ablauf, sofern sie das tatsächliche Datenvolume und nicht nur den Dockge-Container bzw. Compose-Dateien enthält und konsistent aufgenommen wird.** Nicht jeder Dateikopier-Backupjob liefert bei laufendem WAL eine konsistente Sicherung. Einen bereits konsistenten Snapshot möglichst außerhalb desselben Hosts aufbewahren. In dieser Umstellung wird kein zusätzlicher zeitgesteuerter Backupjob eingerichtet.

Die CLI legt Backups mit eingeschränkten Rechten an. Sie enthalten persönliche Daten und Ticketgeheimnisse. Aufbewahrung und Zugriff entsprechend begrenzen. `db.sqlite`, `db.sqlite-wal`, `db.sqlite-shm`, `db.writer.sqlite` und alte JSON-/SQLite-Sicherungen gehören nicht ins Repository.

## Wiederherstellung und Rollback

1. App stoppen; keine zweite App darf dasselbe Datenverzeichnis verwenden.
2. Aktuellen vollständigen Datenbestand geschützt sichern. Die vorhandene `db.sqlite` **und dazugehörige** `-wal`/`-shm`-Dateien gemeinsam aus dem aktiven Pfad verschieben, nicht nur die Hauptdatei ersetzen.
3. Eine mit der Backup-API erstellte Sicherung als `db.sqlite` einspielen; UID/GID 1000 und restriktive Rechte sicherstellen. Die Sicherung benötigt keine alten WAL-Dateien.
4. Integrität prüfen und App starten. Login, Profil, Tickets, Sitzplätze und Ergebnisse prüfen. Spätere Löschanfragen nach Wiederherstellung alter Sicherungen erneut berücksichtigen.

Ein Rollback auf eine frühere **JSON-Anwendung** darf nicht einfach das ursprüngliche `db.json` verwenden: Zwischenzeitliche Änderungen gingen verloren. Vorher aus SQLite einen aktuellen Stand exportieren:

```sh
docker compose exec -T turnierbaum node lib/database-cli.js export-json /data/rollback-current.json
```

Das ist ein expliziter Export, keine zweite parallel beschriebene Datenhaltung. Für einen exakten Rollback Schreibzugriffe stoppen und den Export aus dem nun ruhenden SQLite-Stand erzeugen. Exportdatei geschützt sichern und kontrolliert als `db.json` der alten Anwendung bereitstellen. Danach nie beide Versionen parallel schreiben lassen.
