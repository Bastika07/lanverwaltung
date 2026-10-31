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

Turnierbaum, Paarungen und Platzierungen bleiben im Modul **Turniere**. TMT2 spielt nur das einzelne Match auf dem Server. Die Brücke lässt für eine spielbereite Paarung ein Match in TMT2 anlegen und trägt das Endergebnis (gewonnene Maps, z. B. 2:1) in den Turnierbaum ein. Freie Matches ohne Turnier gehen auch, zum Beispiel für Showmatches.

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
| `TMT2_PUBLIC_URL` | LAN-Verwaltung | Optional: Link zur TMT2-Oberfläche im LAN, z. B. `http://192.168.1.10:8080` (funktioniert nur vor Ort) |
| `LAN_URL` | LAN-Client | Adresse der LAN-Verwaltung, nur `https://` (http nur für `localhost` oder mit `ALLOW_HTTP=1`) |
| `TMT2_TOKEN` / `_FILE` | LAN-Client | Globales TMT2-Token. Bleibt im LAN |
| `TMT2_URL` | LAN-Client | Adresse von TMT2, im Stack `http://tmt2:8080` |
| `TMT2_BIND_ADDRESS`, `TMT2_PORT` | LAN | Wo TMT2 lauscht. Die CS2-Server müssen TMT2 für ihre Logs erreichen |
| `TMT2_LOG_ADDRESS` | LAN | Adresse von TMT2 aus Sicht der CS2-Server |

## Ablauf

1. Admin → **CS2-Matches**: Turnierpaarung und Format (BO1, BO3, BO5) wählen, „In TMT2 anlegen“. Das Match steht auf „wartet auf LAN-Client“, bis der Client es angelegt hat, normalerweise nach wenigen Sekunden.
2. Die Spieler gehen auf den Server und wählen ihr Team mit `.team a` bzw. `.team b`. Team A ist der erste Teilnehmer der Paarung.
3. Mapwahl aus dem Mappool des Events: BO1 bannt abwechselnd bis auf eine Map. BO3 und BO5 bannen zuerst zwei Maps, dann picken die Teams abwechselnd, und der Gegner wählt die Seite. Die übrigen Maps werden gebannt, die letzte ist die Entscheidungsmap mit Messerrunde.
4. Der Client meldet den Stand alle paar Sekunden. Nach Matchende wird das Ergebnis einmalig in den Turnierbaum eingetragen und wie ein normales Ergebnis angesagt.

Es wird **nichts überschrieben**: Hat die Paarung inzwischen ein Ergebnis, hat sie sich geändert, läuft das Turnier nicht mehr oder gibt es keinen eindeutigen Sieger, steht ein Hinweis am Match. Dann trägt die Turnierleitung das Ergebnis von Hand ein. Kann TMT2 das Match nicht anlegen (z. B. kein freier Gameserver), steht es auf „Fehler“ mit der Meldung von TMT2. Dann entfernen und neu anlegen. Entfernen beendet ein laufendes Match beim nächsten Abruf in TMT2. Ein schon übernommenes Ergebnis bleibt im Turnier.

Ist die Verbindung gestört, versucht der Client es mit wachsender Pause erneut (bis 60 s). Hat er ein Match angelegt, die Rückmeldung aber nicht mehr geschafft, findet er es beim nächsten Durchlauf über die Match-ID wieder und legt es kein zweites Mal an.

## Sicherheit

- Admin-Seite nur für die Orga, Rechteprüfung serverseitig. Der Client bekommt nur Aufträge aus Events, in denen das Modul eingeschaltet ist.
- Der Client meldet sich mit `TMT2_AGENT_TOKEN` an (Vergleich per `timingSafeEqual`). Abgelehnte Anfragen landen als `cs2_agent_rejected` im `sec`-Log und sind in der Rate begrenzt. Das Token geht nur per HTTPS ins Internet.
- Der Client gibt an TMT2 nur bekannte Felder weiter: Teams, Mappool, Mapwahl. `gameServer` ist immer `null`, RCON-Befehle und Webhooks gibt es nicht. Zurück an die LAN-Verwaltung gehen nur Status und Map-Stände, keine Passwörter, Spieler oder Logs.
- TMT2 hat eine eigene Anmeldung. Ohne Token darf dort jeder eigene Matches anlegen. TMT2 deshalb **nur im LAN** erreichbar machen.
