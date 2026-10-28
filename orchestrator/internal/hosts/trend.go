package hosts

import (
	"context"
	"database/sql"
	"math"
	"sort"
	"time"
)

// Trend-Daten (Kapitel 54): zusätzlich zu CPU/RAM je Sample der Live-Anteil (Instanzen), GPU und Netzauslastung. Stundenwerte
// werden in Postgres gehalten (30 Tage) und überstehen so einen Neustart — Grundlage der Auto-Kalibrierung der Live-Reserve
// und der 7-/30-Tage-Ansicht.

const (
	hourWindow   = 30 * 24 * time.Hour
	hourCapacity = int(hourWindow / time.Hour)
)

// Extra sind die zusätzlichen Messgrößen eines Samples (alle 0, wenn nicht gemessen).
type Extra struct {
	// LiveCPUCores: Summe der CPU-Nutzung der vom Orchestrator/Agent gestarteten Instanzen in Kernen (Jobs zählen nicht mit).
	LiveCPUCores float64 `json:"liveCpuCores,omitempty"`
	// LiveMemPercent: Summe der RSS der Instanzen in % des Hostspeichers.
	LiveMemPercent float64 `json:"liveMemPercent,omitempty"`
	// LiveGPUPercent: Summe der GPU-Nutzung der Instanzen in % einer GPU (Mittel über die GPUs des Hosts).
	LiveGPUPercent float64 `json:"liveGpuPercent,omitempty"`
	// GPUPercent: Gesamtauslastung der GPU (inkl. Jobs).
	GPUPercent float64 `json:"gpuPercent,omitempty"`
	// NetPercent: Auslastung der Netzwerkkarte in % der Linkgeschwindigkeit (0, wenn nicht bekannt).
	NetPercent float64 `json:"netPercent,omitempty"`
	// TempC: CPU-/Plattformtemperatur in °C (0 = nicht gemessen), PowerW: Leistungsaufnahme in Watt (0 = nicht gemessen).
	TempC  float64 `json:"tempC,omitempty"`
	PowerW float64 `json:"powerW,omitempty"`
	// Instances: Anzahl gemeldeter Instanzen.
	Instances int `json:"instances,omitempty"`
}

// ExtraMax: Maxima der Zusatzgrößen in einem Aggregat.
type ExtraMax struct {
	LiveCPUCoresMax float64 `json:"liveCpuCoresMax,omitempty"`
	LiveMemMax      float64 `json:"liveMemMax,omitempty"`
	LiveGPUMax      float64 `json:"liveGpuMax,omitempty"`
	GPUMax          float64 `json:"gpuMax,omitempty"`
	NetMax          float64 `json:"netMax,omitempty"`
	TempMax         float64 `json:"tempMax,omitempty"`
	PowerMax        float64 `json:"powerMax,omitempty"`
}

func (e ExtraMax) maxWith(x Extra) ExtraMax {
	e.LiveCPUCoresMax = math.Max(e.LiveCPUCoresMax, x.LiveCPUCores)
	e.LiveMemMax = math.Max(e.LiveMemMax, x.LiveMemPercent)
	e.LiveGPUMax = math.Max(e.LiveGPUMax, x.LiveGPUPercent)
	e.GPUMax = math.Max(e.GPUMax, x.GPUPercent)
	e.NetMax = math.Max(e.NetMax, x.NetPercent)
	e.TempMax = math.Max(e.TempMax, x.TempC)
	e.PowerMax = math.Max(e.PowerMax, x.PowerW)
	return e
}

func (e ExtraMax) merge(o ExtraMax) ExtraMax {
	e.LiveCPUCoresMax = math.Max(e.LiveCPUCoresMax, o.LiveCPUCoresMax)
	e.LiveMemMax = math.Max(e.LiveMemMax, o.LiveMemMax)
	e.LiveGPUMax = math.Max(e.LiveGPUMax, o.LiveGPUMax)
	e.GPUMax = math.Max(e.GPUMax, o.GPUMax)
	e.NetMax = math.Max(e.NetMax, o.NetMax)
	e.TempMax = math.Max(e.TempMax, o.TempMax)
	e.PowerMax = math.Max(e.PowerMax, o.PowerMax)
	return e
}

func extraOf(m Metrics) Extra {
	var x Extra
	var rss uint64
	var gpu float64
	for _, in := range m.Instances {
		x.Instances++
		x.LiveCPUCores += in.CPUPercent / 100
		rss += in.RSSBytes
		if in.GpuPercent != nil {
			gpu += *in.GpuPercent
		}
	}
	if m.MemTotalBytes > 0 {
		x.LiveMemPercent = float64(rss) / float64(m.MemTotalBytes) * 100
	}
	if m.Gpu != nil {
		x.GPUPercent = m.Gpu.UtilizationPercent
		n := m.Gpu.Count
		if n < 1 {
			n = 1
		}
		x.LiveGPUPercent = gpu / float64(n)
	}
	if m.Sensors != nil {
		if m.Sensors.TempC != nil {
			x.TempC = *m.Sensors.TempC
		}
		if m.Sensors.PowerW != nil {
			x.PowerW = *m.Sensors.PowerW
		}
	}
	if m.Net != nil && m.Net.LinkMbps > 0 {
		x.NetPercent = (m.Net.RxBytesPerSec + m.Net.TxBytesPerSec) * 8 / 1e6 / m.Net.LinkMbps * 100
	}
	return x
}

// HourRow ist die Stundenverdichtung (Persistenz und 7-/30-Tage-Ansicht).
type HourRow struct {
	Hour    time.Time `json:"hour"`
	CPUAvg  float64   `json:"cpuAvg"`
	CPUMax  float64   `json:"cpuMax"`
	MemAvg  float64   `json:"memAvg"`
	MemMax  float64   `json:"memMax"`
	Samples int       `json:"samples"`
	// P95 der Live-CPU (Kerne) innerhalb der Stunde — robuster als das Maximum gegen einzelne Spitzen.
	LiveCPUCoresP95 float64 `json:"liveCpuCoresP95,omitempty"`
	LiveCPUCoresAvg float64 `json:"liveCpuCoresAvg,omitempty"`
	ExtraMax
}

type hourAcc struct {
	start          time.Time
	n              int
	cpuSum, cpuMax float64
	memSum, memMax float64
	liveCPU        []float64
	liveSum        float64
	max            ExtraMax
}

// add nimmt ein Sample auf; beginnt eine neue Stunde, wird die abgeschlossene geliefert.
func (a *hourAcc) add(s Sample) (HourRow, bool) {
	hour := s.Timestamp.Truncate(time.Hour)
	var out HourRow
	done := false
	if !a.start.IsZero() && !hour.Equal(a.start) {
		out, done = a.finish(), true
		*a = hourAcc{}
	}
	if a.start.IsZero() {
		a.start = hour
	}
	a.n++
	a.cpuSum += s.CPUPercent
	a.cpuMax = math.Max(a.cpuMax, s.CPUPercent)
	a.memSum += s.MemPercent
	a.memMax = math.Max(a.memMax, s.MemPercent)
	a.liveCPU = append(a.liveCPU, s.LiveCPUCores)
	a.liveSum += s.LiveCPUCores
	a.max = a.max.maxWith(s.Extra)
	return out, done
}

func (a *hourAcc) finish() HourRow {
	if a.n == 0 {
		return HourRow{}
	}
	return HourRow{Hour: a.start, CPUAvg: a.cpuSum / float64(a.n), CPUMax: a.cpuMax, MemAvg: a.memSum / float64(a.n), MemMax: a.memMax,
		Samples: a.n, LiveCPUCoresP95: percentile(a.liveCPU, 0.95), LiveCPUCoresAvg: a.liveSum / float64(a.n), ExtraMax: a.max}
}

func percentile(v []float64, p float64) float64 {
	if len(v) == 0 {
		return 0
	}
	c := append([]float64(nil), v...)
	sort.Float64s(c)
	i := int(math.Ceil(p*float64(len(c)))) - 1
	if i < 0 {
		i = 0
	}
	return c[i]
}

func summarizeHours(h []HourRow) Summary {
	if len(h) == 0 {
		return Summary{}
	}
	s := Summary{CPUMin: h[0].CPUAvg, CPUMax: h[0].CPUMax, MemMin: h[0].MemAvg, MemMax: h[0].MemMax}
	var cw, mw float64
	for _, x := range h {
		cw += x.CPUAvg * float64(x.Samples)
		mw += x.MemAvg * float64(x.Samples)
		s.SampleCount += x.Samples
		s.CPUMin = math.Min(s.CPUMin, x.CPUAvg)
		s.CPUMax = math.Max(s.CPUMax, x.CPUMax)
		s.MemMin = math.Min(s.MemMin, x.MemAvg)
		s.MemMax = math.Max(s.MemMax, x.MemMax)
	}
	if s.SampleCount > 0 {
		s.CPUAvg, s.MemAvg = cw/float64(s.SampleCount), mw/float64(s.SampleCount)
	}
	return s
}

// Seed übernimmt gespeicherte Stundenwerte (beim Start).
func (h *History) Seed(hostID string, rows []HourRow) {
	h.mu.Lock()
	defer h.mu.Unlock()
	hh := h.byHost[hostID]
	if hh == nil {
		hh = &hostHistory{}
		h.byHost[hostID] = hh
	}
	sort.Slice(rows, func(i, j int) bool { return rows[i].Hour.Before(rows[j].Hour) })
	hh.hours = append(rows, hh.hours...)
	if len(hh.hours) > hourCapacity {
		hh.hours = hh.hours[len(hh.hours)-hourCapacity:]
	}
}

// LiveDemand fasst den Live-Bedarf eines Hosts über ein Fenster zusammen (Grundlage der Kalibrierung).
type LiveDemand struct {
	// Span: Zeitraum, den die Daten tatsächlich abdecken.
	Span    time.Duration `json:"spanS"`
	Samples int           `json:"samples"`
	// Live-CPU in Kernen: aktuell, P95, Spitze.
	CPUNow, CPUP95, CPUPeak float64
	// Live-Speicher in % des Hosts.
	MemNow, MemP95, MemPeak float64
	// Live-GPU in % einer GPU.
	GPUNow, GPUP95, GPUPeak float64
}

// LiveDemand wertet Roh-Samples (letzte Stunde), Minutenwerte (24 h) und Stundenwerte (bis `window`) aus.
func (h *History) LiveDemand(hostID string, window time.Duration) (LiveDemand, bool) {
	h.mu.Lock()
	defer h.mu.Unlock()
	hh, ok := h.byHost[hostID]
	if !ok {
		return LiveDemand{}, false
	}
	cutoff := time.Now().Add(-window)
	var cpu, mem, gpu []float64
	var first time.Time
	var d LiveDemand
	note := func(t time.Time) {
		if first.IsZero() || t.Before(first) {
			first = t
		}
	}
	// Peaks aus den Aggregaten (Maxima je Minute bzw. Stunde), Verteilung aus Minuten-Maxima und Roh-Samples
	for _, hr := range hh.hours {
		if hr.Hour.Before(cutoff) {
			continue
		}
		note(hr.Hour)
		d.Samples += hr.Samples
		cpu, mem, gpu = append(cpu, hr.LiveCPUCoresP95), append(mem, hr.LiveMemMax), append(gpu, hr.LiveGPUMax)
		d.CPUPeak, d.MemPeak, d.GPUPeak = math.Max(d.CPUPeak, hr.LiveCPUCoresMax), math.Max(d.MemPeak, hr.LiveMemMax), math.Max(d.GPUPeak, hr.LiveGPUMax)
	}
	var lastHour time.Time
	if n := len(hh.hours); n > 0 {
		lastHour = hh.hours[n-1].Hour.Add(time.Hour)
	}
	for _, a := range hh.aggregates {
		if a.BucketStart.Before(cutoff) || a.BucketStart.Before(lastHour) {
			continue // schon in den Stundenwerten
		}
		note(a.BucketStart)
		d.Samples += a.SampleCount
		cpu, mem, gpu = append(cpu, a.LiveCPUCoresMax), append(mem, a.LiveMemMax), append(gpu, a.LiveGPUMax)
		d.CPUPeak, d.MemPeak, d.GPUPeak = math.Max(d.CPUPeak, a.LiveCPUCoresMax), math.Max(d.MemPeak, a.LiveMemMax), math.Max(d.GPUPeak, a.LiveGPUMax)
	}
	if n := len(hh.raw); n > 0 {
		last := hh.raw[n-1]
		d.CPUNow, d.MemNow, d.GPUNow = last.LiveCPUCores, last.LiveMemPercent, last.LiveGPUPercent
		for _, s := range hh.raw {
			if s.Timestamp.Before(cutoff) {
				continue
			}
			note(s.Timestamp)
			d.CPUPeak, d.MemPeak, d.GPUPeak = math.Max(d.CPUPeak, s.LiveCPUCores), math.Max(d.MemPeak, s.LiveMemPercent), math.Max(d.GPUPeak, s.LiveGPUPercent)
		}
	}
	if len(cpu) == 0 && len(hh.raw) == 0 {
		return LiveDemand{}, false
	}
	d.CPUP95, d.MemP95, d.GPUP95 = percentile(cpu, 0.95), percentile(mem, 0.95), percentile(gpu, 0.95)
	if len(cpu) == 0 { // nur Rohdaten
		var rc, rm, rg []float64
		for _, s := range hh.raw {
			rc, rm, rg = append(rc, s.LiveCPUCores), append(rm, s.LiveMemPercent), append(rg, s.LiveGPUPercent)
			d.Samples++
		}
		d.CPUP95, d.MemP95, d.GPUP95 = percentile(rc, 0.95), percentile(rm, 0.95), percentile(rg, 0.95)
	}
	if !first.IsZero() {
		d.Span = time.Since(first)
	}
	return d, true
}

// --- Persistenz --------------------------------------------------------------------------------------

// HourStore speichert Stundenwerte in Postgres (Tabelle host_metrics_hourly, 30 Tage).
type HourStore struct{ db *sql.DB }

func NewHourStore(db *sql.DB) *HourStore { return &HourStore{db: db} }

func (s *HourStore) Save(hostID string, r HourRow) error {
	_, err := s.db.Exec(`INSERT INTO host_metrics_hourly (host_id, hour, cpu_avg, cpu_max, mem_avg, mem_max, samples, live_cpu_p95, live_cpu_avg,
			live_cpu_max, live_mem_max, live_gpu_max, gpu_max, net_max, temp_max, power_max)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
		ON CONFLICT (host_id, hour) DO UPDATE SET cpu_avg=$3, cpu_max=$4, mem_avg=$5, mem_max=$6, samples=$7, live_cpu_p95=$8, live_cpu_avg=$9,
			live_cpu_max=$10, live_mem_max=$11, live_gpu_max=$12, gpu_max=$13, net_max=$14, temp_max=$15, power_max=$16`,
		hostID, r.Hour, r.CPUAvg, r.CPUMax, r.MemAvg, r.MemMax, r.Samples, r.LiveCPUCoresP95, r.LiveCPUCoresAvg,
		r.LiveCPUCoresMax, r.LiveMemMax, r.LiveGPUMax, r.GPUMax, r.NetMax, r.TempMax, r.PowerMax)
	if err != nil {
		return err
	}
	_, _ = s.db.Exec(`DELETE FROM host_metrics_hourly WHERE hour < now() - interval '31 days'`)
	return nil
}

// Load liefert die gespeicherten Stundenwerte je Host seit `since`.
func (s *HourStore) Load(ctx context.Context, since time.Time) (map[string][]HourRow, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT host_id, hour, cpu_avg, cpu_max, mem_avg, mem_max, samples, live_cpu_p95, live_cpu_avg,
		live_cpu_max, live_mem_max, live_gpu_max, gpu_max, net_max, temp_max, power_max FROM host_metrics_hourly WHERE hour >= $1 ORDER BY hour`, since)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[string][]HourRow{}
	for rows.Next() {
		var id string
		var r HourRow
		if err := rows.Scan(&id, &r.Hour, &r.CPUAvg, &r.CPUMax, &r.MemAvg, &r.MemMax, &r.Samples, &r.LiveCPUCoresP95, &r.LiveCPUCoresAvg,
			&r.LiveCPUCoresMax, &r.LiveMemMax, &r.LiveGPUMax, &r.GPUMax, &r.NetMax, &r.TempMax, &r.PowerMax); err != nil {
			return nil, err
		}
		out[id] = append(out[id], r)
	}
	return out, rows.Err()
}
