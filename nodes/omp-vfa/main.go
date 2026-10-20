// omp-vfa — „Video folgt Audio“: schaltet den Bildmischer auf die Kamera, die
// die gerade sprechende Person zeigt. Pegel kommen vom Tonmischer, Gesichter
// von omp-vfa-vision (NATS). Siehe UMSETZUNG.md Kapitel 46.
package main

import (
	"context"
	"embed"
	"encoding/json"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/nats-io/nats.go"

	"github.com/infantilo/openmediaplatform/nodes/omp-vfa/internal/engine"
	"github.com/infantilo/openmediaplatform/nodes/omp-vfa/internal/health"
	"github.com/infantilo/openmediaplatform/nodes/omp-vfa/internal/idgen"
	"github.com/infantilo/openmediaplatform/nodes/omp-vfa/internal/is04"
	"github.com/infantilo/openmediaplatform/nodes/omp-vfa/internal/orch"
	"github.com/infantilo/openmediaplatform/nodes/omp-vfa/internal/service"
)

//go:embed ui/manifest.json ui/bundle.js
var uiFiles embed.FS

func main() {
	slog.SetDefault(slog.New(slog.NewJSONHandler(os.Stdout, nil)))
	label := env("OMP_LABEL", "Video folgt Audio")
	host := env("OMP_HOST", "127.0.0.1")
	port := 9460
	fmt.Sscanf(env("OMP_PORT", "9460"), "%d", &port)
	registryURL := env("OMP_REGISTRY_URL", "http://127.0.0.1:8010")
	natsURL := env("OMP_NATS_URL", "nats://localhost:4222")

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	nc, err := nats.Connect(natsURL, nats.MaxReconnects(-1), nats.ReconnectWait(2*time.Second))
	if err != nil {
		slog.Error("nats", "error", err)
		os.Exit(1)
	}
	defer nc.Close()

	o := orch.New(env("OMP_ORCHESTRATOR_URL", "http://localhost:8000"), env("OMP_INSTANCE_ID", ""), env("OMP_LAUNCH_SECRET", ""))
	svc := service.New(o, nc, env("OMP_VFA_DATA", "data/omp-vfa.json"))
	go svc.Run(ctx)

	mux := http.NewServeMux()
	registerAPI(mux, svc)
	// OMP_PORT=0 (Launcher): freien Port wählen und den echten melden.
	ln, lerr := net.Listen("tcp", fmt.Sprintf(":%d", port))
	if lerr != nil {
		slog.Error("listen", "error", lerr)
		os.Exit(1)
	}
	port = ln.Addr().(*net.TCPAddr).Port
	srv := &http.Server{Handler: cors(mux)}
	go func() {
		if err := srv.Serve(ln); err != http.ErrServerClosed {
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
		if err := register(ctx); err == nil {
			break
		} else {
			slog.Warn("registrierung", "error", err)
		}
		select {
		case <-ctx.Done():
		case <-time.After(2 * time.Second):
		}
	}
	pub, err := health.Connect(natsURL)
	if err == nil {
		defer pub.Close()
	}
	slog.Info("omp-vfa läuft", "node_id", nodeID, "port", port)
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

func registerAPI(mux *http.ServeMux, svc *service.Service) {
	mux.HandleFunc("GET /descriptor.json", func(w http.ResponseWriter, r *http.Request) {
		str := func(n string) map[string]any { return map[string]any{"name": n, "type": "string"} }
		writeJSON(w, 200, map[string]any{
			"parameters": []map[string]any{
				{"name": "status", "type": "string", "readonly": true},
				{"name": "config", "type": "string", "readonly": true},
				{"name": "channels", "type": "string", "readonly": true},
			},
			"methods": []map[string]any{
				{"name": "setConfig", "args": []map[string]any{str("json")}},
				{"name": "learnStart", "args": []map[string]any{str("personId")}},
				{"name": "learnCancel", "args": []map[string]any{}},
				{"name": "confirmShots", "args": []map[string]any{str("personId"), str("shots")}},
				{"name": "testCut", "args": []map[string]any{str("cameraId")}},
			},
		})
	})
	mux.HandleFunc("GET /params/{name}", func(w http.ResponseWriter, r *http.Request) {
		switch r.PathValue("name") {
		case "status":
			writeJSON(w, 200, map[string]any{"value": svc.Status()})
		case "config":
			writeJSON(w, 200, map[string]any{"value": svc.Config()})
		case "channels":
			ch, err := svc.Channels(r.Context())
			if err != nil {
				http.Error(w, err.Error(), 502)
				return
			}
			writeJSON(w, 200, map[string]any{"value": ch})
		default:
			http.NotFound(w, r)
		}
	})
	mux.HandleFunc("POST /methods/{name}", func(w http.ResponseWriter, r *http.Request) {
		var a map[string]any
		_ = json.NewDecoder(r.Body).Decode(&a)
		s := func(k string) string { v, _ := a[k].(string); return v }
		var err error
		switch r.PathValue("name") {
		case "setConfig":
			cfg := engine.DefaultConfig()
			if err = json.Unmarshal([]byte(s("json")), &cfg); err == nil {
				svc.SetConfig(cfg)
			}
		case "learnStart":
			err = svc.LearnStart(s("personId"))
		case "learnCancel":
			svc.LearnCancel()
		case "confirmShots":
			var shots []engine.Shot
			if err = json.Unmarshal([]byte(s("shots")), &shots); err == nil {
				err = svc.ConfirmShots(s("personId"), shots)
			}
		case "testCut":
			err = svc.CutTo(r.Context(), svc.Config(), s("cameraId"))
		default:
			http.NotFound(w, r)
			return
		}
		if err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		writeJSON(w, 200, map[string]bool{"ok": true})
	})
	for _, f := range []struct{ path, name, ct string }{
		{"/ui/manifest.json", "ui/manifest.json", "application/json"},
		{"/ui/bundle.js", "ui/bundle.js", "text/javascript"},
	} {
		mux.HandleFunc("GET "+f.path, func(w http.ResponseWriter, r *http.Request) {
			b, _ := uiFiles.ReadFile(f.name)
			w.Header().Set("Content-Type", f.ct)
			w.Header().Set("Cache-Control", "no-store")
			w.Write(b)
		})
	}
}

func cors(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", "*")
		next.ServeHTTP(w, r)
	})
}

func writeJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(v)
}

func env(k, def string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return def
}
