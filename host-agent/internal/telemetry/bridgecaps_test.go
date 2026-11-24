package telemetry

import (
	"os"
	"path/filepath"
	"testing"
)

func TestDetectBridgeCaps(t *testing.T) {
	dir := t.TempDir()
	mk := func(name string, mode os.FileMode) string {
		p := filepath.Join(dir, name)
		if err := os.WriteFile(p, []byte("x"), mode); err != nil {
			t.Fatal(err)
		}
		return p
	}
	bins := map[string]string{
		"omp-fabrics-gateway-target": mk("ft", 0o755), "omp-fabrics-gateway-initiator": mk("fi", 0o755),
		"omp-aes67-gateway-source": mk("as", 0o755), "omp-aes67-gateway-sink": mk("ak", 0o644), // nicht ausführbar
		"omp-2110-gateway-ingest": mk("gi", 0o755), "omp-2110-gateway-output": mk("go", 0o755),
	}
	find := func(t string) string { return bins[t] }
	c := DetectBridgeCaps(find, true)
	if !c.Fabrics || !c.ST2110 || c.AES67 || c.SRT {
		t.Fatalf("caps = %+v", c)
	}
	if c := DetectBridgeCaps(find, false); c.Fabrics {
		t.Fatal("fabrics needs libmxl-fabrics")
	}
}
