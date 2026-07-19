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
	"sync"
	"time"
)

// Sample ist eine Momentaufnahme der Host-Auslastung.
type Sample struct {
	CPUPercent    float64 `json:"cpuPercent"`
	MemUsedBytes  uint64  `json:"memUsedBytes"`
	MemTotalBytes uint64  `json:"memTotalBytes"`
	// Instances ist die additive Pro-Instanz-Ergänzung (Kapitel 14 Teil
	// 2, docs/END-GOAL-FEATURES.md §14.3b) — rein additiv befüllt von
	// main.go, unbekannt bleibt hosts.Tracker.Touch (Orchestrator-Seite)
	// bei einer älteren Agent-Version egal (json.Unmarshal ignoriert
	// fehlende Felder).
	Instances []InstanceSample `json:"instances,omitempty"`
}

// InstanceSample ist die Pro-Instanz-Telemetrie einer vom Host-Agent
// verwalteten Instanz (Kapitel 14 Teil 2) — Spiegelbild von
// orchestrator/internal/hosts.InstanceMetrics (eigenständige Go-Module,
// gleiche bewusste kleine Duplikation wie beim übrigen Wire-Format
// dieses Projekts, s. host-agent/internal/commands-Paketkommentar).
type InstanceSample struct {
	InstanceID string  `json:"instanceId"`
	CPUPercent float64 `json:"cpuPercent"`
	RSSBytes   uint64  `json:"rssBytes"`
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

// clockTicksPerSecond ist USER_HZ, der Skalierungsfaktor von
// utime/stime in /proc/<pid>/stat (Kernel-ABI, "man proc"). Kein
// Rate-Raten (UMSETZUNG.md §0 Punkt 9 gilt sinngemäß auch außerhalb von
// GStreamer): per `getconf CLK_TCK` auf der Entwicklungsmaschine
// verifiziert (=100, der praktisch universelle Linux-Default seit
// Jahrzehnten — ein System mit abweichendem Wert bräuchte eine eigene
// Kernel-Konfiguration, die dieses Projekt laut UMSETZUNG.md §0 Punkt 7
// ohnehin nicht als Zielplattform hat).
const clockTicksPerSecond = 100

// processTimes liest utime+stime (Klock-Ticks) aus /proc/<pid>/stat.
// comm (Feld 2) kann Leerzeichen/Klammern enthalten — deshalb hinter
// der letzten ")" weiterparsen statt naiv nach Leerzeichen zu splitten
// (gleiche Technik wie bei jedem robusten /proc/stat-Parser). Nach der
// schließenden Klammer beginnt state (Feld 3) als Index 0; utime (Feld
// 14 gesamt) liegt damit bei Index 11, stime (Feld 15) bei Index 12.
func processTimes(pid int) (ticks uint64, err error) {
	data, err := os.ReadFile(fmt.Sprintf("/proc/%d/stat", pid))
	if err != nil {
		return 0, err
	}
	text := string(data)
	closeParen := strings.LastIndexByte(text, ')')
	if closeParen < 0 {
		return 0, fmt.Errorf("telemetry: unexpected /proc/%d/stat format", pid)
	}
	fields := strings.Fields(text[closeParen+1:])
	if len(fields) < 13 {
		return 0, fmt.Errorf("telemetry: too few fields in /proc/%d/stat", pid)
	}
	utime, err := strconv.ParseUint(fields[11], 10, 64)
	if err != nil {
		return 0, fmt.Errorf("telemetry: parse utime for pid %d: %w", pid, err)
	}
	stime, err := strconv.ParseUint(fields[12], 10, 64)
	if err != nil {
		return 0, fmt.Errorf("telemetry: parse stime for pid %d: %w", pid, err)
	}
	return utime + stime, nil
}

// processRSSBytes liest VmRSS aus /proc/<pid>/status (gleiche Quelle
// wie ein `ps`/`top` RSS-Wert).
func processRSSBytes(pid int) (uint64, error) {
	f, err := os.Open(fmt.Sprintf("/proc/%d/status", pid))
	if err != nil {
		return 0, err
	}
	defer f.Close()

	scanner := bufio.NewScanner(f)
	for scanner.Scan() {
		line := scanner.Text()
		if !strings.HasPrefix(line, "VmRSS:") {
			continue
		}
		fields := strings.Fields(line)
		if len(fields) < 2 {
			return 0, fmt.Errorf("telemetry: unexpected VmRSS line %q for pid %d", line, pid)
		}
		kb, err := strconv.ParseUint(fields[1], 10, 64)
		if err != nil {
			return 0, fmt.Errorf("telemetry: parse VmRSS for pid %d: %w", pid, err)
		}
		return kb * 1024, nil
	}
	// Keine VmRSS-Zeile (z. B. Prozess bereits beendet, kein Anonymous-
	// Memory mehr zugeordnet) — 0 statt Fehler, gleiche Nachsicht wie ein
	// fehlendes Feld anderswo in diesem Paket.
	return 0, nil
}

type processState struct {
	ticks uint64
	at    time.Time
}

// ProcessSampler misst CPU%/RSS pro verwalteter PID über zwei
// aufeinanderfolgende Aufrufe von Sample() (Kapitel 14 Teil 2,
// docs/END-GOAL-FEATURES.md §14.3b) — anders als die blockierende
// cpuPercent()-Messung für den Host-Gesamtwert nutzt dies den ohnehin
// vorhandenen Telemetrie-Tick-Abstand als Delta-Fenster, kein eigenes
// time.Sleep (bei potenziell vielen verwalteten Instanzen wäre ein
// blockierendes Sample pro PID unnötig teuer). Die erste Messung einer
// PID liefert deshalb noch kein CPU%-Delta (ok=false) — der Aufrufer
// verwirft diesen ersten Sample statt eine falsche 0%-Momentaufnahme zu
// veröffentlichen.
type ProcessSampler struct {
	mu   sync.Mutex
	prev map[int]processState
}

// NewProcessSampler erstellt einen leeren ProcessSampler.
func NewProcessSampler() *ProcessSampler {
	return &ProcessSampler{prev: map[int]processState{}}
}

// Sample misst den aktuellen Zustand von pid. ok=false bedeutet: kein
// verwertbarer Wert (erster Sample dieser PID, Prozess nicht mehr
// vorhanden, oder eine Uhrzeit-/Ticks-Anomalie) — der Aufrufer soll in
// dem Fall nichts veröffentlichen, nicht 0 als echten Wert interpretieren.
func (s *ProcessSampler) Sample(pid int) (cpuPercent float64, rssBytes uint64, ok bool) {
	ticks, err := processTimes(pid)
	if err != nil {
		return 0, 0, false
	}
	rss, err := processRSSBytes(pid)
	if err != nil {
		return 0, 0, false
	}
	now := time.Now()

	s.mu.Lock()
	prev, hadPrev := s.prev[pid]
	s.prev[pid] = processState{ticks: ticks, at: now}
	s.mu.Unlock()

	if !hadPrev {
		return 0, rss, false
	}

	elapsed := now.Sub(prev.at).Seconds()
	if elapsed <= 0 || ticks < prev.ticks {
		return 0, rss, false
	}
	deltaSeconds := float64(ticks-prev.ticks) / clockTicksPerSecond
	return (deltaSeconds / elapsed) * 100, rss, true
}

// Prune entfernt den gemerkten Zustand jeder PID, die nicht in keep
// steht — verhindert unbegrenztes Wachstum von ProcessSampler.prev über
// die Laufzeit des Agents hinweg, wenn Instanzen kommen und gehen
// (jeder Neustart einer Instanz bekommt ohnehin eine neue PID, ein
// altes Delta wäre falsch).
func (s *ProcessSampler) Prune(keep map[int]bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for pid := range s.prev {
		if !keep[pid] {
			delete(s.prev, pid)
		}
	}
}
