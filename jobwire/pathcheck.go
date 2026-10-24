package jobwire

import (
	"path/filepath"
	"regexp"
	"strings"
)

// Gemeinsame Pfadprüfung für ffmpeg-Argumente: Host-Agent und lokaler Ausführer des Orchestrators prüfen gleich.

var parentSegRe = regexp.MustCompile(`(^|[/\\=:,;'"\s\[(])\.\.($|[/\\,;:'"\s\])])`)

// HasParentSegment: das Argument enthält ein Pfadsegment „..“ (auch eingebettet, etwa in movie=../x). Relative Pfade
// mit „..“ verließen das Arbeitsverzeichnis des Jobs und die erlaubten Wurzeln.
func HasParentSegment(a string) bool { return parentSegRe.MatchString(a) }

var embeddedPathRe = regexp.MustCompile(`(?:^|[=:,;'"\s\[])(/[^\s,;:'"\]]+)`)

// EmbeddedAbsPaths liefert absolute Pfade, die in einem Filter-Argument stecken (movie=, subtitles=, …).
func EmbeddedAbsPaths(a string) []string {
	var out []string
	for _, m := range embeddedPathRe.FindAllStringSubmatch(a, -1) {
		out = append(out, m[1])
	}
	return out
}

// UnderRoots: der Pfad liegt (nach Auflösen von Symlinks des vorhandenen Anteils) unter einer der Wurzeln.
func UnderRoots(p string, roots []string) bool {
	rp := ResolveExisting(filepath.Clean(p))
	for _, root := range roots {
		rr := ResolveExisting(root)
		if rp == rr || strings.HasPrefix(rp, rr+string(filepath.Separator)) {
			return true
		}
	}
	return false
}

// ResolveExisting löst Symlinks des längsten vorhandenen Präfixes auf (Ausgabedateien existieren noch nicht).
func ResolveExisting(p string) string {
	rest := ""
	cur := p
	for {
		if real, err := filepath.EvalSymlinks(cur); err == nil {
			return filepath.Join(real, rest)
		}
		parent := filepath.Dir(cur)
		if parent == cur {
			return p
		}
		rest = filepath.Join(filepath.Base(cur), rest)
		cur = parent
	}
}
