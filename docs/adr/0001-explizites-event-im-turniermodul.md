# Explizites Event im Turniermodul

Abweichend von der Hauskonvention, das aktuelle Event implizit über AsyncLocalStorage (`db.tournaments`) zu lesen, bekommt das Turniermodul das Event ausdrücklich übergeben: `tournaments.of(event).…`. Grund: TMT2 arbeitet alle aktivierten Events nacheinander ab und Discord-Befehle laufen ohne eigenen Eventkontext. Beim impliziten Kontext landen Ergebnisse oder Änderungen daher leicht im falschen Event. Bei der expliziten Übergabe ist an jeder Aufrufstelle sichtbar, um welches Event es geht, und Tests kommen ohne Kontextaufbau aus.

## Consequences

- HTTP-Routen übergeben `ctx.event.scoped()`, Discord `ctx.event.current()`, TMT2 das gerade bearbeitete Event.
- Andere Module nutzen weiter den impliziten Kontext; dieses ADR ist kein Auftrag, sie umzustellen.
