package files

import (
	"encoding/json"
	"fmt"
	"path/filepath"
	"strings"
	"time"
)

// planItem ist ein Medienbezug aus dem Zustand eines Playout-Kanals (Snapshot des Automators).
type planItem struct {
	Channel  string
	Label    string
	Path     string // Datei (absolut oder relativ zum Medienverzeichnis des Players)
	AssetID  string // alternativ: Asset-Referenz
	Fallback bool   // Ersatzdatei (fallbackFile)
	StartMs  int64  // 0 = unbekannt
	EndMs    int64  // 0 = unbekannt
	Aired    bool   // bereits gesendet (oder übersprungen)
	OnAir    bool
	Cart     bool
}

type snapMeta struct {
	Label string `json:"label"`
	Media struct {
		Kind string `json:"kind"`
		Path string `json:"path"`
	} `json:"media"`
	DurationMs uint64 `json:"duration_ms"`
	StartAtMs  *int64 `json:"start_at_utc_ms"`
	Asset      *struct {
		AssetID string `json:"assetId"`
	} `json:"asset"`
	FallbackFile *string `json:"fallbackFile"`
}

type snapshot struct {
	Items []struct {
		ID   string   `json:"id"`
		Meta snapMeta `json:"meta"`
	} `json:"items"`
	Carts []struct {
		ID   string   `json:"id"`
		Meta snapMeta `json:"meta"`
	} `json:"carts"`
	CurrentIndex *int  `json:"current_index"`
	OnAir        bool  `json:"on_air"`
	OnairUTCMs   int64 `json:"onair_utc_ms"`
}

// extractPlans liest die Medienbezüge eines Kanal-Snapshots und schätzt Beginn/Ende je Eintrag:
// fester Startzeitpunkt (Fixtime) gilt; sonst aus dem Beginn des laufenden Eintrags (onair_utc_ms) vorwärts/rückwärts über die
// Dauern; ohne Sendung dient der Zeitpunkt der letzten Zustandsänderung als Ende des zuletzt gesendeten Eintrags.
func extractPlans(channel string, raw []byte, updatedMs int64) []planItem {
	var s snapshot
	if err := json.Unmarshal(raw, &s); err != nil {
		return nil
	}
	n := len(s.Items)
	cur := -1
	if s.CurrentIndex != nil && *s.CurrentIndex >= 0 && *s.CurrentIndex < n {
		cur = *s.CurrentIndex
	}
	start := make([]int64, n)
	end := make([]int64, n)
	dur := func(i int) int64 { return int64(s.Items[i].Meta.DurationMs) }
	if cur >= 0 {
		base := s.OnairUTCMs
		if s.OnAir && base > 0 {
			start[cur], end[cur] = base, base+dur(cur)
			for i := cur + 1; i < n; i++ {
				start[i] = end[i-1]
				end[i] = start[i] + dur(i)
			}
		}
		prevEnd := base
		if !(s.OnAir && base > 0) {
			prevEnd = updatedMs
		}
		for i := cur - 1; i >= 0; i-- {
			end[i] = prevEnd
			start[i] = prevEnd - dur(i)
			prevEnd = start[i]
		}
	}
	var out []planItem
	add := func(i int, m snapMeta, cart bool) {
		p := planItem{Channel: channel, Label: m.Label, Cart: cart}
		if !cart {
			p.StartMs, p.EndMs = start[i], end[i]
			if m.StartAtMs != nil && *m.StartAtMs > 0 { // fester Startzeitpunkt hat Vorrang
				p.StartMs = *m.StartAtMs
				p.EndMs = p.StartMs + dur(i)
			}
			if cur >= 0 {
				p.Aired = i < cur
				p.OnAir = s.OnAir && i == cur
			}
		}
		if p.Label == "" {
			p.Label = m.Media.Path
		}
		if m.Media.Kind == "file" || m.Media.Kind == "image" {
			q := p
			q.Path = m.Media.Path
			if q.Path != "" {
				out = append(out, q)
			}
		}
		if m.Asset != nil && m.Asset.AssetID != "" {
			q := p
			q.AssetID = m.Asset.AssetID
			out = append(out, q)
		}
		if m.FallbackFile != nil && *m.FallbackFile != "" {
			q := p
			q.Path, q.Fallback = *m.FallbackFile, true
			q.Aired, q.OnAir = false, false // Ersatz wird nur im Notfall gespielt: gilt als verplant
			out = append(out, q)
		}
	}
	for i, it := range s.Items {
		add(i, it.Meta, false)
	}
	for i, c := range s.Carts {
		add(i, c.Meta, true)
	}
	return out
}

// pathMatches: ein Playout-Pfad (absolut oder relativ zum Medienverzeichnis) meint die absolute Datei abs.
func pathMatches(planPath, abs string) bool {
	if planPath == "" {
		return false
	}
	p := filepath.Clean(planPath)
	if filepath.IsAbs(p) {
		return p == filepath.Clean(abs)
	}
	abs = filepath.Clean(abs)
	return abs == p || strings.HasSuffix(abs, string(filepath.Separator)+p)
}

// Level der Sperre.
const (
	levelNone = iota
	levelSoft
	levelHard
	levelAbsolute
)

func fmtT(ms int64) string {
	return time.UnixMilli(ms).Local().Format("02.01. 15:04")
}

// lockLevel bewertet EINEN Planbezug (E4): läuft gerade → absolut; Sperrfenster [Beginn−vor, Ende+nach] → hart; solange noch
// verplant und nicht gesendet → hart (plannedIsHard) bzw. weich, wenn der Beginn noch außerhalb des Fensters liegt; nach der Sendung
// → hart bis Ende+nach, danach frei. Unbekannte Zeiten werden vorsichtig als „verplant“ behandelt.
func lockLevel(p planItem, now time.Time, before, after time.Duration, plannedIsHard bool) (int, string) {
	nowMs := now.UnixMilli()
	where := p.Channel
	if p.Label != "" {
		where += " · " + p.Label
	}
	switch {
	case p.OnAir:
		return levelAbsolute, fmt.Sprintf("läuft gerade auf Sendung (%s)", where)
	case p.Aired:
		if p.EndMs > 0 && nowMs <= p.EndMs+after.Milliseconds() {
			return levelHard, fmt.Sprintf("kürzlich gesendet (%s), gesperrt bis %s", where, fmtT(p.EndMs+after.Milliseconds()))
		}
		return levelNone, ""
	}
	// noch nicht gesendet: verplant
	if p.StartMs > 0 {
		if nowMs >= p.StartMs-before.Milliseconds() {
			return levelHard, fmt.Sprintf("beginnt %s (%s) — im Sperrfenster", fmtT(p.StartMs), where)
		}
		if plannedIsHard {
			return levelHard, fmt.Sprintf("verplant für %s (%s)", fmtT(p.StartMs), where)
		}
		return levelSoft, fmt.Sprintf("verplant für %s (%s)", fmtT(p.StartMs), where)
	}
	if plannedIsHard {
		return levelHard, fmt.Sprintf("in der Playlist verplant (%s)", where)
	}
	return levelSoft, fmt.Sprintf("in der Playlist verplant (%s)", where)
}
