// Package httpapi stellt den HTTP-Handler des Orchestrators bereit:
// generische REST-Endpunkte plus statisches Ausliefern der UI-Shell.
package httpapi

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/infantilo/openmediaplatform/orchestrator/internal/authz"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/config"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/consoles"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/graph"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/launcher"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/placement"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/registry"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/snapshots"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/sse"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/workflows"
)

// AppName identifiziert den Orchestrator in /api/v1/info und Logs.
const AppName = "openmediaplatform-orchestrator"

// Version wird in späteren Schritten per ldflags beim Build gesetzt.
var Version = "dev"

// InfoResponse ist der Body von GET /api/v1/info.
type InfoResponse struct {
	Name    string `json:"name"`
	Version string `json:"version"`
}

// NodeLister liefert den zuletzt bekannten Node-Snapshot (implementiert von
// *registry.Store); als Interface gehalten, damit Handler-Tests ohne
// echten Poller auskommen. Get wird vom generischen Parameter-/Methoden-
// Proxy (A8) genutzt, um die API-Basis-URL eines Nodes aufzulösen.
type NodeLister interface {
	List() []registry.NodeView
	Get(id string) (registry.NodeView, bool)
	// PollDuration (S8, docs/REVIEW-2026-07-17-SKALIERUNG-24-7.md) — s.
	// handleMetrics in metrics.go.
	PollDuration() time.Duration
}

// EventSubscriber liefert einen Event-Kanal für einen neuen SSE-Client
// und erlaubt zusätzlich das Verteilen synthetischer Events, die nicht
// über NATS laufen (implementiert von *sse.Hub). Broadcast wird bisher
// nur von handleRegisterHost genutzt ("host.registered", S2 —
// docs/REVIEW-2026-07-17-SKALIERUNG-24-7.md): eine neue Host-
// Registrierung soll ohne Poll <1s im hosts-view sichtbar werden.
type EventSubscriber interface {
	Subscribe() (<-chan sse.Event, func())
	Broadcast(sse.Event)
	// ClientCount/TotalDrops (S8, docs/REVIEW-2026-07-17-SKALIERUNG-24-7.md)
	// — s. handleMetrics in metrics.go.
	ClientCount() int
	TotalDrops() uint64
}

// GraphService baut den Flow-Editor-Graphen und führt IS-05-
// Verbindungsänderungen aus (implementiert von *graph.Service).
type GraphService interface {
	Graph(ctx context.Context) graph.Graph
	Connect(ctx context.Context, fromSender, toReceiver string) error
	Disconnect(ctx context.Context, receiverID string) error
}

// LayoutStore persistiert benannte Layout-Blobs (implementiert von
// *layouts.Store) — der Orchestrator kennt deren Struktur nicht, reines
// Opak-Speichern (UMSETZUNG.md B5).
type LayoutStore interface {
	Get(name string) (json.RawMessage, error)
	Put(name string, data json.RawMessage) error
}

// SnapshotService erfasst und stellt Szenen wieder her (implementiert
// von *snapshots.Service, UMSETZUNG.md B7).
type SnapshotService interface {
	// nodeIDs leer = klassische, workflow-weite Szene (B7); nicht leer =
	// Node-Preset (§4.6 Punkt 4), s. snapshots.Service.Create-Doku.
	Create(ctx context.Context, label string, nodeIDs []string) (snapshots.Snapshot, error)
	List() ([]snapshots.Snapshot, error)
	Apply(ctx context.Context, id string) (snapshots.ApplyResult, error)
}

// LauncherService startet/stoppt Node-Instanzen aus dem Katalog —
// lokal (UMSETZUNG.md C8) oder, mit gesetztem hostID, auf einem
// entfernten Host (ARCHITECTURE.md §18.5, UMSETZUNG.md D6 Teil 2)
// (implementiert von *launcher.Launcher).
type LauncherService interface {
	Catalog() []launcher.CatalogEntry
	List() []launcher.Instance
	Start(nodeType, hostID string, extraEnv map[string]string) (launcher.Instance, error)
	Stop(id string) error
	// TotalRestarts (S8, docs/REVIEW-2026-07-17-SKALIERUNG-24-7.md) — s.
	// handleMetrics in metrics.go.
	TotalRestarts() uint64
}

// WorkflowService verwaltet Workflow-Definitionen und führt Bundle-
// Start/-Stop aus (implementiert von *workflows.Service,
// ARCHITECTURE.md §6.2, UMSETZUNG.md D7 Teil 1).
type WorkflowService interface {
	Create(name string, def workflows.Definition) (workflows.Workflow, error)
	List() ([]workflows.Workflow, error)
	Get(id string) (workflows.Workflow, error)
	// GetThumbnail (Kapitel 12 Teil 6, §22.3 Punkt 5) — s.
	// handleWorkflowThumbnail in workflow_handlers.go.
	GetThumbnail(id string) ([]byte, bool, error)
	Update(id, name string, def workflows.Definition) (workflows.Workflow, error)
	Delete(id string) error
	Start(ctx context.Context, id string) error
	Stop(ctx context.Context, id string, confirm bool) error
	Pause(ctx context.Context, id string, confirm bool) error
	Export(id string) (workflows.ExportedWorkflow, error)
	Import(exported workflows.ExportedWorkflow) (workflows.Workflow, error)
	// FindRoleForNode (Kapitel 12 Teil 4) — s. WorkflowRoleFinder in
	// auth_middleware.go, dieselbe Methode, hier Teil der ohnehin
	// injizierten WorkflowService-Implementierung.
	FindRoleForNode(nodeID string) (workflowID, workflowName, role string, ok bool)
}

// ConsoleResolver löst Rollenbindungen zu Konsolen-Einträgen auf
// (implementiert von *consoles.Resolver, UMSETZUNG.md C13) — eine
// vereinfachte Rollen-Stub-Prüfung, echte Durchsetzung folgt mit D3.
type ConsoleResolver interface {
	Resolve(userID string, nodes []consoles.NodeInfo) (consoles.Result, error)
}

// nodeInfosFrom projiziert den Node-Bestand auf die schmale Teilmenge,
// die consoles.Resolver braucht — hält consoles von registry entkoppelt.
func nodeInfosFrom(nodes NodeLister) []consoles.NodeInfo {
	views := nodes.List()
	infos := make([]consoles.NodeInfo, len(views))
	for i, v := range views {
		infos[i] = consoles.NodeInfo{ID: v.ID, Label: v.Label, InstanceID: v.InstanceID}
	}
	return infos
}

// NewHandler baut den kompletten HTTP-Handler des Orchestrators:
// /healthz, /api/v1/info, /api/v1/auth, /api/v1/nodes, /api/v1/events,
// /api/v1/graph, /api/v1/layouts, /api/v1/snapshots, /api/v1/catalog,
// /api/v1/instances, /api/v1/me/consoles, /api/v1/admin, /api/v1/hosts
// (Remote-Host-Erkennung, ARCHITECTURE.md §18, UMSETZUNG.md D6 Teil 1),
// /api/v1/workflows (Workflow-Bereitstellung & -Verteilung,
// ARCHITECTURE.md §6.2, UMSETZUNG.md D7 Teil 1), /api/v1/placement/advice
// (Resource-Aware Placement, advisory-only, ARCHITECTURE.md §6.1,
// UMSETZUNG.md D6 Teil 3)
// und statisches
// Serving von cfg.UIDir unter / (inkl. SPA-Fallback für die Kiosk-Routen
// /console/<workflowId>/<nodeRoleId>, ARCHITECTURE.md §14). nodeClient
// ist der (ggf. mTLS-fähige, UMSETZUNG.md D3 Teil 1) HTTP-Client für den
// generischen Node-Proxy — nil bedeutet http.DefaultClient.
//
// authSvc/authzStore/auditLogger setzen ARCHITECTURE.md §12 durch
// (UMSETZUNG.md D3 Teil 2): lesende Endpunkte verlangen nur eine gültige
// Anmeldung (authGate.requireAuth), schreibende verlangen zusätzlich das
// passende Verb — node-gescoped (params/methods, requireVerbOnNode) oder
// global auf einer "*"-Bindung (Graph/Layouts/Snapshots/Launcher/Admin,
// requireVerbGlobal, s. §12 Punkt 2: "Katalog-Verwaltung ist eine
// administrative Rolle"). Solange kein Nutzer existiert, bypassed
// authGate jede Prüfung (Bootstrap-Modus) — unverändertes Verhalten
// gegenüber vor D3 Teil 2.
func NewHandler(cfg config.Config, nodes NodeLister, events EventSubscriber, graphSvc GraphService, layoutStore LayoutStore, snapshotSvc SnapshotService, launcherSvc LauncherService, consoleResolver ConsoleResolver, nodeClient *http.Client, authSvc AuthService, authzStore AuthzChecker, auditLogger AuditLogger, auditReader AuditReader, hostRegistry HostRegistry, hostMetrics HostMetricsReader, hostHistory HostHistoryReader, workflowSvc WorkflowService, placementAdvisor PlacementAdvisor, profileStore ProfileReader, placementThresholds placement.Thresholds) http.Handler {
	g := &authGate{auth: authSvc, authz: authzStore, audit: auditLogger, nodes: nodes, workflows: workflowSvc}

	// S8 (docs/REVIEW-2026-07-17-SKALIERUNG-24-7.md): ein Zähler pro
	// Prozess, geteilt zwischen der zählenden Middleware (unten,
	// umschließt den ganzen Mux) und /metrics selbst.
	reqCounters := &requestCounters{}

	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", handleHealthz)
	mux.HandleFunc("GET /api/v1/info", handleInfo)
	// Bewusst unauthentifiziert wie /healthz (Prometheus-Scraper senden
	// üblicherweise keinen Bearer-Token; Netzwerk-Isolation ist hier die
	// erwartete Absicherung, nicht Anwendungs-Auth) — s. metrics.go.
	mux.HandleFunc("GET /metrics", handleMetrics(nodes, events, launcherSvc, reqCounters))

	mux.HandleFunc("POST /api/v1/auth/login", handleLogin(authSvc))
	mux.HandleFunc("GET /api/v1/auth/whoami", handleWhoami(authSvc, authzStore))
	mux.HandleFunc("POST /api/v1/auth/users", g.requireVerbGlobal(authz.VerbAdmin, handleCreateUser(authSvc, authzStore)))
	mux.HandleFunc("GET /api/v1/auth/users", g.requireVerbGlobal(authz.VerbAdmin, handleListUsers(authSvc, authzStore)))
	mux.HandleFunc("DELETE /api/v1/auth/users/{name}", g.requireVerbGlobal(authz.VerbAdmin, handleDeleteUser(authSvc, authzStore)))
	mux.HandleFunc("PUT /api/v1/auth/users/{name}/password", g.requireVerbGlobal(authz.VerbAdmin, handleResetPassword(authSvc)))

	mux.HandleFunc("GET /api/v1/nodes", g.requireAuth(handleNodes(nodes)))
	mux.HandleFunc("GET /api/v1/events", g.requireAuth(handleEvents(events)))
	mux.HandleFunc("GET /api/v1/nodes/{id}/descriptor", g.requireAuth(handleNodeProxy(nodes, nodeClient, "/descriptor.json")))
	mux.HandleFunc("GET /api/v1/nodes/{id}/params/{name}", g.requireAuth(handleNodeProxy(nodes, nodeClient, "/params/{name}")))
	mux.HandleFunc("PATCH /api/v1/nodes/{id}/params/{name}", g.requireVerbOnNode(authz.VerbOperate, handleNodeProxy(nodes, nodeClient, "/params/{name}")))
	mux.HandleFunc("POST /api/v1/nodes/{id}/methods/{name}", g.requireVerbOnNode(authz.VerbOperate, handleNodeProxy(nodes, nodeClient, "/methods/{name}")))
	mux.HandleFunc("GET /api/v1/nodes/{id}/ui/manifest.json", g.requireAuth(handleNodeProxy(nodes, nodeClient, "/ui/manifest.json")))
	mux.HandleFunc("GET /api/v1/nodes/{id}/ui/bundle.js", g.requireAuth(handleNodeProxy(nodes, nodeClient, "/ui/bundle.js")))
	mux.HandleFunc("GET /api/v1/graph", g.requireAuth(handleGraph(graphSvc)))
	mux.HandleFunc("POST /api/v1/graph/edges", g.requireVerbGlobal(authz.VerbConfigure, handlePostGraphEdge(graphSvc)))
	mux.HandleFunc("DELETE /api/v1/graph/edges/{id}", g.requireVerbGlobal(authz.VerbConfigure, handleDeleteGraphEdge(graphSvc)))
	mux.HandleFunc("GET /api/v1/layouts/{name}", g.requireAuth(handleGetLayout(layoutStore)))
	mux.HandleFunc("PUT /api/v1/layouts/{name}", g.requireVerbGlobal(authz.VerbConfigure, handlePutLayout(layoutStore)))
	mux.HandleFunc("GET /api/v1/snapshots", g.requireAuth(handleListSnapshots(snapshotSvc)))
	mux.HandleFunc("POST /api/v1/snapshots", g.requireVerbGlobal(authz.VerbConfigure, handleCreateSnapshot(snapshotSvc)))
	mux.HandleFunc("POST /api/v1/snapshots/{id}/apply", g.requireVerbGlobal(authz.VerbConfigure, handleApplySnapshot(snapshotSvc)))
	mux.HandleFunc("GET /api/v1/catalog", g.requireAuth(handleCatalog(launcherSvc)))
	mux.HandleFunc("GET /api/v1/instances", g.requireAuth(handleListInstances(launcherSvc, hostMetrics)))
	mux.HandleFunc("POST /api/v1/instances", g.requireVerbGlobal(authz.VerbAdmin, handlePostInstance(launcherSvc)))
	mux.HandleFunc("DELETE /api/v1/instances/{id}", g.requireVerbGlobal(authz.VerbAdmin, handleDeleteInstance(launcherSvc)))
	mux.HandleFunc("GET /api/v1/me/consoles", g.requireAuth(handleMeConsoles(nodes, consoleResolver)))

	mux.HandleFunc("GET /api/v1/admin/role-bindings", g.requireVerbGlobal(authz.VerbAdmin, handleListRoleBindings(authzStore)))
	mux.HandleFunc("POST /api/v1/admin/role-bindings", g.requireVerbGlobal(authz.VerbAdmin, handleCreateRoleBinding(authzStore)))
	mux.HandleFunc("DELETE /api/v1/admin/role-bindings/{id}", g.requireVerbGlobal(authz.VerbAdmin, handleDeleteRoleBinding(authzStore)))
	mux.HandleFunc("GET /api/v1/admin/audit-log", g.requireVerbGlobal(authz.VerbAdmin, handleListAuditLog(auditReader)))

	// Remote-Host-Erkennung (ARCHITECTURE.md §18, UMSETZUNG.md D6 Teil 1).
	// /register bewusst außerhalb von authGate — s. handleRegisterHost.
	mux.HandleFunc("POST /api/v1/admin/hosts/bootstrap-tokens", g.requireVerbGlobal(authz.VerbAdmin, handleCreateBootstrapToken(hostRegistry)))
	mux.HandleFunc("POST /api/v1/hosts/register", handleRegisterHost(hostRegistry, events))
	mux.HandleFunc("GET /api/v1/hosts", g.requireAuth(handleListHosts(hostRegistry, hostMetrics)))
	mux.HandleFunc("GET /api/v1/hosts/{id}/metrics/history", g.requireAuth(handleHostMetricsHistory(hostHistory)))

	// Resource-Aware Placement, advisory-only (ARCHITECTURE.md §6.1,
	// UMSETZUNG.md D6 Teil 3) — view-artig wie /api/v1/hosts, kein
	// eigener Verb-Scope, die Engine führt selbst nichts aus.
	mux.HandleFunc("GET /api/v1/placement/advice", g.requireAuth(handleListPlacementAdvice(placementAdvisor)))

	// Verbrauchsprofile pro Node-Typ, advisory (Kapitel 14 Teil 3,
	// docs/END-GOAL-FEATURES.md §14.3d) — view-artig wie /api/v1/hosts.
	mux.HandleFunc("GET /api/v1/profiles", g.requireAuth(handleGetProfile(profileStore, hostMetrics, placementThresholds)))

	// Workflow-Bereitstellung & -Verteilung (ARCHITECTURE.md §6.2,
	// UMSETZUNG.md D7 Teil 1). Definieren ist "configure" (wie
	// Graph-Kanten/Layouts/Snapshots), Start/Stop ist "admin" (wie der
	// Instanz-Launcher — ein Workflow-Start ist nichts anderes als
	// mehrere gebündelte Instanz-Starts).
	mux.HandleFunc("GET /api/v1/workflows", g.requireAuth(handleListWorkflows(workflowSvc)))
	mux.HandleFunc("GET /api/v1/workflows/{id}", g.requireAuth(handleGetWorkflow(workflowSvc)))
	mux.HandleFunc("POST /api/v1/workflows", g.requireVerbGlobal(authz.VerbConfigure, handleCreateWorkflow(workflowSvc)))
	mux.HandleFunc("PUT /api/v1/workflows/{id}", g.requireVerbGlobal(authz.VerbConfigure, handleUpdateWorkflow(workflowSvc)))
	mux.HandleFunc("DELETE /api/v1/workflows/{id}", g.requireVerbGlobal(authz.VerbConfigure, handleDeleteWorkflow(workflowSvc)))
	mux.HandleFunc("POST /api/v1/workflows/{id}/start", g.requireVerbGlobal(authz.VerbAdmin, handleStartWorkflow(workflowSvc)))
	mux.HandleFunc("POST /api/v1/workflows/{id}/stop", g.requireVerbGlobal(authz.VerbAdmin, handleStopWorkflow(workflowSvc)))
	mux.HandleFunc("POST /api/v1/workflows/{id}/pause", g.requireVerbGlobal(authz.VerbAdmin, handlePauseWorkflow(workflowSvc)))
	mux.HandleFunc("GET /api/v1/workflows/{id}/export", g.requireAuth(handleExportWorkflow(workflowSvc)))
	mux.HandleFunc("GET /api/v1/workflows/{id}/thumbnail", g.requireAuth(handleWorkflowThumbnail(workflowSvc)))
	mux.HandleFunc("POST /api/v1/workflows/import", g.requireVerbGlobal(authz.VerbConfigure, handleImportWorkflow(workflowSvc)))

	mux.Handle("/", spaFallback(cfg.UIDir, http.FileServer(http.Dir(cfg.UIDir))))
	return countRequests(reqCounters, noStoreForAPI(mux))
}

// spaFallback liefert für die Kiosk-Routen /console/... (ARCHITECTURE.md
// §14: "direkt verlinkbar/bookmarkbar") index.html aus, statt eines
// 404 vom generischen Datei-Server — die Shell selbst wertet
// window.location.pathname client-seitig aus (ui/shell/shell.ts), der
// Orchestrator kennt diese Routen sonst nicht.
func spaFallback(uiDir string, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasPrefix(r.URL.Path, "/console/") {
			http.ServeFile(w, r, uiDir+"/index.html")
			return
		}
		next.ServeHTTP(w, r)
	})
}

// noStoreForAPI markiert alle /api/v1/*-Antworten als nicht cachebar.
// Ohne das kann der Browser GET-Antworten (Graph, Nodes, Snapshot-Liste,
// Node-Proxy-Parameter …) je nach Heuristik zwischenspeichern und nach
// einer Änderung veraltete Daten zeigen, bis ein vollständiger Reload
// einen echten Request erzwingt — im Browser bei B7 beobachtet
// (Snapshot-Leiste aktualisierte sich nicht sofort, Parameter-Panel
// zeigte nach einem Apply erst nach erneuter Node-Auswahl den neuen
// Wert). Statisches UI-Serving (/, /dist/…) ist von der Regel
// ausgenommen, da Caching dort unproblematisch/gewünscht ist.
func noStoreForAPI(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasPrefix(r.URL.Path, "/api/v1/") {
			w.Header().Set("Cache-Control", "no-store")
		}
		next.ServeHTTP(w, r)
	})
}

func handleHealthz(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

func handleInfo(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, InfoResponse{Name: AppName, Version: Version})
}

func handleNodes(nodes NodeLister) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusOK, nodes.List())
	}
}

// handleEvents liefert Bus-Ereignisse und Node-Inventar-Änderungen als
// Server-Sent-Events-Stream (UMSETZUNG.md A6).
func handleEvents(events EventSubscriber) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		flusher, ok := w.(http.Flusher)
		if !ok {
			http.Error(w, "streaming unsupported", http.StatusInternalServerError)
			return
		}

		w.Header().Set("Content-Type", "text/event-stream")
		w.Header().Set("Cache-Control", "no-cache")
		w.Header().Set("Connection", "keep-alive")
		w.WriteHeader(http.StatusOK)
		flusher.Flush()

		ch, cancel := events.Subscribe()
		defer cancel()

		for {
			select {
			case <-r.Context().Done():
				return
			case ev, ok := <-ch:
				if !ok {
					return
				}
				data, err := json.Marshal(ev)
				if err != nil {
					continue
				}
				fmt.Fprintf(w, "data: %s\n\n", data)
				flusher.Flush()
			}
		}
	}
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}
