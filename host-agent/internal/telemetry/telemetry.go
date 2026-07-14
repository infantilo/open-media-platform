// Package telemetry misst Host-Auslastung über /proc (Linux) —
// ARCHITECTURE.md §18.4: "Wie gemessen wird, ist zum
// Umsetzungszeitpunkt zu verifizieren, nicht zu raten". Bewusst nur
// CPU/RAM in dieser Runde (UMSETZUNG.md D6 Teil 1) — GPU/NIC sind
// herstellerspezifisch und explizit als Folgearbeit dokumentiert
// (docs/decisions.md).
package telemetry

import (
	"bufio"
	"fmt"
	"os"
	"strconv"
	"strings"
	"time"
)

// Sample ist eine Momentaufnahme der Host-Auslastung.
type Sample struct {
	CPUPercent    float64 `json:"cpuPercent"`
	MemUsedBytes  uint64  `json:"memUsedBytes"`
	MemTotalBytes uint64  `json:"memTotalBytes"`
}

// cpuTimes ist die für die Auslastungsberechnung nötige Teilmenge der
// Felder aus /proc/stats erster Zeile ("cpu  user nice system idle
// iowait irq softirq steal guest guest_nice").
type cpuTimes struct {
	idle  uint64
	total uint64
}

func readCPUTimes() (cpuTimes, error) {
	f, err := os.Open("/proc/stat")
	if err != nil {
		return cpuTimes{}, fmt.Errorf("telemetry: open /proc/stat: %w", err)
	}
	defer f.Close()

	scanner := bufio.NewScanner(f)
	if !scanner.Scan() {
		return cpuTimes{}, fmt.Errorf("telemetry: /proc/stat empty")
	}
	fields := strings.Fields(scanner.Text())
	if len(fields) < 5 || fields[0] != "cpu" {
		return cpuTimes{}, fmt.Errorf("telemetry: unexpected /proc/stat format: %q", scanner.Text())
	}

	var values []uint64
	for _, f := range fields[1:] {
		v, err := strconv.ParseUint(f, 10, 64)
		if err != nil {
			return cpuTimes{}, fmt.Errorf("telemetry: parse /proc/stat field %q: %w", f, err)
		}
		values = append(values, v)
	}

	var total uint64
	for _, v := range values {
		total += v
	}
	// idle (Index 3) + iowait (Index 4) zählen beide als "nicht
	// arbeitend" — Standardpraxis für CPU%-Berechnung aus /proc/stat.
	idle := values[3]
	if len(values) > 4 {
		idle += values[4]
	}
	return cpuTimes{idle: idle, total: total}, nil
}

// cpuPercent misst die CPU-Auslastung über ein kurzes Sample-Intervall
// (blockierend) — Standardtechnik: /proc/stat zweimal lesen, Differenz
// bilden. interval sollte kurz genug sein, um den periodischen
// Telemetrie-Tick (Sekunden) nicht spürbar zu verzögern.
func cpuPercent(interval time.Duration) (float64, error) {
	first, err := readCPUTimes()
	if err != nil {
		return 0, err
	}
	time.Sleep(interval)
	second, err := readCPUTimes()
	if err != nil {
		return 0, err
	}

	totalDelta := second.total - first.total
	if totalDelta == 0 {
		return 0, nil
	}
	idleDelta := second.idle - first.idle
	return (1 - float64(idleDelta)/float64(totalDelta)) * 100, nil
}

// memoryUsage liest /proc/meminfo. "used" ist MemTotal-MemAvailable
// (Standardpraxis — genauer als MemTotal-MemFree, weil MemAvailable
// Caches/Buffers berücksichtigt, die tatsächlich verfügbar sind).
func memoryUsage() (usedBytes, totalBytes uint64, err error) {
	f, err := os.Open("/proc/meminfo")
	if err != nil {
		return 0, 0, fmt.Errorf("telemetry: open /proc/meminfo: %w", err)
	}
	defer f.Close()

	var totalKB, availableKB uint64
	scanner := bufio.NewScanner(f)
	for scanner.Scan() {
		line := scanner.Text()
		switch {
		case strings.HasPrefix(line, "MemTotal:"):
			totalKB = parseMeminfoLine(line)
		case strings.HasPrefix(line, "MemAvailable:"):
			availableKB = parseMeminfoLine(line)
		}
	}
	if totalKB == 0 {
		return 0, 0, fmt.Errorf("telemetry: MemTotal not found in /proc/meminfo")
	}
	usedKB := totalKB - availableKB
	return usedKB * 1024, totalKB * 1024, nil
}

func parseMeminfoLine(line string) uint64 {
	fields := strings.Fields(line)
	if len(fields) < 2 {
		return 0
	}
	v, _ := strconv.ParseUint(fields[1], 10, 64)
	return v
}

// Take nimmt eine Momentaufnahme — blockiert für interval, um die
// CPU-Auslastung zu messen (s. cpuPercent).
func Take(interval time.Duration) (Sample, error) {
	cpu, err := cpuPercent(interval)
	if err != nil {
		return Sample{}, err
	}
	used, total, err := memoryUsage()
	if err != nil {
		return Sample{}, err
	}
	return Sample{CPUPercent: cpu, MemUsedBytes: used, MemTotalBytes: total}, nil
}
