//go:build ignore

// Registriert N simulierte NMOS-Nodes (je Device, 2 Audio-Sender samt Flow/Source, 2 Receiver) in der Registry und haelt sie per
// Heartbeat am Leben, bis das Programm beendet wird (dann werden sie wieder abgemeldet). Fuer Tests des Registry-Polls.
//
//	go run fakenodes.go -n 250
package main

import (
	"bytes"
	"crypto/rand"
	"encoding/json"
	"flag"
	"fmt"
	"net/http"
	"os"
	"os/signal"
	"sync"
	"syscall"
	"time"
)

var reg = envOr("OMP_REG", "http://localhost:8010") + "/x-nmos/registration/v1.3"

func envOr(k, d string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return d
}

func uuid() string {
	b := make([]byte, 16)
	rand.Read(b)
	b[6] = b[6]&0x0f | 0x40
	b[8] = b[8]&0x3f | 0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:])
}

var cl = &http.Client{Timeout: 20 * time.Second, Transport: &http.Transport{MaxIdleConnsPerHost: 64}}

func post(path string, v any) error {
	b, _ := json.Marshal(v)
	r, err := cl.Post(reg+path, "application/json", bytes.NewReader(b))
	if err != nil {
		return err
	}
	r.Body.Close()
	if r.StatusCode >= 300 {
		return fmt.Errorf("%s: %d", path, r.StatusCode)
	}
	return nil
}

func res(typ string, data map[string]any) error {
	data["version"] = fmt.Sprintf("%d:0", time.Now().Unix())
	data["description"] = ""
	return post("/resource", map[string]any{"type": typ, "data": data})
}

func main() {
	n := flag.Int("n", 100, "Anzahl Nodes")
	flag.Parse()
	ids := make([]string, *n)
	var wg sync.WaitGroup
	sem := make(chan struct{}, 32)
	var failed int
	var fmu sync.Mutex
	for i := 0; i < *n; i++ {
		ids[i] = uuid()
		wg.Add(1)
		sem <- struct{}{}
		go func(i int) {
			defer wg.Done()
			defer func() { <-sem }()
			nid, did := ids[i], uuid()
			label := fmt.Sprintf("loadtest-node-%04d", i)
			errs := []error{}
			errs = append(errs, res("node", map[string]any{"id": nid, "label": label, "href": "http://127.0.0.1:1/", "caps": map[string]any{},
				"api": map[string]any{"versions": []string{"v1.3"}, "endpoints": []any{map[string]any{"host": "127.0.0.1", "port": 1, "protocol": "http"}}},
				"services": []any{}, "clocks": []any{}, "interfaces": []any{map[string]any{"chassis_id": nil, "name": "eth0", "port_id": "00-00-00-00-95-01"}},
				"tags": map[string]any{"urn:x-omp:loadtest": []string{"1"}}}))
			var snd, rcv []string
			srcs, flows, sends, recvs := []map[string]any{}, []map[string]any{}, []map[string]any{}, []map[string]any{}
			for k := 0; k < 2; k++ {
				sid, fid, sndid, rid := uuid(), uuid(), uuid(), uuid()
				snd, rcv = append(snd, sndid), append(rcv, rid)
				srcs = append(srcs, map[string]any{"id": sid, "label": fmt.Sprintf("%s Sender %d", label, k+1), "device_id": did, "format": "urn:x-nmos:format:audio", "clock_name": nil, "parents": []any{}, "tags": map[string]any{}, "caps": map[string]any{}, "channels": []any{map[string]any{"label": "Channel 1"}}})
				flows = append(flows, map[string]any{"id": fid, "label": fmt.Sprintf("%s Sender %d", label, k+1), "device_id": did, "source_id": sid, "format": "urn:x-nmos:format:audio", "media_type": "audio/float32", "bit_depth": 32, "sample_rate": map[string]any{"numerator": 48000, "denominator": 1}, "parents": []any{}, "tags": map[string]any{}})
				sends = append(sends, map[string]any{"id": sndid, "label": fmt.Sprintf("%s Sender %d", label, k+1), "device_id": did, "flow_id": fid, "transport": "urn:x-nmos:transport:mxl", "interface_bindings": []string{"eth0"}, "manifest_href": nil, "subscription": map[string]any{"active": false, "receiver_id": nil}, "tags": map[string]any{}})
				recvs = append(recvs, map[string]any{"id": rid, "label": fmt.Sprintf("%s Receiver %d", label, k+1), "device_id": did, "transport": "urn:x-nmos:transport:mxl", "interface_bindings": []string{"eth0"}, "format": "urn:x-nmos:format:audio", "caps": map[string]any{"media_types": []string{"audio/float32"}}, "subscription": map[string]any{"sender_id": nil, "active": false}, "tags": map[string]any{}})
			}
			errs = append(errs, res("device", map[string]any{"id": did, "label": label + " Device", "node_id": nid, "type": "urn:x-nmos:device:generic", "senders": snd, "receivers": rcv, "controls": []any{}, "tags": map[string]any{}}))
			for _, x := range srcs {
				errs = append(errs, res("source", x))
			}
			for _, x := range flows {
				errs = append(errs, res("flow", x))
			}
			for _, x := range sends {
				errs = append(errs, res("sender", x))
			}
			for _, x := range recvs {
				errs = append(errs, res("receiver", x))
			}
			for _, e := range errs {
				if e != nil {
					fmu.Lock()
					failed++
					if failed < 4 {
						fmt.Println("Fehler:", e)
					}
					fmu.Unlock()
					break
				}
			}
		}(i)
	}
	wg.Wait()
	fmt.Printf("%d Nodes registriert (%d mit Fehlern), Heartbeat laeuft; Strg-C/SIGTERM meldet ab\n", *n, failed)
	stop := make(chan os.Signal, 1)
	signal.Notify(stop, syscall.SIGINT, syscall.SIGTERM)
	tk := time.NewTicker(4 * time.Second)
	for {
		select {
		case <-tk.C:
			for _, id := range ids {
				sem <- struct{}{}
				go func(id string) {
					defer func() { <-sem }()
					post("/health/nodes/"+id, map[string]any{})
				}(id)
			}
		case <-stop:
			for _, id := range ids {
				req, _ := http.NewRequest("DELETE", reg+"/resource/nodes/"+id, nil)
				if r, err := cl.Do(req); err == nil {
					r.Body.Close()
				}
			}
			fmt.Println("abgemeldet")
			return
		}
	}
}
