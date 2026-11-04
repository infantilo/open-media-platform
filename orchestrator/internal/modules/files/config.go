package files

import (
	"encoding/json"
	"fmt"
	"time"
)

// settingsKey: Einstellungsdokument des Moduls (NodeSettings).
const settingsKey = "files.config"

// TypeLock überschreibt das Sperrfenster für einen Asset-Typ.
type TypeLock struct {
	LockBeforeH *float64 `json:"lockBeforeH,omitempty"`
	LockAfterH  *float64 `json:"lockAfterH,omitempty"`
}

// Config sind die globalen Einstellungen (je Wurzel überschreibbar: Papierkorb, Notfallgrenze, Sperrfenster).
type Config struct {
	// TrashDays: Aufbewahrung im Papierkorb; 0 = sofort endgültig löschen.
	TrashDays int `json:"trashDays"`
	// EmergencyFreeGB/-Pct: unterschreitet der freie Platz einer Wurzel EINEN der Werte (0 = aus), wird der Papierkorb früher geleert.
	EmergencyFreeGB  float64 `json:"emergencyFreeGb"`
	EmergencyFreePct float64 `json:"emergencyFreePct"`
	// GraceMinutes: Schutzfrist der Notfall-Leerung — Einträge, die jünger sind, bleiben.
	GraceMinutes int `json:"graceMinutes"`
	// LockBeforeH/-AfterH: Sperrfenster um eine Sendung (Stunden vor Beginn, nach Ende).
	LockBeforeH float64 `json:"lockBeforeH"`
	LockAfterH  float64 `json:"lockAfterH"`
	// PlannedIsHard: solange eine Datei noch verplant (nicht gesendet) ist, gilt sie als hart gesperrt, egal wie weit der Beginn entfernt ist.
	PlannedIsHard bool                `json:"plannedIsHard"`
	AssetTypes    map[string]TypeLock `json:"assetTypes,omitempty"`
	// CheckEveryMin: Abstand des Hintergrund-Prüflaufs; CheckBatch: Representations je Prüfstapel.
	CheckEveryMin int `json:"checkEveryMin"`
	CheckBatch    int `json:"checkBatch"`
	// SweepEveryMin: Abstand der Papierkorb-Pflege.
	SweepEveryMin int `json:"sweepEveryMin"`
}

// DefaultConfig: Standardwerte (Entwurf Kap. 86 E3/E4).
func DefaultConfig() Config {
	return Config{TrashDays: 7, EmergencyFreeGB: 10, EmergencyFreePct: 3, GraceMinutes: 10, LockBeforeH: 24, LockAfterH: 6,
		PlannedIsHard: true, CheckEveryMin: 360, CheckBatch: 200, SweepEveryMin: 10}
}

// ParseConfig liest das Dokument (leer = Standard); fehlende Felder behalten den Standardwert.
func ParseConfig(raw []byte) (Config, error) {
	c := DefaultConfig()
	if len(raw) == 0 {
		return c, nil
	}
	if err := json.Unmarshal(raw, &c); err != nil {
		return DefaultConfig(), fmt.Errorf("files.config: %w", err)
	}
	return c, c.Validate()
}

// Validate prüft Wertebereiche.
func (c Config) Validate() error {
	switch {
	case c.TrashDays < 0 || c.TrashDays > 3650:
		return fmt.Errorf("trashDays 0–3650")
	case c.EmergencyFreeGB < 0 || c.EmergencyFreePct < 0 || c.EmergencyFreePct >= 100:
		return fmt.Errorf("Notfallgrenze: GB ≥ 0, Prozent 0–<100")
	case c.GraceMinutes < 0 || c.GraceMinutes > 1440:
		return fmt.Errorf("graceMinutes 0–1440")
	case c.LockBeforeH < 0 || c.LockAfterH < 0 || c.LockBeforeH > 24*365 || c.LockAfterH > 24*365:
		return fmt.Errorf("Sperrfenster: Stunden ≥ 0")
	case c.CheckEveryMin < 1 || c.CheckBatch < 1 || c.CheckBatch > 5000 || c.SweepEveryMin < 1:
		return fmt.Errorf("Prüf-/Pflegeintervalle ≥ 1, Stapel 1–5000")
	}
	for t, l := range c.AssetTypes {
		if (l.LockBeforeH != nil && *l.LockBeforeH < 0) || (l.LockAfterH != nil && *l.LockAfterH < 0) {
			return fmt.Errorf("Sperrfenster für Typ %q: Stunden ≥ 0", t)
		}
	}
	return nil
}

func hours(h float64) time.Duration { return time.Duration(h * float64(time.Hour)) }

// LockWindow liefert das wirksame Sperrfenster: Typ-Überschreibung > Wurzel-Überschreibung > global.
func (c Config) LockWindow(root *Root, assetType string) (before, after time.Duration) {
	b, a := c.LockBeforeH, c.LockAfterH
	if root != nil {
		if root.LockBeforeH != nil {
			b = *root.LockBeforeH
		}
		if root.LockAfterH != nil {
			a = *root.LockAfterH
		}
	}
	if t, ok := c.AssetTypes[assetType]; ok {
		if t.LockBeforeH != nil {
			b = *t.LockBeforeH
		}
		if t.LockAfterH != nil {
			a = *t.LockAfterH
		}
	}
	return hours(b), hours(a)
}

// TrashRetention: wirksame Aufbewahrung der Wurzel.
func (c Config) TrashRetention(root Root) time.Duration {
	d := c.TrashDays
	if root.TrashDays != nil {
		d = *root.TrashDays
	}
	return time.Duration(d) * 24 * time.Hour
}

// EmergencyFree: Zielwert freier Bytes, ab dem der Notfall greift, bei Gesamtgröße total (größerer der beiden Grenzwerte; 0 = aus).
func (c Config) EmergencyFree(root Root, total int64) int64 {
	gb, pct := c.EmergencyFreeGB, c.EmergencyFreePct
	if root.EmergencyFreeGB != nil {
		gb = *root.EmergencyFreeGB
	}
	if root.EmergencyFreePct != nil {
		pct = *root.EmergencyFreePct
	}
	a := int64(gb * (1 << 30))
	b := int64(float64(total) * pct / 100)
	if b > a {
		return b
	}
	return a
}
