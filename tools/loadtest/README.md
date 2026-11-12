# Lasttest Orchestrator (Control-Plane)

Legt viele gespeicherte Workflows an und belastet die API mit parallelen Operatoren, Lese-Clients und SSE-Streams.
Nur Python-Standardbibliothek. Läuft gegen den laufenden Dev-Orchestrator (`make start`).

```
python3 setup.py 149      # 149 gestoppte Workflows à 8 Rollen + 1 echter Workflow (ein omp-source), Test-Benutzer mit Workflow-Bindung
nice python3 run.py 20    # 20 s Last: 20 Operatoren (PATCH-Parameter), 5x /me/consoles, je 3x /workflows, /nodes, /graph, 40 SSE-Clients
python3 cleanup.py        # alles wieder entfernen
```

Umgebung: `OMP_URL` (Standard `http://localhost:8000`), `OMP_ADMIN_USER`/`OMP_ADMIN_PASSWORD` (Standard Dev-Login), `OMP_PID_FILE`.

Hinweis: Das Lastskript läuft auf derselben Maschine und verbraucht selbst CPU; die Zahlen sind relative Vergleichswerte (vorher/nachher), keine Kapazitätsgarantie.

## Medienpfad und schneller Generator (2026-11-12)

```
nice python3 media.py setup          # omp-source -> omp-viewer (echter Workflow "loadtest-media")
nice python3 setup.py 149            # Workflows + Testbenutzer für gen.go
go build -o /tmp/gen gen.go && nice /tmp/gen -d 15s -n 100 -tiles 4   # N Bediener + N SSE + 4 Vorschau-Kacheln je Client
nice python3 media.py cleanup; python3 cleanup.py
```

`run.py`/`media.py` (Python, GIL) sind ab ~100 Clients selbst der Engpass; für belastbare Zahlen `gen.go` nehmen.
