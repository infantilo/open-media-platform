package nodeauth

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestDeriveStableAndSecretBound(t *testing.T) {
	a, b := Derive([]byte("s1")), Derive([]byte("s1"))
	if a == "" || a != b || a == Derive([]byte("s2")) || Derive(nil) != "" {
		t.Fatalf("derive: %q %q", a, b)
	}
}

func TestValid(t *testing.T) {
	if !Valid("x", "x") || Valid("x", "y") || Valid("", "") || Valid("x", "") {
		t.Fatal("Valid")
	}
}

func TestInternalHost(t *testing.T) {
	for h, want := range map[string]bool{
		"127.0.0.1": true, "::1": true, "10.1.2.3": true, "192.168.0.5": true, "169.254.1.1": true, "host-a": true, "box.local": true,
		"8.8.8.8": false, "sqs.eu-west-1.amazonaws.com": false, "example.com": false, "": false,
	} {
		if got := internalHost(h); got != want {
			t.Errorf("%q: got %v want %v", h, got, want)
		}
	}
}

func TestWrapAddsTokenOnlyToInternal(t *testing.T) {
	var got string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { got = r.Header.Get(Header) }))
	defer srv.Close()
	c := &http.Client{Transport: Wrap(http.DefaultTransport)}
	SetToken("")
	if _, err := c.Get(srv.URL); err != nil || got != "" {
		t.Fatalf("no token set: %v %q", err, got)
	}
	SetToken("tok")
	defer SetToken("")
	if _, err := c.Get(srv.URL); err != nil || got != "tok" {
		t.Fatalf("internal: %v %q", err, got)
	}
}

func TestExtraHosts(t *testing.T) {
	defer SetExtraHosts(nil)
	if internalHost("n1.example.org") {
		t.Fatal("public name must not be trusted by default")
	}
	SetExtraHosts([]string{".example.org", "gw.example.com"})
	if !internalHost("n1.example.org") || !internalHost("gw.example.com") || internalHost("evil.example.com") {
		t.Fatal("extra hosts")
	}
}
