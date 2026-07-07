package main

import (
	"context"
	"flag"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/infantilo/openmediaplatform/nodes/mock/internal/connection"
	"github.com/infantilo/openmediaplatform/nodes/mock/internal/descriptor"
	"github.com/infantilo/openmediaplatform/nodes/mock/internal/health"
	"github.com/infantilo/openmediaplatform/nodes/mock/internal/idgen"
	"github.com/infantilo/openmediaplatform/nodes/mock/internal/is04"
)

// heartbeatInterval gilt sowohl für den IS-04-Heartbeat als auch für die
// NATS-Health-Publikation (UMSETZUNG.md A7: "alle 5s"), deutlich unter
// registration_expiry_interval (12s, deploy/nmos/registry.json).
const heartbeatInterval = 5 * time.Second

func main() {
	slog.SetDefault(slog.New(slog.NewJSONHandler(os.Stdout, nil)))

	label := flag.String("label", "Mock Node", "Label der simulierten Node")
	senders := flag.Int("senders", 1, "Anzahl simulierter Sender")
	receivers := flag.Int("receivers", 1, "Anzahl simulierter Receiver")
	port := flag.Int("port", 9001, "Port des Mock-Node-HTTP-API (descriptor.json, params)")
	flag.Parse()

	registryURL := getEnv("OMP_REGISTRY_URL", "http://localhost:8010")
	natsURL := getEnv("OMP_NATS_URL", "nats://localhost:4222")
	host := getEnv("OMP_MOCK_HOST", "127.0.0.1")

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	nodeID := idgen.NewV4()
	deviceID := idgen.NewV4()

	senderIDs := make([]string, *senders)
	for i := range senderIDs {
		senderIDs[i] = idgen.NewV4()
	}
	receiverIDs := make([]string, *receivers)
	for i := range receiverIDs {
		receiverIDs[i] = idgen.NewV4()
	}

	node := is04.NewNode(nodeID, *label, host, *port)
	device := is04.NewDevice(deviceID, *label+" Device", nodeID, senderIDs, receiverIDs)

	senderResources := make([]is04.Sender, len(senderIDs))
	for i, id := range senderIDs {
		senderResources[i] = is04.NewSender(id, fmt.Sprintf("%s Sender %d", *label, i+1), deviceID)
	}
	receiverResources := make([]is04.Receiver, len(receiverIDs))
	for i, id := range receiverIDs {
		receiverResources[i] = is04.NewReceiver(id, fmt.Sprintf("%s Receiver %d", *label, i+1), deviceID)
	}

	registryClient := is04.NewClient(registryURL)

	registerAll := func(ctx context.Context) error {
		if err := registryClient.Register(ctx, "node", node); err != nil {
			return err
		}
		if err := registryClient.Register(ctx, "device", device); err != nil {
			return err
		}
		for _, s := range senderResources {
			if err := registryClient.Register(ctx, "sender", s); err != nil {
				return err
			}
		}
		for _, r := range receiverResources {
			if err := registryClient.Register(ctx, "receiver", r); err != nil {
				return err
			}
		}
		return nil
	}

	store := descriptor.NewStore(*label)
	connStore := connection.NewReceiverStore(receiverIDs)

	mux := http.NewServeMux()
	mux.Handle("/", descriptor.Handler(store))
	mux.Handle("/x-nmos/connection/", connection.Handler(connStore))

	go func() {
		addr := fmt.Sprintf(":%d", *port)
		slog.Info("mock node http api listening", "addr", addr)
		if err := http.ListenAndServe(addr, mux); err != nil {
			slog.Error("mock node http api stopped", "error", err)
		}
	}()

	publisher, err := health.Connect(natsURL)
	if err != nil {
		slog.Error("nats connect failed, continuing without health publishing", "error", err)
	} else {
		defer publisher.Close()
	}

	slog.Info("registering mock node",
		"node_id", nodeID, "label", *label, "senders", *senders, "receivers", *receivers)

	registerWithRetry(ctx, registerAll)

	slog.Info("mock node registered", "node_id", nodeID)

	ticker := time.NewTicker(heartbeatInterval)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			slog.Info("mock node shutting down", "node_id", nodeID)
			return
		case <-ticker.C:
			if err := registryClient.Heartbeat(ctx, nodeID); err != nil {
				slog.Warn("heartbeat failed", "error", err)
				if err == is04.ErrNotRegistered {
					registerWithRetry(ctx, registerAll)
				}
			}
			if publisher != nil {
				status := health.Status{
					NodeID:    nodeID,
					Label:     *label,
					Status:    "ok",
					Senders:   *senders,
					Receivers: *receivers,
				}
				if err := publisher.Publish(status); err != nil {
					slog.Warn("health publish failed", "error", err)
				}
			}
		}
	}
}

// registerWithRetry versucht register bis zum Erfolg oder bis ctx endet;
// verhindert, dass eine kurzzeitig nicht erreichbare Registry den
// Mock-Node abstürzen lässt (Resilienz-Linie wie internal/registry.Poller
// im Orchestrator).
func registerWithRetry(ctx context.Context, register func(context.Context) error) {
	for {
		if err := register(ctx); err == nil {
			return
		} else {
			slog.Warn("registration failed, retrying", "error", err)
		}
		select {
		case <-ctx.Done():
			return
		case <-time.After(2 * time.Second):
		}
	}
}

func getEnv(key, fallback string) string {
	if v, ok := os.LookupEnv(key); ok && v != "" {
		return v
	}
	return fallback
}
