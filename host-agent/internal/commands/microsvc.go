package commands

// Aktionen für importierte Microservices (Kap. 85): catalog-trust, catalog-install, catalog-remove, catalog-list.
// Wie beim System-Update lädt der Agent nur vom EIGENEN Orchestrator (feste Pfad-Whitelist), prüft Signatur und
// Prüfsumme mit seinem eigenen Vertrauensanker und entscheidet über Vertrauens-Erweiterungen selbst (microsvc.Store).

import (
	"encoding/json"
	"fmt"
	"net/url"
	"os"
	"strings"

	"github.com/infantilo/openmediaplatform/host-agent/internal/microsvc"
)

// SetMicroservices aktiviert die Microservice-Verwaltung.
func (e *Executor) SetMicroservices(s *microsvc.Store) {
	e.mu.Lock()
	defer e.mu.Unlock()
	e.installed = s
}

// Pfad-Präfix der Bundle-Downloads beim Orchestrator.
const bundlePathPrefix = "/api/v1/host-catalog/"

// InstalledSummary ist die Antwort von catalog-list (Detail als JSON-Array).
type InstalledSummary struct {
	Type    string `json:"type"`
	Version string `json:"version"`
	ImageID string `json:"imageId"`
}

func (e *Executor) handleMicroservice(req Request) Response {
	if e.installed == nil {
		return Response{Error: "Microservices auf diesem Host nicht aktiviert"}
	}
	switch req.Action {
	case "catalog-trust":
		if err := e.installed.TrustKey(req.DistKey); err != nil {
			return Response{Error: err.Error()}
		}
		return Response{OK: true}
	case "catalog-list":
		var out []InstalledSummary
		for _, in := range e.installed.List() {
			out = append(out, InstalledSummary{Type: in.Type, Version: in.Version, ImageID: in.ImageID})
		}
		data, _ := json.Marshal(out)
		return Response{OK: true, Detail: string(data)}
	case "catalog-remove":
		inUse := func(t, v string) bool {
			e.mu.Lock()
			defer e.mu.Unlock()
			for _, ri := range e.instances {
				if ri.nodeType == t && (v == "" || ri.version == v) {
					return true
				}
			}
			return false
		}
		if err := e.installed.Remove(req.Type, req.Version, inUse); err != nil {
			return Response{Error: err.Error()}
		}
		return Response{OK: true}
	case "catalog-install":
		return e.installBundle(req)
	}
	return Response{Error: "unbekannte Aktion"}
}

func (e *Executor) installBundle(req Request) Response {
	if req.BundlePath == "" || req.BundleSHA256 == "" {
		return Response{Error: "bundlePath/bundleSha256 erforderlich"}
	}
	if !strings.HasPrefix(req.BundlePath, bundlePathPrefix) || strings.Contains(req.BundlePath, "..") {
		return Response{Error: "bundlePath nicht erlaubt"}
	}
	base, err := url.Parse(e.orchestratorURL)
	if err != nil || base.Host == "" {
		return Response{Error: "kein gültiger Orchestrator-URL konfiguriert"}
	}
	if !e.installed.HasKey() {
		return Response{Error: "kein Verteilschlüssel hinterlegt"}
	}
	target := strings.TrimRight(e.orchestratorURL, "/") + req.BundlePath
	dst := e.installed.DownloadPath(req.BundleSHA256[:min(12, len(req.BundleSHA256))])
	defer os.Remove(dst)
	if err := download(target, dst, req.BundleSHA256); err != nil {
		return Response{Error: "download: " + err.Error()}
	}
	in, err := e.installed.Install(dst)
	if err != nil {
		return Response{Error: "installation abgelehnt: " + err.Error()}
	}
	return Response{OK: true, Detail: fmt.Sprintf("%s %s installiert (Image %s)", in.Type, in.Version, in.ImageID)}
}
