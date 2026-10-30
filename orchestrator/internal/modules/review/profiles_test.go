package review

import (
	"errors"
	"testing"
)

func TestDefaultProfileIsValid(t *testing.T) {
	if err := DefaultQCProfile().Validate(); err != nil {
		t.Fatalf("das mitgelieferte Profil muss gültig sein: %v", err)
	}
}

func TestValidateRejectsNonsense(t *testing.T) {
	mod := func(f func(p *QCProfile)) QCProfile { p := DefaultQCProfile(); f(&p); return p }
	cases := map[string]QCProfile{
		"Name leer":              mod(func(p *QCProfile) { p.Name = "  " }),
		"Warn über Fehler":       mod(func(p *QCProfile) { p.Black.WarnAboveS, p.Black.FailAboveS = 20, 10 }),
		"negative Dauer":         mod(func(p *QCProfile) { p.Silence.MinDurationS = -1 }),
		"pix_th > 1":             mod(func(p *QCProfile) { p.Black.PixTh = 1.5 }),
		"Rauschpegel positiv":    mod(func(p *QCProfile) { p.Freeze.NoiseDb = 3 }),
		"Lautheit Warn > Fehler": mod(func(p *QCProfile) { p.Loudness.WarnToleranceLU, p.Loudness.FailToleranceLU = 4, 2 }),
		"Ziel außerhalb":         mod(func(p *QCProfile) { p.Loudness.TargetLUFS = 5 }),
		"Clipping positiv":       mod(func(p *QCProfile) { p.ClipPeakDB = 1 }),
		"Halbbild unbekannt":     mod(func(p *QCProfile) { p.Expect.FieldOrder = "diagonal" }),
		"negative Breite":        mod(func(p *QCProfile) { p.Expect.Width = -1 }),
		"zu viele Tonspuren":     mod(func(p *QCProfile) { p.MaxAudioStreams = 500 }),
	}
	for name, p := range cases {
		if p.Validate() == nil {
			t.Errorf("%s: erwartet Fehler", name)
		}
	}
}

func TestWithProfileCreateBumpAndKeepVersion(t *testing.T) {
	c := DefaultConfig()
	// neu anlegen
	n := DefaultQCProfile()
	n.Name = "Kurzbeitrag"
	c2, p, created, err := withProfile(c, "kurz", n)
	if err != nil || !created || p.ID != "kurz" || p.Version != 1 {
		t.Fatalf("anlegen: %+v created=%v err=%v", p, created, err)
	}
	if _, ok := c.QCProfiles["kurz"]; ok {
		t.Fatal("das Ausgangsdokument darf nicht verändert werden")
	}
	// Regeln ändern ohne Version → Version steigt
	chg := p
	chg.Black.FailAboveS = 5
	_, p2, created, err := withProfile(c2, "kurz", chg)
	if err != nil || created || p2.Version != 2 || p2.Ruleset() != "kurz@2" {
		t.Fatalf("Regeländerung: %+v created=%v err=%v", p2, created, err)
	}
	// nur der Name → Version bleibt, auch wenn der Client eine andere schickt
	ren := p
	ren.Name = "Kurz neu"
	ren.Version = 7
	_, p3, _, err := withProfile(c2, "kurz", ren)
	if err != nil || p3.Version != 1 || p3.Name != "Kurz neu" {
		t.Fatalf("Umbenennen: %+v err=%v", p3, err)
	}
	// Regeln geändert und Client schickt höhere Version → bleibt
	hi := chg
	hi.Version = 5
	_, p4, _, _ := withProfile(c2, "kurz", hi)
	if p4.Version != 5 {
		t.Fatalf("explizit höhere Version: %d", p4.Version)
	}
}

func TestWithProfileRejectsBadIDAndValues(t *testing.T) {
	c := DefaultConfig()
	for _, id := range []string{"", "Gross", "mit space", "-x", "ä", "a/b", "zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz"} {
		if _, _, _, err := withProfile(c, id, DefaultQCProfile()); err == nil {
			t.Errorf("id %q: erwartet Fehler", id)
		}
	}
	bad := DefaultQCProfile()
	bad.Expect.FrameRate = "fünfundzwanzig"
	if _, _, _, err := withProfile(c, "ok", bad); !errors.Is(err, ErrValidation) {
		t.Errorf("Bildrate: %v", err)
	}
	bad = DefaultQCProfile()
	bad.Silence.MinDurationS = -5
	if _, _, _, err := withProfile(c, "ok", bad); !errors.Is(err, ErrValidation) {
		t.Errorf("Wertebereich: %v", err)
	}
}

func TestWithoutProfileKeepsDefaultAndLast(t *testing.T) {
	c := DefaultConfig()
	if _, err := withoutProfile(c, "broadcast-default"); err == nil {
		t.Fatal("letztes/Standardprofil darf nicht gelöscht werden")
	}
	c, _, _, _ = withProfile(c, "zweit", DefaultQCProfile())
	if _, err := withoutProfile(c, "broadcast-default"); !errors.Is(err, ErrValidation) {
		t.Fatalf("Standardprofil: %v", err)
	}
	c2, err := withoutProfile(c, "zweit")
	if err != nil || len(c2.QCProfiles) != 1 || len(c.QCProfiles) != 2 {
		t.Fatalf("löschen: %v %d/%d", err, len(c2.QCProfiles), len(c.QCProfiles))
	}
	if _, err := withoutProfile(c, "gibtsnicht"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("unbekannt: %v", err)
	}
}
