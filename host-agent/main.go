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
// Registrierung. Die eigentliche Sicherheitsgrenze für den
// Kommandokanal ist der **agent-lokale Katalog** (internal/catalog):
// ein Start-Kommando kann nur einen dort freigegebenen Node-Typ
// auslösen, nie einen beliebigen Befehl — dieselbe Grenze wie beim
// lokalen Orchestrator-Launcher (C8), nur pro Host statt zentral.
//
// Telemetrie/Kommandokanal (NATS) selbst können seit ARCHITECTURE.md
// §20.4 optional per mTLS verschlüsselt werden (OMP_NATS_TLS_ENABLED,
// s. loadNatsTLSConfig unten + `make nats-tls-up`) — Default weiterhin
// **aus** (Klartext wie zuvor), additiv wie überall sonst im Projekt.
package main

import (
	"bytes"
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"runtime"
	"strconv"
	"syscall"
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

// loadNatsTLSConfig baut die *tls.Config für eine mTLS-gesicherte
// NATS-Verbindung (ARCHITECTURE.md §20.4 Restlücke "NATS-
// Verschlüsselung") — liefert (nil, nil), solange
// OMP_NATS_TLS_ENABLED nicht gesetzt ist, dann verbindet nats.Connect
// unten unverändert per Klartext. Eigene, kleine Kopie von
// orchestrator/internal/mtls.ClientTLSConfig statt eines Imports über
// die Modulgrenze hinweg (host-agent ist ein eigenständiges Go-Modul,
// gleiches "bewusste Duplikation"-Muster wie defaultNatsURL oben und
// wie orchestrator/internal/mtls' eigene Moduldoku es für den
// Node-seitigen Fall bereits beschreibt). Zertifikat ist bewusst EIN
// geteiltes "nats-client"-Zertifikat für Orchestrator/host-agent/jede
// Rust-Node-Instanz (Scope-Vereinfachung, keine echte Pro-Instanz-
// Identität), nicht ein host-agent-eigenes.
func loadNatsTLSConfig() (*tls.Config, error) {
	if enabled, _ := strconv.ParseBool(envOr("OMP_NATS_TLS_ENABLED", "false")); !enabled {
		return nil, nil
	}
	certFile := envOr("OMP_NATS_TLS_CERT_FILE", "../.run/mtls/nats-client.crt")
	keyFile := envOr("OMP_NATS_TLS_KEY_FILE", "../.run/mtls/nats-client.key")
	caFile := envOr("OMP_NATS_TLS_CA_FILE", "../.run/mtls/root_ca.crt")

	cert, err := tls.LoadX509KeyPair(certFile, keyFile)
	if err != nil {
		return nil, fmt.Errorf("nats tls: load client cert/key: %w", err)
	}
	caPEM, err := os.ReadFile(caFile)
	if err != nil {
		return nil, fmt.Errorf("nats tls: read CA file: %w", err)
	}
	caPool := x509.NewCertPool()
	if !caPool.AppendCertsFromPEM(caPEM) {
		return nil, fmt.Errorf("nats tls: no valid certificates found in %s", caFile)
	}
	return &tls.Config{
		Certificates: []tls.Certificate{cert},
		RootCAs:      caPool,
		MinVersion:   tls.VersionTLS12,
	}, nil
}

func main() {
	slog.SetDefault(slog.New(slog.NewJSONHandler(os.Stdout, nil)))

	orchestratorURL := envOr("OMP_ORCHESTRATOR_URL", "http://localhost:8000")
	registryURL := envOr("OMP_REGISTRY_URL", "http://localhost:8010")
	natsURL := envOr("OMP_NATS_URL", defaultNatsURL)
	statePath := envOr("OMP_HOST_AGENT_STATE_FILE", ".omp-host-agent-state.json")
	catalogPath := envOr("OMP_HOST_AGENT_CATALOG_PATH", "")
	ioPortsPath := envOr("OMP_HOST_AGENT_IO_PORTS_PATH", "")
	// Netzwerk-Interface für die Bandbreiten-Telemetrie (Nutzerauftrag
	// 2026-09-02) — bewusst kein Default/Auto-Erkennung, s.
	// telemetry.NetSample-Doku. Leer = Netz-Telemetrie deaktiviert
	// (Sample.Net bleibt nil), unverändertes Verhalten gegenüber vorher.
	netIface := envOr("OMP_HOST_AGENT_NET_IFACE", "")
	// GPU-Index für die Auslastungs-/Speicher-Telemetrie (Nutzerauftrag
	// 2026-09-17, "GPU-Telemetrie im Placement jetzt umsetzen") — bewusst
	// kein Default/Auto-Erkennung, s. telemetry.GpuSample-Doku. Leer =
	// GPU-Telemetrie deaktiviert (gpuIndex bleibt -1, Sample.Gpu bleibt
	// nil), gleiches Muster wie netIface.
	gpuIndex := -1
	if v := envOr("OMP_HOST_AGENT_GPU_INDEX", ""); v != "" {
		parsed, err := strconv.Atoi(v)
		if err != nil {
			slog.Error("invalid OMP_HOST_AGENT_GPU_INDEX", "value", v, "error", err)
			os.Exit(1)
		}
		gpuIndex = parsed
	}
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

	natsTLSConfig, err := loadNatsTLSConfig()
	if err != nil {
		slog.Error("nats tls config failed", "error", err)
		os.Exit(1)
	}
	natsOpts := []nats.Option{
		nats.Name("omp-host-agent"),
		nats.RetryOnFailedConnect(true),
		nats.MaxReconnects(-1),
	}
	if natsTLSConfig != nil {
		natsOpts = append(natsOpts, nats.Secure(natsTLSConfig))
	}
	nc, err := nats.Connect(natsURL, natsOpts...)
	if err != nil {
		slog.Error("nats connect failed", "error", err)
		os.Exit(1)
	}
	defer nc.Close()

	executor := commands.NewExecutor(cat, registryURL, natsURL, orchestratorURL, st.HostID, nc)
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
	if netIface != "" {
		slog.Info("network bandwidth telemetry enabled", "iface", netIface)
	} else {
		slog.Info("network bandwidth telemetry disabled (OMP_HOST_AGENT_NET_IFACE unset)")
	}
	if gpuIndex >= 0 {
		slog.Info("gpu telemetry enabled", "index", gpuIndex)
	} else {
		slog.Info("gpu telemetry disabled (OMP_HOST_AGENT_GPU_INDEX unset)")
	}

	// Kapitel 14 Teil 2 (docs/END-GOAL-FEATURES.md §14.3b): additive
	// Pro-Instanz-Messung im selben Tick-Takt wie die Host-Telemetrie —
	// ein eigener ProcessSampler statt Momentwerten, weil CPU% ein Delta
	// über zwei Ticks braucht (s. telemetry.ProcessSampler-Doku).
	procSampler := telemetry.NewProcessSampler()

	ticker := time.NewTicker(telemetryInterval)
	defer ticker.Stop()
	// Absichtliches Beenden (SIGTERM/SIGINT) meldet sich per Goodbye-
	// Nachricht ab, damit der Orchestrator es von einem Absturz/
	// Netzausfall unterscheiden kann (telemetry.Sample.Goodbye).
	sigCh := make(chan os.Signal, 1)
	signal.Notify(sigCh, syscall.SIGTERM, syscall.SIGINT)
	for {
		select {
		case <-ticker.C:
		case sig := <-sigCh:
			slog.Info("shutdown requested, sending goodbye", "signal", sig.String())
			if payload, err := json.Marshal(telemetry.Sample{Goodbye: true}); err == nil {
				if err := nc.Publish(subject, payload); err != nil {
					slog.Warn("goodbye publish failed", "error", err)
				}
			}
			if err := nc.FlushTimeout(2 * time.Second); err != nil {
				slog.Warn("goodbye flush failed", "error", err)
			}
			return
		}
		// Take() blockiert kurz zur CPU%-Messung (s. telemetry.Take) —
		// bewusst deutlich kürzer als telemetryInterval, damit der
		// Tick-Takt nicht spürbar driftet.
		sample, err := telemetry.Take(200*time.Millisecond, netIface)
		if err != nil {
			slog.Warn("telemetry sample failed", "error", err)
			continue
		}

		if gpuIndex >= 0 {
			// Eigener, kurzer Timeout statt telemetryInterval: TakeGPU
			// braucht (anders als Take()) kein Sleep-Fenster, ein
			// hängendes nvidia-smi soll trotzdem nicht den Tick blockieren
			// (s. TakeGPU-Doku).
			gpuCtx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
			if gpu, ok := telemetry.TakeGPU(gpuCtx, gpuIndex); ok {
				sample.Gpu = &gpu
			}
			cancel()
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
