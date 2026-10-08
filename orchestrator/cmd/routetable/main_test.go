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
	got, err := collect("../../internal/httpapi")
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
