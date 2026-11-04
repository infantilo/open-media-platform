package update

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"os"
	"sync"
)

// Build-Stempel in Node-Binaries: `OMPBUILD1{…json…}OMPBUILD1END`, vom omp-node-sdk eingebettet. Die Datei wird nur gelesen,
// nie ausgeführt. Genutzt vom Orchestrator (nodeversions) und vom Host-Agent (Software-Anzeige, Kap. 85).
const (
	markerStart = "OMPBUILD1{"
	markerEnd   = "}OMPBUILD1END"
)

// ErrNoBuildMarker: die Datei trägt keinen Build-Stempel.
var ErrNoBuildMarker = errors.New("update: kein Build-Stempel im Binary gefunden")

// ReadBuildMarker liefert das JSON des Stempels (streamend, Chunk-Überlappung).
func ReadBuildMarker(path string) ([]byte, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	const chunk = 4 << 20
	const overlap = 512
	buf := make([]byte, chunk+overlap)
	have := 0
	for {
		n, rerr := f.Read(buf[have : have+chunk])
		have += n
		window := buf[:have]
		if i := bytes.Index(window, []byte(markerStart)); i >= 0 {
			rest := window[i+len(markerStart)-1:] // ab "{"
			if j := bytes.Index(rest, []byte(markerEnd)); j >= 0 {
				return append([]byte(nil), rest[:j+1]...), nil
			}
			// Marker beginnt, Ende fehlt noch: ab Markeranfang weiterlesen.
			copy(buf, window[i:])
			have -= i
			if rerr != nil {
				return nil, ErrNoBuildMarker
			}
			continue
		}
		if rerr != nil {
			if errors.Is(rerr, io.EOF) {
				return nil, ErrNoBuildMarker
			}
			return nil, rerr
		}
		keep := overlap
		if have < keep {
			keep = have
		}
		copy(buf, window[have-keep:])
		have = keep
	}
}

// Stamp ist der lesbare Stand eines Binaries für Anzeigen (Error gesetzt, wenn kein Stempel gelesen werden konnte).
type Stamp struct {
	Version string
	Commit  string
	BuiltAt string
	// Modified: Änderungszeit der Datei (RFC 3339, UTC) — Anhaltspunkt, wenn der Stempel keine Bauzeit trägt (Entwicklungs-Builds).
	Modified string
	// Size: Dateigröße in Byte — gleiche Größe bei gleichem Stempel gilt als gleicher Build.
	Size  int64
	Error string
}

type stampKey struct {
	path      string
	mod, size int64
}

var (
	stampMu    sync.Mutex
	stampCache = map[stampKey]Stamp{}
)

// StampOf liest den Stempel mit Zwischenspeicher je Pfad/Änderungszeit/Größe: große Binaries werden nicht bei jeder
// Abfrage neu durchsucht, ein ersetztes Binary wird sofort neu gelesen.
func StampOf(path string) Stamp {
	st, err := os.Stat(path)
	if err != nil {
		return Stamp{Error: "Datei nicht lesbar"}
	}
	k := stampKey{path, st.ModTime().UnixNano(), st.Size()}
	stampMu.Lock()
	if v, ok := stampCache[k]; ok {
		stampMu.Unlock()
		return v
	}
	stampMu.Unlock()
	var v Stamp
	mod := st.ModTime().UTC().Format("2006-01-02T15:04:05Z")
	size := st.Size()
	raw, err := ReadBuildMarker(path)
	switch {
	case errors.Is(err, ErrNoBuildMarker):
		v = Stamp{Error: "kein Build-Stempel", Modified: mod, Size: size}
	case err != nil:
		v = Stamp{Error: err.Error(), Modified: mod, Size: size}
	default:
		var info struct {
			Version string `json:"version"`
			Commit  string `json:"commit"`
			BuiltAt string `json:"builtAt"`
		}
		if json.Unmarshal(raw, &info) != nil {
			v = Stamp{Error: "Stempel unlesbar", Modified: mod, Size: size}
		} else {
			v = Stamp{Version: info.Version, Commit: info.Commit, BuiltAt: info.BuiltAt, Modified: mod, Size: size}
		}
	}
	stampMu.Lock()
	for old := range stampCache {
		if old.path == path {
			delete(stampCache, old)
		}
	}
	stampCache[k] = v
	stampMu.Unlock()
	return v
}
