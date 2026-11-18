// Package mxlflows liest den Zustand einer MXL-Domain (Verzeichnis unter /dev/shm) direkt von der Platte:
// welche Flows es gibt, ob ein Prozess sie schreibt und welcher. Nur lesend, keine Abhängigkeit zum MXL-SDK.
//
// Layout (third_party/mxl, lib/internal/include/mxl-internal/FlowManager.hpp, PathUtils.hpp):
//
//	<domain>/<flow-id>.mxl-flow/flow_def.json   NMOS-Flow-Resource
//	<domain>/<flow-id>.mxl-flow/data            Shared-Memory-Segment mit dem Flow-Header
//
// Ein Schreiber hält ein flock() auf `data` (SharedMemory.cpp: LockMode::Shared bei CREATE_READ_WRITE; Leser öffnen
// READ_ONLY und sperren nicht). Ein Flow gilt in mxl_is_flow_active als aktiv, wenn sich kein exklusives flock()
// nehmen lässt. Der Halter steht in /proc/locks als `FLOCK ... <pid> <major>:<minor>:<inode>`.
package mxlflows

import (
	"bufio"
	"encoding/json"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"syscall"
)

const flowSuffix = ".mxl-flow"

// Writer ist ein Prozess, der ein flock() auf dem Datensegment des Flows hält.
type Writer struct {
	PID int `json:"pid"`
	// Cmd: Programmname (/proc/<pid>/comm), leer wenn der Prozess nicht mehr lesbar ist.
	Cmd string `json:"cmd,omitempty"`
	// Container: Container-ID aus /proc/<pid>/cgroup (podman/docker), leer außerhalb eines Containers.
	Container string `json:"container,omitempty"`
}

// Flow ist ein Flow der Domain.
type Flow struct {
	ID     string `json:"id"`
	Label  string `json:"label,omitempty"`
	Format string `json:"format,omitempty"` // urn:x-nmos:format:video|audio|data
	// Active: mindestens ein Prozess hält das Schreibersperre (gleiche Regel wie das MXL-SDK).
	Active  bool     `json:"active"`
	Writers []Writer `json:"writers"`
	// Stale: Flow-Verzeichnis ohne Schreiber, ohne dass das SDK es beim nächsten Start aufräumen würde — also ein
	// Rest eines beendeten oder abgestürzten Schreibers (belegt Speicher, taucht in Listen auf).
	Stale bool `json:"stale"`
	// SizeBytes: belegter Platz des Flow-Verzeichnisses (ohne Verzeichniseinträge).
	SizeBytes int64 `json:"sizeBytes"`
}

// Options macht die Quellen austauschbar (Tests).
type Options struct {
	ProcRoot string // Standard /proc
}

func (o Options) proc() string {
	if o.ProcRoot == "" {
		return "/proc"
	}
	return o.ProcRoot
}

// Scan liest alle Flows unter domain. Eine fehlende Domain ist kein Fehler (leere Liste).
func Scan(domain string, o Options) ([]Flow, error) {
	entries, err := os.ReadDir(domain)
	if err != nil {
		if os.IsNotExist(err) {
			return []Flow{}, nil
		}
		return nil, err
	}
	holders := lockHolders(o.proc())
	out := []Flow{}
	for _, e := range entries {
		name := e.Name()
		if !e.IsDir() || !strings.HasSuffix(name, flowSuffix) {
			continue
		}
		id := strings.TrimSuffix(name, flowSuffix)
		dir := filepath.Join(domain, name)
		f := Flow{ID: id, Writers: []Writer{}}
		readDef(filepath.Join(dir, "flow_def.json"), &f)
		f.SizeBytes = dirSize(dir)
		if st, err := os.Stat(filepath.Join(dir, "data")); err == nil {
			if sys, ok := st.Sys().(*syscall.Stat_t); ok {
				for _, pid := range holders[lockKey{dev: uint64(sys.Dev), ino: sys.Ino}] {
					f.Writers = append(f.Writers, describe(o.proc(), pid))
				}
			}
		}
		sort.Slice(f.Writers, func(i, j int) bool { return f.Writers[i].PID < f.Writers[j].PID })
		f.Active = len(f.Writers) > 0
		f.Stale = !f.Active
		out = append(out, f)
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].Label != out[j].Label {
			return out[i].Label < out[j].Label
		}
		return out[i].ID < out[j].ID
	})
	return out, nil
}

func readDef(path string, f *Flow) {
	b, err := os.ReadFile(path)
	if err != nil {
		return
	}
	var d struct {
		Label  string `json:"label"`
		Format string `json:"format"`
	}
	if json.Unmarshal(b, &d) == nil {
		f.Label, f.Format = d.Label, d.Format
	}
}

func dirSize(dir string) int64 {
	var n int64
	_ = filepath.WalkDir(dir, func(_ string, d os.DirEntry, err error) error {
		if err != nil || d.IsDir() {
			return nil
		}
		if info, err := d.Info(); err == nil {
			n += info.Size()
		}
		return nil
	})
	return n
}

type lockKey struct {
	dev uint64
	ino uint64
}

// lockHolders wertet /proc/locks aus: Zeilen der Form
//
//	1: FLOCK  ADVISORY  READ 1234 00:19:48213 0 EOF
//
// (Feld 6 = major:minor:inode, Major/Minor hexadezimal, Inode dezimal; siehe proc(5)).
// Der Gerätewert wird mit makedev (Linux, glibc-Kodierung) mit st_dev vergleichbar gemacht.
func lockHolders(proc string) map[lockKey][]int {
	res := map[lockKey][]int{}
	f, err := os.Open(filepath.Join(proc, "locks"))
	if err != nil {
		return res
	}
	defer f.Close()
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		fs := strings.Fields(sc.Text())
		// ggf. "->" bei wartenden Sperren (Zeile beginnt mit "->"): überspringen.
		if len(fs) < 6 || fs[0] == "->" || fs[1] != "FLOCK" {
			continue
		}
		pid, err := strconv.Atoi(fs[4])
		if err != nil {
			continue
		}
		parts := strings.Split(fs[5], ":")
		if len(parts) != 3 {
			continue
		}
		maj, e1 := strconv.ParseUint(parts[0], 16, 32)
		min, e2 := strconv.ParseUint(parts[1], 16, 32)
		ino, e3 := strconv.ParseUint(parts[2], 10, 64)
		if e1 != nil || e2 != nil || e3 != nil {
			continue
		}
		k := lockKey{dev: makedev(uint32(maj), uint32(min)), ino: ino}
		res[k] = append(res[k], pid)
	}
	return res
}

// makedev entspricht glibc: Dev_t in Stat_t.
func makedev(major, minor uint32) uint64 {
	return (uint64(major&0xfffff000) << 32) | (uint64(major&0x00000fff) << 8) |
		(uint64(minor&0xffffff00) << 12) | uint64(minor&0x000000ff)
}

func describe(proc string, pid int) Writer {
	w := Writer{PID: pid}
	base := filepath.Join(proc, strconv.Itoa(pid))
	if b, err := os.ReadFile(filepath.Join(base, "comm")); err == nil {
		w.Cmd = strings.TrimSpace(string(b))
	}
	if b, err := os.ReadFile(filepath.Join(base, "cgroup")); err == nil {
		w.Container = containerFromCgroup(string(b))
	}
	return w
}

// containerFromCgroup zieht die 64-stellige Container-ID aus einem cgroup-Pfad (libpod-<id>.scope, docker-<id>.scope,
// /docker/<id>, /libpod_parent/libpod-<id>). Kein Treffer → "".
func containerFromCgroup(s string) string {
	for _, line := range strings.Split(s, "\n") {
		for _, seg := range strings.FieldsFunc(line, func(r rune) bool { return r == '/' || r == ':' }) {
			seg = strings.TrimSuffix(seg, ".scope")
			for _, p := range []string{"libpod-", "docker-", "crio-"} {
				seg = strings.TrimPrefix(seg, p)
			}
			if len(seg) == 64 && isHex(seg) {
				return seg[:12]
			}
		}
	}
	return ""
}

func isHex(s string) bool {
	for _, r := range s {
		if !(r >= '0' && r <= '9' || r >= 'a' && r <= 'f') {
			return false
		}
	}
	return true
}
