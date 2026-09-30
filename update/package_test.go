package update

import (
	"archive/tar"
	"compress/gzip"
	"crypto/ed25519"
	"crypto/rand"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func writeFile(t *testing.T, dir, name, content string) string {
	t.Helper()
	p := filepath.Join(dir, name)
	if err := os.WriteFile(p, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
	return p
}

func buildPkg(t *testing.T, priv ed25519.PrivateKey) (pkgPath string, files []BuildFile) {
	t.Helper()
	dir := t.TempDir()
	files = []BuildFile{
		{ID: "orchestrator", Source: writeFile(t, dir, "orch", "ORCH-BINARY"), Path: "orchestrator/omp-orchestrator", Target: "bin/omp-orchestrator"},
		{ID: "ui", Source: writeFile(t, dir, "shell.js", "UI"), Path: "ui/dist/shell.js", Target: "ui/dist/shell.js"},
		{ID: "node-source", Source: writeFile(t, dir, "src", "SRC"), Path: "nodes/omp-source", Target: "node:omp-source"},
	}
	pkgPath = filepath.Join(dir, "p.tar.gz")
	err := Build(pkgPath, Manifest{Version: "2026.10.0", Arch: "linux/amd64", Migrations: []string{"0031_x.sql"}}, priv, files)
	if err != nil {
		t.Fatalf("Build: %v", err)
	}
	return pkgPath, files
}

func keys(t *testing.T) (ed25519.PublicKey, ed25519.PrivateKey) {
	t.Helper()
	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	return pub, priv
}

func TestReadPackageSigned(t *testing.T) {
	pub, priv := keys(t)
	p, _ := buildPkg(t, priv)
	pkg, err := ReadPackage(p, Options{Trusted: []ed25519.PublicKey{pub}, Arch: "linux/amd64"})
	if err != nil {
		t.Fatalf("ReadPackage: %v", err)
	}
	if !pkg.Signed || pkg.KeyID != KeyID(pub) || pkg.Manifest.Version != "2026.10.0" || len(pkg.Manifest.Components) != 3 || pkg.SHA256 == "" {
		t.Errorf("unexpected package: %+v", pkg)
	}
}

func TestReadPackageWholeFileHashMatchesFile(t *testing.T) {
	pub, priv := keys(t)
	p, _ := buildPkg(t, priv)
	want, err := fileSHA256(p)
	if err != nil {
		t.Fatal(err)
	}
	pkg, err := ReadPackage(p, Options{Trusted: []ed25519.PublicKey{pub}})
	if err != nil {
		t.Fatal(err)
	}
	if pkg.SHA256 != want {
		t.Errorf("SHA256 = %s, want %s", pkg.SHA256, want)
	}
}

func TestReadPackageRejectsUntrustedKey(t *testing.T) {
	_, priv := keys(t)
	other, _ := keys(t)
	p, _ := buildPkg(t, priv)
	if _, err := ReadPackage(p, Options{Trusted: []ed25519.PublicKey{other}}); !errors.Is(err, ErrBadSignature) {
		t.Errorf("err = %v, want ErrBadSignature", err)
	}
	if _, err := ReadPackage(p, Options{}); !errors.Is(err, ErrBadSignature) {
		t.Errorf("no trusted keys: err = %v, want ErrBadSignature", err)
	}
}

func TestReadPackageUnsigned(t *testing.T) {
	p, _ := buildPkg(t, nil)
	if _, err := ReadPackage(p, Options{}); !errors.Is(err, ErrUnsigned) {
		t.Errorf("err = %v, want ErrUnsigned", err)
	}
	pkg, err := ReadPackage(p, Options{AllowUnsigned: true})
	if err != nil || pkg.Signed {
		t.Errorf("AllowUnsigned: pkg=%+v err=%v", pkg, err)
	}
}

func TestReadPackageWrongArch(t *testing.T) {
	pub, priv := keys(t)
	p, _ := buildPkg(t, priv)
	if _, err := ReadPackage(p, Options{Trusted: []ed25519.PublicKey{pub}, Arch: "linux/arm64"}); err == nil {
		t.Error("expected arch mismatch error")
	}
}

// rawArchive baut ein Archiv mit frei wählbaren Einträgen (auch bösartigen).
func rawArchive(t *testing.T, entries []tar.Header, bodies []string) string {
	t.Helper()
	p := filepath.Join(t.TempDir(), "raw.tar.gz")
	f, _ := os.Create(p)
	gz := gzip.NewWriter(f)
	tw := tar.NewWriter(gz)
	for i, h := range entries {
		h := h
		h.Size = int64(len(bodies[i]))
		if err := tw.WriteHeader(&h); err != nil {
			t.Fatal(err)
		}
		_, _ = tw.Write([]byte(bodies[i]))
	}
	_ = tw.Close()
	_ = gz.Close()
	_ = f.Close()
	return p
}

func manifestFor(comps string) string {
	return `{"schemaVersion":1,"version":"1.0.0","arch":"linux/amd64","components":[` + comps + `]}`
}

func TestReadPackageRejectsBadArchives(t *testing.T) {
	sum := "2c26b46b68ffc68ff99b453c1d30413413422d706483bfa0f98a5e886266e7ae" // sha256("foo")
	good := `{"id":"a","path":"orchestrator/x","sha256":"` + sum + `","target":"bin/omp-orchestrator"}`
	cases := []struct {
		name    string
		entries []tar.Header
		bodies  []string
	}{
		{"symlink", []tar.Header{{Name: "manifest.json", Typeflag: tar.TypeReg, Mode: 0o644}, {Name: "orchestrator/x", Typeflag: tar.TypeSymlink, Linkname: "/etc/passwd"}}, []string{manifestFor(good), ""}},
		{"traversal", []tar.Header{{Name: "manifest.json", Typeflag: tar.TypeReg, Mode: 0o644}, {Name: "../evil", Typeflag: tar.TypeReg, Mode: 0o644}}, []string{manifestFor(good), "foo"}},
		{"absolute", []tar.Header{{Name: "manifest.json", Typeflag: tar.TypeReg, Mode: 0o644}, {Name: "/etc/evil", Typeflag: tar.TypeReg, Mode: 0o644}}, []string{manifestFor(good), "foo"}},
		{"hash mismatch", []tar.Header{{Name: "manifest.json", Typeflag: tar.TypeReg, Mode: 0o644}, {Name: "orchestrator/x", Typeflag: tar.TypeReg, Mode: 0o644}}, []string{manifestFor(good), "bar"}},
		{"unlisted file", []tar.Header{{Name: "manifest.json", Typeflag: tar.TypeReg, Mode: 0o644}, {Name: "orchestrator/x", Typeflag: tar.TypeReg, Mode: 0o644}, {Name: "extra", Typeflag: tar.TypeReg, Mode: 0o644}}, []string{manifestFor(good), "foo", "x"}},
		{"missing component", []tar.Header{{Name: "manifest.json", Typeflag: tar.TypeReg, Mode: 0o644}}, []string{manifestFor(good)}},
		{"bad target", []tar.Header{{Name: "manifest.json", Typeflag: tar.TypeReg, Mode: 0o644}, {Name: "orchestrator/x", Typeflag: tar.TypeReg, Mode: 0o644}}, []string{manifestFor(`{"id":"a","path":"orchestrator/x","sha256":"` + sum + `","target":"etc/passwd"}`), "foo"}},
		{"target traversal", []tar.Header{{Name: "manifest.json", Typeflag: tar.TypeReg, Mode: 0o644}, {Name: "orchestrator/x", Typeflag: tar.TypeReg, Mode: 0o644}}, []string{manifestFor(`{"id":"a","path":"orchestrator/x","sha256":"` + sum + `","target":"ui/dist/../../etc/x"}`), "foo"}},
		{"no manifest", []tar.Header{{Name: "orchestrator/x", Typeflag: tar.TypeReg, Mode: 0o644}}, []string{"foo"}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			p := rawArchive(t, tc.entries, tc.bodies)
			if _, err := ReadPackage(p, Options{AllowUnsigned: true}); err == nil {
				t.Errorf("%s: expected error", tc.name)
			}
		})
	}
	// Positivfall derselben Bauart, damit die Ablehnungen oben nicht an
	// einem Testfehler hängen.
	p := rawArchive(t, []tar.Header{{Name: "manifest.json", Typeflag: tar.TypeReg, Mode: 0o644}, {Name: "orchestrator/x", Typeflag: tar.TypeReg, Mode: 0o644}}, []string{manifestFor(good), "foo"})
	if _, err := ReadPackage(p, Options{AllowUnsigned: true}); err != nil {
		t.Errorf("positive control failed: %v", err)
	}
}

func TestExtractFile(t *testing.T) {
	pub, priv := keys(t)
	p, files := buildPkg(t, priv)
	pkg, err := ReadPackage(p, Options{Trusted: []ed25519.PublicKey{pub}})
	if err != nil {
		t.Fatal(err)
	}
	c := pkg.Manifest.Components[0]
	dst := filepath.Join(t.TempDir(), "out")
	if err := ExtractFile(p, c.Path, c.SHA256, dst, 0o755); err != nil {
		t.Fatalf("ExtractFile: %v", err)
	}
	got, _ := os.ReadFile(dst)
	want, _ := os.ReadFile(files[0].Source)
	if string(got) != string(want) {
		t.Errorf("content = %q", got)
	}
	if st, _ := os.Stat(dst); st.Mode().Perm() != 0o755 {
		t.Errorf("mode = %v", st.Mode())
	}
	// falscher Hash → Fehler, keine Datei.
	dst2 := filepath.Join(t.TempDir(), "out2")
	if err := ExtractFile(p, c.Path, strings.Repeat("0", 64), dst2, 0o755); err == nil {
		t.Error("expected checksum error")
	}
	if _, err := os.Stat(dst2); err == nil {
		t.Error("file must be removed after failed extract")
	}
}

func TestCheckTarget(t *testing.T) {
	ok := []string{"bin/omp-orchestrator", "bin/omp-supervisor", "bin/omp-host-agent", "ui/dist/shell.js", "ui/dist/sub/a.js", "node:omp-source"}
	bad := []string{"", "bin/other", "/bin/omp-orchestrator", "ui/dist/", "ui/dist/../x", "ui/dist/a/../b", "node:", "node:evil", "node:omp-x/../y", "etc/passwd", "ui/dist/a\\b"}
	for _, s := range ok {
		if err := CheckTarget(s); err != nil {
			t.Errorf("CheckTarget(%q) = %v", s, err)
		}
	}
	for _, s := range bad {
		if err := CheckTarget(s); err == nil {
			t.Errorf("CheckTarget(%q) should fail", s)
		}
	}
}

func TestCompareVersions(t *testing.T) {
	cases := []struct {
		a, b string
		want int
	}{{"2026.10.0", "2026.9.3", 1}, {"2026.9", "2026.9.0", 0}, {"1.0.0", "1.0.1", -1}, {"2.0.0-rc1", "2.0.0", 0}}
	for _, c := range cases {
		if got := CompareVersions(c.a, c.b); got != c.want {
			t.Errorf("CompareVersions(%s,%s) = %d, want %d", c.a, c.b, got, c.want)
		}
	}
}

func TestParsePublicKeys(t *testing.T) {
	pub, _ := keys(t)
	line := KeyID(pub)
	_ = line
	if _, err := ParsePublicKeys([]byte("# c\n\nnot-base64!!\n")); err == nil {
		t.Error("expected error for invalid key")
	}
	if ks, err := ParsePublicKeys([]byte("# nur Kommentar\n")); err != nil || len(ks) != 0 {
		t.Errorf("comment only: %v %v", ks, err)
	}
}
