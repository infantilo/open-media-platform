package review

import (
	"context"
	"os/exec"
	"path/filepath"
	"testing"
)

func TestCompareFactsRegeln(t *testing.T) {
	o := MediaFacts{DurationSec: 10, VideoCodec: "mpeg2video", Width: 1920, Height: 1080, FrameRate: "25/1", AudioCodec: "pcm_s24le", AudioStreams: 1, Channels: 2, SampleRate: 48000}
	status := func(cs []CompareCheck, id string) string {
		for _, c := range cs {
			if c.ID == id {
				return c.Status
			}
		}
		return "?"
	}
	r := o
	r.DurationSec = 10.039 // knapp ein Bild
	cs := CompareFacts(o, r, CompareOptions{})
	if status(cs, "duration") != "pass" || status(cs, "framerate") != "pass" || status(cs, "audio") != "pass" {
		t.Fatalf("gleiche Datei: %+v", cs)
	}
	r.DurationSec = 10.2
	if status(CompareFacts(o, r, CompareOptions{}), "duration") != "fail" {
		t.Fatal("200 ms Abweichung muss durchfallen")
	}
	if status(CompareFacts(o, r, CompareOptions{OffsetSec: 0.2}), "duration") != "pass" {
		t.Fatal("Vorlauf der Aufnahme wird abgezogen")
	}
	r = o
	r.FrameRate = "30000/1001"
	if status(CompareFacts(o, r, CompareOptions{}), "framerate") != "fail" {
		t.Fatal("Bildrate muss exakt gleich sein")
	}
	r = o
	r.FrameRate = "50/2"
	if status(CompareFacts(o, r, CompareOptions{}), "framerate") != "pass" {
		t.Fatal("25/1 == 50/2")
	}
	r = o
	r.Width, r.Height, r.VideoCodec = 1280, 720, "h264"
	cs = CompareFacts(o, r, CompareOptions{})
	if status(cs, "resolution") != "warn" || status(cs, "codec") != "warn" {
		t.Fatalf("Auflösung/Codec sind Hinweise: %+v", cs)
	}
	r = o
	r.AudioStreams, r.Channels = 0, 0
	if status(CompareFacts(o, r, CompareOptions{}), "audio") != "fail" {
		t.Fatal("Aufnahme ohne Ton fällt durch")
	}
}

func TestParseSSIMUndFacts(t *testing.T) {
	v, ok := ParseSSIM("[Parsed_ssim_4 @ 0x1] SSIM Y:0.99 (20.0) U:0.99 (20.0) V:0.99 (20.0) All:0.987654 (19.1)\n")
	if !ok || v != 0.987654 {
		t.Fatalf("%v %v", v, ok)
	}
	if _, ok := ParseSSIM("nichts"); ok {
		t.Fatal("ohne Zeile kein Wert")
	}
	f, err := ParseFacts([]byte(`{"format":{"duration":"2.000000"},"streams":[{"codec_type":"video","codec_name":"h264","width":160,"height":90,"avg_frame_rate":"25/1","r_frame_rate":"25/1"},{"codec_type":"audio","codec_name":"aac","channels":2,"sample_rate":"48000"}]}`))
	if err != nil || f.FrameRate != "25/1" || f.Channels != 2 || f.AudioStreams != 1 || f.DurationSec != 2 {
		t.Fatalf("%+v %v", f, err)
	}
	if _, err := ParseFacts([]byte(`{"streams":[]}`)); err == nil {
		t.Fatal("leer ist ein Fehler")
	}
}

// Echter Lauf mit zwei winzigen Testvideos (160x90, 2 s, ein Faden): identische Datei besteht, verrauschte Aufnahme fällt durch.
func TestCompareEchteDateien(t *testing.T) {
	ff, err1 := exec.LookPath("ffmpeg")
	_, err2 := exec.LookPath("ffprobe")
	if err1 != nil || err2 != nil {
		t.Skip("ffmpeg/ffprobe nicht vorhanden")
	}
	dir := t.TempDir()
	gen := func(name string, extra ...string) string {
		p := filepath.Join(dir, name)
		args := []string{"-hide_banner", "-loglevel", "error", "-threads", "1", "-f", "lavfi", "-i", "testsrc2=size=160x90:rate=25:duration=2", "-f", "lavfi", "-i", "sine=frequency=440:duration=2:sample_rate=48000"}
		args = append(args, extra...)
		args = append(args, "-c:v", "mpeg4", "-q:v", "3", "-c:a", "aac", "-shortest", p)
		if out, err := exec.Command("nice", append([]string{"-n", "10", ff}, args...)...).CombinedOutput(); err != nil {
			t.Fatalf("ffmpeg: %v %s", err, out)
		}
		return p
	}
	orig := gen("orig.mp4")
	same := gen("same.mp4")
	bad := gen("bad.mp4", "-vf", "noise=alls=80:allf=t,hue=s=0")
	tools := NewTools("", "")
	rep, err := tools.Compare(context.Background(), orig, same, CompareOptions{SampleSec: 2})
	if err != nil {
		t.Fatal(err)
	}
	if rep.Overall != "pass" || rep.SSIM == nil || *rep.SSIM < 0.98 {
		t.Fatalf("identische Aufnahme muss bestehen: %+v", rep)
	}
	rep, err = tools.Compare(context.Background(), orig, bad, CompareOptions{SampleSec: 2})
	if err != nil {
		t.Fatal(err)
	}
	if rep.Overall != "fail" || rep.SSIM == nil || *rep.SSIM >= 0.98 {
		t.Fatalf("verschlechterte Aufnahme muss durchfallen: %+v", rep)
	}
	if _, err := tools.Compare(context.Background(), orig, filepath.Join(dir, "gibtsnicht.mp4"), CompareOptions{}); err == nil {
		t.Fatal("fehlende Datei ist ein Fehler")
	}
}
