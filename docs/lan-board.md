# LAN-Board

Statusanzeige der Gameserver im Terminal, im Stil von `btop`: je Server Karte, Spieler/Slots, Ping und online/offline, dazu CPU, RAM, Netz und Laufzeit des Containers sowie die Last des Proxmox-Hosts. Läuft im LAN, z. B. auf dem Rechner mit AMP oder TMT2. Nur Node-Bordmittel ([agent/lan-board.js](../agent/lan-board.js)), Node ≥ 22.

```text
╭─ Warserver #1 ─── 192.0.2.22:27015 ─╮
│ ● online  Counter-Strike 2          │
│ Karte   de_dust2                    │
│ Spieler ■■■■■■■■■■■■■■■■■■■■■■ 8/12 │
│ Ping    1 ms                        │
│ CPU     ■■■■■■■■■■■■■■■■■■■■■■  45% │
│ RAM     ■■■■■■■■■■■■■■■■■ 2.0G/3.0G │
│ Netz    ↓ 121K/s     ↑ 4.5K/s       │
│ Läuft   3h 25m  CT 101 running      │
╰─────────────────────────────────────╯
```

## Datenquellen

- **Spiel:** Steam-Abfrage `A2S_INFO` per UDP an den Query-Port (CS2: Spielport, Mordhau: `-QueryPort`, bei AMP meist 27015). Keine Zugangsdaten. Text vom Gameserver wird von Steuerzeichen bereinigt, bevor er ins Terminal geht.
- **Ressourcen (optional):** Proxmox-API `/cluster/resources` mit einem **Nur-Lese-Token**. Proxmox aktualisiert die Werte etwa alle 10 Sekunden; die Netz-Raten erscheinen nach der zweiten Messung.

## Proxmox-Token (nur lesen)

Auf dem Proxmox-Host als root. Bei einem Token mit Rechtetrennung (`--privsep 1`) gilt die Schnittmenge aus Benutzer- und Token-Rechten, deshalb bekommen **beide** die Rolle `PVEAuditor`:

```sh
pveum user add lanboard@pve --comment "LAN-Board, nur lesen"
pveum user token add lanboard@pve board --privsep 1   # Wert wird nur einmal angezeigt
for path in /vms /nodes/<node>; do
  pveum acl modify $path --users lanboard@pve --roles PVEAuditor
  pveum acl modify $path --tokens 'lanboard@pve!board' --roles PVEAuditor
done
```

Den Token-Wert auf dem Board-Rechner in `/etc/lan-board/pve-token` ablegen (root, `600`), dazu die Proxmox-CA `/etc/pve/pve-root-ca.pem` als `/etc/lan-board/pve-root-ca.pem`. Das Zertifikat wird damit normal geprüft; die IP des Hosts muss im Zertifikat stehen (Standard bei Proxmox).

## Konfiguration

`/etc/lan-board.json` (oder `--config <datei>` bzw. `LAN_BOARD_CONFIG`):

```json
{
  "interval": 2,
  "proxmox": {
    "url": "https://192.0.2.20:8006",
    "tokenId": "lanboard@pve!board",
    "secretFile": "/etc/lan-board/pve-token",
    "caFile": "/etc/lan-board/pve-root-ca.pem"
  },
  "servers": [
    { "name": "Warserver #1", "host": "192.0.2.22", "port": 27015, "vmid": 101 },
    { "name": "Mordhau", "host": "192.0.2.27", "port": 27015, "vmid": 106 }
  ]
}
```

`vmid` verbindet einen Server mit seinem Container; ohne `vmid` oder ohne `proxmox` zeigt die Box nur den Spielstand.

## Start

```sh
node agent/lan-board.js            # Vollbild, Taste q beendet, r fragt sofort neu ab
node agent/lan-board.js --once     # ein Rahmen, ohne Terminal automatisch ohne Farben
NO_COLOR=1 node agent/lan-board.js # ohne Farben
```

Bequem als `/usr/local/bin/lan-board` mit `exec node /opt/lan-board/lan-board.js "$@"`. Das Layout passt sich der Fensterbreite an (eine Spalte je 38 Zeichen).
