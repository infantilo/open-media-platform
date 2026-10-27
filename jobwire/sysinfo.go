package jobwire

import (
	"bufio"
	"bytes"
	"context"
	"os"
	"os/exec"
	"runtime"
	"strconv"
	"strings"
	"syscall"
	"time"
)

// ActionSysinfo: der Host-Agent liefert den Zustand seines Rechners (Platten, Speicher, Last, Prozesse, Kernel-Meldungen)
// als JSON in Response.Detail — für Selbsttest und Support-Paket des Orchestrators (UMSETZUNG.md Kap. 72). Nur Lesen.
const ActionSysinfo = "sysinfo"

// DiskUse ist die Belegung eines Pfads.
type DiskUse struct {
	Path       string `json:"path"`
	Label      string `json:"label"`
	FreeBytes  uint64 `json:"freeBytes"`
	TotalBytes uint64 `json:"totalBytes"`
	Err        string `json:"err,omitempty"`
}

// Sysinfo ist der Zustand eines Rechners.
type Sysinfo struct {
	Hostname     string            `json:"hostname"`
	At           time.Time         `json:"at"`
	CPUs         int               `json:"cpus"`
	Load1        float64           `json:"load1"`
	MemTotal     uint64            `json:"memTotal"`
	MemAvailable uint64            `json:"memAvailable"`
	ShmTotal     uint64            `json:"shmTotal"`
	ShmFree      uint64            `json:"shmFree"`
	ShmErr       string            `json:"shmErr,omitempty"`
	OpenFDs      int               `json:"openFds"`
	FDLimit      int               `json:"fdLimit"`
	Disks        []DiskUse         `json:"disks"`
	Files        map[string]string `json:"files,omitempty"` // Textberichte: Name → Inhalt (Prozesse, Kernel-Meldungen, …)
}

// DiskTarget ist ein zu messender Pfad.
type DiskTarget struct{ Path, Label string }

// ProbeSystem misst Platten, Speicher, /dev/shm, Last und die Handles des eigenen Prozesses. Nur Lesen (/proc, statfs).
func ProbeSystem(disks []DiskTarget) Sysinfo {
	s := Sysinfo{At: time.Now().UTC(), CPUs: runtime.NumCPU()}
	s.Hostname, _ = os.Hostname()
	seen := map[[2]uint64]bool{}
	for _, d := range disks {
		var st syscall.Statfs_t
		if err := syscall.Statfs(d.Path, &st); err != nil {
			s.Disks = append(s.Disks, DiskUse{Path: d.Path, Label: d.Label, Err: err.Error()})
			continue
		}
		bs := uint64(st.Bsize)
		total, free := st.Blocks*bs, st.Bavail*bs
		if key := [2]uint64{total, free}; seen[key] { // derselbe Datenträger unter zwei Pfaden nur einmal
			continue
		} else {
			seen[key] = true
		}
		s.Disks = append(s.Disks, DiskUse{Path: d.Path, Label: d.Label, FreeBytes: free, TotalBytes: total})
	}
	if data, err := os.ReadFile("/proc/meminfo"); err == nil {
		s.MemTotal, s.MemAvailable = ParseMeminfo(string(data))
	}
	var st syscall.Statfs_t
	if err := syscall.Statfs("/dev/shm", &st); err != nil {
		s.ShmErr = err.Error()
	} else {
		s.ShmTotal, s.ShmFree = st.Blocks*uint64(st.Bsize), st.Bavail*uint64(st.Bsize)
	}
	if data, err := os.ReadFile("/proc/loadavg"); err == nil {
		s.Load1 = ParseLoad1(string(data))
	}
	if ents, err := os.ReadDir("/proc/self/fd"); err == nil {
		s.OpenFDs = len(ents)
	}
	if data, err := os.ReadFile("/proc/self/limits"); err == nil {
		s.FDLimit = ParseFDLimit(string(data))
	}
	return s
}

// ReportCommands sind die festen, nur lesenden Kommandos des Textberichts (Name → Aufruf).
var reportCommands = []struct {
	Name string
	Args []string
	Tail int // >0: nur die letzten Zeilen
}{
	{"processes.txt", []string{"ps", "-eo", "pid,ppid,etime,rss,pcpu,pmem,comm,args", "--sort=-rss"}, 300},
	{"kernel-messages.txt", []string{"dmesg", "--ctime"}, 300},
	{"disks.txt", []string{"df", "-h"}, 0},
	{"memory.txt", []string{"free", "-m"}, 0},
	{"network.txt", []string{"ip", "-brief", "address"}, 0},
	{"time.txt", []string{"timedatectl", "status"}, 0},
}

var reportFiles = []struct{ Name, Path string }{
	{"os-release.txt", "/etc/os-release"}, {"kernel.txt", "/proc/version"},
	{"meminfo.txt", "/proc/meminfo"}, {"loadavg.txt", "/proc/loadavg"},
}

// CollectReport sammelt den Textbericht (Kommandoausgaben mit Zeitlimit, Systemdateien). Was nicht lesbar ist, steht in
// failed (Name → Grund), nicht im Bericht.
func CollectReport(ctx context.Context) (files map[string]string, failed map[string]string) {
	files, failed = map[string]string{}, map[string]string{}
	for _, c := range reportCommands {
		out, err := runLimited(ctx, c.Args)
		if err != nil && len(out) == 0 {
			failed[c.Name] = err.Error()
			continue
		}
		if c.Tail > 0 {
			out = lastLines(out, c.Tail)
		}
		files[c.Name] = string(out)
	}
	for _, f := range reportFiles {
		if b, err := os.ReadFile(f.Path); err == nil {
			files[f.Name] = string(b)
		} else {
			failed[f.Name] = err.Error()
		}
	}
	return files, failed
}

func runLimited(ctx context.Context, args []string) ([]byte, error) {
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, args[0], args[1:]...)
	var buf bytes.Buffer
	cmd.Stdout, cmd.Stderr = &buf, &buf
	err := cmd.Run()
	if buf.Len() > 1<<20 {
		buf.Truncate(1 << 20)
	}
	return buf.Bytes(), err
}

func lastLines(b []byte, n int) []byte {
	lines := strings.Split(strings.TrimRight(string(b), "\n"), "\n")
	if len(lines) > n {
		lines = lines[len(lines)-n:]
	}
	return []byte(strings.Join(lines, "\n") + "\n")
}

// ParseMeminfo liest MemTotal und MemAvailable (in Bytes) aus /proc/meminfo.
func ParseMeminfo(s string) (total, avail uint64) {
	sc := bufio.NewScanner(strings.NewReader(s))
	for sc.Scan() {
		f := strings.Fields(sc.Text())
		if len(f) < 2 {
			continue
		}
		v, err := strconv.ParseUint(f[1], 10, 64)
		if err != nil {
			continue
		}
		switch f[0] {
		case "MemTotal:":
			total = v * 1024
		case "MemAvailable:":
			avail = v * 1024
		}
	}
	return total, avail
}

// ParseLoad1 liest den 1-Minuten-Wert aus /proc/loadavg.
func ParseLoad1(s string) float64 {
	f := strings.Fields(s)
	if len(f) == 0 {
		return 0
	}
	v, _ := strconv.ParseFloat(f[0], 64)
	return v
}

// ParseFDLimit liest das weiche Limit „Max open files“ aus /proc/self/limits (0 = unbegrenzt/unbekannt).
func ParseFDLimit(s string) int {
	for _, line := range strings.Split(s, "\n") {
		if !strings.HasPrefix(line, "Max open files") {
			continue
		}
		f := strings.Fields(strings.TrimPrefix(line, "Max open files"))
		if len(f) == 0 {
			return 0
		}
		v, err := strconv.Atoi(f[0])
		if err != nil {
			return 0
		}
		return v
	}
	return 0
}

// CollectSysinfo ist die vollständige Antwort der Aktion sysinfo: Messwerte plus Textbericht.
func CollectSysinfo(ctx context.Context, disks []DiskTarget) Sysinfo {
	s := ProbeSystem(disks)
	files, failed := CollectReport(ctx)
	for name, why := range failed {
		files[name+".fehlt"] = why
	}
	s.Files = files
	return s
}
