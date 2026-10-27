# Website-Module

Unter **Admin → Website & Rechtliches** stehen sechs einzeln schaltbare Module bereit:

- Impressum, Datenschutzerklärung, AGB und Verhaltenskodex: öffentliche Textseiten mit Footer-Link und Änderungsdatum.
- Cookie-Banner: schließbarer Hinweis und eine Detailseite zu den tatsächlich verwendeten Cookies/Browserspeichern.
- Sponsoren: Einleitung und bis zu 40 Einträge mit Name, Kategorie, Beschreibung und optionalem HTTPS-Link, auf Startseite und eigener Seite. Reihenfolge und Sichtbarkeit je Sponsor sind bearbeitbar.

Alle Inhalte gelten **websiteweit**, unabhängig vom ausgewählten Event und dessen Zugangsbeschränkungen. Zu Beginn sind alle Module ausgeschaltet, Texte leer und nur ein technischer Cookie-Hinweis vorbelegt. Es werden keine Namen/Adressen erfunden oder pauschalen Rechtstexte veröffentlicht. Erst prüfen, ausfüllen und gezielt aktivieren. Eine deaktivierte Seite ist nur im Admin-API sichtbar; sie ist kein öffentlicher Entwurf. Das Modul ersetzt nicht die Verantwortung, erforderliche Rechtstexte bereitzustellen.

Speichern ersetzt die komplette Website-Konfiguration. Eine Versionsprüfung verhindert das Überschreiben zwischen zwei Admin-Tabs; bei Konflikt den eigenen Text extern sichern, neu laden und abgleichen. Textfelder unterstützen [Markdown](markdown.md) mit Überschriften, Listen, Links, Tabellen und Codeblöcken, kein aktives HTML, JavaScript oder eingebettete Medien. Die aufklappbare Hilfe zeigt eine lokale Live-Vorschau mit derselben sicheren Darstellung wie die öffentliche Seite. Externe Sponsorenbilder werden nicht geladen; Links öffnen erst nach einem Klick mit `noreferrer`, der separate Website-Link zusätzlich mit `rel=sponsored`. Entwürfe können frei bearbeitet werden; bei veröffentlichten Modulen werden gespeicherte Änderungen sofort öffentlich. Es gibt keine getrennte Entwurfsfassung einer bereits veröffentlichten Seite.

Veröffentlichte Datenschutz-, AGB- und Verhaltenskodex-Seiten werden zusätzlich am Profil-/Bestellformular verlinkt. **AGB/Verhaltenskodex sind Informationsseiten:** Eine beweissichere Zustimmung beim Bestellen, Vertragsversionen und Widerrufsbelehrungen sind nicht implementiert. Ob und wie dies für die Veranstaltung erforderlich ist, muss die Orga prüfen. Der bisherige kurze Datenschutzhinweis bei der Registrierung bleibt unabhängig davon erhalten und sollte inhaltlich zur veröffentlichten Erklärung passen.

## Cookie-Hinweis statt Schein-Einwilligung

Die Anwendung lädt derzeit keine optionalen Analyse-/Marketingdienste. Daher gibt es kein „Alle akzeptieren“ und keine vorgetäuschten Kategorien. Das Banner blockiert keine Inhalte; Impressum und Datenschutz bleiben bedienbar. „Hinweis schließen“ wird in `sessionStorage` als `lan-cookie-notice` für die aktuelle Tab-Sitzung gespeichert. Änderungen am Hinweis oder veröffentlichten Datenschutztext zeigen ihn erneut. Der Footer-Link öffnet eine Detailseite; dort lässt sich der Hinweis erneut anzeigen. Bei gesperrtem Browserspeicher lässt er sich trotzdem schließen, erscheint aber nach Neuladen wieder. Im Beamerbetrieb wird das Banner ausgeblendet.

Dokumentierte Anmelde-Cookies: `session` (7 Tage), `lan_user` (30 Tage), `lan_state` (10 Minuten). Dazu kommen die Auswahl `adminEvent` im lokalen Speicher sowie geschlossene Durchsagen (`lan-dismissed`) im Sitzungsspeicher. Cookie-Einstellungen gelten unverändert; insbesondere HttpOnly, SameSite und Secure bei HTTPS.

**Keine allgemeine Consent-Management-Plattform:** Werden später optionale Tracker, externe Einbettungen, Marketingdienste oder nicht notwendige Cookies ergänzt, müssen diese vor einer passenden Einwilligung tatsächlich blockiert werden. Auch eigene Nginx-Proxy-Manager-Erweiterungen gesondert prüfen. Keine rechtliche Aussage ableiten, dass jedes Browser-Speicherdetail in jedem Einsatz ohne Einwilligung zulässig ist.

## Ein optionales Sponsorenbild

Jeder Sponsor kann genau ein **lokales PNG** haben. Sponsor zuerst speichern (auch bei bestehenden Einträgen ohne ID aus älteren Versionen); danach unter dem Sponsor eine Datei auswählen. Der Upload speichert sofort und zeigt die gespeicherte Vorschau. Eine neue Datei ersetzt das vorherige Bild; **Bild entfernen** löscht nur das Bild. Diese Aktionen speichern keine anderen ungespeicherten Textänderungen. Der Website-Editor behält Entwürfe auch bei Live-Updates und Bildänderungen ohne Eingabefokus; zum Übernehmen fremder Änderungen ausdrücklich neu laden und etwaige Versionskonflikte abgleichen. Änderungen an Bildern veröffentlichter, sichtbarer Sponsoren sind sofort öffentlich. Ohne Bild bleiben Name, Beschreibung und Link erhalten.

Grenzen: **128 KiB**, maximal **2048 × 2048**, insgesamt höchstens **1.048.576 Pixel**; ausschließlich **8-Bit RGB/RGBA-PNG, nicht interlaced und nicht animiert**. Paletten-/Graustufenbilder, JPEG und SVG vorher passend exportieren. Die Oberfläche zeigt diese Grenzen; der Server prüft Base64, PNG-Signatur, Chunk-Reihenfolge/-Längen und CRCs, Header, vollständigen Zlib-Datenstrom sowie Zeilenlängen und Filterbytes. Dekomprimierung ist auf die erwartete Pixelmenge begrenzt. Ancillary-Metadaten werden entfernt. Es gibt keine Dateinamen-/Pfadparameter und keine externen Bild-URLs.

Bilder liegen zusammen mit einer zufälligen stabilen Sponsor-ID in `db.meta.website` in SQLite und sind damit Bestandteil des bestehenden Backups. Neuordnen und Textänderungen behalten die Zuordnung. Jede Ersetzung erhält eine neue Bild-ID; die alte URL funktioniert nicht mehr. Entfernen des Sponsors löscht auch seine Bildzuordnung. Die öffentliche Darstellung verwendet lokale URLs, Namens-Alternativtext und proportionale responsive Bilder; Bilddaten werden nicht im Website-JSON ausgeliefert.

Bild-API: nur Admins `PUT /api/website/sponsors/:id/image` mit `{ version, data }` (reines Base64), `DELETE` derselben URL mit `{ version }`. Beide unterliegen Origin-/CSRF-Schutz, erneuter Admin-Prüfung nach dem Upload und derselben Versionskontrolle wie Textänderungen. `GET /api/website/sponsor-images/:imageId` liefert `image/png`, `nosniff`, `no-store`; unveröffentlichte/ausgeblendete Bilder sind nur für angemeldete Admins erreichbar. Bei Versionskonflikten neu laden und Änderungen abgleichen.

Die Daten liegen in `db.meta.website` und werden mit der bestehenden Datenbank gesichert. API: öffentlich `GET /api/website`, nur Admins `GET/PUT /api/website/admin`. Schreiben unterliegt außerdem der bestehenden Origin-/CSRF-Prüfung. Unbekannte Felder werden nicht übernommen; Inhalte und Links werden serverseitig geprüft.
