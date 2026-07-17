// omp-host-agent (ARCHITECTURE.md §18, UMSETZUNG.md D6): meldet einen
// Host über ein einmaliges Bootstrap-Token beim Orchestrator an,
// veröffentlicht danach periodisch CPU/RAM-Telemetrie über NATS
// (omp.host.<hostId>.metrics) und führt Start-/Stop-Kommandos für
// Node-Instanzen auf diesem Host aus (omp.host.<hostId>.cmd, §18.5,
// D6 Teil 2 — internal/commands). Kein NMOS-Node selbst (§18.1:
// "produziert/konsumiert keine Medien, kein IS-12/14-Descriptor").
//
// **Scope-Entscheidungen** (dokumentiert, s. docs/decisions.md D6 Teil
// 1/2): kein mTLS-Zertifikats-Bootstrap über step-ca (§18.3 Punkt 3) —
// das Bootstrap-Token bleibt die Zugriffskontrolle für die
// Registrierung; Telemetrie **und** Kommandokanal laufen danach
// unverschlüsselt/unsigniert über NATS, wie der bestehende
// Node-Health-Kanal (gleicher Sicherheitsstand wie der Rest des Stacks
// ohne aktiviertes mTLS). Die eigentliche Sicherheitsgrenze für den
// Kommandokanal ist der **agent-lokale Katalog** (internal/catalog):
// ein Start-Kommando kann nur einen dort freigegebenen Node-Typ
// auslösen, nie einen beliebigen Befehl — dieselbe Grenze wie beim
// lokalen Orchestrator-Launcher (C8), nur pro Host statt zentral.
package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"runtime"
	"time"

	"github.com/nats-io/nats.go"

	"github.com/infantilo/openmediaplatform/host-agent/internal/catalog"
	"github.com/infantilo/openmediaplatform/host-agent/internal/commands"
	"github.com/infantilo/openmediaplatform/host-agent/internal/state"
	"github.com/infantilo/openmediaplatform/host-agent/internal/telemetry"
)

func envOr(key, fallback string) string {
	if v, ok := os.LookupEnv(key); ok && v != "" {
		return v
	}
	return fallback
}

func main() {
	slog.SetDefault(slog.New(slog.NewJSONHandler(os.Stdout, nil)))

	orchestratorURL := envOr("OMP_ORCHESTRATOR_URL", "http://localhost:8000")
	registryURL := envOr("OMP_REGISTRY_URL", "http://localhost:8010")
	natsURL := envOr("OMP_NATS_URL", "nats://localhost:4222")
	statePath := envOr("OMP_HOST_AGENT_STATE_FILE", ".omp-host-agent-state.json")
	catalogPath := envOr("OMP_HOST_AGENT_CATALOG_PATH", "")
	telemetryInterval := 5 * time.Second

	cat, err := catalog.Load(catalogPath)
	if err != nil {
		slog.Error("catalog load failed", "path", catalogPath, "error", err)
		os.Exit(1)
	}
	slog.Info("catalog loaded", "path", catalogPath, "entries", len(cat))

	hostname, err := os.Hostname()
	if err != nil {
		slog.Error("hostname lookup failed", "error", err)
		os.Exit(1)
	}
	label := envOr("OMP_HOST_AGENT_LABEL", hostname)

	st, registered, err := state.Load(statePath)
	if err != nil {
		slog.Error("state load failed", "path", statePath, "error", err)
		os.Exit(1)
	}

	if !registered {
		token := os.Getenv("OMP_HOST_AGENT_BOOTSTRAP_TOKEN")
		if token == "" {
			slog.Error("not registered yet and OMP_HOST_AGENT_BOOTSTRAP_TOKEN is unset — obtain a token via POST /api/v1/admin/hosts/bootstrap-tokens")
			os.Exit(1)
		}
		hostID, err := register(orchestratorURL, token, label, hostname)
		if err != nil {
			slog.Error("registration failed", "error", err)
			os.Exit(1)
		}
		st = state.State{HostID: hostID, Label: label}
		if err := state.Save(statePath, st); err != nil {
			slog.Error("state save failed", "path", statePath, "error", err)
			os.Exit(1)
		}
		slog.Info("registered", "host_id", st.HostID, "label", label)
	} else {
		slog.Info("already registered, resuming telemetry", "host_id", st.HostID, "label", st.Label)
	}

	nc, err := nats.Connect(natsURL,
		nats.Name("omp-host-agent"),
		nats.RetryOnFailedConnect(true),
		nats.MaxReconnects(-1),
	)
	if err != nil {
		slog.Error("nats connect failed", "error", err)
		os.Exit(1)
	}
	defer nc.Close()

	executor := commands.NewExecutor(cat, registryURL, natsURL, st.HostID, nc)
	cmdSubject := fmt.Sprintf("omp.host.%s.cmd", st.HostID)
	cmdSub, err := nc.Subscribe(cmdSubject, func(msg *nats.Msg) {
		req, err := commands.DecodeRequest(msg.Data)
		if err != nil {
			_ = msg.Respond(commands.EncodeResponse(commands.Response{OK: false, Error: "invalid request: " + err.Error()}))
			return
		}
		slog.Info("command received", "action", req.Action, "type", req.Type, "instance_id", req.InstanceID)
		resp := executor.Handle(req)
		if !resp.OK {
			slog.Warn("command failed", "action", req.Action, "instance_id", req.InstanceID, "error", resp.Error)
		}
		_ = msg.Respond(commands.EncodeResponse(resp))
	})
	if err != nil {
		slog.Error("command subscribe failed", "subject", cmdSubject, "error", err)
		os.Exit(1)
	}
	defer cmdSub.Unsubscribe()
	slog.Info("listening for commands", "subject", cmdSubject)

	subject := fmt.Sprintf("omp.host.%s.metrics", st.HostID)
	slog.Info("publishing telemetry", "subject", subject, "interval", telemetryInterval)

	ticker := time.NewTicker(telemetryInterval)
	defer ticker.Stop()
	for range ticker.C {
		// Take() blockiert kurz zur CPU%-Messung (s. telemetry.Take) —
		// bewusst deutlich kürzer als telemetryInterval, damit der
		// Tick-Takt nicht spürbar driftet.
		sample, err := telemetry.Take(200 * time.Millisecond)
		if err != nil {
			slog.Warn("telemetry sample failed", "error", err)
			continue
		}
		payload, err := json.Marshal(sample)
		if err != nil {
			slog.Warn("telemetry marshal failed", "error", err)
			continue
		}
		if err := nc.Publish(subject, payload); err != nil {
			slog.Warn("telemetry publish failed", "error", err)
		}
	}
}

type registerRequest struct {
	Token        string          `json:"token"`
	Label        string          `json:"label"`
	Hostname     string          `json:"hostname"`
	Capabilities json.RawMessage `json:"capabilities"`
}

type registerResponse struct {
	HostID string `json:"hostId"`
}

// register meldet den Host einmalig beim Orchestrator an (§18.3 Punkt
// 3) — capabilities ist bewusst minimal (OS/Arch/CPU-Zahl); das
// I/O-Karten-Inventar aus §18.4 ist dokumentierte Folgearbeit
// (herstellerspezifische Erkennung, docs/decisions.md D6 Teil 1).
func register(orchestratorURL, token, label, hostname string) (string, error) {
	capabilities, err := json.Marshal(map[string]any{
		"os":     runtime.GOOS,
		"arch":   runtime.GOARCH,
		"numCPU": runtime.NumCPU(),
	})
	if err != nil {
		return "", err
	}

	body, err := json.Marshal(registerRequest{Token: token, Label: label, Hostname: hostname, Capabilities: capabilities})
	if err != nil {
		return "", err
	}

	resp, err := http.Post(orchestratorURL+"/api/v1/hosts/register", "application/json", bytes.NewReader(body))
	if err != nil {
		return "", fmt.Errorf("register: request failed: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusCreated {
		return "", fmt.Errorf("register: orchestrator returned %s", resp.Status)
	}
	var parsed registerResponse
	if err := json.NewDecoder(resp.Body).Decode(&parsed); err != nil {
		return "", fmt.Errorf("register: decode response: %w", err)
	}
	if parsed.HostID == "" {
		return "", fmt.Errorf("register: orchestrator did not return a hostId")
	}
	return parsed.HostID, nil
}
