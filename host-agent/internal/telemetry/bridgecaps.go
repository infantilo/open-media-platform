package telemetry

import (
	"os"
	"path/filepath"
	"strings"
)

// BridgeCaps: welche Gateway-Ketten dieser Host für Umzüge über Hostgrenzen (Kapitel 108) bauen kann. Ein Transport gilt
// als möglich, wenn alle seine Gateway-Binaries im Agent-Katalog stehen und ausführbar sind (Fabrics zusätzlich:
// libmxl-fabrics gefunden). Das sagt nichts über Netzkarte oder Zeitbasis — scheitert der Start, folgt der nächste Transport.
type BridgeCaps struct {
	Fabrics bool `json:"fabrics"`
	ST2110  bool `json:"st2110"`
	AES67   bool `json:"aes67"`
	SRT     bool `json:"srt"`
}

// DetectBridgeCaps wertet den Katalog aus: binary(type) liefert den Pfad des Kommandos eines Node-Typs ("" = nicht im Katalog).
func DetectBridgeCaps(binary func(nodeType string) string, libFound bool) BridgeCaps {
	all := func(types ...string) bool {
		for _, t := range types {
			p := binary(t)
			if p == "" {
				return false
			}
			st, err := os.Stat(p)
			if err != nil || st.IsDir() || st.Mode()&0o111 == 0 {
				return false
			}
		}
		return true
	}
	return BridgeCaps{
		Fabrics: libFound && all("omp-fabrics-gateway-target", "omp-fabrics-gateway-initiator"),
		ST2110:  all("omp-2110-gateway-ingest", "omp-2110-gateway-output"),
		AES67:   all("omp-aes67-gateway-source", "omp-aes67-gateway-sink"),
		SRT:     all("omp-2110-gateway-ingest", "omp-2110-gateway-output", "omp-srt-gateway-uplink", "omp-srt-gateway-downlink"),
	}
}

// LibraryFound sucht eine Bibliothek in LD_LIBRARY_PATH und den üblichen Systempfaden.
func LibraryFound(prefix string) bool {
	dirs := strings.Split(os.Getenv("LD_LIBRARY_PATH"), ":")
	dirs = append(dirs, "/usr/lib", "/usr/lib64", "/usr/local/lib", "/usr/lib/x86_64-linux-gnu", "/usr/lib/aarch64-linux-gnu")
	for _, d := range dirs {
		if d == "" {
			continue
		}
		if m, _ := filepath.Glob(filepath.Join(d, prefix+"*")); len(m) > 0 {
			return true
		}
	}
	return false
}
