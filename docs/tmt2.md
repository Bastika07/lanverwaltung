# CS2-Matches mit TMT2

Das Modul **🔫 CS2-Matches** verbindet die LAN-Verwaltung mit **TMT2 – Tournament Match Tracker 2**. TMT2 betreut Counter-Strike-2-Matches auf euren Gameservern: Mapwahl per Ingame-Chat (`.ban`, `.pick`, `.ct`/`.t`), Messerrunde, Mapwechsel, Seitenwechsel und Round-Backups. Ein Plugin auf dem CS2-Server ist nicht nötig.

## Herkunft und Lizenz

- Original: [JensForstmann/tmt2](https://github.com/JensForstmann/tmt2) von **Jens Forstmann**
- Fork: [Bastika07/tmt2](https://github.com/Bastika07/tmt2), unverändert auf dem Stand `d699867` (TMT2 3.0.0)
- Lizenz: **MIT**, Copyright (c) 2020 Jens Forstmann. Der Lizenztext liegt im Fork (`LICENSE`); der Hinweis steht zusätzlich in [NOTICE](../NOTICE).

TMT2 ist in TypeScript geschrieben und braucht npm-Pakete und einen Build. Deshalb läuft es als **eigener Container**. Dieses Repository bleibt ohne npm-Abhängigkeiten. Hier liegen nur die Brücke ([lib/tmt.js](../lib/tmt.js), [public/cs2.js](../public/cs2.js)) und der LAN-Client ([agent/tmt2-agent.js](../agent/tmt2-agent.js)).

## Aufbau

Die LAN-Verwaltung läuft woanders als die CS2-Server, zum Beispiel bei einem Hoster. Die CS2-Server sind aus dem Internet nicht erreichbar. Deshalb läuft am **LAN-Standort** neben den CS2-Servern ein kleiner Docker-Stack ([docker-compose.lan.yml](../docker-compose.lan.yml)):

- **tmt2**: TMT2, gebaut aus dem Fork. Spricht per RCON mit den CS2-Servern und empfängt deren Logs.
- **tmt2-agent**: der LAN-Client, nur mit Node-Bordmitteln. Er fragt die LAN-Verwaltung alle paar Sekunden per HTTPS nach Aufträgen (Match anlegen, Match beenden). Er führt sie an TMT2 aus und meldet den Stand der offenen Matches zurück.

Alle Verbindungen gehen **vom LAN nach außen**. Im LAN wird kein Port für das Internet geöffnet, und die LAN-Verwaltung braucht keinen Weg ins LAN.

```
CS2-Server ⇄ tmt2 ⇄ tmt2-agent ──HTTPS (nur ausgehend)──▶ LAN-Verwaltung
                (LAN)                                       (Internet)
```

## Abgrenzung zum eigenen Turniermodul

Turnierbaum, Paarungen und Platzierungen bleiben im Modul **Turniere**. TMT2 spielt nur das einzelne Match auf dem Server. Die Brücke lässt für eine spielbereite Paarung ein Match in TMT2 anlegen und trägt das Endergebnis in den Turnierbaum ein: bei BO1 den Rundenstand (z. B. 13:9), bei BO3/BO5 die gewonnenen Maps (z. B. 2:1). Die Rundenstände je Map stehen unter dem Spiel im Turnierbaum („dust2 13:9“). Eine Summe der Runden wäre bei mehreren Maps kein fairer Sieger, deshalb zählen dort die Maps. Freie Matches ohne Turnier gehen auch, zum Beispiel für Showmatches.

## Einrichten

**LAN-Verwaltung** (Server im Internet):

1. Ein zufälliges Token erzeugen (`openssl rand -hex 32`), als `TMT2_AGENT_TOKEN` in `.env` eintragen und neu starten.
2. Im Admin-Bereich unter **Einstellungen → Module** für das Event **CS2-Matches** einschalten.

**LAN-Standort** (Rechner mit Docker im selben Netz wie die CS2-Server):

1. Dieses Repository klonen und `.env.lan.example` nach `.env.lan` kopieren. `LAN_URL` (HTTPS-Adresse der LAN-Verwaltung) und dasselbe `TMT2_AGENT_TOKEN` eintragen. Dazu `TMT2_BIND_ADDRESS`/`TMT2_LOG_ADDRESS` setzen, damit die CS2-Server TMT2 erreichen.
2. Starten:

   ```bash
   docker compose -f docker-compose.lan.yml --env-file .env.lan up -d --build
   ```

3. Das globale TMT2-Token aus `docker logs tmt2` holen (Zeile „First auto generated access token“). Als `TMT2_TOKEN` in `.env.lan` eintragen und den Stack noch einmal mit demselben Befehl starten. Bis dahin beendet sich der Client mit „TMT2_TOKEN fehlt“ und startet neu.
4. Gameserver in der TMT2-Oberfläche unter **Game Servers** anlegen (IP, Port, RCON-Passwort). TMT2 nimmt für jedes neue Match einen freien Server aus dieser Liste. Die LAN-Verwaltung bekommt keine RCON-Passwörter zu sehen.

Im Admin-Bereich unter **CS2-Matches** steht dann „LAN-Client: 🟢 verbunden“.

| Variable | Wo | Bedeutung |
|---|---|---|
| `TMT2_AGENT_TOKEN` / `_FILE` | beide | Gemeinsames Token des LAN-Clients, mindestens 32 Zeichen |
| `TMT2_PUBLIC_URL` | LAN-Verwaltung | Optional: fester Link zur TMT2-Oberfläche im LAN, z. B. `http://192.168.1.10:8080` (funktioniert nur vor Ort). Ohne ihn gilt die Adresse aus der Statusdatei |
| `AMP_PUBLIC_URL` | LAN-Verwaltung | Optional: fester Link zum AMP-Panel, z. B. `http://192.168.1.10:8080`. Ohne ihn gilt die Adresse aus der Statusdatei |
| `LAN_STATUS_FILE` | LAN-Client | Optional: Statusdatei des Gameserver-Hosts (siehe „Gameserver und AMP“) |
| `LAN_URL` | LAN-Client | Adresse der LAN-Verwaltung, nur `https://` (http nur für `localhost` oder mit `ALLOW_HTTP=1`) |
| `TMT2_TOKEN` / `_FILE` | LAN-Client | Globales TMT2-Token. Bleibt im LAN |
| `TMT2_URL` | LAN-Client | Adresse von TMT2, im Stack `http://tmt2:8080` |
| `TMT2_BIND_ADDRESS`, `TMT2_PORT` | LAN | Wo TMT2 lauscht. Die CS2-Server müssen TMT2 für ihre Logs erreichen |
| `TMT2_LOG_ADDRESS` | LAN | Adresse von TMT2 aus Sicht der CS2-Server |

### Ohne Docker (systemd, z. B. Proxmox-LXC)

Läuft am LAN-Standort kein Docker, zum Beispiel in LXC-Containern unter Proxmox, laufen TMT2 und der LAN-Client als zwei systemd-Dienste direkt mit Node ≥ 22.

1. **TMT2 bauen:** Den Fork klonen. Backend und Frontend wie im `Dockerfile` des Forks bauen (`npm ci` und `npm run build` je Teil). Das Ergebnis so ablegen, dass `/opt/tmt2/backend/dist/backend/src/index.js` und `/opt/tmt2/frontend/dist` existieren. TMT2 leitet sein Programmverzeichnis aus diesem Pfad ab. Dazu `backend/package.json` und `backend/node_modules` (nur Produktionspakete) kopieren.
2. **Token vorab anlegen:** In TMT2s Datenordner, z. B. `/var/lib/tmt2`, die Datei `access_tokens.json` mit einem zufälligen Token schreiben: `{"<token>":{"comment":"LAN-Verwaltung"}}`. Dasselbe Token kommt als `TMT2_TOKEN` in eine Umgebungsdatei mit Rechten `600` für den Client. So erzeugt TMT2 kein eigenes Token und schreibt keines ins Log.
3. **TMT2-Dienst** unter einem eigenen Systembenutzer:

   ```ini
   [Service]
   User=tmt2
   WorkingDirectory=/opt/tmt2/backend
   ExecStart=/usr/bin/node ./dist/backend/src/index.js
   Environment=NODE_ENV=production TMT_PORT=8088 TMT_STORAGE_FOLDER=/var/lib/tmt2
   Environment=TMT_LOG_ADDRESS=http://192.168.1.10:8088
   Restart=always
   ProtectSystem=strict
   ReadWritePaths=/var/lib/tmt2
   ```

4. **LAN-Client** aus einem Klon dieses Repositorys, ebenfalls unter einem eigenen Benutzer: `ExecStart=/usr/bin/node agent/tmt2-agent.js` mit `TMT2_URL=http://127.0.0.1:8088` sowie `LAN_URL`, `TMT2_AGENT_TOKEN` und `TMT2_TOKEN` aus Umgebungsdateien (`EnvironmentFile=`, Rechte `600`). Optional kommt `LAN_STATUS_FILE` dazu.

**Mehrere Gameserver-Hosts:** Läuft jeder CS2-Server in einem eigenen Container, kann ein Skript auf dem TMT2-Host die Gameserver-Liste pflegen:

- Das Skript fragt die Gameserver-Container regelmäßig per SSH ab (systemd-Timer).
- Auf jedem Gameserver-Host erlaubt `authorized_keys` dem Schlüssel des Skripts nur ein festes Kommando, nur von der Adresse des TMT2-Hosts: `restrict,command="…",from="…"`.
- Das Kommando meldet die CS2-Instanzen als JSON mit Name, Adresse, Zustand und dem RCON-Passwort des laufenden Servers.
- Das Skript trägt die Server über die TMT2-API (`/api/gameservers`) ein und schreibt die Statusdatei für `LAN_STATUS_FILE`.
- Passwörter gibt das Skript nie aus. Es speichert davon nur Hashes, um Änderungen zu erkennen.
- Offene Server, die kein Turnier spielen (z. B. „4 All“), bleiben in TMT2 draußen.

## Gameserver und AMP

Unter **CS2-Matches** zeigt die Karte **Gameserver** alle Server mit Name, `connect`-Adresse, Zustand (läuft/aus) und Belegung in TMT2 (frei, belegt mit Paarung, gesperrt, nicht in TMT2). Daneben stehen die Links **TMT2 öffnen ↗** und **AMP öffnen ↗**.

Die Belegung fragt der LAN-Client bei TMT2 ab. Namen, Zustand und die Adressen von AMP und TMT2 liest er aus einer optionalen JSON-Datei (`LAN_STATUS_FILE`), die der Gameserver-Host schreibt, z. B. ein Skript neben AMP:

```json
{ "ampUrl": "http://192.168.1.10:8080", "tmt2Url": "http://192.168.1.10:8088",
  "servers": [{ "name": "Warserver#1", "address": "192.168.1.10:27015", "running": true }] }
```

Schreibt das Skript die aktuelle IP des Hosts hinein, folgen die Links nach einem Netzwechsel (z. B. auf der LAN-Party) von selbst. Feste Werte in `TMT2_PUBLIC_URL` bzw. `AMP_PUBLIC_URL` haben Vorrang. Den Stand hält die LAN-Verwaltung nur im Speicher. Nach einem Neustart erscheint er mit der nächsten Meldung des Clients wieder, nach wenigen Sekunden.

## Ablauf

1. Admin → **CS2-Matches**: Turnierpaarung und Format (BO1, BO3, BO5) wählen, „In TMT2 anlegen“. Das Match steht auf „wartet auf LAN-Client“, bis der Client es angelegt hat, normalerweise nach wenigen Sekunden.
2. Die Spieler gehen auf den Server und wählen ihr Team mit `.team a` bzw. `.team b`. Team A ist der erste Teilnehmer der Paarung.
3. Mapwahl aus dem Mappool des Events: BO1 bannt abwechselnd bis auf eine Map. BO3 und BO5 bannen zuerst zwei Maps, dann picken die Teams abwechselnd, und der Gegner wählt die Seite. Die übrigen Maps werden gebannt, die letzte ist die Entscheidungsmap mit Messerrunde.
4. Der Client meldet den Stand alle paar Sekunden. Nach Matchende wird das Ergebnis einmalig in den Turnierbaum eingetragen und wie ein normales Ergebnis angesagt.

### CS2-Turnier automatisch abgleichen

Statt jede Paarung einzeln anzulegen, lässt sich ein ganzes Turnier mit TMT2 verbinden: Im Turnierformular (Anlegen oder Bearbeiten) **„🔫 CS2-Matches automatisch in TMT2 anlegen“** anhaken und das Format wählen, getrennt für alle Spiele und für das Finale (z. B. BO1, Finale BO3). Der Schalter erscheint nur, wenn das Modul im Event eingeschaltet ist.

- Sobald das Turnier läuft, bekommt **jede spielbereite Paarung genau ein Match**, spätestens beim nächsten Abruf des LAN-Clients. Ist ein Spiel fertig, folgt das nächste automatisch. Ergebnisse kommen wie oben in den Turnierbaum.
- **Keine Doppelten:** Maßgeblich sind die gespeicherten Matches, auch nach einem Neustart. Ein Match in jedem Zustand (auch „Fehler“ oder „abgebrochen“) zählt. Für einen neuen Versuch das Match entfernen, dann legt die LAN-Verwaltung es neu an.
- **Korrekturen:** Ändert eine Ergebniskorrektur, ein von Hand eingetragenes Ergebnis, das Zurücksetzen oder Löschen des Turniers eine Paarung, verschwindet das offene automatische Match dazu und wird in TMT2 beendet. Für die neue Paarung entsteht ein neues Match. Beendete Matches und übernommene Ergebnisse bleiben. Ausnahme: Ein Unentschieden (z. B. 12:12 ohne Verlängerung) lädt TMT2 neu und hält den Gameserver. Sobald die Turnierleitung den Sieger von Hand einträgt, wird dieses Match in TMT2 beendet und der Server frei.
- **Abschalten** des Schalters legt keine neuen Matches mehr an; laufende Matches laufen weiter.
- Reicht der Mappool für das Format nicht (z. B. BO3 mit zwei Maps), steht das Match auf „Fehler“. Mappool erweitern und das Match entfernen.
- Diese Turniere fehlen in der Auswahl „Neues Match“ auf der Seite CS2-Matches; ihre Matches sind dort mit „automatisch“ markiert.

**Discord:** Sobald TMT2 ein Match für eine Turnierpaarung angelegt und einen Gameserver zugeteilt hat, kommt im Turnierkanal eine Ansage mit den Spielern (angepingt wie bei „Als Nächstes“) und der Adresse zum Verbinden, z. B. `connect 10.13.37.252:27016`. Die Adresse steht auch in der Admin-Liste, nie in öffentlichen Ansichten. Erwähnt werden nur Einträge, die im Turnier mit einer Person mit Discord-Konto verknüpft sind und die Teilnehmer des Events sind. Dafür muss der LAN-Client aktuell sein.

Es wird **nichts überschrieben**: Hat die Paarung inzwischen ein Ergebnis, hat sie sich geändert, läuft das Turnier nicht mehr oder gibt es keinen eindeutigen Sieger, steht ein Hinweis am Match. Dann trägt die Turnierleitung das Ergebnis von Hand ein. Ist in TMT2 gerade kein Gameserver frei oder hält ein noch nicht freigegebenes Match den Server, wartet das Match („Wartet auf einen freien Gameserver in TMT2“) und wird beim nächsten Abruf erneut angelegt. TMT2 gibt einen Server erst etwa eine Minute nach Matchende frei, so startet z. B. das Finale kurz nach dem letzten Halbfinale von selbst. Lehnt TMT2 das Anlegen aus einem anderen Grund ab, steht das Match auf „Fehler“ mit der Meldung von TMT2. Dann entfernen und neu anlegen. Entfernen beendet ein laufendes Match beim nächsten Abruf in TMT2. Ein schon übernommenes Ergebnis bleibt im Turnier.

Ist die Verbindung gestört, versucht der Client es mit wachsender Pause erneut (bis 60 s). Hat er ein Match angelegt, die Rückmeldung aber nicht mehr geschafft, findet er es beim nächsten Durchlauf über die Match-ID wieder und legt es kein zweites Mal an.

## Sicherheit

- Admin-Seite nur für die Orga, Rechteprüfung serverseitig. Der Client bekommt nur Aufträge aus Events, in denen das Modul eingeschaltet ist.
- Der Client meldet sich mit `TMT2_AGENT_TOKEN` an (Vergleich per `timingSafeEqual`). Abgelehnte Anfragen landen als `cs2_agent_rejected` im `sec`-Log und sind in der Rate begrenzt. Das Token geht nur per HTTPS ins Internet.
- Der Client gibt an TMT2 nur bekannte Felder weiter: Teams, Mappool, Mapwahl. `gameServer` ist immer `null`, RCON-Befehle und Webhooks gibt es nicht. Zurück an die LAN-Verwaltung gehen nur Status, Map-Stände und die Gameserver-Liste (Name, Adresse, läuft, Belegung), keine Passwörter, Spieler oder Logs.
- Gemeldete Links werden nur als `http(s)://Host[:Port]` ohne Zugangsdaten übernommen, Serveradressen nur als `Host:Port`. Alles andere wird verworfen.
- TMT2 hat eine eigene Anmeldung. Ohne Token darf dort jeder eigene Matches anlegen. TMT2 deshalb **nur im LAN** erreichbar machen.
