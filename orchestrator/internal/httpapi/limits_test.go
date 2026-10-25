package httpapi

import (
	"bufio"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestLimitRequestsCapsJSONBodyOnly(t *testing.T) {
	var got int64
	var rerr error
	h := LimitRequests(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		n, err := io.Copy(io.Discard, r.Body)
		got, rerr = n, err
		if err != nil {
			http.Error(w, err.Error(), http.StatusRequestEntityTooLarge)
		}
	}))
	big := strings.NewReader(strings.Repeat("x", maxJSONBodyBytes+1024))
	req := httptest.NewRequest("POST", "/", big)
	req.Header.Set("Content-Type", "application/json; charset=utf-8")
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rerr == nil || rec.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("JSON-Body über dem Limit muss scheitern (gelesen %d, err %v, code %d)", got, rerr, rec.Code)
	}
	// Upload (anderer Typ) bleibt unbegrenzt
	req = httptest.NewRequest("POST", "/", strings.NewReader(strings.Repeat("x", maxJSONBodyBytes+1024)))
	req.Header.Set("Content-Type", "application/octet-stream")
	rerr = nil
	h.ServeHTTP(httptest.NewRecorder(), req)
	if rerr != nil {
		t.Fatalf("Nicht-JSON darf nicht begrenzt werden: %v", rerr)
	}
	// kleiner JSON-Body geht durch
	req = httptest.NewRequest("POST", "/", strings.NewReader(`{"a":1}`))
	req.Header.Set("Content-Type", "application/json")
	rec = httptest.NewRecorder()
	rerr = nil
	h.ServeHTTP(rec, req)
	if rerr != nil || rec.Code != 200 {
		t.Fatalf("kleiner Body: %v %d", rerr, rec.Code)
	}
}

// Slowloris: ein Client, der den Kopf nicht fertig sendet, wird getrennt; ein normaler Request davor/danach funktioniert,
// auch über dieselbe Verbindung (Keep-Alive, das Lese-Limit des JSON-Bodys darf die nächste Anfrage nicht treffen).
func TestServerHeaderTimeoutAndKeepAliveAfterJSON(t *testing.T) {
	srv := httptest.NewUnstartedServer(LimitRequests(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.Copy(io.Discard, r.Body)
		_, _ = w.Write([]byte("ok"))
	})))
	ConfigureServer(srv.Config)
	srv.Config.ReadHeaderTimeout = 300 * time.Millisecond
	srv.Start()
	defer srv.Close()

	c, err := net.Dial("tcp", srv.Listener.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	_, _ = c.Write([]byte("GET / HTTP/1.1\r\nHost: x\r\nX-Slow: "))
	_ = c.SetReadDeadline(time.Now().Add(3 * time.Second))
	if _, err := bufio.NewReader(c).ReadByte(); err == nil {
		t.Fatal("unvollständiger Kopf: Verbindung muss ohne Antwort geschlossen werden")
	} else if ne, ok := err.(net.Error); ok && ne.Timeout() {
		t.Fatal("Server hat die Verbindung nicht getrennt (ReadHeaderTimeout wirkt nicht)")
	}

	c2, err := net.Dial("tcp", srv.Listener.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	defer c2.Close()
	br := bufio.NewReader(c2)
	for i := 0; i < 2; i++ {
		_, _ = c2.Write([]byte("POST / HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nContent-Length: 2\r\n\r\n{}"))
		_ = c2.SetReadDeadline(time.Now().Add(2 * time.Second))
		resp, err := http.ReadResponse(br, nil)
		if err != nil {
			t.Fatalf("Anfrage %d über dieselbe Verbindung: %v", i+1, err)
		}
		_, _ = io.Copy(io.Discard, resp.Body)
		resp.Body.Close()
		if resp.StatusCode != 200 {
			t.Fatalf("Status %d", resp.StatusCode)
		}
	}
}

func TestRequireMetricsToken(t *testing.T) {
	ok := func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(200) }
	do := func(h http.HandlerFunc, auth string) int {
		r := httptest.NewRequest("GET", "/metrics", nil)
		if auth != "" {
			r.Header.Set("Authorization", auth)
		}
		rec := httptest.NewRecorder()
		h(rec, r)
		return rec.Code
	}
	if do(requireMetricsToken("", ok), "") != 200 {
		t.Error("ohne Token offen (bisheriges Verhalten)")
	}
	g := requireMetricsToken("s3cret", ok)
	if do(g, "") != 401 || do(g, "Bearer falsch") != 401 || do(g, "s3cret") != 401 {
		t.Error("ohne/mit falschem Token abgewiesen")
	}
	if do(g, "Bearer s3cret") != 200 {
		t.Error("richtiges Token")
	}
}
