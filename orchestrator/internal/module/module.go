// Package module ist die Erweiterungsschnittstelle des Orchestrators (ARCHITECTURE.md §28, UMSETZUNG.md Kapitel 36):
// Domänenfunktionen (Playout, Audio-Ausgabe, Cloud, …) sind Module, die sich bei einer Registry im Kern anmelden,
// statt von `httpapi/server.go` und `main.go` einzeln gekannt zu werden. Stufe 1: gleiche Prozess- und DB-Grenze.
//
// Ein Modul braucht nur [Module] (Name + Mount); alles Weitere sind optionale Schnittstellen ([Migrator], [Starter],
// [UIProvider], [MetricsProvider]) — ein Modul implementiert, was es braucht.
package module

import (
	"context"
	"database/sql"
	"errors"
	"io"
	"net/http"
	"time"

	"github.com/infantilo/openmediaplatform/orchestrator/internal/authz"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/hosts"
)

// Module ist die Mindestschnittstelle.
type Module interface {
	// Name ist eindeutig und stabil (Konfiguration `OMP_MODULES_DISABLE`, `module_migrations`, UI-Manifest).
	Name() string
	// Mount meldet die Routen des Moduls an. Ein Fehler markiert nur dieses Modul als fehlgeschlagen.
	Mount(r Routes, d Deps) error
}

// Migration ist ein SQL-Schritt eines Moduls. Versionen sind je Modul lückenlos ab 1 aufsteigend; ein angewendeter
// Schritt wird nie geändert (wie die Kernmigrationen).
type Migration struct {
	Version int
	Name    string
	SQL     string
}

// Migrator: das Modul hat eigene Tabellen. Die Registry wendet die Schritte einmalig an (Tabelle `module_migrations`).
type Migrator interface {
	Migrations() []Migration
}

// Starter: das Modul hat Hintergrundjobs. `Start` wird vom Kern **nur auf dem Raft-Leader** gerufen und mit dem
// Verlust der Führung abgebrochen (Kontext), wie `runWhileLeader`; es blockiert, bis der Kontext endet.
type Starter interface {
	Start(ctx context.Context, d Deps) error
}

// UITab beschreibt einen Eintrag der Shell, den das Modul beisteuert (Kapitel 36.3). Die Shell kennt das Modul nicht:
// sie liest die Tabs aus `GET /api/v1/modules`, lädt das ESM-Bundle und legt beim Aktivieren des Tabs das Custom Element an.
type UITab struct {
	// ID ist im Modul eindeutig.
	ID string `json:"id"`
	// Placement: "main" (Hauptleiste) oder "admin:<gruppe>" (Admin-Untertab, ab 36.7).
	Placement string `json:"placement"`
	// After: ID eines vorhandenen Tabs, hinter den der neue gehört (leer = ans Ende, vor „Administration“).
	After string `json:"after,omitempty"`
	// Label: Beschriftung je Sprache ("de", "en"); fehlt die aktuelle Sprache, gilt "de", dann die ID.
	Label map[string]string `json:"label"`
	// Group: Beschriftung der Admin-Gruppe (nur bei Placement "admin:<gruppe>"); Module derselben Gruppe dürfen sie wiederholen.
	Group map[string]string `json:"group,omitempty"`
	// Element: Name des Custom Elements, das das Bundle registriert. Bundle: URL des ESM-Bundles.
	Element string `json:"element"`
	Bundle  string `json:"bundle"`
}

// UIProvider: das Modul bringt Oberfläche mit.
type UIProvider interface {
	UI() []UITab
}

// MetricsProvider: das Modul liefert Zeilen für `GET /metrics` (Prometheus-Textformat).
type MetricsProvider interface {
	WriteMetrics(w io.Writer)
}

// AuthKind ist die Rechtepflicht einer Route.
type AuthKind int

const (
	// AuthAnonymous: ohne Anmeldung erreichbar (nur für bewusst offene Endpunkte).
	AuthAnonymous AuthKind = iota
	// AuthAuthenticated: jede angemeldete Person.
	AuthAuthenticated
	// AuthVerbGlobal: mindestens das Recht `Verb` global.
	AuthVerbGlobal
	// AuthVerbOnNode: mindestens `Verb` auf der Node, die in der Route steht (`{id}`).
	AuthVerbOnNode
)

// Auth beschreibt die Rechtepflicht einer Route. Die Konstruktoren sind die einzige Schreibweise (auch das
// Routentabellen-Werkzeug erkennt sie daran).
type Auth struct {
	Kind AuthKind
	Verb authz.Verb
}

func Anonymous() Auth              { return Auth{Kind: AuthAnonymous} }
func Authenticated() Auth          { return Auth{Kind: AuthAuthenticated} }
func Verb(v authz.Verb) Auth       { return Auth{Kind: AuthVerbGlobal, Verb: v} }
func VerbOnNode(v authz.Verb) Auth { return Auth{Kind: AuthVerbOnNode, Verb: v} }

// Routes nimmt die Routen eines Moduls entgegen; die Umsetzung (httpapi) hängt die Rechteprüfung des Kerns davor.
// `pattern` hat die Form von `http.ServeMux` ("GET /api/v1/cloud/hosts").
type Routes interface {
	Handle(pattern string, auth Auth, h http.HandlerFunc)
}

// DomainAudit schreibt einen Eintrag ins Domänen-Audit-Log.
type DomainAudit interface {
	Log(actor, objectType, objectID, action string, details map[string]any)
}

// ErrNotFound: für den Schlüssel wurde nie etwas gespeichert (`NodeSettings.Get`).
var ErrNotFound = errors.New("module: setting not found")

// NodeSettings ist der generische Schlüssel/Wert-Speicher der Plattform.
type NodeSettings interface {
	Get(key string) ([]byte, error)
	Put(key string, data []byte) error
}

// Hosts ist die Host-Verwaltung des Kerns (registrierte Host-Agents, Bootstrap-Token für neue Hosts).
type Hosts interface {
	ListHosts() ([]hosts.Host, error)
	CreateBootstrapToken(createdBy string, ttl time.Duration) (string, time.Time, error)
}

// HostMetrics liefert die zuletzt empfangene Telemetrie eines Hosts.
type HostMetrics interface {
	Get(hostID string) (hosts.Metrics, bool)
}

// Instances ist die Sicht auf die laufenden Instanzen.
type Instances interface {
	// CountOnHost zählt die Instanzen auf einem Host-Agent (hostID = Host-Agent-ID).
	CountOnHost(hostID string) int
	// LocalLoad: Auslastung des Orchestrator-Rechners selbst (ok=false: unbekannt).
	LocalLoad() (cpuPercent, memPercent float64, ok bool)
}

// Placement steuert, wohin Last gelegt wird.
type Placement interface {
	// SetDraining sperrt/entsperrt einen Host für neue Platzierungen (laufende Instanzen bleiben).
	SetDraining(hostID string, on bool)
}

// Deps ist, was ein Modul vom Kern bekommt — bewusst klein; weitere Abhängigkeiten kommen mit dem jeweiligen Umzug
// als eigene schmale Schnittstellen, nie als Durchreichen des ganzen Kerns.
type Deps struct {
	DB       *sql.DB
	Audit    DomainAudit
	Settings NodeSettings
	// Actor liefert den Nutzernamen des angemeldeten Aufrufers einer Anfrage ("" im Bootstrap-Modus).
	Actor       func(*http.Request) string
	Hosts       Hosts
	HostMetrics HostMetrics
	Instances   Instances
	Placement   Placement
}
