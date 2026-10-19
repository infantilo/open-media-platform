package ingest

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/infantilo/openmediaplatform/orchestrator/internal/launcher"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/registry"
)

// Schmale Schnittstellen auf die Kernbausteine (vom Kern implementiert; Tests ersetzen sie).
type LauncherAPI interface {
	StartLabeled(nodeType, version, hostID, customLabel string, extraEnv map[string]string) (launcher.Instance, error)
	Stop(id string) error
	List() []launcher.Instance
}

type NodeLister interface{ List() []registry.NodeView }

type Connector interface {
	Connect(ctx context.Context, fromSender, toReceiver string) error
}

// LauncherRuntime startet je Auftrag einen omp-recorder (lokal oder auf einem Host), verbindet die Quelle per IS-05 und steuert die
// Aufnahme über die Node-Methoden record.start/record.stop. Instanzen heißen „ingest-<Auftrag>“; daran findet Prepare eine bereits
// laufende Instanz wieder (Idempotenz nach Neustart) und Instances() verwaiste.
type LauncherRuntime struct {
	Launcher     LauncherAPI
	Nodes        NodeLister
	Graph        Connector
	HTTP         *http.Client
	ReadyWait    time.Duration // Wartezeit auf die Registrierung (Standard 30 s)
	RecorderType string        // Standard omp-recorder
}

const instanceLabelPrefix = "ingest-"

func (r *LauncherRuntime) client() *http.Client {
	if r.HTTP != nil {
		return r.HTTP
	}
	return &http.Client{Timeout: 10 * time.Second}
}

func (r *LauncherRuntime) recorderType() string {
	if r.RecorderType != "" {
		return r.RecorderType
	}
	return "omp-recorder"
}

func (r *LauncherRuntime) node(instanceID string) (registry.NodeView, bool) {
	for _, n := range r.Nodes.List() {
		if n.InstanceID == instanceID && n.Online {
			return n, true
		}
	}
	return registry.NodeView{}, false
}

func (r *LauncherRuntime) Prepare(ctx context.Context, jobID, hostID, label, mediaDir string, audioInputs int) (Session, error) {
	var inst launcher.Instance
	found := false
	for _, in := range r.Launcher.List() {
		if in.Label == label && in.Type == r.recorderType() && !in.Crashed {
			inst, found = in, true
			break
		}
	}
	if !found {
		var err error
		env := map[string]string{"OMP_MEDIA_DIR": mediaDir}
		if audioInputs > 1 {
			env["OMP_RECORDER_AUDIO_INPUTS"] = strconv.Itoa(audioInputs)
		}
		inst, err = r.Launcher.StartLabeled(r.recorderType(), "", hostID, label, env)
		if err != nil {
			return Session{}, err
		}
	}
	wait := r.ReadyWait
	if wait <= 0 {
		wait = 30 * time.Second
	}
	deadline := time.Now().Add(wait)
	for {
		if n, ok := r.node(inst.ID); ok && n.APIBaseURL != "" {
			return Session{InstanceID: inst.ID, HostID: hostID}, nil
		}
		if time.Now().After(deadline) {
			_ = r.Launcher.Stop(inst.ID)
			return Session{}, fmt.Errorf("Rekorder %s meldete sich nicht in der Registry (%s)", inst.ID, wait)
		}
		select {
		case <-ctx.Done():
			return Session{}, ctx.Err()
		case <-time.After(250 * time.Millisecond):
		}
	}
}

func (r *LauncherRuntime) Adopt(ctx context.Context, instanceID string) (Session, bool) {
	for _, in := range r.Launcher.List() {
		if in.ID == instanceID && !in.Crashed {
			if _, ok := r.node(instanceID); ok {
				return Session{InstanceID: instanceID, HostID: in.HostID}, true
			}
		}
	}
	return Session{}, false
}

// senders liefert (Video-, Audio-Sender) der Quelle.
func (r *LauncherRuntime) senders(src Source) (video, audio string, err error) {
	for _, n := range r.Nodes.List() {
		if !n.Online {
			continue
		}
		if src.InstanceID != "" && n.InstanceID != src.InstanceID {
			continue
		}
		for _, s := range n.Senders {
			if src.SenderID != "" && s.ID != src.SenderID {
				continue
			}
			if src.SenderID == "" && src.SenderLabel != "" && s.Label != src.SenderLabel {
				continue
			}
			switch {
			case strings.Contains(s.Format, "video") && video == "":
				video = s.ID
			case strings.Contains(s.Format, "audio") && audio == "":
				audio = s.ID
			}
		}
	}
	if video == "" && audio == "" {
		return "", "", ErrSourceUnavailable
	}
	return video, audio, nil
}

func (r *LauncherRuntime) ResolveSource(ctx context.Context, src Source) error {
	_, _, err := r.senders(src)
	return err
}

func (r *LauncherRuntime) Connect(ctx context.Context, s Session, src Source, audio *AudioPlan) error {
	rec, ok := r.node(s.InstanceID)
	if !ok {
		return fmt.Errorf("Rekorder nicht in der Registry")
	}
	vs, as, err := r.senders(src)
	if err != nil {
		return err
	}
	var vr string
	ars := audioReceivers(rec.Receivers)
	var ar string
	if len(ars) > 0 {
		ar = ars[0]
	}
	for _, rc := range rec.Receivers {
		if strings.Contains(rc.Format, "video") && vr == "" {
			vr = rc.ID
		}
	}
	if vs != "" && vr != "" {
		if err := r.Graph.Connect(ctx, vs, vr); err != nil {
			return fmt.Errorf("Video verbinden: %w", err)
		}
	}
	if as != "" && ar != "" {
		if err := r.Graph.Connect(ctx, as, ar); err != nil {
			return fmt.Errorf("Audio verbinden: %w", err)
		}
	}
	// weitere Quellen des Kanalplans: je eine auf „Audio 2“ …
	if audio != nil {
		for i, extra := range audio.Inputs {
			_, xa, err := r.senders(extra)
			if err != nil {
				return fmt.Errorf("weitere Quelle %d: %w", i+1, err)
			}
			if xa == "" {
				return fmt.Errorf("weitere Quelle %d hat keinen Audio-Sender", i+1)
			}
			if i+1 >= len(ars) {
				return fmt.Errorf("Rekorder hat zu wenige Audio-Empfänger (%d) für %d Quellen", len(ars), len(audio.Inputs)+1)
			}
			if err := r.Graph.Connect(ctx, xa, ars[i+1]); err != nil {
				return fmt.Errorf("weitere Quelle %d verbinden: %w", i+1, err)
			}
		}
	}
	if (vs == "" || vr == "") && (as == "" || ar == "") && !(audio != nil && len(audio.Inputs) > 0) {
		return fmt.Errorf("keine passende Sender/Empfänger-Kombination")
	}
	return nil
}

// audioReceivers: Audio-Empfänger des Rekorders in Eingangsreihenfolge („Audio“, „Audio 2“, …) — nach Beschriftung, nicht nach
// Registry-Reihenfolge (die ist nicht stabil).
func audioReceivers(rs []registry.ReceiverView) []string {
	type rv struct {
		n  int
		id string
	}
	var list []rv
	for _, rc := range rs {
		if !strings.Contains(rc.Format, "audio") {
			continue
		}
		n := 1
		if rest, ok := strings.CutPrefix(rc.Label, "Audio "); ok {
			if v, err := strconv.Atoi(strings.TrimSpace(rest)); err == nil && v > 1 {
				n = v
			}
		}
		list = append(list, rv{n, rc.ID})
	}
	sort.SliceStable(list, func(i, j int) bool { return list[i].n < list[j].n })
	out := make([]string, len(list))
	for i, x := range list {
		out[i] = x.id
	}
	return out
}

func (r *LauncherRuntime) do(ctx context.Context, method, url string, body any) ([]byte, int, error) {
	var rd *bytes.Reader
	if body != nil {
		b, _ := json.Marshal(body)
		rd = bytes.NewReader(b)
	} else {
		rd = bytes.NewReader(nil)
	}
	req, err := http.NewRequestWithContext(ctx, method, url, rd)
	if err != nil {
		return nil, 0, err
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := r.client().Do(req)
	if err != nil {
		return nil, 0, err
	}
	defer resp.Body.Close()
	var buf bytes.Buffer
	_, _ = buf.ReadFrom(io.LimitReader(resp.Body, 1<<20))
	return buf.Bytes(), resp.StatusCode, nil
}

func (r *LauncherRuntime) StartRecording(ctx context.Context, s Session, fileRel, mcaPlan string, audio *AudioPlan) error {
	n, ok := r.node(s.InstanceID)
	if !ok {
		return fmt.Errorf("Rekorder nicht erreichbar")
	}
	if mcaPlan != "" {
		if _, code, err := r.do(ctx, http.MethodPatch, n.APIBaseURL+"/params/record.mcaPlan", map[string]any{"value": mcaPlan}); err != nil || code >= 300 {
			return fmt.Errorf("MCA-Plan nicht setzbar (HTTP %d)", code)
		}
	}
	if plan := audio.RecorderJSON(); plan != "" {
		if b, code, err := r.do(ctx, http.MethodPatch, n.APIBaseURL+"/params/record.audioPlan", map[string]any{"value": plan}); err != nil || code >= 300 {
			return fmt.Errorf("Kanalplan nicht setzbar (HTTP %d %s)", code, strings.TrimSpace(string(b)))
		}
	}
	body, code, err := r.do(ctx, http.MethodPost, n.APIBaseURL+"/methods/record.start", map[string]any{"fileName": fileRel})
	if err != nil {
		return err
	}
	if code != http.StatusOK {
		return fmt.Errorf("record.start: HTTP %d %s", code, strings.TrimSpace(string(body)))
	}
	return nil
}

func (r *LauncherRuntime) Status(ctx context.Context, s Session) (string, int64, error) {
	n, ok := r.node(s.InstanceID)
	if !ok {
		return "", 0, fmt.Errorf("Rekorder nicht erreichbar")
	}
	body, code, err := r.do(ctx, http.MethodGet, n.APIBaseURL+"/params/record.status", nil)
	if err != nil || code != http.StatusOK {
		return "", 0, fmt.Errorf("Status nicht lesbar (HTTP %d): %v", code, err)
	}
	var v struct {
		Value string `json:"value"`
	}
	_ = json.Unmarshal(body, &v)
	var dur int64
	if b2, c2, e2 := r.do(ctx, http.MethodGet, n.APIBaseURL+"/params/record.durationMs", nil); e2 == nil && c2 == http.StatusOK {
		var d struct {
			Value float64 `json:"value"`
		}
		_ = json.Unmarshal(b2, &d)
		dur = int64(d.Value)
	}
	return v.Value, dur, nil
}

func (r *LauncherRuntime) StopRecording(ctx context.Context, s Session) error {
	n, ok := r.node(s.InstanceID)
	if !ok {
		return nil // nichts mehr zu stoppen
	}
	_, code, err := r.do(ctx, http.MethodPost, n.APIBaseURL+"/methods/record.stop", map[string]any{})
	if err != nil {
		return err
	}
	if code != http.StatusOK {
		return fmt.Errorf("record.stop: HTTP %d", code)
	}
	return nil
}

func (r *LauncherRuntime) Teardown(ctx context.Context, instanceID string) error {
	for _, in := range r.Launcher.List() {
		if in.ID == instanceID {
			return r.Launcher.Stop(instanceID)
		}
	}
	return nil // schon weg
}

func (r *LauncherRuntime) Instances(ctx context.Context) []string {
	var out []string
	for _, in := range r.Launcher.List() {
		if in.Type == r.recorderType() && strings.HasPrefix(in.Label, instanceLabelPrefix) {
			out = append(out, in.ID)
		}
	}
	return out
}
