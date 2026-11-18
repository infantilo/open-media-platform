package mxlflows

import (
	"os"
	"testing"
)

// Nur manuell: OMP_LIVE_PROBE_DOMAIN=<domain> go test -run TestLiveProbe -v
func TestLiveProbe(t *testing.T) {
	d := os.Getenv("OMP_LIVE_PROBE_DOMAIN")
	if d == "" {
		t.Skip("OMP_LIVE_PROBE_DOMAIN nicht gesetzt")
	}
	fl, err := Scan(d, Options{})
	if err != nil {
		t.Fatal(err)
	}
	for _, f := range fl {
		t.Logf("%+v", f)
	}
}
