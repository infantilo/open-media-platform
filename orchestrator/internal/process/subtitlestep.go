package process

import (
	"context"
	"encoding/json"
	"fmt"
	"strconv"
	"strings"
)

// StepTypeSubtitles erzeugt Untertitel (SRT) aus einer Mediendatei — mit Sprechererkennung (Kap. 77). Die Rechenarbeit macht ein
// Auto-Untertitel-Node; der Schritt reicht den Auftrag ein und wartet (ErrStepWaiting), bis er fertig ist. Ergebnis: Pfad der SRT,
// Name der Spur für das Kind-Event SUBTITLE der Playout-Automation, Anzahl Sprecher und Einheiten.
const StepTypeSubtitles StepType = "subtitles"

// SubtitleStepConfig ist die ausgewertete Konfiguration (alle ${…}-Ausdrücke sind ersetzt).
type SubtitleStepConfig struct {
	// File: absoluter Pfad der Mediendatei (auf dem Rechner des Untertitel-Nodes lesbar) — oder AssetID: dessen Quelle.
	File    string
	AssetID string
	Track   int
	// Language: „de“, „en“ … oder „auto“.
	Language string
	// Speakers: 1 = ohne Sprechernamen, 0 = Anzahl automatisch, ≥ 2 = feste Anzahl.
	Speakers int
	Names    []string
	Word     string
	// Style: colon | bracket | dash.
	Style string
	// Name: Dateiname der Spur (leer = aus dem Dateinamen).
	Name string
}

// SubtitleStepResult ist die Ausgabe des Schritts.
type SubtitleStepResult struct {
	SRT              string  `json:"srt"`
	Name             string  `json:"name"`
	PlayoutTrack     string  `json:"playoutTrack,omitempty"`
	RepresentationID string  `json:"representationId,omitempty"`
	Speakers         int     `json:"speakers"`
	Cues             int     `json:"cues"`
	DurationS        float64 `json:"durationS"`
	Warning          string  `json:"warning,omitempty"`
}

// SubtitleService verbindet den Schritt mit dem Untertitel-Node. Step wird je Poll aufgerufen: der erste Aufruf reicht den Auftrag ein
// (unter `key` = Ausführung + Schritt, damit ein Neustart der Engine keinen zweiten anlegt), die weiteren fragen den Zustand ab.
// done=false: läuft noch.
type SubtitleService interface {
	Step(ctx context.Context, key string, cfg SubtitleStepConfig) (res SubtitleStepResult, done bool, err error)
}

// subtitleStepConfig: Rohform mit möglichen ${…}-Ausdrücken. Zahlen dürfen als Zahl oder Text kommen.
type subtitleStepConfig struct {
	File     string          `json:"file"`
	AssetID  string          `json:"assetId"`
	Track    json.RawMessage `json:"track"`
	Language string          `json:"language"`
	Speakers json.RawMessage `json:"speakers"`
	Names    json.RawMessage `json:"names"`
	Word     string          `json:"word"`
	Style    string          `json:"style"`
	Name     string          `json:"name"`
}

// rawInt liest eine Zahl, die als Zahl oder Text („3“, „${…}“ schon ersetzt) vorliegen darf; leer = Vorgabe.
func rawInt(ev *Evaluator, vars map[string]any, raw json.RawMessage, def int) (int, error) {
	s := strings.TrimSpace(string(raw))
	if s == "" || s == "null" {
		return def, nil
	}
	s = strings.Trim(s, `"`)
	s, err := interpolate(ev, vars, s)
	if err != nil {
		return 0, err
	}
	s = strings.TrimSpace(s)
	if s == "" {
		return def, nil
	}
	n, err := strconv.Atoi(s)
	if err != nil {
		return 0, fmt.Errorf("%q ist keine ganze Zahl", s)
	}
	return n, nil
}

// NewSubtitleExecutor liefert den Executor für Untertitel-Schritte.
func NewSubtitleExecutor(svc SubtitleService) StepExecutor {
	ev := &Evaluator{}
	return StepExecutorFunc(func(ctx context.Context, ec ExecutionCtx, step Step) (json.RawMessage, error) {
		var raw subtitleStepConfig
		if err := json.Unmarshal(step.Config, &raw); err != nil {
			return nil, fmt.Errorf("process: step %q: invalid subtitles config: %w", step.ID, err)
		}
		vars := exprVars(ec)
		sub := func(s string) (string, error) {
			out, err := interpolate(ev, vars, s)
			return strings.TrimSpace(out), err
		}
		var cfg SubtitleStepConfig
		var err error
		for _, f := range []struct {
			in  string
			out *string
		}{{raw.File, &cfg.File}, {raw.AssetID, &cfg.AssetID}, {raw.Language, &cfg.Language}, {raw.Word, &cfg.Word}, {raw.Style, &cfg.Style}, {raw.Name, &cfg.Name}} {
			if *f.out, err = sub(f.in); err != nil {
				return nil, fmt.Errorf("process: step %q: %w", step.ID, err)
			}
		}
		if cfg.File == "" && cfg.AssetID == "" {
			return nil, fmt.Errorf("process: step %q: subtitles needs file or assetId", step.ID)
		}
		if cfg.Track, err = rawInt(ev, vars, raw.Track, 0); err != nil {
			return nil, fmt.Errorf("process: step %q: track: %w", step.ID, err)
		}
		if cfg.Speakers, err = rawInt(ev, vars, raw.Speakers, 0); err != nil {
			return nil, fmt.Errorf("process: step %q: speakers: %w", step.ID, err)
		}
		// Namen: Liste oder kommagetrennter Text
		if len(raw.Names) > 0 && string(raw.Names) != "null" {
			var list []string
			if json.Unmarshal(raw.Names, &list) != nil {
				var one string
				_ = json.Unmarshal(raw.Names, &one)
				list = strings.Split(one, ",")
			}
			for _, n := range list {
				n, err := sub(n)
				if err != nil {
					return nil, fmt.Errorf("process: step %q: names: %w", step.ID, err)
				}
				if n != "" {
					cfg.Names = append(cfg.Names, n)
				}
			}
		}
		res, done, err := svc.Step(ctx, ec.Execution.ID+":"+step.ID, cfg)
		if err != nil {
			return nil, fmt.Errorf("process: step %q: %w", step.ID, err)
		}
		if !done {
			return nil, ErrStepWaiting
		}
		return json.Marshal(res)
	})
}
