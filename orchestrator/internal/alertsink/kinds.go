package alertsink

import (
	"regexp"
	"sort"
	"sync"
)

// Alarmarten sind dynamisch: jede Quelle (Kern, Module) meldet ihre Arten mit RegisterKind an; Regeln, Oberfläche und
// Prüfungen lesen immer die aktuelle Liste. Eine Regel darf auch eine Art nennen, die gerade nicht angemeldet ist
// (Modul aus) — sie bleibt erhalten und greift wieder, sobald die Art zurückkehrt.

// Schweregrade eines Alarms (wie im Reiter „Alarme“: kritisch/Warnung; zusätzlich Info für Entwarnungen).
const (
	SevCritical = "critical"
	SevWarning  = "warning"
	SevInfo     = "info"
)

// KindInfo beschreibt eine Alarmart.
type KindInfo struct {
	Kind     string `json:"kind"`
	Severity string `json:"severity"` // Standard-Schweregrad
	Group    string `json:"group"`    // Quelle, z. B. nodes, hosts, process, review, user
	Label    string `json:"label"`    // Anzeigetext (Deutsch); die Oberfläche übersetzt bekannte Arten selbst
	LabelEN  string `json:"labelEn,omitempty"`
	// OptIn: nur Regeln, die die Art ausdrücklich nennen, lösen sie aus (nie „alle“, nie die Standard-Empfänger, nie der Webhook).
	// Für Arten, die sonst überfluten würden (Benutzeraktionen).
	OptIn bool `json:"optIn,omitempty"`
}

var (
	kindMu    sync.RWMutex
	kindList  []KindInfo
	kindNamed = regexp.MustCompile(`^[a-z0-9][a-z0-9._:-]{0,63}$`)
)

// RegisterKind meldet eine Alarmart an (erneutes Anmelden ersetzt sie).
func RegisterKind(k KindInfo) {
	if !validSeverity(k.Severity) {
		k.Severity = SevWarning
	}
	kindMu.Lock()
	defer kindMu.Unlock()
	for i := range kindList {
		if kindList[i].Kind == k.Kind {
			kindList[i] = k
			return
		}
	}
	kindList = append(kindList, k)
}

// UnregisterKind nimmt eine Art zurück (z. B. Modul abgeschaltet).
func UnregisterKind(kind string) {
	kindMu.Lock()
	defer kindMu.Unlock()
	for i := range kindList {
		if kindList[i].Kind == kind {
			kindList = append(kindList[:i], kindList[i+1:]...)
			return
		}
	}
}

// ListKinds liefert die angemeldeten Arten (stabil: nach Gruppe, dann Anmeldereihenfolge).
func ListKinds() []KindInfo {
	kindMu.RLock()
	out := append([]KindInfo(nil), kindList...)
	kindMu.RUnlock()
	sort.SliceStable(out, func(i, j int) bool { return out[i].Group < out[j].Group })
	return out
}

func lookupKind(kind string) (KindInfo, bool) {
	kindMu.RLock()
	defer kindMu.RUnlock()
	for _, k := range kindList {
		if k.Kind == kind {
			return k, true
		}
	}
	return KindInfo{}, false
}

func isOptIn(kind string) bool { k, ok := lookupKind(kind); return ok && k.OptIn }

// DefaultSeverity liefert den Standard-Schweregrad einer Alarmart (unbekannt: Warnung).
func DefaultSeverity(kind string) string {
	if k, ok := lookupKind(kind); ok {
		return k.Severity
	}
	if kind == "test" {
		return SevInfo
	}
	return SevWarning
}

func validSeverity(s string) bool { return s == SevCritical || s == SevWarning || s == SevInfo }

// validKindName prüft nur die Schreibweise, nicht die Anmeldung (siehe oben).
func validKindName(k string) bool { return kindNamed.MatchString(k) }

func init() {
	for _, k := range []KindInfo{
		{Kind: "node-alert", Severity: SevCritical, Group: "nodes", Label: "Node-Alarm (z. B. Pipeline gerissen)"},
		{Kind: "media-lost", Severity: SevCritical, Group: "nodes", Label: "Sendeweg liefert keine Medien"},
		{Kind: "node-silent", Severity: SevCritical, Group: "nodes", Label: "Node ohne Lebenszeichen"},
		{Kind: "node-recovered", Severity: SevInfo, Group: "nodes", Label: "Node meldet sich wieder"},
		{Kind: "media-recovered", Severity: SevInfo, Group: "nodes", Label: "Sendeweg liefert wieder Medien"},
		{Kind: "host-offline", Severity: SevCritical, Group: "hosts", Label: "Host offline"},
		{Kind: "host-online", Severity: SevInfo, Group: "hosts", Label: "Host wieder online"},
		{Kind: "load-high", Severity: SevWarning, Group: "hosts", Label: "Last zu hoch"},
		{Kind: "load-recovered", Severity: SevInfo, Group: "hosts", Label: "Last wieder normal"},
		{Kind: "process-failed", Severity: SevCritical, Group: "process", Label: "Prozess fehlgeschlagen"},
		{Kind: "qc-failed", Severity: SevWarning, Group: "review", Label: "Datei hat die QC nicht bestanden"},
		{Kind: "qc-error", Severity: SevWarning, Group: "review", Label: "QC konnte nicht ausgeführt werden"},
		{Kind: "file-rejected", Severity: SevWarning, Group: "review", Label: "Datei im Eingang abgelehnt"},
		{Kind: "file-missing", Severity: SevWarning, Group: "files", Label: "Datei eines Assets fehlt"},
		{Kind: "file-recovered", Severity: SevInfo, Group: "files", Label: "Fehlende Datei ist wieder da"},
		{Kind: "file-trash-emergency", Severity: SevWarning, Group: "files", Label: "Speicher knapp (Papierkorb vorzeitig geleert)"},
		{Kind: "file-mount-hung", Severity: SevCritical, Group: "files", Label: "Mount hängt (Ort antwortet nicht)"},
		{Kind: "file-root-unreachable", Severity: SevWarning, Group: "files", Label: "Ort nicht erreichbar (Host offline oder Pfad fehlt)"},
		{Kind: "file-mount-recovered", Severity: SevInfo, Group: "files", Label: "Ort antwortet wieder"},
		{Kind: "file-force-delete", Severity: SevWarning, Group: "files", Label: "Gesperrte Datei erzwungen gelöscht"},
		{Kind: "user-action", Severity: SevInfo, Group: "user", Label: "Manuelle Benutzeraktion", OptIn: true},
	} {
		RegisterKind(k)
	}
}
