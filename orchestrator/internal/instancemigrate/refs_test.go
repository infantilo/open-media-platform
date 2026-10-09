package instancemigrate

import (
	"encoding/json"
	"testing"
)

func TestMapStringsAliasRoundTrip(t *testing.T) {
	state := json.RawMessage(`{"programSenderId":"old-s0","pinned":["old-s0","other"],"nested":{"n":"old-node"}}`)
	aliased, err := mapStrings(state, map[string]string{"old-s0": aliasSenderPrefix + "0", "old-node": aliasNodePrefix})
	if err != nil {
		t.Fatal(err)
	}
	if string(aliased) == string(state) {
		t.Fatal("expected ids to be aliased")
	}
	back, err := mapStrings(aliased, map[string]string{aliasSenderPrefix + "0": "new-s0", aliasNodePrefix: "new-node"})
	if err != nil {
		t.Fatal(err)
	}
	want := json.RawMessage(`{"programSenderId":"new-s0","pinned":["new-s0","other"],"nested":{"n":"new-node"}}`)
	if !jsonEqual(back, want) {
		t.Fatalf("got %s, want %s", back, want)
	}
}
