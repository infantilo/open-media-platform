// Command witness ist der Raft-Zeuge (Audit 2026-10-23 B5): ein leichter dritter Raft-Knoten für Installationen mit zwei Orchestratoren. Er hält keine Datenbank, startet
// keine Nodes und bedient keine Oberfläche — er stimmt nur bei Leader-Wahlen ab, sodass bei Ausfall eines Orchestrators die verbliebenen zwei von drei Stimmen eine
// Mehrheit haben. Er gehört auf einen eigenen Rechner (nicht auf einen der beiden Orchestrator-Rechner), sonst fällt mit diesem Rechner auch seine Stimme weg.
//
// Umgebung (wie beim Orchestrator): OMP_NODE_ID, OMP_RAFT_LISTEN (von den Orchestratoren erreichbare Adresse), OMP_RAFT_DATA_DIR, OMP_CLUSTER_PEERS (Gründungsliste mit
// allen drei Knoten, dieselbe wie bei den Orchestratoren) oder OMP_CLUSTER_JOIN=1 (wartet, bis ein Orchestrator ihn per POST /api/v1/cluster/join aufnimmt),
// optional OMP_MTLS_* für den Raft-Transport. OMP_WITNESS_LISTEN (Standard 127.0.0.1:8002): Adresse des Gesundheits-Endpunkts GET /healthz.
package main

import (
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/infantilo/openmediaplatform/orchestrator/internal/cluster"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/config"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/mtls"
)

func main() {
	slog.SetDefault(slog.New(slog.NewJSONHandler(os.Stdout, nil)))
	cfg := config.Load()
	peers, err := cluster.ParsePeers(cfg.ClusterPeers)
	if err != nil {
		slog.Error("OMP_CLUSTER_PEERS ungültig", "error", err)
		os.Exit(1)
	}
	node, err := cluster.New(cluster.Config{
		NodeID: cfg.ClusterNodeID, RaftAddr: cfg.ClusterRaftAddr, DataDir: cfg.ClusterDataDir,
		TLS:           mtls.Config{Enabled: cfg.MTLSEnabled, CertFile: cfg.MTLSCertFile, KeyFile: cfg.MTLSKeyFile, CAFile: cfg.MTLSCAFile},
		FoundingPeers: peers, SkipBootstrap: cfg.ClusterJoin, Witness: true,
	})
	if err != nil {
		slog.Error("Zeuge startet nicht", "error", err)
		os.Exit(1)
	}
	listen := os.Getenv("OMP_WITNESS_LISTEN")
	if listen == "" {
		listen = "127.0.0.1:8002"
	}
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(node.Status())
	})
	srv := &http.Server{Addr: listen, Handler: mux, ReadHeaderTimeout: 5 * time.Second}
	go func() {
		if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			slog.Error("Gesundheits-Endpunkt", "error", err)
		}
	}()
	slog.Info("Raft-Zeuge läuft", "node", cfg.ClusterNodeID, "raft", cfg.ClusterRaftAddr, "health", listen)

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	<-ctx.Done()
	shutdown, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_ = srv.Shutdown(shutdown)
	_ = node.Shutdown(shutdown)
}
