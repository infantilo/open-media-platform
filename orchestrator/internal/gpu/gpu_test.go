package gpu

import "testing"

func TestParsePmonAndTree(t *testing.T) {
	out := `# gpu         pid   type     sm    mem    enc    dec    jpg    ofa     fb   ccpm    command
# Idx           #    C/G      %      %      %      %      %      %     MB     MB    name
    0       100     C     10      7      0      -      -      -   1000      0    a
    0       300     G     20      2      -      -      -      -    500      0    b
    0       500     C      -      -      -      -      -      -      -      -    c
`
	procs, err := ParsePmon(out)
	if err != nil || len(procs) != 3 {
		t.Fatalf("ParsePmon = %v %v", procs, err)
	}
	g := ForTree(procs, map[int]int{300: 200, 200: 100, 500: 1}, 100)
	if g.SM != 30 || g.FB != 1500<<20 || !g.HasFB {
		t.Errorf("tree = %+v", g)
	}
	if _, err := ParsePmon("No devices were found\n"); err == nil {
		t.Error("unbekanntes Format muss fehlschlagen")
	}
}

func TestParseHostPoolAndSpec(t *testing.T) {
	s, err := ParseHost("0, 40, 1000, 8000\n1, 20, 3000, 8000\n")
	if err != nil || s.Count != 2 || s.UtilPercent != 30 || s.MemUsed != 4000<<20 || s.MemTotal != 16000<<20 {
		t.Errorf("pool = %+v %v", s, err)
	}
	for in, want := range map[string]bool{"": true, "auto": true, "off": false, "3": true} {
		if _, en, err := ParseSpec(in); err != nil || en != want {
			t.Errorf("ParseSpec(%q) = %v %v", in, en, err)
		}
	}
	if _, _, err := ParseSpec("x"); err == nil {
		t.Error("ungültige Spec muss fehlschlagen")
	}
}
