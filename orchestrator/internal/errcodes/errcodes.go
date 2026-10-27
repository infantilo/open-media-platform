// Package errcodes ist der Katalog der Fehlercodes (UMSETZUNG.md Kap. 72.8): jeder bekannte Fehler hat einen stabilen Code
// (OMP-nnnn) mit Titel, Ursache und Lösungsschritten in Klartext. Der Katalog erkennt Meldungen am Muster (ältere Freitext-
// Meldungen bleiben also gültig) und am Code selbst: eine Meldung mit „[OMP-3001]“ wird direkt zugeordnet — so können Go und
// Rust ihre Meldungen schrittweise mit Codes versehen.
//
// Die Muster müssen in Go (RE2) und im Browser (JavaScript) gleich laufen: keine Inline-Schalter, keine Rückblicke; die
// Groß-/Kleinschreibung wird nie unterschieden.
package errcodes

import (
	"fmt"
	"regexp"
	"strings"
)

// Severity eines Fehlers.
const (
	SevError = "error"
	SevWarn  = "warn"
	SevInfo  = "info"
)

// Text ist ein zweisprachiger Text.
type Text struct{ DE, EN string }

// Steps sind die Lösungsschritte in Reihenfolge.
type Steps struct{ DE, EN []string }

// Entry ist ein Fehlercode.
type Entry struct {
	Code     string
	Severity string
	Match    string // Muster (ohne Schalter); leer = nur über den Code selbst oder die Befund-ID erreichbar
	Title    Text
	Cause    Text
	Fix      Steps
	re       *regexp.Regexp
}

// Doc ist der Anker im Handbuch (docs/FEHLERCODES.md).
func (e Entry) Doc() string { return "FEHLERCODES.md#" + strings.ToLower(e.Code) }

var tagRe = regexp.MustCompile(`\bOMP-(\d{4})\b`)

// Prefix liefert „[OMP-nnnn]“ zum Voranstellen (für fmt.Errorf mit %w); ein unbekannter Code ergibt einen leeren Text.
func Prefix(code string) string {
	if _, ok := Lookup(code); !ok {
		return ""
	}
	return "[" + code + "]"
}

// Tag stellt einer Meldung den Code voran („[OMP-3001] …“); ein unbekannter Code wird nicht angefügt.
func Tag(code, msg string) string {
	if _, ok := Lookup(code); !ok {
		return msg
	}
	return fmt.Sprintf("[%s] %s", code, msg)
}

func init() {
	seen := map[string]bool{}
	for i := range catalog {
		e := &catalog[i]
		if seen[e.Code] {
			panic("errcodes: doppelter Code " + e.Code)
		}
		seen[e.Code] = true
		if e.Match != "" {
			e.re = regexp.MustCompile("(?i)" + e.Match)
		}
	}
}

// All liefert den Katalog (Reihenfolge = Reihenfolge der Mustersuche).
func All() []Entry { return catalog }

// Lookup sucht einen Code.
func Lookup(code string) (Entry, bool) {
	code = strings.ToUpper(strings.TrimSpace(code))
	for _, e := range catalog {
		if e.Code == code {
			return e, true
		}
	}
	return Entry{}, false
}

// Classify ordnet eine Meldung einem Code zu: zuerst ein „OMP-nnnn“ in der Meldung selbst, sonst das erste passende Muster.
func Classify(msg string) (Entry, bool) {
	if m := tagRe.FindString(msg); m != "" {
		if e, ok := Lookup(m); ok {
			return e, true
		}
	}
	for _, e := range catalog {
		if e.re != nil && e.re.MatchString(msg) {
			return e, true
		}
	}
	return Entry{}, false
}

// ForCheck liefert den Code eines Befunds des Selbsttests oder der Node-Diagnose (Befund-ID → Code).
func ForCheck(id string) string {
	switch {
	case id == "database":
		return "OMP-1001"
	case id == "cluster":
		return "OMP-1004"
	case strings.HasPrefix(id, "disk:"):
		return "OMP-1005"
	case id == "memory":
		return "OMP-1010"
	case id == "fds", strings.HasSuffix(id, ":fds"):
		return "OMP-1011"
	case id == "load":
		return "OMP-1012"
	case strings.HasSuffix(id, ":disk:/"), strings.Contains(id, ":disk:"):
		return "OMP-1005"
	case strings.HasSuffix(id, ":memory"):
		return "OMP-1010"
	case strings.HasSuffix(id, ":load"):
		return "OMP-1012"
	case strings.HasSuffix(id, ":shm"), id == "shm":
		return "OMP-3002"
	case strings.HasPrefix(id, "host:") && strings.Count(id, ":") == 1:
		return "OMP-5001"
	case id == "nodes", id == "online", id == "registry":
		return "OMP-2001"
	case id == "instances-crashed", id == "crashed":
		return "OMP-2004"
	case id == "instances-restarts", id == "restarts":
		return "OMP-2009"
	case id == "instances-outdated", id == "outdated":
		return "OMP-2010"
	case id == "media":
		return "OMP-3006"
	case id == "fps":
		return "OMP-3007"
	case id == "cpu":
		return "OMP-1012"
	case id == "threads":
		return "OMP-1011"
	case strings.HasPrefix(id, "pipeline-queues:"):
		return "OMP-3008"
	case strings.HasPrefix(id, "pipeline-elements:"), strings.HasPrefix(id, "pipeline:"):
		return "OMP-3004"
	}
	return ""
}
