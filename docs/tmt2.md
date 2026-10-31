# CS2-Matches mit TMT2

Das Modul **🔫 CS2-Matches** verbindet die LAN-Verwaltung mit **TMT2 – Tournament Match Tracker 2**. TMT2 betreut Counter-Strike-2-Matches auf euren Gameservern: Mapwahl per Ingame-Chat (`.ban`, `.pick`, `.ct`/`.t`), Messerrunde, Mapwechsel, Seitenwechsel und Round-Backups. Ein Plugin auf dem CS2-Server ist nicht nötig.

## Herkunft und Lizenz

- Original: [JensForstmann/tmt2](https://github.com/JensForstmann/tmt2) von **Jens Forstmann**
- Fork: [Bastika07/tmt2](https://github.com/Bastika07/tmt2), unverändert auf dem Stand `d699867` (TMT2 3.0.0)
- Lizenz: **MIT**, Copyright (c) 2020 Jens Forstmann. Der Lizenztext liegt im Fork (`LICENSE`); der Hinweis steht zusätzlich in [NOTICE](../NOTICE).

TMT2 ist in TypeScript geschrieben und braucht npm-Pakete und einen Build. Deshalb läuft es als **eigener Container** neben der LAN-Verwaltung. Dieses Repository bleibt ohne npm-Abhängigkeiten. Hier liegt nur die Brücke ([lib/tmt.js](../lib/tmt.js), [public/cs2.js](../public/cs2.js)).

## Abgrenzung zum eigenen Turniermodul

Turnierbaum, Paarungen und Platzierungen bleiben im Modul **Turniere**. TMT2 spielt nur das einzelne Match auf dem Server. Die Brücke legt für eine spielbereite Paarung ein Match in TMT2 an und trägt das Endergebnis (gewonnene Maps, z. B. 2:1) in den Turnierbaum ein. Freie Matches ohne Turnier gehen auch, zum Beispiel für Showmatches.

## Einrichten

1. In `.env` die TMT2-Werte setzen (Vorlage in `.env.example`) und TMT2 mitstarten:

   ```bash
   docker compose --profile tmt2 up -d --build
   ```

   Compose baut das Image aus dem Fork mit festem Commit.
2. Das globale Token aus dem TMT2-Log holen (`docker logs tmt2`, Zeile „First auto generated access token“) oder aus `access_tokens.json` im Volume `tmt2-storage`. Als `TMT2_TOKEN` (oder `TMT2_TOKEN_FILE`) eintragen und `turnierbaum` neu starten.
3. Gameserver in der TMT2-Oberfläche unter **Game Servers** anlegen (IP, Port, RCON-Passwort). Die LAN-Verwaltung speichert keine RCON-Passwörter. TMT2 nimmt für jedes neue Match einen freien Server aus dieser Liste.
4. Im Admin-Bereich unter **Einstellungen → Module** für das Event **CS2-Matches** einschalten.

| Variable | Bedeutung |
|---|---|
| `TMT2_URL` | Interne Adresse der TMT2-API, in Compose `http://tmt2:8080` |
| `TMT2_TOKEN` / `TMT2_TOKEN_FILE` | Globales TMT2-Token. Bleibt auf dem Server und geht nie an den Browser |
| `TMT2_PUBLIC_URL` | Optional: Link zur TMT2-Oberfläche im Admin-Bereich |
| `TMT2_WEBHOOK_URL` | Optional: Adresse, unter der TMT2 die LAN-Verwaltung erreicht, in Compose `http://turnierbaum:3000`. Leer bedeutet: Stand nur über „Abgleichen“ holen |
| `TMT2_BIND_ADDRESS`, `TMT2_PORT` | Wo TMT2 lauscht. Die CS2-Server müssen TMT2 für ihre Logs erreichen |
| `TMT2_LOG_ADDRESS` | Adresse von TMT2 aus Sicht der CS2-Server, z. B. `http://192.168.1.10:8080` |

## Ablauf

1. Admin → **CS2-Matches**: Turnierpaarung und Format (BO1, BO3, BO5) wählen, „In TMT2 anlegen“.
2. Die Spieler gehen auf den Server und wählen ihr Team mit `.team a` bzw. `.team b`. Team A ist der erste Teilnehmer der Paarung.
3. Mapwahl aus dem Mappool des Events: BO1 bannt abwechselnd bis auf eine Map. BO3 und BO5 bannen zuerst zwei Maps, dann picken die Teams abwechselnd, und der Gegner wählt die Seite. Die übrigen Maps werden gebannt, die letzte ist die Entscheidungsmap mit Messerrunde.
4. Den Stand meldet TMT2 per Webhook, sonst holt ihn „Abgleichen“. Nach Matchende wird das Ergebnis einmalig in den Turnierbaum eingetragen und wie ein normales Ergebnis angesagt.

Es wird **nichts überschrieben**: Hat die Paarung inzwischen ein Ergebnis, hat sie sich geändert, läuft das Turnier nicht mehr oder gibt es keinen eindeutigen Sieger, steht ein Hinweis am Match. Dann trägt die Turnierleitung das Ergebnis von Hand ein. Löschen beendet das Match in TMT2 und entfernt es aus der Liste. Ein schon übernommenes Ergebnis bleibt im Turnier.

## Sicherheit

- Die Brücke ist nur für Admins und nur bei eingeschaltetem Modul aktiv. Die Prüfung läuft serverseitig.
- Jedes Match bekommt ein eigenes zufälliges Webhook-Geheimnis. TMT2 schickt es als `Authorization`-Header mit. Gespeichert wird nur sein SHA-256-Hash. Abgelehnte Webhooks landen als `cs2_webhook_rejected` im `sec`-Log und sind in der Rate begrenzt.
- `TMT2_URL` kommt nur aus der Umgebung. Über die Oberfläche lässt sich keine andere Zieladresse setzen.
- TMT2 hat eine eigene Anmeldung. Ohne Token darf dort jeder eigene Matches anlegen. TMT2 deshalb **nur im LAN** erreichbar machen und nicht ins Internet stellen.
- Mit `PROXY_ONLY=1` nimmt die LAN-Verwaltung nur Anfragen über den Reverse Proxy an. Dann `TMT2_WEBHOOK_URL` auf die Proxy-Adresse setzen oder ohne Webhook mit „Abgleichen“ arbeiten.
