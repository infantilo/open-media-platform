package support

import (
	"fmt"
	"math"
)

var metricNames = map[string]Text2{
	"host.cpu":        {"Prozessorlast", "CPU load"},
	"host.mem":        {"Arbeitsspeicher", "memory"},
	"host.net":        {"Netzwerklast", "network load"},
	"proc.rss":        {"Speicher", "memory"},
	"proc.cpu":        {"Prozessorlast", "CPU load"},
	"proc.fds":        {"offene Dateien", "open files"},
	"proc.threads":    {"Threads", "threads"},
	"orch.heap":       {"Speicher des Orchestrators", "orchestrator memory"},
	"orch.goroutines": {"Goroutinen des Orchestrators", "orchestrator goroutines"},
	"orch.fds":        {"offene Dateien des Orchestrators", "orchestrator open files"},
}

// Text2 ist ein zweisprachiger Name.
type Text2 struct{ DE, EN string }

func (t tr) name(m string) string {
	n, ok := metricNames[m]
	if !ok {
		return m
	}
	return t.s(n.DE, n.EN)
}

// formatValue schreibt einen Messwert lesbar (Prozent, Bytes, Anzahl).
func formatValue(v float64, unit string) string {
	switch unit {
	case "%":
		return fmt.Sprintf("%.0f %%", v)
	case "B":
		return human(uint64(math.Max(v, 0)))
	}
	return fmt.Sprintf("%.0f", v)
}

func formatRate(v float64, unit string) string {
	switch unit {
	case "%":
		return fmt.Sprintf("%.1f Punkte/h", v)
	case "B":
		return human(uint64(math.Max(v, 0))) + "/h"
	}
	return fmt.Sprintf("%.1f/h", v)
}

// trendCheck macht aus einer Auffälligkeit einen Befund in Klartext.
func trendCheck(t tr, f TrendFinding) Check {
	who := f.Label
	if who == "" {
		who = f.Subject
	}
	c := Check{ID: "trend:" + f.Subject + ":" + f.Metric + ":" + f.Kind, Group: t.s("Trends", "Trends"), Level: LevelWarn}
	name := t.name(f.Metric)
	if f.Kind == "drift" {
		c.Title = t.s(fmt.Sprintf("%s: %s wächst stetig", who, name), fmt.Sprintf("%s: %s keeps growing", who, name))
		c.Detail = t.s(fmt.Sprintf("seit %.0f Stunden von %s auf %s (%s)", f.Hours, formatValue(f.Baseline, f.Unit), formatValue(f.Value, f.Unit), formatRate(f.SlopePerHour, f.Unit)),
			fmt.Sprintf("for %.0f hours from %s to %s (%s)", f.Hours, formatValue(f.Baseline, f.Unit), formatValue(f.Value, f.Unit), formatRate(f.SlopePerHour, f.Unit)))
		if f.HoursToLimit > 0 {
			c.Detail += t.s(fmt.Sprintf(" — bei diesem Tempo ist die Grenze in etwa %.0f Stunden erreicht", f.HoursToLimit),
				fmt.Sprintf(" — at this pace the limit is reached in about %.0f hours", f.HoursToLimit))
		}
		c.Fix = t.s("Zu einem ruhigen Zeitpunkt (nicht während einer Sendung) neu starten; wächst es danach wieder, das Support-Paket senden.",
			"Restart at a quiet moment (not during a broadcast); if it grows again, send the support package.")
		return c
	}
	c.Title = t.s(fmt.Sprintf("%s: %s ungewöhnlich hoch", who, name), fmt.Sprintf("%s: %s unusually high", who, name))
	c.Detail = t.s(fmt.Sprintf("jetzt %s — zu dieser Tageszeit üblich sind %s", formatValue(f.Value, f.Unit), formatValue(f.Baseline, f.Unit)),
		fmt.Sprintf("now %s — usual at this time of day is %s", formatValue(f.Value, f.Unit), formatValue(f.Baseline, f.Unit)))
	c.Fix = t.s("Prüfen, was sich geändert hat (Administration → Zeitleiste): neue Instanzen, Workflow, Update. Ist die Last gewollt, ist nichts zu tun.",
		"Check what changed (Administration → Timeline): new instances, workflow, update. If the load is intended, nothing needs to be done.")
	return c
}
