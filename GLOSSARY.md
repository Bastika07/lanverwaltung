# Lanverwaltung

Fachsprache des LAN-Party-Systems: Events, Personen, Teilnahme und Turniere.

## Events und Personen

**Event**:
Eine einzelne LAN-Party mit eigenen Turnieren, Tickets, Teilnehmerliste und Modulauswahl.
_Avoid_: Veranstaltung, Party

**Person**:
Ein Mensch, der eventübergreifend erhalten bleibt; Ticketnamen und Anzeigenamen sind kein Identitätsnachweis.
_Avoid_: Spieler (für die Identität), User

**Teilnehmer**:
Eine Person, die in einem Event selbst ein bezahltes Teilnehmerticket hält oder eine Orga-Freigabe hat.
_Avoid_: Mitglied, Besucher

**Teilnehmerrechte**:
Zugang eines Kontos zu Bereichen „nur für Teilnehmer“: als Käufer eines bezahlten Teilnehmertickets oder über eine verknüpfte Person, die Teilnehmer ist.
_Avoid_: Mitgliedschaft, Member

**Teilnehmerticket**:
Ein Ticket einer Ticketart, die als Teilnehmer zählt; Zuschauer- oder Tagestickets gehören nicht dazu.

## Turniere

**Turnier**:
Ein Wettbewerb innerhalb eines Events im Modus Single Elimination, Double Elimination oder „Jeder gegen jeden“, für Einzelspieler oder Teams.

**Turniereintrag**:
Ein Platz im Turnier, belegt von einem Einzelspieler oder einem Team.
_Avoid_: Turnierplatz (kollidiert mit Sitzplatz), Slot, Teilnehmer (im Turnierkontext)

**Gebundener Eintrag**:
Ein Turniereintrag, der über eine feste Personen-ID einer geprüften Person zugeordnet ist, nie über einen gleichen Namen.
_Avoid_: verknüpfter Name, gematchter Spieler

**Team**:
Ein Turniereintrag in einem Teamturnier, dessen Mitglieder gebundene Personen sind.
_Avoid_: Clan (Clan ist eine Personenangabe, kein Turniereintrag)

**Spielplan**:
Die aus Turniereinträgen und Ergebnissen berechnete Ansicht aller Paarungen eines Turniers.
_Avoid_: Bracket, Turnierbaum (für die berechnete Gesamtansicht)

**Paarung**:
Ein einzelnes Spiel zweier Turniereinträge im Spielplan.
_Avoid_: Match (außer für CS2-Matches in TMT2)

**Gruppenphase**:
Turniermodus, in dem zuerst in Gruppen jeder gegen jeden spielt und die Besten jeder Gruppe in eine K.-o.-Runde einziehen.

**Setzplatz**:
Ein fester Platz in der Startreihenfolge, der bei der Auslosung erhalten bleibt.
_Avoid_: Seed (im Deutschen)

**Ergebnis**:
Der festgeschriebene Ausgang einer Paarung, als Punktestand oder als kampflose Wertung; ein Unentschieden gibt es nur bei „Jeder gegen jeden“ und in Gruppenspielen.

**Meldung**:
Ein von einer Seite der Paarung eingetragenes Ergebnis, das bei eingeschalteter Bestätigung erst nach Bestätigung durch die Gegenseite gilt.
_Avoid_: Ergebnis (solange nicht bestätigt)

**Bestätigung**:
Die Zustimmung der Gegenseite zu einer Meldung, ausdrücklich, durch eine gleiche eigene Meldung oder automatisch nach Ablauf der Frist ohne Einspruch.

**Strittige Paarung**:
Eine Paarung, deren Meldung die Gegenseite bestritten oder abweichend gemeldet hat; über sie entscheidet die Turnierleitung.
_Avoid_: Streitfall, Konflikt

**Kampflose Wertung**:
Ein Ergebnis ohne Spiel, bei dem eine Seite als Verlierer gewertet wird.
_Avoid_: Forfeit, Walkover

**Disqualifikation**:
Ausschluss eines Turniereintrags aus dem laufenden Turnier; offene Paarungen gehen kampflos an den Gegner, gespielte Ergebnisse bleiben.

**Protokoll**:
Die Liste aller Meldungen, Bestätigungen und Entscheidungen eines Turniers, sichtbar nur für die Turnierleitung.
_Avoid_: Log, Verlauf

**Coins**:
Ein Budget pro Person und Event, mit dem sich Personen für Turniere anmelden, die Coins kosten; Abmelden gibt sie zurück.
_Avoid_: Punkte, Credits

## Rollen

**Orga**:
Wer den Admin-Bereich nutzen darf; legt Turniere an, ändert Einstellungen und entscheidet über alles.
_Avoid_: Admin (in Texten für Teilnehmer), Veranstalter

**Turnierleiter**:
Eine Person, die die Orga für ein bestimmtes Turnier einsetzt; sie darf dort Ergebnisse festschreiben, kampflos werten und disqualifizieren, aber keine Einstellungen ändern.
_Avoid_: Schiedsrichter, Referee

**Turnierleitung**:
Orga und Turnierleiter eines Turniers zusammen.

**Akteur**:
Wer eine Änderung auslöst: die Orga, ein Turnierleiter, eine geprüfte Person oder TMT2, über Webseite oder Discord.
_Avoid_: Benutzer, Aufrufer
