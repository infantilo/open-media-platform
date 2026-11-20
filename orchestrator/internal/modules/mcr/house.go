package mcr

import (
	"encoding/json"
	"fmt"
	"strconv"
	"strings"
)

// Hausformat (UMSETZUNG 106.1/106.9, ARCHITECTURE §33 M3a): dasselbe JSON wie `HouseFormat` im Rust-Crate `omp-normalizer`.
// Es gibt keine festen Werte im Code; Vorgabe, Event und Leitung dürfen es jeweils (teilweise) setzen.

type VideoHouse struct {
	Width          int    `json:"width"`
	Height         int    `json:"height"`
	Rate           string `json:"rate"` // "25/1"
	Scan           string `json:"scan"` // progressive | interlaced_tff | interlaced_bff
	Colorspace     string `json:"colorspace,omitempty"`
	Transfer       string `json:"transfer,omitempty"`
	TransferPolicy string `json:"transferPolicy,omitempty"` // warn | block | map
}

type AudioGroup struct {
	Name     string `json:"name"`
	Channels []int  `json:"channels"`
}

type AudioHouse struct {
	SampleRate int          `json:"sampleRate"`
	Channels   int          `json:"channels"`
	Groups     []AudioGroup `json:"groups,omitempty"`
}

type HouseFormat struct {
	Video *VideoHouse `json:"video,omitempty"`
	Audio *AudioHouse `json:"audio,omitempty"`
}

// ParseHouse liest ein Hausformat; leer oder `null` gibt nil (= nicht gesetzt). Unbekannte Felder werden abgelehnt.
func ParseHouse(raw json.RawMessage) (*HouseFormat, error) {
	s := strings.TrimSpace(string(raw))
	if s == "" || s == "null" || s == "{}" {
		return nil, nil
	}
	var h HouseFormat
	dec := json.NewDecoder(strings.NewReader(s))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&h); err != nil {
		return nil, fmt.Errorf("Hausformat: %v", err)
	}
	if err := h.Validate(); err != nil {
		return nil, err
	}
	if h.Video == nil && h.Audio == nil {
		return nil, nil
	}
	return &h, nil
}

func parseRate(s string) (num, den int, err error) {
	a, b, ok := strings.Cut(s, "/")
	if !ok {
		b = "1"
	}
	num, e1 := strconv.Atoi(strings.TrimSpace(a))
	den, e2 := strconv.Atoi(strings.TrimSpace(b))
	if e1 != nil || e2 != nil || num <= 0 || den <= 0 {
		return 0, 0, fmt.Errorf("Hausformat: Bildrate „%s“ ungültig (erwartet z. B. 25/1, größer als 0)", s)
	}
	return num, den, nil
}

func (h HouseFormat) Validate() error {
	if v := h.Video; v != nil {
		if v.Width <= 0 || v.Height <= 0 {
			return fmt.Errorf("Hausformat: Bildgröße muss größer als 0 sein")
		}
		switch v.Scan {
		case "progressive", "interlaced_tff", "interlaced_bff":
		default:
			return fmt.Errorf("Hausformat: Raster „%s“ unbekannt (progressive, interlaced_tff, interlaced_bff)", v.Scan)
		}
		if strings.HasPrefix(v.Scan, "interlaced") && v.Height%2 != 0 {
			return fmt.Errorf("Hausformat: Zeilensprung braucht eine gerade Zeilenzahl")
		}
		if _, _, err := parseRate(v.Rate); err != nil {
			return err
		}
		switch v.TransferPolicy {
		case "", "warn", "block", "map":
		default:
			return fmt.Errorf("Hausformat: transferPolicy „%s“ unbekannt (warn, block, map)", v.TransferPolicy)
		}
	}
	if a := h.Audio; a != nil {
		if a.SampleRate < 8000 || a.SampleRate > 384000 {
			return fmt.Errorf("Hausformat: Abtastrate außerhalb 8000…384000 Hz")
		}
		if a.Channels < 1 || a.Channels > 64 {
			return fmt.Errorf("Hausformat: Kanalzahl muss 1…64 sein")
		}
		for _, g := range a.Groups {
			if strings.TrimSpace(g.Name) == "" {
				return fmt.Errorf("Hausformat: Tongruppe ohne Namen")
			}
			seen := map[int]bool{}
			for _, c := range g.Channels {
				if c < 1 || c > a.Channels {
					return fmt.Errorf("Hausformat: Gruppe „%s“ nennt Kanal %d außerhalb 1…%d", g.Name, c, a.Channels)
				}
				if seen[c] {
					return fmt.Errorf("Hausformat: Gruppe „%s“ nennt Kanal %d doppelt", g.Name, c)
				}
				seen[c] = true
			}
		}
	}
	return nil
}

// Effective: Vererbung Vorgabe → Event → Leitung, getrennt für Bild und Ton (die tiefere Ebene überstimmt).
func Effective(global, event, line *HouseFormat) HouseFormat {
	var out HouseFormat
	for _, h := range []*HouseFormat{global, event, line} {
		if h == nil {
			continue
		}
		if h.Video != nil {
			v := *h.Video
			out.Video = &v
		}
		if h.Audio != nil {
			a := *h.Audio
			out.Audio = &a
		}
	}
	return out
}
