// Package version trägt den Build-Stempel des Host-Agents (wie orchestrator/internal/version). Per -ldflags gesetzt
// (deploy/dev/start-hosts.sh, Release-Build), sonst "dev".
package version

// Version: Versionsnummer ("dev" = ohne Stempel gebaut).
var Version = "dev"

// Commit: Git-Commit des Builds.
var Commit = ""

// BuiltAt: Bauzeitpunkt, RFC 3339.
var BuiltAt = ""

// Release: Release, auf dem der Stand aufbaut (`git describe`).
var Release = ""

// Info fasst den Stempel zusammen.
type Info struct {
	Version string `json:"version"`
	Commit  string `json:"commit,omitempty"`
	BuiltAt string `json:"builtAt,omitempty"`
	Release string `json:"release,omitempty"`
}

// Current liefert den Stempel dieses Prozesses.
func Current() Info {
	return Info{Version: Version, Commit: Commit, BuiltAt: BuiltAt, Release: Release}
}
