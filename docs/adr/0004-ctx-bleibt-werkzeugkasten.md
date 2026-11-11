# ctx bleibt der gemeinsame Werkzeugkasten

Die bestehenden Module in `lib/` bekommen weiterhin `ctx` (Speicher, HTTP-Helfer, Einstellungen und Verweise auf andere Module) statt ausdrücklich genannter Abhängigkeiten. Ein Umbau wurde verworfen: Mehrere Module hängen im Kreis voneinander ab (`people` ↔ `accounts`, `people` ↔ `tickets`, `tickets` ↔ `accounts`, `people` ↔ `catering`) und lesen sich deshalb erst beim Aufruf aus `ctx`; ausdrückliche Abhängigkeiten bräuchten dafür überall verzögerte Verweise, ohne Verhalten zu ändern.

## Consequences

- Neue oder grundlegend umgebaute Module bekommen ihre Abhängigkeiten ausdrücklich übergeben, nach dem Vorbild von `lib/tournaments.js` und `lib/participation.js`.
- Ein Modul darf auf andere Module in `ctx` erst beim Aufruf zugreifen, nicht beim Anlegen (Startreihenfolge in `server.js`).
- Tests ohne Server bauen ihren Kontext mit `testCtx` aus `test-support/ctx.cjs`: Fehlende Einträge brechen dort sofort mit Namen ab.
