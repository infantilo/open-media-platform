package commands

// Aktion "software" (Kap. 85, Nutzerwunsch: „welcher Host läuft mit welcher Version“): der Agent meldet seinen eigenen
// Build-Stempel, die Stempel der Node-Binaries seines Katalogs (gelesen aus der Datei, nie ausgeführt), die per Bundle
// installierten Microservices und wie viele Instanzen je Typ laufen (davon veraltet).

import (
	"encoding/json"
	"path/filepath"
	"sort"
	"time"

	"github.com/infantilo/openmediaplatform/host-agent/internal/version"
	"github.com/infantilo/openmediaplatform/update"
)

// SoftwareNode ist ein Node-Typ dieses Hosts.
type SoftwareNode struct {
	Type    string `json:"type"`
	Runner  string `json:"runner"`
	Binary  string `json:"binary,omitempty"`
	Version string `json:"version,omitempty"`
	Commit  string `json:"commit,omitempty"`
	BuiltAt string `json:"builtAt,omitempty"`
	// Modified: Änderungszeit der Binärdatei (Anhaltspunkt bei Entwicklungs-Builds ohne Bauzeit im Stempel).
	Modified string `json:"modified,omitempty"`
	// Source: "binary" (Stempel aus der Datei), "image" (Container) oder leer, wenn kein Stempel lesbar war.
	Source   string `json:"source,omitempty"`
	Error    string `json:"error,omitempty"`
	Running  int    `json:"running"`
	Outdated int    `json:"outdated,omitempty"`
}

// SoftwareReport ist die Antwort auf Action "software" (Response.Detail als JSON).
type SoftwareReport struct {
	Agent   version.Info   `json:"agent"`
	Nodes   []SoftwareNode `json:"nodes"`
	Updated time.Time      `json:"updated"`
}

func (e *Executor) software() Response {
	e.mu.Lock()
	running := map[string]int{}
	outdated := map[string]int{}
	for _, ri := range e.instances {
		if ri.nodeType == "" {
			continue
		}
		running[ri.nodeType]++
		if ri.containerID == "" && ri.cmd != nil && ri.cmd.Process != nil && binaryNewerThanProcess(ri.binPath, ri.cmd.Process.Pid) {
			outdated[ri.nodeType]++
		}
	}
	e.mu.Unlock()

	rep := SoftwareReport{Agent: version.Current(), Updated: time.Now().UTC()}
	seen := map[string]bool{}
	for _, en := range e.catalog {
		n := SoftwareNode{Type: en.Type, Runner: en.Runner, Running: running[en.Type], Outdated: outdated[en.Type]}
		if len(en.Command) > 0 && en.Runner != "podman" {
			n.Binary = filepath.Base(en.Command[0])
			v := update.StampOf(en.Command[0])
			n.Version, n.Commit, n.BuiltAt, n.Modified, n.Error = v.Version, v.Commit, v.BuiltAt, v.Modified, v.Error
			if v.Error == "" {
				n.Source = "binary"
			}
		} else if en.Image != "" {
			n.Version, n.Source = en.Version, "image"
		}
		seen[en.Type] = true
		rep.Nodes = append(rep.Nodes, n)
	}
	if e.installed != nil {
		for _, in := range e.installed.List() {
			key := in.Type
			rep.Nodes = append(rep.Nodes, SoftwareNode{Type: key, Runner: "podman", Version: in.Version, Source: "image", Running: running[key]})
		}
	}
	sort.SliceStable(rep.Nodes, func(i, j int) bool {
		if rep.Nodes[i].Type != rep.Nodes[j].Type {
			return rep.Nodes[i].Type < rep.Nodes[j].Type
		}
		return rep.Nodes[i].Version < rep.Nodes[j].Version
	})
	data, _ := json.Marshal(rep)
	return Response{OK: true, Detail: string(data)}
}
