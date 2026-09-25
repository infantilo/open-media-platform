// Package ffmpegtools führt das lokal installierte ffmpeg/ffprobe nach
// seinen tatsächlichen Fähigkeiten (Encoder/Decoder/Formate/Pixel-
// formate/Filter, je Encoder/Muxer/Filter deren AVOptions inkl.
// Hilfetext/erlaubten Werten) — Grundlage für den geführten
// Wizard/Filter-Builder aus UMSETZUNG.md Kapitel 22 (W1), damit dessen
// UI keine statisch gepflegte, schnell veraltende Parameterliste
// braucht. Reine Introspektion, kein Aufruf, der irgendetwas encodiert
// — Ausführung bleibt beim bestehenden `script`-Workflow-Schritt
// (orchestrator/internal/process, gleiche Allow-Liste wie main.go).
package ffmpegtools

// CodecEntry ist eine Zeile aus `ffmpeg -encoders`/`-decoders`.
type CodecEntry struct {
	Name        string `json:"name"`
	Description string `json:"description"`
	MediaType   string `json:"mediaType"` // "video" | "audio" | "subtitle" | ""
	Flags       string `json:"flags"`
}

// FormatEntry ist eine Zeile aus `ffmpeg -formats`.
type FormatEntry struct {
	Name        string `json:"name"`
	Description string `json:"description"`
	Demuxing    bool   `json:"demuxing"`
	Muxing      bool   `json:"muxing"`
}

// PixFmtEntry ist eine Zeile aus `ffmpeg -pix_fmts`.
type PixFmtEntry struct {
	Name          string `json:"name"`
	NumComponents int    `json:"numComponents"`
	BitsPerPixel  int    `json:"bitsPerPixel"`
	BitDepths     string `json:"bitDepths,omitempty"`
	Input         bool   `json:"input"`
	Output        bool   `json:"output"`
	HardwareAccel bool   `json:"hardwareAccel"`
	Paletted      bool   `json:"paletted"`
	Bitstream     bool   `json:"bitstream"`
}

// FilterEntry ist eine Zeile aus `ffmpeg -filters`.
type FilterEntry struct {
	Name            string `json:"name"`
	Description     string `json:"description"`
	IO              string `json:"io"` // z.B. "A->A", "V->V", "N->N", "|->V" (Source/Sink)
	TimelineSupport bool   `json:"timelineSupport"`
	SliceThreading  bool   `json:"sliceThreading"`
	CommandSupport  bool   `json:"commandSupport"`
}

// OptionChoice ist ein Enum-Wert eines Option (die eingerückten
// Unterzeilen unter einer AVOption in `-h encoder=X`/`-h filter=X`/
// `-h muxer=X`, z.B. die möglichen `-preset`-Werte von libx264).
type OptionChoice struct {
	Name        string `json:"name"`
	Value       string `json:"value,omitempty"`
	Description string `json:"description,omitempty"`
}

// Option ist eine AVOption (ein einstellbarer Parameter) eines Encoders/
// Decoders/Muxers/Demuxers/Filters, wie `-h <kind>=<name>` sie
// beschreibt — genau das Wissen, das der Wizard heute fehlt (rohe
// Textfelder statt gültiger Werte + Hilfetext).
type Option struct {
	Name        string         `json:"name"`
	Type        string         `json:"type"` // "string","int","int64","float","double","boolean","dictionary","flags","rational","binary","image_size","video_rate","color","duration","channel_layout","dictionary",...
	Flags       string         `json:"flags"`
	Description string         `json:"description,omitempty"`
	Default     string         `json:"default,omitempty"`
	Min         string         `json:"min,omitempty"`
	Max         string         `json:"max,omitempty"`
	Choices     []OptionChoice `json:"choices,omitempty"`
}

// Kind benennt, wonach `-h <kind>=<name>` fragt — bewusst eine enge
// Allow-Liste statt eines freien Strings (Hygiene, s. ValidKind).
type Kind string

const (
	KindEncoder Kind = "encoder"
	KindDecoder Kind = "decoder"
	KindMuxer   Kind = "muxer"
	KindDemuxer Kind = "demuxer"
	KindFilter  Kind = "filter"
)

// ValidKind meldet, ob kind eine von `ffmpeg -h <kind>=<name>`
// unterstützte Kategorie ist.
func ValidKind(kind string) bool {
	switch Kind(kind) {
	case KindEncoder, KindDecoder, KindMuxer, KindDemuxer, KindFilter:
		return true
	default:
		return false
	}
}

// Detail ist das Ergebnis von `ffmpeg -h <kind>=<name>` — Kurzbeschreibung
// (sofern vorhanden) plus die geparsten AVOptions.
type Detail struct {
	Name        string   `json:"name"`
	Description string   `json:"description,omitempty"`
	Options     []Option `json:"options"`
}
