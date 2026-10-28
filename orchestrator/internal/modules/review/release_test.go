package review

import "testing"

func TestDecideRelease(t *testing.T) {
	cases := []struct {
		name string
		it   Item
		want bool
	}{
		{"qc grün", Item{State: StateAwaitingReview, QCStatus: OverallPass}, true},
		{"manuell trotz qc rot", Item{State: StateApproved, QCStatus: OverallFail}, true},
		{"qc rot", Item{State: StateAwaitingReview, QCStatus: OverallFail}, false},
		{"warnung ohne freigabe", Item{State: StateAwaitingReview, QCStatus: OverallWarning}, false},
		{"abgelehnt schlägt grün", Item{State: StateRejected, QCStatus: OverallPass}, false},
		{"archiviert", Item{State: StateArchived, QCStatus: OverallPass}, false},
		{"qc steht aus", Item{State: StateAwaitingQC}, false},
		{"qc läuft", Item{State: StateQCRunning}, false},
	}
	for _, c := range cases {
		got := DecideRelease(c.it)
		if got.Released != c.want || got.Reason == "" || !got.Known {
			t.Errorf("%s: released=%v (%s), erwartet %v", c.name, got.Released, got.Reason, c.want)
		}
	}
}
