package main

import (
	"context"
	"encoding/json"
	"log/slog"
	"sync"
	"time"

	"github.com/nats-io/nats.go"
)

// cameraSet hält je Kamera eine Erkennungsschleife und gleicht sie mit der
// zuletzt gemeldeten Liste ab: neue Kameras starten, geänderte URLs werden
// neu aufgebaut, entfallene beendet.
type cameraSet struct {
	ctx      context.Context
	nc       *nats.Conn
	det      *Detector
	interval time.Duration
	mu       sync.Mutex
	running  map[string]*runningCam
}

type runningCam struct {
	url    string
	cancel context.CancelFunc
	done   chan struct{}
}

func newCameraSet(ctx context.Context, nc *nats.Conn, det *Detector, interval time.Duration) *cameraSet {
	return &cameraSet{ctx: ctx, nc: nc, det: det, interval: interval, running: map[string]*runningCam{}}
}

// onConfig verarbeitet `{"cameras":[{"id":"cam-1","url":"http://…/preview"}]}`.
func (s *cameraSet) onConfig(data []byte) {
	var c struct {
		Cameras []struct {
			ID  string `json:"id"`
			URL string `json:"url"`
		} `json:"cameras"`
	}
	if json.Unmarshal(data, &c) != nil {
		return
	}
	want := map[string]string{}
	for _, cam := range c.Cameras {
		want[cam.ID] = cam.URL
	}
	s.apply(want)
}

func (s *cameraSet) apply(want map[string]string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for id, rc := range s.running {
		if u, ok := want[id]; !ok || u != rc.url {
			rc.cancel()
			<-rc.done
			delete(s.running, id)
			status.remove(id)
			slog.Info("kamera entfernt", "camera", id)
		}
	}
	for id, url := range want {
		if _, ok := s.running[id]; ok {
			continue
		}
		cctx, cancel := context.WithCancel(s.ctx)
		rc := &runningCam{url: url, cancel: cancel, done: make(chan struct{})}
		s.running[id] = rc
		status.add(id, url)
		go func() {
			defer close(rc.done)
			runCamera(cctx, s.nc, s.det, id, newPreviewSource(url), s.interval)
		}()
		slog.Info("kamera gestartet", "camera", id, "url", url)
	}
}

func (s *cameraSet) stopAll() { s.apply(map[string]string{}) }
