package sourcetags

import (
	"database/sql"
	"errors"
	"reflect"
	"testing"

	"github.com/infantilo/openmediaplatform/orchestrator/internal/dbtest"
)

func TestValidateTag(t *testing.T) {
	for _, ok := range []string{"audio.commentator", "media.video", "audio.51", "role.program", "video.camera", "audio.x-ray.a1"} {
		if err := ValidateTag(ok); err != nil {
			t.Errorf("%q should be valid: %v", ok, err)
		}
	}
	for _, bad := range []string{"", "audio", "Audio.Commentator", "audio..x", ".audio", "audio.", "audio commentator", "audio.comm entator", "1audio.x", "a.b/c"} {
		if err := ValidateTag(bad); !errors.Is(err, ErrValidation) {
			t.Errorf("%q should be rejected, got %v", bad, err)
		}
	}
}

func TestNormalizeDeduplicatesSortsAndLimits(t *testing.T) {
	got, err := Normalize([]string{" role.b ", "audio.a", "role.b"})
	if err != nil || !reflect.DeepEqual(got, []string{"audio.a", "role.b"}) {
		t.Fatalf("Normalize = %v, %v", got, err)
	}
	many := make([]string, MaxTagsPerSource+1)
	for i := range many {
		many[i] = "x.t" + string(rune('a'+i%26)) + string(rune('a'+i/26))
	}
	if _, err := Normalize(many); !errors.Is(err, ErrValidation) {
		t.Fatalf("too many tags: err = %v", err)
	}
	if _, err := Normalize([]string{"nope"}); !errors.Is(err, ErrValidation) {
		t.Fatalf("invalid tag must fail the whole list: %v", err)
	}
}

func TestDeriveFromFormatAndChannelCount(t *testing.T) {
	cases := []struct {
		format string
		ch     int
		want   []string
	}{
		{"urn:x-nmos:format:video", 0, []string{"media.video"}},
		{"urn:x-nmos:format:audio", 1, []string{"media.audio", "audio.mono"}},
		{"urn:x-nmos:format:audio", 2, []string{"media.audio", "audio.stereo"}},
		{"urn:x-nmos:format:audio", 6, []string{"media.audio", "audio.51"}},
		// Unbekannte/ungewöhnliche Kanalzahl: nichts raten.
		{"urn:x-nmos:format:audio", 0, []string{"media.audio"}},
		{"urn:x-nmos:format:audio", 4, []string{"media.audio"}},
		{"", 2, nil},
	}
	for _, c := range cases {
		if got := Derive(c.format, c.ch); !reflect.DeepEqual(got, c.want) {
			t.Errorf("Derive(%q,%d) = %v, want %v", c.format, c.ch, got, c.want)
		}
	}
}

func TestMergeExplicitBeatsDerivedBeatsDiscovered(t *testing.T) {
	got := Merge(
		[]string{"audio.stereo", "role.commentator"},
		[]string{"media.audio", "audio.stereo", "audio.mono"},
		[]string{"audio.mono", "role.program", "BAD TAG", "media.audio"},
	)
	want := []Tag{
		{"audio.mono", OriginDerived},
		{"audio.stereo", OriginExplicit},
		{"media.audio", OriginDerived},
		{"role.commentator", OriginExplicit},
		{"role.program", OriginDiscovered},
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("Merge = %+v\nwant   %+v", got, want)
	}
}

func testStore(t *testing.T) *Store {
	t.Helper()
	database := dbtest.Open(t)
	clean := func(db *sql.DB) {
		if _, err := db.Exec(`DELETE FROM source_tags`); err != nil {
			t.Fatalf("cleanup: %v", err)
		}
	}
	clean(database)
	t.Cleanup(func() { clean(database) })
	return NewStore(database)
}

func TestStoreSetReplacesAndSurvivesByStableKey(t *testing.T) {
	s := testStore(t)
	k := Key{NodeID: "node-1", SenderLabel: "Audio 1"}
	if _, err := s.Set(Key{}, nil, "u"); !errors.Is(err, ErrValidation) {
		t.Fatalf("empty key: %v", err)
	}
	got, err := s.Set(k, []string{"role.commentator", "audio.mono", "audio.mono"}, "alice")
	if err != nil || !reflect.DeepEqual(got, []string{"audio.mono", "role.commentator"}) {
		t.Fatalf("Set = %v, %v", got, err)
	}
	// Ersetzen, nicht ergänzen.
	if _, err := s.Set(k, []string{"role.program"}, "bob"); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Set(Key{NodeID: "node-1", SenderLabel: "Audio 2"}, []string{"role.international"}, "bob"); err != nil {
		t.Fatal(err)
	}
	all, err := s.All()
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(all[k], []string{"role.program"}) || len(all) != 2 {
		t.Fatalf("All = %v", all)
	}
	// Leere Liste entfernt alle.
	if _, err := s.Set(k, nil, "bob"); err != nil {
		t.Fatal(err)
	}
	all, _ = s.All()
	if _, still := all[k]; still {
		t.Fatalf("tags should be gone: %v", all)
	}
	// Ungültiger Tag ändert nichts am Bestand.
	if _, err := s.Set(Key{NodeID: "node-1", SenderLabel: "Audio 2"}, []string{"kaputt"}, "bob"); !errors.Is(err, ErrValidation) {
		t.Fatalf("invalid: %v", err)
	}
	all, _ = s.All()
	if !reflect.DeepEqual(all[Key{NodeID: "node-1", SenderLabel: "Audio 2"}], []string{"role.international"}) {
		t.Fatalf("existing tags changed by a failed Set: %v", all)
	}
}
