package support

import "github.com/infantilo/openmediaplatform/jobwire"

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
