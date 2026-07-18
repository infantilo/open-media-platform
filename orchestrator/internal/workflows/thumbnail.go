package workflows

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"mime"
	"mime/multipart"
	"net/http"
	"time"

	"github.com/infantilo/openmediaplatform/orchestrator/internal/registry"
)

// Kapitel 12 Teil 6, Unterteil 3 (docs/END-GOAL-FEATURES.md §12.3g,
// ARCHITECTURE.md §22.3 Punkt 5): "Wiederverwendung des bereits
// vorhandenen MJPEG-Preview-Mechanismus (omp-viewer, seit dem
// C13-Nachtrag als gemeinsames preview-Feature in omp-mediaio):
// GET <previewUrl> liefert ohnehin einzelne JPEGs, kein neuer
// Node-Endpunkt nötig." Der previewUrl-Endpunkt selbst liefert
// tatsächlich `multipart/x-mixed-replace` (nodes/omp-mediaio/src/
// preview.rs) statt eines einzelnen JPEGs — dieselbe HTTP-Antwort
// liefert aber mit dem ersten Teilbild bereits alles, was ein
// Katalog-Thumbnail braucht; die Verbindung wird danach sofort
// geschlossen (kein Dauerabo).

// maxThumbnailBytes begrenzt ein einzelnes erfasstes Vorschau-Bild —
// ein JPEG-Preview-Frame liegt üblicherweise im niedrigen
// Zehntausender-Byte-Bereich; die Obergrenze ist eine
// Verteidigungslinie gegen einen fehlkonfigurierten Preview-Endpunkt,
// keine erwartete Größe.
const maxThumbnailBytes = 8 << 20 // 8 MiB

const thumbnailCaptureTimeout = 5 * time.Second

// captureThumbnail fragt einen einzelnen Frame vom MJPEG-Preview-
// Endpunkt ab und liest genau das erste Teilbild.
func captureThumbnail(ctx context.Context, client *http.Client, previewURL string) ([]byte, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, previewURL, nil)
	if err != nil {
		return nil, err
	}
	resp, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("workflows: unexpected status %d from GET %s", resp.StatusCode, previewURL)
	}
	_, params, err := mime.ParseMediaType(resp.Header.Get("Content-Type"))
	if err != nil {
		return nil, fmt.Errorf("workflows: preview endpoint %s did not return multipart: %w", previewURL, err)
	}
	boundary, ok := params["boundary"]
	if !ok {
		return nil, fmt.Errorf("workflows: preview endpoint %s missing multipart boundary", previewURL)
	}
	part, err := multipart.NewReader(resp.Body, boundary).NextPart()
	if err != nil {
		return nil, err
	}
	defer part.Close()
	return io.ReadAll(io.LimitReader(part, maxThumbnailBytes))
}

// previewURLForNode fragt den previewUrl-Parameter eines laufenden
// Nodes ab — leerer String, wenn der Node-Typ keinen previewUrl-
// Parameter hat (z. B. jeder Node ohne omp-mediaio::preview), kein
// Fehler: gleiche Robustheit wie beim previewUrl-Thumbnail im
// Flow-Editor (ui/graph/flow-canvas.ts #maybeFetchPreviewUrl).
func (s *Service) previewURLForNode(ctx context.Context, node registry.NodeView) string {
	if node.APIBaseURL == "" {
		return ""
	}
	raw, err := s.methods.GetParam(ctx, node.APIBaseURL, "previewUrl")
	if err != nil {
		return ""
	}
	var url string
	if err := json.Unmarshal(raw, &url); err != nil {
		return ""
	}
	return url
}

// captureWorkflowThumbnail versucht, für einen soeben gestarteten
// Workflow ein Vorschau-Bild zu erfassen und zu speichern — best
// effort, jeder Fehler wird verschluckt (kein previewUrl-fähiger Node
// in irgendeiner Rolle, Node noch nicht erreichbar, Preview-Endpunkt
// liefert innerhalb des Timeouts kein Frame, …): ein fehlendes
// Thumbnail ist nie ein Fehler, nur ein Katalog-Platzhalter (§22.3
// Punkt 5).
//
// "Program-Bus-Rolle" (§22.3 Punkt 5 wörtlich) ist im Workflow-Objekt
// heute nicht als eigenes Feld modelliert — kein Rollentyp-Marker "das
// ist der Ausgang" (ARCHITECTURE.md §22.4 nennt das selbst als noch
// fehlende Voraussetzung: "braucht eine echte Program-Bus-Rolle").
// Pragmatischer Ersatz statt eines geratenen neuen Schemafelds: die
// erste Rolle in Definitionsreihenfolge, deren laufender Node
// tatsächlich einen previewUrl liefert (docs/decisions.md 2026-07-18).
func (s *Service) captureWorkflowThumbnail(wf Workflow) {
	ctx, cancel := context.WithTimeout(context.Background(), thumbnailCaptureTimeout)
	defer cancel()

	for _, role := range wf.Definition.Roles {
		node, ok := s.nodeForRole(wf, role.Name)
		if !ok {
			continue
		}
		previewURL := s.previewURLForNode(ctx, node)
		if previewURL == "" {
			continue
		}
		jpeg, err := captureThumbnail(ctx, s.httpClient, previewURL)
		if err != nil || len(jpeg) == 0 {
			continue
		}
		if err := s.store.SetThumbnail(wf.ID, jpeg); err != nil {
			slog.Warn("workflows: failed to persist thumbnail", "id", wf.ID, "error", err)
		}
		return
	}
}
