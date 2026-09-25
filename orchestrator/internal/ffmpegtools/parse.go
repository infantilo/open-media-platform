package ffmpegtools

import (
	"regexp"
	"strconv"
	"strings"
)

// Alle Parser hier arbeiten Token-basiert (strings.Fields) statt über
// feste Spaltenbreiten — `ffmpeg`-Ausgaben richten Namen/Werte nur bis
// zu einer MINDESTBREITE aus und überschreiten sie klaglos bei langen
// Namen (live an echter `ffmpeg -h encoder=libx264`-Ausgabe geprüft,
// z. B. `autovariance-biased 3            E..V....... …` — nur EIN
// Leerzeichen statt der sonst üblichen Auffüllung). Eine
// spaltenpositions-basierte Regex würde bei genau solchen Zeilen
// stillschweigend falsch parsen.

// looksLikeFlags erkennt ein Flags-Token wie `V....D`, `..C`, `E..V.......`
// — nur Großbuchstaben und Punkte, mindestens ein Buchstabe (rein
// zeichenbasiert, nicht positionsbasiert, damit unterschiedliche
// ffmpeg-Versionen mit abweichender Flaganzahl nicht brechen).
func looksLikeFlags(tok string) bool {
	if len(tok) < 2 {
		return false
	}
	hasLetter := false
	for _, r := range tok {
		switch {
		case r == '.':
		case r >= 'A' && r <= 'Z':
			hasLetter = true
		default:
			return false
		}
	}
	return hasLetter
}

// looksLikeCharsetFlags ist looksLikeFlags, aber auf ein enges
// Alphabet beschränkt (z. B. nur `I`/`O`/`H`/`P`/`B`/`.` für
// Pixelformate) — verhindert, dass eine zufällig ähnlich aussehende
// erste Spalte fälschlich als Flags-Spalte gilt.
func looksLikeCharsetFlags(tok string, alphabet string) bool {
	if tok == "" {
		return false
	}
	for _, r := range tok {
		if !strings.ContainsRune(alphabet, r) {
			return false
		}
	}
	return true
}

// ParseCodecs parst `ffmpeg -encoders`/`-decoders` (identisches Format).
func ParseCodecs(output string) []CodecEntry {
	var out []CodecEntry
	for _, line := range strings.Split(output, "\n") {
		tokens := strings.Fields(line)
		if len(tokens) < 2 || tokens[1] == "=" {
			continue
		}
		flags := tokens[0]
		if !looksLikeFlags(flags) {
			continue
		}
		mediaType := ""
		switch flags[0] {
		case 'V':
			mediaType = "video"
		case 'A':
			mediaType = "audio"
		case 'S':
			mediaType = "subtitle"
		}
		out = append(out, CodecEntry{
			Name:        tokens[1],
			Description: strings.Join(tokens[2:], " "),
			MediaType:   mediaType,
			Flags:       flags,
		})
	}
	return out
}

// ParseFormats parst `ffmpeg -formats`. Die Flags-Spalte ist immer
// genau eine von "D"/"E"/"DE" (Leerstellen fallen beim Tokenisieren
// weg) — anders als bei Codecs/Filtern/Pixelformaten reicht daher eine
// exakte statt einer zeichenbasierten Prüfung.
func ParseFormats(output string) []FormatEntry {
	var out []FormatEntry
	for _, line := range strings.Split(output, "\n") {
		tokens := strings.Fields(line)
		if len(tokens) < 2 {
			continue
		}
		flags := tokens[0]
		if flags != "D" && flags != "E" && flags != "DE" {
			continue
		}
		out = append(out, FormatEntry{
			Name:        tokens[1],
			Description: strings.Join(tokens[2:], " "),
			Demuxing:    strings.Contains(flags, "D"),
			Muxing:      strings.Contains(flags, "E"),
		})
	}
	return out
}

const pixFmtFlagAlphabet = "IOHPB."

// ParsePixFmts parst `ffmpeg -pix_fmts`.
func ParsePixFmts(output string) []PixFmtEntry {
	var out []PixFmtEntry
	for _, line := range strings.Split(output, "\n") {
		tokens := strings.Fields(line)
		if len(tokens) < 2 || tokens[1] == "=" {
			continue
		}
		flags := tokens[0]
		if !looksLikeCharsetFlags(flags, pixFmtFlagAlphabet) {
			continue
		}
		entry := PixFmtEntry{
			Name:          tokens[1],
			Input:         strings.ContainsRune(flags, 'I'),
			Output:        strings.ContainsRune(flags, 'O'),
			HardwareAccel: strings.ContainsRune(flags, 'H'),
			Paletted:      strings.ContainsRune(flags, 'P'),
			Bitstream:     strings.ContainsRune(flags, 'B'),
		}
		if len(tokens) >= 3 {
			entry.NumComponents, _ = strconv.Atoi(tokens[2])
		}
		if len(tokens) >= 4 {
			entry.BitsPerPixel, _ = strconv.Atoi(tokens[3])
		}
		if len(tokens) >= 5 {
			entry.BitDepths = tokens[4]
		}
		out = append(out, entry)
	}
	return out
}

const filterFlagAlphabet = "TSC."

// ParseFilters parst `ffmpeg -filters`.
func ParseFilters(output string) []FilterEntry {
	var out []FilterEntry
	for _, line := range strings.Split(output, "\n") {
		tokens := strings.Fields(line)
		if len(tokens) < 3 || tokens[1] == "=" {
			continue
		}
		flags := tokens[0]
		if !looksLikeCharsetFlags(flags, filterFlagAlphabet) {
			continue
		}
		out = append(out, FilterEntry{
			Name:            tokens[1],
			IO:              tokens[2],
			Description:     strings.Join(tokens[3:], " "),
			TimelineSupport: strings.ContainsRune(flags, 'T'),
			SliceThreading:  strings.ContainsRune(flags, 'S'),
			CommandSupport:  strings.ContainsRune(flags, 'C'),
		})
	}
	return out
}

var (
	typeTokenRe = regexp.MustCompile(`^<(\w+)>$`)
	fromToRe    = regexp.MustCompile(`\(from (\S+) to (\S+)\)`)
	defaultRe   = regexp.MustCompile(`\(default (.*?)\)`)
)

// isDetailFlagsToken ist wie looksLikeFlags, aber mit Mindestlänge 3 —
// die AVOption-Flags-Spalte (z. B. `E..V.......`) ist nie kürzer,
// während ein 2-Zeichen-Enum-Namenskürzel zufällig sonst mitgezählt
// werden könnte.
func isDetailFlagsToken(tok string) bool {
	return len(tok) >= 3 && looksLikeFlags(tok)
}

// splitOptionRest trennt "(from X to Y)" und "(default Z)" aus dem Rest
// einer AVOption-Zeile heraus; was übrig bleibt, ist die eigentliche
// Beschreibung.
func splitOptionRest(rest string) (desc, def, min, max string) {
	if m := fromToRe.FindStringSubmatch(rest); m != nil {
		min, max = m[1], m[2]
		rest = fromToRe.ReplaceAllString(rest, "")
	}
	if m := defaultRe.FindStringSubmatch(rest); m != nil {
		def = m[1]
		rest = defaultRe.ReplaceAllString(rest, "")
	}
	return strings.TrimSpace(rest), def, min, max
}

// extractDetailDescription liest die Kurzbeschreibung aus `-h
// <kind>=<name>`s ersten Zeilen — Encoder/Decoder/Muxer/Demuxer tragen
// sie in `Kind name [Beschreibung]:` auf Zeile 1, Filter stattdessen
// als eigene Prosa-Zeile direkt danach (`Filter name` + Beschreibung
// erst auf Zeile 2, sofern vorhanden — s. reale `-h filter=scale`-
// Ausgabe).
func extractDetailDescription(lines []string) string {
	if len(lines) == 0 {
		return ""
	}
	if idx := strings.Index(lines[0], "["); idx != -1 {
		if end := strings.LastIndex(lines[0], "]"); end > idx {
			return lines[0][idx+1 : end]
		}
	}
	if len(lines) > 1 {
		trimmed := strings.TrimSpace(lines[1])
		if trimmed != "" && !strings.HasSuffix(trimmed, ":") {
			return trimmed
		}
	}
	return ""
}

// ParseDetail parst `ffmpeg -h <kind>=<name>` — die AVOptions-Liste
// eines Encoders/Decoders/Muxers/Demuxers/Filters, inkl. der
// eingerückten Enum-Unterzeilen (z. B. `-preset`s mögliche Werte bei
// libx264). name ist der bereits bekannte Name (aus dem Aufruf), nicht
// aus der Ausgabe re-geparst.
func ParseDetail(name, output string) *Detail {
	lines := strings.Split(output, "\n")
	detail := &Detail{Name: name, Description: extractDetailDescription(lines)}

	startIdx := -1
	for i, line := range lines {
		if strings.HasSuffix(strings.TrimSpace(line), "AVOptions:") {
			startIdx = i + 1
			break
		}
	}
	if startIdx == -1 {
		return detail // kein eigener AVOptions-Block (z.B. ein Muxer ohne Optionen)
	}

	currentIdx := -1
	for _, line := range lines[startIdx:] {
		if strings.TrimSpace(line) == "" {
			continue
		}
		tokens := strings.Fields(line)
		if len(tokens) < 2 {
			continue
		}

		if m := typeTokenRe.FindStringSubmatch(tokens[1]); m != nil {
			// Neue Top-Level-Option: `<name> <type> <flags> <rest>`.
			flagsIdx := -1
			for i := 2; i < len(tokens); i++ {
				if isDetailFlagsToken(tokens[i]) {
					flagsIdx = i
					break
				}
			}
			if flagsIdx == -1 {
				continue // unerwartetes Format — überspringen statt zu raten
			}
			desc, def, min, max := splitOptionRest(strings.Join(tokens[flagsIdx+1:], " "))
			detail.Options = append(detail.Options, Option{
				Name:        tokens[0],
				Type:        m[1],
				Flags:       tokens[flagsIdx],
				Description: desc,
				Default:     def,
				Min:         min,
				Max:         max,
			})
			currentIdx = len(detail.Options) - 1
			continue
		}

		// Sonst: eingerückte Enum-Unterzeile der zuletzt gesehenen
		// Top-Level-Option (`<name> [<wert>] <flags> [<beschreibung>]`,
		// der Wert fehlt bei rein symbolischen Enum-Einträgen).
		if currentIdx == -1 {
			continue
		}
		flagsIdx := -1
		for i := 1; i < len(tokens) && i <= 2; i++ {
			if isDetailFlagsToken(tokens[i]) {
				flagsIdx = i
				break
			}
		}
		if flagsIdx == -1 {
			continue
		}
		choice := OptionChoice{Name: tokens[0]}
		if flagsIdx == 2 {
			choice.Value = tokens[1]
		}
		choice.Description = strings.Join(tokens[flagsIdx+1:], " ")
		detail.Options[currentIdx].Choices = append(detail.Options[currentIdx].Choices, choice)
	}
	return detail
}
