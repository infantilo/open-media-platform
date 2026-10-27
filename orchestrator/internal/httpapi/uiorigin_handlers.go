package httpapi

import (
	"net/http"
	"net/url"
	"strings"

	"github.com/infantilo/openmediaplatform/orchestrator/internal/launcher"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/registry"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/uiorigin"
)

// UIIsolation beschreibt den zweiten Ursprung für Node-Oberflächen (internal/uiorigin, Audit H1).
type UIIsolation struct {
	Manager *uiorigin.Manager
	// Port des zweiten Ursprungs (Hostname = der der Shell-Seite, außer URLBase ist gesetzt).
	Port string
	// URLBase überschreibt Schema+Host(+Port) des zweiten Ursprungs (z. B. hinter einem Reverse-Proxy), ohne Pfad.
	URLBase string
	// Types: Node-Typen, deren Oberfläche isoliert läuft ("*" = alle).
	Types []string
}

func (u *UIIsolation) isolates(nodeType string) bool {
	for _, t := range u.Types {
		if t == "*" || t == nodeType {
			return true
		}
	}
	return false
}

// WithUIIsolation aktiviert POST /api/v1/nodes/{id}/ui-grant und GET /api/v1/ui-origin.
func WithUIIsolation(u *UIIsolation) HandlerOption {
	return func(o *handlerOptions) { o.uiIsolation = u }
}

type nodeGetter interface {
	Get(id string) (registry.NodeView, bool)
}

type instanceGetter interface {
	Get(id string) (launcher.Instance, bool)
}

func uiOriginBase(u *UIIsolation, r *http.Request) string {
	if u.URLBase != "" {
		return strings.TrimSuffix(u.URLBase, "/")
	}
	scheme := "http"
	if secureRequest(r) {
		scheme = "https"
	}
	host := r.Host
	if parsed, err := url.Parse("//" + r.Host); err == nil {
		host = parsed.Hostname()
	}
	if strings.Contains(host, ":") { // IPv6-Literal
		host = "[" + host + "]"
	}
	return scheme + "://" + host + ":" + u.Port
}

// handleUIGrant: POST /api/v1/nodes/{id}/ui-grant — liefert die Adresse für den iframe der isolierten Oberfläche; `isolated: false`, wenn dieser Node-Typ nicht isoliert läuft.
func handleUIGrant(u *UIIsolation, nodes NodeLister, launcherSvc LauncherService) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id := r.PathValue("id")
		ng, ok := nodes.(nodeGetter)
		if !ok {
			writeJSON(w, http.StatusOK, map[string]any{"isolated": false})
			return
		}
		node, found := ng.Get(id)
		if !found {
			http.Error(w, "unknown node", http.StatusNotFound)
			return
		}
		nodeType := ""
		if ig, ok := launcherSvc.(instanceGetter); ok && node.InstanceID != "" {
			if inst, ok := ig.Get(node.InstanceID); ok {
				nodeType = inst.Type
			}
		}
		if nodeType == "" || !u.isolates(nodeType) {
			writeJSON(w, http.StatusOK, map[string]any{"isolated": false})
			return
		}
		token, present := bearerToken(r)
		if !present {
			// Bootstrap-Modus ohne Nutzer: es gibt kein Token, das der zweite Ursprung weiterreichen könnte — Oberfläche läuft klassisch.
			writeJSON(w, http.StatusOK, map[string]any{"isolated": false})
			return
		}
		grant, ok := u.Manager.NewGrant(id, token, uiorigin.DefaultRules[nodeType])
		if !ok {
			http.Error(w, "cannot grant", http.StatusBadRequest)
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"isolated": true, "url": uiOriginBase(u, r) + "/enter/" + url.PathEscape(id) + "?g=" + grant})
	}
}

func handleUIOriginInfo(u *UIIsolation) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusOK, map[string]any{"enabled": true, "origin": uiOriginBase(u, r), "types": u.Types})
	}
}

// OptionalUIIsolation: wie WithUIIsolation, aber nil ergibt eine wirkungslose Option (Isolation nicht konfiguriert).
func OptionalUIIsolation(u *UIIsolation) HandlerOption {
	if u == nil {
		return func(*handlerOptions) {}
	}
	return WithUIIsolation(u)
}
