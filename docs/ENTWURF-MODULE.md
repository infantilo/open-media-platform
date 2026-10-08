# Entwurf: Orchestrator-Module (Kapitel 36.1 — Inventur und Schnittstelle)

Stand 2026-10-09. Grundlage für `UMSETZUNG.md` Kapitel 36 und `ARCHITECTURE.md` §28. Dieser Entwurf ist das Ergebnis der
Inventur am Code (nicht geschätzt) und wartet auf Review durch den Nutzer, bevor 36.2 beginnt.

## 1. Methode und Absicherung

- `orchestrator/cmd/routetable` liest per AST alle `mux.HandleFunc`/`mux.Handle`-Registrierungen und gibt je Route Methode,
  Pfad, Rechtepflicht, Registrierungsbedingung und Domäne aus. Die Tabelle ist als **Golden-Datei**
  (`cmd/routetable/testdata/routes.golden.json`, 240 Routen) eingefroren; `go test ./cmd/routetable` schlägt bei jeder
  Abweichung an (Gegenprobe gemacht: eine geänderte Rechtepflicht wird gemeldet). Beim Umzug in Module muss sie **identisch**
  bleiben. Eine absichtliche neue Route aktualisiert die Datei (Befehl im Testkopf).
- Die Fundstelle (Datei/Zeile) gehört nicht zum Vergleich: ein Umzug verschiebt Code, nicht Verhalten.

## 2. Inventur je Domäne

| | Playout | Audio-Ausgabe (Audio-Regeln) | Cloud |
|---|---|---|---|
| **Routen** | 18 (`/api/v1/playout/…`): Channels, Zustand/Ausführungen, Trigger + Regeln, As-Run, Preflight/Materialize | 4 (`/api/v1/audio-rules…`) | 13 (`/api/v1/cloud/…`) |
| **Registrierung** | bedingt (`options.playout != nil`, plus `asrun`/`preflight`/`triggerRouter`) | immer | **immer** (Handler antworten ohne Anbieter mit `configured:false`/503) |
| **Rechte** | `auth`, `verb:Configure`, `verb:View`; zusätzlich Instanz-/Rollenprüfung im Handler (`FindRoleForInstance` aus `workflows`) | `auth`, `verb:Admin` | `auth`, `verb:Admin` |
| **Go-Pakete** | `playout`, `channeltrigger`, `asrun`, `materialize` (rund 2.250 Zeilen) | — (nur Handler, 430 Zeilen + eingebettetes Standarddokument) | `cloud` (rund 2.540 Zeilen) + `cloud_setup.go` |
| **Handler** | `playout_handlers`, `channel_trigger_handlers`, `asrun_handlers`, `preflight_handlers` (rund 780 Zeilen) | `audio_rules_handlers` | `cloud_handlers` (rund 330 Zeilen) |
| **Tabellen** | `playout_channels`, `playout_state`, `playout_executions`, `channel_triggers`, `channel_trigger_rules`, `playout_asrun` (Migrationen 0032, 0033, 0037, 0038) | keine eigene — Schlüssel `audio-rules` im generischen `NodeSettingsStore` | `cloud_reservations`, `cloud_policies`, `cloud_hosts` (0039, 0040) |
| **Hintergrundjobs** | `channeltrigger.Router.Run` (leader-gegated), As-Run-Aufbewahrung (Prune) | — | Pool-Controller (leader-gegated) |
| **Metriken/Alarme** | `asrun.Metrics` fließt in `GET /metrics` | — | — (Aktionsprotokoll nur in der API) |
| **Process-Engine** | Schritt `materialize` (`processEngine.Register`, bereits generisch) | — | — |
| **UI** | `playout-admin-view.ts` (+Logik, 545 Zeilen), statischer Import in `admin-view.ts`, Admin-Untertab | `audio-rules-view.ts` (+Logik, 754 Zeilen), statischer Import in `admin-view.ts` | `cloud-view.ts` (+Logik, 508 Zeilen), statischer Import in `app-shell.ts`, eigener Tab |
| **Fremde Verbraucher** | **Node `omp-playout-automation`** ruft die Playout-Endpunkte (Zustand/Ausführungen) → stabiler API-Vertrag nötig | die Nodes lesen das Dokument indirekt; Orchestrator führt `audio-sim` (Rust) per `os/exec` aus | — |
| **Was es vom Kern braucht** | Authz-Prüfung, Domain-Audit, NATS (`nc`), `workflows.Service` (Rollenauflösung), Process-Engine, Asset-Store, Objekt-Backends, DB | NodeSettingsStore, Launcher (Binärsuche) | Hosts-Store, Host-Metriken, Launcher (Instanzzahl), Placement (Draining), Bootstrap-Token, Cluster-Leader, Domain-Audit, DB |

Zusätzlich gehören zur Playout-Fachlichkeit im Kern (nicht in den obigen Paketen):
`workflows/autotargets.go` (leitet Automations-Ziele aus Rollen ab, kennt `omp-playout-automation` und die Player-/Mischer-Typen)
und `workflows/service.go` (`controlPlaneNodeTypes`, hartkodiert; wird auch von `handlePostInstance` genutzt).

## 3. Korrektur gegenüber dem ersten Befund

Im Gespräch und in `ARCHITECTURE.md` §28.1 stand, die **Autorisierung** habe eine Playout-Rollenbindung (Migration `0033`). Das
stimmt **nicht**: `0033` fügt nur `playout_channels.workflow_id/role` hinzu (ein Channel hängt an einer Workflow-Rolle statt
an einer flüchtigen Instanz-ID). Das Paket `authz` kennt kein Playout. Die Handler benutzen lediglich die Rechte-Helfer des
Kerns und die Rollenauflösung von `workflows`.

Folge: Der geplante Schritt „generische Rechtebindung (Objekttyp + ID)“ (36.4) ist **nicht nötig**. Stattdessen müssen die
Rechte-Helfer (`requireAuth`, `requireVerbGlobal`, die Instanz-/Rollenprüfung) Teil der Modul-Abhängigkeiten sein. 36.4 wird
entsprechend ersetzt (s. `UMSETZUNG.md`).

## 4. Schnittstelle (Skizze für 36.2)

```go
// Package module: Domänenfunktionen, die sich am Orchestrator-Kern anmelden.
type Module interface {
    Name() string                                  // eindeutig, z. B. "cloud"
    Migrations() []Migration                       // eigene, nummerierte SQL-Schritte (Stand in module_migrations)
    Mount(r Routes, d Deps) error                  // Routen anmelden (mit den Rechte-Helfern aus Deps)
    Start(ctx context.Context, d Deps) error       // Hintergrundjobs; vom Kern leader-gegated aufgerufen
    UI() []UITab                                   // Tabs/Admin-Untertabs samt Bundle-URL und Beschriftungs-Schlüsseln
}

type Routes interface {
    Handle(pattern string, auth Auth, h http.HandlerFunc)   // Auth: Anonymous | Authenticated | Verb(v) | VerbOnNode(v)
}

type Deps struct {           // nur das, was Module wirklich brauchen — kein Durchreichen von handlerOptions
    DB         *sql.DB
    Audit      DomainAudit            // Log(actor, objectType, objectID, action, details)
    Events     EventBus               // NATS-Veröffentlichung/Abonnement
    Settings   NodeSettings           // generischer Schlüssel/Wert-Speicher
    Authz      Authorizer             // Verb-Prüfung global/auf Node/Rolle
    Hosts      HostDirectory          // Hosts, Metriken, Draining
    Instances  InstanceDirectory      // Launcher: Instanzen/Zählung/Rollen
    Process    StepRegistry           // Process-Schritte registrieren (heute schon vorhanden)
    Metrics    MetricSources          // Module liefern Quellen für /metrics
    LeaderOnly func(ctx, fn)          // wie runWhileLeader
}
```

Die Registry bietet: doppelte Namen ablehnen, Module in fester Reihenfolge laden, ein Modul per Konfiguration abschalten
(`OMP_MODULES_DISABLE=cloud,playout`), und den Start nicht still scheitern lassen (fehlerhaftes Modul → deutliche Meldung,
Kern läuft weiter).

## 5. Entscheidungen des Nutzers (2026-10-09)

1. **404** für ein deaktiviertes Modul, der Tab fehlt. 2. Kernmigrationen `0032…0040` bleiben unangetastet im Kern, neue Modulmigrationen im Modul. 3. Automations-Ziele über einen **Hook** „Start-Umgebung einer Rolle ergänzen“ (36.5).

Ursprüngliche Fragen (zur Nachvollziehbarkeit):

1. **Abschalten:** Soll ein deaktiviertes Modul **keine** Routen registrieren (heute bei Playout so, bei Cloud antworten die
   Routen mit „nicht konfiguriert“) — oder soll die Schnittstelle bewusst 404 liefern? Vorschlag: einheitlich 404 und der Tab
   fehlt; der Golden-Vergleich läuft mit allen Modulen eingeschaltet.
2. **Migrationen:** Bestehende Kernmigrationen `0032…0040` bleiben unangetastet im Kern-Verlauf (bereits angewendet). Neue
   Migrationen der Module liegen im Modul. Einverstanden?
3. **Automations-Ziele (36.5):** `autotargets.go` leitet Ziele aus **Rollen-Node-Typen** ab (Kanal-Player, Mischer, Grafik).
   Das ist Playout-Wissen in `workflows`. Vorschlag: der Katalogeintrag trägt Rollen-Hinweise („Automations-Ziel: Kanal-Player“),
   `workflows` liest nur diese. Alternative: die Ableitung wandert ins Playout-Modul und `workflows` bietet einen Hook
   „Start-Umgebung einer Rolle ergänzen“. Mein Vorschlag ist der Hook, weil er `workflows` ganz ohne Playout-Begriffe lässt.
4. **Stufe 2** bleibt offen (Entscheidung nach dem Pilot 36.6).

## 6. Oberfläche der Module (36.3, umgesetzt)

- **Manifest:** `GET /api/v1/modules` liefert je Modul `state` (mounted/disabled/failed) und — nur für gemountete Module — die
  UI-Einträge (`placement`, `after`, `label` je Sprache, `element`, `bundle`). Die Shell kennt kein Modul beim Namen.
- **Bundles:** Jedes Modul hat ein eigenständiges ESM-Bundle (`ui/modules/<name>/index.ts` → `ui/dist/modules/<name>.js`, gebaut
  von `make ui`). Es registriert sein Custom Element und meldet seine Texte über `addMessages` an.
- **Host-Schnittstelle:** Sprache/Wörterbuch, Verbindungsüberwachung (`apiFetch`), Anmeldung (`whoami`) und Toasts sind
  Singletons der Shell. Sie liegen unter `globalThis.__omp`; Module greifen über `ui/modules/host.ts` darauf zu und bündeln
  keine zweite Kopie.
- **Fehlerverhalten:** Lädt ein Bundle nicht, zeigt nur dessen Tab eine Fehlermeldung; ein abgeschaltetes Modul hat keinen Tab.
- **Noch offen:** Admin-Untertabs (`placement: "admin:<gruppe>"`) — kommen mit dem ersten Modul, das sie braucht (Audio-Ausgabe, 36.7).
