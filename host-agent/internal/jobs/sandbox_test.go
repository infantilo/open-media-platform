package jobs

import (
	"bytes"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"
)

func sandboxRunner(t *testing.T, allowNet bool) (*Runner, *fakePub, string) {
	t.Helper()
	root := t.TempDir()
	pub := &fakePub{}
	cfg := Config{
		Tools:    map[string]ToolConfig{"ffmpeg": {Path: "/usr/bin/ffmpeg", Sandbox: "container"}, "ffprobe": {Path: "/usr/bin/ffprobe", Sandbox: "container"}},
		JobRoots: []string{root}, AllowNet: allowNet, MaxJobs: 2, CPUQuota: "200%", SandboxImage: "localhost/omp-ffmpeg-sandbox:test",
	}
	return NewRunner(cfg, "h1", t.TempDir(), pub), pub, root
}

func has(args []string, want ...string) bool {
	for i := 0; i+len(want) <= len(args); i++ {
		if strings.Join(args[i:i+len(want)], "\x00") == strings.Join(want, "\x00") {
			return true
		}
	}
	return false
}

func TestSandboxArgsAreHardened(t *testing.T) {
	r, _, root := sandboxRunner(t, false)
	in := filepath.Join(root, "in.mxf")
	if err := os.WriteFile(in, []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	outDir := filepath.Join(root, "out")
	if err := os.MkdirAll(outDir, 0o755); err != nil {
		t.Fatal(err)
	}
	out := filepath.Join(outDir, "a.mp4.part")
	work := filepath.Join(t.TempDir(), "job1")
	a := r.sandboxArgs("job1", "ffmpeg", []string{"-i", in, "-c:v", "libx264", out}, 10, work, 1000, 1000)
	for _, want := range [][]string{
		{"--read-only"}, {"--cap-drop=all"}, {"--security-opt=no-new-privileges"}, {"--network=none"}, {"--pull=never"}, {"--rm"},
		{"--userns=keep-id"}, {"--user", "1000:1000"}, {"--pids-limit", "512"}, {"--memory", "8192m"}, {"--memory-swap", "8192m"},
		{"--cpus", "2"}, {"--label", "omp-job=1"}, {"--name", "omp-job-job1"}, {"-e", "HOME=/tmp"}, {"-w", work},
		{"-v", root + ":" + root + ":ro"}, {"-v", outDir + ":" + outDir + ":rw"}, {"-v", work + ":" + work + ":rw"},
	} {
		if !has(a, want...) {
			t.Errorf("fehlt: %v\nin %v", want, a)
		}
	}
	// Befehl am Ende: Image, nice, Programm, Argumente (das Programm heißt im Container nur ffmpeg, nicht wie der Host-Pfad)
	if !has(a, "localhost/omp-ffmpeg-sandbox:test", "nice", "-n", "10", "ffmpeg", "-i", in) || a[len(a)-1] != out {
		t.Errorf("Befehlsteil: %v", a)
	}
	for _, bad := range []string{"--privileged", "--network=host", "--security-opt=seccomp=unconfined", "--device", "omp-mxl", "/dev/shm", "--cap-add"} {
		for _, x := range a {
			if strings.Contains(x, bad) {
				t.Errorf("verbotene Option %q in %v", bad, a)
			}
		}
	}
	// Eingabe bleibt nur lesbar: kein eigener rw-Einhängepunkt für die Eingabedatei oder die Wurzel
	if has(a, "-v", root+":"+root+":rw") {
		t.Error("Wurzel darf nicht schreibbar sein")
	}
}

func TestSandboxArgsNetworkOnlyWithAllowNet(t *testing.T) {
	r, _, root := sandboxRunner(t, true)
	a := r.sandboxArgs("j", "ffprobe", []string{filepath.Join(root, "x")}, 10, t.TempDir(), 1, 1)
	if has(a, "--network=none") {
		t.Error("mit allowNet darf das Netz nicht gesperrt werden")
	}
}

func TestSandboxOutputInRootMakesRootWritableButNotMore(t *testing.T) {
	r, _, root := sandboxRunner(t, false)
	a := r.sandboxArgs("j", "ffmpeg", []string{"-i", filepath.Join(root, "in"), filepath.Join(root, "neu.mp4")}, 10, t.TempDir(), 1, 1)
	if !has(a, "-v", root+":"+root+":rw") || has(a, "-v", root+":"+root+":ro") {
		t.Errorf("Ausgabe direkt in der Wurzel: Wurzel genau einmal und schreibbar erwartet: %v", a)
	}
}

func TestWritableDirsOnlyForNewPathsUnderRoots(t *testing.T) {
	r, _, root := sandboxRunner(t, false)
	existing := filepath.Join(root, "vorhanden.mp4")
	_ = os.WriteFile(existing, nil, 0o644)
	sub := filepath.Join(root, "ziel")
	_ = os.MkdirAll(sub, 0o755)
	got := r.writableDirs([]string{"-i", existing, "file:" + filepath.Join(sub, "x.part"), "-vf", "scale=1:1", "relativ.mp4", filepath.Join(root, "fehlt", "y.part")})
	if len(got) != 1 || got[0] != sub {
		t.Errorf("nur das vorhandene Zielverzeichnis erwartet: %v", got)
	}
	// Wiederholung: die `.part`-Datei eines abgebrochenen Laufs ist noch da und bleibt beschreibbar (Ausgabe, keine Eingabe)
	stale := filepath.Join(sub, "alt.mp4.part")
	_ = os.WriteFile(stale, []byte("halb"), 0o644)
	if got := r.writableDirs([]string{"-i", existing, stale}); len(got) != 1 || got[0] != sub {
		t.Errorf("vorhandene .part-Datei muss als Ausgabe gelten: %v", got)
	}
	// Mit -y gilt das letzte Argument als Ausgabe, auch wenn es schon existiert; ohne -y bleibt es nur lesbar
	if got := r.writableDirs([]string{"-y", "-i", "x", filepath.Join(root, "vorhanden.mp4")}); len(got) != 1 || got[0] != root {
		t.Errorf("-y: letztes Argument ist die Ausgabe: %v", got)
	}
	if got := r.writableDirs([]string{"-i", "x", filepath.Join(root, "vorhanden.mp4")}); len(got) != 0 {
		t.Errorf("ohne -y bleibt ein vorhandener Pfad nur lesbar: %v", got)
	}
}

func TestLoadFileValidatesSandbox(t *testing.T) {
	dir := t.TempDir()
	write := func(s string) string {
		p := filepath.Join(dir, "t.json")
		_ = os.WriteFile(p, []byte(s), 0o644)
		return p
	}
	if _, err := LoadFile(write(`{"tools":{"ffmpeg":{"path":"/usr/bin/ffmpeg","sandbox":"container"}},"jobRoots":["/srv/m"]}`)); err == nil || !strings.Contains(err.Error(), "sandboxImage") {
		t.Errorf("Container ohne Image muss abgelehnt werden: %v", err)
	}
	if _, err := LoadFile(write(`{"tools":{"ffmpeg":{"path":"/usr/bin/ffmpeg","sandbox":"vm"}},"jobRoots":["/srv/m"]}`)); err == nil {
		t.Error("unbekannter Sandbox-Wert muss abgelehnt werden")
	}
	c, err := LoadFile(write(`{"tools":{"ffmpeg":{"path":"/usr/bin/ffmpeg","sandbox":"container"}},"jobRoots":["/srv/m"],"sandboxImage":"x:1"}`))
	if err != nil || !c.Tools["ffmpeg"].sandboxed() {
		t.Errorf("gültige Sandbox-Konfiguration: %v", err)
	}
	c, err = LoadFile(write(`{"tools":{"ffmpeg":{"path":"/usr/bin/ffmpeg"}},"jobRoots":["/srv/m"]}`))
	if err != nil || c.Tools["ffmpeg"].sandboxed() {
		t.Error("ohne Eintrag bleibt der Standard none")
	}
}

func TestCpusFromQuota(t *testing.T) {
	for in, want := range map[string]float64{"200%": 2, "50%": 0.5, " 150 % ": 1.5, "": 0, "abc": 0, "0%": 0} {
		if got := cpusFromQuota(in); got != want {
			t.Errorf("%q → %v, erwartet %v", in, got, want)
		}
	}
}

// Fake-Podman: schreibt seine Argumente in eine Datei; „run“ bleibt, bis die Datei stop existiert.
func fakePodman(t *testing.T) (calls string, stop string) {
	t.Helper()
	dir := t.TempDir()
	calls, stop = filepath.Join(dir, "calls"), filepath.Join(dir, "stop")
	script := "#!/bin/sh\necho \"$@\" >> " + calls + "\ncase \"$1\" in run) while [ ! -e " + stop + " ]; do sleep 0.05; done; echo fertig >&2;; esac\nexit 0\n"
	p := filepath.Join(dir, "podman")
	if err := os.WriteFile(p, []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	old := PodmanBinary
	PodmanBinary = p
	t.Cleanup(func() { PodmanBinary = old })
	return calls, stop
}

func TestSandboxJobPauseUndAbbruchGehenUeberPodman(t *testing.T) {
	calls, stop := fakePodman(t)
	r, pub, root := sandboxRunner(t, false)
	_, err := r.Exec(Request{JobID: "j1", Tool: "ffmpeg", Args: []string{"-i", filepath.Join(root, "a"), filepath.Join(root, "b.part")}})
	if err != nil {
		t.Fatal(err)
	}
	time.Sleep(300 * time.Millisecond)
	if err := r.Pause("j1", true); err != nil {
		t.Fatal(err)
	}
	if err := r.Pause("j1", false); err != nil {
		t.Fatal(err)
	}
	if err := r.Renice("j1", 5); err == nil || !strings.Contains(err.Error(), "Sandbox") {
		t.Errorf("Renice muss bei Sandbox-Jobs klar abgelehnt werden: %v", err)
	}
	if err := r.Cancel("j1"); err != nil {
		t.Fatal(err)
	}
	_ = os.WriteFile(stop, nil, 0o644)
	ev := wait(t, pub, "j1")
	if ev.Error == "" {
		t.Errorf("Abbruch muss gemeldet werden: %+v", ev)
	}
	b, _ := os.ReadFile(calls)
	log := string(b)
	for _, want := range []string{"run --rm --name omp-job-j1", "pause omp-job-j1", "unpause omp-job-j1"} {
		if !strings.Contains(log, want) {
			t.Errorf("Aufruf %q fehlt:\n%s", want, log)
		}
	}
}

func TestSandboxCleanupRemovesLeftoverContainers(t *testing.T) {
	calls, _ := fakePodman(t)
	r, _, _ := sandboxRunner(t, false)
	r.CleanupStale()
	b, _ := os.ReadFile(calls)
	if !strings.Contains(string(b), "ps -aq --filter label=omp-job=1") {
		t.Errorf("verwaiste Job-Container werden gesucht:\n%s", b)
	}
}

// ---- echte Sandbox (nur mit Podman und gebautem Image: OMP_SANDBOX_TEST_IMAGE=localhost/omp-ffmpeg-sandbox:<Version>) ----

func realSandbox(t *testing.T) (*Runner, *fakePub, string) {
	t.Helper()
	img := os.Getenv("OMP_SANDBOX_TEST_IMAGE")
	if img == "" {
		t.Skip("OMP_SANDBOX_TEST_IMAGE nicht gesetzt")
	}
	if _, err := exec.LookPath("podman"); err != nil {
		t.Skip("kein podman")
	}
	r, pub, root := sandboxRunner(t, false)
	r.cfg.SandboxImage = img
	return r, pub, root
}

// runSandbox startet die Sandbox DIREKT (an der Argumentprüfung vorbei) — beweist, dass die Sandbox selbst schützt.
func runSandbox(t *testing.T, r *Runner, tool string, args ...string) (string, int) {
	t.Helper()
	work := filepath.Join(t.TempDir(), "w")
	_ = os.MkdirAll(work, 0o750)
	cmd := exec.Command(PodmanBinary, r.sandboxArgs("probe-"+strings.ReplaceAll(t.Name(), "/", "_"), tool, args, 10, work, os.Getuid(), os.Getgid())...)
	var out bytes.Buffer
	cmd.Stdout, cmd.Stderr = &out, &out
	err := cmd.Run()
	code := 0
	if ee, ok := err.(*exec.ExitError); ok {
		code = ee.ExitCode()
	} else if err != nil {
		t.Fatal(err)
	}
	// Podman meldet auf cgroup-v1-Systemen ohne Delegation, dass Ressourcengrenzen ignoriert werden — kein Teil der Ausgabe des Programms.
	var lines []string
	for _, l := range strings.Split(out.String(), "\n") {
		if !strings.Contains(l, "Resource limits are not supported") {
			lines = append(lines, l)
		}
	}
	return strings.Join(lines, "\n"), code
}

func makeClip(t *testing.T, path string, secs string) {
	t.Helper()
	if out, err := exec.Command("ffmpeg", "-y", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc=size=320x240:rate=25", "-t", secs, "-pix_fmt", "yuv420p", path).CombinedOutput(); err != nil {
		t.Skipf("kein Testclip (ffmpeg auf dem Host): %v %s", err, out)
	}
}

func TestRealSandboxTranscodeRuns(t *testing.T) {
	r, pub, root := realSandbox(t)
	in := filepath.Join(root, "in.mp4")
	makeClip(t, in, "2")
	outDir := filepath.Join(root, "out")
	_ = os.MkdirAll(outDir, 0o755)
	out := filepath.Join(outDir, "a.mp4.part")
	if _, err := r.Exec(Request{JobID: "t1", Tool: "ffmpeg", Args: []string{"-y", "-i", in, "-c:v", "libx264", "-preset", "ultrafast", "-threads", "2", "-f", "mp4", out}}); err != nil {
		t.Fatal(err)
	}
	var ev Event
	for i := 0; i < 2400; i++ { // Containerstart dauert rund 1,5 s: großzügig warten
		var ok bool
		if ev, ok = pub.done("t1"); ok {
			break
		}
		time.Sleep(25 * time.Millisecond)
	}
	if ev.Type != "done" || ev.ExitCode != 0 || ev.Error != "" {
		t.Fatalf("Job fehlgeschlagen: %+v", ev)
	}
	st, err := os.Stat(out)
	if err != nil || st.Size() == 0 {
		t.Fatalf("Ergebnisdatei fehlt: %v", err)
	}
	if sys, ok := st.Sys().(*syscall.Stat_t); !ok || int(sys.Uid) != os.Getuid() {
		t.Errorf("Ergebnisdatei muss dem Betreiber gehören")
	}
	if p, err := exec.Command("ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", out).Output(); err != nil || !strings.HasPrefix(strings.TrimSpace(string(p)), "2") {
		t.Errorf("Ergebnis nicht abspielbar/Dauer ≠ 2 s: %q %v", p, err)
	}
}

func TestRealSandboxIsolation(t *testing.T) {
	r, _, root := realSandbox(t)
	// 1) Rechte des Prozesses im Container
	out, code := runSandbox(t, r, "cat", "/proc/self/status")
	if code != 0 {
		t.Fatalf("status nicht lesbar: %s", out)
	}
	for _, want := range []string{"CapEff:\t0000000000000000", "CapBnd:\t0000000000000000", "NoNewPrivs:\t1", "Seccomp:\t2"} {
		if !strings.Contains(out, want) {
			t.Errorf("%q fehlt in /proc/self/status:\n%s", want, out)
		}
	}
	if !strings.Contains(out, "Uid:\t"+strconv.Itoa(os.Getuid())) {
		t.Errorf("Prozess läuft nicht unter der Nutzer-UID:\n%s", out)
	}
	// 2) Keine MXL-Domain, keine Host-Wurzel
	out, _ = runSandbox(t, r, "ls", "-A", "/dev/shm")
	if strings.TrimSpace(out) != "" {
		t.Errorf("/dev/shm muss leer sein, enthält: %q", out)
	}
	// 3) Eine Datei AUSSERHALB der Wurzeln ist nicht lesbar (auch wenn die Argumentprüfung umgangen wird)
	secret := filepath.Join(t.TempDir(), "geheim.txt")
	_ = os.WriteFile(secret, []byte("topsecret"), 0o600)
	out, code = runSandbox(t, r, "cat", secret)
	if code == 0 || strings.Contains(out, "topsecret") {
		t.Errorf("Datei außerhalb der Wurzeln ist in der Sandbox lesbar: %q (exit %d)", out, code)
	}
	// 4) Eine vorhandene Datei unter der Wurzel ist nur lesbar
	exists := filepath.Join(root, "vorhanden.txt")
	_ = os.WriteFile(exists, []byte("alt"), 0o644)
	out, code = runSandbox(t, r, "sh", "-c", "echo neu > "+exists)
	if code == 0 {
		t.Errorf("vorhandene Datei unter der Wurzel ist beschreibbar: %q", out)
	}
	if b, _ := os.ReadFile(exists); string(b) != "alt" {
		t.Errorf("Datei wurde verändert: %q", b)
	}
	// 5) Wurzel-Dateisystem nur lesbar
	if out, code = runSandbox(t, r, "sh", "-c", "touch /etc/zz"); code == 0 {
		t.Errorf("Wurzel des Containers ist beschreibbar: %q", out)
	}
}

func TestRealSandboxHasNoNetwork(t *testing.T) {
	r, _, _ := realSandbox(t)
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Skip(err)
	}
	srv := &http.Server{Handler: http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { _, _ = w.Write([]byte("hallo")) })}
	go func() { _ = srv.Serve(ln) }()
	defer srv.Close()
	url := "http://" + ln.Addr().String() + "/"
	// Gegenprobe: vom Host aus ist der Server erreichbar
	if out, err := exec.Command("ffprobe", "-v", "error", "-protocol_whitelist", "http,tcp", url).CombinedOutput(); err == nil || strings.Contains(string(out), "refused") {
		t.Fatalf("Gegenprobe: der Host muss den Server erreichen (Antwort ohne Medium): %v %s", err, out)
	}
	out, code := runSandbox(t, r, "ffprobe", "-v", "error", url)
	if code == 0 || !(strings.Contains(out, "refused") || strings.Contains(out, "unreachable") || strings.Contains(out, "Network")) {
		t.Errorf("in der Sandbox muss die Verbindung scheitern: exit %d, %q", code, out)
	}
}

// ---- Namensraum-Hülle (bubblewrap) ----

func nsRunner(t *testing.T, allowNet bool) (*Runner, *fakePub, string) {
	t.Helper()
	root := t.TempDir()
	pub := &fakePub{}
	cfg := Config{
		Tools:    map[string]ToolConfig{"ffmpeg": {Path: "/usr/bin/ffmpeg", Sandbox: "namespace"}, "ffprobe": {Path: "/usr/bin/ffprobe", Sandbox: "namespace"}, "cat": {Path: "/usr/bin/cat", Sandbox: "namespace"}, "sh": {Path: "/usr/bin/sh", Sandbox: "namespace"}},
		JobRoots: []string{root}, AllowNet: allowNet, MaxJobs: 2,
	}
	return NewRunner(cfg, "h1", t.TempDir(), pub), pub, root
}

func TestBwrapArgsAreHardened(t *testing.T) {
	r, _, root := nsRunner(t, false)
	in := filepath.Join(root, "in.mxf")
	_ = os.WriteFile(in, []byte("x"), 0o644)
	outDir := filepath.Join(root, "out")
	_ = os.MkdirAll(outDir, 0o755)
	out := filepath.Join(outDir, "a.part")
	work := filepath.Join(t.TempDir(), "job1")
	a := r.bwrapArgs("ffmpeg", r.cfg.Tools["ffmpeg"], []string{"-i", in, out}, work)
	for _, want := range [][]string{
		{"--unshare-all"}, {"--die-with-parent"}, {"--cap-drop", "ALL"}, {"--clearenv"}, {"--ro-bind", "/usr", "/usr"},
		{"--tmpfs", "/tmp"}, {"--proc", "/proc"}, {"--dev", "/dev"}, {"--ro-bind", root, root}, {"--bind", outDir, outDir}, {"--bind", work, work},
		{"--chdir", work, "/usr/bin/ffmpeg", "-i", in, out},
	} {
		if !has(a, want...) {
			t.Errorf("fehlt: %v\nin %v", want, a)
		}
	}
	for _, bad := range []string{"--share-net", "--new-session", "--bind-try /", "--dev-bind", "/home", "/run", "/dev/shm", "omp-mxl"} {
		if strings.Contains(" "+strings.Join(a, " ")+" ", bad) {
			t.Errorf("verbotene Option %q in %v", bad, a)
		}
	}
	if has(a, "--bind", root, root) {
		t.Error("Wurzel darf nicht schreibbar sein")
	}
	r2, _, _ := nsRunner(t, true)
	if !has(r2.bwrapArgs("ffmpeg", r2.cfg.Tools["ffmpeg"], nil, work), "--share-net") {
		t.Error("mit allowNet muss das Netz freigegeben werden")
	}
}

func TestNamespaceJobWithoutBwrapIsRejectedClearly(t *testing.T) {
	r, _, root := nsRunner(t, false)
	old := BwrapBinary
	BwrapBinary = "/nicht/vorhanden/bwrap"
	defer func() { BwrapBinary = old }()
	_, err := r.Exec(Request{JobID: "n1", Tool: "ffmpeg", Args: []string{"-i", filepath.Join(root, "a")}})
	if err == nil || !strings.Contains(err.Error(), "bubblewrap") {
		t.Errorf("klare Meldung erwartet: %v", err)
	}
	if _, statErr := os.Stat(filepath.Join(r.dir, "n1")); statErr == nil {
		t.Error("Arbeitsverzeichnis muss wieder weg sein")
	}
}

func realNamespace(t *testing.T) (*Runner, *fakePub, string) {
	t.Helper()
	if _, err := exec.LookPath("bwrap"); err != nil {
		t.Skip("kein bwrap")
	}
	if out, err := exec.Command("bwrap", "--unshare-all", "--ro-bind", "/usr", "/usr", "--symlink", "usr/bin", "/bin", "--symlink", "usr/lib", "/lib", "--symlink", "usr/lib64", "/lib64", "true").CombinedOutput(); err != nil {
		t.Skipf("bubblewrap läuft hier nicht (Namensräume gesperrt?): %v %s", err, out)
	}
	return nsRunner(t, false)
}

func runBwrap(t *testing.T, r *Runner, tool string, args ...string) (string, int) {
	t.Helper()
	work := filepath.Join(t.TempDir(), "w")
	_ = os.MkdirAll(work, 0o750)
	tc := r.cfg.Tools[tool]
	cmd := exec.Command(BwrapBinary, r.bwrapArgs(tool, tc, args, work)...)
	var out bytes.Buffer
	cmd.Stdout, cmd.Stderr = &out, &out
	err := cmd.Run()
	code := 0
	if ee, ok := err.(*exec.ExitError); ok {
		code = ee.ExitCode()
	} else if err != nil {
		t.Fatal(err)
	}
	return out.String(), code
}

func TestRealNamespaceTranscodeRuns(t *testing.T) {
	r, pub, root := realNamespace(t)
	in := filepath.Join(root, "in.mp4")
	makeClip(t, in, "2")
	outDir := filepath.Join(root, "out")
	_ = os.MkdirAll(outDir, 0o755)
	out := filepath.Join(outDir, "a.mp4.part")
	if _, err := r.Exec(Request{JobID: "n1", Tool: "ffmpeg", Args: []string{"-y", "-i", in, "-c:v", "libx264", "-preset", "ultrafast", "-threads", "2", "-f", "mp4", out}}); err != nil {
		t.Fatal(err)
	}
	var ev Event
	for i := 0; i < 600; i++ {
		var ok bool
		if ev, ok = pub.done("n1"); ok {
			break
		}
		time.Sleep(25 * time.Millisecond)
	}
	if ev.ExitCode != 0 || ev.Error != "" || ev.Type != "done" {
		t.Fatalf("Job fehlgeschlagen: %+v", ev)
	}
	if p, err := exec.Command("ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", out).Output(); err != nil || !strings.HasPrefix(strings.TrimSpace(string(p)), "2") {
		t.Errorf("Ergebnis nicht abspielbar/Dauer ≠ 2 s: %q %v", p, err)
	}
}

func TestRealNamespaceIsolation(t *testing.T) {
	r, _, root := realNamespace(t)
	out, code := runBwrap(t, r, "cat", "/proc/self/status")
	if code != 0 {
		t.Fatalf("status nicht lesbar: %s", out)
	}
	for _, want := range []string{"CapEff:\t0000000000000000", "CapBnd:\t0000000000000000"} {
		if !strings.Contains(out, want) {
			t.Errorf("%q fehlt in /proc/self/status:\n%s", want, out)
		}
	}
	if !strings.Contains(out, "Uid:\t"+strconv.Itoa(os.Getuid())) {
		t.Errorf("Prozess läuft nicht unter der Nutzer-UID:\n%s", out)
	}
	t.Logf("NoNewPrivs/Seccomp im Namensraum: %s", strings.Join(grepLines(out, "NoNewPrivs", "Seccomp:"), " | "))
	// Datei außerhalb der Wurzeln: unsichtbar
	secret := filepath.Join(t.TempDir(), "geheim.txt")
	_ = os.WriteFile(secret, []byte("topsecret"), 0o600)
	if out, code = runBwrap(t, r, "cat", secret); code == 0 || strings.Contains(out, "topsecret") {
		t.Errorf("Datei außerhalb der Wurzeln lesbar: %q (exit %d)", out, code)
	}
	// Persönliche Verzeichnisse und die MXL-Domain: nicht vorhanden
	for _, p := range []string{"/home", "/dev/shm/omp-mxl", "/run", "/root"} {
		if out, code = runBwrap(t, r, "cat", p+"/x"); code == 0 {
			t.Errorf("%s ist in der Hülle erreichbar: %q", p, out)
		}
	}
	// Vorhandene Datei unter der Wurzel nur lesbar: das Verändern scheitert (cat kann nicht schreiben — daher ffmpeg versucht zu überschreiben)
	exists := filepath.Join(root, "vorhanden.mp4")
	_ = os.WriteFile(exists, []byte("alt"), 0o644)
	out, code = runBwrap(t, r, "sh", "-c", "echo neu > "+exists)
	if after, _ := os.ReadFile(exists); code == 0 || string(after) != "alt" {
		t.Errorf("vorhandene Datei unter der Wurzel wurde verändert (exit %d): %q %q", code, out, after)
	}
	// Die Hülle selbst ist nur lesbar
	if out, code = runBwrap(t, r, "sh", "-c", "touch /usr/zz"); code == 0 {
		t.Errorf("/usr ist beschreibbar: %q", out)
	}
}

func grepLines(s string, keys ...string) []string {
	var out []string
	for _, l := range strings.Split(s, "\n") {
		for _, k := range keys {
			if strings.HasPrefix(l, k) {
				out = append(out, strings.ReplaceAll(l, "\t", " "))
			}
		}
	}
	return out
}

func TestRealNamespaceHasNoNetwork(t *testing.T) {
	r, _, _ := realNamespace(t)
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Skip(err)
	}
	srv := &http.Server{Handler: http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { _, _ = w.Write([]byte("hallo")) })}
	go func() { _ = srv.Serve(ln) }()
	defer srv.Close()
	url := "http://" + ln.Addr().String() + "/"
	out, code := runBwrap(t, r, "ffprobe", "-v", "error", url)
	if code == 0 || !(strings.Contains(out, "refused") || strings.Contains(out, "unreachable") || strings.Contains(out, "Network")) {
		t.Errorf("in der Hülle muss die Verbindung scheitern: exit %d, %q", code, out)
	}
}

// Zeitmessung (Plan 98.3 §5 Punkt 5): nur mit OMP_SANDBOX_TIMING=1 und OMP_SANDBOX_TEST_IMAGE; kurz und klein (CPU schonen).
func TestSandboxTiming(t *testing.T) {
	if os.Getenv("OMP_SANDBOX_TIMING") == "" {
		t.Skip("OMP_SANDBOX_TIMING nicht gesetzt")
	}
	img := os.Getenv("OMP_SANDBOX_TEST_IMAGE")
	root := t.TempDir()
	in := filepath.Join(root, "in.mp4")
	if out, err := exec.Command("ffmpeg", "-y", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc2=size=640x360:rate=25", "-t", "10", "-pix_fmt", "yuv420p", "-c:v", "libx264", "-preset", "ultrafast", in).CombinedOutput(); err != nil {
		t.Skipf("kein Testclip: %v %s", err, out)
	}
	outDir := filepath.Join(root, "out")
	_ = os.MkdirAll(outDir, 0o755)
	run := func(mode string, tool string, args []string, id string) time.Duration {
		pub := &fakePub{}
		cfg := Config{Tools: map[string]ToolConfig{
			"ffmpeg": {Path: "/usr/bin/ffmpeg", Sandbox: mode}, "ffprobe": {Path: "/usr/bin/ffprobe", Sandbox: mode}},
			JobRoots: []string{root}, MaxJobs: 2, SandboxImage: img}
		r := NewRunner(cfg, "h1", t.TempDir(), pub)
		start := time.Now()
		if _, err := r.Exec(Request{JobID: id, Tool: tool, Args: args}); err != nil {
			t.Fatal(err)
		}
		for i := 0; i < 4800; i++ {
			if ev, ok := pub.done(id); ok {
				if ev.ExitCode != 0 {
					t.Fatalf("%s %s: %+v", mode, tool, ev)
				}
				return time.Since(start)
			}
			time.Sleep(5 * time.Millisecond)
		}
		t.Fatal("Zeitüberschreitung")
		return 0
	}
	modes := []string{"none", "namespace"}
	if img != "" {
		modes = append(modes, "container")
	}
	if m := os.Getenv("OMP_SANDBOX_TIMING_MODES"); m != "" { // z. B. "namespace" — für die Sendepfad-Gegenprobe
		modes = strings.Split(m, ",")
	}
	for _, mode := range modes {
		var tr, pr []time.Duration
		for i := 0; i < 3; i++ {
			out := filepath.Join(outDir, mode+"-"+strconv.Itoa(i)+".mp4.part")
			tr = append(tr, run(mode, "ffmpeg", []string{"-y", "-i", in, "-c:v", "libx264", "-preset", "veryfast", "-threads", "2", "-f", "mp4", out}, "t"+mode+strconv.Itoa(i)))
		}
		for i := 0; i < 5; i++ {
			pr = append(pr, run(mode, "ffprobe", []string{"-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", in}, "p"+mode+strconv.Itoa(i)))
		}
		t.Logf("%-9s Transcode 10 s Clip: %v | ffprobe: %v", mode, tr, pr)
	}
}
