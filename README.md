# 🎮 LAN-System

Selbstgehostetes System für LAN-Partys mit Turnieren, Durchsagen, Programm, Infos, Teilnehmerliste und Sitzplan, dazu ein Beamer-Infoscreen und ein Discord-Bot.
Es braucht keine externen Abhängigkeiten, nur Node.js (ab Version 22.16). Die Daten liegen in SQLite; bestehende JSON-Daten werden beim ersten Start automatisch übernommen.

**Catering:** Essensangebote pro Event, Gäste-Selbstanmeldung, Admin-Zuweisung und manuelle Bezahlmarkierung unter **Admin → Catering**. Zuerst unter **Einstellungen → Module** einschalten. Anleitung: [docs/catering.md](docs/catering.md).

**Sicherheitsbetrieb:** Proxy-Zulisten, Firewall, Löschverhalten, Aufbewahrungsgrenzen und Image-Scans sind in [docs/security-operations.md](docs/security-operations.md) beschrieben. Neue Compose-Installationen sind standardmäßig nur über Host-Loopback erreichbar. Bei externem Proxy `BIND_ADDRESS`, `TRUSTED_PROXIES` und `PROXY_ONLY` ausdrücklich konfigurieren.

**Website-Module:** Cookie-Hinweis, Impressum, Datenschutzerklärung, AGB, Verhaltenskodex und Sponsoren unter **Admin → Website & Rechtliches** websiteweit vorbereiten und einzeln veröffentlichen. Details und Grenzen: [docs/website-modules.md](docs/website-modules.md).

## Events

Das System verwaltet mehrere LAN-Events (z. B. „Seniorenlan #12“, „#13“) im Admin-Reiter **Events**.

- **Pro Event** gibt es eigene Turniere, ein eigenes Programm, eigene Infos, Ticketarten, Bestellungen, Catering-Angebote/-Anmeldungen, eine eigene Teilnehmerliste mit Sitzplätzen und eine eigene Auswahl der Module.
- **Für alle Events** gelten Personen, Ticket-Konten mit Anschrift, das Sitzplan-Layout mit Kategorien, Bankverbindung, Datenschutzhinweis und die übrigen Einstellungen.
- **Welches Event Besucher sehen:** das laufende, sonst das nächste geplante, sonst das zuletzt beendete. Webseite, Beamer und Discord-Befehle beziehen sich darauf.
- **Bearbeiten:** Oben im Admin-Bereich wählst du, welches Event du bearbeitest. So bereitest du Turniere, Programm und Tickets fürs nächste Event vor, während das aktuelle läuft. Eine farbige Leiste zeigt an, wenn das nicht das Event ist, das Besucher sehen.
- **Neues Event:** Name und Zeitraum eintragen. Optional übernimmt es Infos, Ticketarten, Verkaufseinstellungen und Module von einem früheren Event.
- **Start und Ende** geschehen automatisch zum eingetragenen Zeitraum oder per Knopf. Es läuft immer nur ein Event; startest du ein anderes, wird das laufende beendet.
- **Vorverkauf:** Hat ein kommendes Event Ticketarten, wählen Käufer auf der Ticketseite das Event aus. Das geht auch, während ein anderes läuft.
- **Archiv:** Vergangene Events bleiben mit allem erhalten. Löschen lässt sich nur ein Event ohne Bestellungen und Catering-Anmeldungen.

**Personen und Statistik:** Personen bleiben über alle Events erhalten. Im Reiter **Teilnehmer** übernimmt die Orga bekannte Personen ins Event. Ticketnamen sind keine Identitätsnachweise: Neue Tickets erhalten eigene Personen, Namensgleichheit führt nicht automatisch zur Zusammenführung. Der Reiter **Personen** zeigt Events und Check-ins. Zusammenführen ist nur bei kompatiblen Ticket-Eigentümern und Discord-Verknüpfungen möglich.

## Module

Jedes Modul lässt sich im Admin-Bereich unter **Einstellungen → Module** pro Event an- und ausschalten (oben das Event wählen). Besucher, Beamer und Discord-Befehle richten sich nach dem aktuellen Event. Eine Ausnahme sind die Tickets: Hat ein kommendes Event den Ticketverkauf an, erscheint „Tickets“ auch dann, wenn das laufende Event ihn aus hat. Ist ein Modul aus, verschwindet es für Besucher aus Webseite, Beamer und Discord. Der Admin kann es trotzdem schon vorbereiten.

| Modul | Was es kann |
|---|---|
| 📋 **Event** | Allgemeine Eventdetails für Interessierte und Käufer, auch für kommende Events. Beginn, Ende, Mindestalter sowie Ticketarten mit Preisen und Beschreibung kommen automatisch aus dem Event. Dazu Location mit Adresse und Kartenlink, Teilnehmerzahl, Zuschauereintritt und ein freier Text (Admin → Eventdetails). |
| 🏆 **Turniere** | Single und Double Elimination sowie „Jeder gegen jeden“. Freilose werden automatisch vergeben. Ergebnisse tragen die Spieler selbst ein, Korrekturen nur der Admin. „Jetzt dran“ zeigt die offenen Spiele. Teamturniere mit Teamgröße. |
| 📢 **Durchsagen** | Banner auf allen Seiten, große Einblendung mit Gong auf dem Beamer, Post in Discord und eine DMX-Lampe, die rot wird. Auslöser sind die Webseite, `/announce` in Discord oder ein Programmpunkt. |
| 🗓️ **Programm** | Zeitplan mit Live-Countdown. Erinnerung in Discord vor jedem Punkt, auf Wunsch eine Durchsage zum Beginn. |
| 🍽️ **Catering** | Essensangebote mit Preis, Ausgabezeit, Anmeldeschluss und optionaler Höchstzahl. Gäste melden sich und eigene Ticketinhaber an; Admins weisen Gäste zu und markieren Zahlungen. Eigene Anmeldungen bleiben privat, Preise bestehender Anmeldungen unverändert. Standardmäßig ausgeschaltet. |
| ℹ️ **Infos** | Infos vor Ort: WLAN, Gameserver (IP und Passwort zum Kopieren), Spieleliste und Hausregeln. |
| 👥 **Teilnehmer** | Teilnehmerliste pro Event mit Clan, Discord-Verknüpfung (`/ich`) und Steam-Profil. Personen bleiben über alle Events erhalten, mit Statistik, wer wie oft dabei war. |
| 💺 **Sitzplan** | Raumplan mit beschrifteten Flächen (Bereiche wie Sleeping oder Bar, Wände, Eingänge, Notausgänge) und kompakten Plätzen: Die Farbe zeigt frei, besetzt oder gesperrt, ein Kürzel die Kategorie (z. B. „L“ für Loge). Name und Clan erscheinen beim Überfahren oder Antippen. Suche „Wer sitzt wo?“ nach Name oder Clan. Ein Layout für alle Events, die Belegung pro Event. |
| 🎟️ **Tickets** | Anmeldung mit Discord, eigene Daten (Name, Anschrift, E-Mail, Geburtsdatum) mit Einwilligung, Bestellung mehrerer Tickets mit einem Namen pro Ticket, Bezahlung per Überweisung mit eindeutigem Verwendungszweck. Der Admin bestätigt Zahlungen, checkt ein und exportiert als CSV. Bezahlte Tickets landen in der Teilnehmerliste. Ticketverkauf pro Event, auch als Vorverkauf fürs nächste. Standardmäßig ausgeschaltet. |
| 🖥️ **Gastserver** | Teilnehmer mit Ticket melden eigene Server an: Servername, Beschreibung und auf Wunsch ein Reverse-DNS-Eintrag. Sie bekommen sofort die nächste freie IP aus dem Bereich des Events und den FQDN `<name>.<domain>`, auch per Discord-Nachricht. Die Orga stellt unter Admin → Gastserver Domain, IP-Bereich und Höchstzahl pro Person ein, sperrt oder löscht Server und trägt die DNS-Einträge selbst ein: Dafür gibt es einen Export als Zonendatei-Zeilen (A-Records und gewünschte PTR) und als CSV. Standardmäßig ausgeschaltet. |
| 📺 **Beamer** | Vollbild-Infoscreen (`/#/beamer`). Er wechselt zwischen Turnieren, Programm, Infos und Sitzplan, daneben stehen „Als Nächstes“ und „Jetzt dran“. |

**Nur für bestätigte Teilnehmer:** Die Module lassen sich pro Event auf „🔒 nur Teilnehmer mit Ticket“ stellen. Berechtigt sind angemeldete Käufer bezahlter Tickets, verknüpfte Inhaber bezahlter Tickets oder verknüpfte Personen mit ausdrücklicher **Orga-Freigabe** für dieses Event. Eine Selbstanmeldung mit `/ich` genügt nicht. Stornierung oder Zahlungsrücknahme entzieht ticketabhängige Rechte; eine unabhängige Orga-Freigabe bleibt erhalten. Der Admin sieht alles. Sitzplandaten und interne Notizen werden auch auf alternativen API-Pfaden entsprechend geschützt.

**Ergebnisse:** Nur angemeldete, mit einer beteiligten Person verknüpfte Spieler bzw. Mitglieder der beteiligten Teams und Admins dürfen Ergebnisse eintragen. Einzelspieler werden über feste Personen-IDs zugeordnet, nicht dynamisch über Anzeigenamen. Gibt es für einen manuell eingetragenen Turniernamen noch keine Person, trägt zunächst nur die Orga Ergebnisse ein; nach geprüfter Personenanlage die Teilnehmerliste im Turnier erneut speichern. Korrekturen bleiben Admins vorbehalten. Parallele Meldungen werden gegen den aktuellen Spielzustand geprüft.

## Discord-Bot

Der Bot legt pro Turnier eine Kategorie mit einem Voice-Kanal je Spieler bzw. Team an und entfernt sie wieder, sobald das Turnier beendet ist. Diese Voice-Kanäle gibt es nur während des Events (siehe unten): Zum Beginn legt der Bot sie für alle noch nicht beendeten Turniere an, zum Ende entfernt er sie.

**Discord-Kanäle nur während des Events:** Unter **Events** trägst du Beginn und Ende jedes Events ein. Alternativ gibt es die Knöpfe „Starten“ und „Beenden“.

- **Zum Beginn** legt der Bot eine Kategorie „🎮 &lt;Eventname&gt;“ mit zwei Textkanälen an und begrüßt alle:
  - `#lan-ansagen`: Durchsagen sowie Programm-Erinnerungen und -starts
  - `#turnier-ansagen`: Turnierstarts, Ergebnisse, nächste Paarungen mit Erwähnung der Spieler und Sieger
- **Außerdem** legt er zum Beginn die Voice-Kanäle aller Turniere dieses Events an, die noch nicht beendet sind (auch vorher angelegte Entwürfe).
- **Zum Ende** löscht er Kategorie und Kanäle, auch die Voice-Kanäle der Turniere.
- **Außerhalb des Events** gehen keine Ansagen nach Discord. Webseite, Beamer, Lampe und Slash-Befehle funktionieren trotzdem.
- **Fest per ID vorgegebene Kanäle** werden nie angelegt oder gelöscht.

Er kennt diese Slash-Befehle:

| Befehl | Wofür |
|---|---|
| `/announce <nachricht>` | Durchsage (Lampe, Beamer, Webseite, Discord). Optional nur für eine Rolle freigegeben. |
| `/announce_ende` | Durchsage vorzeitig beenden, die Lampe geht aus. |
| `/ich <name> [ticketcode]` | Neue unbestätigte Person anlegen oder bestehende Person mit eigenem bezahltem Ticket bzw. gültigem Ticketcode verknüpfen. Alternativ verknüpft die Orga die geprüfte Discord-Benutzer-ID. Ticketcodes vertraulich behandeln. |
| `/clan [name]` | Eigenen Clan bzw. eigenes Team setzen, leer lassen zum Entfernen. Erscheint im Sitzplan. |
| `/anmelden`, `/abmelden` | Selbst für ein Einzelturnier an- oder abmelden, solange die Anmeldung offen ist. |
| `/team gruenden`, `/team beitreten`, `/team verlassen` | Teams für Teamturniere bilden. |
| `/programm` | Die nächsten Programmpunkte. |
| `/jetzt` | Turnierspiele, die gerade dran sind. |
| `/platz [name]` | Wo sitzt jemand? |
| `/ticket` | Eigene Tickets und Zahlungsstatus für laufende und kommende Events |

Verknüpfte Spieler werden in Discord erwähnt, wenn ihr Spiel dran ist.

## Starten

```bash
cp .env.example .env      # Discord (Bot, Client Secret, Admin-Rolle) eintragen, optional DMX
docker compose up -d --build
```

Danach auf dem Docker-Host `http://127.0.0.1:3000` öffnen oder die konfigurierte HTTPS-Adresse des Reverse Proxys verwenden. Für externen Zugriff zuerst Bind-Adresse, Proxy-Zuliste und Firewall wie oben beschrieben einrichten. Den Admin-Bereich erreichst du unter „Admin“ mit „Mit Discord anmelden“.

**Admin-Zugang:** Admin ist, wer auf dem Discord-Server die Admin-Rolle hat (`ADMIN_DISCORD_ROLE`, später unter Einstellungen → Admin-Zugang änderbar). Server-Inhaber und Rollen mit Administrator-Recht kommen immer hinein. Der Server prüft die Rolle alle 10 Minuten nach. Abgelaufene Rollenbestätigungen berechtigen bei Discord-Störungen nicht weiter. Dafür braucht es Bot und OAuth-Konfiguration. `ADMIN_PASSWORD` ist ein optionaler Notzugang. Ohne eingerichteten Zugang wird ein Passwort in `/data/admin-password` (bzw. `DATA_DIR/admin-password`) abgelegt, nicht im Log.

## Sicherheitsupdate: bestehende Installationen

Vor dem ersten Start Code, Konfiguration und Datenbank konsistent sichern. Die einmalige Migration (`meta.securityVersion=1`) ersetzt alle bisherigen Ticketcodes, entfernt diese aus Personen-Notizen und setzt alte Discord-Verknüpfungen sowie nicht nachweisbare Teilnehmerfreigaben zurück. **Alte gedruckte Tickets und QR-Codes sind danach ungültig; neue Tickets erneut abrufen und ausdrucken.** Bezahlte Bestellungen bleiben erhalten. Bestehende Personen müssen erneut über Ticketnachweis oder die Orga verknüpft werden; manuelle Teilnehmer benötigen eine Orga-Freigabe. Mehrdeutige Ticket-Personenbezüge verschiedener Käufer werden getrennt. Beim erneuten Start werden Codes nicht nochmals rotiert.

Offene Bestellungen reservieren ihr Kontingent nur bis `dueAt`; je Konto und Event sind höchstens drei aktive offene Bestellungen möglich. Nach Fristende prüft die Zahlungsbestätigung das verfügbare Kontingent erneut.

Regressionstests: `npm test` (Node.js ab 22, keine Discord-/DMX-Aktionen, isolierte Testdaten). Für den Betrieb feste `PUBLIC_URL` und HTTPS verwenden. Forwarded-Header werden nur bei ausdrücklich aktiviertem `TRUST_PROXY` berücksichtigt; der Proxy muss diese überschreiben und direkter Backendzugriff muss eingeschränkt werden. Das Update ersetzt keine vollständige OWASP-/ASVS-Prüfung, TLS-/Containerprüfung oder ein Datenschutz- und Löschkonzept.

Ohne Docker:

```bash
ADMIN_PASSWORD=geheim node server.js   # ohne Discord: Anmeldung mit Passwort
```

## Discord einrichten

1. Im [Discord Developer Portal](https://discord.com/developers/applications) eine Anwendung anlegen und unter **Bot** das Token erzeugen. Es kommt als `DISCORD_BOT_TOKEN` in die `.env`.
2. Unter **OAuth2 → URL Generator** die Scopes `bot` und `applications.commands` wählen, dazu die Berechtigungen **Manage Channels**, **View Channels** und **Send Messages**. Mit der erzeugten URL den Bot einladen.
3. Die Server-ID (Rechtsklick auf den Server, Entwicklermodus muss an sein) als `DISCORD_GUILD_ID` eintragen.
4. Den Container neu starten. Im Log steht danach „Discord-Gateway verbunden“.

Privilegierte Intents sind nicht nötig.

## Ticketverkauf einrichten

1. Unter Einstellungen → Module **Tickets** einschalten.
2. Im Discord Developer Portal bei deiner Anwendung unter **OAuth2** das **Client Secret** kopieren und als `DISCORD_CLIENT_SECRET` in die `.env` eintragen. Danach den Container neu starten.
3. Unter **OAuth2 → Redirects** die Adresse eintragen, die der Admin-Reiter „Tickets“ unter „Discord-Login“ anzeigt, z. B. `http://10.99.254.6:3000/api/auth/callback`. Sie muss exakt stimmen.
4. Oben das Event wählen, für das verkauft wird, dann im Admin-Reiter **Tickets**:
   - Bankverbindung und Datenschutzhinweis eintragen (gelten für alle Events).
   - Zahlungsfrist, Mindestalter, „Verkauf geöffnet“ und „Platzwahl offen“ einstellen (gelten nur für dieses Event).
   - Ticketarten anlegen (Preis, Kontingent, optional Verkaufszeitraum).

Ablauf für Besucher:
1. Unter „Tickets“ mit Discord anmelden. Optional dürfen das nur Mitglieder des Discord-Servers, das prüft der Bot.
2. Daten hinterlegen. Sie bleiben für spätere Events gespeichert.
3. Gibt es Tickets für mehrere Events, oben das Event wählen.
4. Tickets bestellen und die angezeigten Bankdaten mit dem Verwendungszweck (z. B. `LAN-K7Q2XM`) nutzen.
5. Der Bot schickt eine Bestätigung per Direktnachricht, sofern der Nutzer sie zulässt.

Ablauf für den Admin:
1. Sobald das Geld da ist, die Bestellung auf „Bezahlt“ setzen.
2. Beim Einlass den QR-Code scannen (siehe unten).

**Sitzplätze:**
- **Plan zeichnen** (Admin → Sitzplan, Raster bis 80 × 60):
  - „▦ Platz-Block“ füllt mit zwei Klicks (zwei Ecken) ein ganzes Rechteck mit fortlaufend nummerierten Plätzen, z. B. eine Tischreihe.
  - „✕ Plätze entfernen“ löscht so ein Rechteck wieder.
  - „▭ Fläche zeichnen“ legt Bereiche (z. B. Sleeping, Bühne, WC, Bar), Wände, Eingänge und Notausgänge an. Beschriftung, Farbe und Größe änderst du danach.
- **Kategorien:** Du legst Kategorien mit Farbe und Kürzel an (z. B. „Loge“ mit „L“, „Parkett“, „Orga“). Über den Klick-Modus weist du sie den Plätzen zu. Das Kürzel steht im Plan auf dem Platz.
- **Gesperrte Plätze** (🔒, gelb) sind nicht selbst buchbar, z. B. für Orga oder Technik.
- **Clan:** gehört zur Person und gilt für alle Events. Setzen kann ihn der Admin, jeder selbst mit `/clan` oder der Käufer auf der Ticketseite für seine bezahlten Tickets.
- **Pro Ticketart** legst du fest, in welchen Kategorien sie sitzen darf. Ist nichts angehakt, darf sie überall sitzen.
- **Selbst reservieren:** Nach der Zahlung reserviert der Käufer auf der Ticketseite für alle Tickets seiner Bestellung selbst Plätze im gewählten Event. Er wählt ein Ticket und tippt auf einen freien Platz. Ein erneuter Tipp auf den Platz des gewählten Tickets gibt ihn wieder frei. Das lässt sich in den Ticket-Einstellungen mit „Platzwahl offen“ an- und abschalten.
- **Defragmentieren** (Admin → Sitzplan): Füllt pro Kategorie die Plätze lückenlos in der Reihenfolge der Platznummern auf, Tickets einer Bestellung sitzen danach nebeneinander. Gesperrte Plätze bleiben stehen. Erst siehst du eine Vorschau, dann übernimmst du sie, und die Käufer bekommen ihre neuen Plätze per Discord.

**Einlass mit QR-Codes:**
- Für jedes bezahlte Ticket gibt es einen QR-Code. Besucher öffnen ihn auf der Ticketseite unter „▦ QR“ oder drucken mit „🖨 Tickets drucken“ ein Blatt pro Ticket.
- Der QR-Code enthält den Link `<PUBLIC_URL>/#/checkin/<Code>`. Die Orga scannt ihn mit der normalen Handy-Kamera, eine Scanner-App braucht es nicht.
- Auf der Check-in-Seite stehen Name, Ticketart und Status, ein Tipp auf „Einchecken“ genügt. Wurde ein Ticket schon gescannt, erscheint eine Warnung.
- Die Check-in-Seite ist nur mit Admin-Login nutzbar.
- Ohne Kamera lässt sich der Code im Admin-Reiter „Tickets“ unter „Check-in“ auch eintippen.
- Die QR-Codes erzeugt die Seite selbst, ohne externe Dienste. Auf der LAN braucht es dafür kein Internet.

> Persönliche Daten sieht nur der Admin. Nutzer können ihr Konto selbst löschen, dabei werden offene Bestellungen storniert.
> Solange die Seite ohne HTTPS läuft, gehen die Daten unverschlüsselt durchs Netz. Für den echten Verkauf sollte HTTPS kommen.

## DMX-Lampe (Raspberry Pi mit OLA)

Die Lampe hängt per USB-DMX-Interface an einem Raspberry Pi, auf dem [OLA](https://www.openlighting.org/ola/) läuft. Das LAN-System schaltet sie über OLAs Weboberfläche. Auf dem Pi läuft deshalb nur `olad`, kein eigener Bot.

1. Auf dem Pi OLA installieren (`sudo apt install ola`), das Interface im OLA-Webinterface (`http://<pi-ip>:9090`) mit Universe 1 verbinden und `sudo systemctl enable --now olad` ausführen.
2. Im Admin-Bereich unter **Einstellungen → DMX-Lampe** die OLA-Adresse (`http://<pi-ip>:9090`), das Universe und die Kanäle eintragen. Mit „Testen“ prüfen.
   - Kanäle im Format `Kanal=Wert`, z. B. `1=255` für Rot oder `1=255, 4=255` für Rot plus Dimmer.

Wer bisher den Python-Bot `dmx-announce-bot` genutzt hat, stoppt ihn auf dem Pi, sonst gibt es `/announce` doppelt:

```bash
sudo systemctl disable --now dmx-announce-bot
```

## Konfiguration (Umgebungsvariablen)

| Variable | Bedeutung |
|---|---|
| `ADMIN_DISCORD_ROLE` | Discord-Rolle (Name oder ID) für den Admin-Bereich, Startwert, danach in den Einstellungen änderbar |
| `ADMIN_PASSWORD` | Optionaler Notzugang mit Passwort, alternativ `ADMIN_PASSWORD_FILE`. Leer = nur Discord |
| `DISCORD_BOT_TOKEN`, `DISCORD_GUILD_ID` | Discord-Bot (optional), alternativ `DISCORD_BOT_TOKEN_FILE` |
| `DISCORD_CLIENT_SECRET` | Für „Mit Discord anmelden“ (Ticketverkauf), alternativ `DISCORD_CLIENT_SECRET_FILE` |
| `DISCORD_ANNOUNCE_CHANNEL_ID` | Fester Kanal für allgemeine Ansagen (sonst wird `#lan-ansagen` angelegt), `ANNOUNCE_CHANNEL_ID` geht auch |
| `DISCORD_TOURNAMENT_CHANNEL_ID` | Fester Kanal für Turnier-Ansagen (sonst wird `#turnier-ansagen` angelegt) |
| `PUBLIC_URL` | Adresse der Seite für Links in Discord, z. B. `http://192.168.1.10:3000` |
| `TRUST_PROXY` | Hinter einem Reverse Proxy auf `1` setzen, damit X-Forwarded-For/-Proto gelten (echte Client-IP, Secure-Cookies, HSTS) |
| `EVENT_NAME`, `OLA_URL`, `DMX_UNIVERSE`, `DMX_RED_CHANNEL`, `DMX_RESET_SECONDS`, `ANNOUNCE_ROLE_NAME` | Startwerte, danach im Admin-Bereich änderbar |
| `PORT`, `HOST`, `DATA_DIR` | Server-Port (3000), Adresse (0.0.0.0), Datenverzeichnis |

## Sicherheit (OWASP)

Das System ist entlang der OWASP Top 10 gehärtet:

| Bereich | Umsetzung |
|---|---|
| Zugriffskontrolle (A01) | Admin-Funktionen nur mit Admin-Sitzung. Admin-Zugang über die Discord-Rolle, die alle 10 Minuten nachgeprüft wird. Bestellungen, Tickets und Plätze nur für den eigenen Discord-Account. Öffentliche Antworten ohne Anschriften, Discord-IDs oder Discord-Interna. |
| Kryptografie (A02) | Zufällige 256-Bit-Sitzungstoken. Besucher-Sitzungen werden nur als SHA-256-Hash gespeichert. Hinter HTTPS: `Secure`-Cookies und HSTS. |
| Injection / XSS (A03) | Alle Ausgaben werden HTML-maskiert, Links nur `http(s)`. CSV-Export mit Schutz gegen Formel-Injection. Discord-Erwähnungen nur gezielt freigegeben, nie `@everyone`. |
| Unsicheres Design (A04) | Rate-Limits für den Passwort-Notzugang (10 Versuche je 15 Min.), Discord-Login, Bestellungen, Ergebnisse und Platzwahl. Kontingente werden serverseitig geprüft. |
| Fehlkonfiguration (A05) | Content-Security-Policy ohne Inline-Skripte, Clickjacking-Schutz, `nosniff`, Referrer- und Permissions-Policy. Fehlerdetails nur im Log. Timeouts gegen langsame Angriffe, Limits für Anfragegröße und Live-Verbindungen. |
| Komponenten (A06) | Keine npm-Abhängigkeiten. Container mit schreibgeschütztem Dateisystem, ohne Linux-Capabilities, mit `no-new-privileges`, als Benutzer `node`. |
| Authentifizierung (A07) | Zeitkonstanter Passwortvergleich mit Verzögerung bei Fehlversuchen. Warnung bei Admin-Passwörtern unter 12 Zeichen. OAuth-`state` gegen untergeschobene Logins. CSRF-Schutz über SameSite-Cookies und Origin-Prüfung. |
| Integrität (A08) | Eingaben werden serverseitig geprüft und in der Länge begrenzt, nur bekannte Felder werden übernommen. |
| Logging (A09) | Sicherheitsereignisse als JSON-Zeilen im Container-Log (`"sec": …`), ohne Namen oder Anschriften. Protokolliert werden Logins, Fehlversuche, abgewehrte Anfragen, Zahlungen, Check-ins und Datenexporte. |
| SSRF (A10) | Ausgehende Verbindungen nur zu Discord und zur vom Admin eingetragenen OLA-Adresse (`http(s)`). |

**Empfehlungen für den Betrieb:**
- Ein langes Admin-Passwort verwenden (mindestens 12 Zeichen). Es schützt den ganzen Admin-Bereich.
- Aus dem Internet nur über HTTPS (Reverse Proxy) erreichbar machen und dann `TRUST_PROXY=1` setzen. Nur damit sehen Rate-Limits die echte Client-IP, und Cookies werden `Secure`.
- Die Sicherheitsereignisse im Blick behalten: `docker logs turnierbaum | grep '"sec"'`.
- Nach der LAN persönliche Daten gemäß Aufbewahrungszweck prüfen (Konten, CSV-Exporte) und alte JSON-/SQLite-Sicherungen nicht unnötig aufbewahren.

## Daten und Sicherung

Die aktuelle Datenbank liegt in `db.sqlite` im Datenverzeichnis, bei Docker im Volume `turnierbaum-data`. Eine vorhandene `db.json` wird einmalig verlustfrei importiert und bleibt danach als alter Migrationsstand unverändert liegen. Alte Daten mit nur einem Event werden weiterhin automatisch auf Eventverwaltung umgestellt.

Konsistente Sicherung bei laufender Anwendung (Zielnamen je Sicherung ändern):

```bash
docker compose exec -T turnierbaum node lib/database-cli.js backup /data/backups/lan-backup.sqlite
docker compose cp turnierbaum:/data/backups/lan-backup.sqlite ./lan-backup.sqlite
```

Nicht die laufende SQLite-Hauptdatei allein kopieren: Änderungen können im WAL liegen. Bestehende Dockge-/Host-Backups müssen das tatsächliche Datenvolume konsistent sichern. Migration, Tabellen, Single-Writer-Grenze, Wiederherstellung und JSON-Rollback: [docs/sqlite.md](docs/sqlite.md).

## Hinweise

- Admin-Sitzungen liegen nur im Arbeitsspeicher. Nach einem Neustart muss man sich neu anmelden.
- Für den Gong muss am Beamer einmal auf 🔔 (oder Vollbild) geklickt werden, weil Browser Ton erst nach einer Interaktion erlauben.
- Für den Betrieb im Internet sollte ein Reverse-Proxy mit HTTPS davor. Im LAN ist das nicht nötig.
