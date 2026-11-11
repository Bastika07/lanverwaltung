# Rollout

Zwei Stufen auf demselben Docker-Host. Die Skripte liegen in [`ops/rollout/`](../ops/rollout/), installiert unter `/opt/lanverwaltung-autodeploy/` (root, `700`). Installationsspezifische Werte (Stack-Pfade, Container, Domains) stehen in `/etc/lanverwaltung-rollout.conf` (root, `600`, Vorlage: [`ops/rollout/rollout.conf.example`](../ops/rollout/rollout.conf.example)), nicht im Repo.

## Dev: automatisch

`deploy.sh` läuft per systemd-Timer (`lanverwaltung-autodeploy.timer`, alle 5 Minuten). Sobald alle GitHub-Workflows des neuesten `main`-Commits grün sind: Quellarchiv laden, Image `<DEV_IMAGE>:development-<commit>` bauen, isolierter Smoke-Test ohne Netzwerk, Sicherung, Austausch, Health-Prüfung, sonst automatischer Rollback. Protokoll: `journalctl -u lanverwaltung-autodeploy`.

## Produktion: per `promote.sh`

Die Produktion bekommt genau das Image, das auf Dev läuft und healthy ist, ohne Neubau.

```sh
promote.sh status             # Stand von Produktion und Dev, aktives Event, letzte Sicherung
promote.sh promote <commit>   # Dev-Image dieses Commits auf Produktion
promote.sh rollback           # zurück auf „Vorher:“ aus DEPLOYMENT.md (Datenbank bleibt)
```

`promote` bricht ab, solange ein Event aktiv ist, wenn der Commit nicht healthy auf Dev läuft oder bereits ein Rollout läuft; es wartet auf einen laufenden Dev-Rollout. Vorher wird in `<PROD_BACKUPS>/pre-revision-<commit>` gesichert (Datenbank mit Integritätsprüfung, Datenvolume, `compose.yaml`, `.env`, `DEPLOYMENT.md`). Danach müssen Container, Domain, Datenbank-Check und Datensatzanzahl stimmen, sonst wird automatisch zurückgerollt. Ergebnis und Rollback-Anleitung stehen in `DEPLOYMENT.md` im Stack-Verzeichnis. Protokoll: `journalctl -t lanverwaltung-promote`.

### Eingeschränkter Zugang

Für Rollouts (auch durch Agenten) einen eigenen SSH-Schlüssel verwenden, der nur `promote.sh` ausführen darf:

```sh
ssh-keygen -t ed25519 -f ~/.ssh/lanverwaltung-rollout -C rollout
```

In `/root/.ssh/authorized_keys` des Hosts (optional mit `from="<Netz>",` davor):

```text
restrict,command="/opt/lanverwaltung-autodeploy/promote.sh" ssh-ed25519 AAAA… rollout
```

`restrict` sperrt Terminal und Weiterleitungen; der beim Aufruf übergebene Befehl wird von `promote.sh` streng geprüft (`status`, `rollback`, `promote <7–40 Hex-Zeichen>`), alles andere wird abgelehnt.

```sh
ssh -i ~/.ssh/lanverwaltung-rollout root@<host> promote <commit>
```

Rollouts nicht während einer laufenden LAN; das Skript verweigert sie dann.
