// omp-vfa-vision zählt Gesichter je Kamera und meldet Position und Größe per
// NATS (`vfa.vision.state`) an omp-vfa. Es bestimmt keine Identitäten.
package main

import (
	"context"
	"encoding/json"
	"log/slog"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/nats-io/nats.go"
)

const (
	subject       = "vfa.vision.state"
	configSubject = "vfa.vision.config"
)

// State ist die NATS-Nachricht je Kamera und Abtastung.
type State struct {
	CameraID string `json:"camera_id"`
	Faces    []Face `json:"faces"`
}

func main() {
	slog.SetDefault(slog.New(slog.NewJSONHandler(os.Stdout, nil)))

	natsURL := env("OMP_NATS_URL", "nats://localhost:4222")
	interval := time.Duration(envInt("OMP_VFA_INTERVAL_MS", 300)) * time.Millisecond
	minQ := float32(envInt("OMP_VFA_MIN_QUALITY", 5))
	// Format: "cam-1=http://host:port/preview,cam-2=…"
	cams := parseCameras(env("OMP_VFA_CAMERAS", ""))
	sim := env("OMP_VFA_SIM", "") == "1"

	det, err := NewDetector(minQ)
	if err != nil {
		slog.Error("detektor", "error", err)
		os.Exit(1)
	}
	nc, err := nats.Connect(natsURL, nats.MaxReconnects(-1), nats.ReconnectWait(2*time.Second))
	if err != nil {
		slog.Error("nats", "error", err)
		os.Exit(1)
	}
	defer nc.Close()

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	var wg sync.WaitGroup
	if sim {
		wg.Add(1)
		go func() { defer wg.Done(); runSim(ctx, nc, interval) }()
	}
	// Kameras kommen normalerweise von omp-vfa (`vfa.vision.config`); die
	// Umgebungsvariable bleibt als feste Vorgabe für Tests ohne omp-vfa.
	set := newCameraSet(ctx, nc, det, interval)
	set.apply(cams)
	if _, err := nc.Subscribe(configSubject, func(m *nats.Msg) { set.onConfig(m.Data) }); err != nil {
		slog.Error("nats subscribe", "error", err)
		os.Exit(1)
	}
	slog.Info("omp-vfa-vision läuft", "intervall", interval, "sim", sim)
	<-ctx.Done()
	wg.Wait()
	set.stopAll()
}

// runCamera: Bild holen → Gesichter → publizieren. Eine Kamera ohne Bild
// (Quelle weg) meldet nichts statt „0 Gesichter“, damit omp-vfa den Ausfall
// vom leeren Bild unterscheiden kann (Zustand läuft dort nach Zeit ab).
func runCamera(ctx context.Context, nc *nats.Conn, det *Detector, id string, src FrameSource, every time.Duration) {
	t := time.NewTicker(every)
	defer t.Stop()
	failing := false
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
		}
		data, err := src.Frame(ctx)
		if err == nil {
			var faces []Face
			if faces, err = det.DetectJPEG(data); err == nil {
				failing = false
				publish(nc, State{CameraID: id, Faces: faces})
				continue
			}
		}
		if !failing {
			slog.Warn("kamera ohne Bild", "camera", id, "error", err)
			failing = true
		}
	}
}

func publish(nc *nats.Conn, s State) {
	if s.Faces == nil {
		s.Faces = []Face{}
	}
	b, _ := json.Marshal(s)
	if err := nc.Publish(subject, b); err != nil {
		slog.Warn("publish", "error", err)
	}
}

// runSim ersetzt die Kameras durch ein Drehbuch (Inbetriebnahme ohne Studio):
// zwei Kameras, die Person wandert alle 6 s von Kamera 1 zu Kamera 2.
func runSim(ctx context.Context, nc *nats.Conn, every time.Duration) {
	t := time.NewTicker(every)
	defer t.Stop()
	for n := 0; ; n++ {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
		}
		onFirst := (n*int(every/time.Millisecond)/6000)%2 == 0
		a, b := []Face{}, []Face{}
		if onFirst {
			a = []Face{{CenterX: 0.25, CenterY: 0.4, SizePercent: 15}}
		} else {
			b = []Face{{CenterX: 0.7, CenterY: 0.4, SizePercent: 22}}
		}
		publish(nc, State{CameraID: "cam-1", Faces: a})
		publish(nc, State{CameraID: "cam-2", Faces: b})
	}
}

func parseCameras(s string) map[string]string {
	out := map[string]string{}
	for _, part := range strings.Split(s, ",") {
		id, url, ok := strings.Cut(strings.TrimSpace(part), "=")
		if ok && id != "" && url != "" {
			out[id] = url
		}
	}
	return out
}

func env(k, def string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return def
}

func envInt(k string, def int) int {
	if n, err := strconv.Atoi(os.Getenv(k)); err == nil && n > 0 {
		return n
	}
	return def
}
