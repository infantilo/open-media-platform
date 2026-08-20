package authz

import "testing"

func TestVerbCovers(t *testing.T) {
	cases := []struct {
		have, min Verb
		want      bool
	}{
		{VerbAdmin, VerbView, true},
		{VerbAdmin, VerbAdmin, true},
		{VerbConfigure, VerbOperate, true},
		{VerbConfigure, VerbAdmin, false},
		{VerbOperate, VerbConfigure, false},
		{VerbView, VerbOperate, false},
		{VerbView, VerbView, true},
	}
	for _, c := range cases {
		if got := c.have.Covers(c.min); got != c.want {
			t.Errorf("%s.Covers(%s) = %v, want %v", c.have, c.min, got, c.want)
		}
	}
}
