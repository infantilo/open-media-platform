package jobrun

import (
	"sort"
	"time"
)

// ActionKind ist ein Eingriff des Sendeschutzes.
type ActionKind string

const (
	ActThrottle ActionKind = "throttle"
	ActPause    ActionKind = "pause"
	ActResume   ActionKind = "resume"
	ActCancel   ActionKind = "protect-cancel"
)

// Action ist ein Eingriff in einen laufenden Job.
type Action struct {
	Kind   ActionKind
	JobID  string
	Nice   int
	Reason string
}

// ProtectInput ist, was der Wächter pro Host auswertet.
type ProtectInput struct {
	Host     HostState
	Degraded bool // ein Live-Node auf dem Host meldet Aussetzer
	Now      time.Time
}

// Evaluate entscheidet gestuft (Drosseln → Pausieren → Abbrechen), niemals mehr als einen harten Eingriff pro Aufruf:
// die Last sinkt erst, nachdem er wirkt — das nächste Intervall sieht das Ergebnis. Interactive-Jobs werden erst
// gedrosselt, dann nur bei Degradation abgebrochen. Reihenfolge der Opfer: niedrigste Klasse, zuletzt gestartet.
func Evaluate(in ProtectInput, cfg Config) []Action {
	p := cfg.Protect
	if !p.Enabled || len(in.Host.Jobs) == 0 {
		return nil
	}
	limit := 100 * (1 - in.Host.ReserveOf(cfg).CPU)
	level := in.Host.CPUPercent / limit
	jobs := append([]RunningJob(nil), in.Host.Jobs...)
	sort.SliceStable(jobs, func(i, j int) bool { // Opfer zuerst
		if jobs[i].Class.rank() != jobs[j].Class.rank() {
			return jobs[i].Class.rank() > jobs[j].Class.rank()
		}
		return jobs[i].Started.After(jobs[j].Started)
	})
	var acts []Action
	switch {
	case in.Degraded:
		for _, j := range jobs {
			if j.Class == ClassInteractive {
				continue
			}
			acts = append(acts, Action{Kind: ActCancel, JobID: j.ID, Reason: "Live-Node meldet Aussetzer"})
			return acts // einer pro Intervall
		}
		for _, j := range jobs {
			acts = append(acts, Action{Kind: ActCancel, JobID: j.ID, Reason: "Live-Node meldet Aussetzer"})
			return acts
		}
	case level >= p.CancelAt:
		for _, j := range jobs {
			if j.Class == ClassInteractive {
				continue
			}
			return []Action{{Kind: ActCancel, JobID: j.ID, Reason: "CPU-Grenze deutlich überschritten"}}
		}
	}
	// Pausierte Jobs, die zu lange stehen, werden abgebrochen (sie bekommen sonst nie wieder Platz).
	for _, j := range jobs {
		if j.Paused && !j.PausedSince.IsZero() && in.Now.Sub(j.PausedSince) > time.Duration(p.MaxPauseS)*time.Second {
			return []Action{{Kind: ActCancel, JobID: j.ID, Reason: "zu lange pausiert"}}
		}
	}
	switch {
	case level >= p.PauseAt:
		for _, j := range jobs {
			if j.Paused || j.Class == ClassInteractive {
				continue
			}
			if !j.Pausable {
				// Live-Eingang: Pausieren würde Daten verlieren — bleibt bei Drosselung, Abbruch erst bei CancelAt.
				if j.Nice < 19 {
					acts = append(acts, Action{Kind: ActThrottle, JobID: j.ID, Nice: 19, Reason: "CPU-Grenze erreicht"})
				}
				continue
			}
			acts = append(acts, Action{Kind: ActPause, JobID: j.ID, Reason: "CPU-Grenze erreicht"})
			return acts // einer pro Intervall
		}
		for _, j := range jobs {
			if j.Class == ClassInteractive && j.Nice < 15 {
				acts = append(acts, Action{Kind: ActThrottle, JobID: j.ID, Nice: 15, Reason: "CPU-Grenze erreicht"})
			}
		}
	case level >= p.ThrottleAt:
		for _, j := range jobs {
			if j.Paused {
				continue
			}
			target := 19
			if j.Class == ClassInteractive {
				target = 15
			}
			if j.Nice < target {
				acts = append(acts, Action{Kind: ActThrottle, JobID: j.ID, Nice: target, Reason: "CPU nähert sich der Grenze"})
			}
		}
	case level < p.ResumeAt:
		// Fortsetzen: der wichtigste pausierte Job zuerst, einer pro Intervall.
		for i := len(jobs) - 1; i >= 0; i-- {
			if jobs[i].Paused {
				return []Action{{Kind: ActResume, JobID: jobs[i].ID, Reason: "Last unter der Fortsetz-Schwelle"}}
			}
		}
	}
	return acts
}
