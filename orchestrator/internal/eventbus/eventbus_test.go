package eventbus

import "testing"

func TestHostIDFromMetricsSubject(t *testing.T) {
	cases := []struct {
		subject string
		wantID  string
		wantOK  bool
	}{
		{"omp.host.abc123.metrics", "abc123", true},
		{"omp.health.abc123", "", false},
		{"omp.host.metrics", "", false},
		{"omp.host..metrics", "", false},
		{"omp.host.abc123.cmd", "", false},
	}
	for _, c := range cases {
		gotID, gotOK := hostIDFromMetricsSubject(c.subject)
		if gotID != c.wantID || gotOK != c.wantOK {
			t.Errorf("hostIDFromMetricsSubject(%q) = (%q, %v), want (%q, %v)", c.subject, gotID, gotOK, c.wantID, c.wantOK)
		}
	}
}
