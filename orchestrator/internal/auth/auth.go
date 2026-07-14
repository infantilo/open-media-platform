// Package auth implementiert Authentifizierung (ARCHITECTURE.md §12
// Punkt 1, UMSETZUNG.md D3 Teil 2): lokale Nutzerkonten, Passwort-Hashing
// und Token-Ausstellung/-Prüfung. Die Autorisierungs-Semantik (wer darf
// was auf welchem Node) liegt bewusst getrennt in internal/authz — dieses
// Paket kennt nur "wer ist der Nutzer", nicht "was darf er".
//
// AD/LDAP-Anbindung (§12 Punkt 1: "AD/LDAP(S)-Anbindung für Enterprise-
// Umgebungen") ist in dieser Runde bewusst **nicht** umgesetzt: es gibt
// auf der Single-Host-Dev-Maschine keinen echten Verzeichnisdienst, gegen
// den sich ein LDAP-Bind sinnvoll verifizieren ließe (UMSETZUNG.md §0
// Punkt 7 verbietet Schritte, die nur mit Hardware/Infrastruktur testbar
// wären, die hier nicht existiert) — kein Raten an einer ungetesteten
// LDAP-Integration. Store ist deshalb hinter einem schmalen Interface in
// httpapi verwendet, damit eine LDAP-Variante später additiv (zweite
// Store-Implementierung) ergänzt werden kann, ohne den Rest anzufassen.
// Siehe docs/decisions.md D3 Teil 2.
package auth

import "time"

// User ist ein lokales Nutzerkonto.
type User struct {
	ID           string
	Username     string
	PasswordHash string
	CreatedAt    time.Time
}

// Principal ist die aus einem verifizierten Token gewonnene Identität —
// bewusst schmaler als User (kein PasswordHash), das ist alles, was
// Handler/Middleware nach der Authentifizierung noch brauchen.
type Principal struct {
	UserID   string
	Username string
}
