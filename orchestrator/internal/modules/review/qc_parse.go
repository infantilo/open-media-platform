package review

import (
	"math"
	"regexp"
	"strconv"
	"strings"
)

// Reine Parser für die Textausgaben von ffmpeg/ffprobe (ohne Prozessstart, damit sie mit festen Beispielen testbar sind).
// Die Formate stammen aus ffmpeg 5.1; ein Format, das sich ändert, führt zu „nicht ausgewertet“ statt zu falschem „bestanden“.

// Interval ist ein Zeitabschnitt in Sekunden (Stream-Zeitbasis). Open: das Ende wurde nicht gemeldet (läuft bis Dateiende).
type Interval struct {
	Start, End float64
	Open       bool
}

func (i Interval) Dur() float64 { return i.End - i.Start }

var (
	reBlack      = regexp.MustCompile(`black_start:\s*([0-9.]+)\s+black_end:\s*([0-9.]+)`)
	reFreezeSt   = regexp.MustCompile(`freeze_start:\s*([0-9.]+)`)
	reFreezeEnd  = regexp.MustCompile(`freeze_end:\s*([0-9.]+)`)
	reSilStart   = regexp.MustCompile(`silence_start:\s*(-?[0-9.]+)`)
	reSilEnd     = regexp.MustCompile(`silence_end:\s*(-?[0-9.]+)`)
	reIdet       = regexp.MustCompile(`Multi frame detection:\s*TFF:\s*(\d+)\s+BFF:\s*(\d+)\s+Progressive:\s*(\d+)\s+Undetermined:\s*(\d+)`)
	reLoudI      = regexp.MustCompile(`^\s*I:\s*(-?[0-9.]+|-?inf)\s+LUFS`)
	reLoudLRA    = regexp.MustCompile(`^\s*LRA:\s*(-?[0-9.]+|-?inf)\s+LU\b`)
	reLoudPeak   = regexp.MustCompile(`^\s*Peak:\s*(-?[0-9.]+|-?inf)\s+dBFS`)
	reAstatsPeak = regexp.MustCompile(`Peak level dB:\s*(-?[0-9.]+|-?inf)`)
	reAstatsN    = regexp.MustCompile(`Number of samples:\s*([0-9.]+)`)
	reAstatsBits = regexp.MustCompile(`Bit depth:\s*(\d+)/(\d+)`)
)

func num(s string) float64 {
	switch s {
	case "-inf":
		return math.Inf(-1)
	case "inf":
		return math.Inf(1)
	}
	f, err := strconv.ParseFloat(s, 64)
	if err != nil {
		return math.NaN()
	}
	return f
}

// IntervalParser sammelt Abschnitte zeilenweise (Black/Freeze/Silence).
type IntervalParser struct {
	Black   []Interval
	Freeze  []Interval
	Silence []Interval

	freezeOpen, silenceOpen *float64
}

func (p *IntervalParser) Line(line string) {
	switch {
	case strings.Contains(line, "black_start"):
		if m := reBlack.FindStringSubmatch(line); m != nil {
			p.Black = append(p.Black, Interval{Start: num(m[1]), End: num(m[2])})
		}
	case strings.Contains(line, "freeze_start"):
		if m := reFreezeSt.FindStringSubmatch(line); m != nil {
			v := num(m[1])
			p.freezeOpen = &v
		}
	case strings.Contains(line, "freeze_end"):
		if m := reFreezeEnd.FindStringSubmatch(line); m != nil && p.freezeOpen != nil {
			p.Freeze = append(p.Freeze, Interval{Start: *p.freezeOpen, End: num(m[1])})
			p.freezeOpen = nil
		}
	case strings.Contains(line, "silence_start"):
		if m := reSilStart.FindStringSubmatch(line); m != nil {
			v := num(m[1])
			if v < 0 {
				v = 0
			}
			p.silenceOpen = &v
		}
	case strings.Contains(line, "silence_end"):
		if m := reSilEnd.FindStringSubmatch(line); m != nil && p.silenceOpen != nil {
			p.Silence = append(p.Silence, Interval{Start: *p.silenceOpen, End: num(m[1])})
			p.silenceOpen = nil
		}
	}
}

// Finish schließt offene Abschnitte mit dem Dateiende ab (ffmpeg 5.1 meldet kein freeze_end/silence_end am Dateiende).
func (p *IntervalParser) Finish(end float64) {
	if p.freezeOpen != nil && end > *p.freezeOpen {
		p.Freeze = append(p.Freeze, Interval{Start: *p.freezeOpen, End: end, Open: true})
	}
	if p.silenceOpen != nil && end > *p.silenceOpen {
		p.Silence = append(p.Silence, Interval{Start: *p.silenceOpen, End: end, Open: true})
	}
	p.freezeOpen, p.silenceOpen = nil, nil
}

// Idet ist das Ergebnis der Halbbild-Erkennung.
type Idet struct{ TFF, BFF, Progressive, Undetermined int64 }

func (d Idet) Total() int64 { return d.TFF + d.BFF + d.Progressive + d.Undetermined }

// ParseIdet liest die letzte „Multi frame detection“-Zeile.
func ParseIdet(lines []string) (Idet, bool) {
	var out Idet
	found := false
	for _, l := range lines {
		if m := reIdet.FindStringSubmatch(l); m != nil {
			a, _ := strconv.ParseInt(m[1], 10, 64)
			b, _ := strconv.ParseInt(m[2], 10, 64)
			c, _ := strconv.ParseInt(m[3], 10, 64)
			d, _ := strconv.ParseInt(m[4], 10, 64)
			out, found = Idet{a, b, c, d}, true
		}
	}
	return out, found
}

// Loudness: EBU-R128-Zusammenfassung (ebur128-Filter, „Summary:“-Block am Ende).
type Loudness struct {
	IntegratedLUFS float64
	LRA            float64
	TruePeakDBFS   float64
}

// ParseLoudness liest den letzten Summary-Block; ok=false, wenn keiner vorhanden ist.
func ParseLoudness(lines []string) (Loudness, bool) {
	start := -1
	for i, l := range lines {
		if strings.Contains(l, "Summary:") {
			start = i
		}
	}
	if start < 0 {
		return Loudness{}, false
	}
	out := Loudness{IntegratedLUFS: math.NaN(), LRA: math.NaN(), TruePeakDBFS: math.NaN()}
	section := ""
	for _, l := range lines[start+1:] {
		t := strings.TrimSpace(l)
		switch {
		case strings.HasPrefix(t, "Integrated loudness"):
			section = "I"
		case strings.HasPrefix(t, "Loudness range"):
			section = "LRA"
		case strings.HasPrefix(t, "True peak"):
			section = "TP"
		}
		switch section {
		case "I":
			if m := reLoudI.FindStringSubmatch(l); m != nil {
				out.IntegratedLUFS = num(m[1])
			}
		case "LRA":
			if m := reLoudLRA.FindStringSubmatch(l); m != nil {
				out.LRA = num(m[1])
			}
		case "TP":
			if m := reLoudPeak.FindStringSubmatch(l); m != nil {
				out.TruePeakDBFS = num(m[1])
			}
		}
	}
	return out, !math.IsNaN(out.IntegratedLUFS) || !math.IsNaN(out.TruePeakDBFS)
}

// AudioStats: Gesamtwerte des astats-Filters.
type AudioStats struct {
	PeakDB                float64
	Samples               float64
	BitsUsed, BitsNominal int
}

// ParseAstats liest das letzte „Peak level dB“ (Overall-Block steht am Ende).
func ParseAstats(lines []string) (AudioStats, bool) {
	out := AudioStats{PeakDB: math.NaN()}
	ok := false
	for _, l := range lines {
		if !strings.Contains(l, "astats") {
			continue
		}
		if m := reAstatsPeak.FindStringSubmatch(l); m != nil {
			out.PeakDB, ok = num(m[1]), true
		}
		if m := reAstatsN.FindStringSubmatch(l); m != nil {
			out.Samples = num(m[1])
		}
		if m := reAstatsBits.FindStringSubmatch(l); m != nil {
			out.BitsUsed, _ = strconv.Atoi(m[1])
			out.BitsNominal, _ = strconv.Atoi(m[2])
		}
	}
	return out, ok
}
