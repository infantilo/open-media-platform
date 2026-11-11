// Package auth implementiert Authentifizierung (ARCHITECTURE.md §12
// Punkt 1, UMSETZUNG.md D3 Teil 2): lokale Nutzerkonten, Passwort-Hashing
// und Token-Ausstellung/-Prüfung. Die Autorisierungs-Semantik (wer darf
// was auf welchem Node) liegt bewusst getrennt in internal/authz — dieses
// Paket kennt nur "wer ist der Nutzer", nicht "was darf er".
//
// AD/LDAP-Anbindung (Nutzerauftrag 2026-11-11): Service.SetDirectory hängt ein Verzeichnis (internal/directory)
// an Login; Verzeichnisnutzer werden beim ersten Login angelegt (source='ldap'), ihre Gruppen auf OMP-Gruppen
// abgebildet. Lokale Konten haben immer Vorrang und bleiben als Notzugang nutzbar.
package auth

import "time"

// User ist ein lokales Nutzerkonto.
type User struct {
	ID           string
	Username     string
	PasswordHash string
	CreatedAt    time.Time
	// SessionsEpoch (Sicherheits-Härtung 2026-08-10, ARCHITECTURE.md
	// §20.4, s. db/migrations/0014_session_revocation.sql) — bei jedem
	// RevokeSessions-Aufruf um 1 erhöht. Ein Token trägt den Epoch-Wert,
	// der beim Ausstellen aktuell war (Principal.Epoch); Authenticate
	// verlangt exakte Übereinstimmung mit dem aktuellen Wert hier —
	// jedes davor ausgestellte Token hat zwangsläufig einen anderen
	// (kleineren) Wert und wird abgelehnt, unabhängig von jeder
	// Zeitstempel-Auflösung (s. Migrations-Kommentar für den Grund,
	// warum kein Zeitstempel-Vergleich verwendet wird).
	SessionsEpoch int64
	// OrgID (Kapitel 21 B14, Nachtrag 283) — die Organisation dieses
	// Nutzers (UMSETZUNG.md §21.6: eine Organisation pro Nutzer, kein
	// viele-zu-viele-Modell). Default "default" für jeden vor B14
	// bestehenden Nutzer (s. db/migrations/0025_organizations.sql).
	OrgID string
	// Source: "local" (Passwort in OMP) oder "ldap" (Anmeldung gegen Active Directory/LDAP, internal/directory).
	Source string
}

// Quellen eines Nutzerkontos.
const (
	SourceLocal = "local"
	SourceLDAP  = "ldap"
	// ExternalPasswordHash ist der Platzhalter-Hash von Verzeichnisnutzern; kein bcrypt-Hash, passt auf kein Passwort.
	ExternalPasswordHash = "!"
)

// Principal ist die aus einem verifizierten Token gewonnene Identität —
// bewusst schmaler als User (kein PasswordHash), das ist alles, was
// Handler/Middleware nach der Authentifizierung noch brauchen. Epoch
// wird nur intern von Service.Authenticate für den Revocation-Abgleich
// genutzt (s. User.SessionsEpoch). OrgID wird — wie die Autorisierung
// selbst (s. jwt.go-Moduldoku: "matcht ausschließlich über sein
// Username-Feld... live gegen role_bindings") — bewusst NICHT im Token
// mitgeführt, sondern von Service.Authenticate bei JEDER Prüfung frisch
// aus der DB gelesen: ein Organisationswechsel wirkt sofort, nicht erst
// nach einem erneuten Login.
type Principal struct {
	UserID   string
	Username string
	Epoch    int64
	OrgID    string
	// Service: Token einer Node-Instanz (IssueServiceToken), kein Nutzerkonto — es gibt dazu keine users-Zeile.
	Service bool
	// Support: befristeter, nur lesender Support-Zugang (internal/supportaccess); Username "support:<id>", kein Nutzerkonto.
	Support bool
}
