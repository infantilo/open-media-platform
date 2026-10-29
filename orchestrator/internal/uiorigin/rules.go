package uiorigin

import "strings"

// Rule erlaubt einer isolierten Oberfläche einen Aufruf außerhalb ihres eigenen Nodes: Methode und Pfadmuster ("*" = ein Segment, "**" am Ende = beliebig viele).
// Die Regeln je Node-Typ stehen hier im Orchestrator (vertrauenswürdig) — nie aus dem Manifest oder der Antwort des Nodes. Die Rechte des Nutzers gelten zusätzlich weiter.
type Rule struct{ Method, Pattern string }

func (r Rule) match(method, path string) bool {
	if r.Method != "*" && !strings.EqualFold(r.Method, method) {
		return false
	}
	want := strings.Split(strings.Trim(r.Pattern, "/"), "/")
	got := strings.Split(strings.Trim(path, "/"), "/")
	for i, w := range want {
		if w == "**" && i == len(want)-1 {
			return len(got) >= i
		}
		if i >= len(got) {
			return false
		}
		if w != "*" && w != got[i] {
			return false
		}
	}
	return len(got) == len(want)
}

func anyRule(rules []Rule, method, path string) bool {
	for _, r := range rules {
		if r.match(method, path) {
			return true
		}
	}
	return false
}

// DefaultRules: was die Oberfläche des jeweiligen Node-Typs außerhalb ihres Nodes aufruft (aus dem Bundle-Quelltext ermittelt, im Browser geprüft).
var DefaultRules = map[string][]Rule{
	"omp-switcher": {
		{"GET", "/api/v1/graph"}, {"GET", "/api/v1/workflows"}, {"GET", "/api/v1/layouts/*"},
	},
	"omp-video-mixer-me": {
		{"GET", "/api/v1/graph"}, {"GET", "/api/v1/workflows"}, {"GET", "/api/v1/snapshots"}, {"POST", "/api/v1/snapshots"},
		{"POST", "/api/v1/snapshots/*/apply"}, {"POST", "/api/v1/workflows/*/roles/*/restart"},
	},
	"omp-audio-mixer":            {{"GET", "/api/v1/audio-rules"}, {"GET", "/api/v1/nodes"}},
	"omp-audio-monitor":          sourceSelectorRules,
	"omp-subtitle-asr":           sourceSelectorRules,
	"omp-multiviewer-custom":     sourceSelectorRules,
	"omp-playout-automation":     {{"GET", "/api/v1/nodes"}, {"GET", "/api/v1/sources"}},
	"omp-vfa":                    {{"GET", "/api/v1/nodes"}},
	"omp-webrtc-gateway-camera":  webrtcRules,
	"omp-webrtc-gateway-monitor": webrtcRules,
}

// webrtcRules: die Kamera-/Monitor-Oberfläche koppelt den Intercom-Dienst (Verträge über /api/v1/ext, Funktionsrechte des Nutzers gelten).
var webrtcRules = []Rule{{"GET", "/api/v1/nodes"}, {"GET", "/api/v1/instances"}, {"GET", "/api/v1/ext"}, {"*", "/api/v1/ext/**"}}

// sourceSelectorRules: das Kit-Element <omp-source-selector> baut seinen Quellkatalog aus Graph und Workflows (ui/kit/source-catalog.ts).
var sourceSelectorRules = []Rule{{"GET", "/api/v1/graph"}, {"GET", "/api/v1/workflows"}}
