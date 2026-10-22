// Command serviceconformance prüft, ob ein Node einen Dienstvertrag erfüllt (UMSETZUNG.md Kapitel 49): Manifest gültig,
// Pflichtrollen vorhanden, Antworten in der Form des Vertrags, Dienst-Routen ohne Geheimnis gesperrt, Dienst-Oberfläche
// auslieferbar. Gilt für jede Implementierung — unsere oder die eines anderen Herstellers:
//
//	go run ./cmd/serviceconformance -node http://127.0.0.1:9450 -token <Dienst-Token> [-party 1] [-mutate]
//
// Ausgabe: je Prüfung PASS/FAIL; Exit 1 bei einem Fehler.
package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/infantilo/openmediaplatform/orchestrator/internal/modules/extsvc"
)

type runner struct {
	node, token string
	cli         *http.Client
	fails       int
}

func (r *runner) check(name string, err error) {
	if err != nil {
		r.fails++
		fmt.Printf("FAIL  %s: %v\n", name, err)
		return
	}
	fmt.Printf("PASS  %s\n", name)
}

func (r *runner) do(method, path string, body []byte, withToken bool, features []string) (int, []byte, error) {
	var rd io.Reader
	if body != nil {
		rd = strings.NewReader(string(body))
	}
	req, err := http.NewRequest(method, r.node+path, rd)
	if err != nil {
		return 0, nil, err
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	if withToken {
		req.Header.Set(extsvc.HToken, r.token)
		// Prüf-Identität: kein Nutzer (Bootstrap-Modus) mit allen Rechten des Dienstes = darf jede Sprechstelle sehen/bedienen.
		req.Header.Set(extsvc.HFeatures, strings.Join(features, ","))
		req.Header.Set(extsvc.HNodeBase, r.node)
		req.Header.Set(extsvc.HRequestHost, "localhost")
	}
	resp, err := r.cli.Do(req)
	if err != nil {
		return 0, nil, err
	}
	defer resp.Body.Close()
	b, _ := io.ReadAll(io.LimitReader(resp.Body, 8<<20))
	return resp.StatusCode, b, nil
}

func main() {
	node := flag.String("node", "", "Basis-URL des Nodes (z. B. http://127.0.0.1:9450)")
	token := flag.String("token", os.Getenv("OMP_SERVICE_TOKEN"), "Dienst-Token (Standard: OMP_SERVICE_TOKEN)")
	party := flag.Int("party", 0, "Teilnehmer-ID für die Rollen mit Platzhalter (Standard: erster aus `panels`)")
	mutate := flag.Bool("mutate", false, "auch Rollen prüfen, die etwas verändern (deck.command mit harmlosem Befehl)")
	flag.Parse()
	if *node == "" || *token == "" {
		fmt.Fprintln(os.Stderr, "usage: serviceconformance -node URL -token TOKEN")
		os.Exit(2)
	}
	r := &runner{node: strings.TrimRight(*node, "/"), token: *token, cli: &http.Client{Timeout: 10 * time.Second}}

	code, body, err := r.do("GET", "/service.json", nil, false, nil)
	if err == nil && code != 200 {
		err = fmt.Errorf("HTTP %d", code)
	}
	r.check("Manifest erreichbar (/service.json, ohne Anmeldung)", err)
	if err != nil {
		os.Exit(1)
	}
	var mf extsvc.Manifest
	r.check("Manifest ist JSON", json.Unmarshal(body, &mf))
	r.check("Manifest gültig (Name, Rechte, Routen, Vertrag)", mf.Validate())
	if mf.Kind != "" && extsvc.Contracts[mf.Kind] == nil {
		fmt.Printf("INFO  Typ %q ist kein bekannter Vertrag — nur die allgemeinen Prüfungen laufen\n", mf.Kind)
	}

	// Alle Rechte des Dienstes für die Prüf-Identität.
	var feats []string
	for _, f := range mf.Features {
		feats = append(feats, f.ID)
	}

	// Sicherheit: jede Route ohne Geheimnis gesperrt, mit Geheimnis aber unbekannter Pfad = 404.
	for _, rt := range mf.Routes {
		p := mf.Base + strings.NewReplacer("{id}", "1", "{party}", "1").Replace(rt.Path)
		code, _, err := r.do(rt.Method, p, nil, false, nil)
		if err == nil && code != 401 && code != 403 {
			err = fmt.Errorf("ohne Dienst-Token HTTP %d statt 401/403", code)
		}
		r.check(fmt.Sprintf("gesperrt ohne Token: %s %s", rt.Method, rt.Path), err)
	}
	code, _, err = r.do("GET", mf.Base+"/gibt-es-nicht", nil, true, feats)
	if err == nil && code != 404 {
		err = fmt.Errorf("HTTP %d statt 404", code)
	}
	r.check("unbekannte Route → 404", err)

	// Rollen: Antworten in der Form des Vertrags.
	partyID := *party
	for _, role := range []string{"panels", "status", "deck.state", "deck.command"} {
		var rt *extsvc.RouteDef
		for i := range mf.Routes {
			if mf.Routes[i].Role == role {
				rt = &mf.Routes[i]
			}
		}
		if rt == nil {
			if spec, ok := extsvc.Contracts[mf.Kind][role]; ok && !spec.Required {
				fmt.Printf("SKIP  Rolle %s (optional, nicht angeboten)\n", role)
			}
			continue
		}
		path := mf.Base + rt.Path
		if strings.Contains(path, "{") {
			if partyID == 0 {
				fmt.Printf("SKIP  Rolle %s (kein Teilnehmer bekannt — -party angeben)\n", role)
				continue
			}
			path = strings.NewReplacer("{party}", fmt.Sprint(partyID), "{id}", fmt.Sprint(partyID)).Replace(path)
		}
		if rt.Method != "GET" {
			if !*mutate {
				fmt.Printf("SKIP  Rolle %s (verändert etwas, -mutate)\n", role)
				continue
			}
			code, _, err := r.do(rt.Method, path, []byte(`{"t":"ping"}`), true, feats)
			if err == nil && code/100 != 2 {
				err = fmt.Errorf("HTTP %d", code)
			}
			r.check("Rolle "+role, err)
			continue
		}
		code, body, err := r.do(rt.Method, path, nil, true, feats)
		if err == nil && code != 200 {
			err = fmt.Errorf("HTTP %d: %s", code, strings.TrimSpace(string(body)))
		}
		if err == nil {
			err = extsvc.CheckShape(mf.Kind, role, body)
		}
		r.check("Rolle "+role, err)
		if role == "panels" && err == nil && partyID == 0 {
			var v struct {
				Panels []struct {
					ID int `json:"party_id"`
				} `json:"panels"`
			}
			if json.Unmarshal(body, &v) == nil && len(v.Panels) > 0 {
				partyID = v.Panels[0].ID
			}
		}
	}

	// Oberfläche: relative Bundles müssen unter `<Base>/ui/<Datei>` auslieferbar sein.
	seen := map[string]bool{}
	var bundles []string
	for _, t := range mf.UI {
		bundles = append(bundles, t.Bundle)
	}
	for _, t := range mf.Tiles {
		bundles = append(bundles, t.Bundle)
	}
	for _, b := range bundles {
		if strings.HasPrefix(b, "/") || seen[b] {
			continue
		}
		seen[b] = true
		code, body, err := r.do("GET", mf.Base+"/ui/"+b, nil, true, feats)
		if err == nil && (code != 200 || len(body) == 0) {
			err = fmt.Errorf("HTTP %d, %d Bytes", code, len(body))
		}
		r.check("Oberfläche "+b, err)
	}
	if r.fails > 0 {
		fmt.Printf("\n%d Prüfung(en) fehlgeschlagen\n", r.fails)
		os.Exit(1)
	}
	fmt.Println("\nalle Prüfungen bestanden")
}
