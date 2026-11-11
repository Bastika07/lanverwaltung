# Domain-Doku

Deutsche Fassung von [domain.md](domain.md). Maßgeblich für die Agent-Skills ist die englische Datei; bei Änderungen beide anpassen.

## Vor dem Erkunden lesen

- **`GLOSSARY.md`** im Repo-Root (Fachbegriffe des Projekts).
- **`docs/adr/`**: Architekturentscheidungen (ADRs) zum betroffenen Bereich.

Fehlen diese Dateien, **ohne Hinweis weitermachen**. Sie werden erst angelegt, wenn Begriffe oder Entscheidungen tatsächlich geklärt werden (über `/domain-modeling`, `/grill-with-docs` oder `/improve-codebase-architecture`).

## Aufbau (single-context)

```
/
├── GLOSSARY.md
├── docs/adr/
│   └── 0001-<entscheidung>.md
└── lib/, public/, …
```

## Begriffe des Glossars verwenden

Fachbegriffe in Issues, Refactoring-Vorschlägen, Hypothesen und Testnamen so verwenden, wie `GLOSSARY.md` sie definiert. Fehlt ein Begriff, ist das ein Signal: entweder neue Sprache erfunden (überdenken) oder eine echte Lücke (für `/domain-modeling` notieren).

## ADR-Konflikte kennzeichnen

Widerspricht ein Vorschlag einem ADR, das ausdrücklich sagen statt es stillschweigend zu übergehen:

> _Widerspricht ADR-0007, sollte aber neu bewertet werden, weil …_
