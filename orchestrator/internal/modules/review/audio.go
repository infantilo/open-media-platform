package review

import (
	"context"
	"encoding/binary"
	"fmt"
	"math"
	"os"
	"strconv"
)

// Ton-Blöcke für den Review-Player (Scrub-Ton bei Jog/Shuttle, Spurwahl): der Browser holt je Tonspur Blöcke von
// AudioBlockSeconds Sekunden als 16-Bit-WAV (48 kHz, Stereo) und spielt sie über Web Audio — vorwärts, rückwärts und in
// kurzen Stücken beim Einzelbildschritt. Block b einer Spur beginnt bei b·AudioBlockSeconds (bildgenau zum Proxy, weil der
// Ton-Proxy auf die Bildlänge aufgefüllt ist).
const (
	AudioBlockSeconds = 10
	audioRate         = 48000
	audioChannels     = 2
)

// AudioBlock liefert Block `block` der Tonspur `track` (0-basiert) als vollständige WAV-Datei. Hinter dem Ende entsteht ein
// kürzerer Block, ein Block ganz hinter dem Ende ist ein Fehler (ErrValidation).
func (s *Service) AudioBlock(ctx context.Context, assetID string, track, block int) ([]byte, error) {
	_, p, err := s.ProxyFile(ctx, assetID)
	if err != nil {
		return nil, err
	}
	if p.AudioTracks == 0 || p.AudioPath == "" {
		return nil, ErrNotFound
	}
	if _, err := os.Stat(p.AudioPath); err != nil {
		return nil, ErrNotFound
	}
	if track < 0 || track >= p.AudioTracks {
		return nil, fmt.Errorf("%w: Tonspur %d außerhalb [0,%d)", ErrValidation, track, p.AudioTracks)
	}
	total := float64(p.Frames) * float64(p.Rate.Den) / float64(p.Rate.Num)
	start := float64(block * AudioBlockSeconds)
	if block < 0 || start >= total {
		return nil, fmt.Errorf("%w: Block %d außerhalb der Länge", ErrValidation, block)
	}
	length := float64(AudioBlockSeconds)
	if start+length > total {
		length = total - start
	}
	pcm, code, err := s.Tools.ExecProxy().Run(ctx, s.Tools.FFmpeg, []string{"-nostdin", "-v", "error",
		"-ss", strconv.FormatFloat(start, 'f', 6, 64), "-t", strconv.FormatFloat(length, 'f', 6, 64), "-i", p.AudioPath,
		"-map", fmt.Sprintf("0:a:%d", track), "-f", "s16le", "-acodec", "pcm_s16le", "-ar", strconv.Itoa(audioRate), "-ac", strconv.Itoa(audioChannels), "-"}, nil)
	if err != nil {
		return nil, err
	}
	if code != 0 || len(pcm) == 0 {
		return nil, fmt.Errorf("Tonblock nicht lesbar")
	}
	return wavFromPCM16(pcm, audioRate, audioChannels), nil
}

// wavFromPCM16 setzt einen 44-Byte-WAV-Kopf mit exakten Längen vor rohe 16-Bit-Daten (Stream-WAV mit unbekannter Länge
// dekodieren nicht alle Browser).
func wavFromPCM16(pcm []byte, rate, ch int) []byte {
	out := make([]byte, 44+len(pcm))
	copy(out[0:], "RIFF")
	binary.LittleEndian.PutUint32(out[4:], uint32(36+len(pcm)))
	copy(out[8:], "WAVEfmt ")
	binary.LittleEndian.PutUint32(out[16:], 16)
	binary.LittleEndian.PutUint16(out[20:], 1)
	binary.LittleEndian.PutUint16(out[22:], uint16(ch))
	binary.LittleEndian.PutUint32(out[24:], uint32(rate))
	binary.LittleEndian.PutUint32(out[28:], uint32(rate*ch*2))
	binary.LittleEndian.PutUint16(out[32:], uint16(ch*2))
	binary.LittleEndian.PutUint16(out[34:], 16)
	copy(out[36:], "data")
	binary.LittleEndian.PutUint32(out[40:], uint32(len(pcm)))
	copy(out[44:], pcm)
	return out
}

// Wellenform: je Bild der Proxy-Zeitachse ein Spitzenwert (0–255) je Tonspur — damit lassen sich Ton-Ein- und Ausstiege auf der
// Zeitleiste sehen, bevor man sie abhört. Skala: 0 = ≤ −60 dBFS … 255 = 0 dBFS (linear in dB).
const (
	peakRate   = 8000 // Dekodierrate für die Spitzenwerte (genug für Pegel, billig zu rechnen)
	peakFloorD = 60.0
)

// PeaksFromPCM rechnet 16-Bit-Mono-Samples (Rate `rate`) in `frames` Spitzenwerte um (Bild n = Samples
// [n·rate·den/num, (n+1)·rate·den/num)); fehlende Samples am Ende zählen als Stille.
func PeaksFromPCM(pcm []byte, rate int, frames int64, fpsNum, fpsDen int64) []byte {
	out := make([]byte, frames)
	n := len(pcm) / 2
	for f := int64(0); f < frames; f++ {
		a := int(f * int64(rate) * fpsDen / fpsNum)
		b := int((f + 1) * int64(rate) * fpsDen / fpsNum)
		if b > n {
			b = n
		}
		peak := 0
		for i := a; i < b; i++ {
			v := int(int16(uint16(pcm[2*i]) | uint16(pcm[2*i+1])<<8))
			if v < 0 {
				v = -v
			}
			if v > peak {
				peak = v
			}
		}
		if peak == 0 {
			continue
		}
		db := 20 * math.Log10(float64(peak)/32768)
		x := (db + peakFloorD) / peakFloorD
		if x < 0 {
			x = 0
		}
		if x > 1 {
			x = 1
		}
		out[f] = byte(math.Round(x * 255))
	}
	return out
}

// Peaks liefert die Spitzenwerte einer Spur (Länge = Bildanzahl des Proxys); das Ergebnis liegt neben dem Ton-Proxy im Zwischenspeicher.
func (s *Service) Peaks(ctx context.Context, assetID string, track int) ([]byte, error) {
	_, p, err := s.ProxyFile(ctx, assetID)
	if err != nil {
		return nil, err
	}
	if p.AudioTracks == 0 || p.AudioPath == "" {
		return nil, ErrNotFound
	}
	if track < 0 || track >= p.AudioTracks {
		return nil, fmt.Errorf("%w: Tonspur %d außerhalb [0,%d)", ErrValidation, track, p.AudioTracks)
	}
	cache := fmt.Sprintf("%s.peaks%d", p.AudioPath, track)
	if b, err := os.ReadFile(cache); err == nil && int64(len(b)) == p.Frames {
		return b, nil
	}
	pcm, code, err := s.Tools.ExecProxy().Run(ctx, s.Tools.FFmpeg, []string{"-nostdin", "-v", "error", "-i", p.AudioPath,
		"-map", fmt.Sprintf("0:a:%d", track), "-f", "s16le", "-acodec", "pcm_s16le", "-ar", strconv.Itoa(peakRate), "-ac", "1", "-"}, nil)
	if err != nil {
		return nil, err
	}
	if code != 0 {
		return nil, fmt.Errorf("Tonspur nicht lesbar")
	}
	out := PeaksFromPCM(pcm, peakRate, p.Frames, p.Rate.Num, p.Rate.Den)
	tmp := cache + ".tmp"
	if os.WriteFile(tmp, out, 0o644) == nil {
		_ = os.Rename(tmp, cache)
	}
	return out, nil
}
