package mcr

import (
	"context"
	"encoding/json"
	"testing"
)

type fakeCap struct {
	hosts []HostCap
	prof  map[string]float64
}

func (f fakeCap) Hosts(context.Context) []HostCap { return f.hosts }
func (f fakeCap) Profile(_ context.Context, nt string) (float64, uint64, bool) {
	c, ok := f.prof[nt]
	return c, 100 << 20, ok
}

func srtLines(n int) Event {
	e := Event{ID: "ev", Name: "Cap"}
	for i := 0; i < n; i++ {
		e.Lines = append(e.Lines, Line{ID: string(rune('a' + i)), Name: string(rune('A' + i)), Kind: KindSRT, Transport: json.RawMessage(`{"uri":"srt://:9000"}`)})
	}
	return e
}

func TestPrecheckFitsAndOverflows(t *testing.T) {
	big := fakeCap{hosts: []HostCap{{ID: "h", Cores: 16, CPUPercent: 10, MemTotal: 32 << 30, MemPercent: 20}}}
	rep, err := Precheck(context.Background(), srtLines(4), nil, big)
	if err != nil || !rep.OK || rep.NeedCores <= 0 {
		t.Fatalf("passt auf großen Host: %+v %v", rep, err)
	}
	small := fakeCap{hosts: []HostCap{{ID: "h", Cores: 2, CPUPercent: 70, MemTotal: 32 << 30, MemPercent: 20}}}
	rep, _ = Precheck(context.Background(), srtLines(8), nil, small)
	if rep.OK || len(rep.Warnings) == 0 {
		t.Fatalf("muss warnen: %+v", rep)
	}
}

func TestPrecheckUsesProfileAndCountsRoles(t *testing.T) {
	src := fakeCap{hosts: []HostCap{{ID: "h", Cores: 4, CPUPercent: 0}}, prof: map[string]float64{NodeNormalizer: 1.0, NodeContribIn: 0.5}}
	rep, _ := Precheck(context.Background(), srtLines(2), nil, src)
	if rep.NeedCores < 2.9 || rep.NeedCores > 3.1 { // 2×1,0 + 2×0,5
		t.Fatalf("Bedarf aus Profil: %.2f", rep.NeedCores)
	}
	for _, it := range rep.Items {
		if it.Estimated {
			t.Fatalf("Profil vorhanden, darf nicht geschätzt sein: %+v", it)
		}
	}
}

func TestPrecheckNoHosts(t *testing.T) {
	rep, _ := Precheck(context.Background(), srtLines(1), nil, fakeCap{})
	if len(rep.Warnings) == 0 {
		t.Fatal("ohne Hosts muss die Vorprüfung ehrlich sagen, dass sie nichts belegt")
	}
}
