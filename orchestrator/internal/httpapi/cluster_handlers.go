package httpapi

import (
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httputil"
	"net/url"

	"github.com/hashicorp/raft"

	"github.com/infantilo/openmediaplatform/orchestrator/internal/cluster"
)

// ClusterService liefert den Raft-Cluster-Status dieser Instanz und
// verwaltet Mitgliedschaft (implementiert von *cluster.Node,
// ARCHITECTURE.md §19.3, UMSETZUNG.md D12).
type ClusterService interface {
	Status() cluster.Status
	// IsLeader/Join/Leave/LeaderHTTPAddr (D12 Teil 2) — Join/Leave dürfen
	// nur auf dem Leader wirken (s. cluster.Node-Doku); die Handler unten
	// nutzen IsLeader/LeaderHTTPAddr, um einen an eine Follower-Instanz
	// gerichteten Aufruf transparent an den echten Leader weiterzuleiten,
	// statt lokal falsch zu antworten.
	IsLeader() bool
	Join(nodeID, raftAddr, httpAddr string) error
	Leave(nodeID string) error
	LeaderHTTPAddr() (string, bool)
}

// handleClusterStatus ist GET /api/v1/cluster/status — view-artiger
// Bestandsendpunkt wie GET /api/v1/hosts (nur Authentifizierung, kein
// weiterer Verb-Scope): Leader/Term/angewandter Log-Index/Peer-Liste
// dieser Instanz. Absichtlich ohne Cluster-weite Aggregation — jede
// Instanz beantwortet nur ihre eigene, lokale Sicht (die bei
// funktionierendem Konsens ohnehin auf allen Instanzen konvergiert;
// Divergenz selbst ist ein Diagnose-Signal, kein Fehler, der hier
// versteckt werden sollte).
func handleClusterStatus(clusterSvc ClusterService) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusOK, clusterSvc.Status())
	}
}

// clusterJoinRequest ist der Body von POST /api/v1/cluster/join — die
// bereits laufende, per cluster.Config.SkipBootstrap wartende
// Ziel-Instanz beschreibt sich selbst (D12 Teil 2).
type clusterJoinRequest struct {
	NodeID   string `json:"nodeId"`
	RaftAddr string `json:"raftAddr"`
	HTTPAddr string `json:"httpAddr"`
}

// handleClusterJoin ist POST /api/v1/cluster/join (Admin-Verb wie andere
// mitgliedschafts-/sicherheitsrelevante Aktionen, z. B.
// POST /api/v1/admin/hosts/bootstrap-tokens). Läuft diese Instanz gerade
// nicht als Leader, wird der Aufruf transparent an den tatsächlichen
// Leader weitergeleitet (forwardToLeader) statt mit einem bloßen
// Redirect-Hinweis beantwortet — ersetzt den in der ursprünglichen
// Postgres-Advisory-Lock-Skizze noch für nötig gehaltenen externen
// VIP/Proxy-Baustein (ARCHITECTURE.md §19.3 Punkt 6).
func handleClusterJoin(clusterSvc ClusterService) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !clusterSvc.IsLeader() {
			forwardToLeader(clusterSvc, w, r)
			return
		}
		var req clusterJoinRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			http.Error(w, "invalid request body", http.StatusBadRequest)
			return
		}
		if req.NodeID == "" || req.RaftAddr == "" {
			http.Error(w, "nodeId and raftAddr are required", http.StatusBadRequest)
			return
		}
		if err := clusterSvc.Join(req.NodeID, req.RaftAddr, req.HTTPAddr); err != nil {
			http.Error(w, err.Error(), clusterErrorStatus(err))
			return
		}
		writeJSON(w, http.StatusOK, clusterSvc.Status())
	}
}

// handleClusterLeave ist DELETE /api/v1/cluster/members/{id} — dieselbe
// Leader-Weiterleitung wie handleClusterJoin.
func handleClusterLeave(clusterSvc ClusterService) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !clusterSvc.IsLeader() {
			forwardToLeader(clusterSvc, w, r)
			return
		}
		id := r.PathValue("id")
		if id == "" {
			http.Error(w, "member id required", http.StatusBadRequest)
			return
		}
		if err := clusterSvc.Leave(id); err != nil {
			http.Error(w, err.Error(), clusterErrorStatus(err))
			return
		}
		writeJSON(w, http.StatusOK, clusterSvc.Status())
	}
}

// forwardToLeader proxied die eingehende Anfrage unverändert (Methode,
// Body, Header inkl. Authorization — die lokale Instanz hat den Aufrufer
// bereits über authGate geprüft, der Leader prüft beim Empfang erneut,
// keine Vertrauens-Abkürzung) an die aktuelle Leader-HTTP-Adresse. Kann
// der Leader (noch) nicht aufgelöst werden — kein Leader gewählt, oder
// der Leader hat seine Adresse noch nicht angekündigt
// (cluster.Node.watchLeadership, kurzes Fenster direkt nach einem
// Führungswechsel) — antwortet die Instanz mit 503 statt zu blockieren.
func forwardToLeader(clusterSvc ClusterService, w http.ResponseWriter, r *http.Request) {
	addr, ok := clusterSvc.LeaderHTTPAddr()
	if !ok {
		http.Error(w, "no cluster leader known right now, retry shortly", http.StatusServiceUnavailable)
		return
	}
	target, err := url.Parse(addr)
	if err != nil {
		http.Error(w, "leader http address is malformed: "+err.Error(), http.StatusServiceUnavailable)
		return
	}
	httputil.NewSingleHostReverseProxy(target).ServeHTTP(w, r)
}

// clusterErrorStatus bildet cluster.Node-Fehler auf HTTP-Status ab —
// raft.ErrNotLeader (kann trotz des IsLeader()-Checks oben in den
// Handlern noch auftreten, wenn die Führung genau zwischen Check und
// Apply wechselt) und cluster.ErrLastVoterIsLeader (Nutzerfund
// 2026-08-27: der Leader darf sich nicht selbst als letztes
// verbleibendes Mitglied entfernen, s. dortige Doku) werden beide als
// 409 gemeldet, alles andere bleibt 500. Kleine Hilfsfunktion statt
// eines Sonderfalls in jedem Handler.
func clusterErrorStatus(err error) int {
	if errors.Is(err, raft.ErrNotLeader) || errors.Is(err, cluster.ErrLastVoterIsLeader) {
		return http.StatusConflict
	}
	return http.StatusInternalServerError
}
