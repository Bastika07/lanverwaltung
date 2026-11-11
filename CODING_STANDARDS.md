# Coding Standards

Regeln, die ein Review am Diff prüft. Was sich mechanisch prüfen lässt, steht als Check in `ops/` bzw. `test/ci.test.js` und gehört nicht hierher.

## Logzeilen mit Nutzerwerten

Werte, die Nutzer oder externe Dienste bestimmen (Turnier-, Team- und Personennamen, Freitexte, Discord-Daten, Fehlermeldungen mit solchen Werten), gehen nur über `logText(…)` aus `lib/security.js` in `console.*` bzw. `log.*`, und nie in den Formatstring. Zeilenumbrüche würden Logzeilen fälschen, und CodeQL (`js/log-injection`) erkennt nur dieses Muster als Bereinigung; ein neuer Fund sperrt den Merge.
