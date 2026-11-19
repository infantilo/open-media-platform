package workflows

import (
	"encoding/json"
	"fmt"
	"sort"
	"strconv"
	"strings"

	"github.com/infantilo/openmediaplatform/orchestrator/internal/authz"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/version"
)

// ExportMeta beschreibt, womit eine Exportdatei erzeugt wurde. Der Import vergleicht die Version, weil eine Datei aus einer
// neueren Version Felder oder Funktionen enthalten kann, die diese Version nicht kennt.
type ExportMeta struct {
	OrchestratorVersion string `json:"orchestratorVersion,omitempty"`
	ExportedAt          string `json:"exportedAt,omitempty"`
}

// HostDirectory sagt, ob ein Host bekannt ist (Import-Prüfung der Rollen mit fester Host-Vorgabe).
type HostDirectory interface {
	HostLabel(id string) (string, bool)
}

// SetHostDirectory verdrahtet das Hostverzeichnis (nil = Hosts werden nicht geprüft).
func (s *Service) SetHostDirectory(d HostDirectory) { s.hostDir = d }

// ImportIssue ist ein Prüfergebnis. Level "error": der Import ist so nicht möglich; "warn": möglich, aber mit Folgen;
// "info": zur Kenntnis. Code ist stabil (Oberfläche und Tests), Message deutsch.
type ImportIssue struct {
	Level   string `json:"level"`
	Code    string `json:"code"`
	Message string `json:"message"`
	Role    string `json:"role,omitempty"`
}

// ExistingRef verweist auf einen bereits vorhandenen Workflow gleichen Namens.
type ExistingRef struct {
	ID     string `json:"id"`
	Name   string `json:"name"`
	Status string `json:"status"`
	// CanReplace: der Workflow lässt sich in seinem Zustand ersetzen (gestoppt, pausiert oder laufend — bei einem laufenden
	// wirkt die neue Definition erst beim nächsten Start).
	CanReplace bool `json:"canReplace"`
}

// DefinitionDiff fasst zusammen, was „ersetzen“ am vorhandenen Workflow ändern würde.
type DefinitionDiff struct {
	RolesAdded         []string `json:"rolesAdded,omitempty"`
	RolesRemoved       []string `json:"rolesRemoved,omitempty"`
	RolesChanged       []string `json:"rolesChanged,omitempty"`
	ConnectionsAdded   int      `json:"connectionsAdded"`
	ConnectionsRemoved int      `json:"connectionsRemoved"`
	SettingsChanged    bool     `json:"settingsChanged"`
	SchedulesChanged   bool     `json:"schedulesChanged"`
}

// ImportReport ist das Ergebnis der Importprüfung (POST /api/v1/workflows/import/preview). Es verändert nichts.
type ImportReport struct {
	Name           string          `json:"name"`
	Exists         *ExistingRef    `json:"exists,omitempty"`
	NewName        string          `json:"newName"`
	Issues         []ImportIssue   `json:"issues"`
	Diff           *DefinitionDiff `json:"diff,omitempty"`
	FileVersion    string          `json:"fileVersion,omitempty"`
	CurrentVersion string          `json:"currentVersion"`
	// CanImport ist false, solange ein Fehler vorliegt.
	CanImport bool `json:"canImport"`
}

// Preview prüft eine Importdatei, ohne etwas anzulegen: bekannte Node-Typen, gültige Definition, vorhandene Hosts und
// Gruppen, Version der Datei gegen die laufende Version, unbekannte Felder (= Funktionen einer neueren Version) und ob schon
// ein Workflow gleichen Namens existiert (dann samt Unterschieden, damit „ersetzen“ angeboten werden kann). raw ist der
// Roh-JSON-Text der Datei (für die Erkennung unbekannter Felder), darf leer sein.
func (s *Service) Preview(exported ExportedWorkflow, raw []byte) (ImportReport, error) {
	cur := version.Version
	rep := ImportReport{Name: exported.Name, FileVersion: exported.Meta.OrchestratorVersion, CurrentVersion: cur, Issues: []ImportIssue{}}
	add := func(level, code, msg, role string) {
		rep.Issues = append(rep.Issues, ImportIssue{Level: level, Code: code, Message: msg, Role: role})
	}

	// Katalog
	known := map[string]bool{}
	for _, entry := range s.launcher.Catalog() {
		known[entry.Type] = true
	}
	for _, role := range exported.Definition.Roles {
		if !known[role.NodeType] {
			add("error", "unknown-node-type", fmt.Sprintf("Rolle „%s“: Node-Typ „%s“ gibt es in diesem Katalog nicht.", role.Name, role.NodeType), role.Name)
		}
	}
	// Definition (Rollen, Verbindungen, Format, Domänen, Zeitpläne …)
	if err := validate(exported.Definition); err != nil {
		add("error", "invalid-definition", strings.TrimPrefix(err.Error(), ErrValidation.Error()+": "), "")
	}
	// Hosts
	if s.hostDir != nil {
		seen := map[string]bool{}
		for _, role := range exported.Definition.Roles {
			if role.HostID == "" || seen[role.HostID] {
				continue
			}
			seen[role.HostID] = true
			if _, ok := s.hostDir.HostLabel(role.HostID); !ok {
				add("warn", "unknown-host", fmt.Sprintf("Rolle „%s“ verweist auf einen Host, den es hier nicht gibt (%s). Beim Start wählt der Orchestrator automatisch einen Host.", role.Name, role.HostID), role.Name)
			}
		}
	}
	// Gruppen der Rollenbindungen
	if s.groups != nil {
		for _, b := range exported.Bindings {
			if b.SubjectType != authz.SubjectTypeGroup {
				continue
			}
			found := false
			if b.SubjectName != "" {
				_, found = s.groups.GroupIDByName(b.SubjectName)
			}
			if !found {
				_, found = s.groups.GroupName(b.Subject)
			}
			if !found {
				name := b.SubjectName
				if name == "" {
					name = b.Subject
				}
				add("warn", "unknown-group", fmt.Sprintf("Die Gruppe „%s“ (Rollenbindung für „%s“) gibt es hier nicht; diese Bindung wird nicht angelegt.", name, b.Role), b.Role)
			}
		}
	}
	// Version
	switch cmp := CompareVersions(exported.Meta.OrchestratorVersion, cur); {
	case exported.Meta.OrchestratorVersion == "":
		add("info", "no-version", "Die Datei trägt keine Versionsangabe (älterer Export).", "")
	case cmp > 0:
		add("warn", "newer-file", fmt.Sprintf("Die Datei stammt aus einer neueren Version (%s) als diese (%s). Funktionen, die es hier noch nicht gibt, gehen verloren.", exported.Meta.OrchestratorVersion, cur), "")
	case cmp < 0:
		add("info", "older-file", fmt.Sprintf("Die Datei stammt aus einer älteren Version (%s); sie wird mit den Standardwerten dieser Version (%s) ergänzt.", exported.Meta.OrchestratorVersion, cur), "")
	}
	// Felder, die diese Version nicht kennt
	if len(raw) > 0 {
		if extra := UnknownFields(raw); len(extra) > 0 {
			add("warn", "unknown-fields", "Die Datei enthält Felder, die diese Version nicht kennt und verwirft: "+strings.Join(extra, ", ")+".", "")
		}
	}
	// Vorhanden?
	existing, err := s.store.List()
	if err != nil {
		return rep, err
	}
	rep.NewName = uniqueWorkflowName(exported.Name, existing)
	for _, wf := range existing {
		if wf.Name == exported.Name {
			ref := ExistingRef{ID: wf.ID, Name: wf.Name, Status: wf.Status,
				CanReplace: wf.Status == StatusStopped || wf.Status == StatusPaused || wf.Status == StatusStarted}
			rep.Exists = &ref
			d := diffDefinitions(wf.Definition, exported.Definition)
			rep.Diff = &d
			if wf.Status == StatusStarted {
				add("info", "replace-running", "Der vorhandene Workflow läuft. Ersetzen ändert nur die Definition; sie wirkt erst beim nächsten Start.", "")
			} else if !ref.CanReplace {
				add("warn", "replace-blocked", fmt.Sprintf("Der vorhandene Workflow ist „%s“ und lässt sich jetzt nicht ersetzen.", wf.Status), "")
			}
			break
		}
	}
	rep.CanImport = true
	for _, i := range rep.Issues {
		if i.Level == "error" {
			rep.CanImport = false
		}
	}
	return rep, nil
}

// ImportReplace ersetzt die Definition eines vorhandenen Workflows durch die der Datei (Name und ID bleiben). Rollenbindungen
// aus der Datei kommen zu den vorhandenen hinzu (bereits vorhandene gleiche werden nicht doppelt angelegt, nichts wird
// entzogen — ein laufender Workflow trägt Dienst-Bindungen seiner Instanzen); Alarmregeln aus der Datei ersetzen die
// bisherigen Regeln dieses Workflows.
func (s *Service) ImportReplace(id string, exported ExportedWorkflow) (Workflow, error) {
	known := map[string]bool{}
	for _, entry := range s.launcher.Catalog() {
		known[entry.Type] = true
	}
	for _, role := range exported.Definition.Roles {
		if !known[role.NodeType] {
			return Workflow{}, fmt.Errorf("%w: role %q references unknown node type %q (not in catalog)", ErrValidation, role.Name, role.NodeType)
		}
	}
	cur, err := s.store.Get(id)
	if err != nil {
		return Workflow{}, err
	}
	// Zeitplan-Zustand (lastFiredAt) bleibt erhalten, sonst feuerte ein „once“-Zeitplan erneut
	wf, err := s.Update(id, cur.Name, exported.Definition)
	if err != nil {
		return Workflow{}, err
	}
	if s.authz != nil && len(exported.Bindings) > 0 {
		have := map[string]bool{}
		if existing, err := s.authz.LoadByWorkflow(id); err == nil {
			for _, b := range existing {
				have[bindingKey(b.SubjectType, b.Subject, b.NodeID, string(b.Verb))] = true
			}
		}
		for _, b := range exported.Bindings {
			if b.SubjectType == authz.SubjectTypeGroup {
				gid := s.resolveGroupID(b)
				if gid == "" || have[bindingKey(authz.SubjectTypeGroup, gid, b.Role, string(b.Verb))] {
					continue
				}
				if note := s.importGroupBinding(id, b); note != "" {
					wf.ImportNotes = append(wf.ImportNotes, note)
				}
				continue
			}
			if have[bindingKey(authz.SubjectTypeUser, b.Subject, b.Role, string(b.Verb))] {
				continue
			}
			if _, err := s.authz.Create(b.Subject, id, b.Role, b.Verb); err != nil {
				wf.ImportNotes = append(wf.ImportNotes, "Rollenbindung für „"+b.Subject+"“ nicht übernommen: "+err.Error())
			}
		}
	}
	if len(exported.AlertRules) > 0 {
		if s.alertRules == nil {
			wf.ImportNotes = append(wf.ImportNotes, "Alarmregeln nicht übernommen: nicht verfügbar")
		} else if err := s.alertRules.RemoveWorkflow(id); err != nil {
			wf.ImportNotes = append(wf.ImportNotes, "Alarmregeln nicht ersetzt: "+err.Error())
		} else if err := s.alertRules.AddWorkflowRules(id, exported.AlertRules); err != nil {
			wf.ImportNotes = append(wf.ImportNotes, "Alarmregeln nicht übernommen: "+err.Error())
		}
	}
	return wf, nil
}

func bindingKey(typ, subject, role, verb string) string {
	if typ == "" {
		typ = authz.SubjectTypeUser
	}
	return typ + "|" + subject + "|" + role + "|" + verb
}

// resolveGroupID findet die Gruppe einer exportierten Bindung hier: zuerst über den Namen, dann über die ID.
func (s *Service) resolveGroupID(b ExportedBinding) string {
	if s.groups == nil {
		return ""
	}
	if b.SubjectName != "" {
		if id, ok := s.groups.GroupIDByName(b.SubjectName); ok {
			return id
		}
	}
	if _, ok := s.groups.GroupName(b.Subject); ok {
		return b.Subject
	}
	return ""
}

// diffDefinitions beschreibt, was beim Ersetzen von alt durch neu geändert würde.
func diffDefinitions(old, neu Definition) DefinitionDiff {
	var d DefinitionDiff
	oldRoles := map[string]Role{}
	for _, r := range old.Roles {
		oldRoles[r.Name] = r
	}
	newRoles := map[string]Role{}
	for _, r := range neu.Roles {
		newRoles[r.Name] = r
		if o, ok := oldRoles[r.Name]; !ok {
			d.RolesAdded = append(d.RolesAdded, r.Name)
		} else if !jsonEqual(o, r) {
			d.RolesChanged = append(d.RolesChanged, r.Name)
		}
	}
	for _, r := range old.Roles {
		if _, ok := newRoles[r.Name]; !ok {
			d.RolesRemoved = append(d.RolesRemoved, r.Name)
		}
	}
	conn := func(cs []Connection) map[string]bool {
		m := map[string]bool{}
		for _, c := range cs {
			m[c.FromRole+"\x00"+c.FromSender+"\x00"+c.ToRole+"\x00"+c.ToReceiver] = true
		}
		return m
	}
	oc, nc := conn(old.Connections), conn(neu.Connections)
	for k := range nc {
		if !oc[k] {
			d.ConnectionsAdded++
		}
	}
	for k := range oc {
		if !nc[k] {
			d.ConnectionsRemoved++
		}
	}
	d.SettingsChanged = !jsonEqual(old.Settings, neu.Settings)
	// Zeitpläne ohne lastFiredAt vergleichen (das schreibt der Scheduler)
	strip := func(ss []Schedule) []Schedule {
		out := make([]Schedule, len(ss))
		for i, s := range ss {
			s.LastFiredAt = nil
			out[i] = s
		}
		return out
	}
	d.SchedulesChanged = !jsonEqual(strip(old.Schedules), strip(neu.Schedules))
	sort.Strings(d.RolesAdded)
	sort.Strings(d.RolesRemoved)
	sort.Strings(d.RolesChanged)
	return d
}

func jsonEqual(a, b any) bool {
	x, _ := json.Marshal(a)
	y, _ := json.Marshal(b)
	return string(x) == string(y)
}

// CompareVersions vergleicht zwei Versionen der Form „2026.11.6.1“ Zahl für Zahl: −1, 0, 1. Eine nicht lesbare Version
// (z. B. „dev“ oder leer) ergibt 0 — dann gibt es nichts zu warnen.
func CompareVersions(a, b string) int {
	pa, oka := parseVersion(a)
	pb, okb := parseVersion(b)
	if !oka || !okb {
		return 0
	}
	for i := 0; i < len(pa) || i < len(pb); i++ {
		var x, y int
		if i < len(pa) {
			x = pa[i]
		}
		if i < len(pb) {
			y = pb[i]
		}
		if x != y {
			if x < y {
				return -1
			}
			return 1
		}
	}
	return 0
}

func parseVersion(v string) ([]int, bool) {
	v = strings.TrimPrefix(strings.TrimSpace(v), "v")
	if v == "" {
		return nil, false
	}
	var out []int
	for _, p := range strings.Split(v, ".") {
		n, err := strconv.Atoi(p)
		if err != nil {
			return nil, false
		}
		out = append(out, n)
	}
	return out, true
}

// UnknownFields liefert die Pfade der Felder einer Exportdatei, die ExportedWorkflow nicht kennt (z. B. neue Rollenfelder
// einer neueren Version). Verglichen wird die Datei mit sich selbst nach dem Durchlauf durch die Typen: was dabei verloren geht
// und einen echten Wert trug (nicht null/false/0/leer), ist unbekannt.
func UnknownFields(raw []byte) []string {
	var orig any
	if json.Unmarshal(raw, &orig) != nil {
		return nil
	}
	var typed ExportedWorkflow
	if json.Unmarshal(raw, &typed) != nil {
		return nil
	}
	round, err := json.Marshal(typed)
	if err != nil {
		return nil
	}
	var back any
	_ = json.Unmarshal(round, &back)
	have := map[string]bool{}
	flatten("", back, func(p string, _ any) { have[p] = true })
	var missing []string
	flatten("", orig, func(p string, v any) {
		if !have[p] && !isZeroJSON(v) {
			missing = append(missing, p)
		}
	})
	sort.Strings(missing)
	// nur die obersten fehlenden Pfade: „definition.roles[].foo“ statt jedem Unterpfad
	var top []string
	for _, p := range missing {
		covered := false
		for _, t := range top {
			if strings.HasPrefix(p, t+".") || strings.HasPrefix(p, t+"[") {
				covered = true
				break
			}
		}
		if !covered {
			top = append(top, p)
		}
	}
	if len(top) > 8 {
		top = append(top[:8], fmt.Sprintf("… (+%d)", len(top)-8))
	}
	return top
}

// flatten ruft fn für jeden Pfad auf: Objektschlüssel mit „.“, Feldlisten als „[]“.
func flatten(prefix string, v any, fn func(path string, v any)) {
	switch x := v.(type) {
	case map[string]any:
		for k, c := range x {
			p := k
			if prefix != "" {
				p = prefix + "." + k
			}
			fn(p, c)
			flatten(p, c, fn)
		}
	case []any:
		for _, c := range x {
			p := prefix + "[]"
			fn(p, c)
			flatten(p, c, fn)
		}
	}
}

func isZeroJSON(v any) bool {
	switch x := v.(type) {
	case nil:
		return true
	case bool:
		return !x
	case float64:
		return x == 0
	case string:
		return x == ""
	case []any:
		return len(x) == 0
	case map[string]any:
		return len(x) == 0
	}
	return false
}
