# Issue-Tracker: GitHub

Deutsche Fassung von [issue-tracker.md](issue-tracker.md). Maßgeblich für die Agent-Skills ist die englische Datei; bei Änderungen beide anpassen.

Issues und Specs liegen als GitHub Issues in diesem Repo. Alle Vorgänge laufen über die `gh` CLI.

## Konventionen

- **Issue anlegen**: `gh issue create --title "..." --body "..."`. Mehrzeilige Texte per Heredoc.
- **Issue lesen**: `gh issue view <nummer> --json number,title,body,labels,comments`.
- **Issues auflisten**: `gh issue list --state open --json number,title,body,labels,comments` mit passenden `--label`- und `--state`-Filtern.
- **Unter-Issue anlegen**: `gh issue create --parent <eltern> ...` oder nachträglich `gh issue edit <eltern> --add-sub-issue <kind>` (`gh` ≥ 2.94). Ohne Unter-Issues `Part of #<eltern>` an den Anfang des Kind-Issues schreiben.
- **Kommentieren**: `gh issue comment <nummer> --body "..."`
- **Labels setzen/entfernen**: `gh issue edit <nummer> --add-label "..."` / `--remove-label "..."`
- **Schließen**: `gh issue close <nummer> --comment "..."`

Das Repo ergibt sich aus `git remote -v`; `gh` erkennt es im Klon automatisch.

## Pull Requests als Triage-Quelle

**PRs als Anfragequelle: nein.** (Auf `yes` in der englischen Datei setzen, wenn externe PRs als Feature-Anfragen gelten sollen; `/triage` liest diesen Schalter.)

## „Im Issue-Tracker veröffentlichen“

Ein GitHub Issue anlegen.

## „Das passende Ticket holen“

Wie unter **Issue lesen** beschrieben.

## Wayfinding

Für `/wayfinder`: Die **Karte** ist ein Issue mit Label `wayfinder:map`, die Tickets sind Unter-Issues mit Labels `wayfinder:<typ>` (`research`/`prototype`/`grilling`/`task`). Blockaden über GitHubs native Issue-Abhängigkeiten, ersatzweise eine Zeile `Blocked by: #<n>`. Details siehe englische Datei.
