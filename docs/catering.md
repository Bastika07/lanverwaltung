# Catering

## Einrichten

1. Im Admin-Bereich oben das gewünschte Event wählen.
2. **Einstellungen → Module → Catering** aktivieren. Standardmäßig ist das neue Modul ausgeschaltet; bestehende Events werden nicht automatisch öffentlich erweitert.
3. Wahlweise Sichtbarkeit auf **nur Teilnehmer mit Ticket** setzen. Ohne diese Einschränkung dürfen auch angemeldete Konten ohne Ticket sich selbst anmelden; das erteilt keine Ticket-/Teilnehmerrechte.
4. Unter **Admin → Catering** Angebote mit Titel, Beschreibung, Preis pro Person, optionaler Ausgabezeit, Anmeldeschluss und Höchstzahl anlegen. `0` bei der Höchstzahl bedeutet unbegrenzt.

## Gäste

Unter **Catering** sehen Besucher die Angebote. Mit Discord angemeldete Gäste können sich selbst und Inhaber ihrer bezahlten Tickets eintragen. Verknüpfte Personen werden über ihre feste Personen-ID zugeordnet; ein frei gewählter Name gewährt keinen Zugriff auf fremde Gäste. Ohne Personenverknüpfung wird die eigene Anmeldung dem Konto zugeordnet. Pro Gast und Angebot ist nur eine Anmeldung möglich, mit einer Portion pro Anmeldung.

Gäste sehen nur ihre eigenen bzw. die zu ihren bezahlten Tickets gehörenden Anmeldungen samt Betrag und Zahlungsstatus, keine fremden Namen oder Zahlungen. Öffentlich sichtbar ist die Zahl der Anmeldungen je Angebot. Unbezahlte Anmeldungen können vor Anmeldeschluss wieder entfernt werden. Bei geschlossener Anmeldung oder beendetem Event hilft die Orga.

## Verwaltung und Bezahlung

- **Gast zuweisen:** Auswahl aus den Event-Teilnehmern und registrierten Konten. Zusätzliche Gäste vorher unter **Teilnehmer** anlegen; kein Discord-Konto für eine Admin-Zuweisung erforderlich.
- Admins dürfen auch bei geschlossener Selbstanmeldung zuweisen. Die Höchstzahl bleibt verbindlich und muss bei Bedarf zuerst erhöht werden.
- In der Anmeldungsliste **Als bezahlt markieren** wählen. Der Zeitpunkt wird gespeichert; Summen zeigen bezahlte und offene Beträge. Der Angebotsfilter grenzt die Liste ein.
- **Wieder offen setzen** nimmt die Zahlungsmarkierung nach ausdrücklicher Bestätigung zurück. Das löst keine echte Erstattung aus. Bezahlte Anmeldungen können nicht direkt gelöscht werden: zuerst eine Erstattung außerhalb des Systems klären und den Zahlungsstatus zurücksetzen.
- Preise sind ganze Centbeträge. Jede Anmeldung speichert den bei ihrer Erstellung gültigen Preis; spätere Angebotsänderungen ändern bestehende Beträge oder Zahlungen nicht.
- Angebote mit Anmeldungen können nicht gelöscht werden; stattdessen die Selbstanmeldung schließen. Events mit Catering-Anmeldungen bleiben als Archiv erhalten.
- Beim Kopieren eines Events werden Angebote ohne Zeiten, zunächst geschlossen und mit neuen IDs übernommen, niemals Anmeldungen oder Zahlungen.

Es gibt keine Online-Zahlungsabwicklung, Rechnungserstellung, automatische Mahnung oder Discord-Catering-Befehle. Freitexte sind einfache, HTML-kodierte Texte, kein HTML-Editor.

## Speicherung und Schutz

Catering wird pro Event im vorhandenen SQLite-Eventdatensatz gespeichert, ohne neues SQLite-Schema und ohne Rückfall auf die alte `db.json`. Atomare SQLite-Speicherung und Online-Backup gelten unverändert. Das betrifft nur die Datenhaltung; organisatorische Aufbewahrungs-/Löschfristen sind weiterhin separat festzulegen.

Kontolöschung entfernt direkte Kontozuordnungen aus Catering-Einträgen; verknüpfte Personen werden durch das bestehende Löschverfahren pseudonymisiert. Bezahlstatus und Beträge bleiben für die Abrechnung erhalten. Namen werden nicht zusätzlich in Catering-Datensätzen dupliziert. Zusammenführen von Personen übernimmt ihre Catering-Zuordnungen; doppelte Anmeldungen für dasselbe Angebot müssen vorher mit der Orga geklärt werden.

Admin-/Sitzungsrechte, Modulstatus, Sichtbarkeit, Anmeldeschluss, aktuelle Höchstzahl und Zahlungsstand werden nach einem Body-Upload erneut berücksichtigt. Versionsprüfungen verhindern, dass eine veraltete Oberfläche eine neuere Zahlung oder Angebotsänderung überschreibt. Für das Modul gelten dieselben CSRF-/Proxy-Grenzen wie für die übrige Anwendung.

Nachtests: `node --test test/catering.test.js test/catering-render.test.js` sowie die vollständige Suite `node --test`; nur synthetische Daten, keine produktiven Discord-/DMX-Ziele.
