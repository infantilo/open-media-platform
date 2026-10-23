package jobrun

import (
	"fmt"
	"sort"
	"strings"
	"time"
)

// ToolCaps: was ein Host für ein Programm meldet. Leere Listen heißen „unbekannt“ (noch nicht ermittelt), nicht „keine“.
type ToolCaps struct {
	Version  string
	Encoders []string
	Decoders []string
	Hwaccels []string
}

// GPUState ist die gemessene GPU-Last (nil in HostState = nicht gemessen).
type GPUState struct {
	UtilPercent float64
	MemUsedPct  float64
}

// RunningJob ist, was der Sendeschutz über einen laufenden Job wissen muss.
type RunningJob struct {
	ID          string
	Class       Class
	Paused      bool
	PausedSince time.Time
	Nice        int
	Started     time.Time
	Pausable    bool
}

// HostState ist der Zustand eines Hosts zum Zeitpunkt einer Entscheidung.
type HostState struct {
	ID, Label   string
	Local       bool
	Online      bool
	Maintenance bool
	// Capable: der Host kann Jobs ausführen (Agent meldet tools.json bzw. lokal: ffmpeg gefunden).
	Capable  bool
	Tools    map[string]ToolCaps
	Roots    []string
	AllowNet bool

	CPUPercent float64 // Gesamtauslastung 0–100
	CPUCores   float64
	MemUsedPct float64
	Gpu        *GPUState
	NetUtil    float64 // 0–1, −1 = unbekannt

	// Live-Nodes (vom Agent/Launcher verwaltete Instanzen) auf dem Host.
	LiveInstances  int
	LiveCPUPercent float64 // Summe der Instanz-CPU in % des Gesamthosts

	MaxJobs     int
	Running     int // laufende Jobs dieses Dispatchers
	Reserved    int // zugewiesen, aber noch nicht gestartet
	ReservedCPU float64
	ByClass     map[Class]int
	Jobs        []RunningJob

	// Reserve: für diesen Host geltende Live-Reserve (Host-Vorgabe, Auto-Kalibrierung oder System-Wert); nil = System-Wert.
	Reserve   *Reserve
	Pools     []string
	BatchOnly bool
	NoBatch   bool
	Disabled  bool
}

// Candidate ist ein Host in der Entscheidung.
type Candidate struct {
	Host     string             `json:"host"`
	Label    string             `json:"label,omitempty"`
	Score    float64            `json:"score,omitempty"`
	Parts    map[string]float64 `json:"parts,omitempty"`
	Rejected string             `json:"rejected,omitempty"`
}

// Decision ist das Ergebnis der Zuweisung samt Begründung.
type Decision struct {
	Target     string      `json:"target"`
	Host       string      `json:"host,omitempty"`
	Reason     string      `json:"reason,omitempty"` // bei Host == "": warum nichts gewählt wurde
	Candidates []Candidate `json:"candidates"`
	At         time.Time   `json:"at"`
}

// PlaceCtx liefert Prüfungen, die vom Dispatcher abhängen (Dateisystem, Buchungen).
type PlaceCtx struct {
	Now time.Time
	// PathOK prüft Ein-/Ausgabepfade auf dem Host (nil = ok).
	PathOK func(h HostState) (bool, string)
	// Busy: gebuchte Live-Belegung des Hosts, in die der Job hineinlaufen würde (nil = nein).
	Busy func(h HostState, within time.Duration) (bool, string)
	// DataLocal: liegen die Eingaben auf diesem Host? (nil = nur der lokale Host)
	DataLocal func(h HostState) bool
}

// Traits sind die aus den Argumenten abgeleiteten Anforderungen eines Jobs.
type Traits struct {
	Encoders []string
	Decoders []string
	Hwaccels []string
	UsesGPU  bool
}

// TraitsOf liest Encoder/Decoder/Hwaccel aus dem Argumentvektor.
func TraitsOf(args []string) Traits {
	var t Traits
	add := func(list *[]string, v string) {
		for _, x := range *list {
			if x == v {
				return
			}
		}
		*list = append(*list, v)
	}
	for i := 0; i < len(args); i++ {
		a := args[i]
		next := ""
		if i+1 < len(args) {
			next = args[i+1]
		}
		switch {
		case a == "-hwaccel" && next != "":
			add(&t.Hwaccels, next)
			if next != "none" && next != "auto" {
				t.UsesGPU = true
			}
		case a == "-c" || a == "-codec" || a == "-vcodec" || a == "-acodec" || a == "-scodec" || strings.HasPrefix(a, "-c:") || strings.HasPrefix(a, "-codec:"):
			if next == "" || next == "copy" {
				continue
			}
			// Position entscheidet: Decoder steht vor dem nächsten -i, Encoder danach.
			if seenInput(args, i) {
				add(&t.Encoders, next)
			} else {
				add(&t.Decoders, next)
			}
			if gpuCodec(next) {
				t.UsesGPU = true
			}
		}
	}
	return t
}

func seenInput(args []string, idx int) bool {
	for i := 0; i < idx; i++ {
		if args[i] == "-i" {
			// ein -i vor dem Codec-Schalter: alle Eingaben davor; Optionen nach dem letzten -i gelten der Ausgabe
			for j := idx; j < len(args); j++ {
				if args[j] == "-i" {
					return false
				}
			}
			return true
		}
	}
	return false
}

func gpuCodec(name string) bool {
	for _, s := range []string{"_nvenc", "_cuvid", "_qsv", "_vaapi", "_amf", "_videotoolbox", "_vulkan", "_cuda"} {
		if strings.HasSuffix(name, s) {
			return true
		}
	}
	return false
}

func has(list []string, v string) bool {
	for _, x := range list {
		if x == v {
			return true
		}
	}
	return false
}

func clamp01(v float64) float64 {
	if v < 0 {
		return 0
	}
	if v > 1 {
		return 1
	}
	return v
}

func classFactor(c Class, cfg Config) float64 {
	switch c {
	case ClassInteractive:
		return 1
	case ClassScheduled:
		return 0.9
	}
	return cfg.BatchSoftFraction
}

// CPULimit ist die Obergrenze der Gesamt-CPU (in %) mit der System-Reserve, bis zu der ein Job der Klasse noch starten darf.
func CPULimit(c Class, cfg Config) float64 {
	return 100 * (1 - cfg.Reserve.CPU) * classFactor(c, cfg)
}

// ReserveOf liefert die für den Host geltende Reserve.
func (h HostState) ReserveOf(cfg Config) Reserve {
	if h.Reserve != nil {
		return *h.Reserve
	}
	return cfg.Reserve
}

// CPULimitFor wie CPULimit, aber mit der Reserve des Hosts.
func CPULimitFor(c Class, cfg Config, h HostState) float64 {
	return 100 * (1 - h.ReserveOf(cfg).CPU) * classFactor(c, cfg)
}

func matchesTarget(h HostState, tgt Target) bool {
	switch tgt.Kind {
	case "local":
		return h.Local
	case "host":
		return h.ID == tgt.Name
	case "pool":
		return has(h.Pools, tgt.Name)
	}
	return true
}

// Place wählt den Host für einen Job: harte Filter, dann Bewertung (kleinster Score gewinnt, Gleichstand nach Host-ID).
func Place(spec Spec, tgt Target, hosts []HostState, cfg Config, pc PlaceCtx) Decision {
	if pc.Now.IsZero() {
		pc.Now = time.Now()
	}
	class := spec.Class
	if !class.valid() {
		class = ClassBatch
	}
	tr := TraitsOf(spec.Args)
	d := Decision{Target: tgt.String(), At: pc.Now}
	within := time.Duration(cfg.LookaheadMin) * time.Minute
	if spec.EstimateS > 0 {
		within = time.Duration(spec.EstimateS) * time.Second
	}

	type scored struct {
		c Candidate
		h HostState
	}
	var ok []scored
	sorted := append([]HostState(nil), hosts...)
	sort.Slice(sorted, func(i, j int) bool { return sorted[i].ID < sorted[j].ID })
	for _, h := range sorted {
		c := Candidate{Host: h.ID, Label: h.Label}
		reject := func(format string, a ...any) {
			c.Rejected = fmt.Sprintf(format, a...)
		}
		switch {
		case !matchesTarget(h, tgt):
			continue // gehört nicht zum Ziel: nicht einmal als Kandidat aufführen
		case h.Disabled:
			reject("für ffmpeg-Jobs deaktiviert")
		case !h.Online:
			reject("offline")
		case h.Maintenance:
			reject("im Wartungsmodus")
		case !h.Capable:
			reject("führt keine Jobs aus (tools.json fehlt bzw. Programm nicht gefunden)")
		}
		if c.Rejected == "" {
			if _, have := h.Tools[spec.Tool]; !have {
				reject("Programm %s nicht freigegeben", spec.Tool)
			}
		}
		if c.Rejected == "" {
			caps := h.Tools[spec.Tool]
			for _, e := range tr.Encoders {
				if len(caps.Encoders) > 0 && !has(caps.Encoders, e) {
					reject("Encoder %s fehlt", e)
					break
				}
			}
			for _, e := range tr.Decoders {
				if c.Rejected == "" && len(caps.Decoders) > 0 && !has(caps.Decoders, e) {
					reject("Decoder %s fehlt", e)
				}
			}
			for _, e := range tr.Hwaccels {
				if c.Rejected == "" && e != "none" && e != "auto" && len(caps.Hwaccels) > 0 && !has(caps.Hwaccels, e) {
					reject("Hwaccel %s fehlt", e)
				}
			}
		}
		if c.Rejected == "" && h.NoBatch && class != ClassInteractive {
			reject("Host ist für Batch gesperrt (noBatch)")
		}
		if c.Rejected == "" && cfg.LiveHostPolicy == "interactive-only" && h.LiveInstances > 0 && !h.BatchOnly && class != ClassInteractive {
			reject("Host trägt Live-Nodes: nur interaktive Jobs")
		}
		if c.Rejected == "" && h.MaxJobs > 0 && h.Running+h.Reserved >= h.MaxJobs {
			reject("alle Job-Plätze belegt (%d/%d)", h.Running+h.Reserved, h.MaxJobs)
		}
		if c.Rejected == "" {
			if lim := cfg.ClassLimits[class]; lim > 0 && h.ByClass[class] >= lim {
				reject("Grenze für Klasse %s erreicht (%d)", class, lim)
			}
		}
		if c.Rejected == "" {
			rs := h.ReserveOf(cfg)
			if cpu := h.CPUPercent + h.ReservedCPU; cpu >= CPULimitFor(class, cfg, h) {
				reject("Live-Reserve CPU (%.0f %% ≥ %.0f %%)", cpu, CPULimitFor(class, cfg, h))
			} else if h.MemUsedPct >= 100*(1-rs.Mem) {
				reject("Live-Reserve Speicher (%.0f %%)", h.MemUsedPct)
			} else if tr.UsesGPU && h.Gpu != nil && (h.Gpu.UtilPercent >= 100*(1-rs.GPU) || h.Gpu.MemUsedPct >= 100*(1-rs.GPU)) {
				reject("Live-Reserve GPU (%.0f %%)", h.Gpu.UtilPercent)
			}
		}
		if c.Rejected == "" && pc.PathOK != nil {
			if okp, why := pc.PathOK(h); !okp {
				reject("Pfade nicht sichtbar: %s", why)
			}
		}
		if c.Rejected == "" && pc.Busy != nil {
			if busy, why := pc.Busy(h, within); busy {
				reject("gebuchte Live-Belegung: %s", why)
			}
		}
		if c.Rejected != "" {
			d.Candidates = append(d.Candidates, c)
			continue
		}
		ok = append(ok, scored{c: c, h: h})
	}

	// GPU „unbekannt ≠ leer“: Mittelwert der gemessenen Hosts plus Aufschlag.
	gpuKnown, gpuSum := 0, 0.0
	if tr.UsesGPU {
		for _, s := range ok {
			if s.h.Gpu != nil {
				gpuKnown++
				gpuSum += clamp01(maxf(s.h.Gpu.UtilPercent, s.h.Gpu.MemUsedPct) / 100)
			}
		}
	}
	w := cfg.Weights
	for i := range ok {
		h := ok[i].h
		parts := map[string]float64{}
		parts["cpu"] = w.CPU * clamp01((h.CPUPercent+h.ReservedCPU)/100)
		if tr.UsesGPU {
			var g float64
			switch {
			case h.Gpu != nil:
				g = clamp01(maxf(h.Gpu.UtilPercent, h.Gpu.MemUsedPct) / 100)
			case gpuKnown > 0:
				g = clamp01(gpuSum/float64(gpuKnown) + 0.15)
			default:
				g = 0.5
			}
			parts["gpu"] = w.GPU * g
		}
		if h.MaxJobs > 0 {
			parts["jobs"] = w.Jobs * clamp01(float64(h.Running+h.Reserved)/float64(h.MaxJobs))
		}
		if !h.BatchOnly {
			live := 0.7*clamp01(h.LiveCPUPercent/100) + 0.3*clamp01(float64(h.LiveInstances)/6)
			parts["live"] = w.Live * live
		}
		local := h.Local
		if pc.DataLocal != nil {
			local = pc.DataLocal(h)
		}
		if !local {
			parts["data"] = w.Data
		}
		if h.NetUtil > 0 {
			parts["net"] = w.Net * clamp01(h.NetUtil)
		}
		sum := 0.0
		for _, v := range parts {
			sum += v
		}
		ok[i].c.Score = round3(sum)
		ok[i].c.Parts = parts
	}
	sort.SliceStable(ok, func(i, j int) bool {
		if ok[i].c.Score != ok[j].c.Score {
			return ok[i].c.Score < ok[j].c.Score
		}
		return ok[i].h.ID < ok[j].h.ID
	})
	cands := make([]Candidate, 0, len(ok))
	for _, s := range ok {
		cands = append(cands, s.c)
	}
	d.Candidates = append(cands, d.Candidates...)
	if len(ok) > 0 {
		d.Host = ok[0].h.ID
		return d
	}
	d.Reason = reasonOf(d.Candidates, tgt)
	return d
}

func maxf(a, b float64) float64 {
	if a > b {
		return a
	}
	return b
}

func round3(v float64) float64 { return float64(int(v*1000+0.5)) / 1000 }

func reasonOf(c []Candidate, tgt Target) string {
	if len(c) == 0 {
		return fmt.Sprintf("kein Host für das Ziel %s", tgt)
	}
	parts := make([]string, 0, len(c))
	for _, x := range c {
		parts = append(parts, x.Host+": "+x.Rejected)
	}
	return strings.Join(parts, "; ")
}
