// Package support: Selbsttest (Ampel) und Support-Paket (UMSETZUNG.md Kap. 72).
//
// Der Selbsttest trennt Messen (ProbeLocal, liest nur /proc und statfs) von
// Bewerten (Evaluate, reine Funktion) — die Schwellwerte und Texte lassen
// sich so ohne System testen.
package support

import (
	"fmt"
	"sort"
	"time"

	"github.com/infantilo/openmediaplatform/orchestrator/internal/errcodes"
)

// Level ist die Ampelstufe eines Befunds.
type Level string

const (
	LevelOK   Level = "ok"
	LevelWarn Level = "warn"
	LevelErr  Level = "err"
)

// Check ist ein Befund: was geprüft wurde, wie es steht und was als Nächstes zu tun ist.
type Check struct {
	ID     string `json:"id"`
	Group  string `json:"group"`
	Level  Level  `json:"level"`
	Title  string `json:"title"`
	Detail string `json:"detail,omitempty"`
	Fix    string `json:"fix,omitempty"`
	// Code: Fehlercode (OMP-nnnn, internal/errcodes), leer ohne Eintrag im Katalog.
	Code string `json:"code,omitempty"`
}

// Report ist das Ergebnis eines Selbsttests.
type Report struct {
	GeneratedAt time.Time `json:"generatedAt"`
	Level       Level     `json:"level"`
	Summary     string    `json:"summary"`
	Errors      int       `json:"errors"`
	Warnings    int       `json:"warnings"`
	Checks      []Check   `json:"checks"`
}

// Disk ist die Belegung eines Pfads.
type Disk struct {
	Path       string
	Label      string
	FreeBytes  uint64
	TotalBytes uint64
	Err        string
}

// Local sind die Messwerte des Rechners, auf dem der Orchestrator läuft.
type Local struct {
	Disks         []Disk
	MemAvailable  uint64
	MemTotal      uint64
	ShmFree       uint64
	ShmTotal      uint64
	ShmErr        string
	Load1         float64
	CPUs          int
	OpenFDs       int
	FDLimit       int
	DatabaseError string // leer = erreichbar; "-" = nicht geprüft
}

// Host ist die Sicht auf einen Host-Agent.
type Host struct {
	ID, Label    string
	TelemetryAge time.Duration // seit der letzten Telemetrie; <0 = nie
	Goodbye      bool
	CPUPercent   float64
	MemUsed      uint64
	MemTotal     uint64
	ClockProblem string // "" = Uhr in Ordnung
	// Sys: Messwerte des Host-Rechners (Host-Agent, Aktion sysinfo); nil = nicht abrufbar (älterer Agent).
	Sys *Local
}

// Instance ist die Sicht auf eine vom Launcher gestartete Instanz.
type Instance struct {
	ID, Label, Type string
	Crashed         bool
	CrashMessage    string
	RestartCount    int
	Outdated        bool
}

// Cluster ist die Sicht auf den Raft-Zustand.
type Cluster struct {
	Known           bool
	State           string
	Members         int
	NoLeaderSeconds int
	QuorumLost      bool
}

// Finding ist ein Befund des Betriebsprofils.
type Finding struct{ ID, Severity, Message, Hint string }

// Inputs bündelt alles, was Evaluate bewertet.
type Inputs struct {
	Local        Local
	Hosts        []Host
	HostsKnown   bool
	Instances    []Instance
	NodesOnline  int
	NodesOffline []string // Labels
	Cluster      Cluster
	Findings     []Finding
	// Profile: Name des Betriebsprofils; im Profil „dev“ färben Produktionsbefunde die Ampel nicht rot.
	Profile string
	// Trends: Auffälligkeiten aus Baseline und Trend-Erkennung (internal/trends).
	Trends []TrendFinding
}

// TrendFinding ist eine Auffälligkeit der Trend-Erkennung (Abweichung vom Üblichen oder stetiges Wachstum).
type TrendFinding struct {
	Subject, Label, Metric, Kind, Unit string
	Value, Baseline, SlopePerHour      float64
	Hours, HoursToLimit                float64
}

// tr wählt den Text der Sprache ("en" oder sonst Deutsch).
type tr struct{ lang string }

func (t tr) s(de, en string) string {
	if t.lang == "en" {
		return en
	}
	return de
}

// GiB formatiert Bytes für Menschen.
func human(b uint64) string {
	const k = 1024.0
	f := float64(b)
	switch {
	case f >= k*k*k*k:
		return fmt.Sprintf("%.1f TiB", f/(k*k*k*k))
	case f >= k*k*k:
		return fmt.Sprintf("%.1f GiB", f/(k*k*k))
	case f >= k*k:
		return fmt.Sprintf("%.0f MiB", f/(k*k))
	}
	return fmt.Sprintf("%.0f KiB", f/k)
}

func pct(part, total uint64) float64 {
	if total == 0 {
		return 0
	}
	return float64(part) / float64(total) * 100
}

// machineChecks bewertet die Messwerte eines Rechners (Orchestrator-Rechner oder Host). idp ist das Präfix der Check-IDs.
func machineChecks(t tr, grp, idp string, l0 Local, add func(Check)) {
	for _, d := range l0.Disks {
		id := idp + "disk:" + d.Path
		if d.Err != "" {
			add(Check{ID: id, Group: grp, Level: LevelWarn, Title: t.s("Speicherplatz "+d.Label+" nicht lesbar", "Disk space "+d.Label+" unreadable"), Detail: d.Err})
			continue
		}
		free := pct(d.FreeBytes, d.TotalBytes)
		c := Check{ID: id, Group: grp, Level: LevelOK,
			Title:  t.s("Speicherplatz "+d.Label, "Disk space "+d.Label),
			Detail: t.s(fmt.Sprintf("%s frei von %s (%.0f %%)", human(d.FreeBytes), human(d.TotalBytes), free), fmt.Sprintf("%s free of %s (%.0f%%)", human(d.FreeBytes), human(d.TotalBytes), free))}
		switch {
		case free < 5 || d.FreeBytes < 2<<30:
			c.Level = LevelErr
			c.Fix = t.s("Der Platz reicht nicht mehr für Aufnahmen und Datenbank. Alte Aufnahmen und Sicherungen löschen oder die Platte vergrößern.", "There is not enough room left for recordings and the database. Delete old recordings and backups or enlarge the disk.")
		case free < 10:
			c.Level = LevelWarn
			c.Fix = t.s("Bald voll. Alte Aufnahmen und Sicherungen aufräumen.", "Getting full. Clean up old recordings and backups.")
		}
		add(c)
	}
	if l := l0; l.MemTotal > 0 {
		avail := pct(l.MemAvailable, l.MemTotal)
		c := Check{ID: idp + "memory", Group: grp, Level: LevelOK, Title: t.s("Arbeitsspeicher", "Memory"),
			Detail: t.s(fmt.Sprintf("%s verfügbar von %s (%.0f %%)", human(l.MemAvailable), human(l.MemTotal), avail), fmt.Sprintf("%s available of %s (%.0f%%)", human(l.MemAvailable), human(l.MemTotal), avail))}
		switch {
		case avail < 5:
			c.Level = LevelErr
			c.Fix = t.s("Der Speicher ist fast aufgebraucht, Prozesse können vom System beendet werden. Nicht benötigte Instanzen stoppen oder mehr RAM einbauen.", "Memory is nearly exhausted; the system may kill processes. Stop unneeded instances or add RAM.")
		case avail < 15:
			c.Level = LevelWarn
			c.Fix = t.s("Wenig freier Speicher. Nicht benötigte Instanzen stoppen.", "Little free memory. Stop unneeded instances.")
		}
		add(c)
	}
	if l := l0; l.ShmErr != "" {
		add(Check{ID: idp + "shm", Group: grp, Level: LevelWarn, Title: t.s("Medien-Austauschspeicher (/dev/shm)", "Media exchange memory (/dev/shm)"), Detail: l.ShmErr})
	} else if l.ShmTotal > 0 {
		free := pct(l.ShmFree, l.ShmTotal)
		c := Check{ID: idp + "shm", Group: grp, Level: LevelOK, Title: t.s("Medien-Austauschspeicher (/dev/shm)", "Media exchange memory (/dev/shm)"),
			Detail: t.s(fmt.Sprintf("%s frei von %s", human(l.ShmFree), human(l.ShmTotal)), fmt.Sprintf("%s free of %s", human(l.ShmFree), human(l.ShmTotal)))}
		switch {
		case free < 5:
			c.Level = LevelErr
			c.Fix = t.s("Hier liegen die Videobilder zwischen den Nodes; ist er voll, bleibt das Bild stehen. Verwaiste Flows unter /dev/shm/omp-mxl entfernen (Nodes vorher stoppen) oder den Speicher vergrößern.", "Video frames pass between nodes here; if it is full the picture freezes. Remove orphaned flows under /dev/shm/omp-mxl (stop the nodes first) or enlarge it.")
		case free < 20:
			c.Level = LevelWarn
			c.Fix = t.s("Wird knapp. Ungenutzte Flows entfernen oder /dev/shm vergrößern.", "Running low. Remove unused flows or enlarge /dev/shm.")
		}
		add(c)
	}
	if l := l0; l.FDLimit > 0 {
		use := float64(l.OpenFDs) / float64(l.FDLimit) * 100
		c := Check{ID: idp + "fds", Group: grp, Level: LevelOK, Title: t.s("Offene Dateien des Dienstes (Orchestrator bzw. Host-Agent)", "Open files of the service (orchestrator or host agent)"),
			Detail: fmt.Sprintf("%d / %d", l.OpenFDs, l.FDLimit)}
		switch {
		case use > 90:
			c.Level = LevelErr
			c.Fix = t.s("Gleich ist das Limit erreicht, dann scheitern neue Verbindungen. Orchestrator neu starten und das Limit (LimitNOFILE) erhöhen.", "The limit is about to be hit; new connections will then fail. Restart the orchestrator and raise the limit (LimitNOFILE).")
		case use > 70:
			c.Level = LevelWarn
			c.Fix = t.s("Die Zahl steigt vermutlich stetig (Leck). Beobachten und dem Support melden, wenn sie weiter wächst.", "The number probably keeps growing (leak). Watch it and tell support if it keeps rising.")
		}
		add(c)
	}
	if l := l0; l.CPUs > 0 && l.Load1 > 0 {
		per := l.Load1 / float64(l.CPUs)
		c := Check{ID: idp + "load", Group: grp, Level: LevelOK, Title: t.s("Prozessor-Auslastung", "CPU load"),
			Detail: t.s(fmt.Sprintf("Last %.1f bei %d Kernen", l.Load1, l.CPUs), fmt.Sprintf("load %.1f on %d cores", l.Load1, l.CPUs))}
		switch {
		case per > 3:
			c.Level = LevelErr
			c.Fix = t.s("Der Rechner ist überlastet, Bild und Ton können aussetzen. Instanzen auf andere Hosts verteilen oder stoppen.", "The machine is overloaded; picture and sound may drop out. Spread instances over other hosts or stop some.")
		case per > 1.5:
			c.Level = LevelWarn
			c.Fix = t.s("Hohe Last. Instanzen auf andere Hosts verteilen.", "High load. Spread instances over other hosts.")
		}
		add(c)
	}
}

// Evaluate bewertet die Messwerte. lang: "en" oder "" (Deutsch).
func Evaluate(in Inputs, lang string, now time.Time) Report {
	t := tr{lang}
	var cs []Check
	add := func(c Check) { cs = append(cs, c) }

	// ---- Dieser Rechner -------------------------------------------------
	grp := t.s("Dieser Rechner", "This machine")
	machineChecks(t, grp, "", in.Local, add)
	switch in.Local.DatabaseError {
	case "-":
	case "":
		add(Check{ID: "database", Group: grp, Level: LevelOK, Title: t.s("Datenbank", "Database"), Detail: t.s("erreichbar", "reachable")})
	default:
		add(Check{ID: "database", Group: grp, Level: LevelErr, Title: t.s("Datenbank", "Database"), Detail: in.Local.DatabaseError,
			Fix: t.s("Ohne Datenbank gehen Anmeldung, Workflows und Protokolle nicht. Prüfen, ob PostgreSQL läuft und erreichbar ist.", "Without the database login, workflows and logs do not work. Check that PostgreSQL is running and reachable.")})
	}

	// ---- Cluster --------------------------------------------------------
	grp = "Cluster"
	if cl := in.Cluster; cl.Known {
		switch {
		case cl.QuorumLost:
			add(Check{ID: "cluster", Group: grp, Level: LevelErr, Title: t.s("Mehrheit im Cluster verloren", "Cluster majority lost"),
				Detail: t.s(fmt.Sprintf("seit %d s kein Leader", cl.NoLeaderSeconds), fmt.Sprintf("no leader for %d s", cl.NoLeaderSeconds)),
				Fix:    t.s("Der Partner-Orchestrator ist nicht erreichbar. Wieder starten oder in Administration → Cluster den Notausgang nutzen. Bis dahin laufen Automatik und Failover nicht.", "The partner orchestrator is unreachable. Start it again or use the emergency exit under Administration → Cluster. Automation and failover are stopped until then.")})
		case cl.NoLeaderSeconds > 0:
			add(Check{ID: "cluster", Group: grp, Level: LevelWarn, Title: t.s("Cluster ohne Leader", "Cluster without leader"),
				Detail: t.s(fmt.Sprintf("seit %d s", cl.NoLeaderSeconds), fmt.Sprintf("for %d s", cl.NoLeaderSeconds)),
				Fix:    t.s("Kurz abwarten; bleibt es bestehen, Verbindung zwischen den Orchestratoren prüfen.", "Wait a moment; if it stays, check the connection between the orchestrators.")})
		default:
			add(Check{ID: "cluster", Group: grp, Level: LevelOK, Title: t.s("Cluster", "Cluster"),
				Detail: t.s(fmt.Sprintf("%d Mitglied(er), Rolle: %s", cl.Members, cl.State), fmt.Sprintf("%d member(s), role: %s", cl.Members, cl.State))})
		}
	}

	// ---- Hosts ----------------------------------------------------------
	grp = "Hosts"
	hosts := append([]Host(nil), in.Hosts...)
	sort.Slice(hosts, func(i, j int) bool { return hosts[i].Label < hosts[j].Label })
	for _, h := range hosts {
		name := h.Label
		if name == "" {
			name = h.ID
		}
		id := "host:" + h.ID
		if h.Goodbye {
			add(Check{ID: id, Group: grp, Level: LevelOK, Title: name, Detail: t.s("abgemeldet (absichtlich beendet)", "signed off (stopped on purpose)")})
			continue
		}
		if h.TelemetryAge < 0 || h.TelemetryAge > 30*time.Second {
			d := t.s("nie Daten empfangen", "no data ever received")
			if h.TelemetryAge >= 0 {
				d = t.s(fmt.Sprintf("seit %d s keine Meldung", int(h.TelemetryAge.Seconds())), fmt.Sprintf("no report for %d s", int(h.TelemetryAge.Seconds())))
			}
			lv := LevelErr
			if h.TelemetryAge < 0 {
				lv = LevelWarn // nie eine Meldung: meist ein übrig gebliebener Eintrag, kein Ausfall
				d += t.s(" — ist der Host noch in Betrieb? Sonst unter Hosts entfernen.", " — is the host still in service? If not, remove it under Hosts.")
			}
			add(Check{ID: id, Group: grp, Level: lv, Title: name + t.s(" antwortet nicht", " is not responding"), Detail: d,
				Fix: t.s("Rechner, Netzwerk und den Dienst „omp-host-agent“ prüfen. Instanzen auf diesem Host sind vermutlich nicht erreichbar.", "Check the machine, the network and the “omp-host-agent” service. Instances on this host are probably unreachable.")})
			continue
		}
		c := Check{ID: id, Group: grp, Level: LevelOK, Title: name}
		memPct := pct(h.MemUsed, h.MemTotal)
		c.Detail = t.s(fmt.Sprintf("CPU %.0f %%, RAM %.0f %%", h.CPUPercent, memPct), fmt.Sprintf("CPU %.0f%%, RAM %.0f%%", h.CPUPercent, memPct))
		switch {
		case h.ClockProblem != "":
			c.Level = LevelErr
			c.Detail += " — " + t.s("Uhr: ", "clock: ") + h.ClockProblem
			c.Code = "OMP-5002"
			c.Fix = t.s("Eine falsche Uhr stört Videoübergabe und Schaltzeitpunkte. Zeitsynchronisation (chrony/PTP) auf diesem Host prüfen.", "A wrong clock disturbs video exchange and switch times. Check time synchronisation (chrony/PTP) on this host.")
		case h.CPUPercent > 90 || memPct > 92:
			c.Level = LevelErr
			c.Code = "OMP-1012"
			c.Fix = t.s("Der Host ist am Limit. Instanzen auf andere Hosts verschieben.", "The host is at its limit. Move instances to other hosts.")
		case h.CPUPercent > 80 || memPct > 85:
			c.Level = LevelWarn
			c.Code = "OMP-1012"
			c.Fix = t.s("Hohe Auslastung. Vor weiteren Instanzen einen anderen Host wählen.", "High load. Pick another host before adding instances.")
		}
		add(c)
		if h.Sys != nil {
			machineChecks(t, grp+": "+name, "host:"+h.ID+":", *h.Sys, add)
		}
	}

	// ---- Nodes und Instanzen --------------------------------------------
	grp = "Nodes"
	if len(in.NodesOffline) > 0 {
		add(Check{ID: "nodes", Group: grp, Level: LevelWarn,
			Title:  t.s(fmt.Sprintf("%d Node(s) nicht erreichbar", len(in.NodesOffline)), fmt.Sprintf("%d node(s) unreachable", len(in.NodesOffline))),
			Detail: joinMax(in.NodesOffline, 8),
			Fix:    t.s("Unter Instanzen nachsehen, ob der Prozess läuft; sonst neu starten. Die Meldung des Nodes steht in Administration → Diagnose.", "Check under Instances whether the process runs; otherwise restart it. The node’s message is under Administration → Diagnose.")})
	} else if in.NodesOnline > 0 {
		add(Check{ID: "nodes", Group: grp, Level: LevelOK, Title: t.s("Nodes", "Nodes"), Detail: t.s(fmt.Sprintf("%d erreichbar", in.NodesOnline), fmt.Sprintf("%d reachable", in.NodesOnline))})
	}
	var crashed, loops, outdated []string
	for _, i := range in.Instances {
		n := i.Label
		if n == "" {
			n = i.Type
		}
		switch {
		case i.Crashed:
			crashed = append(crashed, n)
		case i.RestartCount >= 3:
			loops = append(loops, fmt.Sprintf("%s (%d×)", n, i.RestartCount))
		}
		if i.Outdated {
			outdated = append(outdated, n)
		}
	}
	if len(crashed) > 0 {
		add(Check{ID: "instances-crashed", Group: grp, Level: LevelErr,
			Title:  t.s(fmt.Sprintf("%d Instanz(en) abgestürzt", len(crashed)), fmt.Sprintf("%d instance(s) crashed", len(crashed))),
			Detail: joinMax(crashed, 8),
			Fix:    t.s("Unter Instanzen steht die letzte Fehlermeldung. Neu starten; stürzt sie wieder ab, das Support-Paket erstellen und senden.", "The last error is shown under Instances. Restart; if it crashes again, create the support package and send it.")})
	}
	if len(loops) > 0 {
		add(Check{ID: "instances-restarts", Group: grp, Level: LevelWarn,
			Title:  t.s(fmt.Sprintf("%d Instanz(en) starten wiederholt neu", len(loops)), fmt.Sprintf("%d instance(s) keep restarting", len(loops))),
			Detail: joinMax(loops, 8),
			Fix:    t.s("Instabil: Der Prozess endet immer wieder von selbst. Ursache in Administration → Diagnose suchen oder das Support-Paket senden.", "Unstable: the process keeps ending on its own. Look for the cause under Administration → Diagnose or send the support package.")})
	}
	if len(outdated) > 0 {
		add(Check{ID: "instances-outdated", Group: grp, Level: LevelWarn,
			Title:  t.s(fmt.Sprintf("%d Instanz(en) laufen mit alter Version", len(outdated)), fmt.Sprintf("%d instance(s) run an old version", len(outdated))),
			Detail: joinMax(outdated, 8),
			Fix:    t.s("Nach einem Update neu starten, wenn es der Betrieb erlaubt (nicht während einer Sendung).", "Restart after an update when operation allows (not during a broadcast).")})
	}
	if len(crashed) == 0 && len(loops) == 0 && len(in.Instances) > 0 {
		add(Check{ID: "instances", Group: grp, Level: LevelOK, Title: t.s("Instanzen", "Instances"), Detail: t.s(fmt.Sprintf("%d laufen stabil", len(in.Instances)), fmt.Sprintf("%d running stably", len(in.Instances)))})
	}

	// ---- Trends ---------------------------------------------------------------------------------------------------
	for _, f := range in.Trends {
		cs = append(cs, trendCheck(t, f))
	}

	// ---- Betriebsprofil --------------------------------------------------
	grp = t.s("Betriebsprofil", "Operating profile")
	for _, f := range in.Findings {
		lv := LevelWarn
		if (f.Severity == "error" || f.Severity == "err" || f.Severity == "critical") && in.Profile != "dev" {
			lv = LevelErr
		}
		add(Check{ID: "profile:" + f.ID, Group: grp, Level: lv, Title: f.Message, Fix: f.Hint})
	}

	rep := Report{GeneratedAt: now.UTC(), Level: LevelOK, Checks: cs}
	for _, c := range cs {
		switch c.Level {
		case LevelErr:
			rep.Errors++
		case LevelWarn:
			rep.Warnings++
		}
	}
	switch {
	case rep.Errors > 0:
		rep.Level = LevelErr
		rep.Summary = t.s(fmt.Sprintf("%d Problem(e) brauchen Aufmerksamkeit", rep.Errors), fmt.Sprintf("%d problem(s) need attention", rep.Errors))
	case rep.Warnings > 0:
		rep.Level = LevelWarn
		rep.Summary = t.s(fmt.Sprintf("Läuft, aber %d Hinweis(e) beachten", rep.Warnings), fmt.Sprintf("Running, but %d notice(s) to look at", rep.Warnings))
	default:
		rep.Summary = t.s("Alles in Ordnung", "Everything is fine")
	}
	for i := range rep.Checks {
		if rep.Checks[i].Level != LevelOK && rep.Checks[i].Code == "" {
			rep.Checks[i].Code = errcodes.ForCheck(rep.Checks[i].ID)
		}
	}
	// Schlimmstes zuerst, sonst Reihenfolge der Prüfung.
	sort.SliceStable(rep.Checks, func(i, j int) bool { return rank(rep.Checks[i].Level) < rank(rep.Checks[j].Level) })
	return rep
}

func rank(l Level) int {
	switch l {
	case LevelErr:
		return 0
	case LevelWarn:
		return 1
	}
	return 2
}

// dedupe fasst gleiche Namen zusammen („Mixer (×3)“), Reihenfolge des ersten Auftretens bleibt.
func dedupe(items []string) []string {
	count := map[string]int{}
	var order []string
	for _, s := range items {
		if count[s] == 0 {
			order = append(order, s)
		}
		count[s]++
	}
	for i, s := range order {
		if count[s] > 1 {
			order[i] = fmt.Sprintf("%s (×%d)", s, count[s])
		}
	}
	return order
}

func joinMax(items []string, max int) string {
	items = dedupe(items)
	if len(items) <= max {
		return join(items)
	}
	return join(items[:max]) + fmt.Sprintf(" … +%d", len(items)-max)
}

func join(items []string) string {
	out := ""
	for i, s := range items {
		if i > 0 {
			out += ", "
		}
		out += s
	}
	return out
}
