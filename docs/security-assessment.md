# Sicherheitsprüfung – 23.10.2026

## Auftrag und Regeln

Autorisierte technische Eigenprüfung des Seniorenlan-Prototyps, Ausgangsstand `f2b1a6b`.
Vorgehen an PTES/NIST SP 800-115 angelehnt: Umfang → Bedrohungsmodell → Erkennung → kontrollierte Reproduktion → Behebung/Nachtest → Bericht. Kein unabhängiger Pentest, kein Zertifikat und keine vollständige OSSTMM-Prüfung.

- Aktive Ziele ausschließlich kurzlebige Testprozesse/Container mit synthetischen Daten, Loopback und deaktivierten Discord-/DMX-Integrationen. Kein Scan der öffentlichen Domains, echten Konten, Ticketcodes oder Datenvolumes.
- Scanner erhalten nur einen Quellcodeexport bzw. ein Git-Bundle der committeten Historie oder ein exportiertes Image. Keine `.env`, Produktionsdaten, Hostnetz-/Docker-Socket-Freigaben.
- Laufzeitprüfungen im Container ohne Netzwerkzugang nach außen, maximal 2 CPUs/512 MiB für die App, bis 1,5 GiB für Scanner, begrenzte Testanzahl und Zeitlimits. Keine Persistenz, keine Ausbreitung, kein Passwort-Bruteforce.
- Scanergebnisse werden manuell bewertet. Rohberichte nicht ungeprüft veröffentlichen; insbesondere historische Secret-Funde könnten Geheimnisse enthalten (Redaktion einschalten).
- Änderungen/Deployments/Commits werden separat ausgewiesen. Keine Änderungen an Proxy, Firewall, Backupjobs oder laufenden Daten.

## Schutzgüter, Rollen und Vertrauensgrenzen

Schutzgüter: Käuferprofile, Discord-Zuordnungen, Sitzungstokens, Ticketcodes, Zahlung/Bestand, Sitzplätze und Turnierergebnisse. Rollen: anonym; Käufer/Teilnehmer; fremdes Konto ohne Ticket; zweiter Käufer; Admin. Grenzen: Browser → Proxy → HTTP/API → Sitzung/Rollenprüfung → Event-Kontext → Fachlogik → SQLite; separat Discord-OAuth/Bot und administrativ konfiguriertes OLA/DMX-Ziel.

Priorisierte Szenarien: fremde Bestellung/Sitzplätze lesen oder ändern (IDOR); fremde Ergebnisse melden; Rollen-/Sitzungswiderruf während Upload; doppelte Buchung/Check-in bei paralleler Änderung; CSRF/Proxy-Spoofing; bösartige JSON-/Cookie-/Pfadwerte; persistiertes HTML/CSV-Injection; Geheimnisse in Code/Historie und verwundbare Laufzeitkomponenten.

ATT&CK dient nur der Szenarienzuordnung: T1190 (öffentlich erreichbare Anwendung), T1078 (Missbrauch gültiger Konten), T1539 (Web-Sitzungscookies), T1565.001 (Manipulation gespeicherter Daten). Dies ist keine ATT&CK-Emulation und keine geprüfte Erkennungskette. Host-, Netzwerk-, physische und soziale OSSTMM-Bereiche sind ausgeschlossen.

## Verfahren und Nachweise

| Bereich | Durchführung und Grenze |
|---|---|
| PTES / NIST SP 800-115 | Umfang, Regeln, Bedrohungsmodell, kontrollierte Reproduktion, Nachtest und Bericht; keine vollständige oder unabhängige Standardprüfung |
| OSSTMM | Nur technische Anwendungsgrenzen berücksichtigt; keine vollständige operative Sicherheitsprüfung |
| ATT&CK | Obige Zuordnung der Missbrauchsszenarien; keine Angreiferemulation oder Detection-Validierung |
| SAST | Semgrep CE 1.182.0, öffentliche JS-/Generic-Regeln; Quellcodeprüfung und gezielte Nachtests. Regel-Commit `16b9e6d45f10649f6a531ec4838ed9924372c3bc` |
| Secret-Scanning | Gitleaks 8.30.1, Quellcodeexport und Git-Bundle mit 24 erreichbaren Commits; redigierte Ausgabe, keine Secret-Funde. Nicht: `.env`, Servergeheimnisse oder gelöschte/unerreichbare Git-Objekte |
| DAST | Authentifizierte HTTP-Rollen-/IDOR-/CSRF- und Nebenläufigkeitstests mit synthetischen Sitzungen; begrenzter zusätzlicher ZAP-API-Lauf separat dokumentiert |
| Fuzzing | 117 deterministische HTTP-Mutationen für Text/JSON/Cookies/Pfade plus zehn berechtigte Score-Typmutationen. Rate-Limits dürfen die Mutationen nicht verdecken. Kein Coverage-guided-/Langzeitfuzzing |
| IAST | **Nicht eingerichtet.** Keine bewährte Instrumentierung für diese native HTTP-/SQLite-Anwendung validiert; weder HTTP-Tests noch HTML-Builder-Tests sind IAST. Offen, nicht als erfolgreich bewertet |
| SCA / SBOM | Trivy 0.76.1, vollständiger Imagebericht und CycloneDX-SBOM (21 Komponenten), null bekannte Schwachstellen im erkannten Bestand; keine direkten npm-Abhängigkeiten. Keine Garantie für alle in Node eingebetteten Bibliotheken |

Scanner arbeiten lokal in Containern, Semgrep ohne Telemetrie und mit lokalem Regelklon, Gitleaks ohne Netzwerk. Kein Quellcodeupload zu Scanner-Clouds. Trivy darf für seinen Schwachstellenbestand auf das Internet zugreifen, nicht auf Produktionsdaten. Image-ID des geprüften Laufzeitimages: `sha256:95ab90729502729cfe8be4618fcf6338c31bc3a6be6b1a7ab35a26730e0f5923`. Das Image selbst wurde durch diese Prüfung nicht ersetzt; Korrekturen wurden im Test als schreibgeschützter Quellcode eingebunden.

## Bestätigte Befunde und Korrekturen

Schweregrade sind eine kontextbezogene manuelle Priorisierung, kein berechneter CVSS-Wert. „Behoben“ bedeutet zunächst **im getesteten Arbeitsstand**, nicht auf der laufenden Instanz.

| ID | Priorität | Reproduktion / Auswirkung | Korrektur / Nachtest |
|---|---|---|---|
| SA-01 | Mittel | Admin startet PUT `/api/settings`, lässt den Body offen, loggt sich aus und beendet den Upload: ursprünglicher Stand antwortet 200 und speichert trotz widerrufener Sitzung | `readBody()` prüft eine beim Uploadstart bestehende Adminberechtigung am Ende erneut; Nachtest 401, keine Mutation |
| SA-02 | Mittel | Admin startet Check-in mit offenem Body; zweite Anfrage storniert das Ticket; erster Upload setzt trotzdem `checkedInAt` | Zahlungsstatus nach Body erneut geprüft; Nachtest 400 und kein Check-in |
| SA-03 | Mittel | Während eines Uploads deaktivierte Sitzwahl bzw. Gastserver-Anmeldung oder erhöhtes Ticket-Mindestalter wurden nicht durchgängig berücksichtigt. Gastserver-Konfiguration wurde vor Upload als altes Objekt festgehalten | Aktuelle Sitzwahl/Gastserver-Konfiguration/Verkaufsvorgaben nach Upload lesen und prüfen. Drei getrennte Nachtests: jeweils 400, keine Reservierung, kein Server, keine Bestellung |
| SA-04 | Niedrig | Textwert `{"toString":null}` erzeugt an Profil/Holder-Pfaden 500; vergleichbare Zahlenkonvertierung beim berechtigten Ergebnisbericht ebenfalls 500. Keine RCE/SQL-Injection oder Prozessbeendigung beobachtet | Objekte in Textfeldern als 400 abweisen, Score-Konvertierung auf primitive Zahlen/Strings begrenzen; Passwortvergleich akzeptiert nur Strings. Mutationstests ohne 500/Stack-Ausgabe |
| SA-05 | Niedrig | GET `/%00` erreicht Dateisystemaufruf mit NUL-Byte und produziert 500 statt Clientfehler | NUL im dekodierten statischen Pfad als 400 abweisen; Pfadmutation besteht |

Kontrollierte Vorher-/Nachher-Probe mit **demselben** neuen HTTP-Testprogramm: Ausgangscode `f2b1a6b`: 2 bestanden, 7 fehlgeschlagen. Korrigierter Stand: 9/9 bestanden. Die sieben Fehlschläge sind nicht sieben unabhängige Schwachstellen (SA-03 enthält drei Fälle).

Gesamtsuite: **49/49 Tests bestanden**, lokal mit Node 24.22.1 und im isolierten Produktionsruntime-Image mit Node 22.23.4. Dies umfasst die vorhandenen Regressionen, neun neue HTTP-Tests und einen Frontend-Builder-Test.

Weitere positive Prüfungen: 32 Rollen-/Eigentums-/Event-/CSRF-Kontrollen; fremde Konten erhalten keine fremden Ticketcodes und dürfen keine fremden Holder/Sitze ändern. Zwei parallele Bestellungen für den letzten Kontingentplatz erzeugen nur eine Bestellung; zwei Reservierungen desselben Sitzes nur eine Belegung. Bestehende Ergebnisberechtigung für beteiligte Spieler/Teams und Admin bleibt erhalten. Bestehende Löschungs-, Proxy-, Migrations-, Crash- und Online-Backup-Regressionen bleiben Teil der Gesamtsuite.

## SAST-Triage – ausdrücklich kein Nullbefund

Der Erstlauf hat 49 Dateien mit 414 tatsächlich ausgeführten Regeln untersucht und **483 Hinweise** geliefert. Davon sind 286 HTML-Template-Hinweise und 102 überlappende DOM-Sink-Hinweise (`innerHTML`/Dokumentmethoden). Weitere Gruppen sind unter anderem `confirm`/`prompt`, vermutete fehlende Template-Strings und Audit-Regeln. Diese Zahlen sind Rohmeldungen, nicht bestätigte Sicherheitslücken.

Wiederholung nach den Anwendungskorrekturen (`reports-after/`): 54 Dateien, 484 Hinweise, davon unverändert 483 im Anwendungscode; eine Parserwarnung. Gitleaks liefert für Quellcode und Historie jeweils das gültige JSON-Ergebnis `[]`. Dieser Export entstand vor den letzten ZAP-Runner-/Hook- und Berichtsänderungen; er ist kein Scan-Nachweis für den gesamten abschließenden Arbeitsstand.

Abschließender separater Export (`final-source/`, `assessment-final-source.tar.gz`, Berichte `reports-final/`) umfasst auch die letzten ZAP-Werkzeuge: **56 Dateien, 484 Semgrep-Hinweise, davon 483 im Anwendungscode, eine Parserwarnung; Gitleaks Quelle/Historie jeweils `[]`; Produktionsruntime erneut 49/49 Tests bestanden.** Shell-Syntax beider neuer Runner geprüft, lokaler Nachtest ebenfalls 49/49 und `git diff --check` ohne Fehler. `reports-final/ARTIFACT-SHA256SUMS` bindet Export, JSON-Berichte, Runtimeprotokoll und finale ZAP-Coverage-/Ergebnisberichte. Nur diese abschließende Ergebnisergänzung im Bericht entstand danach; keine weitere Codeänderung.

- Geprüfte Beispiele: `richText`, Website-/Sponsor-Ausgabe und Sitzplan-Textfelder verwenden den zentralen HTML-Encoder; Tests führen die tatsächlichen Repository-Funktionen mit feindlichen Texten/Schemata aus. Das ist **kein vollständiger Browser-/DOM-XSS-Nachweis für alle 483 Stellen**. Nicht jede HTML-Meldung wurde abschließend einzeln triagiert; dieser Rest bleibt offen.
- `server.js` statischer Dateizugriff: normalisierter Pfad muss mit `PUBLIC_DIR + path.sep` beginnen; Traversal-Mutationen lesen weder Servercode noch `.env`. Der zusätzliche NUL-Fall SA-05 wurde behoben. Symlink-Angriffe durch bereits schreibberechtigte Hostnutzer sind nicht Bestandteil dieses HTTP-Tests.
- `Dmx[which]` in `lib/announcements.js`: interne Aufrufe mit `on`/`off`, nicht frei vom Client wählbarer Methodenname. OLA-Ziel bleibt administrativ konfigurierbarer Netzwerkzugriff; keine Egress-Allowlist und kein SSRF-Filter gegen einen bereits berechtigten/bösartigen Admin eingeführt.
- Domain-RegEx in `lib/servers.js`: Eingabe vor Prüfung auf 200 Zeichen begrenzt und nur administrativ änderbar. Kein erfolgreicher ReDoS nachgewiesen; keine Lastprüfung behauptet.
- Formatstring-Hinweise: festes Präfix vor variablen Fehlermeldungen; kein Codeausführungspfad. `JSON.stringify`-Hinweise beim Speichermodell ersetzen keine Prüfung der expliziten Spalten-/Datensatzpläne.
- Erstlauf: Dockerfile wegen gespeicherter CRLF-Zeilen teilweise nicht geparst (~99,8 % aller Zeilen geparst). Image wurde zusätzlich per Trivy geprüft; das ersetzt **keine** vollständige Dockerfile-SAST-Auswertung. Warnung bleibt sichtbar, nicht unterdrückt.

## Begrenzter aktiver ZAP-API-Test

ZAP 2.17.0, unveränderlicher Imagedigest im Runner. `zap-final/` enthält die abschließenden Berichte, Rollenprüfung, Zielprotokolle und `coverage.json`. Die sechs expliziten OpenAPI-Pfade sind ein Subset, kein vollständiges API-Inventar; kein Browser-/SPA-Crawl und kein Admin-ZAP-Lauf.

| Nachweis | Anonym | Käufer |
|---|---:|---:|
| Rolle durch ZAP verifiziert | ja | ja |
| Aktiver Scan | FINISHED, 100 % | FINISHED, 100 % |
| Aktive Scan-Anfragen (`reqCount`) | 250 | 256 |
| Gespeicherte Nachrichten, vollständig gezählt | 284 | 288 |
| HTTP 200 / 401 / 404 | 85 / 173 / 5 | 216 / 48 / 5 |
| Ohne verwertbaren HTTP-Status (`HTTP/1.0 0`) | 21 | 19 |
| HTTP 429 / 5xx in aufgezeichneten Statuszeilen | 0 / 0 | 0 / 0 |
| Exitcode | 2 (Warnung) | 2 (Warnung) |

Beide Läufe: keine konfigurierten FAIL-Befunde; eine niedrige Warnungsart `100001` („Unexpected Content-Type“), jeweils zwölf Instanzen. Die geprüften Instanzen betreffen HTML am SPA-Einstieg, `/api` ohne abschließenden Slash und unbekannte/Cloud-Metadaten-artige Probeziele, die auf den SPA-Fallback fallen; kein Nachweis, dass deklarierte gültige JSON-Endpunkte ihre API-Daten als HTML ausgeben. Informationsbefund `100000` protokolliert 401/404 bei unbekannten bzw. geschützten Probewegen. Keine `rate_limited`-Ereignisse in beiden Zielprotokollen.

**Grenzen:** Status `0` ist kein erfolgreicher HTTP-Response. Die Ursachen dieser 21/19 Nachrichten wurden nicht einzeln rekonstruiert; damit bleibt eine Transport-/Antwort-Abdeckungslücke. „FINISHED“ und „PASS: 113“ aus ZAP bedeuten weder vollständige Endpunktabdeckung noch 113 nachgewiesene Sicherheitsgarantien. Ein früher Käuferlauf wurde wegen fehlgeschlagener Rollenprüfung korrekt abgebrochen (Exit 3), nicht als erfolgreicher authentifizierter Scan gewertet. Erst der explizite URL-begrenzte Cookie-Replacer ermöglichte die verifizierten Käuferläufe. Nach Abschluss waren keine Assessment-Ziel-/Scannercontainer mehr aktiv.

## Reproduzierbarkeit und geschützte Artefakte

- `test/assessment.test.js`: neun isolierte HTTP-/Fuzz-/Nebenläufigkeitstests.
- `test/render-security.test.js`: reale ausgewählte Frontend-Encoder/HTML-Builder; kein vollständiger Browser.
- `test-support/isolated.cjs`: synthetische Rollen, zufällige temporäre Sitzungen, Environment-Allowlist, Loopback, Zeitlimits und Cleanup.
- `ops/assessment-source.sh`: Scanner mit unveränderlichen Imagedigests und geprüftem Regel-Commit; erwartet ausschließlich dedizierten Export/Bundle-Klon/Regelklon und ein neues Reportverzeichnis.
- `ops/assessment-zap.sh`, `ops/assessment-api.json`, `ops/assessment-target.cjs`, `ops/assessment-zap-hook.py`: begrenzter Runner, festes isoliertes API-Subset, synthetisches Ziel mit Ablaufzeit und Rollenprüfung durch ZAP. Ziel nur im Container `--network none`; Scanner teilt dessen Netzwerknamespace, ohne veröffentlichte Ports.
- `ops/scan-image.sh`: vorhandener Image-CVE-Gate; SBOM zusätzlich mit demselben exportierten Image und `--format cyclonedx` erzeugt.

Rohartefakte liegen zugriffsbeschränkt unter `/opt/backups/turniere/assessment-20261023/`: `reports/` für Ausgangsscans/SBOM und Vorher-/Nachher-Lauf, `reports-after/` für wiederholte Quellenprüfung/Gesamttests, separate ZAP-Berichte. `SHA256SUMS` und Scanner-Digests dokumentieren Eingaben/Berichte. Im ersten Gitleaks-Aufruf blieb die JSON-Datei bei null Funden leer; die Logs bestätigen null Funde. Wiederholung schreibt reguläre JSON-Reportdateien statt `/dev/stdout` und prüft sie erneut.

Lokaler Nachtest (Node ≥22.16, Testverzeichnis außerhalb synchronisierter Cloud-Daten):

```powershell
$env:OPENCODE_TEST_TMP='C:\Users\SebastianLübke\AppData\Local\Temp\opencode'
& 'C:\Program Files\nodejs\node.exe' --test
```

Container-Nachtest: frischen Quellcodeexport als `/app:ro` mounten, `--network none --cpus 2 --memory 512m --pids-limit 100 --read-only --tmpfs /tmp`, Einstiegspunkt `node`, Argument `--test`. Keine Produktionsvolumes/Umgebung übernehmen. Die App nutzt weiter genau einen SQLite-Schreiber; kein Multi-Instance-Umbau.

## Restumfang und Freigabegrenzen

Keine pauschale Sicherheitsfreigabe. Offen bleiben die vollständige HTML-SAST-Einzeltriage, echter Browser-/SPA-/DOM-XSS-Crawl, IAST, externe OAuth-/Discord-Rollenketten gegen den echten Anbieter, TLS-/NPM-/Host-/Netzwerkprüfung, Langzeit-/Last-/Slowloris-Tests und unabhängiger Pentest. Die überprüften synthetischen Sitzungen ersetzen keinen echten OAuth-Login-End-to-End-Test. Backupabdeckung des täglichen Dockge-Backups, Aufbewahrung und finale Rechtstexte/Domain bleiben ebenfalls ungeprüft bzw. organisatorisch zu entscheiden.

Die eigentliche Prüfung veränderte keine laufenden Daten, Proxy-/Firewallregeln oder Backupjobs. Korrekturen und Prüfartefakte waren bis zur anschließenden ausdrücklichen Deployment-/Commit-/Push-Freigabe ausschließlich im Arbeitsstand.

## Autorisiertes Deployment – 23.10.2026

Nach ausdrücklicher Freigabe wurden die vier geänderten Anwendungsdateien (`server.js`, `lib/seats.js`, `lib/servers.js`, `lib/tickets.js`) aus dem geprüften Export übernommen und das daraus neu gebaute Image gestartet. Keine Übernahme der Repository-Compose-Datei oder Produktionsumgebung in Scanner; bestehende `compose.yaml` und `.env` blieben per Hashvergleich unverändert.

- Deploymentbackup: `/opt/backups/turniere/security-deploy-20261023T105429Z`, mit geprüftem SQLite-Online-Backup, geschützter Sicherung der vorherigen Buildquellen/Konfiguration und Image-IDs. Ein erster Versuch scheiterte vor jeder Deploymentänderung an `docker cp` aus tmpfs; der erfolgreiche Versuch übertrug die fertige SQLite-Sicherung binär ohne TTY und prüfte Integrität/Schema separat.
- Vorgängerimage bleibt als `turnierbaum:before-assessment-20261023T105429Z` erhalten; neues Image `sha256:9d7c27c13daf80efb2a62fb5e27c2032ebf84b57661d7fbb73de4a067c5fada2`.
- Neues Image: 49/49 isolierte Tests bestanden; aktueller Trivy-Imagebericht ohne bekannte Schwachstellen im erkannten Bestand (`trivy.json` im Deploymentbackup). Keine pauschale CVE-frei-Garantie.
- Container `healthy`, SQLite-Integrität/Schema OK. SHA-256 des vollständig gelesenen logischen SQLite-Zustands vor/nach Deployment identisch: `319ef80797eeab090bed53e4603680ddafc9ca558446f668728a281f4bdac9ab`.
- Beide öffentlichen Domains: Startseite HTTP 200, `/api/health` mit `{"ok":true}`. Nur lesende Smoke-Checks, keine aktiven Scans gegen Produktion.
- Direkter Backendzugriff weiterhin HTTP 403; `TRUST_PROXY=1`, `TRUSTED_PROXIES=10.12.254.12`, `PROXY_ONLY=1`, Portbindung unverändert `10.99.254.6:3000`. Keine Firewall-, Proxy- oder Backupjobänderungen.

Rollback bei Bedarf mit dem behaltenen Vorgängerimage und den vier gesicherten Quelldateien; keine Rückmigration und kein Überschreiben inzwischen eingegangener Daten. Die verbleibenden Prüfgrenzen gelten auch nach diesem Deployment.
