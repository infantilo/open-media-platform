package main

import (
	"encoding/json"
	"os"
	"testing"
)

// TestRouteTableMatchesGolden hält die Routentabelle des Orchestrators (Methode, Pfad, Rechtepflicht, Bedingung,
// Domäne) fest. Beim Umzug von Funktionen in Module (UMSETZUNG.md Kapitel 36) darf sich nichts ändern; eine
// ABSICHTLICHE neue/geänderte Route aktualisiert die Datei mit
//
//	go run ./cmd/routetable -strip-source > cmd/routetable/testdata/routes.golden.json
func TestRouteTableMatchesGolden(t *testing.T) {
	got, err := collect("../../internal/httpapi,../../internal/modules")
	if err != nil {
		t.Fatal(err)
	}
	raw, err := os.ReadFile("testdata/routes.golden.json")
	if err != nil {
		t.Fatal(err)
	}
	var want []Route
	if err := json.Unmarshal(raw, &want); err != nil {
		t.Fatal(err)
	}
	have := map[string]int{}
	for _, r := range got {
		have[key(r)]++
	}
	for _, r := range want {
		if have[key(r)] == 0 {
			t.Errorf("Route fehlt: %s %s [%s] %s", r.Method, r.Path, r.Auth, r.When)
		}
		have[key(r)]--
	}
	for _, r := range got {
		if have[key(r)] > 0 {
			t.Errorf("Route neu/geändert: %s %s [%s] %s", r.Method, r.Path, r.Auth, r.When)
			have[key(r)]--
		}
	}
}

func TestDomainAssignment(t *testing.T) {
	for path, want := range map[string]string{
		"/api/v1/playout/channels/{id}/state": "playout", "/api/v1/audio-rules": "audio-rules", "/api/v1/cloud/hosts": "cloud",
		"/api/v1/workflows": "core", "/api/v1/nodes/{id}/params": "core",
	} {
		if got := domainOf(path); got != want {
			t.Errorf("%s: %s, want %s", path, got, want)
		}
	}
}

// Modulrouten werden erkannt (Fixture), samt Rechtepflicht und Domäne.
func TestModuleRoutesAreRecognised(t *testing.T) {
	got, err := collect("testdata/fixture")
	if err != nil {
		t.Fatal(err)
	}
	want := map[string]string{
		"GET /api/v1/cloud/hosts":          "auth|module:cloud",
		"POST /api/v1/cloud/reservations":  "verb:Admin|module:cloud",
		"GET /api/v1/audio-rules/default":  "none|module:audio-rules",
		"POST /api/v1/playout/x/{id}/call": "node-verb:Operate|module:playout",
	}
	seen := map[string]bool{}
	for _, r := range got {
		k := r.Method + " " + r.Path
		if w, ok := want[k]; ok {
			if r.Auth+"|"+r.When != w {
				t.Errorf("%s: %s|%s, want %s", k, r.Auth, r.When, w)
			}
			seen[k] = true
		}
	}
	for k := range want {
		if !seen[k] {
			t.Errorf("Modulroute nicht erkannt: %s", k)
		}
	}
	if len(got) != len(want) {
		t.Errorf("%d Routen, want %d (nur module.*-Aufrufe zählen): %+v", len(got), len(want), got)
	}
}
