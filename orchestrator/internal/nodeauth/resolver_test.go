package nodeauth

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestHostResolver(t *testing.T) {
	secret := []byte("geheim")
	a, b, local := DeriveHost(secret, "a"), DeriveHost(secret, "b"), DeriveHost(secret, "")
	if a == b || a == local || a == Derive(secret) || DerivePeer(secret) == Derive(secret) {
		t.Fatal("Token müssen sich unterscheiden")
	}
	r := HostResolver(secret, func() []Target {
		return []Target{{"http://10.0.0.1:4000", "a"}, {"http://10.0.0.2:4000", "b"}, {"http://127.0.0.1:5000", ""}, {"http://127.0.0.1:5001", "a"}, {"http://[fd00::1]:4000", "b"}}
	})
	for hostport, want := range map[string]string{
		"10.0.0.1:4000": a, "10.0.0.2:4000": b, "127.0.0.1:5000": local, "127.0.0.1:5001": a,
		"10.0.0.2:9999": b, "[fd00::1]:8443": b, // Zusatzport: Rechnername eindeutig
		"127.0.0.1:9999": "", "10.0.0.9:4000": "", // mehrdeutig bzw. unbekannt
	} {
		if got := r(hostport); got != want {
			t.Errorf("%s: falsches Token", hostport)
		}
	}
}

func TestTransportUsesResolverWithFallback(t *testing.T) {
	var got string
	srv := httptest.NewServer(http.HandlerFunc(func(_ http.ResponseWriter, r *http.Request) { got = r.Header.Get(Header) }))
	defer srv.Close()
	SetToken("plattform")
	defer func() { SetToken(""); SetResolver(nil) }()
	client := &http.Client{Transport: Wrap(nil)}
	for _, c := range []struct{ resolved, want string }{{"je-host", "je-host"}, {"", "plattform"}} {
		SetResolver(func(string) string { return c.resolved })
		resp, err := client.Get(srv.URL)
		if err != nil {
			t.Fatal(err)
		}
		resp.Body.Close()
		if got != c.want {
			t.Errorf("Header = %q, want %q", got, c.want)
		}
	}
}

func TestAttachOnlyForSameHost(t *testing.T) {
	SetToken("plattform")
	SetResolver(func(h string) string { return "token-" + h })
	defer func() { SetToken(""); SetResolver(nil) }()
	same, _ := http.NewRequest(http.MethodGet, "http://127.0.0.1:9100/stream", nil)
	Attach(same, "http://127.0.0.1:4000")
	if got := same.Header.Get(Header); got != "token-127.0.0.1:4000" {
		t.Errorf("same host: %q", got)
	}
	other, _ := http.NewRequest(http.MethodGet, "http://10.0.0.9:9100/stream", nil)
	Attach(other, "http://127.0.0.1:4000")
	if got := other.Header.Get(Header); got != "" {
		t.Errorf("other host: %q", got)
	}
}
