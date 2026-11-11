# Prüfen vor dem Ändern statt Rollback

Eine abgelehnte Anfrage darf nichts ändern, auch nicht im Arbeitsspeicher, den die nächste Speicherung übernähme. Das sichert jede Operation selbst: erst alle Eingaben und Bedingungen prüfen, dann ändern. Eine allgemeine Speicherfunktion, die bei einem Fehler zurücksetzt, wurde verworfen: Die Module halten direkte Verweise auf Objekte im Speicher (Spielplan-Cache, Discord-Warteschlangen), und gleichzeitige Anfragen haben während eines `await` noch ungespeicherte Änderungen, die ein Zurücksetzen mitreißen würde. `save()` selbst bleibt atomar (eine SQLite-Transaktion).

## Consequences

- Muster in Operationen: Werte vorab bereinigen und in Variablen halten, Bedingungen prüfen, dann zuweisen (z. B. `info.js`, `tickets.js` Inhaber, `tournaments.update`). Seiteneffekte wie das Anlegen einer Person erst nach allen Prüfungen.
- Tests prüfen „abgelehnt → gespeicherter Stand unverändert“, siehe `test/validate-before-apply.test.js`.
- Reviews achten darauf (`CODING_STANDARDS.md`); ein automatischer Check ist dafür nicht möglich.
