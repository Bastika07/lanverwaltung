# Sicherheitsbetrieb

Dokumentierte Eigenprüfung mit Umfang, Befunden, Nachtests und offenen Grenzen: [security-assessment.md](security-assessment.md). Wiederholbare isolierte Prüfungen und Scannerbefehle stehen dort; niemals die öffentlichen Domains oder Produktionsdaten als Fuzzing-Ziel verwenden.

## Reverse Proxy und Firewall

`TRUST_PROXY=1` allein vertraut keinen Forwarded-Headern mehr. `TRUSTED_PROXIES` enthält die tatsächlich am Container ankommenden Proxy-IP-Adressen oder enge CIDR-Netze (kommagetrennt, IPv4/IPv6). Nicht die öffentlichen Client-IP-Adressen eintragen. Der Proxy muss Host/Proto überschreiben und die echte Client-IP als letzten X-Forwarded-For-Hop setzen; keine ungeprüften Clientheader durchreichen.

Bei fest konfigurierter HTTPS-`PUBLIC_URL` gelten Anfragen des zugelassenen Proxys immer als extern HTTPS: Secure-Cookies und HSTS können nicht durch ein weitergereichtes `X-Forwarded-Proto: http` abgeschaltet werden. Das ersetzt nicht die korrekte Headerbereinigung im Proxy; insbesondere muss X-Forwarded-For zuverlässig die tatsächliche Client-IP enthalten.

Beispiel für einen **externen** Proxy (Adressen ersetzen):

```dotenv
BIND_ADDRESS=192.0.2.10
TRUST_PROXY=1
TRUSTED_PROXIES=192.0.2.20
PROXY_ONLY=1
PUBLIC_URL=https://lan.example.org
```

Bei lokalem Proxy auf dem Host standardmäßig nur an Loopback binden; die tatsächliche Container-Peer-IP prüfen und eng zulassen. `PROXY_ONLY=1` sperrt alle nicht freigegebenen Peers unabhängig von deren Forwarded-Headern. Nur `GET /api/health` auf Container-Loopback bleibt für den internen Healthcheck erreichbar. Ohne Proxy die drei Proxy-Optionen ausschalten. Neue Compose-Installationen veröffentlichen den Port standardmäßig nur auf `127.0.0.1`; direkter LAN-Betrieb erfordert eine bewusste Bind-Adresse.

Zusätzlich Port 3000 am Host **vor der Docker-DNAT-Regel** für andere Quellen sperren. Eine reine INPUT-Regel schützt Docker-Portfreigaben nicht zuverlässig. Beispiel einer separaten nftables-Tabelle, ohne andere Firewallregeln zu überschreiben:

```nft
table inet seniorenlan_backend {
  chain prerouting {
    type filter hook prerouting priority -110; policy accept;
    ip daddr 192.0.2.10 tcp dport 3000 ip saddr 192.0.2.20 counter accept
    ip daddr 192.0.2.10 tcp dport 3000 counter drop
  }
}
```

Nur die konkrete Backend-IP und den konkreten Port bearbeiten. IPv6 nicht offen veröffentlichen; bei IPv6-Betrieb entsprechende IPv6-Regeln ergänzen. Die Regeldatei in die bestehende persistente Firewallkonfiguration einbinden. **Nicht pauschal `flush ruleset`/nftables neu laden**, weil das Docker-Regeln entfernen kann. Änderungen mit vorbereitetem Rückweg durchführen: SSH erhalten, HTTPS-Gesundheitsprüfung über den echten Proxy erfolgreich, direkter Backendzugriff gesperrt. Interne Docker-Netzzugriffe werden zusätzlich durch `PROXY_ONLY` abgewiesen.

## Nginx Proxy Manager (NPM)

Für diese Installation: Proxy Host `lanverwaltung.familie-luebke.com`, Forward Scheme **http**, Host **10.99.254.6**, Port **3000**. SSL-Zertifikat wählen und **Force SSL** aktivieren. Die tatsächliche Quell-IP muss weiterhin **10.12.254.12** sein; die Backend-Zuliste nicht auf das ganze LAN erweitern. SSE benötigt kein WebSocket-Upgrade; die Anwendung setzt für den Eventstream `X-Accel-Buffering: no`.

Beim Live-Test wurde `X-Forwarded-Proto: http` vom Client durchgereicht. Die App verhindert bereits das Herabsetzen von Secure/HSTS durch die kanonische HTTPS-`PUBLIC_URL`. Ohne Zugang zum NPM wurde dessen Konfiguration **nicht** geändert.

In NPM zunächst die Version und die effektiv generierte Konfiguration (`nginx -T` im NPM-Container) prüfen, insbesondere den `location /` des betroffenen Proxy Hosts und etwaige Custom Locations. Client-supplied Header müssen dort durch vom Proxy bestimmte Werte ersetzt werden. Der gewünschte Zustand **innerhalb der wirksamen Proxy-Location** ist:

```nginx
proxy_set_header Host $host;
proxy_set_header X-Forwarded-Host $host;
proxy_set_header X-Forwarded-Proto $scheme;
proxy_set_header X-Forwarded-Scheme $scheme;
proxy_set_header X-Real-IP $remote_addr;
proxy_set_header X-Forwarded-For $remote_addr;
```

Bei direkt am Internet/LAN erreichbarem NPM ist `$remote_addr` die richtige Clientquelle. Bei einem weiteren vorgeschalteten Proxy erst eine enge Real-IP-Vertrauenskette einrichten; nicht ungeprüft dessen Clientheader vertrauen. **Nicht blind im Advanced-Tab zusätzlich einfügen:** NPM-Versionen/Custom Locations erzeugen bereits eigene `proxy_set_header`-Direktiven. Nginx vererbt diese blockweise; doppelte Direktiven oder wirkungslose Server-Level-Einträge vermeiden. Die tatsächlich erzeugte Location muss pro Header genau den beabsichtigten Wert senden. Änderungen am generierten Container-Dateisystem sind bei NPM-Neugenerierung nicht dauerhaft; eine zur installierten NPM-Version passende Konfiguration nutzen, vorher sichern und mit `nginx -t` prüfen.

Referenzvorlagen (versionsabhängig): [NPM Proxy-Include](https://github.com/NginxProxyManager/nginx-proxy-manager/blob/develop/docker/rootfs/etc/nginx/conf.d/include/proxy.conf), [NPM Custom Location](https://github.com/NginxProxyManager/nginx-proxy-manager/blob/develop/backend/templates/_location.conf).

Nach Anpassung über HTTPS mit gefälschten `X-Forwarded-Proto`, `X-Forwarded-Host` und `X-Forwarded-For` testen: OAuth bleibt auf der richtigen Domain, Anmelde-Cookies bleiben Secure und HSTS aktiv. Die Headerbereinigung selbst ist am effektiven NPM-Upstream zu prüfen, da die App-Mitigation den ursprünglichen Fehler bei HTTPS sonst verdecken kann. Keine zusätzlichen Produktions-IP-Logs aktivieren, um diesen Test durchzuführen.

## Kontolöschung und Aufbewahrung

Eine vom angemeldeten Nutzer ausgelöste Kontolöschung führt synchron aus:

- Konto/Profil einschließlich Discord-E-Mail und alle Besuchersitzungen entfernen; etwaige Discord-Admin-Sitzungen widerrufen.
- Nur die **tatsächlich per Discord-ID verknüpfte Person** pseudonymisieren: zufälliger Name statt Klarname, Discord, Steam, Clan und interne Notiz leeren. Keine Namensheuristik auf fremde Personen anwenden.
- Eigenen Ticketinhabernamen und Einzelturnier-Anzeigenamen dieser Person ersetzen; feste Personen-IDs, Ergebnisse und bezahlte Eintrittscodes erhalten.
- Käuferbezüge entfernen, offene Bestellungen stornieren. Bezahlte Tickets anderer Inhaber bleiben gültig und unverändert; neue Logins desselben Discord-Kontos erhalten keinen Zugriff auf alte Bestellungen.
- Gastserver vom Konto trennen und sperren. IP/FQDN bleiben für die Orga erhalten, damit vorhandene DNS-Einträge kontrolliert zurückgenommen werden können. Sperren im System entfernt keine externen DNS-Einträge.

Das ist **Pseudonymisierung, keine vollständige Anonymisierung**: Personen-IDs, Eintrittscodes und bisherige Außenkontakte können eine Wiedererkennung ermöglichen. Es erfolgt weder eine automatische Löschung bestehender Konten noch eine rückwirkende, unsichere Zuordnung früher gelöschter Käufer. Ticketinhaber ohne verifiziertes Personenprofil können nicht sicher dem gelöschten Käufer zugeordnet werden; solche Löschanfragen muss die Orga separat prüfen. Freitexte, Teamnamen, alte Logs, Exporte, externe Discord-Kanalnamen/-Nachrichten und Backups können personenbezogene Angaben enthalten und benötigen einen gesonderten Prozess. Der lokale Discord-Kanalcache wird mit dem Einzelspielernamen umgeschlüsselt; die tatsächlichen externen Kanäle aktualisiert erst der nächste Discord-Abgleich oder die Orga.

**Vor Festlegung automatischer Fristen entscheiden:** Welche Abrechnungs-/Nachweisdaten sind für welche Dauer erforderlich? Wer prüft Löschanfragen zu Ticketinhabern? Wie lange werden Backups, Exporte und Discord-Nachrichten benötigt? Die Anwendung erfindet keine gesetzlichen Fristen und löscht keine Bestände ohne Freigabe. Aufbewahrungszwecke, Verantwortliche und konkrete Fristen schriftlich dokumentieren; abgelaufene Sicherungen kontrolliert entfernen. Bei Wiederherstellung eines älteren Backups müssen spätere Löschanfragen erneut berücksichtigt werden. Bezahlte Tickets vor einer Löschung extern sichern, da der Kontozugang zu ihnen entfällt.

Sicherheitslogs enthalten künftig keine Roh-IPs, Discord-IDs, Ticketcodes, Namen oder beliebigen Freitexte. Quell-/Kontokorrelation verwendet einen zufälligen, pro Prozessstart erneuerten HMAC-Schlüssel. Auch Pseudonyme sind nicht pauschal anonym. Compose begrenzt neue JSON-Logs auf drei Dateien zu je 10 MB; das ist eine Größenbegrenzung, **keine zeitliche Löschfrist**. Frühere Journald-Protokolle bleiben bestehen und unterliegen der Host-Aufbewahrung.

## Images, Updates und CVE-Prüfung

Die Datenhaltung verwendet inzwischen SQLite. Für konsistente Online-Backups und Wiederherstellung siehe [sqlite.md](sqlite.md); eine laufende `db.sqlite` nicht ohne ihren WAL-Zustand per Dateikopie sichern.

Das Node-Basisimage ist per Digest fixiert. npm, Corepack und Yarn sind im Laufzeitimage entfernt, da es keine externen Anwendungsabhängigkeiten gibt. Lokal bleibt `npm test` möglich; im Container Tests mit `node --test` und schreibgeschütztem Testverzeichnis ausführen:

```sh
docker run --rm --network none --read-only --tmpfs /tmp \
  -v "$PWD/test:/app/test:ro" --entrypoint node turnierbaum:latest --test
sh ops/scan-image.sh turnierbaum:latest ./image-vulnerabilities.json
```

Der Scanner ist ebenfalls per Digest fixiert und bekommt **keinen Docker-Socket** und keine Daten-/Konfigurationsvolumes. Er exportiert nur das Image; bei HIGH/CRITICAL-Befunden liefert das Skript Exit-Code 1. Scanberichte geschützt ablegen, nicht ins öffentliche Repository übernehmen. Der Scanner benötigt Internet für die Schwachstellendatenbank. Regelmäßig, mindestens bei jedem Deployment, mit aktueller Datenbank scannen; hohe/kritische Befunde vor Freigabe bewerten.

Digest-Pinning verhindert unbeabsichtigte Änderungen, aber auch automatische Sicherheitsupdates. Verantwortlich mindestens wöchentlich und bei Node-/Alpine-Sicherheitsmeldungen neue Digests prüfen, bewusst aktualisieren, Tests/Scan durchführen und mit gesichertem vorherigem Image ausrollen. Keine automatischen Blind-Updates und keine Aussage „CVE-frei“ ohne Zeitpunkt, Scanner und Scanumfang. Diese Prüfung ersetzt keine Sicherheitsbewertung des Hosts, Proxys, Node-internen Bibliotheken oder der Hardwareintegration.
