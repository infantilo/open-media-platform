package podmanrun

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

func TestWrapSandboxNoopAndValidation(t *testing.T) {
	argv := []string{"/bin/true"}
	got, env, err := WrapSandbox(argv, []string{"A=1"})
	if err != nil || len(got) != 1 || len(env) != 1 {
		t.Fatalf("ohne Schlüssel unverändert: %v %v %v", got, env, err)
	}
	if _, _, err := WrapSandbox(argv, []string{SandboxKey + "=1"}); err == nil {
		t.Error("ohne Domainpfad muss abgelehnt werden")
	}
	for _, bad := range []string{"relativ/pfad", "/dev/shm/a b", "/dev/shm/a:b", "/dev/shm/$x"} {
		if _, _, err := WrapSandbox(argv, []string{SandboxKey + "=1", "OMP_MXL_DOMAIN=" + bad}); err == nil {
			t.Errorf("%q muss abgelehnt werden", bad)
		}
	}
	if d := SandboxDirs([]string{"OMP_MXL_DOMAIN=/dev/shm/a", "OMP_MXL_TARGET_DOMAIN=/dev/shm/b", "X=1"}); len(d) != 2 || d[0] != "/dev/shm/a" || d[1] != "/dev/shm/b" {
		t.Errorf("SandboxDirs = %v", d)
	}
	if d := SandboxDirs([]string{"OMP_MXL_DOMAIN=/dev/shm/a", "OMP_MXL_TARGET_DOMAIN=/dev/shm/a"}); len(d) != 1 {
		t.Errorf("gleiche Domain nur einmal: %v", d)
	}
}

// Echte Sandbox: die Domain A ist sichtbar und beschreibbar, B (eine andere Domain im selben /dev/shm) nicht.
func TestSandboxHidesOtherDomains(t *testing.T) {
	if err := SandboxAvailable(); err != nil {
		t.Skip("Sandbox nicht verfügbar:", err)
	}
	if _, err := os.Stat("/dev/shm"); err != nil {
		t.Skip("kein /dev/shm")
	}
	base, err := os.MkdirTemp("/dev/shm", "omp-sbxtest-")
	if err != nil {
		t.Skip(err)
	}
	defer os.RemoveAll(base)
	a, b := filepath.Join(base, "a"), filepath.Join(base, "b")
	for _, d := range []string{a, b} {
		if err := os.MkdirAll(d, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	os.WriteFile(filepath.Join(a, "f"), []byte("A"), 0o644)
	os.WriteFile(filepath.Join(b, "f"), []byte("B"), 0o644)

	script := `echo "sees:$(ls ` + base + ` | tr '\n' ',')"; echo "A:$(cat ` + a + `/f)"; echo "B:$(cat ` + b + `/f 2>&1 | head -c 20)"; echo neu > ` + a + `/geschrieben`
	argv, env, err := WrapSandbox([]string{"sh", "-c", script}, append(os.Environ(), SandboxKey+"=1", "OMP_MXL_DOMAIN="+a))
	if err != nil {
		t.Fatal(err)
	}
	cmd := exec.Command(argv[0], argv[1:]...)
	cmd.Env = env
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("Sandbox-Lauf: %v\n%s", err, out)
	}
	s := string(out)
	if !strings.Contains(s, "sees:a,") || strings.Contains(s, "b,") {
		t.Errorf("nur Domain a darf sichtbar sein: %s", s)
	}
	if !strings.Contains(s, "A:A") {
		t.Errorf("eigene Domain muss lesbar sein: %s", s)
	}
	if strings.Contains(s, "B:B") {
		t.Errorf("fremde Domain darf nicht lesbar sein: %s", s)
	}
	// Schreiben in die eigene Domain kommt draußen an (gleiche Dateien)
	if d, err := os.ReadFile(filepath.Join(a, "geschrieben")); err != nil || !strings.Contains(string(d), "neu") {
		t.Errorf("Schreiben aus der Sandbox kam nicht an: %v", err)
	}
	// Auch nach dem Lauf: nichts Zurückgebliebenes im echten /tmp
	if m, _ := filepath.Glob(filepath.Join(os.TempDir(), "omp-sbx.*")); len(m) > 0 {
		t.Errorf("Stage-Verzeichnisse blieben liegen: %v", m)
	}
}
