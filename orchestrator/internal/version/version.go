// Package version trägt den Build-Stempel des Orchestrators. Wird beim
// Release-Build per -ldflags gesetzt (make update-bundle / deploy/dev/
// start-omp.sh), im Entwicklungsbetrieb bleibt "dev".
//
//	go build -ldflags "-X github.com/infantilo/openmediaplatform/orchestrator/internal/version.Version=2026.10.0 \
//	    -X …/version.Commit=abc1234 -X …/version.BuiltAt=2026-09-30T15:00:00Z"
package version

// Version ist die Versionsnummer ("dev" = ohne Stempel gebaut).
var Version = "dev"

// Commit ist der Git-Commit des Builds (optional).
var Commit = ""

// BuiltAt ist der Bauzeitpunkt, RFC 3339 (optional).
var BuiltAt = ""

// Info fasst den Stempel für die HTTP-API zusammen.
type Info struct {
	Version string `json:"version"`
	Commit  string `json:"commit,omitempty"`
	BuiltAt string `json:"builtAt,omitempty"`
}

// Current liefert den Stempel dieses Prozesses.
func Current() Info { return Info{Version: Version, Commit: Commit, BuiltAt: BuiltAt} }
