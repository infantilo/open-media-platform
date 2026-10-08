# Ein Orchestrator-Modul schreiben

Domänenfunktionen (Playout, Audio-Ausgabe, Cloud, …) sind **Module**: Sie melden sich bei einer Registry im Orchestrator an, statt
dass der Kern sie beim Namen kennt (`ARCHITECTURE.md` §28, `docs/ENTWURF-MODULE.md`). Dieses Dokument zeigt, wie man eines schreibt.
Vorbilder im Repo: `internal/modules/cloud` (Routen, Hintergrundjob, Konfiguration), `internal/modules/audiorules` (kleines Modul mit
Admin-Untertab), `internal/modules/playout` (großes Modul mit eigenen Stores, Metriken und Beobachter).

## 1. Das Gerüst (Go)

```go
package mymodule

type Module struct{}

func (*Module) Name() string { return "mymodule" }           // [a-z0-9-], eindeutig; steht in OMP_MODULES_DISABLE

func (*Module) Mount(r module.Routes, d module.Deps) error {
    // Rechtepflicht je Route ausschreiben — nicht über Variablen (auch das Routentabellen-Werkzeug liest sie so)
    r.Handle("GET /api/v1/mymodule/items", module.Authenticated(), listItems(d.DB))
    r.Handle("POST /api/v1/mymodule/items", module.Verb(authz.VerbConfigure), createItem(d.DB, d.Audit))
    return nil
}
```

Anmelden: ein Eintrag in `registerModules` (`orchestrator/modules.go`). Ein Modul **weglassen** heißt, diese Zeile zu entfernen; **zur Laufzeit
abschalten** geht mit `OMP_MODULES_DISABLE=mymodule` (Routen antworten dann 404, der Tab fehlt, der Kern läuft unverändert).

Rechtepflicht: `module.Anonymous()` (nur für bewusst offene Endpunkte), `module.Authenticated()`, `module.Verb(v)` (global), `module.VerbOnNode(v)`.
Den angemeldeten Nutzer liefert `module.User(r)` / `module.Actor(r)`.

## 2. Optionale Fähigkeiten (implementieren, was man braucht)

| Schnittstelle | Zweck |
|---|---|
| `Migrator` (`Migrations() []Migration`) | eigene Tabellen; Versionen lückenlos ab 1, einmalig angewendet (`module_migrations`), nie nachträglich ändern |
| `Starter` (`Start(ctx, d) error`) | Hintergrundjobs; läuft **nur auf dem Raft-Leader** und wird bei Führungsverlust abgebrochen (`ctx`) |
| `UIProvider` (`UI() []UITab`) | Oberfläche: Tab der Hauptleiste (`placement: "main"`) oder Admin-Untertab (`"admin:<gruppe>"`) |
| `MetricsProvider` (`WriteMetrics(w)`) | Zeilen für `GET /metrics` |

Fehler im Modul sind **isoliert**: scheitert `Mount`/`Start`/die Migration (auch durch Panik), steht das Modul als `failed` in
`GET /api/v1/modules`, der Kern läuft weiter.

## 3. Was ein Modul vom Kern bekommt (`module.Deps`)

`DB`, `Audit` (Domänen-Audit), `Settings` (Schlüssel/Wert), `Actor`, `Hosts`, `HostMetrics`, `Instances`, `Placement`, `Hooks`.
Braucht ein Modul mehr, wächst `Deps` **nicht** um den halben Kern: Dienste, die nur dieses Modul braucht, übergibt `main.go` dem
Konstruktor (`playout.New(&Services{…})`), jeweils als schmale Schnittstelle im Modul.

**Beobachtungspunkte** statt Sonderfällen im Kern: `d.Hooks.OnNodeMethod(namen, fn)` ruft `fn` nach einem erfolgreichen
Methodenaufruf an einer Node (der Kern liest den Körper nur, wenn ein Beobachter den Namen kennt; ein Beobachter kann den Aufruf nie
beeinflussen). Der Workflow-Dienst hat `RegisterRoleEnvHook` und `RegisterControlPlaneType` (siehe `playout.Register`).

## 4. Oberfläche (TypeScript)

```
ui/modules/mymodule/
  index.ts          // import "./register.ts"; import "./my-view.ts";   — Reihenfolge wichtig
  register.ts       // addMessages("de", messages.de); addMessages("en", messages.en);
  messages.ts       // Texte des Moduls (nicht im Kern-Wörterbuch)
  my-view.ts        // Custom Element; importiert NUR aus "../host.ts" (t, apiFetch, whoami, showToast, confirmDialog, …)
  my-logic.ts, my-logic_test.ts, test-setup.ts
```

`make ui` bündelt jedes `ui/modules/*/index.ts` zu `ui/dist/modules/<name>.js`. Das Go-Modul nennt es im Manifest
(`UITab{Element: "omp-my-view", Bundle: "/dist/modules/mymodule.js", Label: {de, en}, After: "hosts"}`); die Shell lädt es dynamisch.
`host.ts` greift auf die Singletons der Shell (`globalThis.__omp`) zu — ein Bundle bündelt **keine** zweite Kopie von Sprache oder
Verbindungsüberwachung. Tests: `test-setup.ts` ruft `installHost(messages)` aus `ui/modules/testing.ts` und wird **zuerst** importiert
(manche Logik übersetzt schon beim Laden).

## 5. Absicherung beim Umzug / bei neuen Routen

`go test ./cmd/routetable` vergleicht alle Routen (Methode, Pfad, Rechtepflicht, Domäne) gegen
`cmd/routetable/testdata/routes.golden.json`. Eine **absichtlich** neue Route aktualisiert die Datei:

```
cd orchestrator && go run ./cmd/routetable -strip-source > cmd/routetable/testdata/routes.golden.json
```

Beim Verschieben bestehender Funktionen muss die Tabelle **unverändert** bleiben — das ist der Nachweis „kein Verhaltensunterschied“.
Außerdem prüfen: `go list -deps ./internal/httpapi | grep modules` darf nichts liefern (der Kern kennt keine Module).

## 6. Grenzen (Stufe 1)

Module laufen im selben Prozess und derselben Datenbank wie der Orchestrator; es gibt kein Laden zur Laufzeit (Go kann das nicht
brauchbar). Eigenständige Dienste hinter `/api/v1/ext/<name>` (Stufe 2) sind bewusst **nicht** gebaut — Kriterien in `ARCHITECTURE.md` §28.2.
