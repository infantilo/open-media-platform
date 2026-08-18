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

// defaultNatsURL zeigt auf den per `make up` gestarteten Drei-Knoten-
// NATS-Cluster (ARCHITECTURE.md §19.3 Punkt 7, UMSETZUNG.md D14) —
// dieselbe Adressliste/Konstante wie orchestrator/internal/config
// (eigenständige Go-Module, bewusste kleine Duplikation, gleiches Muster
// wie der Rest des projektweiten Wire-Formats). `nats.Connect` teilt die
// kommagetrennte Liste selbst auf.
const defaultNatsURL = "nats://localhost:4222,nats://localhost:4223,nats://localhost:4224"

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
	natsURL := envOr("OMP_NATS_URL", defaultNatsURL)
	statePath := envOr("OMP_HOST_AGENT_STATE_FILE", ".omp-host-agent-state.json")
	catalogPath := envOr("OMP_HOST_AGENT_CATALOG_PATH", "")
	ioPortsPath := envOr("OMP_HOST_AGENT_IO_PORTS_PATH", "")
	telemetryInterval := 5 * time.Second

	cat, err := catalog.Load(catalogPath)
	if err != nil {
		slog.Error("catalog load failed", "path", catalogPath, "error", err)
		os.Exit(1)
	}
	slog.Info("catalog loaded", "path", catalogPath, "entries", len(cat))

	// I/O-Karten-Inventar (ARCHITECTURE.md §6.1 Erweiterung 2026-07-10,
	// UMSETZUNG.md D13) — nur beim allerersten Registrieren gebraucht
	// (s. Aufrufstelle unten), hier schon geladen, damit ein falscher
	// Pfad den Agent-Start sofort sichtbar abbricht statt erst beim
	// ersten Registrierungsversuch.
	ioPorts, err := loadIOPorts(ioPortsPath)
	if err != nil {
		slog.Error("io ports load failed", "path", ioPortsPath, "error", err)
		os.Exit(1)
	}
	if ioPortsPath != "" {
		slog.Info("io port inventory loaded", "path", ioPortsPath, "ports", len(ioPorts))
	}

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
		hostID, err := register(orchestratorURL, token, label, hostname, ioPorts)
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

	// Kapitel 14 Teil 2 (docs/END-GOAL-FEATURES.md §14.3b): additive
	// Pro-Instanz-Messung im selben Tick-Takt wie die Host-Telemetrie —
	// ein eigener ProcessSampler statt Momentwerten, weil CPU% ein Delta
	// über zwei Ticks braucht (s. telemetry.ProcessSampler-Doku).
	procSampler := telemetry.NewProcessSampler()

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

		running := executor.Instances()
		keepPIDs := make(map[int]bool, len(running))
		for _, inst := range running {
			keepPIDs[inst.PID] = true
			cpu, rss, ok := procSampler.Sample(inst.PID)
			if !ok {
				continue
			}
			sample.Instances = append(sample.Instances, telemetry.InstanceSample{
				InstanceID: inst.InstanceID,
				CPUPercent: cpu,
				RSSBytes:   rss,
			})
		}
		procSampler.Prune(keepPIDs)

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

type ioPort struct {
	PortID    string `json:"portId"`
	CardType  string `json:"cardType"`
	Direction string `json:"direction"`
	Label     string `json:"label,omitempty"`
}

type registerRequest struct {
	Token        string          `json:"token"`
	Label        string          `json:"label"`
	Hostname     string          `json:"hostname"`
	Capabilities json.RawMessage `json:"capabilities"`
	IOPorts      []ioPort        `json:"ioPorts,omitempty"`
}

type registerResponse struct {
	HostID string `json:"hostId"`
}

// loadIOPorts liest das I/O-Karten-Inventar dieses Hosts aus einer
// JSON-Datei (ARCHITECTURE.md §6.1 Erweiterung 2026-07-10, §18.4,
// UMSETZUNG.md D13) — bewusst KONFIGURIERT statt automatisch erkannt:
// herstellerspezifische Laufzeit-Erkennung (z. B. Blackmagic DeckLink
// über dessen SDK) bräuchte echte Hardware zum Testen, die auf der
// Single-Host-Dev-Maschine nicht existiert (UMSETZUNG.md §0 Punkt 7 —
// "nichts einbauen, das nur mit Broadcast-Hardware testbar wäre").
// Gleiches Muster wie catalog.Load: Pfad leer = kein Inventar
// (unverändertes Verhalten vor D13), keine Datei am Pfad ist ein
// Fehler (ein konfigurierter, aber falscher Pfad soll aber nicht still
// ignoriert werden). Eine echte SDK-Erkennung kann diese Datei später
// ersetzen/generieren, ohne das Registrierungs-Wireformat zu ändern.
func loadIOPorts(path string) ([]ioPort, error) {
	if path == "" {
		return nil, nil
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("read io ports file: %w", err)
	}
	var ports []ioPort
	if err := json.Unmarshal(data, &ports); err != nil {
		return nil, fmt.Errorf("parse io ports file: %w", err)
	}
	return ports, nil
}

// register meldet den Host einmalig beim Orchestrator an (§18.3 Punkt
// 3) — capabilities ist bewusst minimal (OS/Arch/CPU-Zahl).
func register(orchestratorURL, token, label, hostname string, ioPorts []ioPort) (string, error) {
	capabilities, err := json.Marshal(map[string]any{
		"os":     runtime.GOOS,
		"arch":   runtime.GOARCH,
		"numCPU": runtime.NumCPU(),
	})
	if err != nil {
		return "", err
	}

	body, err := json.Marshal(registerRequest{Token: token, Label: label, Hostname: hostname, Capabilities: capabilities, IOPorts: ioPorts})
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
