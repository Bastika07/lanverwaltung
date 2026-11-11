# Personenänderungen ohne zentrales Register

Umbenennen, Zusammenführen und Löschen von Personen sowie die Kontolöschung rufen die beteiligten Module ausdrücklich auf (`people.js` bzw. `privacy.js` -> Turniere, Tickets, Catering, Gastserver, jeweils mit eigener Operation wie `forgetPerson` oder `onAccountDeleted`). Ein Register, in das sich Module mit ihren Personen-Verweisen eintragen, wurde verworfen: Bei vier Beteiligten verschiebt es die Logik nur, statt sie zu bündeln, und die Reihenfolge der Schritte wäre nicht mehr am Aufruf ablesbar.

## Consequences

- Jedes Modul ändert nur seine eigenen Daten; die aufrufende Stelle legt nur fest, *was* passiert (z. B. welche Pseudonyme gelten).
- Ein neues Modul mit Personen-Verweisen muss an diesen Stellen ergänzt werden.
- Nicht jeder Verweis wird beim Löschen bereinigt: Ticket-Verweise ordnet das Ticket-Modul neu zu, Catering zeigt „Entfernter Gast“ (siehe Issue #100).
