package ingest

import (
	"encoding/json"
	"fmt"
	"strings"
)

// Config: Einstellungsdokument „ingest.config“ (Konfiguration ohne Neustart änderbar). Fehlende Felder → Standardwerte.
type Config struct {
	Profiles      map[string]Profile    `json:"profiles"`
	DefaultBudget HostBudget            `json:"defaultBudget"`
	HostBudgets   map[string]HostBudget `json:"hostBudgets"` // Schlüssel: Host-ID oder "local"
	Rules         RulesConfig           `json:"rules"`
	// LeadTimeS: Vorwärmzeit — der Rekorder wird so lange VOR dem Start gestartet und verbunden (Modell „hybrid“).
	LeadTimeS int `json:"leadTimeS"`
	// MaxStartDeviationS: Zielwert für die Startabweichung (Kennzahl/Warnung, keine Zusage).
	MaxStartDeviationS int `json:"maxStartDeviationS"`
	// HorizonHours: so weit im Voraus werden Vorkommen eines Zeitplans zu Aufträgen und reserviert.
	HorizonHours int `json:"horizonHours"`
	// MediaDir: Verzeichnis, in das der Rekorder schreibt (OMP_MEDIA_DIR der Rekorder-Instanz auf dem Orchestrator-Host).
	MediaDir string `json:"mediaDir"`
	// DefaultLate / DefaultRetry gelten, wenn ein Zeitplan nichts angibt.
	DefaultLate  LatePolicy  `json:"defaultLate"`
	DefaultRetry RetryPolicy `json:"defaultRetry"`
}

type HostBudget struct {
	Hard      map[string]float64 `json:"hard,omitempty"`
	SoftFrac  float64            `json:"softFraction,omitempty"`
	Functions []string           `json:"functions,omitempty"`
}

type RulesConfig struct {
	ReservePct          map[string]float64 `json:"reservePct,omitempty"`
	ReserveFromPriority int                `json:"reserveFromPriority,omitempty"`
	SourceLimit         int                `json:"sourceLimit,omitempty"`
	SourceOverride      map[string]int     `json:"sourceOverride,omitempty"`
	AllowPreempt        bool               `json:"allowPreempt,omitempty"`
}

// Profile: Aufnahmeprofil mit Bedarf (je Wert Herkunft), Ausgabeformat und optionaler Nachbearbeitung.
type Profile struct {
	ID    string `json:"id"`
	Label string `json:"label"`
	// Ext: Dateiendung der Aufnahme (".mxf" = H.264 + PCM 24 Bit, MCA-Labels möglich).
	Ext string `json:"ext"`
	// Demand: konfigurierter Bedarf je Ressource; fehlende Ressourcen → Standardwert (Herkunft „default“).
	Demand  map[string]float64 `json:"demand,omitempty"`
	McaPlan string             `json:"mcaPlan,omitempty"`
	// Convert: optionale Nachbearbeitung (ffmpeg). Entfällt, wenn das Aufnahmeformat schon das Ziel ist.
	Convert *ConvertStep `json:"convert,omitempty"`
}

type ConvertStep struct {
	Ext  string   `json:"ext"`  // Endung der Ausgabe, z. B. ".mp4"
	Args []string `json:"args"` // ffmpeg-Argumente zwischen -i <Eingabe> und <Ausgabe>
}

type LatePolicy struct {
	// Mode: wait (warten, bis die Quelle da ist; Aufnahme endet zur geplanten Zeit), delay (wie wait, aber höchstens MaxDelayS), fail.
	Mode      string `json:"mode,omitempty"`
	MaxDelayS int    `json:"maxDelayS,omitempty"`
}

type RetryPolicy struct {
	MaxAttempts int `json:"maxAttempts,omitempty"`
	BackoffS    int `json:"backoffS,omitempty"`
	// MinRemainingS: nach einem Abbruch wird nur noch neu gestartet, wenn mindestens so viel Zeit bleibt.
	MinRemainingS int `json:"minRemainingS,omitempty"`
}

// Standardbedarf (Herkunft „default“): konservativ.
var defaultDemand = map[string]float64{ResRecorders: 1, ResCPU: 1.0, ResMem: 800, ResDiskMBps: 12, ResNetMbps: 120, ResMXLShm: 128, ResDiskGB: 0 /* aus Rate × Dauer */}

func DefaultConfig() Config {
	p := Profile{ID: "mxf-h264", Label: "MXF (H.264 + PCM 24 Bit)", Ext: ".mxf"}
	return Config{
		Profiles:      map[string]Profile{p.ID: p},
		DefaultBudget: HostBudget{Hard: map[string]float64{ResRecorders: 2, ResCPU: 4, ResMem: 6144, ResDiskMBps: 200, ResDiskGB: 200, ResNetMbps: 800, ResMXLShm: 1024, ResConverter: 1}, SoftFrac: 0.8, Functions: []string{"recorder", "converter"}},
		HostBudgets:   map[string]HostBudget{},
		Rules:         RulesConfig{SourceLimit: 4},
		LeadTimeS:     45, MaxStartDeviationS: 10, HorizonHours: 48,
		MediaDir:     "data",
		DefaultLate:  LatePolicy{Mode: "wait", MaxDelayS: 600},
		DefaultRetry: RetryPolicy{MaxAttempts: 2, BackoffS: 5, MinRemainingS: 20},
	}
}

func (c *Config) Normalize() error {
	d := DefaultConfig()
	if len(c.Profiles) == 0 {
		c.Profiles = d.Profiles
	}
	for k, p := range c.Profiles {
		if p.ID == "" {
			p.ID = k
		}
		if p.ID != k {
			return fmt.Errorf("Profil %q: id %q passt nicht zum Schlüssel", k, p.ID)
		}
		if !strings.HasPrefix(p.Ext, ".") || len(p.Ext) < 3 || len(p.Ext) > 6 {
			return fmt.Errorf("Profil %q: Endung %q ungültig (z. B. .mxf)", k, p.Ext)
		}
		for r, v := range p.Demand {
			if v < 0 {
				return fmt.Errorf("Profil %q: Bedarf %s negativ", k, r)
			}
		}
		if p.Convert != nil && (!strings.HasPrefix(p.Convert.Ext, ".") || len(p.Convert.Args) == 0) {
			return fmt.Errorf("Profil %q: Nachbearbeitung braucht Endung und Argumente", k)
		}
		c.Profiles[k] = p
	}
	if len(c.DefaultBudget.Hard) == 0 {
		c.DefaultBudget = d.DefaultBudget
	}
	if c.HostBudgets == nil {
		c.HostBudgets = map[string]HostBudget{}
	}
	if c.Rules.SourceLimit <= 0 {
		c.Rules.SourceLimit = 4
	}
	if c.LeadTimeS < 0 || c.LeadTimeS > 3600 {
		return fmt.Errorf("leadTimeS außerhalb 0–3600")
	}
	if c.LeadTimeS == 0 {
		c.LeadTimeS = d.LeadTimeS
	}
	if c.MaxStartDeviationS <= 0 {
		c.MaxStartDeviationS = d.MaxStartDeviationS
	}
	if c.HorizonHours < 1 || c.HorizonHours > 24*30 {
		c.HorizonHours = d.HorizonHours
	}
	if c.MediaDir == "" {
		c.MediaDir = d.MediaDir
	}
	if err := c.DefaultLate.validate(); err != nil {
		return err
	}
	if c.DefaultLate.Mode == "" {
		c.DefaultLate = d.DefaultLate
	}
	if c.DefaultRetry.MaxAttempts < 1 {
		c.DefaultRetry = d.DefaultRetry
	}
	return nil
}

func (l LatePolicy) validate() error {
	switch l.Mode {
	case "", "wait", "delay", "fail":
		return nil
	}
	return fmt.Errorf("Verspätungsrichtlinie %q unbekannt (wait, delay, fail)", l.Mode)
}

func ParseConfig(raw []byte) (Config, error) {
	c := DefaultConfig()
	if len(strings.TrimSpace(string(raw))) > 0 {
		if err := json.Unmarshal(raw, &c); err != nil {
			return Config{}, fmt.Errorf("Konfiguration unlesbar: %w", err)
		}
	}
	if err := c.Normalize(); err != nil {
		return Config{}, err
	}
	return c, nil
}

// Stats: gemessene Werte je Profil (aus abgeschlossenen Aufnahmen).
type Stats struct {
	Samples   int
	BytesPerS float64
	CPUP95    float64
	MemMB     float64
}

// EffectiveDemand führt Standardwerte, Konfiguration und Messung zusammen — **Messung vor Konfiguration vor Standard**, die Herkunft
// bleibt je Wert erhalten. Speicherplatz wird aus Rate × Dauer abgeleitet (Herkunft = Herkunft der Rate).
func EffectiveDemand(p Profile, st *Stats, durationS float64) Demand {
	d := Demand{Amount: map[string]float64{}, Origin: map[string]string{}}
	for r, v := range defaultDemand {
		d.Amount[r], d.Origin[r] = v, OriginDefault
	}
	for r, v := range p.Demand {
		d.Amount[r], d.Origin[r] = v, OriginConfigured
	}
	if st != nil && st.Samples > 0 {
		if st.BytesPerS > 0 {
			d.Amount[ResDiskMBps], d.Origin[ResDiskMBps] = st.BytesPerS/1e6*1.2, OriginMeasured // 20 % Sicherheit
		}
		if st.CPUP95 > 0 {
			d.Amount[ResCPU], d.Origin[ResCPU] = st.CPUP95, OriginMeasured
		}
		if st.MemMB > 0 {
			d.Amount[ResMem], d.Origin[ResMem] = st.MemMB, OriginMeasured
		}
	}
	// Speicherplatz in GB = MB/s × s / 1000 (Rate schließt die Sicherheit bereits ein)
	d.Amount[ResDiskGB] = d.Amount[ResDiskMBps] * durationS / 1000
	d.Origin[ResDiskGB] = d.Origin[ResDiskMBps]
	return d
}
