// Package idgen erzeugt UUIDv4-Werte für IS-04-Resource-IDs. Eigene,
// winzige Implementierung statt einer Library (Minimal-Dependency-Regel,
// UMSETZUNG.md §0.5) — Standardverfahren nach RFC 4122 §4.4.
package idgen

import (
	"crypto/rand"
	"fmt"
)

// NewV4 erzeugt eine zufällige UUID Version 4 im Standard-Textformat
// (8-4-4-4-12), kompatibel mit dem in AMWA-TV/is-04 geforderten Pattern
// "^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$".
func NewV4() string {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		panic(fmt.Sprintf("idgen: crypto/rand unavailable: %v", err))
	}
	b[6] = (b[6] & 0x0f) | 0x40 // Version 4
	b[8] = (b[8] & 0x3f) | 0x80 // Variante RFC 4122

	return fmt.Sprintf("%08x-%04x-%04x-%04x-%012x",
		b[0:4], b[4:6], b[6:8], b[8:10], b[10:16])
}
