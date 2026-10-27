package support

import (
	"os"
	"strconv"
	"strings"

	"github.com/infantilo/openmediaplatform/jobwire"
)

// DiskTarget ist ein zu prüfender Pfad.
type DiskTarget = jobwire.DiskTarget

// ProbeLocal misst den Rechner des Orchestrators (gleicher Code wie im Host-Agent: jobwire.ProbeSystem).
func ProbeLocal(disks []DiskTarget) Local {
	l := LocalFromSysinfo(jobwire.ProbeSystem(disks))
	l.DatabaseError = "-"
	return l
}

// LocalFromSysinfo übersetzt die Messwerte eines Rechners (auch eines Hosts) in die Bewertungssicht.
func LocalFromSysinfo(s jobwire.Sysinfo) Local {
	l := Local{MemAvailable: s.MemAvailable, MemTotal: s.MemTotal, ShmFree: s.ShmFree, ShmTotal: s.ShmTotal, ShmErr: s.ShmErr,
		Load1: s.Load1, CPUs: s.CPUs, OpenFDs: s.OpenFDs, FDLimit: s.FDLimit, DatabaseError: "-"}
	for _, d := range s.Disks {
		l.Disks = append(l.Disks, Disk{Path: d.Path, Label: d.Label, FreeBytes: d.FreeBytes, TotalBytes: d.TotalBytes, Err: d.Err})
	}
	return l
}

// ReadProcess liest den Zustand eines Prozesses auf diesem Rechner aus /proc (Threads, offene Dateien, Speicher).
func ReadProcess(pid int) (ProcessFacts, error) {
	var p ProcessFacts
	base := "/proc/" + strconv.Itoa(pid)
	status, err := os.ReadFile(base + "/status")
	if err != nil {
		return p, err
	}
	for _, line := range strings.Split(string(status), "\n") {
		k, v, ok := strings.Cut(line, ":")
		if !ok {
			continue
		}
		f := strings.Fields(v)
		if len(f) == 0 {
			continue
		}
		n, _ := strconv.ParseUint(f[0], 10, 64)
		switch k {
		case "Threads":
			p.Threads = int(n)
		case "VmRSS":
			p.RSSBytes = n * 1024
		}
	}
	if ents, err := os.ReadDir(base + "/fd"); err == nil {
		p.OpenFDs = len(ents)
	}
	if data, err := os.ReadFile(base + "/limits"); err == nil {
		p.FDLimit = jobwire.ParseFDLimit(string(data))
	}
	if data, err := os.ReadFile("/proc/meminfo"); err == nil {
		p.HostMemory, _ = jobwire.ParseMeminfo(string(data))
	}
	return p, nil
}
