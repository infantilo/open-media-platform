package review

import (
	"context"
	"net/http"
	"sort"

	"github.com/infantilo/openmediaplatform/orchestrator/internal/module"
)

// Funktionsrechte des Moduls (Kapitel 44). Globales `configure` deckt alle ab; Operatoren bekommen genau, was ihnen vergeben wird.
const (
	FeatView    = "review.view"    // alle Dateien der Arbeitsliste sehen (ohne: nur zugewiesene/eigene)
	FeatQCRun   = "review.qc.run"  // QC-Lauf anstoßen, Review-Proxy erzeugen
	FeatWork    = "review.work"    // Dateien übernehmen, Conform bearbeiten, einreichen
	FeatApprove = "review.approve" // freigeben, ablehnen, archivieren
	FeatAssign  = "review.assign"  // Aufgaben zuweisen, übertragen, Übernahme lösen
	FeatImport  = "review.import"  // Dateien importieren und registrieren
)

func (*Module) Features() []module.FeatureDef {
	g := map[string]string{"de": "File Eingangskontrolle", "en": "File intake control"}
	f := func(id, de, en, dde, den string) module.FeatureDef {
		return module.FeatureDef{ID: id, Label: map[string]string{"de": de, "en": en}, Description: map[string]string{"de": dde, "en": den}, Group: g}
	}
	return []module.FeatureDef{
		f(FeatView, "Alle Dateien sehen", "See all files", "Ohne dieses Recht sieht die Person nur Dateien, die ihr oder ihrer Gruppe zugewiesen sind oder die sie bearbeitet.", "Without it the person only sees files assigned to them or their group, or that they are working on."),
		f(FeatQCRun, "QC durchführen", "Run QC", "Die automatische Prüfung starten und den Review-Proxy erzeugen.", "Start the automatic check and create the review proxy."),
		f(FeatWork, "Dateien bearbeiten", "Work on files", "Dateien übernehmen, im Review-Player prüfen, den Conform bearbeiten und zur Freigabe einreichen.", "Take files, review them in the player, edit the conform and submit for approval."),
		f(FeatApprove, "Freigeben und ablehnen", "Approve and reject", "Eingereichte Dateien freigeben oder ablehnen sowie archivieren.", "Approve or reject submitted files, and archive."),
		f(FeatAssign, "Aufgaben zuweisen", "Assign tasks", "Dateien einer Person oder Gruppe zuweisen, Bearbeitung übertragen oder lösen; zugewiesene Dateien auch ohne Zuweisung übernehmen.", "Assign files to a person or group, transfer or release work; take assigned files regardless of assignment."),
		f(FeatImport, "Dateien importieren", "Import files", "Dateien aus dem Importverzeichnis aufnehmen und Assets in den Eingang registrieren.", "Take in files from the import folder and register assets for intake."),
	}
}

// Tiles: die Kachel „Eingang“ des Arbeitsplatzes (dieselbe Ansicht wie der Tab, die Server-Rechte beschränken den Inhalt).
func (*Module) Tiles() []module.UITile {
	return []module.UITile{{
		ID: "intake", Label: map[string]string{"de": "File Eingangskontrolle", "en": "File intake control"},
		Needs:   []string{"review.*"},
		Element: "omp-review-view", Bundle: "/dist/modules/review.js",
	}}
}

// identity: die Person der Anfrage (ohne Rechte-Speicher: der Handlungsname, keine Gruppen).
func (a *api) identity(r *http.Request) module.Identity {
	if a.access == nil {
		return module.Identity{User: actorOf(r), Has: func(string) bool { return true }}
	}
	return a.access.Identity(r)
}

// scopeFor: Sicht der Person auf die Arbeitsliste; nil = alles (Recht „review.view“).
func (a *api) scopeFor(r *http.Request) *Scope {
	if a.access == nil {
		return nil
	}
	id := a.access.Identity(r)
	if id.Has(FeatView) {
		return nil
	}
	return &Scope{User: id.User, Groups: id.Groups, Approver: id.Has(FeatApprove)}
}

// visible: darf die Person diesen Eintrag sehen?
func (a *api) visible(r *http.Request, it Item) bool {
	sc := a.scopeFor(r)
	if sc == nil {
		return true
	}
	if it.Assignee == sc.User || it.AssignedTo == sc.User {
		return true
	}
	if it.AssignedGroup != "" {
		for _, g := range sc.Groups {
			if g == it.AssignedGroup {
				return true
			}
		}
	}
	return sc.Approver && it.State == StateReadyForApproval
}

// Tasks: Dateien, die der Person (oder einer ihrer Gruppen) zur Prüfung zugewiesen sind, die sie bearbeitet, und bei Freigabe-Recht
// die eingereichten.
func (m *Module) Tasks(ctx context.Context, who module.Identity) ([]module.Task, error) {
	m.mu.Lock()
	svc := m.svc
	m.mu.Unlock()
	if svc == nil {
		return nil, nil
	}
	items, err := svc.St.ListItems(ctx, ListFilter{Limit: 500, Scope: &Scope{User: who.User, Groups: who.Groups, Approver: who.Has(FeatApprove)}})
	if err != nil {
		return nil, err
	}
	now := svc.now()
	var out []module.Task
	for _, it := range items {
		if it.State == StateApproved || it.State == StateArchived {
			continue
		}
		title := it.Title
		if title == "" {
			title = it.FileName
		}
		t := module.Task{
			ID: it.AssetID, Kind: "qc", Title: title, State: it.State, Status: "ok",
			Assignee: it.AssignedTo, AssigneeGroup: it.AssignedGroup,
			Mine:   it.Assignee == who.User || it.AssignedTo == who.User,
			DueAt:  it.DueAt,
			Detail: it.FileName,
			Action: module.TaskAction{Tab: "review", Ref: it.AssetID},
		}
		approvalOnly := it.State == StateReadyForApproval && it.Assignee != who.User && it.AssignedTo != who.User
		if approvalOnly {
			t.Kind = "approval"
		}
		t.Claimable = it.Assignee == "" && it.AssignedTo == "" && it.AssignedGroup != "" && who.InGroup(it.AssignedGroup) &&
			contains(svc.claimableStates(), it.State)
		switch {
		case it.State == StateQCFailedToRun:
			t.Status, t.Problem, t.ProblemCode = "error", "QC konnte nicht ausgeführt werden", "qc_not_run"
		case it.QCStatus == OverallFail || it.QCFail > 0:
			t.Status, t.Problem, t.ProblemCode = "warn", "QC mit Fehlern", "qc_failed"
		case it.State == StateRejected:
			t.Status, t.Problem, t.ProblemCode = "warn", "abgelehnt – Nacharbeit", "rejected"
		case it.State == StateInReview || it.State == StateConforming:
			t.Status = "active"
		}
		if it.DueAt != nil && it.DueAt.Before(now) {
			t.Overdue = true
			t.Status = "error"
			t.Problem, t.ProblemCode = "überfällig", "overdue"
		}
		out = append(out, t)
	}
	sort.SliceStable(out, func(i, j int) bool {
		a, b := out[i].DueAt, out[j].DueAt
		switch {
		case a != nil && b != nil:
			return a.Before(*b)
		case a != nil:
			return true
		case b != nil:
			return false
		}
		return out[i].Title < out[j].Title
	})
	return out, nil
}
