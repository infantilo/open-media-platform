// Package freeze: „die letzten Minuten einfrieren“ (UMSETZUNG.md Kap. 72.10). Aus Ringpuffer (blackbox), Zeitleiste, Logs, Zustand und
// Pipeline-Momentaufnahmen entsteht ein ZIP, das hinterher noch da ist, wenn Ringpuffer und Aufbewahrung die Daten längst überschrieben haben.
// Angelegt wird es von Hand (Knopf) oder automatisch bei einer Störung (Absturz, Medien weg, Host verstummt, Failover).
package freeze

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"log/slog"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/infantilo/openmediaplatform/orchestrator/internal/blackbox"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/support"
)

const (
	DefaultWindow = 10 * time.Minute
	MaxWindow     = blackbox.Window
	MinWindow     = 2 * time.Minute
	// maxPipelineNodes begrenzt, von wie vielen Nodes der Pipeline-Zustand festgehalten wird, wenn kein Bereich gewählt ist.
	maxPipelineNodes = 25
)

// Deps sind die Datenquellen; jede darf fehlen (nil) — der Eintrag wird dann übersprungen, die Momentaufnahme entsteht trotzdem.
type Deps struct {
	Timeline   func(since, until time.Time) (any, error)
	Logs       func(since, until time.Time) (any, error)
	Nodes      func() (any, error)
	Instances  func() (any, error)
	Hosts      func() (any, error)
	Graph      func(ctx context.Context) (any, error)
	HostSeries func(window time.Duration) (any, error)
	// Pipelines liefert den Pipeline-Zustand der Nodes aus scope (leer = alle erreichbaren, höchstens maxPipelineNodes): Dateiname → JSON.
	Pipelines func(ctx context.Context, scope []string, max int) (map[string][]byte, error)
	Box       *blackbox.Recorder
}

// Request beschreibt, was eingefroren werden soll.
type Request struct {
	By      string
	Trigger string // "manual" | "auto"
	Reason  string // bei automatisch: was die Auslösung war
	Note    string
	Window  time.Duration
	Scope   []string
}

// Freezer legt Momentaufnahmen an.
type Freezer struct {
	Deps  Deps
	Store *Store
	// OnFrozen wird nach dem Speichern aufgerufen (Ereignis für die Oberfläche, Eintrag in der Zeitleiste).
	OnFrozen func(Meta)

	// Automatik
	AutoEnabled  bool
	AutoCooldown time.Duration
	AutoDelay    time.Duration

	now      func() time.Time
	mu       sync.Mutex
	lastAuto time.Time
}

// New: Automatik an, höchstens eine alle 5 Minuten, 10 Sekunden nach der Störung (so ist der Auslöser selbst mit in der Momentaufnahme).
func New(deps Deps, store *Store) *Freezer {
	return &Freezer{Deps: deps, Store: store, AutoEnabled: true, AutoCooldown: 5 * time.Minute, AutoDelay: 10 * time.Second, now: time.Now}
}

func newID() string {
	b := make([]byte, 6)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

// ClampWindow bringt eine gewünschte Dauer in den erlaubten Bereich (0 = Standard).
func ClampWindow(d time.Duration) time.Duration {
	switch {
	case d <= 0:
		return DefaultWindow
	case d < MinWindow:
		return MinWindow
	case d > MaxWindow:
		return MaxWindow
	}
	return d
}

// Freeze legt eine Momentaufnahme an und speichert sie.
func (f *Freezer) Freeze(ctx context.Context, req Request) (Meta, error) {
	window := ClampWindow(req.Window)
	until := f.now()
	since := until.Add(-window)
	var files []support.File
	failed := map[string]string{}
	add := func(name string, v any, err error) {
		if err != nil {
			failed[name] = err.Error()
			return
		}
		b, mErr := json.MarshalIndent(v, "", "  ")
		if mErr != nil {
			failed[name] = mErr.Error()
			return
		}
		files = append(files, support.File{Name: name, Data: support.Redact(name, b)})
	}
	d := f.Deps
	if d.Timeline != nil {
		v, err := d.Timeline(since, until)
		add("timeline.json", v, err)
	}
	if d.Logs != nil {
		v, err := d.Logs(since, until)
		add("logs.json", v, err)
	}
	if d.Box != nil {
		s := d.Box.Window(window)
		add("series/nodes.json", s.Nodes, nil)
		add("series/processes.json", s.Procs, nil)
	}
	if d.HostSeries != nil {
		v, err := d.HostSeries(window)
		add("series/hosts.json", v, err)
	}
	if d.Nodes != nil {
		v, err := d.Nodes()
		add("state/nodes.json", v, err)
	}
	if d.Instances != nil {
		v, err := d.Instances()
		add("state/instances.json", v, err)
	}
	if d.Hosts != nil {
		v, err := d.Hosts()
		add("state/hosts.json", v, err)
	}
	if d.Graph != nil {
		v, err := d.Graph(ctx)
		add("state/graph.json", v, err)
	}
	if d.Pipelines != nil {
		pls, err := d.Pipelines(ctx, req.Scope, maxPipelineNodes)
		if err != nil {
			failed["pipelines"] = err.Error()
		}
		names := make([]string, 0, len(pls))
		for n := range pls {
			names = append(names, n)
		}
		sort.Strings(names)
		for _, n := range names {
			files = append(files, support.File{Name: "pipelines/" + n, Data: support.Redact(n, pls[n])})
		}
	}

	m := Meta{ID: newID(), CreatedAt: until.UTC(), CreatedBy: req.By, Trigger: req.Trigger, Reason: req.Reason, Note: strings.TrimSpace(req.Note),
		WindowMinutes: int(window / time.Minute), Scope: req.Scope}
	if m.Trigger == "" {
		m.Trigger = "manual"
	}
	if r := []rune(m.Note); len(r) > 200 {
		m.Note = string(r[:200])
	}
	meta := map[string]any{"id": m.ID, "createdAt": m.CreatedAt, "createdBy": m.CreatedBy, "trigger": m.Trigger, "reason": m.Reason, "note": m.Note,
		"from": since.UTC(), "to": until.UTC(), "windowMinutes": m.WindowMinutes, "scope": m.Scope, "failed": failed}
	mb, _ := json.MarshalIndent(meta, "", "  ")
	files = append([]support.File{{Name: "meta.json", Data: mb}, {Name: "README.txt", Data: []byte(readme)}}, files...)

	var buf bytes.Buffer
	if err := support.WriteZip(&buf, files, until); err != nil {
		return Meta{}, err
	}
	m.SizeBytes = buf.Len()
	if err := f.Store.Create(ctx, m, buf.Bytes()); err != nil {
		return Meta{}, err
	}
	if f.OnFrozen != nil {
		f.OnFrozen(m)
	}
	return m, nil
}

const readme = `OpenMediaPlatform — eingefrorene Momentaufnahme / frozen snapshot
=================================================================

Die letzten Minuten des Systems, festgehalten zum Zeitpunkt der Auslösung (meta.json).
Enthält keine Medien, keine Passwörter, Tokens oder Schlüssel (Werte sind durch [entfernt] ersetzt).

  meta.json            Zeitpunkt, Fenster, Auslöser (von Hand oder automatisch), Notiz, nicht abrufbare Teile
  timeline.json        Ereignisse, Bedienungen, Marker und Fehler-Logs des Fensters
  logs.json            Meldungen des Fensters (alle Stufen)
  series/nodes.json    Kennzahlen je Node alle ~5 s: Medien bereit, Bildrate …
  series/processes.json CPU und Speicher je Instanz alle ~5 s
  series/hosts.json    CPU/RAM je Host (Rohwerte, ~5 s)
  state/*.json         Nodes, Instanzen, Hosts, Graph zum Zeitpunkt der Auslösung
  pipelines/*.json     Pipeline-Zustand der betroffenen Nodes (Elemente, Zustände, Füllstände)

Bitte die ganze ZIP-Datei an den Support senden. / Please send the whole ZIP file to support.
`

// AutoKinds sind die Ereignisse, die automatisch eine Momentaufnahme auslösen.
// instance.restarted gehört dazu: ein automatischer Neustart ist die Folge eines Absturzes, „crashed“ kommt erst nach der Crash-Schleife.
var AutoKinds = map[string]bool{"instance.crashed": true, "instance.restarted": true, "node.notready": true, "host.silent": true, "workflow.failover": true}

// Observe wird für jedes aufgezeichnete Ereignis aufgerufen und friert bei einer Störung automatisch ein — höchstens einmal je AutoCooldown,
// leicht verzögert (AutoDelay), damit der Auslöser und seine ersten Folgen mit in der Momentaufnahme stehen.
func (f *Freezer) Observe(kind, label string) {
	if !f.AutoEnabled || !AutoKinds[kind] {
		return
	}
	f.mu.Lock()
	now := f.now()
	if !f.lastAuto.IsZero() && now.Sub(f.lastAuto) < f.AutoCooldown {
		f.mu.Unlock()
		return
	}
	f.lastAuto = now
	f.mu.Unlock()
	reason := kind
	if label != "" {
		reason = kind + ": " + label
	}
	run := func() {
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		if _, err := f.Freeze(ctx, Request{Trigger: "auto", Reason: reason, Window: DefaultWindow}); err != nil {
			slog.Warn("automatic freeze failed", "reason", reason, "error", err)
		}
	}
	if f.AutoDelay <= 0 {
		run()
		return
	}
	time.AfterFunc(f.AutoDelay, run)
}

// Describe liefert eine kurze Beschreibung für Meldungen („letzte 10 Minuten“).
func (m Meta) Describe() string { return fmt.Sprintf("%d min", m.WindowMinutes) }
