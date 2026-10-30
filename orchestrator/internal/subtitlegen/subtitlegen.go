// Package subtitlegen erzeugt Untertitel (SRT) aus Mediendateien über einen Auto-Untertitel-Node (omp-subtitle-asr): Sprecherkennung
// und Spracherkennung laufen dort (Methode file.transcribe, Aufträge im Parameter fileJobs, Ergebnis als fileJobSrt.<id>). Dieses Paket
// ist der gemeinsame Baustein für die Eingangskontrolle (Knopf „SRT erzeugen“) und den Prozess-Schritt `subtitles.generate`.
package subtitlegen

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// Target ist ein erreichbarer Auto-Untertitel-Node.
type Target struct {
	NodeID     string
	InstanceID string
	Label      string
	BaseURL    string
}

// Request beschreibt einen Auftrag. File muss auf dem Rechner des Nodes lesbar sein.
type Request struct {
	// ID: Auftrags-ID (vom Aufrufer vergeben, damit der Fortschritt eindeutig abfragbar ist).
	ID       string
	File     string
	Track    int
	Language string
	// Speakers: 1 = ohne Sprechernamen, 0 = Anzahl automatisch, ≥ 2 = feste Anzahl.
	Speakers int
	Names    []string
	// Word: Beschriftung ohne Namen („Sprecher“ → „Sprecher 1“); Style: colon | bracket | dash.
	Word  string
	Style string
	Name  string
}

// Job ist der Zustand eines Auftrags im Node.
type Job struct {
	ID              string  `json:"id"`
	Name            string  `json:"name"`
	State           string  `json:"state"` // queued | extracting | diarizing | transcribing | done | failed | canceled
	Progress        int     `json:"progress"`
	Message         string  `json:"message"`
	SpeakersFound   int     `json:"speakersFound"`
	Cues            int     `json:"cues"`
	DurationS       float64 `json:"durationS"`
	SpeakersRequest int     `json:"speakersRequested"`
}

// Running: noch in Arbeit.
func (j Job) Running() bool {
	switch j.State {
	case "queued", "extracting", "diarizing", "transcribing":
		return true
	}
	return false
}

// ErrJobLost: der Node kennt den Auftrag nicht mehr (Neustart, zu viele neuere Aufträge).
var ErrJobLost = errors.New("Auftrag ist im Untertitel-Node nicht mehr vorhanden")

// ErrNoNode: kein erreichbarer Auto-Untertitel-Node.
var ErrNoNode = errors.New("kein laufender Auto-Untertitel-Node gefunden — im Node-Katalog „Auto-Untertitel“ starten")

type Client struct {
	HTTP *http.Client
}

func (c *Client) http() *http.Client {
	if c != nil && c.HTTP != nil {
		return c.HTTP
	}
	return &http.Client{Timeout: 20 * time.Second}
}

func (c *Client) do(ctx context.Context, method, u string, body any) ([]byte, int, error) {
	var rd io.Reader
	if body != nil {
		b, _ := json.Marshal(body)
		rd = bytes.NewReader(b)
	}
	req, err := http.NewRequestWithContext(ctx, method, u, rd)
	if err != nil {
		return nil, 0, err
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := c.http().Do(req)
	if err != nil {
		return nil, 0, err
	}
	defer resp.Body.Close()
	b, _ := io.ReadAll(io.LimitReader(resp.Body, 16<<20))
	return b, resp.StatusCode, nil
}

func nodeError(body []byte, code int) error {
	var e struct {
		Error   string `json:"error"`
		Message string `json:"message"`
	}
	if json.Unmarshal(body, &e) == nil {
		if e.Error != "" {
			return errors.New(e.Error)
		}
		if e.Message != "" {
			return errors.New(e.Message)
		}
	}
	if s := strings.TrimSpace(string(body)); s != "" && len(s) < 300 {
		return errors.New(s)
	}
	return fmt.Errorf("HTTP %d", code)
}

// Submit reicht den Auftrag beim Node ein (Methode file.transcribe).
func (c *Client) Submit(ctx context.Context, t Target, r Request) error {
	body := map[string]any{
		"id": r.ID, "file": r.File, "track": r.Track, "language": r.Language, "speakers": r.Speakers,
		"names": strings.Join(r.Names, ","), "word": r.Word, "style": r.Style, "name": r.Name,
	}
	b, code, err := c.do(ctx, http.MethodPost, t.BaseURL+"/methods/file.transcribe", body)
	if err != nil {
		return fmt.Errorf("Untertitel-Node %q nicht erreichbar: %w", t.Label, err)
	}
	if code >= 300 {
		return fmt.Errorf("Untertitel-Node %q: %w", t.Label, nodeError(b, code))
	}
	return nil
}

// Status liest den Zustand eines Auftrags; ErrJobLost, wenn der Node ihn nicht (mehr) kennt.
func (c *Client) Status(ctx context.Context, t Target, id string) (Job, error) {
	b, code, err := c.do(ctx, http.MethodGet, t.BaseURL+"/params/fileJobs", nil)
	if err != nil {
		return Job{}, fmt.Errorf("Untertitel-Node %q nicht erreichbar: %w", t.Label, err)
	}
	if code >= 300 {
		return Job{}, fmt.Errorf("Untertitel-Node %q: %w", t.Label, nodeError(b, code))
	}
	var v struct {
		Value []Job `json:"value"`
	}
	if err := json.Unmarshal(b, &v); err != nil {
		return Job{}, fmt.Errorf("Antwort des Untertitel-Nodes unlesbar: %w", err)
	}
	for _, j := range v.Value {
		if j.ID == id {
			return j, nil
		}
	}
	return Job{}, ErrJobLost
}

// Result holt die fertige SRT-Datei.
func (c *Client) Result(ctx context.Context, t Target, id string) (string, error) {
	b, code, err := c.do(ctx, http.MethodGet, t.BaseURL+"/params/"+url.PathEscape("fileJobSrt."+id), nil)
	if err != nil {
		return "", fmt.Errorf("Untertitel-Node %q nicht erreichbar: %w", t.Label, err)
	}
	if code >= 300 {
		return "", fmt.Errorf("Ergebnis nicht abrufbar: %w", nodeError(b, code))
	}
	var v struct {
		Value *string `json:"value"`
	}
	if err := json.Unmarshal(b, &v); err != nil || v.Value == nil || strings.TrimSpace(*v.Value) == "" {
		return "", errors.New("Ergebnis des Untertitel-Nodes ist leer")
	}
	return *v.Value, nil
}

// Cancel bricht einen laufenden Auftrag ab bzw. entfernt einen beendeten aus der Liste des Nodes (best effort).
func (c *Client) Cancel(ctx context.Context, t Target, id string, remove bool) {
	method := "file.cancel"
	if remove {
		method = "file.remove"
	}
	_, _, _ = c.do(ctx, http.MethodPost, t.BaseURL+"/methods/"+method, map[string]any{"id": id})
}

// HasDiarization fragt, ob der Node eine Sprechererkennung eingerichtet hat.
func (c *Client) HasDiarization(ctx context.Context, t Target) bool {
	b, code, err := c.do(ctx, http.MethodGet, t.BaseURL+"/params/diarization", nil)
	if err != nil || code >= 300 {
		return false
	}
	var v struct {
		Value bool `json:"value"`
	}
	return json.Unmarshal(b, &v) == nil && v.Value
}

// Role liest die Rolle des Nodes: "file" = dedizierter Datei-Node, sonst (auch bei älteren Nodes ohne den Parameter) "live".
func (c *Client) Role(ctx context.Context, t Target) string {
	b, code, err := c.do(ctx, http.MethodGet, t.BaseURL+"/params/role", nil)
	if err != nil || code >= 300 {
		return "live"
	}
	var v struct {
		Value string `json:"value"`
	}
	if json.Unmarshal(b, &v) != nil || v.Value != "file" {
		return "live"
	}
	return "file"
}

// FileNodes behält nur die dedizierten Datei-Nodes. Dateiaufträge rechnen minutenlang auf mehreren Kernen und dürfen die
// Live-Untertitelung nicht beeinträchtigen: ein Live-Node bekommt nie einen.
func (c *Client) FileNodes(ctx context.Context, nodes []Target) []Target {
	var out []Target
	for _, n := range nodes {
		if c.Role(ctx, n) == "file" {
			out = append(out, n)
		}
	}
	return out
}

// ErrNoFileNode: es laufen Untertitel-Nodes, aber keiner ist als Datei-Node gestartet.
var ErrNoFileNode = errors.New("kein dedizierter Datei-Node gefunden — „Auto-Untertitel“ mit Option „Aufgabe = file“ (OMP_ASR_ROLE=file) starten; Live-Nodes nehmen keine Dateiaufträge an, damit die Live-Untertitelung nicht gestört wird")

// Pick wählt den Datei-Node für einen Auftrag: bei Sprechererkennung einen, der sie hat; sonst den ersten.
func (c *Client) Pick(ctx context.Context, all []Target, speakers int) (Target, error) {
	if len(all) == 0 {
		return Target{}, ErrNoNode
	}
	nodes := c.FileNodes(ctx, all)
	if len(nodes) == 0 {
		return Target{}, ErrNoFileNode
	}
	if speakers == 1 {
		return nodes[0], nil
	}
	for _, n := range nodes {
		if c.HasDiarization(ctx, n) {
			return n, nil
		}
	}
	return Target{}, fmt.Errorf("Der Untertitel-Node %q hat keine Sprechererkennung eingerichtet (sh tools/asr-engine/install-diarization.sh); mit „1 Sprecher“ lassen sich Untertitel ohne Namen erzeugen", nodes[0].Label)
}
