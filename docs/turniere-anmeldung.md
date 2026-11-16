# Turniere: Anmeldung, Teams und Coins

Anleitung für Besucher. Alles hier geht auf der Webseite unter **Meine Turniere** oder im Discord mit den gleichen Regeln.

## 1. Anmelden

1. Auf der Webseite oben auf **Meine Turniere** gehen.
2. **Mit Discord anmelden** drücken und bei Discord bestätigen. Nimm das Discord-Konto, mit dem du auch im LAN-Discord bist.
3. Fertig: Du siehst alle Turniere mit offener Anmeldung und oben deine Coins 🪙.

**„Kein Ticket gefunden“?** Turniere gibt es nur für Teilnehmer mit Ticket für dieses Event. Hast du dein Ticket selbst gekauft, wird dein Discord-Konto automatisch verknüpft. Hat jemand anderes für dich gekauft, schreib im Discord `/ich <dein Name> <Ticketcode>` oder frag die Orga.

## 2. Einzelturnier (1 gegen 1, Free-for-all)

- **Jetzt anmelden** drücken. Du stehst sofort in der Teilnehmerliste.
- **Abmelden** geht, solange die Anmeldung offen ist. Danach hilft die Orga.

## 3. Teamturnier

### Team gründen

1. Teamnamen eintippen und **Team gründen** drücken.
2. Du bist jetzt **Captain** 👑 deines Teams.
3. Sag deinen Mitspielern den Teamnamen. Sie fragen den Beitritt an, du bestätigst.

### Einem Team beitreten

1. Im Turnier das Team in der Liste suchen und **Beitritt anfragen** drücken.
2. Deine Anfrage wartet jetzt auf den Captain („⏳ wartet auf den Captain“).
3. Nimmt er an, bist du im Team; lehnt er ab, kannst du ein anderes Team anfragen oder selbst eins gründen. Im Discord bekommst du darüber eine Nachricht.

Du kannst pro Turnier nur **eine** Anfrage offen haben. Eine neue Anfrage ersetzt die alte, mit **Anfrage zurückziehen** nimmst du sie zurück.

### Als Captain

Unter deinem Team siehst du:

- **Beitrittsanfragen** mit **Annehmen** und **Ablehnen**. Im Discord bekommst du eine Nachricht, sobald jemand anfragt. Dort geht es auch mit `/team annehmen` bzw. `/team ablehnen`.
- **Umbenennen**: neuen Teamnamen eintragen.
- **Entfernen**: ein Mitglied aus dem Team nehmen.
- **Team auflösen**: meldet das ganze Team ab.

Die Captain-Rolle lässt sich nicht weitergeben. Verlässt der Captain das Team, ist es **aufgelöst**. Wer weiterspielen will, gründet ein neues Team.

### Team verlassen

Mitglieder drücken **Team verlassen**, solange die Anmeldung offen ist.

## 4. Coins 🪙

Gibt es bei einem Event Coins, siehst du oben auf der Seite, wie viele du noch hast.

- Jede Person bekommt pro Event die gleiche Anzahl Coins.
- Manche Turniere, meist Preisturniere, kosten Coins. So kann niemand bei allen Preisturnieren mitspielen. Turniere ohne Kosten sind frei.
- **Teams:** Jedes Mitglied zahlt die Kosten selbst. Geprüft wird schon bei der Anfrage, abgezogen wird erst, wenn der Captain dich aufnimmt.
- **Zurück** bekommst du deine Coins, wenn du dich abmeldest, das Team verlässt, entfernt wirst oder dein Team aufgelöst wird.
- Löschst du dein Konto, verfallen deine Coins.

Im Discord zeigt `/coins` deinen Stand und wofür du Coins ausgegeben hast.

## 5. Wenn das Turnier startet

Ab dem Start kannst du dich nicht mehr selbst an- oder abmelden, und Captains können ihr Team nicht mehr ändern. Fehlt jemand oder muss etwas getauscht werden, geh zur Orga. Die kann Mitglieder hinzufügen oder entfernen und Teams umbenennen, auch während das Turnier läuft.

Wenn euer Spiel dran ist, sagt der Bot im Discord das Team **mit allen Mitgliedern** an, z. B. „**Team A** (X, Y, Z) vs **Team B** (…)“.

## 6. Konto löschen

Unter **Tickets → Konto löschen** kannst du dein Konto entfernen. Dabei gilt für Turniere:

- Aus allen Turnieren, die noch nicht gestartet sind, wirst du ausgetragen.
- Bist du Captain, wird dein Team aufgelöst; die anderen Mitglieder bekommen ihre Coins zurück.
- In laufenden oder beendeten Turnieren bleibt dein Eintrag anonymisiert stehen, damit der Turnierbaum stimmt.

## Für die Orga

- **Anmeldung öffnen:** im Turnierformular „Anmeldung offen“ setzen, optional Anmeldeschluss, Teilnehmerlimit und Coins.
- **Coins:** unter **Einstellungen → Turnier-Coins** die Coins je Person und Event festlegen (0 = aus).
- **Teams verwalten:** im Turnierformular unter **👥 Teams verwalten** Mitglieder hinzufügen oder entfernen, den Captain setzen (👑) und Teams umbenennen, auch im laufenden Turnier. Der Turnierbaum bleibt dabei unverändert, Coins werden hier nicht geprüft. Offene Beitrittsanfragen stehen am Team.
- **Nur mit Ticket:** Verkauft das Event Tickets, können sich nur Teilnehmer mit Ticket selbst anmelden (Webseite und Discord). Ohne Ticketmodul geht es für alle. Die Webseite bekommt die Ablehnung mit dem Code `no-ticket`; der Login über `/api/auth/login?ziel=turniere` führt danach zurück zu „Meine Turniere“ (nur feste Ziele).
