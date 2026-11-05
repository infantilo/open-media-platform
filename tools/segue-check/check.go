// Package main: Konformitätsprüfung für den Vertrag „Segue-Player“ (docs/CONTRACT-SEGUE-PLAYER.md, Kapitel 89/RB2).
// Prüft einen laufenden Node gegen den Vertrag: (1) Aufbau (Methoden, Argumente, Parameter im Descriptor), (2) Verhalten
// (Idempotenz der voiceId, Ablehnung ungültiger Eingaben, Zustandsfolge einer Stimme, `stop` vor dem Ende des Ladens).
// Kein Wissen über einen bestimmten Hersteller: nur der Vertrag.
package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

// Result ist ein einzelnes Prüfergebnis.
type Result struct {
	Name string
	OK   bool
	Info string
}

type client struct {
	base, token string
	http        *http.Client
}

func (c *client) do(method, path string, body any) (int, []byte, error) {
	var rd io.Reader
	if body != nil {
		b, _ := json.Marshal(body)
		rd = bytes.NewReader(b)
	}
	req, err := http.NewRequest(method, strings.TrimRight(c.base, "/")+path, rd)
	if err != nil {
		return 0, nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	if c.token != "" {
		req.Header.Set("X-OMP-Node-Token", c.token)
	}
	resp, err := c.http.Do(req)
	if err != nil {
		return 0, nil, err
	}
	defer resp.Body.Close()
	b, _ := io.ReadAll(resp.Body)
	return resp.StatusCode, b, nil
}

func (c *client) param(name string) (json.RawMessage, error) {
	code, b, err := c.do("GET", "/params/"+name, nil)
	if err != nil {
		return nil, err
	}
	if code != 200 {
		return nil, fmt.Errorf("GET /params/%s: %d", name, code)
	}
	var v struct {
		Value json.RawMessage `json:"value"`
	}
	if err := json.Unmarshal(b, &v); err != nil {
		return nil, err
	}
	return v.Value, nil
}

type voice struct {
	VoiceID string `json:"voiceId"`
	State   string `json:"state"`
	Error   string `json:"error"`
}

func (c *client) voices() ([]voice, error) {
	raw, err := c.param("voices")
	if err != nil {
		return nil, err
	}
	var vs []voice
	if err := json.Unmarshal(raw, &vs); err != nil {
		return nil, fmt.Errorf("voices ist kein Array von Stimmen: %w", err)
	}
	return vs, nil
}

func (c *client) find(id string) (voice, bool) {
	vs, err := c.voices()
	if err != nil {
		return voice{}, false
	}
	for _, v := range vs {
		if v.VoiceID == id {
			return v, true
		}
	}
	return voice{}, false
}

var requiredMethods = map[string][]string{
	"play":    {"voiceId", "file", "startAt", "gainDb", "offsetMs", "fadeInMs", "fadeInCurve", "stopAtMs", "fadeOutMs", "fadeOutCurve"},
	"stop":    {"voiceId", "fadeMs", "curve", "atTai"},
	"fade":    {"voiceId", "gainDb", "ms", "curve", "atTai"},
	"stopAll": {"fadeMs"},
}

var requiredParams = []string{"voices", "voiceCount", "maxVoices", "taiNowNs", "outputLevelDb"}

// Structure prüft den Descriptor.
func Structure(c *client) []Result {
	code, b, err := c.do("GET", "/descriptor.json", nil)
	if err != nil || code != 200 {
		return []Result{{"Descriptor lesbar", false, fmt.Sprintf("GET /descriptor.json: %v %d", err, code)}}
	}
	var d struct {
		Parameters []struct{ Name string } `json:"parameters"`
		Methods    []struct {
			Name string
			Args []struct{ Name string }
		} `json:"methods"`
	}
	if err := json.Unmarshal(b, &d); err != nil {
		return []Result{{"Descriptor lesbar", false, err.Error()}}
	}
	out := []Result{{"Descriptor lesbar", true, ""}}
	have := map[string]map[string]bool{}
	for _, m := range d.Methods {
		have[m.Name] = map[string]bool{}
		for _, a := range m.Args {
			have[m.Name][a.Name] = true
		}
	}
	for name, args := range requiredMethods {
		got, ok := have[name]
		if !ok {
			out = append(out, Result{"Methode " + name, false, "fehlt"})
			continue
		}
		var missing []string
		for _, a := range args {
			if !got[a] {
				missing = append(missing, a)
			}
		}
		out = append(out, Result{"Methode " + name, len(missing) == 0, "fehlende Argumente: " + strings.Join(missing, ", ")})
	}
	params := map[string]bool{}
	for _, p := range d.Parameters {
		params[p.Name] = true
	}
	for _, p := range requiredParams {
		out = append(out, Result{"Parameter " + p, params[p], ""})
	}
	return out
}

func (c *client) call(method string, body map[string]any) int {
	code, _, err := c.do("POST", "/methods/"+method, body)
	if err != nil {
		return -1
	}
	return code
}

// Behaviour prüft das Verhalten mit einer echten Datei (`file`). Dauer: wenige Sekunden.
func Behaviour(c *client, file string) []Result {
	var out []Result
	add := func(name string, ok bool, info string) { out = append(out, Result{name, ok, info}) }
	raw, err := c.param("taiNowNs")
	if err != nil {
		return []Result{{"taiNowNs lesbar", false, err.Error()}}
	}
	var tai float64
	_ = json.Unmarshal(raw, &tai)
	add("taiNowNs liefert eine Zeit", tai > 1e18, fmt.Sprintf("%.0f", tai))
	id := fmt.Sprintf("chk%d", time.Now().UnixMilli()%1_000_000)
	start := int64(tai) + 2_000_000_000
	if code := c.call("play", map[string]any{"voiceId": id, "file": file, "startAt": start}); code != 200 {
		add("play wird angenommen", false, fmt.Sprintf("HTTP %d", code))
		return out
	}
	add("play wird angenommen", true, "")
	before, _ := c.voices()
	if code := c.call("play", map[string]any{"voiceId": id, "file": file, "startAt": start}); code != 200 {
		add("Wiederholung mit gleicher voiceId wird still angenommen", false, fmt.Sprintf("HTTP %d", code))
	} else {
		after, _ := c.voices()
		n := 0
		for _, v := range after {
			if v.VoiceID == id {
				n++
			}
		}
		add("Idempotenz: keine zweite Stimme", n == 1 && len(after) == len(before), fmt.Sprintf("%d Stimme(n) mit dieser ID", n))
	}
	var st voice
	deadline := time.Now().Add(6 * time.Second)
	for time.Now().Before(deadline) {
		st, _ = c.find(id)
		if st.State == "scheduled" || st.State == "playing" || st.State == "error" {
			break
		}
		time.Sleep(100 * time.Millisecond)
	}
	add("Zustand wird scheduled/playing", st.State == "scheduled" || st.State == "playing", "state="+st.State+" "+st.Error)
	if code := c.call("stop", map[string]any{"voiceId": id, "fadeMs": 200}); code != 200 {
		add("stop auf eine geplante Stimme", false, fmt.Sprintf("HTTP %d", code))
	} else {
		ended := false
		for i := 0; i < 80 && !ended; i++ {
			v, _ := c.find(id)
			ended = v.State == "ended"
			time.Sleep(100 * time.Millisecond)
		}
		add("gestoppte Stimme endet", ended, "")
	}
	// Eingaben, die der Vertrag ablehnt
	if code := c.call("play", map[string]any{"voiceId": "ungültig mit Leerzeichen", "file": file}); code < 400 || code >= 500 {
		add("ungültige voiceId wird abgelehnt (4xx)", false, fmt.Sprintf("HTTP %d", code))
	} else {
		add("ungültige voiceId wird abgelehnt (4xx)", true, "")
	}
	if code := c.call("stop", map[string]any{"voiceId": "gibt-es-nicht"}); code < 400 || code >= 500 {
		add("stop einer unbekannten Stimme wird abgelehnt (4xx)", false, fmt.Sprintf("HTTP %d", code))
	} else {
		add("stop einer unbekannten Stimme wird abgelehnt (4xx)", true, "")
	}
	if code := c.call("play", map[string]any{"voiceId": id + "x", "file": "/gibt/es/nicht.wav"}); code >= 400 && code < 500 {
		add("fehlende Datei wird abgelehnt oder als error gemeldet", true, "")
	} else {
		time.Sleep(1500 * time.Millisecond)
		v, _ := c.find(id + "x")
		add("fehlende Datei wird abgelehnt oder als error gemeldet", v.State == "error", "state="+v.State)
	}
	return out
}
