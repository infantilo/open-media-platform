package jobwire

// Bibliotheksverzeichnis je Node-Binary (HAERTUNG-PLAN.md 98.2, M7 Teil 1): welche Systembibliotheken laden die ausgelieferten
// Programme tatsächlich, aus welchem Paket stammen sie und in welcher Version? Grundlage, um bei einer Meldung zu einer Bibliothek
// (Parser, Dekoder, Kompression) sofort zu sagen, ob und wo sie im Sendeweg steckt.
//
// Es wird KEIN Programm ausgeführt (kein ldd): die Abhängigkeiten (DT_NEEDED) werden mit debug/elf aus der Datei gelesen und
// transitiv aufgelöst. Suchpfade in dieser Reihenfolge: RUNPATH/RPATH des Programms ($ORIGIN ersetzt), LD_LIBRARY_PATH des
// Aufrufers (bei Nodes kommt der Wert aus mxl.env), danach die Standardverzeichnisse. Die Zuordnung zu Paketen läuft über dpkg,
// wo vorhanden; sonst steht „(kein Paket)“. Unaufgelöste Bibliotheken werden ausdrücklich genannt (nicht verschwiegen).

import (
	"context"
	"debug/elf"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

var defaultLibDirs = []string{
	"/lib/x86_64-linux-gnu", "/usr/lib/x86_64-linux-gnu", "/lib/aarch64-linux-gnu", "/usr/lib/aarch64-linux-gnu",
	"/lib64", "/usr/lib64", "/lib", "/usr/lib", "/usr/local/lib",
}

type libInfo struct {
	path    string   // aufgelöster Pfad (ohne Symlinks)
	users   []string // Programme, die sie (direkt oder indirekt) laden
	missing bool
}

// elfNeeded liefert DT_NEEDED sowie RUNPATH/RPATH einer ELF-Datei.
func elfNeeded(path string) (needed, runpath []string, err error) {
	f, err := elf.Open(path)
	if err != nil {
		return nil, nil, err
	}
	defer f.Close()
	needed, _ = f.ImportedLibraries()
	for _, tag := range []elf.DynTag{elf.DT_RUNPATH, elf.DT_RPATH} {
		if v, e := f.DynString(tag); e == nil {
			for _, s := range v {
				runpath = append(runpath, strings.Split(s, ":")...)
			}
		}
	}
	return needed, runpath, nil
}

func resolveLib(soname string, dirs []string) string {
	if strings.Contains(soname, "/") {
		if _, err := os.Stat(soname); err == nil {
			return soname
		}
		return ""
	}
	for _, d := range dirs {
		if d == "" {
			continue
		}
		p := filepath.Join(d, soname)
		if _, err := os.Stat(p); err == nil {
			return p
		}
	}
	return ""
}

// collectLibs löst die Abhängigkeiten aller Programme transitiv auf. Schlüssel: Soname.
func collectLibs(binaries []string, ldLibraryPath string) (map[string]*libInfo, map[string]string) {
	libs := map[string]*libInfo{}
	failed := map[string]string{}
	var envDirs []string
	if ldLibraryPath != "" {
		envDirs = strings.Split(ldLibraryPath, ":")
	}
	for _, bin := range binaries {
		name := filepath.Base(bin)
		needed, runpath, err := elfNeeded(bin)
		if err != nil {
			failed[name] = err.Error()
			continue
		}
		origin := filepath.Dir(bin)
		var dirs []string
		for _, r := range runpath {
			dirs = append(dirs, strings.ReplaceAll(strings.ReplaceAll(r, "${ORIGIN}", origin), "$ORIGIN", origin))
		}
		dirs = append(dirs, envDirs...)
		dirs = append(dirs, defaultLibDirs...)
		seen := map[string]bool{}
		queue := append([]string(nil), needed...)
		for len(queue) > 0 {
			so := queue[0]
			queue = queue[1:]
			if seen[so] {
				continue
			}
			seen[so] = true
			li := libs[so]
			if li == nil {
				li = &libInfo{}
				libs[so] = li
			}
			li.users = append(li.users, name)
			p := resolveLib(so, dirs)
			if p == "" {
				li.missing = true
				continue
			}
			if real, e := filepath.EvalSymlinks(p); e == nil {
				p = real
			}
			li.path, li.missing = p, false
			if sub, _, e := elfNeeded(p); e == nil {
				queue = append(queue, sub...)
			}
		}
	}
	return libs, failed
}

// packageOf ordnet Pfade über dpkg einem Paket mit Version zu (leer, wenn dpkg fehlt oder die Datei keinem Paket gehört).
func packageOf(ctx context.Context, paths []string) map[string]string {
	out := map[string]string{}
	if len(paths) == 0 {
		return out
	}
	pkgOf := map[string]string{} // Pfad → Paket
	// Auf Systemen mit zusammengelegtem /usr führt dpkg die Dateien meist ohne /usr: beide Schreibweisen abfragen.
	var all []string
	seenQ := map[string]bool{}
	for _, p := range paths {
		for _, q := range []string{p, strings.TrimPrefix(p, "/usr")} {
			if !seenQ[q] {
				seenQ[q] = true
				all = append(all, q)
			}
		}
	}
	for i := 0; i < len(all); i += 100 {
		chunk := all[i:min(i+100, len(all))]
		b, _ := runLimited(ctx, append([]string{"dpkg", "-S"}, chunk...))
		for _, line := range strings.Split(string(b), "\n") {
			if pkg, p, ok := strings.Cut(line, ": "); ok && !strings.HasPrefix(line, "dpkg") && !strings.Contains(pkg, " ") {
				pkgOf[strings.TrimSpace(p)] = strings.Split(pkg, ",")[0]
			}
		}
	}
	pkgs := map[string]bool{}
	for _, p := range pkgOf {
		pkgs[strings.Split(p, ":")[0]] = true
	}
	var names []string
	for p := range pkgs {
		names = append(names, p)
	}
	sort.Strings(names)
	ver := map[string]string{}
	for i := 0; i < len(names); i += 100 {
		args := append([]string{"dpkg-query", "-W", "-f", "${Package} ${Version}\n"}, names[i:min(i+100, len(names))]...)
		b, _ := runLimited(ctx, args)
		for _, line := range strings.Split(string(b), "\n") {
			if n, v, ok := strings.Cut(line, " "); ok {
				ver[n] = v
			}
		}
	}
	for path, pkg := range pkgOf {
		base := strings.Split(pkg, ":")[0]
		out[path] = pkg + " " + ver[base]
	}
	return out
}

// loadedLibraries liest /proc/<pid>/maps laufender Prozesse: Pfad → Anzahl Prozesse. Zeigt auch, was per dlopen oder als
// GStreamer-Plugin erst zur Laufzeit geladen wurde (die ELF-Analyse oben sieht nur DT_NEEDED).
func loadedLibraries(pids []int) map[string]int {
	out := map[string]int{}
	for _, pid := range pids {
		b, err := os.ReadFile(fmt.Sprintf("/proc/%d/maps", pid))
		if err != nil {
			continue
		}
		seen := map[string]bool{}
		for _, line := range strings.Split(string(b), "\n") {
			f := strings.Fields(line)
			if len(f) < 6 || !strings.HasPrefix(f[5], "/") {
				continue
			}
			p := f[5]
			if !strings.Contains(filepath.Base(p), ".so") || strings.HasSuffix(p, " (deleted)") || seen[p] {
				continue
			}
			seen[p] = true
			out[p]++
		}
	}
	return out
}

// LibraryReport schreibt das Verzeichnis als Text. binaries: Pfade der ausgelieferten Programme; pids: laufende Node-Prozesse
// (optional, für den Laufzeit-Abschnitt).
func LibraryReport(ctx context.Context, binaries []string, ldLibraryPath string, pids ...int) string {
	libs, failed := collectLibs(binaries, ldLibraryPath)
	var paths []string
	for _, li := range libs {
		if li.path != "" {
			paths = append(paths, li.path)
		}
	}
	pk := packageOf(ctx, paths)
	// dpkg kennt bei zusammengelegten /usr-Pfaden manchmal nur die Variante ohne /usr: beide Schreibweisen probieren.
	lookup := func(p string) string {
		if v, ok := pk[p]; ok {
			return v
		}
		if v, ok := pk[strings.TrimPrefix(p, "/usr")]; ok {
			return v
		}
		return ""
	}
	var sonames []string
	for so := range libs {
		sonames = append(sonames, so)
	}
	sort.Strings(sonames)
	var b strings.Builder
	fmt.Fprintf(&b, "# Bibliotheken der ausgelieferten Programme (%d Programme, %d Bibliotheken)\n", len(binaries), len(libs))
	fmt.Fprintf(&b, "# Spalten: Soname | Pfad | Paket und Version | Anzahl Programme | Beispiele\n")
	nopkg := 0
	for _, so := range sonames {
		li := libs[so]
		users := dedupSorted(li.users)
		ex := strings.Join(users[:min(3, len(users))], ",")
		switch {
		case li.missing || li.path == "":
			fmt.Fprintf(&b, "%s | NICHT GEFUNDEN | - | %d | %s\n", so, len(users), ex)
		default:
			p := lookup(li.path)
			if p == "" {
				p = "(kein Paket)"
				nopkg++
			}
			fmt.Fprintf(&b, "%s | %s | %s | %d | %s\n", so, li.path, p, len(users), ex)
		}
	}
	fmt.Fprintf(&b, "# ohne Paketzuordnung: %d\n", nopkg)
	fmt.Fprintf(&b, "# Hinweis: per dlopen (z. B. libmxl.so) und als GStreamer-Plugin geladene Bibliotheken stehen nicht in DT_NEEDED, sondern im Abschnitt Laufzeit.\n")
	if rt := loadedLibraries(pids); len(rt) > 0 {
		var rp, real []string
		for p := range rt {
			if r, e := filepath.EvalSymlinks(p); e == nil {
				p = r
			}
			real = append(real, p)
		}
		rpk := packageOf(ctx, real)
		for p := range rt {
			rp = append(rp, p)
		}
		sort.Strings(rp)
		fmt.Fprintf(&b, "\n# Laufzeit: aus /proc/<pid>/maps von %d laufenden Prozessen (%d Bibliotheken)\n# Spalten: Pfad | Paket und Version | Anzahl Prozesse\n", len(pids), len(rp))
		for _, p := range rp {
			r := p
			if x, e := filepath.EvalSymlinks(p); e == nil {
				r = x
			}
			pkg := rpk[r]
			if pkg == "" {
				pkg = rpk[strings.TrimPrefix(r, "/usr")]
			}
			if pkg == "" {
				pkg = "(kein Paket)"
			}
			fmt.Fprintf(&b, "%s | %s | %d\n", p, pkg, rt[p])
		}
	}
	if len(failed) > 0 {
		var ns []string
		for n := range failed {
			ns = append(ns, n)
		}
		sort.Strings(ns)
		for _, n := range ns {
			fmt.Fprintf(&b, "# nicht lesbar: %s (%s)\n", n, failed[n])
		}
	}
	return b.String()
}

func dedupSorted(in []string) []string {
	m := map[string]bool{}
	for _, s := range in {
		m[s] = true
	}
	out := make([]string, 0, len(m))
	for s := range m {
		out = append(out, s)
	}
	sort.Strings(out)
	return out
}
