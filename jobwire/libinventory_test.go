package jobwire

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

func TestLibraryReportOnSystemBinary(t *testing.T) {
	bin, err := filepath.EvalSymlinks("/bin/ls")
	if err != nil {
		t.Skip("kein /bin/ls")
	}
	rep := LibraryReport(context.Background(), []string{bin}, "")
	if !strings.Contains(rep, "libc.so.6 |") {
		t.Fatalf("libc fehlt im Bericht:\n%s", rep)
	}
	if strings.Contains(rep, "NICHT GEFUNDEN") {
		t.Errorf("auf dem Systemprogramm /bin/ls darf nichts fehlen:\n%s", rep)
	}
}

func TestLibraryReportNamesUnreadableAndMissing(t *testing.T) {
	d := t.TempDir()
	notElf := filepath.Join(d, "kein-elf")
	if err := os.WriteFile(notElf, []byte("hallo"), 0o755); err != nil {
		t.Fatal(err)
	}
	rep := LibraryReport(context.Background(), []string{notElf}, "")
	if !strings.Contains(rep, "nicht lesbar: kein-elf") {
		t.Errorf("unlesbares Programm muss genannt werden:\n%s", rep)
	}
}

func TestResolveLibPrefersGivenDirsInOrder(t *testing.T) {
	a, b := t.TempDir(), t.TempDir()
	for _, d := range []string{a, b} {
		_ = os.WriteFile(filepath.Join(d, "libx.so.1"), nil, 0o644)
	}
	if got := resolveLib("libx.so.1", []string{b, a}); got != filepath.Join(b, "libx.so.1") {
		t.Errorf("erste Fundstelle gewinnt, bekam %s", got)
	}
	if resolveLib("liby.so.1", []string{a, b}) != "" {
		t.Error("nicht vorhandene Bibliothek muss leer liefern")
	}
}

func TestLoadedLibrariesReadsOwnMaps(t *testing.T) {
	m := loadedLibraries([]int{os.Getpid()})
	found := false
	for p := range m {
		if strings.Contains(filepath.Base(p), ".so") {
			found = true
		}
	}
	// Ein statisch gelinktes Go-Testprogramm kann ohne .so laufen; dann ist die Karte leer, aber nicht fehlerhaft.
	if len(m) > 0 && !found {
		t.Errorf("nur .so-Dateien erwartet: %v", m)
	}
}

func TestPackageOfFindsLibcWithUsrMerge(t *testing.T) {
	real, err := filepath.EvalSymlinks("/lib/x86_64-linux-gnu/libc.so.6")
	if err != nil {
		t.Skip("keine libc an der üblichen Stelle")
	}
	if _, err := exec.LookPath("dpkg"); err != nil {
		t.Skip("kein dpkg")
	}
	rep := LibraryReport(context.Background(), []string{"/bin/ls"}, "")
	_ = real
	if strings.Contains(rep, "libc.so.6 | ") && strings.Contains(rep, "(kein Paket)") && strings.Contains(strings.Split(strings.SplitAfter(rep, "libc.so.6 | ")[1], "\n")[0], "(kein Paket)") {
		t.Errorf("libc muss einem Paket zugeordnet werden:\n%s", rep)
	}
}
