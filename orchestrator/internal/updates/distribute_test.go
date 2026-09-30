package updates

import (
	"encoding/json"
	"errors"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestDownloadsTokenScopedToPackageAndExpires(t *testing.T) {
	d := NewDownloads()
	tok := d.Issue("pkg-a")
	if !d.Check("pkg-a", tok) {
		t.Error("valid token rejected")
	}
	if d.Check("pkg-b", tok) {
		t.Error("token must only be valid for its own package")
	}
	if d.Check("pkg-a", "x"+tok[1:]) || d.Check("pkg-a", "") {
		t.Error("wrong/empty token accepted")
	}
	// abgelaufen
	d.mu.Lock()
	d.tokens[tok] = dlToken{id: "pkg-a", expires: time.Now().Add(-time.Second)}
	d.mu.Unlock()
	if d.Check("pkg-a", tok) {
		t.Error("expired token accepted")
	}
}

func waitDone(t *testing.T, d *Distributor) *Distribution {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		if l := d.Last(); l != nil && !l.Running {
			return l
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatal("distribution did not finish")
	return nil
}

func TestDistributorReportsPerHost(t *testing.T) {
	var mu sync.Mutex
	var subjects []string
	var lastPayload map[string]string
	d := &Distributor{
		Downloads: NewDownloads(),
		Hosts: func() ([]HostRef, error) {
			return []HostRef{{"h1", "Alpha"}, {"h2", "Beta"}, {"h3", "Gamma"}, {"h4", "Delta"}}, nil
		},
		Online: func(id string) bool { return id != "h3" },
		Request: func(subject string, data []byte, _ time.Duration) ([]byte, error) {
			mu.Lock()
			defer mu.Unlock()
			subjects = append(subjects, subject)
			_ = json.Unmarshal(data, &lastPayload)
			switch subject {
			case "omp.host.h2.cmd":
				return []byte(`{"ok":false,"error":"paket ungültig"}`), nil
			case "omp.host.h4.cmd":
				return nil, errors.New("timeout")
			}
			return []byte(`{"ok":true,"detail":"ersetzt omp-source"}`), nil
		},
	}
	e := Entry{ID: "2026.10.0-abc123abc123", Version: "2026.10.0", SHA256: strings.Repeat("a", 64)}
	if _, err := d.Start(e); err != nil {
		t.Fatal(err)
	}
	if _, err := d.Start(e); !errors.Is(err, ErrBusy) {
		t.Errorf("second Start while running: err = %v, want ErrBusy", err)
	}
	res := waitDone(t, d)

	byLabel := map[string]HostResult{}
	for _, h := range res.Hosts {
		byLabel[h.Label] = h
	}
	if byLabel["Alpha"].State != "ok" || byLabel["Alpha"].Detail != "ersetzt omp-source" {
		t.Errorf("Alpha = %+v", byLabel["Alpha"])
	}
	if byLabel["Beta"].State != "failed" || byLabel["Beta"].Detail != "paket ungültig" {
		t.Errorf("Beta = %+v", byLabel["Beta"])
	}
	if byLabel["Gamma"].State != "offline" {
		t.Errorf("Gamma = %+v (offline hosts must not be contacted)", byLabel["Gamma"])
	}
	if byLabel["Delta"].State != "failed" || !strings.Contains(byLabel["Delta"].Detail, "timeout") {
		t.Errorf("Delta = %+v", byLabel["Delta"])
	}
	for _, s := range subjects {
		if s == "omp.host.h3.cmd" {
			t.Error("offline host was contacted")
		}
	}
	// Payload: relativer Pfad mit Token, nie eine volle URL.
	path := lastPayload["updatePath"]
	if !strings.HasPrefix(path, "/api/v1/host-updates/"+e.ID+"?token=") {
		t.Errorf("updatePath = %q", path)
	}
	tok := strings.TrimPrefix(path, "/api/v1/host-updates/"+e.ID+"?token=")
	if !d.CheckToken(e.ID, tok) {
		t.Error("issued token must be accepted by CheckToken")
	}
	if lastPayload["updateSha256"] != e.SHA256 || lastPayload["action"] != "update" {
		t.Errorf("payload = %v", lastPayload)
	}
	// Nach dem Ende ist eine neue Verteilung wieder möglich.
	if _, err := d.Start(e); err != nil {
		t.Errorf("Start after finish: %v", err)
	}
	waitDone(t, d)
}
