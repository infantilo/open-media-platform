package commands

import (
	"os"
	"path/filepath"
	"strings"

	"github.com/infantilo/openmediaplatform/jobwire"
)

// fileRoots: die Verzeichnisse, die dieser Host für Dateioperationen freigibt — OMP_FILE_ROOTS (Doppelpunkt-getrennt),
// ersatzweise die Medienverzeichnisse OMP_MEDIA_MOUNTS. Relative Einträge zählen nicht.
func fileRoots() []string {
	allow := strings.TrimSpace(os.Getenv("OMP_FILE_ROOTS"))
	if allow == "" {
		allow = os.Getenv("OMP_MEDIA_MOUNTS")
	}
	var roots []string
	for _, r := range strings.Split(allow, ":") {
		if r = strings.TrimSpace(r); filepath.IsAbs(r) {
			roots = append(roots, filepath.Clean(r))
		}
	}
	return roots
}

// handleFiles führt eine Dateioperation (Kap. 86) in einer Wurzel dieses Hosts aus. Sicherheitsgrenze des Hosts: die
// angefragte Wurzel muss unter einer freigegebenen liegen (fileRoots) — ohne Freigabe geschieht nichts. Verzeichnisse
// mit dem Zustand und dem Katalog des Agents (protected) sind auch innerhalb einer Freigabe tabu.
func (e *Executor) handleFiles(req Request) Response {
	if req.FileOp == nil {
		return Response{OK: false, Error: "fileOp required"}
	}
	roots := fileRoots()
	if len(roots) == 0 {
		return Response{OK: false, Error: "Wurzel nicht freigegeben (auf diesem Host ist weder OMP_FILE_ROOTS noch OMP_MEDIA_MOUNTS gesetzt)"}
	}
	root := req.FileOp.Root
	if !filepath.IsAbs(root) || !jobwire.UnderRoots(root, roots) {
		return Response{OK: false, Error: "Wurzel nicht freigegeben (OMP_FILE_ROOTS/OMP_MEDIA_MOUNTS dieses Hosts)"}
	}
	for _, p := range e.protected {
		// in beide Richtungen: die Wurzel enthält das geschützte Objekt, oder sie liegt darin
		if jobwire.UnderRoots(p, []string{root}) || jobwire.UnderRoots(root, []string{p}) {
			return Response{OK: false, Error: "Wurzel nicht freigegeben (enthält Dateien des Host-Agents)"}
		}
	}
	out, err := jobwire.RunFileOpTimeout(*req.FileOp, 0)
	if err != nil {
		return Response{OK: false, Error: err.Error()}
	}
	return Response{OK: true, Detail: string(out)}
}

// SetProtectedPaths nennt Dateien und Verzeichnisse, die Dateioperationen nie erreichen dürfen.
func (e *Executor) SetProtectedPaths(paths ...string) {
	for _, p := range paths {
		if p == "" {
			continue
		}
		if abs, err := filepath.Abs(p); err == nil {
			e.protected = append(e.protected, abs)
		}
	}
}
