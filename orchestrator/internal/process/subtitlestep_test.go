package process

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"
)

type fakeSubtitles struct {
	calls []SubtitleStepConfig
	keys  []string
	done  bool
	err   error
}

func (f *fakeSubtitles) Step(_ context.Context, key string, c SubtitleStepConfig) (SubtitleStepResult, bool, error) {
	f.calls = append(f.calls, c)
	f.keys = append(f.keys, key)
	if f.err != nil {
		return SubtitleStepResult{}, false, f.err
	}
	return SubtitleStepResult{SRT: "/d/a.srt", Name: "a", Speakers: 2, Cues: 7}, f.done, nil
}

func subStep(cfg string) Step {
	return Step{ID: "s1", Type: StepTypeSubtitles, Config: json.RawMessage(cfg)}
}

func subCtx() ExecutionCtx {
	return ExecutionCtx{Execution: ProcessExecution{ID: "ex9", Input: json.RawMessage(`{"file":"/m/wetter.mxf","lang":"en","n":"3"}`)}}
}

func TestSubtitleStepInterpolatesWaitsThenDelivers(t *testing.T) {
	svc := &fakeSubtitles{}
	ex := NewSubtitleExecutor(svc)
	step := subStep(`{"file":"${input.file}","language":"${input.lang}","speakers":"${input.n}","track":2,"names":"Anna, Ben,","style":"bracket","name":"wetter"}`)

	// läuft noch → Schritt wartet, Engine ruft erneut auf
	if _, err := ex.Execute(context.Background(), subCtx(), step); !errors.Is(err, ErrStepWaiting) {
		t.Fatalf("erwartet ErrStepWaiting, bekam %v", err)
	}
	c := svc.calls[0]
	if c.File != "/m/wetter.mxf" || c.Language != "en" || c.Speakers != 3 || c.Track != 2 || len(c.Names) != 2 || c.Names[1] != "Ben" || c.Style != "bracket" || c.Name != "wetter" {
		t.Fatalf("Konfiguration = %+v", c)
	}
	if svc.keys[0] != "ex9:s1" {
		t.Fatalf("Schlüssel = %q (Ausführung:Schritt, damit ein Neustart keinen zweiten Auftrag anlegt)", svc.keys[0])
	}

	svc.done = true
	out, err := ex.Execute(context.Background(), subCtx(), step)
	if err != nil {
		t.Fatal(err)
	}
	var res SubtitleStepResult
	if json.Unmarshal(out, &res) != nil || res.SRT != "/d/a.srt" || res.Speakers != 2 || res.Cues != 7 {
		t.Fatalf("Ausgabe = %s", out)
	}
}

func TestSubtitleStepNamesAsListAndDefaults(t *testing.T) {
	svc := &fakeSubtitles{done: true}
	ex := NewSubtitleExecutor(svc)
	if _, err := ex.Execute(context.Background(), subCtx(), subStep(`{"assetId":"A1","names":["Anna","","Ben"]}`)); err != nil {
		t.Fatal(err)
	}
	c := svc.calls[0]
	if c.AssetID != "A1" || c.Speakers != 0 || c.Track != 0 || len(c.Names) != 2 {
		t.Fatalf("Standardwerte = %+v", c)
	}
}

func TestSubtitleStepRejectsMissingSourceBadNumbersAndServiceErrors(t *testing.T) {
	svc := &fakeSubtitles{}
	ex := NewSubtitleExecutor(svc)
	for _, cfg := range []string{`{}`, `{"file":"/a","speakers":"viele"}`, `{"file":"/a","track":"x"}`, `{"file":"${nope.x}"}`, `kein json`} {
		if _, err := ex.Execute(context.Background(), subCtx(), subStep(cfg)); err == nil || errors.Is(err, ErrStepWaiting) {
			t.Errorf("%s: erwartet Fehler, bekam %v", cfg, err)
		}
	}
	if len(svc.calls) != 0 {
		t.Fatal("bei ungültiger Konfiguration darf der Dienst nicht gerufen werden")
	}
	svc.err = errors.New("kein Untertitel-Node")
	if _, err := ex.Execute(context.Background(), subCtx(), subStep(`{"file":"/a"}`)); err == nil || !strings.Contains(err.Error(), "kein Untertitel-Node") {
		t.Fatalf("Dienstfehler: %v", err)
	}
}
