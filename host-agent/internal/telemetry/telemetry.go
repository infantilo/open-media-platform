// Package telemetry misst Host-Auslastung über /proc (Linux) —
// ARCHITECTURE.md §18.4: "Wie gemessen wird, ist zum
// Umsetzungszeitpunkt zu verifizieren, nicht zu raten". CPU/RAM seit
// D6 Teil 1, Netzwerk-Durchsatz/-Kapazität seit 2026-09-02 (Nutzerauftrag
// "netzwerkbandbreite ... auch relevant"; s. NetSample-Doku) — GPU bleibt
// herstellerspezifisch und weiterhin als Folgearbeit dokumentiert
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
	// Net ist nil, wenn OMP_HOST_AGENT_NET_IFACE nicht gesetzt ist (s.
	// main.go) — kein konfiguriertes Interface bedeutet "nicht
	// gemessen", nicht "0 Bandbreite" (gleiche Ehrlichkeitslinie wie
	// ProfileResponse.known=false in orchestrator/internal/profiles).
	Net *NetSample `json:"net,omitempty"`
}

// NetSample ist die zuletzt gemessene Durchsatz-/Kapazitäts-
// Momentaufnahme GENAU EINES, per OMP_HOST_AGENT_NET_IFACE explizit
// benannten Netzwerk-Interfaces (ARCHITECTURE.md §6.1: NIC-Auslastung ist
// wie CPU/RAM eine kontinuierliche, teilbare Ressource, keine
// diskret-exklusive wie ein I/O-Karten-Port — s. Erweiterung 2026-07-10
// dort). Bewusst explizit konfiguriert statt automatisch erkannt (das
// Default-Route-Interface ist auf einem Host mit dedizierter 2110-NIC
// typischerweise NICHT die Management-Schnittstelle, über die der
// Host-Agent selbst mit dem Orchestrator spricht) — exakt dasselbe
// Prinzip wie beim I/O-Karten-Inventar (§6.1 Erweiterung 2026-07-10:
// "host-agent-konfiguriert statt automatisch erkannt").
type NetSample struct {
	Iface         string  `json:"iface"`
	RxBytesPerSec float64 `json:"rxBytesPerSec"`
	TxBytesPerSec float64 `json:"txBytesPerSec"`
	// LinkMbps ist die vom Treiber gemeldete Verbindungsgeschwindigkeit
	// (/sys/class/net/<iface>/speed, Mbit/s) — 0 (Feld dadurch
	// weggelassen, omitempty), wenn der Treiber sie nicht meldet (z. B.
	// virtuelle/Bridge-Interfaces); dann bleibt nur der Rohdurchsatz oben
	// aussagekräftig, kein Auslastungs-%.
	LinkMbps float64 `json:"linkMbps,omitempty"`
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

// netBytes ist rx/tx aus /proc/net/dev für ein einzelnes Interface.
type netBytes struct {
	rx uint64
	tx uint64
}

// readNetDevBytes liest rx_bytes/tx_bytes für iface aus /proc/net/dev.
// Format je Zeile (Documentation/filesystems/proc.rst): "<iface>: <rx
// bytes> <rx packets> ... (6 weitere rx-Felder) <tx bytes> ..." — nach
// dem Doppelpunkt ist Feld 0 rx_bytes, Feld 8 tx_bytes.
func readNetDevBytes(iface string) (netBytes, error) {
	f, err := os.Open("/proc/net/dev")
	if err != nil {
		return netBytes{}, fmt.Errorf("telemetry: open /proc/net/dev: %w", err)
	}
	defer f.Close()

	scanner := bufio.NewScanner(f)
	for scanner.Scan() {
		line := scanner.Text()
		colon := strings.IndexByte(line, ':')
		if colon < 0 {
			continue // Kopfzeilen (die ersten zwei) haben keinen Doppelpunkt.
		}
		name := strings.TrimSpace(line[:colon])
		if name != iface {
			continue
		}
		fields := strings.Fields(line[colon+1:])
		if len(fields) < 9 {
			return netBytes{}, fmt.Errorf("telemetry: unexpected /proc/net/dev format for %q: %q", iface, line)
		}
		rx, err := strconv.ParseUint(fields[0], 10, 64)
		if err != nil {
			return netBytes{}, fmt.Errorf("telemetry: parse rx_bytes for %q: %w", iface, err)
		}
		tx, err := strconv.ParseUint(fields[8], 10, 64)
		if err != nil {
			return netBytes{}, fmt.Errorf("telemetry: parse tx_bytes for %q: %w", iface, err)
		}
		return netBytes{rx: rx, tx: tx}, nil
	}
	return netBytes{}, fmt.Errorf("telemetry: interface %q not found in /proc/net/dev", iface)
}

// readNetLinkMbps liest die vom Treiber gemeldete Verbindungs-
// geschwindigkeit aus /sys/class/net/<iface>/speed. 0 heißt "unbekannt"
// (virtuelles Interface, Link down, oder Treiber unterstützt es nicht) —
// bewusst kein Fehler, s. NetSample.LinkMbps-Doku.
func readNetLinkMbps(iface string) float64 {
	data, err := os.ReadFile(fmt.Sprintf("/sys/class/net/%s/speed", iface))
	if err != nil {
		return 0
	}
	v, err := strconv.ParseInt(strings.TrimSpace(string(data)), 10, 64)
	if err != nil || v <= 0 {
		return 0
	}
	return float64(v)
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
// CPU-Auslastung UND (falls netIface gesetzt ist) den Netzwerk-Durchsatz
// über dasselbe Zeitfenster zu messen (ein zweiter, eigener Sleep für Net
// wäre unnötig verdoppelte Wartezeit). netIface == "" überspringt die
// Netz-Messung komplett (Sample.Net bleibt nil) — s. NetSample-Doku,
// warum das Interface explizit benannt statt erraten wird.
func Take(interval time.Duration, netIface string) (Sample, error) {
	firstCPU, err := readCPUTimes()
	if err != nil {
		return Sample{}, err
	}

	var firstNet netBytes
	haveNet := netIface != ""
	if haveNet {
		firstNet, err = readNetDevBytes(netIface)
		if err != nil {
			// Interface (noch) nicht vorhanden/falsch benannt — kein
			// Fehlschlag der gesamten Momentaufnahme, gleiche Nachsicht
			// wie ein bereits beendeter Prozess in ProcessSampler.Sample.
			// main.go loggt den ersten Fehlschlag beim Start bereits.
			haveNet = false
		}
	}

	time.Sleep(interval)

	secondCPU, err := readCPUTimes()
	if err != nil {
		return Sample{}, err
	}
	var cpu float64
	if totalDelta := secondCPU.total - firstCPU.total; totalDelta > 0 {
		idleDelta := secondCPU.idle - firstCPU.idle
		cpu = (1 - float64(idleDelta)/float64(totalDelta)) * 100
	}

	used, total, err := memoryUsage()
	if err != nil {
		return Sample{}, err
	}
	sample := Sample{CPUPercent: cpu, MemUsedBytes: used, MemTotalBytes: total}

	if haveNet {
		if secondNet, err := readNetDevBytes(netIface); err == nil {
			elapsed := interval.Seconds()
			sample.Net = &NetSample{
				Iface:         netIface,
				RxBytesPerSec: float64(secondNet.rx-firstNet.rx) / elapsed,
				TxBytesPerSec: float64(secondNet.tx-firstNet.tx) / elapsed,
				LinkMbps:      readNetLinkMbps(netIface),
			}
		}
	}

	return sample, nil
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
