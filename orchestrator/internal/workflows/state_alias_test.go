package workflows

import (
	"encoding/json"
	"testing"
)

// Node-IDs in einem Rollenzustand (z. B. followTarget des Audiomischers)
// müssen den Neustart überleben: erfassen -> Alias, wiederherstellen ->
// aktuelle Node-ID derselben Rolle.
func TestNodeIDAliasRoundTrip(t *testing.T) {
	raw := json.RawMessage(`{"channels":[{"id":"ch1","followTarget":"old-node-id","followMode":"cut"}]}`)
	aliased, err := aliasSenderIDs(raw, map[string]string{"old-node-id": nodeAliasPrefix + "omp-source"})
	if err != nil {
		t.Fatal(err)
	}
	if string(aliased) == string(raw) {
		t.Fatalf("node id not aliased: %s", aliased)
	}
	resolved, used, err := resolveSenderAliases(aliased, map[string]string{nodeAliasPrefix + "omp-source": "new-node-id"})
	if err != nil {
		t.Fatal(err)
	}
	var doc struct {
		Channels []struct {
			FollowTarget string `json:"followTarget"`
		} `json:"channels"`
	}
	if err := json.Unmarshal(resolved, &doc); err != nil {
		t.Fatal(err)
	}
	if got := doc.Channels[0].FollowTarget; got != "new-node-id" {
		t.Fatalf("followTarget = %q, want new-node-id", got)
	}
	if len(used) != 1 || used[0] != "new-node-id" {
		t.Fatalf("used = %v", used)
	}
}
