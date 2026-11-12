//go:build ignore

// Schneller Lastgenerator (Go) fuer den Orchestrator: der Python-Generator (run.py/media.py) ist ab ~100 Clients selbst der
// Engpass (GIL). Liest .state.json (setup.py) und optional .media.json (media.py setup).
//
//	go run gen.go -d 15 -n 100 -tiles 4 [-think 300ms]
package main

import (
	"bufio"
	"bytes"
	"encoding/json"
	"flag"
	"fmt"
	"math/rand"
	"net/http"
	"os"
	"sort"
	"strings"
	"sync"
	"time"
)

var base = envOr("OMP_URL", "http://localhost:8000")

func envOr(k, d string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return d
}

func login(u, p string) string {
	b, _ := json.Marshal(map[string]string{"username": u, "password": p})
	r, err := http.Post(base+"/api/v1/auth/login", "application/json", bytes.NewReader(b))
	if err != nil {
		panic(err)
	}
	defer r.Body.Close()
	var o struct{ Token string }
	json.NewDecoder(r.Body).Decode(&o)
	o.Token = strings.TrimSpace(o.Token)
	return o.Token
}

type stat struct {
	mu   sync.Mutex
	lat  []time.Duration
	errs map[string]int
}

func (s *stat) add(d time.Duration, err string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if err != "" {
		if s.errs == nil {
			s.errs = map[string]int{}
		}
		s.errs[err]++
		return
	}
	s.lat = append(s.lat, d)
}

func main() {
	dur := flag.Duration("d", 15*time.Second, "Dauer")
	n := flag.Int("n", 100, "Clients (Bediener + SSE)")
	tiles := flag.Int("tiles", 4, "Vorschau-Kacheln je Client (0 = aus)")
	think := flag.Duration("think", 300*time.Millisecond, "Denkpause der Bediener")
	flag.Parse()
	var st, md map[string]string
	b, _ := os.ReadFile(".state.json")
	json.Unmarshal(b, &st)
	b, _ = os.ReadFile(".media.json")
	json.Unmarshal(b, &md)
	adm := login("admin", envOr("OMP_ADMIN_PASSWORD", "adminpass123"))
	op := login("claude-loadtest", "loadtest-pw-123")
	tr := &http.Transport{MaxIdleConnsPerHost: 2000, MaxConnsPerHost: 0}
	cl := &http.Client{Transport: tr, Timeout: 30 * time.Second}
	stop := time.Now().Add(*dur)
	stats := map[string]*stat{}
	var smu sync.Mutex
	get := func(k string) *stat {
		smu.Lock()
		defer smu.Unlock()
		if stats[k] == nil {
			stats[k] = &stat{}
		}
		return stats[k]
	}
	do := func(name, method, path, tok string, body []byte) {
		t := time.Now()
		req, _ := http.NewRequest(method, base+"/api/v1"+path, bytes.NewReader(body))
		req.Header.Set("Authorization", "Bearer "+tok)
		req.Header.Set("Content-Type", "application/json")
		r, err := cl.Do(req)
		if err != nil {
			get(name).add(0, "net")
			return
		}
		bufio.NewReader(r.Body).WriteTo(discard{})
		r.Body.Close()
		if r.StatusCode != 200 {
			get(name).add(0, fmt.Sprint(r.StatusCode))
			return
		}
		get(name).add(time.Since(t), "")
	}
	var wg sync.WaitGroup
	loop := func(name, method, path, tok string, body []byte, pause time.Duration) {
		defer wg.Done()
		time.Sleep(time.Duration(rand.Int63n(int64(pause + 1))))
		for time.Now().Before(stop) {
			t := time.Now()
			do(name, method, path, tok, body)
			if w := pause - time.Since(t); w > 0 {
				time.Sleep(w)
			}
		}
	}
	patch, _ := json.Marshal(map[string]string{"value": "smpte"})
	sseEv := new(int64)
	var sseMu sync.Mutex
	for i := 0; i < *n; i++ {
		if st["node"] != "" {
			wg.Add(1)
			go loop("PATCH param (Bediener)", "PATCH", "/nodes/"+st["node"]+"/params/pattern", op, patch, *think)
		}
		wg.Add(1)
		go func() { // SSE
			defer wg.Done()
			req, _ := http.NewRequest("GET", base+"/api/v1/events?access_token="+adm, nil)
			r, err := (&http.Client{Transport: tr}).Do(req)
			if err != nil {
				return
			}
			go func() { time.Sleep(time.Until(stop)); r.Body.Close() }()
			sc := bufio.NewScanner(r.Body)
			sc.Buffer(make([]byte, 1<<20), 1<<20)
			for sc.Scan() {
				if strings.HasPrefix(sc.Text(), "data:") {
					sseMu.Lock()
					*sseEv++
					sseMu.Unlock()
				}
			}
		}()
		if i%5 == 0 {
			wg.Add(3)
			go loop("GET /workflows", "GET", "/workflows", adm, nil, 200*time.Millisecond)
			go loop("GET /nodes", "GET", "/nodes", adm, nil, 200*time.Millisecond)
			go loop("GET /me/consoles", "GET", "/me/consoles", op, nil, 200*time.Millisecond)
		}
		for t := 0; t < *tiles && md["viewer"] != ""; t++ {
			wg.Add(1)
			go loop("Vorschau-Kachel", "GET", "/nodes/"+md["viewer"]+"/stream/previewUrl", adm, nil, 500*time.Millisecond)
		}
	}
	t0 := time.Now()
	wg.Wait()
	el := time.Since(t0).Seconds()
	fmt.Printf("%d Clients, %.0fs, SSE-Events %d\n", *n, el, *sseEv)
	names := []string{}
	for k := range stats {
		names = append(names, k)
	}
	sort.Strings(names)
	tot := 0
	for _, k := range names {
		s := stats[k]
		sort.Slice(s.lat, func(i, j int) bool { return s.lat[i] < s.lat[j] })
		l := len(s.lat)
		tot += l
		if l == 0 {
			fmt.Printf("%-24s keine Antworten %v\n", k, s.errs)
			continue
		}
		fmt.Printf("%-24s n=%6d rps=%6.1f p50=%7.1fms p95=%7.1fms max=%7.1fms fehler=%v\n", k, l, float64(l)/el, ms(s.lat[l/2]), ms(s.lat[l*95/100]), ms(s.lat[l-1]), s.errs)
	}
	fmt.Printf("gesamt-rps %.0f\n", float64(tot)/el)
}

type discard struct{}

func (discard) Write(p []byte) (int, error) { return len(p), nil }
func ms(d time.Duration) float64             { return float64(d) / 1e6 }
