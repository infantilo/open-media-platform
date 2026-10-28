package telemetry

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

func put(t *testing.T, root, rel, content string) {
	t.Helper()
	p := filepath.Join(root, rel)
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(p, []byte(content+"\n"), 0o644); err != nil {
		t.Fatal(err)
	}
}

func TestSensorsNothingAvailableIsNilNotZero(t *testing.T) {
	root := t.TempDir()
	put(t, root, "class/thermal/thermal_zone0/type", "battery")
	put(t, root, "class/thermal/thermal_zone0/temp", "0")
	if got := NewSensorReader(root).Read(); got != nil {
		t.Fatalf("ohne Sensoren nil, nicht 0: %+v", got)
	}
}

func TestSensorsTemperaturesPickCPUMaxAndIgnoreImplausible(t *testing.T) {
	root := t.TempDir()
	put(t, root, "class/hwmon/hwmon0/name", "coretemp")
	put(t, root, "class/hwmon/hwmon0/temp1_input", "61000")
	put(t, root, "class/hwmon/hwmon0/temp1_label", "Package id 0")
	put(t, root, "class/hwmon/hwmon0/temp2_input", "72500")
	put(t, root, "class/hwmon/hwmon1/name", "nvme")
	put(t, root, "class/hwmon/hwmon1/temp1_input", "90000") // Datenträger zählt nicht als CPU
	put(t, root, "class/hwmon/hwmon2/name", "k10temp")
	put(t, root, "class/hwmon/hwmon2/temp1_input", "-1") // unplausibel
	put(t, root, "class/thermal/thermal_zone0/type", "x86_pkg_temp")
	put(t, root, "class/thermal/thermal_zone0/temp", "68000")
	got := NewSensorReader(root).Read()
	if got == nil || got.TempC == nil || *got.TempC != 72.5 {
		t.Fatalf("höchster CPU-Wert 72,5: %+v", got)
	}
	if len(got.Temps) != 4 || got.Temps[0].Celsius != 90 {
		t.Fatalf("alle plausiblen Werte, absteigend: %+v", got.Temps)
	}
	if got.PowerW != nil {
		t.Fatal("keine Leistung ohne Quelle")
	}
}

func TestSensorsRaplPowerNeedsTwoSamplesAndHandlesWrap(t *testing.T) {
	root := t.TempDir()
	put(t, root, "class/hwmon/hwmon0/name", "coretemp")
	put(t, root, "class/hwmon/hwmon0/temp1_input", "50000")
	put(t, root, "class/powercap/intel-rapl:0/energy_uj", "10000000")
	put(t, root, "class/powercap/intel-rapl:0/max_energy_range_uj", "262143328850")
	put(t, root, "class/powercap/intel-rapl:0:0/energy_uj", "999999999") // Unterdomäne wird nicht doppelt gezählt
	r := NewSensorReader(root)
	if s := r.Read(); s == nil || s.PowerW != nil {
		t.Fatalf("erste Messung: keine Leistung, Temperatur ja: %+v", s)
	}
	time.Sleep(50 * time.Millisecond)
	put(t, root, "class/powercap/intel-rapl:0/energy_uj", "12000000") // +2 J in ~0,05 s
	s := r.Read()
	if s == nil || s.PowerW == nil || s.PowerSource != "rapl" || *s.PowerW < 5 || *s.PowerW > 100 {
		t.Fatalf("Leistung aus Energiedifferenz: %+v", s)
	}
}

func TestSensorsBatteryPowerWhenDischarging(t *testing.T) {
	root := t.TempDir()
	put(t, root, "class/power_supply/BAT0/type", "Battery")
	put(t, root, "class/power_supply/BAT0/current_now", "1500000")
	put(t, root, "class/power_supply/BAT0/voltage_now", "12000000")
	s := NewSensorReader(root).Read()
	if s == nil || s.PowerW == nil || s.PowerSource != "battery" || *s.PowerW < 17.9 || *s.PowerW > 18.1 {
		t.Fatalf("18 W aus 1,5 A x 12 V: %+v", s)
	}
}
