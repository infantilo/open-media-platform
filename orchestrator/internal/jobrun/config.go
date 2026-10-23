package jobrun

import (
	"encoding/json"
	"fmt"
	"sort"
)

// SettingsKey ist der Schlüssel des Einstellungsdokuments.
const SettingsKey = "ffmpeg.config"

// Weights gewichtet die Lastbewertung (kleinerer Wert = besser).
type Weights struct {
	CPU  float64 `json:"cpu"`
	GPU  float64 `json:"gpu"`
	Jobs float64 `json:"jobs"`
	Live float64 `json:"live"`
	Data float64 `json:"data"`
	Net  float64 `json:"net"`
}

// Reserve ist der Anteil (0–1) der Hostkapazität, der für Live-Nodes frei bleibt.
type Reserve struct {
	CPU float64 `json:"cpu"`
	Mem float64 `json:"mem"`
	GPU float64 `json:"gpu"`
	Net float64 `json:"net"`
}

// Protect steuert den Laufzeit-Wächter (Sendeschutz).
type Protect struct {
	Enabled bool `json:"enabled"`
	// Anteile der Grenze (100 % · (1 − Reserve.CPU)): ab ThrottleAt wird gedrosselt, ab PauseAt pausiert, ab CancelAt
	// abgebrochen; unter ResumeAt werden pausierte Jobs fortgesetzt.
	ThrottleAt float64 `json:"throttleAt"`
	PauseAt    float64 `json:"pauseAt"`
	CancelAt   float64 `json:"cancelAt"`
	ResumeAt   float64 `json:"resumeAt"`
	// MaxPauseS: so lange darf ein Job pausiert bleiben, bevor er abgebrochen und neu eingeplant wird.
	MaxPauseS int `json:"maxPauseS"`
	IntervalS int `json:"intervalS"`
}

// HostOpts sind die Einstellungen eines Hosts (Schlüssel: Host-ID oder "local").
type HostOpts struct {
	// Enabled: nil = ja, wenn der Host Job-Ausführung meldet (lokal: ja).
	Enabled   *bool    `json:"enabled,omitempty"`
	MaxJobs   int      `json:"maxJobs,omitempty"` // 0 = Wert des Hosts (Agent: tools.json; lokal: Standard)
	BatchOnly bool     `json:"batchOnly,omitempty"`
	NoBatch   bool     `json:"noBatch,omitempty"`
	Pools     []string `json:"pools,omitempty"`
	Nice      int      `json:"nice,omitempty"`
	// Reserve überschreibt die Live-Reserve für diesen Host (nil = System-Reserve bzw. Auto-Kalibrierung).
	Reserve *Reserve `json:"reserve,omitempty"`
}

func (o HostOpts) enabled() bool { return o.Enabled == nil || *o.Enabled }

// Config ist das Einstellungsdokument „ffmpeg.config“.
type Config struct {
	// DefaultTarget: System-Standard, wenn weder Job noch Aufrufer ein Ziel nennen.
	DefaultTarget string `json:"defaultTarget"`
	// Defaults: Standardziel je Aufrufer ("script", "qc", "proxy", "convert").
	Defaults map[string]string `json:"defaults,omitempty"`
	// FallbackLocal: findet sich kein Host, läuft der Job auf dem Orchestrator-Rechner.
	FallbackLocal bool `json:"fallbackLocal"`
	MaxWaitS      int  `json:"maxWaitS"`
	MaxAttempts   int  `json:"maxAttempts"`
	LookaheadMin  int  `json:"lookaheadMin"`
	// LiveHostPolicy: "reserve-only" (Standard: nur Reserve/Grenzen) | "interactive-only" (auf Hosts mit Live-Nodes
	// nur Klasse interactive).
	LiveHostPolicy string `json:"liveHostPolicy"`
	// BatchSoftFraction: Klasse batch startet nur unter diesem Anteil der CPU-Grenze.
	BatchSoftFraction float64 `json:"batchSoftFraction"`
	// ClassLimits: gleichzeitige Jobs je Klasse und Host (0 = unbegrenzt).
	ClassLimits map[Class]int `json:"classLimits,omitempty"`
	Weights     Weights       `json:"weights"`
	Reserve     Reserve       `json:"liveReserve"`
	Protect     Protect       `json:"protect"`
	// Calibration: Auto-Kalibrierung der Live-Reserve aus der gemessenen Live-Last (Kapitel 54).
	Calibration CalibConfig         `json:"calibration"`
	Local       HostOpts            `json:"local"`
	Hosts       map[string]HostOpts `json:"hosts,omitempty"`
	// PathMap: Pfadpräfix am Orchestrator → Host-ID → Pfadpräfix auf dem Host.
	PathMap map[string]map[string]string `json:"pathMap,omitempty"`
}

// DefaultConfig: Auslieferungswerte. Das Standardziel ist `local` (heutiges Verhalten).
func DefaultConfig() Config {
	return Config{
		DefaultTarget: "local", MaxWaitS: 600, MaxAttempts: 2, LookaheadMin: 30,
		LiveHostPolicy: "reserve-only", BatchSoftFraction: 0.8,
		ClassLimits: map[Class]int{},
		Weights:     Weights{CPU: 1, GPU: 1, Jobs: 0.7, Live: 1.5, Data: 0.5, Net: 0.3},
		Reserve:     Reserve{CPU: 0.30, Mem: 0.25, GPU: 0.30, Net: 0.25},
		Calibration: defaultCalib(),
		Protect:     Protect{Enabled: true, ThrottleAt: 0.90, PauseAt: 1.0, CancelAt: 1.15, ResumeAt: 0.80, MaxPauseS: 120, IntervalS: 2},
		Local:       HostOpts{MaxJobs: 2},
		Hosts:       map[string]HostOpts{},
	}
}

// ParseConfig liest das Dokument über den Standardwerten und prüft es.
func ParseConfig(raw []byte) (Config, error) {
	c := DefaultConfig()
	if len(raw) > 0 {
		if err := json.Unmarshal(raw, &c); err != nil {
			return Config{}, fmt.Errorf("ffmpeg.config: %w", err)
		}
	}
	return c, c.Normalize()
}

// Normalize prüft und ergänzt Werte.
func (c *Config) Normalize() error {
	d := DefaultConfig()
	if c.DefaultTarget == "" {
		c.DefaultTarget = d.DefaultTarget
	}
	if _, err := ParseTarget(c.DefaultTarget); err != nil {
		return fmt.Errorf("defaultTarget: %w", err)
	}
	for k, v := range c.Defaults {
		if v == "" {
			delete(c.Defaults, k)
			continue
		}
		if _, err := ParseTarget(v); err != nil {
			return fmt.Errorf("defaults[%s]: %w", k, err)
		}
	}
	if c.MaxWaitS <= 0 {
		c.MaxWaitS = d.MaxWaitS
	}
	if c.MaxAttempts <= 0 {
		c.MaxAttempts = d.MaxAttempts
	}
	if c.LookaheadMin < 0 {
		return fmt.Errorf("lookaheadMin negativ")
	}
	switch c.LiveHostPolicy {
	case "":
		c.LiveHostPolicy = d.LiveHostPolicy
	case "reserve-only", "interactive-only":
	default:
		return fmt.Errorf("liveHostPolicy %q ungültig", c.LiveHostPolicy)
	}
	if c.BatchSoftFraction <= 0 || c.BatchSoftFraction > 1 {
		c.BatchSoftFraction = d.BatchSoftFraction
	}
	for _, f := range []float64{c.Reserve.CPU, c.Reserve.Mem, c.Reserve.GPU, c.Reserve.Net} {
		if f < 0 || f >= 1 {
			return fmt.Errorf("liveReserve: Anteile müssen in [0,1) liegen")
		}
	}
	w := c.Weights
	if w.CPU < 0 || w.GPU < 0 || w.Jobs < 0 || w.Live < 0 || w.Data < 0 || w.Net < 0 {
		return fmt.Errorf("weights dürfen nicht negativ sein")
	}
	if w == (Weights{}) {
		c.Weights = d.Weights
	}
	p := &c.Protect
	if p.ThrottleAt <= 0 {
		p.ThrottleAt = d.Protect.ThrottleAt
	}
	if p.PauseAt <= 0 {
		p.PauseAt = d.Protect.PauseAt
	}
	if p.CancelAt <= 0 {
		p.CancelAt = d.Protect.CancelAt
	}
	if p.ResumeAt <= 0 {
		p.ResumeAt = d.Protect.ResumeAt
	}
	if !(p.ResumeAt < p.ThrottleAt && p.ThrottleAt <= p.PauseAt && p.PauseAt < p.CancelAt) {
		return fmt.Errorf("protect: erwartet resumeAt < throttleAt ≤ pauseAt < cancelAt")
	}
	if p.MaxPauseS <= 0 {
		p.MaxPauseS = d.Protect.MaxPauseS
	}
	if p.IntervalS <= 0 {
		p.IntervalS = d.Protect.IntervalS
	}
	if err := c.Calibration.normalize(); err != nil {
		return err
	}
	if c.Local.MaxJobs <= 0 {
		c.Local.MaxJobs = d.Local.MaxJobs
	}
	if err := checkReserve(c.Local.Reserve); err != nil {
		return fmt.Errorf("local.reserve: %w", err)
	}
	for k, cl := range c.ClassLimits {
		if !k.valid() || cl < 0 {
			return fmt.Errorf("classLimits[%s] ungültig", k)
		}
	}
	if c.Hosts == nil {
		c.Hosts = map[string]HostOpts{}
	}
	for id, o := range c.Hosts {
		if o.Nice < 0 || o.Nice > 19 {
			return fmt.Errorf("hosts[%s].nice 0–19", id)
		}
		if err := checkReserve(o.Reserve); err != nil {
			return fmt.Errorf("hosts[%s].reserve: %w", id, err)
		}
	}
	return nil
}

// TargetFor löst das Ziel in der Rangfolge Job > Aufrufer > System auf.
func (c Config) TargetFor(spec Spec) (Target, error) {
	s := spec.Target
	if s == "" {
		s = c.Defaults[spec.Caller]
	}
	if s == "" {
		s = c.DefaultTarget
	}
	return ParseTarget(s)
}

func (c Config) hostOpts(id string) HostOpts {
	if id == LocalHostID {
		return c.Local
	}
	return c.Hosts[id]
}

// Pools liefert die Namen aller konfigurierten Pools (sortiert).
func (c Config) Pools() []string {
	set := map[string]bool{}
	for _, o := range c.Hosts {
		for _, p := range o.Pools {
			set[p] = true
		}
	}
	for _, p := range c.Local.Pools {
		set[p] = true
	}
	out := make([]string, 0, len(set))
	for p := range set {
		out = append(out, p)
	}
	sort.Strings(out)
	return out
}

func checkReserve(r *Reserve) error {
	if r == nil {
		return nil
	}
	for _, f := range []float64{r.CPU, r.Mem, r.GPU, r.Net} {
		if f < 0 || f >= 1 {
			return fmt.Errorf("Anteile müssen in [0,1) liegen")
		}
	}
	return nil
}
