package cluster

import (
	"bytes"
	"io"
	"testing"

	"github.com/hashicorp/raft"
)

// Kompatibilitätswächter fürs Cluster-Rolling-Update (Kap. 84, docs/ENTWURF-SYSTEM-UPDATE.md §11.4):
// Während des Rollouts liest ein Mitglied der alten Version das Log, das ein neueres schreibt.
// Der FSM muss daher unbekannte Befehlsarten/Felder überspringen, ohne Zustand zu beschädigen.

// Wer einen CommandType hinzufügt, muss diese Liste ändern und damit bewusst entscheiden, ob das Paket
// (noch) `rollingSafe` sein darf: ein altes Mitglied ignoriert den neuen Befehl, verliert dessen Wirkung.
func TestCommandTypesAreKnownSet(t *testing.T) {
	want := []CommandType{"set_peer_http_addr", "remove_peer_http_addr"}
	got := KnownCommandTypes()
	if len(got) != len(want) {
		t.Fatalf("CommandType-Liste geaendert (%v) - rollingSafe-Folgen pruefen (docs/ENTWURF-SYSTEM-UPDATE.md §11.4) und diese Liste anpassen", got)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("CommandType %d: %q, erwartet %q", i, got[i], want[i])
		}
	}
}

func TestFSMIgnoresUnknownCommandsAndFieldsFromNewerVersion(t *testing.T) {
	f := NewFSM()
	logs := [][]byte{
		[]byte(`{"type":"set_peer_http_addr","nodeId":"a","httpAddr":"h:1","neuesFeld":42}`),
		[]byte(`{"type":"befehl_der_neuen_version","nodeId":"a","payload":{"x":1}}`),
		[]byte(`{"type":"set_peer_http_addr","nodeId":"b","httpAddr":"h:2"}`),
	}
	for i, d := range logs {
		f.Apply(&raft.Log{Index: uint64(i + 1), Data: d})
	}
	if f.Version() != 3 {
		t.Fatalf("version = %d, want 3", f.Version())
	}
	got := f.PeerHTTPAddrs()
	if len(got) != 2 || got["a"] != "h:1" || got["b"] != "h:2" {
		t.Fatalf("Zustand beschaedigt: %v", got)
	}
}

func TestFSMRestoreAcceptsSnapshotWithUnknownFields(t *testing.T) {
	f := NewFSM()
	snap := `{"version":7,"peerHttpAddrs":{"a":"h:1"},"neuerZustand":{"k":[1,2,3]}}`
	if err := f.Restore(io.NopCloser(bytes.NewBufferString(snap))); err != nil {
		t.Fatalf("Restore: %v", err)
	}
	if f.Version() != 7 || f.PeerHTTPAddrs()["a"] != "h:1" {
		t.Fatalf("Restore unvollstaendig: v=%d %v", f.Version(), f.PeerHTTPAddrs())
	}
}
