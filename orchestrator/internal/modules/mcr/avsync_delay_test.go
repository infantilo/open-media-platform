package mcr

import "testing"

// Spiegel der Normalizer-Tests (nodes/omp-normalizer/src/avsync.rs): dieselben Zahlen, 40 ms je Bild, höchstens 12 Bilder.
func plan(t *testing.T, js string) DelayPlan {
	t.Helper()
	p, ok := PlanDelay(raw(js), 40, 12)
	if !ok {
		t.Fatalf("%s: kein Plan", js)
	}
	return p
}

func TestPlanDelayMirrorsNormalizer(t *testing.T) {
	if p := plan(t, `{"mode":"once","heldMs":60}`); p.VideoFrames != 0 || p.AudioMs != 60 || p.OffsetMs != 60 {
		t.Errorf("Ton früh: %+v", p)
	}
	if p := plan(t, `{"mode":"once","heldMs":-80}`); p.VideoFrames != 2 || p.AudioMs != 0 {
		t.Errorf("Ton spät, 2 Bilder: %+v", p)
	}
	if p := plan(t, `{"mode":"once","heldMs":-70}`); p.VideoFrames != 2 || p.AudioMs != 10 {
		t.Errorf("aufgerundet, Rest in den Ton: %+v", p)
	}
	if p := plan(t, `{"mode":"once","heldMs":7.4}`); p.VideoFrames != 0 || p.AudioMs != 0 || p.OffsetMs != 0 {
		t.Errorf("Totband: %+v", p)
	}
	if p := plan(t, `{"mode":"manual","manualMs":5,"heldMs":60}`); p.AudioMs != 5 {
		t.Errorf("manuell ohne Totband: %+v", p)
	}
	if p := plan(t, `{"mode":"off","heldMs":80}`); p.AudioMs != 0 || p.VideoFrames != 0 {
		t.Errorf("off: %+v", p)
	}
	if p := plan(t, `{"mode":"once"}`); p.AudioMs != 0 || p.VideoFrames != 0 {
		t.Errorf("ohne Messwert (z. B. nach Zurücksetzen) = 0: %+v", p)
	}
	if p := plan(t, `{"mode":"once","heldMs":-1000}`); p.VideoFrames != 12 || !p.Exceeds {
		t.Errorf("zu groß für den Ring: %+v", p)
	}
	if p := plan(t, `{"mode":"once","heldMs":-400}`); p.Exceeds {
		t.Errorf("400 ms passen: %+v", p)
	}
	// Ohne Einstellung oder mit „tracking“ gibt es nichts zu übergeben (Startwerte des Slots gelten).
	for _, js := range []string{``, `null`, `{}`, `{"mode":"tracking","heldMs":50}`} {
		if _, ok := PlanDelay(raw(js), 40, 12); ok {
			t.Errorf("%q: kein Plan erwartet", js)
		}
	}
	if _, ok := PlanDelay(raw(`{"mode":"once","heldMs":50}`), 0, 12); ok {
		t.Error("ohne Bilddauer kein Plan")
	}
}

func TestMaterializePassesMeasurementToExternalDelay(t *testing.T) {
	g := mustHouse(t, `{"video":{"width":640,"height":360,"rate":"25/1","scan":"progressive"}}`)
	cc := ChainConfig{Slots: Slots{AVDelay: Slot{NodeType: "omp-avdelay", Video: true, Audio: true, Params: map[string]any{"delay.slewPermille": 2}}}}
	e := Event{ID: "ev", Name: "K", Lines: []Line{{ID: "l1", Name: "A", Kind: KindSRT, Transport: raw(`{"uri":"srt://:9000"}`), Avsync: raw(`{"mode":"once","heldMs":-70}`)}}}
	_, roles, _, err := Materialize(e, g, "", cc)
	if err != nil {
		t.Fatal(err)
	}
	p := roles["l1"].Post[0].Stage.Params
	if p[ParamDelayVideoFrames] != 2 || p[ParamDelayAudioMs] != 10.0 || p["delay.slewPermille"] != 2 {
		t.Fatalf("Parameter am Delay-Node: %v", p)
	}
	// Die Slot-Parameter bleiben unverändert (kein Durchschlagen in die Einstellung).
	if _, ok := cc.Slots.AVDelay.Params[ParamDelayVideoFrames]; ok {
		t.Fatal("Slot-Parameter wurden verändert")
	}
	// Nach „Zurücksetzen“ (kein Messwert mehr) geht der Node explizit auf 0.
	e.Lines[0].Avsync = raw(`{"mode":"once"}`)
	_, roles, _, _ = Materialize(e, g, "", cc)
	if p := roles["l1"].Post[0].Stage.Params; p[ParamDelayVideoFrames] != 0 || p[ParamDelayAudioMs] != 0.0 {
		t.Fatalf("nach Zurücksetzen: %v", p)
	}
	// Ohne Einstellung (oder nach avsync.reset: leer): Startwerte des Slots, sonst 0 — immer ausdrücklich gesetzt.
	for _, js := range []string{``, `{}`} {
		e.Lines[0].Avsync = raw(js)
		_, roles, _, _ = Materialize(e, g, "", cc)
		if p := roles["l1"].Post[0].Stage.Params; p[ParamDelayVideoFrames] != 0 || p[ParamDelayAudioMs] != 0.0 || p["delay.slewPermille"] != 2 {
			t.Fatalf("ohne Einstellung %q: %v", js, p)
		}
	}
	cc.Slots.AVDelay.Params["delay.audioMs"] = 30.0
	_, roles, _, _ = Materialize(e, g, "", cc)
	if p := roles["l1"].Post[0].Stage.Params; p[ParamDelayAudioMs] != 30.0 {
		t.Fatalf("Startwert des Slots: %v", p)
	}
	delete(cc.Slots.AVDelay.Params, "delay.audioMs")
	// Ohne Slot gar kein Eingriff.
	_, roles, _, _ = Materialize(e, g, "", ChainConfig{})
	if len(roles["l1"].Post) != 0 {
		t.Fatalf("ohne Slot keine Stufe: %v", roles["l1"].Post)
	}
}
