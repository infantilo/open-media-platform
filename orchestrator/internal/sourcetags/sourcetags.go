// Package sourcetags ist der Tag-Overlay-Speicher des Orchestrators
// (UMSETZUNG.md Kapitel 27 / P4, Entscheidung E3): semantische Tags je Quelle
// (Spec §18–25). Drei Herkünfte, nie vermischt:
//
//   - EXPLICIT: vom Operator gesetzt (dieser Store, Postgres),
//   - DERIVED: aus Eigenschaften berechnet (Medientyp, Audio-Kanalanzahl),
//   - DISCOVERED: vom Node selbst per IS-04-Tag `urn:x-omp:tags` gemeldet.
//
// Bei mehreren Herkünften desselben Tags gewinnt EXPLICIT vor DERIVED vor
// DISCOVERED (Spec §25: explizite Konfiguration hat Vorrang). Namensbasierte
// Erkennung gibt es bewusst nicht (Spec §222): Tags kommen nie aus Labels.
package sourcetags

import (
	"database/sql"
	"errors"
	"fmt"
	"regexp"
	"sort"
	"strings"
)

// Herkunft eines Tags.
const (
	OriginExplicit   = "EXPLICIT"
	OriginDerived    = "DERIVED"
	OriginDiscovered = "DISCOVERED"
)

// MaxTagsPerSource begrenzt den Overlay je Quelle.
const MaxTagsPerSource = 32

var (
	ErrValidation = errors.New("sourcetags: validation failed")

	// tagRe: `domain.name[.sub]`, nur Kleinbuchstaben/Ziffern/Bindestrich
	// (Spec §20: media.audio, audio.51, role.commentator, video.camera).
	tagRe = regexp.MustCompile(`^[a-z][a-z0-9-]*(\.[a-z0-9][a-z0-9-]*)+$`)
)

// ValidateTag prüft das Namensformat eines Tags.
func ValidateTag(tag string) error {
	if len(tag) > 64 || !tagRe.MatchString(tag) {
		return fmt.Errorf("%w: %q (erwartet domain.name, z. B. audio.commentator)", ErrValidation, tag)
	}
	return nil
}

// Normalize prüft, entdoppelt und sortiert eine Tag-Liste.
func Normalize(tags []string) ([]string, error) {
	seen := map[string]bool{}
	out := make([]string, 0, len(tags))
	for _, t := range tags {
		t = strings.TrimSpace(t)
		if err := ValidateTag(t); err != nil {
			return nil, err
		}
		if !seen[t] {
			seen[t] = true
			out = append(out, t)
		}
	}
	if len(out) > MaxTagsPerSource {
		return nil, fmt.Errorf("%w: höchstens %d Tags je Quelle", ErrValidation, MaxTagsPerSource)
	}
	sort.Strings(out)
	return out, nil
}

// Tag ist ein Tag samt Herkunft.
type Tag struct {
	Tag    string `json:"tag"`
	Origin string `json:"origin"`
}

// Derive liefert die aus Eigenschaften berechneten Tags. Unbekannte
// Eigenschaften (Kanalanzahl 0, unbekanntes Format) ergeben KEINE Tags —
// nichts wird geraten.
func Derive(format string, channelCount int) []string {
	var out []string
	switch format {
	case "urn:x-nmos:format:video":
		out = append(out, "media.video")
	case "urn:x-nmos:format:audio":
		out = append(out, "media.audio")
		switch channelCount {
		case 1:
			out = append(out, "audio.mono")
		case 2:
			out = append(out, "audio.stereo")
		case 6:
			out = append(out, "audio.51")
		}
	case "urn:x-nmos:format:data":
		out = append(out, "media.data")
	}
	return out
}

// Merge führt die drei Herkünfte zusammen (je Tag die stärkste) und sortiert
// stabil nach Tag-Name. Ungültige Namen aus `discovered` (Node-Daten sind
// nicht vertrauenswürdig) werden verworfen.
func Merge(explicit, derived, discovered []string) []Tag {
	best := map[string]string{}
	rank := map[string]int{OriginDiscovered: 1, OriginDerived: 2, OriginExplicit: 3}
	add := func(tags []string, origin string) {
		for _, t := range tags {
			if ValidateTag(t) != nil {
				continue
			}
			if rank[origin] > rank[best[t]] {
				best[t] = origin
			}
		}
	}
	add(discovered, OriginDiscovered)
	add(derived, OriginDerived)
	add(explicit, OriginExplicit)
	out := make([]Tag, 0, len(best))
	for t, o := range best {
		out = append(out, Tag{Tag: t, Origin: o})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Tag < out[j].Tag })
	return out
}

// Store hält den EXPLICIT-Overlay in Postgres.
type Store struct{ db *sql.DB }

func NewStore(db *sql.DB) *Store { return &Store{db: db} }

// Key identifiziert eine Quelle stabil über Sender-Neustarts hinweg.
type Key struct{ NodeID, SenderLabel string }

// All liefert alle EXPLICIT-Tags je Quelle.
func (s *Store) All() (map[Key][]string, error) {
	rows, err := s.db.Query(`SELECT node_id, sender_label, tag FROM source_tags ORDER BY node_id, sender_label, tag`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[Key][]string{}
	for rows.Next() {
		var k Key
		var tag string
		if err := rows.Scan(&k.NodeID, &k.SenderLabel, &tag); err != nil {
			return nil, err
		}
		out[k] = append(out[k], tag)
	}
	return out, rows.Err()
}

// Set ersetzt die EXPLICIT-Tags einer Quelle (leere Liste = alle entfernen).
func (s *Store) Set(k Key, tags []string, by string) ([]string, error) {
	if k.NodeID == "" || k.SenderLabel == "" {
		return nil, fmt.Errorf("%w: nodeId und senderLabel erforderlich", ErrValidation)
	}
	norm, err := Normalize(tags)
	if err != nil {
		return nil, err
	}
	tx, err := s.db.Begin()
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback() }()
	if _, err := tx.Exec(`DELETE FROM source_tags WHERE node_id=$1 AND sender_label=$2`, k.NodeID, k.SenderLabel); err != nil {
		return nil, err
	}
	for _, t := range norm {
		if _, err := tx.Exec(`INSERT INTO source_tags (node_id, sender_label, tag, created_by) VALUES ($1,$2,$3,$4)`, k.NodeID, k.SenderLabel, t, by); err != nil {
			return nil, err
		}
	}
	return norm, tx.Commit()
}
