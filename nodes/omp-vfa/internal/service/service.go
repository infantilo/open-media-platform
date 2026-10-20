// Package service verbindet Engine, Vision-Zustand (NATS), Tonmischer-Pegel
// und Bildmischer-Steuerung.
package service

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"math"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/nats-io/nats.go"

	"github.com/infantilo/openmediaplatform/nodes/omp-vfa/internal/engine"
	"github.com/infantilo/openmediaplatform/nodes/omp-vfa/internal/orch"
)

const (
	visionSubject = "vfa.vision.state"
	configSubject = "vfa.vision.config"
	staleAfter    = 1500 * time.Millisecond
	learnSeconds  = 5
)

type faceSeen struct {
	faces []engine.Face
	at    time.Time
}

type levelSeen struct {
	db float64
	at time.Time
}

type learnState struct {
	PersonID    string             `json:"personId"`
	Running     bool               `json:"running"`
	SecondsLeft int                `json:"secondsLeft"`
	Candidates  []engine.Candidate `json:"candidates"`
	Message     string             `json:"message,omitempty"`
	learner     *engine.Learner
	until       time.Time
}

type Service struct {
	o        *orch.Client
	nc       *nats.Conn
	dataFile string

	mu      sync.Mutex
	cfg     engine.Config
	eng     *engine.Engine
	faces   map[string]faceSeen  // je Kamera-ID
	levels  map[string]levelSeen // je Mikrofonkanal
	learn   learnState
	last    *engine.Cut
	lastErr string
	// Vorschau-URLs der Kameras (aus dem Kamera-Node, regelmäßig erneuert).
	previews map[string]string
}

func New(o *orch.Client, nc *nats.Conn, dataFile string) *Service {
	s := &Service{o: o, nc: nc, dataFile: dataFile, cfg: engine.DefaultConfig(), faces: map[string]faceSeen{}, levels: map[string]levelSeen{}, previews: map[string]string{}}
	s.load()
	s.eng = engine.New(s.cfg)
	return s
}

func (s *Service) load() {
	b, err := os.ReadFile(s.dataFile)
	if err != nil {
		return
	}
	cfg := engine.DefaultConfig()
	if json.Unmarshal(b, &cfg) == nil {
		s.cfg = cfg
	}
}

func (s *Service) save() {
	b, _ := json.MarshalIndent(s.cfg, "", "  ")
	_ = os.MkdirAll(filepath.Dir(s.dataFile), 0o755)
	if err := os.WriteFile(s.dataFile, b, 0o644); err != nil {
		slog.Warn("config speichern", "error", err)
	}
}

// Config/SetConfig: die Oberfläche arbeitet mit dem ganzen Dokument.
func (s *Service) Config() engine.Config {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.cfg
}

func (s *Service) SetConfig(cfg engine.Config) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.cfg = cfg
	s.eng.SetConfig(cfg)
	s.save()
}

// Run startet alle Schleifen und blockiert bis ctx endet.
func (s *Service) Run(ctx context.Context) {
	if _, err := s.nc.Subscribe(visionSubject, s.onVision); err != nil {
		slog.Error("nats subscribe", "error", err)
	}
	go s.levelsLoop(ctx)
	go s.previewLoop(ctx)
	t := time.NewTicker(100 * time.Millisecond)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case now := <-t.C:
			s.tick(ctx, now)
		}
	}
}

func (s *Service) onVision(m *nats.Msg) {
	var st struct {
		CameraID string        `json:"camera_id"`
		Faces    []engine.Face `json:"faces"`
	}
	if json.Unmarshal(m.Data, &st) != nil || st.CameraID == "" {
		return
	}
	s.mu.Lock()
	s.faces[st.CameraID] = faceSeen{st.Faces, time.Now()}
	s.mu.Unlock()
}

// levelsLoop liest die Pegel des Tonmischers (dsp: inDb vor Fader/AutoMix).
func (s *Service) levelsLoop(ctx context.Context) {
	for ctx.Err() == nil {
		node := s.Config().AudioMixer
		if node == "" {
			sleep(ctx, 2*time.Second)
			continue
		}
		cctx, cancel := context.WithCancel(ctx)
		go func() { // Konfigurationswechsel beendet den Strom
			for cctx.Err() == nil {
				sleep(cctx, time.Second)
				if s.Config().AudioMixer != node {
					cancel()
				}
			}
		}()
		err := s.o.Stream(cctx, node, "levelsUrl", s.onLevel)
		cancel()
		if err != nil && ctx.Err() == nil {
			s.setErr("Tonmischer-Pegel: " + err.Error())
		}
		sleep(ctx, 2*time.Second)
	}
}

func (s *Service) onLevel(data []byte) {
	var m struct {
		Type      string   `json:"type"`
		ChannelID *string  `json:"channelId"`
		InDb      *float64 `json:"inDb"`
		RMS       *float64 `json:"rms"`
	}
	if json.Unmarshal(data, &m) != nil || m.ChannelID == nil {
		return
	}
	var db float64
	switch {
	case m.Type == "dsp" && m.InDb != nil:
		db = *m.InDb
	case m.Type == "" && m.RMS != nil && *m.RMS > 0:
		db = 20 * math.Log10(*m.RMS)
	default:
		return
	}
	s.mu.Lock()
	s.levels[*m.ChannelID] = levelSeen{db, time.Now()}
	s.mu.Unlock()
}

// previewLoop löst die Vorschau-URL jeder Kamera auf und gibt sie an
// omp-vfa-vision weiter — dort ist nichts zu konfigurieren.
func (s *Service) previewLoop(ctx context.Context) {
	for ctx.Err() == nil {
		cfg := s.Config()
		type cam struct {
			ID  string `json:"id"`
			URL string `json:"url"`
		}
		var list []cam
		for _, c := range cfg.Cameras {
			if c.NodeID == "" {
				continue
			}
			raw, err := s.o.Param(ctx, c.NodeID, "previewUrl")
			if err != nil {
				continue
			}
			var u string
			if json.Unmarshal(raw, &u) == nil && u != "" {
				list = append(list, cam{c.ID, u})
				s.mu.Lock()
				s.previews[c.ID] = u
				s.mu.Unlock()
			}
		}
		b, _ := json.Marshal(map[string]any{"cameras": list})
		_ = s.nc.Publish(configSubject, b)
		sleep(ctx, 5*time.Second)
	}
}

func (s *Service) snapshot(now time.Time) (map[string]float64, map[string][]engine.Face) {
	lv := map[string]float64{}
	for k, v := range s.levels {
		if now.Sub(v.at) < staleAfter {
			lv[k] = v.db
		}
	}
	fc := map[string][]engine.Face{}
	for k, v := range s.faces {
		if now.Sub(v.at) < staleAfter {
			fc[k] = v.faces
		}
	}
	return lv, fc
}

func (s *Service) tick(ctx context.Context, now time.Time) {
	s.mu.Lock()
	lv, fc := s.snapshot(now)
	if s.learn.Running {
		s.learnStep(now, lv, fc)
	}
	var cut *engine.Cut
	cfg := s.cfg
	if cfg.Enabled && cfg.VideoMixer != "" && !s.learn.Running {
		cut = s.eng.Tick(now, lv, fc)
	}
	s.mu.Unlock()
	if cut != nil {
		go s.execute(ctx, cfg, *cut)
	}
}

// execute schaltet die Kamera am Bildmischer: Eingang suchen, wählen, schneiden.
func (s *Service) execute(ctx context.Context, cfg engine.Config, cut engine.Cut) {
	if err := s.CutTo(ctx, cfg, cut.CameraID); err != nil {
		s.setErr(err.Error())
		return
	}
	s.mu.Lock()
	c := cut
	s.last, s.lastErr = &c, ""
	s.mu.Unlock()
	slog.Info("vfa: Schnitt", "kamera", cut.CameraID, "person", cut.PersonID, "grund", cut.Reason)
}

// CutTo wählt die Kamera am Bildmischer und schneidet hart darauf.
func (s *Service) CutTo(ctx context.Context, cfg engine.Config, cameraID string) error {
	var cam *engine.Camera
	for i := range cfg.Cameras {
		if cfg.Cameras[i].ID == cameraID {
			cam = &cfg.Cameras[i]
		}
	}
	if cam == nil || cam.NodeID == "" {
		return fmt.Errorf("Kamera %q ist keinem Node zugeordnet", cameraID)
	}
	sender, err := s.mixerInputFor(ctx, cfg.VideoMixer, cam.NodeID)
	if err != nil {
		return err
	}
	if err := s.o.Invoke(ctx, cfg.VideoMixer, "crosspoint.select", map[string]any{"senderId": sender}); err != nil {
		return err
	}
	return s.o.Invoke(ctx, cfg.VideoMixer, "crosspoint.cut", nil)
}

// mixerInputFor findet den Mischereingang, der von einem Sender des Kamera-Nodes gespeist wird.
func (s *Service) mixerInputFor(ctx context.Context, mixer, camNode string) (string, error) {
	nodes, err := s.o.Nodes(ctx)
	if err != nil {
		return "", err
	}
	own := map[string]bool{}
	for _, n := range nodes {
		if n.ID == camNode {
			for _, sd := range n.Senders {
				own[sd.ID] = true
			}
		}
	}
	raw, err := s.o.Param(ctx, mixer, "crosspoint.inputs")
	if err != nil {
		return "", err
	}
	var in []struct {
		SenderID string `json:"senderId"`
	}
	if json.Unmarshal(raw, &in) != nil {
		// manche Nodes liefern das Array als String
		var str string
		if json.Unmarshal(raw, &str) == nil {
			_ = json.Unmarshal([]byte(str), &in)
		}
	}
	for _, i := range in {
		if own[i.SenderID] {
			return i.SenderID, nil
		}
	}
	return "", fmt.Errorf("Die Kamera ist nicht mit dem Bildmischer verbunden")
}

func (s *Service) setErr(msg string) {
	s.mu.Lock()
	s.lastErr = msg
	s.mu.Unlock()
}

// ---- Einrichtung: „Person spricht jetzt“ ----

func (s *Service) LearnStart(personID string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	p := s.person(personID)
	if p == nil {
		return fmt.Errorf("unbekannte Person")
	}
	if p.Mic == "" {
		return fmt.Errorf("Zuerst ein Mikrofon wählen")
	}
	s.learn = learnState{PersonID: personID, Running: true, SecondsLeft: learnSeconds,
		learner: engine.NewLearner(s.cfg.SpeakDb), until: time.Now().Add(learnSeconds * time.Second)}
	return nil
}

func (s *Service) LearnCancel() {
	s.mu.Lock()
	s.learn = learnState{}
	s.mu.Unlock()
}

func (s *Service) person(id string) *engine.Person {
	for i := range s.cfg.People {
		if s.cfg.People[i].ID == id {
			return &s.cfg.People[i]
		}
	}
	return nil
}

// learnStep läuft unter s.mu.
func (s *Service) learnStep(now time.Time, lv map[string]float64, fc map[string][]engine.Face) {
	p := s.person(s.learn.PersonID)
	if p == nil {
		s.learn = learnState{}
		return
	}
	// Nur zählen, wenn genau diese Person die lauteste ist.
	db, ok := lv[p.Mic]
	if ok {
		for _, o := range s.cfg.People {
			if o.ID != p.ID {
				if odb, ok2 := lv[o.Mic]; ok2 && odb > db {
					ok = false
				}
			}
		}
	}
	if ok {
		s.learn.learner.Add(db, fc)
	}
	left := int(math.Ceil(s.learn.until.Sub(now).Seconds()))
	if left > 0 {
		s.learn.SecondsLeft = left
		return
	}
	s.learn.Running, s.learn.SecondsLeft = false, 0
	s.learn.Candidates = s.learn.learner.Candidates(35)
	switch {
	case s.learn.learner.Samples() < 5:
		s.learn.Message = "Es wurde kaum Sprache gehört. Bitte lauter oder länger sprechen."
	case len(s.learn.Candidates) == 0:
		s.learn.Message = "Kein Gesicht gesehen. Ist die Kamera auf die Person gerichtet?"
	}
}

// ConfirmShots übernimmt die vom Bediener bestätigten Vorschläge (in Reihenfolge der Vorliebe).
func (s *Service) ConfirmShots(personID string, shots []engine.Shot) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	p := s.person(personID)
	if p == nil {
		return fmt.Errorf("unbekannte Person")
	}
	p.Shots = shots
	s.eng.SetConfig(s.cfg)
	s.save()
	s.learn = learnState{}
	return nil
}

// ---- Status für die Oberfläche ----

type CameraStatus struct {
	engine.Camera
	Faces   []engine.Face `json:"faces"`
	Online  bool          `json:"online"`
	Preview bool          `json:"preview"`
}

type PersonStatus struct {
	ID       string  `json:"id"`
	Db       float64 `json:"db"`
	Speaking bool    `json:"speaking"`
}

func (s *Service) Status() map[string]any {
	s.mu.Lock()
	defer s.mu.Unlock()
	now := time.Now()
	lv, fc := s.snapshot(now)
	cams := make([]CameraStatus, 0, len(s.cfg.Cameras))
	for _, c := range s.cfg.Cameras {
		seen, ok := s.faces[c.ID]
		f := []engine.Face{}
		if ok && now.Sub(seen.at) < staleAfter {
			f = fc[c.ID]
		}
		cams = append(cams, CameraStatus{Camera: c, Faces: f, Online: ok && now.Sub(seen.at) < staleAfter, Preview: s.previews[c.ID] != ""})
	}
	sp, hasSp := s.eng.Speaker(lv)
	people := make([]PersonStatus, 0, len(s.cfg.People))
	for _, p := range s.cfg.People {
		db, ok := lv[p.Mic]
		people = append(people, PersonStatus{ID: p.ID, Db: math.Round(db), Speaking: hasSp && sp.ID == p.ID && ok})
	}
	l := s.learn
	return map[string]any{
		"cameras": cams, "people": people, "current": s.eng.Current(), "last": s.last,
		"error": s.lastErr, "learn": map[string]any{"personId": l.PersonID, "running": l.Running,
			"secondsLeft": l.SecondsLeft, "candidates": nilToEmpty(l.Candidates), "message": l.Message},
	}
}

func nilToEmpty(c []engine.Candidate) []engine.Candidate {
	if c == nil {
		return []engine.Candidate{}
	}
	return c
}

// Channels listet die Kanäle des Tonmischers (für die Mikrofonauswahl).
func (s *Service) Channels(ctx context.Context) ([]map[string]string, error) {
	node := s.Config().AudioMixer
	if node == "" {
		return nil, fmt.Errorf("kein Tonmischer gewählt")
	}
	st, err := s.o.State(ctx, node)
	if err != nil {
		return nil, err
	}
	var d struct {
		Channels []struct {
			ID    string `json:"id"`
			Label string `json:"label"`
		} `json:"channels"`
	}
	if err := json.Unmarshal(st, &d); err != nil {
		return nil, err
	}
	out := []map[string]string{}
	for _, c := range d.Channels {
		out = append(out, map[string]string{"id": c.ID, "label": c.Label})
	}
	return out, nil
}

func sleep(ctx context.Context, d time.Duration) {
	select {
	case <-ctx.Done():
	case <-time.After(d):
	}
}

var _ = strings.TrimSpace
