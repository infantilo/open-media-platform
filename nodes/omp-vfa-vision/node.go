package main

import (
	"context"
	"embed"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"time"

	"github.com/infantilo/openmediaplatform/nodes/omp-vfa-vision/internal/health"
	"github.com/infantilo/openmediaplatform/nodes/omp-vfa-vision/internal/idgen"
	"github.com/infantilo/openmediaplatform/nodes/omp-vfa-vision/internal/is04"
)

//go:embed ui/manifest.json ui/bundle.js
var uiFiles embed.FS

// serveNode meldet den Dienst als Node an (IS-04, Health, minimaler Descriptor),
// damit er im Flow-Editor und in der Instanzliste erscheint. Er hat keine Ports.
// Blockiert bis ctx endet.
func serveNode(ctx context.Context, natsURL string) {
	label := env("OMP_LABEL", "Gesichtserkennung")
	host := env("OMP_HOST", "127.0.0.1")
	port := envInt("OMP_PORT", 9461)
	registryURL := env("OMP_REGISTRY_URL", "http://127.0.0.1:8010")

	mux := http.NewServeMux()
	mux.HandleFunc("GET /descriptor.json", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"parameters": []map[string]any{
				{"name": "cameras", "type": "number", "readonly": true},
				{"name": "faces", "type": "number", "readonly": true},
				{"name": "intervalMs", "type": "number", "unit": "ms", "readonly": true},
				{"name": "status", "type": "string", "readonly": true},
			},
			"methods": []any{},
		})
	})
	mux.HandleFunc("GET /params/{name}", func(w http.ResponseWriter, r *http.Request) {
		cams := status.snapshot()
		var v any
		switch r.PathValue("name") {
		case "cameras":
			v = len(cams)
		case "faces":
			n := 0
			for _, c := range cams {
				n += len(c.Faces)
			}
			v = n
		case "intervalMs":
			v = envInt("OMP_VFA_INTERVAL_MS", 300)
		case "status":
			v = map[string]any{"cameras": cams}
		default:
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{"value": v})
	})
	for _, f := range []struct{ path, name, ct string }{
		{"/ui/manifest.json", "ui/manifest.json", "application/json"},
		{"/ui/bundle.js", "ui/bundle.js", "text/javascript"},
	} {
		mux.HandleFunc("GET "+f.path, func(w http.ResponseWriter, r *http.Request) {
			b, _ := uiFiles.ReadFile(f.name)
			w.Header().Set("Content-Type", f.ct)
			w.Header().Set("Cache-Control", "no-store")
			_, _ = w.Write(b)
		})
	}
	srv := &http.Server{Addr: fmt.Sprintf(":%d", port), Handler: mux}
	go func() {
		if err := srv.ListenAndServe(); err != http.ErrServerClosed {
			slog.Error("http", "error", err)
		}
	}()

	nodeID, deviceID := idgen.NewV4(), idgen.NewV4()
	node := is04.NewNode(nodeID, label, host, port, "http")
	if id := env("OMP_INSTANCE_ID", ""); id != "" {
		node.Tags["urn:x-omp:instance"] = []string{id}
	}
	device := is04.NewDevice(deviceID, label+" Device", nodeID, []string{}, []string{})
	reg := is04.NewClient(registryURL)
	register := func(ctx context.Context) error {
		if err := reg.Register(ctx, "node", node); err != nil {
			return err
		}
		return reg.Register(ctx, "device", device)
	}
	for ctx.Err() == nil {
		err := register(ctx)
		if err == nil {
			break
		}
		slog.Warn("registrierung", "error", err)
		select {
		case <-ctx.Done():
		case <-time.After(2 * time.Second):
		}
	}
	pub, err := health.Connect(natsURL)
	if err == nil {
		defer pub.Close()
	}
	slog.Info("als Node angemeldet", "node_id", nodeID, "port", port)
	t := time.NewTicker(5 * time.Second)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			shutdown, c := context.WithTimeout(context.Background(), 3*time.Second)
			defer c()
			_ = srv.Shutdown(shutdown)
			return
		case <-t.C:
			if err := reg.Heartbeat(ctx, nodeID); err == is04.ErrNotRegistered {
				_ = register(ctx)
			}
			if pub != nil {
				_ = pub.Publish(health.Status{NodeID: nodeID, Label: label, Status: "ok", MediaReady: true})
			}
		}
	}
}
