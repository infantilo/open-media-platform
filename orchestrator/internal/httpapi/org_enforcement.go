package httpapi

import "net/http"

// Kapitel 21 B14 (Nachtrag 283, UMSETZUNG.md §21.6): Mandantenfähigkeit
// als reines Zugriffs-Scoping, keine physische Datentrennung (vom
// Nutzer bestätigte Entscheidung 1). Persistente Domänenobjekte
// (Workflow, ProcessDefinition, Asset, Collection) tragen dafür ein
// OwnerOrgID-Feld; dieses Modul bündelt die dazu passende
// HTTP-Handler-seitige Durchsetzung, damit sie in jedem Domänen-Paket
// (workflow_handlers.go, process_handlers.go, asset_handlers.go)
// identisch aussieht statt vier Mal leicht abweichend erfunden zu
// werden.

// callerOrgID liefert die Organisation, in deren Namen dieser Request
// ein neues Objekt anlegt (Create/Import). Kein authentifizierter
// Principal (Bootstrap-Bypass, s. principalFromContext-Doku) oder ein
// Principal ohne OrgID (Service-Token, s. auth.Principal-Doku) legt
// bewusst in der Default-Organisation an, statt einen Fehler zu
// werfen — dieselbe Großzügigkeit wie auth.Service.CreateUser mit
// leerem orgID.
func callerOrgID(r *http.Request) string {
	p, ok := principalFromContext(r)
	if !ok || p.OrgID == "" {
		return defaultOrgID
	}
	return p.OrgID
}

// orgMatches prüft, ob der Aufrufer dieses Requests auf ein Objekt mit
// gegebenem ownerOrgID zugreifen darf. Zwei bewusste Ausnahmen ohne
// jede Org-Einschränkung (identisch zur "geteilte Infrastruktur"-Linie
// bei node/instance-Launcher-Ressourcen, UMSETZUNG.md §21.6):
//   - kein authentifizierter Principal (Bootstrap-Bypass, noch kein
//     Nutzer angelegt) — die gesamte API ist in diesem Modus ohnehin
//     offen, s. principalFromContext-Doku;
//   - ein Principal ohne OrgID (Service-Token für Node->Orchestrator-
//     Aufrufe, s. auth.Principal-Doku) — interne Steuerungsebene, kein
//     Nutzerkonto, kein Mandant.
//
// ownerOrgID=="" (ein Objekt aus der Zeit vor B14 bzw. ein Aufrufer,
// der das Feld nicht mitschickt) gilt als defaultOrgID — Bestandsdaten
// bleiben für Nutzer der Default-Organisation unverändert sichtbar.
func orgMatches(r *http.Request, ownerOrgID string) bool {
	p, ok := principalFromContext(r)
	if !ok || p.OrgID == "" {
		return true
	}
	if ownerOrgID == "" {
		ownerOrgID = defaultOrgID
	}
	return p.OrgID == ownerOrgID
}

// writeOrgNotFound antwortet mit 404 statt 403 — Kapitel 21 B14 Phase 3
// Plan (UMSETZUNG.md §21.6): ein Aufrufer aus einer fremden
// Organisation soll aus der Antwort nicht einmal ableiten können, DASS
// unter dieser ID überhaupt etwas existiert (kein Cross-Org-
// Existence-Leak). Gleicher HTTP-Status wie "ID existiert gar nicht" —
// aus Aufrufersicht ununterscheidbar, mit Absicht.
func writeOrgNotFound(w http.ResponseWriter) {
	http.Error(w, "not found", http.StatusNotFound)
}

// defaultOrgID spiegelt organizations.DefaultOrgID (bewusst dupliziert
// statt importiert — dieselbe Duplikations-Linie wie auth.Service.
// DefaultOrgID/workflows.ownerOrgIDOrDefault, vermeidet einen
// Paket-Zyklus für eine einzelne Konstante an dieser Stelle).
const defaultOrgID = "default"
