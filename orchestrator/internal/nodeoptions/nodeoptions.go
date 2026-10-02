// Package nodeoptions macht die Umgebungsvariablen der Nodes über die UI
// einstellbar (Kapitel 29): Jeder Node-Typ deklariert seine Optionen (Schema
// aus deploy/node-options.json bzw. dem Katalog-Eintrag), der Orchestrator
// speichert Werte je Node-Typ und optional je Instanz in der Datenbank und der
// Launcher reicht sie beim (Neu-)Start als Umgebung weiter.
//
// Rangfolge beim Start (spätere gewinnen):
//
//	Katalog-`env` < Typ-Wert < Workflow-extraEnv (z. B. Format-Preset) < Instanz-Wert
//
// Alle Werte werden serverseitig gegen das Schema geprüft — der Launcher setzt
// nie etwas, das nicht deklariert und gültig ist. Pfade werden gegen das
// Dateisystem des Orchestrator-Hosts geprüft (lokale Instanzen).
package nodeoptions

import (
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"net"
	"net/url"
	"os"
	"regexp"
	"strconv"
	"strings"
)

// Type ist die Art einer Option.
type Type string

const (
	TypeString Type = "string"
	TypePath   Type = "path" // Datei oder Verzeichnis (je Option.PathKind)
	TypeInt    Type = "int"
	TypeFloat  Type = "float"
	TypeEnum   Type = "enum"
	TypeHost   Type = "host" // Hostname oder IP (v4/v6)
	TypePort   Type = "port" // 0–65535
	TypeURL    Type = "url"
)

// PathKind: was ein Pfad sein soll.
const (
	PathDir  = "dir"
	PathFile = "file"
)

// Choice ist ein Eintrag einer Auswahl-Option.
type Choice struct {
	Value string `json:"value"`
	Label string `json:"label,omitempty"`
}

// Option beschreibt eine einstellbare Umgebungsvariable eines Node-Typs.
type Option struct {
	// Key ist der Name der Umgebungsvariable (OMP_…).
	Key         string   `json:"key"`
	Label       string   `json:"label"`
	Description string   `json:"description,omitempty"`
	Type        Type     `json:"type"`
	Default     string   `json:"default,omitempty"`
	Group       string   `json:"group,omitempty"`
	Placeholder string   `json:"placeholder,omitempty"`
	Min         *float64 `json:"min,omitempty"`
	Max         *float64 `json:"max,omitempty"`
	Choices     []Choice `json:"choices,omitempty"`
	// PathKind (nur path): "dir" | "file".
	PathKind string `json:"pathKind,omitempty"`
	// MustExist (nur path): fehlt der Pfad, ist das ein Fehler statt einer Warnung.
	MustExist bool `json:"mustExist,omitempty"`
}

var (
	keyPattern  = regexp.MustCompile(`^OMP_[A-Z0-9_]{2,80}$`)
	hostPattern = regexp.MustCompile(`^[A-Za-z0-9._:\-\[\]%]{1,253}$`)

	// reserved sind Variablen, die der Launcher selbst setzt — nie überschreibbar.
	reserved = map[string]bool{
		"OMP_INSTANCE_ID": true, "OMP_LABEL": true, "OMP_PORT": true, "OMP_REGISTRY_URL": true,
		"OMP_NATS_URL": true, "OMP_ORCHESTRATOR_URL": true, "OMP_LAUNCH_SECRET": true,
		"OMP_WORKFLOW_ID": true, "OMP_ROLE_SEED": true,
	}

	// ErrInvalid: Wert oder Schema ungültig (Text ist für Menschen gedacht).
	ErrInvalid = errors.New("nodeoptions: ungültig")
)

// ValidateSchema prüft eine Optionsliste (beim Laden, nicht erst beim Setzen).
func ValidateSchema(opts []Option) error {
	seen := map[string]bool{}
	for _, o := range opts {
		switch {
		case !keyPattern.MatchString(o.Key):
			return fmt.Errorf("%w: Schlüssel %q ist keine OMP_-Umgebungsvariable", ErrInvalid, o.Key)
		case reserved[o.Key]:
			return fmt.Errorf("%w: %s wird vom Launcher selbst gesetzt", ErrInvalid, o.Key)
		case seen[o.Key]:
			return fmt.Errorf("%w: %s doppelt deklariert", ErrInvalid, o.Key)
		case o.Label == "":
			return fmt.Errorf("%w: %s ohne Bezeichnung", ErrInvalid, o.Key)
		}
		seen[o.Key] = true
		switch o.Type {
		case TypeString, TypeInt, TypeFloat, TypeHost, TypePort, TypeURL:
		case TypePath:
			if o.PathKind != PathDir && o.PathKind != PathFile {
				return fmt.Errorf("%w: %s: pathKind muss dir oder file sein", ErrInvalid, o.Key)
			}
		case TypeEnum:
			if len(o.Choices) == 0 {
				return fmt.Errorf("%w: %s: enum ohne Auswahl", ErrInvalid, o.Key)
			}
		default:
			return fmt.Errorf("%w: %s: unbekannter Typ %q", ErrInvalid, o.Key, o.Type)
		}
	}
	return nil
}

// Find sucht eine Option nach Schlüssel.
func Find(opts []Option, key string) (Option, bool) {
	for _, o := range opts {
		if o.Key == key {
			return o, true
		}
	}
	return Option{}, false
}

// Validate prüft raw gegen die Option. Liefert den normalisierten Wert und eine
// optionale Warnung (z. B. Pfad existiert (noch) nicht). Ein leerer Wert ist
// immer gültig und bedeutet „Standard verwenden“ (Aufrufer löscht dann den Eintrag).
func Validate(o Option, raw string) (value, warning string, err error) {
	v := strings.TrimSpace(raw)
	if v == "" {
		return "", "", nil
	}
	if len(v) > 1024 || strings.ContainsAny(v, "\x00\n\r") {
		return "", "", fmt.Errorf("%w: %s: Wert zu lang oder enthält Steuerzeichen", ErrInvalid, o.Label)
	}
	switch o.Type {
	case TypeString:
		return v, "", nil
	case TypeInt, TypePort:
		n, perr := strconv.ParseInt(v, 10, 64)
		if perr != nil {
			return "", "", fmt.Errorf("%w: %s: „%s“ ist keine ganze Zahl", ErrInvalid, o.Label, v)
		}
		lo, hi := o.Min, o.Max
		if o.Type == TypePort {
			zero, max := 0.0, 65535.0
			if lo == nil {
				lo = &zero
			}
			if hi == nil {
				hi = &max
			}
		}
		if err := checkRange(o, float64(n), lo, hi); err != nil {
			return "", "", err
		}
		return strconv.FormatInt(n, 10), "", nil
	case TypeFloat:
		f, perr := strconv.ParseFloat(v, 64)
		if perr != nil || math.IsNaN(f) || math.IsInf(f, 0) {
			return "", "", fmt.Errorf("%w: %s: „%s“ ist keine Zahl", ErrInvalid, o.Label, v)
		}
		if err := checkRange(o, f, o.Min, o.Max); err != nil {
			return "", "", err
		}
		return strconv.FormatFloat(f, 'f', -1, 64), "", nil
	case TypeEnum:
		for _, c := range o.Choices {
			if c.Value == v {
				return v, "", nil
			}
		}
		return "", "", fmt.Errorf("%w: %s: „%s“ ist keine der erlaubten Optionen", ErrInvalid, o.Label, v)
	case TypeHost:
		if !hostPattern.MatchString(v) {
			return "", "", fmt.Errorf("%w: %s: „%s“ ist kein gültiger Host/keine gültige Adresse", ErrInvalid, o.Label, v)
		}
		return v, "", nil
	case TypeURL:
		u, perr := url.Parse(v)
		if perr != nil || u.Scheme == "" || (u.Host == "" && u.Opaque == "") {
			return "", "", fmt.Errorf("%w: %s: „%s“ ist keine gültige URL (Schema://Host…)", ErrInvalid, o.Label, v)
		}
		return v, "", nil
	case TypePath:
		return validatePath(o, v)
	}
	return "", "", fmt.Errorf("%w: unbekannter Typ %q", ErrInvalid, o.Type)
}

func checkRange(o Option, n float64, lo, hi *float64) error {
	if lo != nil && n < *lo {
		return fmt.Errorf("%w: %s: %v ist kleiner als das Minimum %v", ErrInvalid, o.Label, n, *lo)
	}
	if hi != nil && n > *hi {
		return fmt.Errorf("%w: %s: %v ist größer als das Maximum %v", ErrInvalid, o.Label, n, *hi)
	}
	return nil
}

// PathInfo ist das Ergebnis einer Pfadprüfung auf dem Orchestrator-Host.
type PathInfo struct {
	Exists   bool   `json:"exists"`
	IsDir    bool   `json:"isDir"`
	Readable bool   `json:"readable"`
	Entries  int    `json:"entries,omitempty"` // Verzeichnis: Anzahl Einträge (gedeckelt)
	Message  string `json:"message"`
}

// CheckPath prüft einen Pfad (relativ = zum Arbeitsverzeichnis des Orchestrators,
// dem der lokal gestarteten Nodes).
func CheckPath(p, kind string) PathInfo {
	st, err := os.Stat(p)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return PathInfo{Message: "Pfad existiert nicht"}
		}
		return PathInfo{Message: "nicht zugreifbar: " + err.Error()}
	}
	info := PathInfo{Exists: true, IsDir: st.IsDir()}
	switch {
	case kind == PathDir && !st.IsDir():
		info.Message = "ist kein Verzeichnis"
	case kind == PathFile && st.IsDir():
		info.Message = "ist ein Verzeichnis, erwartet wird eine Datei"
	case st.IsDir():
		entries, rerr := os.ReadDir(p)
		if rerr != nil {
			info.Message = "Verzeichnis nicht lesbar: " + rerr.Error()
			return info
		}
		info.Readable = true
		info.Entries = len(entries)
		info.Message = fmt.Sprintf("Verzeichnis lesbar, %d Einträge", len(entries))
	default:
		f, oerr := os.Open(p)
		if oerr != nil {
			info.Message = "Datei nicht lesbar: " + oerr.Error()
			return info
		}
		_ = f.Close()
		info.Readable = true
		info.Message = fmt.Sprintf("Datei lesbar, %d Bytes", st.Size())
	}
	return info
}

func validatePath(o Option, v string) (string, string, error) {
	if strings.Contains(v, "..") {
		return "", "", fmt.Errorf("%w: %s: „..“ im Pfad ist nicht erlaubt", ErrInvalid, o.Label)
	}
	info := CheckPath(v, o.PathKind)
	if info.Exists && info.Readable {
		return v, "", nil
	}
	if o.MustExist || (info.Exists && !info.Readable) {
		return "", "", fmt.Errorf("%w: %s: %s (%s)", ErrInvalid, o.Label, info.Message, v)
	}
	return v, fmt.Sprintf("%s: %s — der Node legt ihn ggf. selbst an oder meldet beim Start einen Fehler", v, info.Message), nil
}

// LoadFile liest deploy/node-options.json: {"<node-typ>": [Option, …], …}. Jeder
// Eintrag wird geprüft; ein ungültiges Schema lehnt die ganze Datei ab (lieber
// laut scheitern als stille, halbe Einstellbarkeit).
func LoadFile(path string) (map[string][]Option, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	var m map[string][]Option
	if err := json.Unmarshal(data, &m); err != nil {
		return nil, fmt.Errorf("nodeoptions: %s: %w", path, err)
	}
	for typ, opts := range m {
		if err := ValidateSchema(opts); err != nil {
			return nil, fmt.Errorf("%s: %w", typ, err)
		}
	}
	return m, nil
}

// HostOrIP prüft, ob s eine IP ist (Hilfsfunktion für Tests/Aufrufer).
func HostOrIP(s string) bool { return net.ParseIP(s) != nil || hostPattern.MatchString(s) }
