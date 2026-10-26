# Website-Module

Unter **Admin → Website & Rechtliches** stehen sechs einzeln schaltbare Module bereit:

- Impressum, Datenschutzerklärung, AGB und Verhaltenskodex: öffentliche Textseiten mit Footer-Link und Änderungsdatum.
- Cookie-Banner: schließbarer Hinweis und eine Detailseite zu den tatsächlich verwendeten Cookies/Browserspeichern.
- Sponsoren: Einleitung und bis zu 40 Einträge mit Name, Kategorie, Beschreibung und optionalem HTTPS-Link, auf Startseite und eigener Seite. Reihenfolge und Sichtbarkeit je Sponsor sind bearbeitbar.

Alle Inhalte gelten **websiteweit**, unabhängig vom ausgewählten Event und dessen Zugangsbeschränkungen. Zu Beginn sind alle Module ausgeschaltet, Texte leer und nur ein technischer Cookie-Hinweis vorbelegt. Es werden keine Namen/Adressen erfunden oder pauschalen Rechtstexte veröffentlicht. Erst prüfen, ausfüllen und gezielt aktivieren. Eine deaktivierte Seite ist nur im Admin-API sichtbar; sie ist kein öffentlicher Entwurf. Das Modul ersetzt nicht die Verantwortung, erforderliche Rechtstexte bereitzustellen.

Speichern ersetzt die komplette Website-Konfiguration. Eine Versionsprüfung verhindert das Überschreiben zwischen zwei Admin-Tabs; bei Konflikt den eigenen Text extern sichern, neu laden und abgleichen. Textfelder unterstützen Klartext mit Absätzen, kein HTML, JavaScript oder eingebettete Medien. Vorschauen verwenden dieselbe sichere Textdarstellung. Externe Sponsorenbilder werden nicht geladen; Links öffnen erst nach einem Klick mit `noreferrer` und `rel=sponsored`. Entwürfe können frei bearbeitet werden; bei veröffentlichten Modulen werden gespeicherte Änderungen sofort öffentlich. Es gibt keine getrennte Entwurfsfassung einer bereits veröffentlichten Seite.

Veröffentlichte Datenschutz-, AGB- und Verhaltenskodex-Seiten werden zusätzlich am Profil-/Bestellformular verlinkt. **AGB/Verhaltenskodex sind Informationsseiten:** Eine beweissichere Zustimmung beim Bestellen, Vertragsversionen und Widerrufsbelehrungen sind nicht implementiert. Ob und wie dies für die Veranstaltung erforderlich ist, muss die Orga prüfen. Der bisherige kurze Datenschutzhinweis bei der Registrierung bleibt unabhängig davon erhalten und sollte inhaltlich zur veröffentlichten Erklärung passen.

## Cookie-Hinweis statt Schein-Einwilligung

Die Anwendung lädt derzeit keine optionalen Analyse-/Marketingdienste. Daher gibt es kein „Alle akzeptieren“ und keine vorgetäuschten Kategorien. Das Banner blockiert keine Inhalte; Impressum und Datenschutz bleiben bedienbar. „Hinweis schließen“ wird in `sessionStorage` als `lan-cookie-notice` für die aktuelle Tab-Sitzung gespeichert. Änderungen am Hinweis oder veröffentlichten Datenschutztext zeigen ihn erneut. Der Footer-Link öffnet eine Detailseite; dort lässt sich der Hinweis erneut anzeigen. Bei gesperrtem Browserspeicher lässt er sich trotzdem schließen, erscheint aber nach Neuladen wieder. Im Beamerbetrieb wird das Banner ausgeblendet.

Dokumentierte Anmelde-Cookies: `session` (7 Tage), `lan_user` (30 Tage), `lan_state` (10 Minuten). Dazu kommen die Auswahl `adminEvent` im lokalen Speicher sowie geschlossene Durchsagen (`lan-dismissed`) im Sitzungsspeicher. Cookie-Einstellungen gelten unverändert; insbesondere HttpOnly, SameSite und Secure bei HTTPS.

**Keine allgemeine Consent-Management-Plattform:** Werden später optionale Tracker, externe Einbettungen, Marketingdienste oder nicht notwendige Cookies ergänzt, müssen diese vor einer passenden Einwilligung tatsächlich blockiert werden. Auch eigene Nginx-Proxy-Manager-Erweiterungen gesondert prüfen. Keine rechtliche Aussage ableiten, dass jedes Browser-Speicherdetail in jedem Einsatz ohne Einwilligung zulässig ist.

Die Daten liegen in `db.meta.website` und werden mit der bestehenden Datenbank gesichert. API: öffentlich `GET /api/website`, nur Admins `GET/PUT /api/website/admin`. Schreiben unterliegt außerdem der bestehenden Origin-/CSRF-Prüfung. Unbekannte Felder werden nicht übernommen; Inhalte und Links werden serverseitig geprüft.
