package review

import (
	"context"
	"database/sql"
	"errors"
)

// ReleaseInfo ist die Auskunft des Eingangs für die Sendefreigabe (Kapitel 74.3): darf diese Datei gesendet werden,
// wenn der Kanal eine Freigabe verlangt? Regel: „QC grün ODER manuell freigegeben“; eine ausdrückliche Ablehnung
// gewinnt immer, auch bei grüner QC.
type ReleaseInfo struct {
	Known    bool   `json:"known"` // im Eingang registriert
	Released bool   `json:"released"`
	QC       string `json:"qc,omitempty"`
	State    string `json:"state,omitempty"`
	Reason   string `json:"reason"` // Klartext für Anzeige und Protokoll
}

// DecideRelease ist die reine Entscheidung (ohne Datenbank).
func DecideRelease(it Item) ReleaseInfo {
	r := ReleaseInfo{Known: true, QC: it.QCStatus, State: it.State}
	switch {
	case it.State == StateRejected:
		r.Reason = "im Eingang abgelehnt"
	case it.State == StateArchived:
		r.Reason = "im Eingang archiviert"
	case it.State == StateApproved:
		r.Released, r.Reason = true, "manuell freigegeben"
	case it.QCStatus == OverallPass:
		r.Released, r.Reason = true, "QC grün"
	case it.QCStatus == OverallFail:
		r.Reason = "QC rot und nicht freigegeben"
	case it.QCStatus == OverallWarning:
		r.Reason = "QC mit Warnungen, nicht freigegeben"
	case it.QCStatus == "" || it.State == StateAwaitingQC || it.State == StateQCRunning:
		r.Reason = "QC läuft noch bzw. steht aus"
	default:
		r.Reason = "nicht freigegeben (" + it.State + ")"
	}
	return r
}

// ReleaseStatus liefert die Freigabe-Auskunft zu einem Asset.
func (s *Store) ReleaseStatus(ctx context.Context, assetID string) (ReleaseInfo, error) {
	it, err := s.GetItem(ctx, assetID)
	if errors.Is(err, ErrNotFound) {
		return ReleaseInfo{Reason: "nicht im Eingang registriert"}, nil
	}
	if err != nil {
		return ReleaseInfo{}, err
	}
	return DecideRelease(it), nil
}

// ReleaseStatusByFile liefert die Auskunft zur zuletzt geänderten Eingangs-Datei mit diesem Dateinamen
// (für Playlist-Items ohne Asset-Bezug, z. B. aus importierten Fremdlisten).
func (s *Store) ReleaseStatusByFile(ctx context.Context, fileName string) (ReleaseInfo, error) {
	it, err := scanItem(s.db.QueryRowContext(ctx, `SELECT `+itemCols+itemFrom+` WHERE i.file_name=$1 ORDER BY i.updated_at DESC LIMIT 1`, fileName))
	if errors.Is(err, sql.ErrNoRows) {
		return ReleaseInfo{Reason: "nicht im Eingang registriert"}, nil
	}
	if err != nil {
		return ReleaseInfo{}, err
	}
	return DecideRelease(it), nil
}
