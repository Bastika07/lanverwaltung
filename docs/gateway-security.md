# Discord-Gateway: Vertrauensgrenzen und Timer

## Verbindungsziele

Discord dokumentiert das initiale Gateway als `wss://gateway.discord.gg` und verlangt bei Reconnect die `resume_gateway_url` aus READY mit derselben Version und Kodierung: [Gateway](https://docs.discord.com/developers/events/gateway), [READY](https://docs.discord.com/developers/events/gateway-events#ready).

Die lokale Sicherheitsrichtlinie erlaubt initial ausschließlich `gateway.discord.gg`. Für Resume sind zusätzlich regionale Hosts nach dem eng begrenzten Muster `gateway-<alphanumerische Segmente>.discord.gg` zugelassen, beispielsweise `gateway-us-east1-b.discord.gg`. Dieses Muster ist eine bewusste Anwendungs-Allowlist, keine Zusage von Discord über alle künftigen Hostnamen. Neue legitime Hostfamilien benötigen eine geprüfte Erweiterung; REST-Overrides umgehen diese Prüfung nicht.

Nur `wss:`, Root-Pfad und Standardport 443 sind erlaubt. Credentials, Fragmente, fremde Hosts, IP-Adressen, täuschende Domain-Suffixe und andere Ports werden abgelehnt. Nach der Parser-Prüfung entsteht die Zieladresse vollständig neu: feste Protokoll-/Domain-/Pfad-/Query-Bestandteile, bei Resume ergänzt um das separat URI-kodierte, allowlistgeprüfte Regionssegment. Die fremde URL wird nicht an WebSocket weitergereicht. Initial- und Resume-Ziel werden vor dem Verbindungsaufbau geprüft; ein fehlerhaftes Resume-Ziel verwirft die Session. Zieladressen und Bot-Token werden bei einer Ablehnung nicht geloggt.

## Heartbeats und Lebenszyklus

HELLO muss ein ganzzahliges Intervall zwischen **1.000 und 120.000 ms** enthalten. Dies sind lokale Sicherheitsgrenzen, keine von Discord garantierten Protokollgrenzen. Die Discord-Dokumentation zeigt 45.000 ms als Beispiel. Die Untergrenze begrenzt den periodischen Zyklus auf höchstens einen Heartbeat pro Sekunde (Discord erlaubt insgesamt 120 ausgehende Gateway-Ereignisse pro Minute); die Obergrenze verhindert überlange Überwachungszyklen und Timer-Überläufe. Der erste Heartbeat folgt nach `Intervall × Zufallswert`, jeder weitere nach einem vollständigen Intervall. Fehlendes ACK beendet die Verbindung. Auch unmittelbar angeforderte Heartbeats (Opcode 1) benötigen ein ACK und verschieben den periodischen Zyklus nicht: [Heartbeats](https://docs.discord.com/developers/events/gateway#sending-heartbeats). Doppelte HELLO-Nachrichten werden zurückgewiesen, statt weitere Timer anzulegen.

Close, Reconnect, Invalid Session und `stop()` bereinigen die betroffenen Timer; `stop()` widerruft auch geplante Reconnects und verhindert Verbindungen aus später eintreffenden REST-Antworten (der REST-Aufruf selbst wird nicht abgebrochen). Ereignisse alter Sockets werden ignoriert. Ungültige JSON-/HELLO-/READY-Nachrichten, nicht ganzzahlige Opcodes, ungültige Sequenznummern und nicht boolesche Invalid-Session-Werte schließen kontrolliert die Verbindung, ohne den HTTP-Server abstürzen zu lassen. Die Close-Codes 1000, 1001, 4007 und 4009 verwerfen die Session, damit anschließend IDENTIFY statt eines endlosen RESUME-Versuchs folgt: [Close-Codes](https://docs.discord.com/developers/topics/opcodes-and-status-codes#gateway-gateway-close-event-codes).

`node --test test/gateway.test.js` prüft die echte Gateway-Implementierung mit simulierten externen WebSockets, REST-Antworten und deterministischer Zeit. Es werden keine echten Tokens, Discord-Verbindungen oder produktiven Daten verwendet.

## Ergänzung: CodeQL-Datenfluss an den API-Grenzen

Auf PR-Stand `3c5f1ef` meldete CodeQL trotz bestehender Ziel- und HELLO-Validierung weiterhin die Folgehinweise #8 (Request forgery) und #7 (Resource exhaustion). Die globale Datenflussanalyse erkennt weder die eigene URL-Allowlist als Sanitizer noch die äußere Bereichsprüfung zuverlässig für einen später ausgeführten Callback.

Die Zieladresse wird deshalb aus festen Bestandteilen und einem separat kodierten Regionssegment rekonstruiert. Der gemeinsame Heartbeat-Scheduler prüft die tatsächliche Verzögerung unmittelbar vor `setTimeout` nochmals auf einen endlichen Wert zwischen 0 und 120.000 ms; 0 ist nur für den initialen Jitter zulässig, das HELLO-Intervall bleibt ganzzahlig zwischen 1.000 und 120.000 ms. Bestehende Schutzprüfungen bleiben erhalten; keine CodeQL-Regel wird abgeschaltet oder ein Alert manuell quittiert.

Lokale Nachprüfung: **15 Gateway-Tests und insgesamt 116 Tests bestanden**, ebenso `npm run check`. Zusätzliche Fälle prüfen die Intervallgrenzen, manipulierte Regionshosts und die Scheduler-Grenze unabhängig von HELLO. Eine nur im Testprozess eingespielte Mutation ohne Scheduler-Prüfung lässt den neuen Grenztest erwartungsgemäß scheitern; Repository-Dateien werden dabei nicht verändert. Der erneute Remote-CodeQL-Lauf für diese Ergänzung steht zum Zeitpunkt dieser Dokumentation noch aus; das Ergebnis wird am PR nachgewiesen.

## Historische Verifikation zu Issues #3 und #4

- Node v24.22.1: **13/13 Gateway-Tests bestanden**; `node --check lib/gateway.js` und `git diff --check` für die drei Gateway-Dateien ohne Fehler.
- Gegenprobe in einer isolierten Scratch-Fixture: ausschließlich `git show 62f6583:lib/gateway.js` als Implementierung und die aktuellen Gateway-Tests kopiert, keine produktiven Dateien überschrieben. Ergebnis: **0/13 bestanden, 13 erwartete Fehler**, Exit-Code 1. Unter anderem wurden ein `ws:`-Ziel akzeptiert, für Intervall 0 zwei Timer und für doppeltes HELLO vier Timer erzeugt; ungültiges JSON warf eine Exception. Auch der ausstehende REST-Lookup öffnete nach `stop()` noch einen Socket.
- Die zusätzlich gefundenen Fehler (ACK bei angefordertem Heartbeat, Session-Neustart nach invalidierenden Close-Codes, fehlerhafte Frame-Felder) wurden jeweils zuerst mit einem fehlschlagenden Test in der bestehenden Arbeitskopie belegt und danach behoben.
- **CodeQL noch ausstehend:** Lokal ist kein `codeql`-CLI im PATH verfügbar. Die erneut gelesenen GitHub-Alerts 6 (`js/request-forgery`) und 3 (`js/resource-exhaustion`) sind weiterhin offen und beziehen sich auf `refs/heads/main`, Commit `62f65834c7fd98fb0c924c8d9fdac3c3a298609b`, nicht auf diese uncommitteten Änderungen. Es wurde kein neuer Scan behauptet, kein Alert unterdrückt und kein Issue geschlossen. Ein erneuter CodeQL-Lauf nach Übernahme der Änderungen bleibt erforderlich.
