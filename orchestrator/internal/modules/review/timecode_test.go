package review

import (
	"encoding/json"
	"os"
	"testing"
)

type tcVector struct {
	Rate  string `json:"rate"`
	Drop  bool   `json:"drop"`
	Frame int64  `json:"frame"`
	TC    string `json:"tc"`
}

func loadVectors(t *testing.T) []tcVector {
	t.Helper()
	raw, err := os.ReadFile("testdata/timecode_vectors.json")
	if err != nil {
		t.Fatal(err)
	}
	var v []tcVector
	if err := json.Unmarshal(raw, &v); err != nil {
		t.Fatal(err)
	}
	return v
}

func TestTimecodeVectorsRoundTrip(t *testing.T) {
	for _, v := range loadVectors(t) {
		r, err := ParseRate(v.Rate)
		if err != nil {
			t.Fatal(err)
		}
		if got := FormatTimecode(v.Frame, r, v.Drop); got != v.TC {
			t.Errorf("%s drop=%v frame %d: format = %s, want %s", v.Rate, v.Drop, v.Frame, got, v.TC)
		}
		back, drop, err := ParseTimecode(v.TC, r)
		if err != nil || back != v.Frame || drop != v.Drop {
			t.Errorf("%s %s: parse = %d drop=%v err=%v, want %d drop=%v", v.Rate, v.TC, back, drop, err, v.Frame, v.Drop)
		}
	}
}

// Jeder Frame eines Tages muss über Format→Parse unverändert zurückkommen (Drop-Frame ist die klassische Fehlerquelle).
func TestDropFrameFullRoundTrip(t *testing.T) {
	r, _ := ParseRate("30000/1001")
	for f := int64(0); f < 2_000_000; f += 7 {
		tc := FormatTimecode(f, r, true)
		back, _, err := ParseTimecode(tc, r)
		if err != nil || back != f {
			t.Fatalf("frame %d -> %s -> %d (%v)", f, tc, back, err)
		}
	}
}

func TestParseRateAndRejects(t *testing.T) {
	r, err := ParseRate("60000/2002")
	if err != nil || r.Num != 30000 || r.Den != 1001 || !r.DropCapable() || r.Nominal() != 30 {
		t.Fatalf("%+v %v", r, err)
	}
	for _, bad := range []string{"", "0", "-25", "abc", "25/0"} {
		if _, err := ParseRate(bad); err == nil {
			t.Errorf("rate %q must be rejected", bad)
		}
	}
	r25, _ := ParseRate("25")
	for _, bad := range []string{"00:00:00:25", "00:60:00:00", "00:00:60:00", "0:00:00:00", "00:00:00;00"} {
		if _, _, err := ParseTimecode(bad, r25); err == nil {
			t.Errorf("timecode %q must be rejected at 25 fps", bad)
		}
	}
	r2997, _ := ParseRate("30000/1001")
	if _, _, err := ParseTimecode("00:01:00;00", r2997); err == nil {
		t.Error("dropped timecode 00:01:00;00 does not exist and must be rejected")
	}
	if _, _, err := ParseTimecode("00:10:00;00", r2997); err != nil {
		t.Errorf("00:10:00;00 exists: %v", err)
	}
}

func TestFrameTimeConversionExact(t *testing.T) {
	r, _ := ParseRate("30000/1001")
	// 30000 Bilder = exakt 1001 s
	if ns := r.FrameStartNs(30000); ns != 1_001_000_000_000 {
		t.Fatalf("FrameStartNs(30000) = %d", ns)
	}
	for _, n := range []int64{0, 1, 29, 30, 1799, 1800, 107892} {
		if got := r.FrameAtNs(r.FrameStartNs(n)); got != n {
			t.Errorf("FrameAtNs(FrameStartNs(%d)) = %d", n, got)
		}
		// mitten im Bild bleibt im Bild
		mid := (r.FrameStartNs(n) + r.FrameStartNs(n+1)) / 2
		if got := r.FrameAtNs(mid); got != n {
			t.Errorf("mid-frame %d -> %d", n, got)
		}
	}
}

func TestTimelineStartOffsetAndRange(t *testing.T) {
	r, _ := ParseRate("25")
	start, _, _ := ParseTimecode("10:00:00:00", r)
	tl := Timeline{Rate: r, DurationFrames: 500, StartFrames: start}
	if tl.Timecode(0) != "10:00:00:00" || tl.Timecode(499) != "10:00:19:24" {
		t.Fatalf("%s %s", tl.Timecode(0), tl.Timecode(499))
	}
	if n, err := tl.FrameForTimecode("10:00:10:00"); err != nil || n != 250 {
		t.Fatalf("%d %v", n, err)
	}
	if _, err := tl.FrameForTimecode("09:59:59:24"); err == nil {
		t.Fatal("timecode before file start must fail")
	}
	// [in,out) — out exklusiv: out == Dauer ist erlaubt, out == Dauer+1 nicht
	if err := tl.ValidateRange(0, 500, 1); err != nil {
		t.Fatal(err)
	}
	for _, c := range [][2]int64{{-1, 10}, {0, 501}, {10, 10}, {20, 10}} {
		if tl.ValidateRange(c[0], c[1], 1) == nil {
			t.Errorf("range %v must be rejected", c)
		}
	}
	if tl.ValidateRange(0, 5, 10) == nil {
		t.Error("min length not enforced")
	}
}
