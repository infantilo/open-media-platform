package workflows

import (
	"context"
	"encoding/json"
	"sort"
)

// driftVolatileKeys: reine Messwerte/Zeitangaben im /state, die sich ständig ändern und keine Bedienung sind.
var driftVolatileKeys = map[string]bool{
	"level": true, "levels": true, "peak": true, "peakDb": true, "rms": true, "meters": true, "meter": true,
	"timestamp": true, "time": true, "now": true, "uptime": true, "lastUpdate": true, "updatedAt": true,
	"heartbeat": true, "fps": true, "currentFps": true, "tc": true, "timecode": true, "position": true,
	"connectionStatus": true,
}

func stripVolatile(v interface{}) interface{} {
	switch x := v.(type) {
	case map[string]interface{}:
		out := make(map[string]interface{}, len(x))
		for k, e := range x {
			if !driftVolatileKeys[k] {
				out[k] = stripVolatile(e)
			}
		}
		return out
	case []interface{}:
		out := make([]interface{}, len(x))
		for i, e := range x {
			out[i] = stripVolatile(e)
		}
		return out
	}
	return v
}

// sameOperatingState vergleicht zwei /state-Dokumente ohne flüchtige Messwerte.
func sameOperatingState(a, b json.RawMessage) bool {
	var av, bv interface{}
	if json.Unmarshal(a, &av) != nil || json.Unmarshal(b, &bv) != nil {
		return false
	}
	return stateMatches(mustMarshal(stripVolatile(av)), mustMarshal(stripVolatile(bv)))
}

func mustMarshal(v interface{}) json.RawMessage {
	raw, _ := json.Marshal(v)
	return raw
}

// PinnedDrift nennt die Rollen eines LAUFENDEN Workflows, deren gespeicherter (gepinnter) Startzustand vom aktuellen
// Live-Stand abweicht. Beim Stoppen bleibt der gespeicherte Stand gültig, die Live-Änderungen gingen verloren — die
// Oberfläche warnt davor (Nutzerfund 2026-11-10: „wir verlieren immer wieder Einstellungen“). Rein lesend.
func (s *Service) PinnedDrift(id string) ([]string, error) {
	wf, err := s.Get(id)
	if err != nil {
		return nil, err
	}
	if wf.Status != StatusStarted {
		return []string{}, nil
	}
	saved, err := s.store.GetRoleState(id)
	if err != nil {
		return nil, err
	}
	senderToAlias := s.buildSenderAliasIndex(wf)
	drift := []string{}
	for role, raw := range saved {
		var env roleStateEnvelope
		if json.Unmarshal(raw, &env) != nil || !env.Pinned || env.Kind != roleStateKindNode || len(env.Blob) == 0 {
			continue
		}
		node, ok := s.nodeForRole(wf, role)
		if !ok || node.APIBaseURL == "" {
			continue
		}
		ctx, cancel := context.WithTimeout(context.Background(), roleStateTimeout)
		live, lerr := getNodeState(ctx, s.httpClient, node.APIBaseURL)
		cancel()
		if lerr != nil {
			continue
		}
		aliased, aerr := aliasSenderIDs(live, senderToAlias)
		if aerr != nil {
			continue
		}
		if !sameOperatingState(aliased, env.Blob) {
			drift = append(drift, role)
		}
	}
	sort.Strings(drift)
	return drift, nil
}
