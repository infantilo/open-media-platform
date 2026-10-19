package ingest

import (
	"fmt"
	"math/rand"
	"testing"
	"time"
)

var t0 = utc("2026-10-20T10:00:00Z")

func host(id string, rec, cpu float64) HostCap {
	return HostCap{ID: id, Label: id, Online: true, Functions: []string{"recorder", "converter"},
		Hard: map[string]float64{ResRecorders: rec, ResCPU: cpu, ResMem: 8000, ResDiskMBps: 400, ResDiskGB: 500, ResNetMbps: 1000, ResMXLShm: 2000}}
}

func req(id, src string, startMin, durMin int, prio int, cpu float64) Request {
	return Request{JobID: id, Source: src, Start: t0.Add(time.Duration(startMin) * time.Minute), End: t0.Add(time.Duration(startMin+durMin) * time.Minute), Priority: prio,
		Demand: Demand{Amount: map[string]float64{ResRecorders: 1, ResCPU: cpu, ResMem: 500, ResDiskMBps: 20, ResDiskGB: 10, ResMXLShm: 100}, Origin: map[string]string{ResCPU: OriginMeasured}},
		Needs:  []string{"recorder"}}
}

func book(r Request, host string) Booked {
	return Booked{JobID: r.JobID, Host: host, Source: r.Source, Start: r.Start, End: r.End, Priority: r.Priority, Amount: r.Demand.Amount}
}

func kinds(d Decision) []string {
	var k []string
	for _, v := range d.Verdicts {
		k = append(k, v.Kind)
	}
	return k
}

func TestAdmitOnFreeHost(t *testing.T) {
	d := Plan(req("a", "cam1", 0, 60, 5, 1), []HostCap{host("h1", 2, 4)}, nil, Rules{}, t0)
	if !d.Admit || d.Host != "h1" || kinds(d)[0] != VOK {
		t.Fatalf("%+v", d)
	}
}

// Sieben Gründe sind unterscheidbar.
func TestVerdictClasses(t *testing.T) {
	hs := []HostCap{host("h1", 1, 4)}
	b := []Booked{book(req("x", "camX", 0, 120, 5, 1), "h1")}

	// vorübergehend belegt (Rekorder-Slot): frühester Start = Ende des belegenden Auftrags
	d := Plan(req("a", "cam1", 30, 30, 5, 1), hs, b, Rules{}, t0)
	if d.Admit || kinds(d)[0] != VTempOccupied || d.EarliestStart == nil || !d.EarliestStart.Equal(t0.Add(120*time.Minute)) || d.Verdicts[0].Resource != ResRecorders {
		t.Fatalf("temporarily occupied: %+v", d)
	}
	if len(d.Verdicts[0].Jobs) != 1 || d.Verdicts[0].Jobs[0] != "x" || d.Verdicts[0].From == nil {
		t.Fatalf("verdict must name the jobs and interval: %+v", d.Verdicts[0])
	}
	// harter Mangel: braucht mehr CPU als der Host je hat
	big := req("b", "cam1", 0, 30, 5, 16)
	if d := Plan(big, hs, nil, Rules{}, t0); d.Admit || d.Verdicts[0].Kind != VHardShortage || d.Verdicts[0].Resource != ResCPU {
		t.Fatalf("hard shortage: %+v", d)
	}
	// Speicherplatz
	st := req("s", "cam1", 0, 30, 5, 1)
	st.Demand.Amount[ResDiskGB] = 900
	if d := Plan(st, hs, nil, Rules{}, t0); d.Admit || d.Verdicts[0].Kind != VStorage {
		t.Fatalf("storage: %+v", d)
	}
	// Schreibdurchsatz zählt ebenfalls als Speicher/I-O-Mangel
	io := req("io", "cam1", 0, 30, 5, 1)
	io.Demand.Amount[ResDiskMBps] = 5000
	if d := Plan(io, hs, nil, Rules{}, t0); d.Admit || d.Verdicts[0].Kind != VStorage {
		t.Fatalf("io: %+v", d)
	}
	// fehlende Funktion
	cv := req("c", "cam1", 0, 30, 5, 1)
	cv.Needs = []string{"gpu-transcoder"}
	if d := Plan(cv, hs, nil, Rules{}, t0); d.Admit || d.Verdicts[0].Kind != VMissingFunction {
		t.Fatalf("missing function: %+v", d)
	}
	// Host offline = keine Funktion verfügbar
	off := host("h2", 1, 4)
	off.Online = false
	if d := Plan(req("o", "cam1", 0, 30, 5, 1), []HostCap{off}, nil, Rules{}, t0); d.Admit || d.Verdicts[0].Kind != VMissingFunction {
		t.Fatalf("offline: %+v", d)
	}
	// Quellenkonflikt
	var many []Booked
	for i := 0; i < 2; i++ {
		many = append(many, book(req(fmt.Sprintf("m%d", i), "camS", 0, 60, 5, 0.1), "h1"))
	}
	r := Rules{SourceOverride: map[string]int{"camS": 2}}
	if d := Plan(req("n", "camS", 10, 10, 5, 0.1), []HostCap{host("h9", 9, 40)}, many, r, t0); d.Admit || d.Verdicts[0].Kind != VSourceConflict || len(d.Verdicts[0].Jobs) != 2 {
		t.Fatalf("source conflict: %+v", d)
	}
}

func TestSoftWarningAndUncertainEstimateDoNotBlock(t *testing.T) {
	h := host("h1", 4, 4)
	h.SoftFrac = 0.7
	b := []Booked{book(req("x", "camX", 0, 120, 5, 2.5), "h1")}
	rq := req("a", "cam1", 10, 30, 5, 1) // 3,5 von 4 Kernen = 87 %
	rq.Demand.Origin = map[string]string{ResCPU: OriginDefault, ResMem: OriginConfigured}
	d := Plan(rq, []HostCap{h}, b, Rules{}, t0)
	if !d.Admit {
		t.Fatalf("must still be admitted: %+v", d)
	}
	k := kinds(d)
	if len(k) != 2 || k[0] != VSoftWarning || k[1] != VUncertain {
		t.Fatalf("verdicts %v", k)
	}
}

func TestPriorityReserveProtectsCapacityForHighPriority(t *testing.T) {
	h := host("h1", 2, 8)
	rules := Rules{ReservePct: map[string]float64{ResRecorders: 0.5}, ReserveFromPriority: 8}
	// niedrige Priorität: nur 1 von 2 Slots nutzbar
	b := []Booked{book(req("x", "camX", 0, 120, 3, 1), "h1")}
	d := Plan(req("low", "cam1", 10, 30, 3, 1), []HostCap{h}, b, rules, t0)
	if d.Admit {
		t.Fatalf("low priority must not use the reserved slot: %+v", d)
	}
	// hohe Priorität bekommt den zweiten Slot
	if d := Plan(req("high", "cam1", 10, 30, 9, 1), []HostCap{h}, b, rules, t0); !d.Admit {
		t.Fatalf("high priority must be admitted: %+v", d)
	}
}

func TestPreemptionIsOnlyASuggestionAndNeverTouchesRunning(t *testing.T) {
	h := host("h1", 1, 4)
	run := book(req("running", "camA", -10, 60, 1, 1), "h1")
	run.Active = true
	fut := book(req("future", "camB", 70, 60, 1, 1), "h1")
	hi := req("vip", "camC", 80, 30, 9, 1)
	d := Plan(hi, []HostCap{h}, []Booked{run, fut}, Rules{AllowPreempt: true}, t0)
	if d.Admit || len(d.Verdicts[0].Preemptable) != 1 || d.Verdicts[0].Preemptable[0] != "future" {
		t.Fatalf("suggest only the future job: %+v", d.Verdicts)
	}
	// gegen einen laufenden Auftrag wird nie vorgeschlagen
	d = Plan(req("vip2", "camC", 10, 30, 9, 1), []HostCap{h}, []Booked{run}, Rules{AllowPreempt: true}, t0)
	if d.Admit || len(d.Verdicts[0].Preemptable) != 0 {
		t.Fatalf("running jobs are never preemptable: %+v", d.Verdicts)
	}
	// ohne Erlaubnis keine Vorschläge
	d = Plan(hi, []HostCap{h}, []Booked{run, fut}, Rules{}, t0)
	if len(d.Verdicts[0].Preemptable) != 0 {
		t.Fatal("preemption suggestions need the policy")
	}
}

func TestAlternativeHostIsOffered(t *testing.T) {
	h1, h2 := host("h1", 1, 4), host("h2", 1, 4)
	b := []Booked{book(req("x", "a", 0, 120, 5, 1), "h1"), book(req("y", "b", 0, 30, 5, 1), "h2")}
	rq := req("n", "c", 10, 40, 5, 1)
	rq.HostPref = "h1"
	d := Plan(rq, []HostCap{h1, h2}, b, Rules{}, t0)
	if d.Admit || len(d.Alternatives) != 2 {
		t.Fatalf("%+v", d)
	}
	if !d.EarliestStart.Equal(t0.Add(30 * time.Minute)) {
		t.Fatalf("earliest = %v (h2 frees up after 30 min)", d.EarliestStart)
	}
	// Wunschhost wird bevorzugt, wenn frei
	if d := Plan(req("n2", "c", 200, 10, 5, 1), []HostCap{h1, h2}, b, Rules{}, t0); !d.Admit || d.Host != "h1" {
		// h1/h2 sind beide frei; ohne Wunsch deterministisch h1
		t.Fatalf("%+v", d)
	}
	rq2 := req("n3", "c", 200, 10, 5, 1)
	rq2.HostPref = "h2"
	if d := Plan(rq2, []HostCap{h1, h2}, b, Rules{}, t0); d.Host != "h2" {
		t.Fatalf("preferred host ignored: %+v", d)
	}
}

// Eigenschaft: sequentielle Zulassungen überschreiten zu keinem Zeitpunkt eine harte Grenze (unabhängige Prüfung).
func TestPropertyNeverOversubscribes(t *testing.T) {
	rnd := rand.New(rand.NewSource(42))
	for round := 0; round < 40; round++ {
		hs := []HostCap{host("h1", float64(1+rnd.Intn(3)), float64(2+rnd.Intn(4))), host("h2", float64(1+rnd.Intn(3)), float64(2+rnd.Intn(4)))}
		var booked []Booked
		for i := 0; i < 60; i++ {
			r := req(fmt.Sprintf("j%d", i), fmt.Sprintf("cam%d", rnd.Intn(5)), rnd.Intn(600), 5+rnd.Intn(120), rnd.Intn(10), 0.25+rnd.Float64()*1.5)
			d := Plan(r, hs, booked, Rules{ReservePct: map[string]float64{ResCPU: 0.2}, ReserveFromPriority: 7}, t0)
			if d.Admit {
				booked = append(booked, book(r, d.Host))
			}
		}
		// Unabhängige Prüfung: an jedem Zeitpunkt (Minutenraster) je Host/Ressource ≤ Obergrenze
		for _, h := range hs {
			for m := 0; m < 800; m++ {
				at := t0.Add(time.Duration(m) * time.Minute)
				use := map[string]float64{}
				for _, b := range booked {
					if b.Host == h.ID && !at.Before(b.Start) && at.Before(b.End) {
						for k, v := range b.Amount {
							if k != ResDiskGB {
								use[k] += v
							}
						}
					}
				}
				for k, v := range use {
					if lim, ok := h.Hard[k]; ok && v > lim+1e-9 {
						t.Fatalf("round %d host %s at +%dm: %s = %.3f > %.3f", round, h.ID, m, k, v, lim)
					}
				}
			}
		}
	}
}

func TestAdjacentWindowsDoNotConflict(t *testing.T) {
	h := host("h1", 1, 4)
	b := []Booked{book(req("x", "a", 0, 60, 5, 1), "h1")}
	if d := Plan(req("n", "b", 60, 60, 5, 1), []HostCap{h}, b, Rules{}, t0); !d.Admit {
		t.Fatalf("back-to-back recordings must be allowed (end exclusive): %+v", d)
	}
}

func TestStorageIsCumulative(t *testing.T) {
	h := host("h1", 8, 8)
	h.Hard[ResDiskGB] = 25
	var b []Booked
	for i := 0; i < 2; i++ {
		b = append(b, book(req(fmt.Sprintf("d%d", i), fmt.Sprintf("c%d", i), 600+i*10, 5, 5, 0.1), "h1")) // 10 GB je, weit in der Zukunft
	}
	d := Plan(req("n", "cx", 0, 5, 5, 0.1), []HostCap{h}, b, Rules{}, t0) // 10 weitere → 30 > 25, obwohl zeitlich getrennt
	if d.Admit || d.Verdicts[0].Kind != VStorage {
		t.Fatalf("disk space is not time-windowed: %+v", d)
	}
}
