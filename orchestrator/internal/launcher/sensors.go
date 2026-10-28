package launcher

import (
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

// Temperatur und Leistungsaufnahme des Hosts aus /sys (Linux): hwmon/thermal für Temperaturen, RAPL (Energiezähler der CPU)
// und Akku für die Leistung. Was der Host nicht liefert, bleibt leer — „nicht gemessen“, nie 0. VMs und Container liefern
// oft nichts; RAPL ist auf neueren Kerneln nur für root lesbar (dann fehlt die Leistung ebenfalls ehrlich).
// Die Datei existiert bewusst gleichlautend in orchestrator/internal/launcher (zwei Go-Module, kleine Wire-Duplikation).

// Sensor ist ein einzelner Temperaturwert.
type Sensor struct {
	Name    string  `json:"name"`
	Label   string  `json:"label,omitempty"`
	Celsius float64 `json:"celsius"`
}

// SensorSample ist eine Momentaufnahme; nil = der Host liefert weder Temperatur noch Leistung.
type SensorSample struct {
	// TempC: höchster CPU-/Plattform-Wert (der für Überwachung maßgebliche), nil wenn keiner vorhanden.
	TempC *float64 `json:"tempC,omitempty"`
	Temps []Sensor `json:"temps,omitempty"`
	// PowerW: aktuelle Leistungsaufnahme, PowerSource: "rapl" (CPU-Paket, ohne Rest des Systems) oder "battery" (Gesamtsystem).
	PowerW      *float64 `json:"powerW,omitempty"`
	PowerSource string   `json:"powerSource,omitempty"`
}

// SensorReader hält den Zustand für die Leistungsberechnung (Energiezähler brauchen zwei Messpunkte).
type SensorReader struct {
	root string
	mu   sync.Mutex
	last map[string]uint64
	at   time.Time
}

// NewSensorReader: root leer = "/sys" (Tests übergeben ein nachgebautes Verzeichnis).
func NewSensorReader(root string) *SensorReader {
	if root == "" {
		root = "/sys"
	}
	return &SensorReader{root: root, last: map[string]uint64{}}
}

var cpuSensorNames = map[string]bool{"coretemp": true, "k10temp": true, "zenpower": true, "cpu_thermal": true, "x86_pkg_temp": true, "soc_thermal": true, "acpitz": true}

func readTrim(p string) string {
	b, err := os.ReadFile(p)
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(b))
}

func readInt(p string) (int64, bool) {
	v, err := strconv.ParseInt(readTrim(p), 10, 64)
	return v, err == nil
}

func plausible(c float64) bool { return c > 0 && c < 150 }

func (r *SensorReader) temps() (temps []Sensor, cpuMax *float64) {
	consider := func(name, label string, milli int64) {
		c := float64(milli) / 1000
		if !plausible(c) {
			return
		}
		temps = append(temps, Sensor{Name: name, Label: label, Celsius: c})
		if cpuSensorNames[name] && (cpuMax == nil || c > *cpuMax) {
			v := c
			cpuMax = &v
		}
	}
	hw, _ := filepath.Glob(filepath.Join(r.root, "class/hwmon/hwmon*"))
	for _, dir := range hw {
		name := readTrim(filepath.Join(dir, "name"))
		inputs, _ := filepath.Glob(filepath.Join(dir, "temp*_input"))
		for _, in := range inputs {
			if m, ok := readInt(in); ok {
				consider(name, readTrim(strings.TrimSuffix(in, "_input")+"_label"), m)
			}
		}
	}
	zones, _ := filepath.Glob(filepath.Join(r.root, "class/thermal/thermal_zone*"))
	for _, z := range zones {
		typ := readTrim(filepath.Join(z, "type"))
		if typ == "" || typ == "battery" {
			continue
		}
		if m, ok := readInt(filepath.Join(z, "temp")); ok {
			consider(strings.ReplaceAll(typ, "-", "_"), "", m)
		}
	}
	sort.SliceStable(temps, func(i, j int) bool { return temps[i].Celsius > temps[j].Celsius })
	return temps, cpuMax
}

func (r *SensorReader) power(now time.Time) (*float64, string) {
	// RAPL: Energiezähler der Paket-Domänen (intel-rapl:N, ohne Unterdomänen mit zwei Doppelpunkten).
	doms, _ := filepath.Glob(filepath.Join(r.root, "class/powercap/intel-rapl:*"))
	var watts float64
	have := false
	dt := now.Sub(r.at).Seconds()
	for _, d := range doms {
		if strings.Count(filepath.Base(d), ":") != 1 {
			continue
		}
		e, ok := readInt(filepath.Join(d, "energy_uj"))
		if !ok {
			continue
		}
		cur := uint64(e)
		if prev, seen := r.last[d]; seen && dt > 0 {
			delta := cur - prev
			if cur < prev { // Zähler übergelaufen
				if mx, ok := readInt(filepath.Join(d, "max_energy_range_uj")); ok && mx > 0 {
					delta = uint64(mx) - prev + cur
				} else {
					r.last[d] = cur
					continue
				}
			}
			watts += float64(delta) / 1e6 / dt
			have = true
		}
		r.last[d] = cur
	}
	if have {
		return &watts, "rapl"
	}
	// Akku: Gesamtleistung des Geräts, nur bei Entladung aussagekräftig.
	bats, _ := filepath.Glob(filepath.Join(r.root, "class/power_supply/*"))
	for _, b := range bats {
		if readTrim(filepath.Join(b, "type")) != "Battery" {
			continue
		}
		if pw, ok := readInt(filepath.Join(b, "power_now")); ok && pw > 0 {
			w := float64(pw) / 1e6
			return &w, "battery"
		}
		cur, ok1 := readInt(filepath.Join(b, "current_now"))
		vol, ok2 := readInt(filepath.Join(b, "voltage_now"))
		if ok1 && ok2 && cur > 0 && vol > 0 {
			w := float64(cur) * float64(vol) / 1e12
			return &w, "battery"
		}
	}
	return nil, ""
}

// Read liefert die aktuelle Momentaufnahme oder nil, wenn nichts verfügbar ist. Billig: wenige kleine Dateilesungen.
func (r *SensorReader) Read() *SensorSample {
	r.mu.Lock()
	defer r.mu.Unlock()
	now := time.Now()
	temps, cpuMax := r.temps()
	w, src := r.power(now)
	r.at = now
	if len(temps) == 0 && w == nil {
		return nil
	}
	out := &SensorSample{Temps: temps, PowerW: w, PowerSource: src}
	if cpuMax != nil {
		out.TempC = cpuMax
	} else if len(temps) > 0 {
		v := temps[0].Celsius
		out.TempC = &v
	}
	return out
}
