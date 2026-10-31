# Markdown in Freitextfeldern

Markdown ist in folgenden Feldern möglich:

- Infos: WLAN-Hinweis, Hinweise zu Gameservern und Spielen, Sonstiges und Hausregeln
- Eventdetails: Weitere Infos
- Programm: Hinweis (auch auf Startseite und Beamer)
- Tickets: Beschreibung der Ticketart und Datenschutzhinweis bei der Registrierung
- Catering und Gastserver: Beschreibung
- Website & Rechtliches: Seiteninhalte, Cookie-Hinweis, Sponsoren-Einleitung und -Beschreibungen

Unter den Eingabefeldern öffnet **Markdown-Hilfe & Vorschau** eine lokale Live-Vorschau. Speichern funktioniert wie bisher. Die vorhandenen Zeichenlimits gelten weiterhin einschließlich Markdown-Syntax. Namen, Adressen, Passwörter und technische Werte bleiben Klartext.

```markdown
## Wichtig für die LAN

Bitte **vorher installieren** und *aktualisieren*.

- LAN-Kabel mitbringen
- [Spiel herunterladen](https://example.org/download)

1. Anmelden
2. Platz aufbauen

> Bei Fragen hilft die Orga.

Server: `10.0.0.1:27015`

| Zeit | Programmpunkt |
| --- | --- |
| 18:00 | Begrüßung |
```

Auch durchgestrichener Text (`~~alt~~`) und Codeblöcke mit drei Backticks sind möglich. Bestehende Texte werden unverändert gespeichert; einzelne Zeilenumbrüche bleiben sichtbar. Bereits vorhandene Markdown-Zeichen werden jetzt als Formatierung interpretiert. Mit einem Backslash lassen sie sich maskieren, zum Beispiel `\*kein kursiver Text\*`.

HTML wird nur als Text angezeigt. Markdown-Bilder zeigen lediglich ihren Alternativtext; externe Bilder, Skripte und Einbettungen werden nicht geladen. Links erlauben nur HTTP, HTTPS, Mailto und Hash-Ziele. Vorschau und öffentliche Ausgabe verwenden denselben lokal ausgelieferten Parser und dieselben Sicherheitsregeln. Zusätzlich lässt eine Allowlist am fertigen HTML nur die erwarteten Markdown-Elemente ohne Styles, Event-Handler oder Datenattribute durch; alles andere erscheint als Text, auch bei künftigen Parser-Änderungen. Bedienelemente des Admin-Bereichs werden nie an Elemente aus Beschreibungen gebunden. Es gibt keine Datenmigration und keine zusätzlichen externen Anfragen.
