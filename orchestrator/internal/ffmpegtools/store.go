package ffmpegtools

import (
	"context"
	"fmt"
	"os/exec"
	"strings"
	"sync"
	"time"
)

// runTimeout begrenzt jeden ffmpeg-Introspektions-Aufruf — reine
// Selbstauskunft (`-encoders`/`-h ...`), sollte in Millisekunden
// antworten; ein Timeout ist nur ein Sicherheitsnetz gegen einen
// hängenden/kaputten Binary-Aufruf, kein erwarteter Normalfall.
const runTimeout = 5 * time.Second

// Store cached ffmpegs Introspektionsergebnisse für die Prozesslaufzeit
// des Orchestrators — die Fähigkeiten eines auf dem Host installierten
// ffmpeg ändern sich nicht, solange der Prozess läuft, ein Neu-Parsen
// je Anfrage wäre nur unnötige Prozess-Spawns. Die vier Listen werden
// gemeinsam beim ersten Zugriff geladen (ein Vorbeifahren an fünf
// `ffmpeg`-Aufrufen ist günstig genug für "beim ersten Request"); Details
// je Encoder/Muxer/Filter dagegen NUR on demand (das wären sonst
// hunderte Prozessaufrufe beim Start).
type Store struct {
	ffmpegPath string // "" wenn ffmpeg auf diesem Host nicht in der Allow-Liste steht

	listOnce sync.Once
	listErr  error
	encoders []CodecEntry
	decoders []CodecEntry
	formats  []FormatEntry
	pixFmts  []PixFmtEntry
	filters  []FilterEntry

	detailMu sync.Mutex
	details  map[string]*Detail

	// `-h full` ist eine eigene, deutlich teurere Abfrage (~15000 Zeilen,
	// der Großteil davon die pro-Encoder-AVOptions-Wiederholung, die wir
	// gar nicht brauchen) — bewusst NICHT Teil von ensureLists() oben,
	// eigenes Once/Cache, nur bei tatsächlichem Bedarf (Kapitel 23,
	// Schritt 5) geladen.
	globalOnce    sync.Once
	globalErr     error
	globalOptions []GlobalOption
}

// NewStore nimmt den bereits von main.go per exec.LookPath aufgelösten
// ffmpeg-Pfad entgegen (dieselbe Allow-Liste wie der `script`-Workflow-
// Schritt, s. ARCHITECTURE.md §26.1) — nie selbst raten/im PATH suchen.
// ffmpegPath == "" macht Store nutzbar, aber Available() meldet false.
func NewStore(ffmpegPath string) *Store {
	return &Store{ffmpegPath: ffmpegPath, details: make(map[string]*Detail)}
}

// Available meldet, ob ffmpeg auf diesem Host in der Allow-Liste steht.
func (s *Store) Available() bool { return s.ffmpegPath != "" }

func (s *Store) run(args ...string) (string, error) {
	if s.ffmpegPath == "" {
		return "", fmt.Errorf("ffmpegtools: ffmpeg ist auf diesem Host nicht in der Allow-Liste")
	}
	ctx, cancel := context.WithTimeout(context.Background(), runTimeout)
	defer cancel()
	// ffmpeg -encoders/-decoders/-formats/-pix_fmts/-filters/-h liefern
	// ihre Ausgabe bei Erfolg auf stdout mit Exit-Code 0 (live geprüft,
	// nicht geraten) — kein stderr-Fallback wie bei manchen anderen
	// ffmpeg-Aufrufmustern im Projekt nötig.
	out, err := exec.CommandContext(ctx, s.ffmpegPath, args...).Output()
	if err != nil {
		return "", fmt.Errorf("ffmpegtools: %s %s: %w", s.ffmpegPath, strings.Join(args, " "), err)
	}
	return string(out), nil
}

func (s *Store) ensureLists() error {
	s.listOnce.Do(func() {
		if !s.Available() {
			s.listErr = fmt.Errorf("ffmpegtools: ffmpeg ist auf diesem Host nicht in der Allow-Liste")
			return
		}
		type job struct {
			args []string
			fn   func(string)
		}
		jobs := []job{
			{[]string{"-hide_banner", "-encoders"}, func(out string) { s.encoders = ParseCodecs(out) }},
			{[]string{"-hide_banner", "-decoders"}, func(out string) { s.decoders = ParseCodecs(out) }},
			{[]string{"-hide_banner", "-formats"}, func(out string) { s.formats = ParseFormats(out) }},
			{[]string{"-hide_banner", "-pix_fmts"}, func(out string) { s.pixFmts = ParsePixFmts(out) }},
			{[]string{"-hide_banner", "-filters"}, func(out string) { s.filters = ParseFilters(out) }},
		}
		for _, j := range jobs {
			out, err := s.run(j.args...)
			if err != nil {
				s.listErr = err
				return
			}
			j.fn(out)
		}
	})
	return s.listErr
}

func (s *Store) Encoders() ([]CodecEntry, error) {
	if err := s.ensureLists(); err != nil {
		return nil, err
	}
	return s.encoders, nil
}

func (s *Store) Decoders() ([]CodecEntry, error) {
	if err := s.ensureLists(); err != nil {
		return nil, err
	}
	return s.decoders, nil
}

func (s *Store) Formats() ([]FormatEntry, error) {
	if err := s.ensureLists(); err != nil {
		return nil, err
	}
	return s.formats, nil
}

func (s *Store) PixFmts() ([]PixFmtEntry, error) {
	if err := s.ensureLists(); err != nil {
		return nil, err
	}
	return s.pixFmts, nil
}

func (s *Store) Filters() ([]FilterEntry, error) {
	if err := s.ensureLists(); err != nil {
		return nil, err
	}
	return s.filters, nil
}

// GlobalOptions liefert die globalen/dateiübergreifenden CLI-Flags aus
// `ffmpeg -h full` (Kapitel 23, Schritt 5) — der in W1 bewusst
// ausgelassene Scope-Schnitt (s. ParseGlobalOptions-Moduldoku), einmalig
// pro Prozesslaufzeit geladen wie ensureLists(), aber separat gecached
// (eigener, deutlich teurerer Aufruf).
func (s *Store) GlobalOptions() ([]GlobalOption, error) {
	s.globalOnce.Do(func() {
		if !s.Available() {
			s.globalErr = fmt.Errorf("ffmpegtools: ffmpeg ist auf diesem Host nicht in der Allow-Liste")
			return
		}
		out, err := s.run("-hide_banner", "-h", "full")
		if err != nil {
			s.globalErr = err
			return
		}
		s.globalOptions = ParseGlobalOptions(out)
	})
	return s.globalOptions, s.globalErr
}

// Detail liefert `ffmpeg -h <kind>=<name>`, gecached je (kind,name) —
// erst beim ersten tatsächlichen Bedarf abgefragt (ein Wizard-Nutzer
// öffnet nie mehr als eine Handvoll Encoder/Filter pro Sitzung, alle
// vorab abzufragen wäre hunderte unnötige Prozessaufrufe).
func (s *Store) Detail(kind, name string) (*Detail, error) {
	if !ValidKind(kind) {
		return nil, fmt.Errorf("ffmpegtools: unbekannte Kategorie %q", kind)
	}
	if !s.Available() {
		return nil, fmt.Errorf("ffmpegtools: ffmpeg ist auf diesem Host nicht in der Allow-Liste")
	}
	key := kind + ":" + name

	s.detailMu.Lock()
	if d, ok := s.details[key]; ok {
		s.detailMu.Unlock()
		return d, nil
	}
	s.detailMu.Unlock()

	out, err := s.run("-hide_banner", "-h", kind+"="+name)
	if err != nil {
		return nil, err
	}
	detail := ParseDetail(name, out)

	s.detailMu.Lock()
	s.details[key] = detail
	s.detailMu.Unlock()
	return detail, nil
}
