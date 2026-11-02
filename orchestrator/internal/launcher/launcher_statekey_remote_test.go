package launcher

import (
	"encoding/json"
	"strings"
	"testing"
	"time"
)

// oldAgentRequester verhält sich wie ein Host-Agent vor Kap. 81: lehnt OMP_STATE_KEY ab.
type oldAgentRequester struct{ payloads [][]byte }

func (o *oldAgentRequester) RequestBytes(_ string, data []byte, _ time.Duration) ([]byte, error) {
	o.payloads = append(o.payloads, data)
	if strings.Contains(string(data), StateKeyEnv) {
		return json.Marshal(remoteResponse{OK: false, Error: `extraEnv key "OMP_STATE_KEY" not allowed`})
	}
	return json.Marshal(remoteResponse{OK: true, PID: 99})
}

func TestRemoteStartFallsBackForAgentWithoutStateKey(t *testing.T) {
	fake := &oldAgentRequester{}
	l := newWithStore(sleepyCatalog(), "http://registry", "nats://nats", newFakeInstanceStore(), nil, fake, nil)

	inst, err := l.Start("sleepy", "", "host-1", nil)
	if err != nil {
		t.Fatalf("Start() mit altem Agent: %v", err)
	}
	if len(fake.payloads) != 2 {
		t.Fatalf("erwartet 2 Anfragen (mit, dann ohne Schlüssel), waren %d", len(fake.payloads))
	}
	if strings.Contains(string(fake.payloads[1]), StateKeyEnv) {
		t.Fatalf("Wiederholung enthält den Schlüssel noch: %s", fake.payloads[1])
	}
	// Die Instanz merkt sich den Schlüssel trotzdem (für Neustarts, sobald der Agent aktualisiert ist).
	if inst.ExtraEnv[StateKeyEnv] == "" {
		t.Fatalf("Instanz hat keinen Zustandsschlüssel: %v", inst.ExtraEnv)
	}
}
