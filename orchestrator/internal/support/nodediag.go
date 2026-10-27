package support

import (
	"fmt"

	"github.com/infantilo/openmediaplatform/orchestrator/internal/errcodes"
)

// Node-Diagnose (UMSETZUNG.md Kap. 72.7): die Fakten eines einzelnen Nodes in Befunde mit „Was tun?“ übersetzen. Wie Evaluate
// eine reine Funktion auf Messwerten.

// NodeFacts sind die gesammelten Fakten eines Nodes.
type NodeFacts struct {
	Label    string
	Online   bool
	Known    bool // der Node steht in der Registry
	Instance *InstanceFacts
	Process  *ProcessFacts // nur für Prozesse auf dem Orchestrator-Rechner
	Media    *MediaFacts
	// Fehlermeldungen des Nodes in den letzten 15 Minuten.
	RecentErrors int
	Pipelines    []PipelineFacts
}

// InstanceFacts: die vom Launcher gestartete Instanz.
type InstanceFacts struct {
	Crashed      bool
	CrashMessage string
	RestartCount int
	Outdated     bool
	CPUPercent   *float64
	RSSBytes     *uint64
}

// ProcessFacts: Zustand des Prozesses (/proc) auf dem Orchestrator-Rechner.
type ProcessFacts struct {
	Threads    int
	OpenFDs    int
	FDLimit    int
	RSSBytes   uint64
	HostMemory uint64 // Gesamtspeicher des Rechners
}

// MediaFacts: Bereitschaft und Raten aus den Health-Kennzahlen.
type MediaFacts struct {
	Ready        bool
	EverReady    bool
	ObservedSecs float64
	VideoFPS     *Rate
}

type Rate struct{ Last, Avg float64 }

// PipelineFacts: Momentaufnahme einer Pipeline (Node-Antwort /diag/pipelines).
type PipelineFacts struct {
	Name     string
	State    string
	Elements []ElementFacts
}

type ElementFacts struct {
	Name, Factory, State string
	Level                *QueueLevel
}

// QueueLevel: Füllstand einer Queue; Max* 0 = unbegrenzt.
type QueueLevel struct {
	Buffers, Bytes, MaxBuffers, MaxBytes uint64
}

// Full: die Queue ist an ihrer Grenze.
func (q QueueLevel) Full() bool {
	return (q.MaxBuffers > 0 && q.Buffers >= q.MaxBuffers) || (q.MaxBytes > 0 && q.Bytes >= q.MaxBytes)
}

// EvaluateNode bewertet die Fakten eines Nodes; die Befunde sind nach Schwere sortiert, „in Ordnung“ am Ende.
func EvaluateNode(f NodeFacts, lang string) []Check {
	t := tr{lang}
	var cs []Check
	add := func(id string, lv Level, title, detail, fix string) {
		cs = append(cs, Check{ID: id, Group: f.Label, Level: lv, Title: title, Detail: detail, Fix: fix})
	}
	switch {
	case !f.Known:
		add("registry", LevelErr, t.s("Der Node ist nicht in der Registry", "The node is not in the registry"), "",
			t.s("Er läuft nicht oder hat sich noch nicht angemeldet. Unter Instanzen nachsehen, sonst neu starten.", "It is not running or has not registered yet. Check under Instances, otherwise restart it."))
	case !f.Online:
		add("online", LevelErr, t.s("Der Node meldet sich nicht", "The node is not reporting"), "",
			t.s("Unter Instanzen nachsehen, ob der Prozess läuft; sonst neu starten.", "Check under Instances whether the process runs; otherwise restart it."))
	default:
		add("online", LevelOK, t.s("Der Node meldet sich", "The node is reporting"), "", "")
	}
	if in := f.Instance; in != nil {
		if in.Crashed {
			add("crashed", LevelErr, t.s("Der Prozess ist abgestürzt", "The process crashed"), in.CrashMessage,
				t.s("Neu starten; stürzt er wieder ab, das Support-Paket erstellen (Administration → Support) und senden.", "Restart it; if it crashes again, create the support package (Administration → Support) and send it."))
		} else if in.RestartCount >= 3 {
			add("restarts", LevelWarn, t.s(fmt.Sprintf("Wurde %d-mal automatisch neu gestartet", in.RestartCount), fmt.Sprintf("Was restarted automatically %d times", in.RestartCount)), "",
				t.s("Instabil: der Prozess endet immer wieder von selbst. Ursache in Administration → Diagnose suchen oder das Support-Paket senden.", "Unstable: the process keeps ending on its own. Look for the cause under Administration → Diagnose or send the support package."))
		} else {
			add("restarts", LevelOK, t.s("Läuft stabil", "Running stably"), t.s(fmt.Sprintf("%d automatische Neustarts", in.RestartCount), fmt.Sprintf("%d automatic restarts", in.RestartCount)), "")
		}
		if in.Outdated {
			add("outdated", LevelWarn, t.s("Läuft mit alter Version", "Runs an old version"), "",
				t.s("Nach einem Update neu starten, wenn es der Betrieb erlaubt (nicht während einer Sendung).", "Restart after an update when operation allows (not during a broadcast)."))
		}
		if in.CPUPercent != nil && *in.CPUPercent >= 95 {
			add("cpu", LevelWarn, t.s("Der Prozess nutzt einen ganzen Prozessorkern", "The process uses a whole CPU core"), fmt.Sprintf("%.0f %%", *in.CPUPercent),
				t.s("Ein Strang ist ausgelastet — Bild oder Ton können aussetzen. Auflösung oder Bildrate senken oder den Node auf einen anderen Host legen.", "One thread is saturated — picture or sound may drop out. Lower resolution or frame rate or move the node to another host."))
		}
	}
	if p := f.Process; p != nil {
		if p.FDLimit > 0 {
			use := float64(p.OpenFDs) / float64(p.FDLimit) * 100
			switch {
			case use > 90:
				add("fds", LevelErr, t.s("Fast alle erlaubten Dateien offen", "Almost all allowed files open"), fmt.Sprintf("%d / %d", p.OpenFDs, p.FDLimit),
					t.s("Neue Verbindungen scheitern gleich. Node neu starten und dem Support melden (vermutlich ein Leck).", "New connections will fail soon. Restart the node and tell support (probably a leak)."))
			case use > 70:
				add("fds", LevelWarn, t.s("Viele offene Dateien", "Many open files"), fmt.Sprintf("%d / %d", p.OpenFDs, p.FDLimit),
					t.s("Die Zahl wächst vermutlich stetig (Leck). Beobachten und melden, wenn sie weiter steigt.", "The number probably keeps growing (leak). Watch it and report if it keeps rising."))
			default:
				add("fds", LevelOK, t.s("Offene Dateien", "Open files"), fmt.Sprintf("%d / %d", p.OpenFDs, p.FDLimit), "")
			}
		}
		if p.Threads > 500 {
			add("threads", LevelWarn, t.s("Sehr viele Threads", "Very many threads"), fmt.Sprintf("%d", p.Threads),
				t.s("Ungewöhnlich viele: möglicherweise ein Leck. Node neu starten und beobachten.", "Unusually many: possibly a leak. Restart the node and watch it."))
		}
		if p.HostMemory > 0 && p.RSSBytes > p.HostMemory/2 {
			add("memory", LevelWarn, t.s("Der Prozess belegt über die Hälfte des Arbeitsspeichers", "The process uses over half of the memory"), human(p.RSSBytes),
				t.s("Möglicherweise ein Speicherleck. Node neu starten; wächst der Wert wieder, das Support-Paket senden.", "Possibly a memory leak. Restart the node; if it grows again, send the support package."))
		}
	}
	if m := f.Media; m != nil && f.Online {
		switch {
		case !m.Ready && m.EverReady:
			add("media", LevelErr, t.s("Liefert kein Bild und keinen Ton mehr", "No longer delivers picture or sound"), "",
				t.s("Die Quelle davor prüfen: ohne Eingangssignal oder Datei liefert dieser Node nichts. Hilft das nicht, den Node neu starten.", "Check the source before it: without an input signal or file this node delivers nothing. If that does not help, restart the node."))
		case !m.Ready && m.ObservedSecs >= 10:
			add("media", LevelWarn, t.s("Hat noch kein Bild und keinen Ton geliefert", "Has not delivered any picture or sound yet"), t.s("(oder der Node meldet seine Bereitschaft nicht)", "(or the node does not report readiness)"),
				t.s("Soll dieser Node Medien liefern: die Quelle davor und seine Einstellungen prüfen. Manche Node-Typen melden ihre Bereitschaft nicht — dann ist der Hinweis harmlos.", "If this node is supposed to deliver media: check the source before it and its settings. Some node types do not report readiness — then this notice is harmless."))
		default:
			add("media", LevelOK, t.s("Bild und Ton", "Picture and sound"), t.s("liefert", "delivering"), "")
		}
		if r := m.VideoFPS; r != nil && m.Ready {
			switch {
			case r.Avg >= 5 && r.Last < 1:
				add("fps", LevelErr, t.s("Liefert keine Bilder mehr", "Delivers no frames any more"), fmt.Sprintf("%.1f / %.1f", r.Last, r.Avg),
					t.s("Den Node neu starten. Kommt danach wieder nichts, die Quelle davor prüfen und das Support-Paket erstellen.", "Restart the node. If nothing comes afterwards, check the source before it and create the support package."))
			case r.Avg >= 5 && r.Last < r.Avg*0.8:
				add("fps", LevelWarn, t.s("Bildrate eingebrochen", "Frame rate dropped"), t.s(fmt.Sprintf("%.1f statt %.1f Bilder/s", r.Last, r.Avg), fmt.Sprintf("%.1f instead of %.1f frames/s", r.Last, r.Avg)),
					t.s("Meist Überlastung: Last des Hosts prüfen und Instanzen verteilen.", "Usually overload: check the host load and spread instances."))
			default:
				add("fps", LevelOK, t.s("Bildrate", "Frame rate"), t.s(fmt.Sprintf("%.1f Bilder/s", r.Last), fmt.Sprintf("%.1f frames/s", r.Last)), "")
			}
		}
	}
	for _, pl := range f.Pipelines {
		cs = append(cs, evaluatePipeline(t, f.Label, pl)...)
	}
	if f.RecentErrors > 0 {
		add("errors", LevelWarn, t.s(fmt.Sprintf("%d Fehlermeldung(en) in den letzten 15 Minuten", f.RecentErrors), fmt.Sprintf("%d error message(s) in the last 15 minutes", f.RecentErrors)), "",
			t.s("Die Meldungen stehen weiter unten und in Administration → Diagnose.", "The messages are listed below and under Administration → Diagnose."))
	}
	for i := range cs {
		if cs[i].Level == LevelOK {
			continue
		}
		// Eine Absturzmeldung kann einen genaueren Code tragen (Image fehlt, Programmdatei fehlt, Speicher voll …).
		if cs[i].ID == "crashed" {
			if e, ok := errcodes.Classify(cs[i].Detail); ok {
				cs[i].Code = e.Code
				continue
			}
		}
		cs[i].Code = errcodes.ForCheck(cs[i].ID)
	}
	sortChecks(cs)
	return cs
}

func evaluatePipeline(t tr, label string, pl PipelineFacts) []Check {
	var cs []Check
	name := t.s("Pipeline ", "Pipeline ") + pl.Name
	if pl.State != "" && pl.State != "Playing" {
		cs = append(cs, Check{ID: "pipeline:" + pl.Name, Group: label, Level: LevelWarn,
			Title:  t.s(name+" steht nicht auf „Playing“", name+" is not “Playing”"),
			Detail: pl.State,
			Fix:    t.s("Die Pipeline läuft nicht: der Node verarbeitet gerade nichts. Neu starten; steht es dort wieder, das Support-Paket senden.", "The pipeline is not running: the node processes nothing right now. Restart; if it happens again, send the support package.")})
	}
	var stuck, full []string
	for _, e := range pl.Elements {
		if pl.State == "Playing" && e.State != "Playing" && e.State != "" {
			stuck = append(stuck, e.Name+" ("+e.State+")")
		}
		if e.Level != nil && e.Level.Full() {
			full = append(full, e.Name)
		}
	}
	if len(stuck) > 0 {
		cs = append(cs, Check{ID: "pipeline-elements:" + pl.Name, Group: label, Level: LevelWarn,
			Title:  t.s(name+": Elemente nicht im Zustand der Pipeline", name+": elements not in the pipeline’s state"),
			Detail: joinMax(stuck, 6),
			Fix:    t.s("Ein Baustein hängt in einem anderen Zustand als die übrigen — dort stockt der Fluss. Node neu starten und das Support-Paket senden.", "A building block is in a different state from the rest — that is where the flow stalls. Restart the node and send the support package.")})
	}
	if len(full) > 0 {
		cs = append(cs, Check{ID: "pipeline-queues:" + pl.Name, Group: label, Level: LevelWarn,
			Title:  t.s(name+": Puffer voll", name+": buffers full"),
			Detail: joinMax(full, 6),
			Fix:    t.s("Ein Puffer ist an seiner Grenze: der Baustein dahinter nimmt Daten zu langsam ab. Meist Überlastung (Last des Hosts prüfen) oder ein hängender Ausgang.", "A buffer is at its limit: the element after it takes data too slowly. Usually overload (check the host load) or a stuck output.")})
	}
	if len(stuck) == 0 && len(full) == 0 && pl.State == "Playing" {
		cs = append(cs, Check{ID: "pipeline-ok:" + pl.Name, Group: label, Level: LevelOK, Title: name,
			Detail: t.s(fmt.Sprintf("%d Bausteine laufen", len(pl.Elements)), fmt.Sprintf("%d elements running", len(pl.Elements)))})
	}
	return cs
}

func sortChecks(cs []Check) {
	// stabil: Fehler, Hinweise, in Ordnung
	for i := 1; i < len(cs); i++ {
		for j := i; j > 0 && rank(cs[j].Level) < rank(cs[j-1].Level); j-- {
			cs[j], cs[j-1] = cs[j-1], cs[j]
		}
	}
}

// Summary fasst Befunde in Stufe und einen Satz zusammen (wie der Gesamtstatus des Selbsttests).
func Summary(cs []Check, lang string) (Level, string) {
	t := tr{lang}
	errs, warns := 0, 0
	for _, c := range cs {
		switch c.Level {
		case LevelErr:
			errs++
		case LevelWarn:
			warns++
		}
	}
	switch {
	case errs > 0:
		return LevelErr, t.s(fmt.Sprintf("%d Problem(e) brauchen Aufmerksamkeit", errs), fmt.Sprintf("%d problem(s) need attention", errs))
	case warns > 0:
		return LevelWarn, t.s(fmt.Sprintf("Läuft, aber %d Hinweis(e) beachten", warns), fmt.Sprintf("Running, but %d notice(s) to look at", warns))
	}
	return LevelOK, t.s("Alles in Ordnung", "Everything is fine")
}
