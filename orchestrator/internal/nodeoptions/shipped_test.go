package nodeoptions

import "testing"

// Die ausgelieferte Schema-Datei muss gültig sein: eine einzige fehlerhafte Option schaltet im Orchestrator ALLE Node-Optionen ab
// ("node-options.json ungültig — Optionen deaktiviert").
func TestShippedNodeOptionsFileIsValid(t *testing.T) {
	if _, err := LoadFile("../../../deploy/node-options.json"); err != nil {
		t.Fatal(err)
	}
}
