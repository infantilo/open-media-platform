package review

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"regexp"
	"strings"
	"unicode/utf8"
)

// QC-Profile verwalten (Administration): anlegen, ändern, kopieren, löschen, Standard wählen. Alles läuft über das Einstellungsdokument
// „review.config“; die Endpunkte hier ändern nur ein Profil und lassen den Rest unberührt (das Einstellungsformular schreibt das ganze
// Dokument und würde sonst gleichzeitig gemachte Profiländerungen überschreiben).

var profileIDRe = regexp.MustCompile(`^[a-z0-9][a-z0-9-]{0,39}$`)

// ValidProfileID: Kennung eines Profils (Teil jedes Befunds als „<id>@<version>“, deshalb schlicht und stabil).
func ValidProfileID(id string) bool { return profileIDRe.MatchString(id) }

// Validate prüft die Wertebereiche eines Profils. Nullwerte bedeuten „nicht prüfen“ und sind erlaubt.
func (p QCProfile) Validate() error {
	if n := utf8.RuneCountInString(strings.TrimSpace(p.Name)); n < 1 || n > 80 {
		return fmt.Errorf("Name: 1 bis 80 Zeichen")
	}
	neg := func(name string, v float64) error {
		if v < 0 {
			return fmt.Errorf("%s darf nicht negativ sein", name)
		}
		return nil
	}
	order := func(name string, warn, fail float64) error {
		if warn > 0 && fail > 0 && warn > fail {
			return fmt.Errorf("%s: die Warnschwelle (%g s) liegt über der Fehlerschwelle (%g s)", name, warn, fail)
		}
		return nil
	}
	for _, c := range []error{
		neg("Schwarz: Mindestdauer", p.Black.MinDurationS), neg("Schwarz: Warnschwelle", p.Black.WarnAboveS), neg("Schwarz: Fehlerschwelle", p.Black.FailAboveS),
		neg("Schwarz: Anfang ignorieren", p.Black.IgnoreHeadS), neg("Schwarz: Ende ignorieren", p.Black.IgnoreTailS),
		order("Schwarzbild", p.Black.WarnAboveS, p.Black.FailAboveS),
		neg("Standbild: Mindestdauer", p.Freeze.MinDurationS), order("Standbild", p.Freeze.WarnAboveS, p.Freeze.FailAboveS),
		neg("Stille: Mindestdauer", p.Silence.MinDurationS), order("Stille", p.Silence.WarnAboveS, p.Silence.FailAboveS),
		neg("Lautheit: Warntoleranz", p.Loudness.WarnToleranceLU), neg("Lautheit: Fehlertoleranz", p.Loudness.FailToleranceLU), neg("Lautheit: LRA", p.Loudness.MaxLRA),
		neg("Sync: Startversatz", p.Sync.MaxStartOffsetMs), neg("Sync: Dauerabweichung", p.Sync.MaxDurationMismatchMs),
	} {
		if c != nil {
			return c
		}
	}
	if p.Black.PixTh < 0 || p.Black.PixTh > 1 || p.Black.PicTh < 0 || p.Black.PicTh > 1 {
		return fmt.Errorf("Schwarz: die Schwellen pix_th/pic_th liegen zwischen 0 und 1")
	}
	if p.Freeze.NoiseDb > 0 || p.Silence.NoiseDb > 0 {
		return fmt.Errorf("Rauschpegel (Standbild/Stille) muss 0 dB oder kleiner sein")
	}
	if p.Loudness.WarnToleranceLU > 0 && p.Loudness.FailToleranceLU > 0 && p.Loudness.WarnToleranceLU > p.Loudness.FailToleranceLU {
		return fmt.Errorf("Lautheit: die Warntoleranz liegt über der Fehlertoleranz")
	}
	if p.Loudness.Enabled && (p.Loudness.TargetLUFS < -70 || p.Loudness.TargetLUFS > 0) {
		return fmt.Errorf("Lautheit: Zielwert zwischen −70 und 0 LUFS")
	}
	if p.Loudness.MaxTruePeakDB > 3 {
		return fmt.Errorf("Lautheit: True-Peak-Grenze über +3 dBTP ist unsinnig")
	}
	if p.ClipPeakDB > 0 {
		return fmt.Errorf("Clipping-Pegel muss 0 dBFS oder kleiner sein")
	}
	e := p.Expect
	if e.Width < 0 || e.Height < 0 || e.AudioTracks < 0 || e.SampleRate < 0 || e.MinBitDepth < 0 {
		return fmt.Errorf("Erwartungen: Breite, Höhe, Tonspuren, Abtastrate und Bittiefe dürfen nicht negativ sein")
	}
	switch e.FieldOrder {
	case "", "progressive", "tt", "bb", "any":
	default:
		return fmt.Errorf("Erwartungen: Halbbild-Reihenfolge %q unbekannt", e.FieldOrder)
	}
	if p.MaxAudioStreams > 64 {
		return fmt.Errorf("Analyse höchstens für 64 Tonspuren")
	}
	if p.TimeoutSec > 86400 {
		return fmt.Errorf("Zeitlimit höchstens 24 Stunden")
	}
	return nil
}

// sameRules: gleiche Regeln? Name und Version zählen nicht — nur was die Prüfung verändert.
func sameRules(a, b QCProfile) bool {
	a.Name, b.Name, a.Version, b.Version = "", "", 0, 0
	ja, _ := json.Marshal(a)
	jb, _ := json.Marshal(b)
	return string(ja) == string(jb)
}

// withProfile legt `in` unter `id` an oder ersetzt es. Ändern sich die Regeln, ohne dass die Version erhöht wurde, wird sie erhöht:
// Befunde tragen „<id>@<version>“ und müssen sich einem bestimmten Regelstand zuordnen lassen.
func withProfile(c Config, id string, in QCProfile) (Config, QCProfile, bool, error) {
	if !ValidProfileID(id) {
		return c, in, false, fmt.Errorf("Kennung %q: nur Kleinbuchstaben, Ziffern und Bindestrich, höchstens 40 Zeichen", id)
	}
	in.ID = id
	in.Name = strings.TrimSpace(in.Name)
	if in.Version < 1 {
		in.Version = 1
	}
	if err := in.Validate(); err != nil {
		return c, in, false, fmt.Errorf("%w: %v", ErrValidation, err)
	}
	if in.Expect.FrameRate != "" {
		if _, err := ParseRate(in.Expect.FrameRate); err != nil {
			return c, in, false, fmt.Errorf("%w: Erwartungen: %v", ErrValidation, err)
		}
	}
	old, exists := c.QCProfiles[id]
	if exists && !sameRules(old, in) && in.Version <= old.Version {
		in.Version = old.Version + 1
	}
	if exists && sameRules(old, in) {
		in.Version = old.Version // nur der Name geändert: Regelstand bleibt
	}
	next := c
	next.QCProfiles = map[string]QCProfile{}
	for k, v := range c.QCProfiles {
		next.QCProfiles[k] = v
	}
	next.QCProfiles[id] = in
	return next, in, !exists, nil
}

// withoutProfile entfernt ein Profil; das Standardprofil und das letzte Profil bleiben.
func withoutProfile(c Config, id string) (Config, error) {
	if _, ok := c.QCProfiles[id]; !ok {
		return c, ErrNotFound
	}
	if id == c.DefaultQCProfile {
		return c, fmt.Errorf("%w: das Standardprofil lässt sich nicht löschen — zuerst ein anderes zum Standard machen", ErrValidation)
	}
	if len(c.QCProfiles) <= 1 {
		return c, fmt.Errorf("%w: das letzte Profil lässt sich nicht löschen", ErrValidation)
	}
	next := c
	next.QCProfiles = map[string]QCProfile{}
	for k, v := range c.QCProfiles {
		if k != id {
			next.QCProfiles[k] = v
		}
	}
	return next, nil
}

// saveConfig schreibt das Dokument und verwirft den Zwischenspeicher.
func (a *api) saveConfig(c Config) error {
	if err := c.Normalize(); err != nil {
		return fmt.Errorf("%w: %v", ErrValidation, err)
	}
	out, _ := json.Marshal(c)
	if err := a.settings.Put(settingsKey, out); err != nil {
		return err
	}
	a.m.cfg.Invalidate()
	return nil
}

// GET /api/v1/review/qc-profiles: alle Profile, das Standardprofil und die Vorlage für neue Profile (das mitgelieferte Rundfunkprofil).
func (a *api) listProfiles() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		c := a.svc.Cfg()
		list := make([]QCProfile, 0, len(c.QCProfiles))
		for _, id := range c.ProfileIDs() {
			list = append(list, c.QCProfiles[id])
		}
		writeJSON(w, 200, map[string]any{"default": c.DefaultQCProfile, "profiles": list, "template": DefaultQCProfile()})
	}
}

// PUT /api/v1/review/qc-profiles/{id}: Profil anlegen oder ersetzen.
func (a *api) putProfile() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		raw, err := io.ReadAll(http.MaxBytesReader(w, r.Body, 256<<10))
		var in QCProfile
		if err != nil || json.Unmarshal(raw, &in) != nil {
			writeJSON(w, 400, map[string]any{"error": "Körper nicht lesbar"})
			return
		}
		a.m.cfgMu.Lock()
		defer a.m.cfgMu.Unlock()
		c, p, created, err := withProfile(a.svc.Cfg(), r.PathValue("id"), in)
		if err == nil {
			err = a.saveConfig(c)
		}
		if err != nil {
			a.writeErr(w, err, nil)
			return
		}
		action := "qc_profile_changed"
		if created {
			action = "qc_profile_created"
		}
		a.svc.audit(actorOf(r), "", action, map[string]any{"profile": p.Ruleset()})
		writeJSON(w, 200, map[string]any{"profile": p, "created": created})
	}
}

// DELETE /api/v1/review/qc-profiles/{id}
func (a *api) deleteProfile() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		a.m.cfgMu.Lock()
		defer a.m.cfgMu.Unlock()
		id := r.PathValue("id")
		c, err := withoutProfile(a.svc.Cfg(), id)
		if err == nil {
			err = a.saveConfig(c)
		}
		if err != nil {
			a.writeErr(w, err, nil)
			return
		}
		a.svc.audit(actorOf(r), "", "qc_profile_deleted", map[string]any{"profile": id})
		writeJSON(w, 200, map[string]any{"ok": true})
	}
}

// POST /api/v1/review/qc-profiles/default {"id": "…"}
func (a *api) setDefaultProfile() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			ID string `json:"id"`
		}
		if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4096)).Decode(&body); err != nil {
			writeJSON(w, 400, map[string]any{"error": "Körper nicht lesbar"})
			return
		}
		a.m.cfgMu.Lock()
		defer a.m.cfgMu.Unlock()
		c := a.svc.Cfg()
		if _, ok := c.QCProfiles[body.ID]; !ok {
			a.writeErr(w, ErrNotFound, nil)
			return
		}
		c.DefaultQCProfile = body.ID
		if err := a.saveConfig(c); err != nil {
			a.writeErr(w, err, nil)
			return
		}
		a.svc.audit(actorOf(r), "", "qc_profile_default", map[string]any{"profile": body.ID})
		writeJSON(w, 200, map[string]any{"default": body.ID})
	}
}
