package commands

import (
	"os"
	"path/filepath"
	"strings"

	"github.com/infantilo/openmediaplatform/jobwire"
)

// handleFiles führt eine Dateioperation (Kap. 86) in einer Wurzel dieses Hosts aus. Optionale Sicherheitsgrenze des Hosts:
// OMP_FILE_ROOTS (Doppelpunkt-getrennte Pfade) — gesetzt, muss die angefragte Wurzel darunter liegen; der Orchestrator kann
// den Agent also nie auf Verzeichnisse lenken, die der Host nicht freigegeben hat.
func (e *Executor) handleFiles(req Request) Response {
	if req.FileOp == nil {
		return Response{OK: false, Error: "fileOp required"}
	}
	if allow := strings.TrimSpace(os.Getenv("OMP_FILE_ROOTS")); allow != "" {
		var roots []string
		for _, r := range strings.Split(allow, ":") {
			if r = strings.TrimSpace(r); r != "" {
				roots = append(roots, filepath.Clean(r))
			}
		}
		if !jobwire.UnderRoots(req.FileOp.Root, roots) {
			return Response{OK: false, Error: "Wurzel nicht freigegeben (OMP_FILE_ROOTS dieses Hosts)"}
		}
	}
	out, err := jobwire.RunFileOp(*req.FileOp)
	if err != nil {
		return Response{OK: false, Error: err.Error()}
	}
	return Response{OK: true, Detail: string(out)}
}
